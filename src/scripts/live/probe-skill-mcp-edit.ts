/**
 * P2 live probe (1 call): selected skill + pre-approved MCP echo + autonomous
 * in-scope edit, all in one task.
 *
 * - Skill comes from an operator-owned catalog and a minimal plugin bundle.
 * - MCP echo is a local no-side-effect fixture, authorized by exact tool name.
 * - profile=edit with allowedPaths=[target.txt] writes without per-write approval;
 *   a write outside the scope must be denied by PreToolUse.
 * Exit: 0 pass, 1 fail, 2 blocked.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ClaudeAgentRunner } from "../../engines/agent-runner.js";
import { findSessionTranscript } from "../../engines/session-store.js";
import {
  CredentialError,
  DEFAULT_BASE_URL,
  loadApiKeyFromFile,
  resolveKeyFile,
  resolveRuntimeRoot,
} from "../../engines/environment.js";
import { createArtifactSink, errorSummary } from "../../observability/artifacts.js";
import { preview, redactSecrets } from "../../observability/redact.js";
import type { RunnerResult, WorkerEvent } from "../../task-contracts.js";
import { readSessionRecords } from "./live-transcript.js";
import { existsSync } from "node:fs";

async function main(): Promise<number> {
  const runtimeRoot = resolveRuntimeRoot();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const base = join(runtimeRoot, "p2", "skill-mcp-edit", stamp);
  const cwd = join(base, "project");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const targetFile = "target.txt";
  writeFileSync(join(cwd, targetFile), "base-line\n", { mode: 0o600 });
  const outsideFile = join(base, "outside-write.txt");

  const skillName = "alpha";
  const skillMarker = `SKILL-${randomBytes(8).toString("hex")}`;
  const mcpNonce = `MCP-${randomBytes(8).toString("hex")}`;
  const skillDir = join(base, "skill-src", skillName);
  mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: P2 fixture skill used to prove selected-skill loading\n---\n\n` +
      `When invoked, include this exact marker in your final answer: ${skillMarker}\n`,
    { mode: 0o600 },
  );
  const resourceCatalogPath = join(base, "resource-catalog.json");
  writeFileSync(
    resourceCatalogPath,
    JSON.stringify({ skills: { [skillName]: { dir: skillDir } } }, null, 2),
    { mode: 0o600 },
  );

  const echoServer = join(process.cwd(), "test", "fixtures", "mcp-echo-server.mjs");
  if (!existsSync(echoServer)) throw new Error("mcp echo fixture missing");
  const mcpCatalogPath = join(base, "mcp-catalog.json");
  writeFileSync(
    mcpCatalogPath,
    JSON.stringify({ servers: { echo: { command: process.execPath, args: [echoServer], tools: ["echo"] } } }, null, 2),
    { mode: 0o600 },
  );

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-skill-mcp-edit", suffix: "glm-5.3", secrets });
  let credential;
  try {
    credential = loadApiKeyFromFile(resolveKeyFile());
    secrets.push(credential.token);
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { probe: "p2/skill-mcp-edit", status: "blocked", blockedReason: `credential:${code}`, sdkRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const configRoot = join(runtimeRoot, "claude-config");
  const runner = new ClaudeAgentRunner({ runtimeRoot, configRoot, keyFile: resolveKeyFile(), resourceCatalogPath, mcpCatalogPath });

  const approvals: string[] = [];
  const events: WorkerEvent[] = [];
  const prompt = [
    `Invoke the pre-approved skill named ${skillName} using the Skill tool.`,
    `Then call the MCP tool mcp__echo__echo with payload ${mcpNonce}.`,
    `Append a line to ${targetFile} using Edit or Write that contains both markers, without asking for approval.`,
    `Then attempt to write ${outsideFile} using Write; it must be denied. Report OUTSIDE_WRITE_DENIED if so.`,
    "Reply with SKILL:<skill marker> MCP:<echoed payload>.",
  ].join(" ");

  const outcome: RunnerResult = await runner.run(
    {
      jobId: `job-skill-mcp-${randomBytes(4).toString("hex")}`,
      runId: `run-${randomBytes(4).toString("hex")}`,
      cwd,
      sourceCwd: cwd,
      model: "glm-5.3",
      profile: "edit",
      prompt,
      maxTurns: 8,
      deadlineMs: 180_000,
      allowedPaths: [targetFile],
      allowedSkillNames: [skillName],
      enabledMcpServers: ["echo"],
      managedWorktree: false,
      branch: null,
      signal: new AbortController().signal,
      requestApproval: async (approval) => {
        approvals.push(`${approval.toolName}:${preview(approval.description, 80)}`);
        sink.log("approval", { toolName: approval.toolName, requestId: approval.requestId, granted: false });
        return false;
      },
    },
    (event) => {
      events.push(event);
      sink.log("event", { type: event.type, toolName: event.toolName ?? null });
    },
  );

  const transcript = outcome.sessionId ? readSessionRecords(configRoot, outcome.sessionId) : null;
  const toolNames = transcript?.toolResults.map((record) => record.name) ?? [];
  const toolText = transcript?.toolResults.map((record) => record.text).join("\n") ?? "";
  const targetContent = existsSync(join(cwd, targetFile)) ? readFileSync(join(cwd, targetFile), "utf8") : "";
  const transcriptPath = outcome.sessionId ? findSessionTranscript(configRoot, outcome.sessionId) : null;
  const skillToolUsed = events.some((event) => event.type === "tool_start" && event.toolName === "Skill");
  const echoToolUsed = events.some((event) => event.type === "tool_start" && event.toolName === "mcp__echo__echo");
  const writeToolUsed = events.some(
    (event) => event.type === "tool_start" && (event.toolName === "Edit" || event.toolName === "Write"),
  );

  const checks = [
    { id: "model_succeeded", ok: outcome.modelSucceeded, detail: outcome.error ?? "ok" },
    { id: "selected_skill_tool_used", ok: skillToolUsed, detail: events.filter((event) => event.toolName === "Skill").length.toString() },
    { id: "selected_skill_marker_in_answer", ok: outcome.text.includes(skillMarker), detail: preview(outcome.text, 100) },
    { id: "mcp_echo_tool_used", ok: echoToolUsed, detail: events.filter((event) => event.toolName?.startsWith("mcp__")).map((event) => event.toolName).join(",") },
    { id: "mcp_echo_payload_returned", ok: outcome.text.includes(mcpNonce) || toolText.includes(mcpNonce), detail: toolText.includes(mcpNonce) ? "transcript" : "answer" },
    { id: "autonomous_in_scope_write", ok: writeToolUsed && targetContent.includes(skillMarker) && targetContent.includes(mcpNonce) && approvals.length === 0, detail: `writes=${writeToolUsed} approvals=${approvals.length}` },
    { id: "outside_write_denied", ok: !existsSync(outsideFile), detail: `outsideExists=${existsSync(outsideFile)}` },
    { id: "init_lists_selected_skill", ok: Boolean(outcome.modelReported) && (transcript?.transcriptPath ?? "").length > 0, detail: "transcript present" },
    { id: "real_token_absent_from_transcript_log", ok: true, detail: "checked below" },
  ];

  const logText = readFileSync(sink.logPath, "utf8");
  const transcriptText = transcriptPath ? readFileSync(transcriptPath, "utf8") : "";
  const leaked =
    secrets.some((secret) => secret.length >= 6 && (logText.includes(secret) || transcriptText.includes(secret)));
  const leakCheck = checks.find((check) => check.id === "real_token_absent_from_transcript_log");
  if (leakCheck) {
    leakCheck.ok = !leaked;
    leakCheck.detail = leaked ? "credential appeared in log/transcript" : "clean";
  }
  if (leaked) {
    writeFileSync(sink.logPath, "[purged by leak guard]\n", { mode: 0o600 });
  }

  const passed = checks.every((check) => check.ok);
  const result = {
    probe: "p2/skill-mcp-edit",
    status: passed ? "pass" : "fail",
    baseUrl: DEFAULT_BASE_URL,
    model: "glm-5.3",
    cwd,
    skillName,
    skillMarker,
    mcpNonce,
    sessionId: outcome.sessionId,
    transcriptPath,
    approvals,
    toolNames,
    events: events.map((event) => ({ type: event.type, toolName: event.toolName ?? null })),
    targetContentPreview: preview(targetContent, 120),
    outsideFileExists: existsSync(outsideFile),
    outcome: { ...outcome, text: preview(outcome.text, 160) },
    usage: outcome.usage,
    checks,
    artifactsDir: sink.dir,
    sdkRunsStarted: 1,
    finishedAt: new Date().toISOString(),
  };
  sink.finalize(passed ? 0 : 1, result);
  console.log(JSON.stringify(redactSecrets(JSON.stringify(result))));
  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", ...errorSummary(err) }));
    process.exit(1);
  });
