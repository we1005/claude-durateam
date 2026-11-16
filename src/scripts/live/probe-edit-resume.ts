/**
 * P1 live probe: controlled Edit in an isolated workspace, then exact-UUID
 * resume of the same job home and session (proves transcript continuity).
 *
 * Usage: CLAUDE_DURATEAM_KEY_FILE=/path/to/key node dist/scripts/live/probe-edit-resume.js
 * Exit codes: 0 = pass, 1 = fail, 2 = blocked before any network call.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "../../engines/agent-runner.js";
import {
  CredentialError,
  DEFAULT_BASE_URL,
  loadApiKeyFromFile,
  resolveKeyFile,
  resolveRuntimeRoot,
} from "../../engines/environment.js";
import { createArtifactSink, errorSummary } from "../../observability/artifacts.js";
import { preview, redactSecrets } from "../../observability/redact.js";
import type { RunnerRequest, RunnerResult, WorkerEvent } from "../../task-contracts.js";

interface Check {
  id: string;
  ok: boolean;
  detail?: string;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { model: { type: "string", default: "glm-5.3" } },
    strict: true,
  });
  const model = values.model === "glm-5.3-flash" ? "glm-5.3-flash" : "glm-5.3";

  const runtimeRoot = resolveRuntimeRoot();
  const runDir = join(runtimeRoot, "p1", "edit-resume", new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14));
  const projectDir = join(runDir, "project");
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-edit-resume", suffix: model, secrets });
  const keyFile = resolveKeyFile();
  let credential;
  try {
    credential = loadApiKeyFromFile(keyFile);
    secrets.push(credential.token);
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { probe: "p1/edit-resume", status: "blocked", blockedReason: `credential:${code}`, sdkRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const baseResult = {
    probe: "p1/edit-resume",
    model,
    baseUrl: DEFAULT_BASE_URL,
    runtimeDir: runDir,
    startedAt: new Date().toISOString(),
  };
  const checks: Check[] = [];
  const nonce = `CDT-EDIT-${randomBytes(8).toString("hex")}`;
  const targetFile = "target.txt";
  const targetPath = join(projectDir, targetFile);
  writeFileSync(targetPath, "base-line\n", { mode: 0o600 });

  const runner = new ClaudeAgentRunner({ runtimeRoot, keyFile });
  const jobId = `job-edit-${randomBytes(4).toString("hex")}`;
  const approvals: string[] = [];
  const events1: WorkerEvent[] = [];

  const run1: RunnerRequest = {
    jobId,
    runId: `run1-${randomBytes(4).toString("hex")}`,
    cwd: projectDir,
    sourceCwd: projectDir,
    model,
    profile: "edit",
    prompt: [
      "Use the Edit tool to append a new line to target.txt.",
      `The new line must contain exactly this marker: ${nonce}`,
      "Do not use Write, do not touch other files, and reply DONE when finished.",
    ].join(" "),
    maxTurns: 4,
    deadlineMs: 150_000,
    allowedPaths: [targetFile],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: false,
    branch: null,
    signal: new AbortController().signal,
    requestApproval: async (approval) => {
      approvals.push(`${approval.toolName}:${preview(approval.description, 60)}`);
      const isTargetEdit = approval.toolName === "Edit" && approval.description.includes(targetFile);
      sink.log("approval.requested", { toolName: approval.toolName, requestId: approval.requestId, granted: isTargetEdit });
      return isTargetEdit;
    },
  };

  const outcome1: RunnerResult = await runner.run(run1, (event) => {
    events1.push(event);
    sink.log("run1.event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
  });
  const contentAfterEdit = readFileSync(targetPath, "utf8");

  checks.push({ id: "run1.model_succeeded", ok: outcome1.modelSucceeded, detail: outcome1.error ?? "ok" });
  checks.push({ id: "run1.session_uuid", ok: Boolean(outcome1.sessionId), detail: outcome1.sessionId ?? "none" });
  checks.push({
    id: "run1.edit_tool_used",
    ok: events1.some((event) => event.type === "tool_start" && event.toolName === "Edit"),
    detail: events1.filter((event) => event.type === "tool_start").map((event) => event.toolName).join(","),
  });
  checks.push({
    id: "run1.file_updated",
    ok: contentAfterEdit.includes(nonce) && contentAfterEdit.includes("base-line"),
    detail: `bytes=${contentAfterEdit.length}`,
  });
  checks.push({
    id: "run1.approval_real_callback",
    ok: approvals.some((entry) => entry.startsWith("Edit:")),
    detail: approvals.join(" | "),
  });

  const events2: WorkerEvent[] = [];
  const memoryPrompt =
    "In the previous turn of this same session you appended a random marker to a file. " +
    "Reply with exactly that marker prefixed MEM: and nothing else. " +
    "Do not use any tools and do not read any files; answer from session memory only.";
  const run2: RunnerRequest | null = outcome1.sessionId
    ? {
        ...run1,
        runId: `run2-${randomBytes(4).toString("hex")}`,
        profile: "read",
        allowedPaths: [],
        prompt: memoryPrompt,
        resumeSessionId: outcome1.sessionId,
        requestApproval: async () => false,
      }
    : null;

  const outcome2: RunnerResult | null = run2
    ? await runner.run(run2, (event) => {
        events2.push(event);
        sink.log("run2.event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
      })
    : null;
  const run2ToolCalls = events2.filter((event) => event.type === "tool_start" || event.type === "tool_end");

  checks.push({ id: "run2.ran", ok: Boolean(outcome2), detail: outcome2?.error ?? "no session id" });
  checks.push({
    id: "run2.resume_model_succeeded",
    ok: outcome2?.modelSucceeded === true,
    detail: outcome2?.error ?? "ok",
  });
  checks.push({
    id: "run2.memory_retained_no_marker_in_prompt",
    ok: Boolean(outcome2 && outcome2.text.includes(nonce) && !memoryPrompt.includes(nonce)),
    detail: preview(outcome2?.text ?? "", 80),
  });
  checks.push({
    id: "run2.zero_tool_calls",
    ok: run2ToolCalls.length === 0,
    detail: run2ToolCalls.map((event) => event.toolName ?? event.type).join(","),
  });
  checks.push({
    id: "run2.exact_uuid_resume_requested",
    ok: Boolean(run2?.resumeSessionId && run2.resumeSessionId === outcome1.sessionId),
    detail: `requested=${run2?.resumeSessionId ?? "none"}`,
  });
  checks.push({
    id: "run2.same_session_id",
    ok: Boolean(outcome1.sessionId && outcome2?.sessionId === outcome1.sessionId),
    detail: `run1=${outcome1.sessionId ?? "none"} run2=${outcome2?.sessionId ?? "none"}`,
  });

  // Distinct fork check: same parent transcript, but the SDK must mint a new SID.
  const events3: WorkerEvent[] = [];
  const forkRun: RunnerRequest | null = outcome1.sessionId
    ? {
        ...run1,
        runId: `run3-${randomBytes(4).toString("hex")}`,
        profile: "read",
        allowedPaths: [],
        prompt:
          "Using only session memory inherited from the parent session, reply with exactly the marker " +
          "that was appended there, prefixed FORK: and nothing else. Do not use any tools.",
        resumeSessionId: outcome1.sessionId,
        forkSession: true,
        requestApproval: async () => false,
      }
    : null;
  const outcome3: RunnerResult | null = forkRun
    ? await runner.run(forkRun, (event) => {
        events3.push(event);
        sink.log("run3.event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
      })
    : null;
  const run3ToolCalls = events3.filter((event) => event.type === "tool_start" || event.type === "tool_end");

  checks.push({ id: "fork.ran", ok: Boolean(outcome3), detail: outcome3?.error ?? "no session id" });
  checks.push({
    id: "fork.model_succeeded",
    ok: outcome3?.modelSucceeded === true,
    detail: outcome3?.error ?? "ok",
  });
  checks.push({
    id: "fork.memory_inherited_no_marker_in_prompt",
    ok: Boolean(outcome3 && outcome3.text.includes(nonce) && !(forkRun?.prompt ?? "").includes(nonce)),
    detail: preview(outcome3?.text ?? "", 80),
  });
  checks.push({
    id: "fork.new_session_id",
    ok: Boolean(outcome3?.sessionId && outcome1.sessionId && outcome3.sessionId !== outcome1.sessionId),
    detail: `parent=${outcome1.sessionId ?? "none"} fork=${outcome3?.sessionId ?? "none"}`,
  });
  checks.push({
    id: "fork.zero_tool_calls",
    ok: run3ToolCalls.length === 0,
    detail: run3ToolCalls.map((event) => event.toolName ?? event.type).join(","),
  });

  const compatWarnings = [
    "canUseTool is shadowed for allowed read tools (Read/Glob/Grep); writes remain gated by a real callback + PreToolUse",
    "e1b9f3b first-red artifact is preserved; its 'new SID on resume' conclusion was withdrawn: the bridge had not passed resume into SDK options.",
  ];
  const passed = checks.every((check) => check.ok);
  const result = {
    compatWarnings,
    ...baseResult,
    status: passed ? "pass" : "fail",
    finishedAt: new Date().toISOString(),
    sdkRunsStarted: (outcome2 ? 1 : 0) + (outcome3 ? 1 : 0) + 1,
    jobId,
    sessionId: outcome1.sessionId,
    run1: { ...outcome1, text: preview(outcome1.text, 120) },
    run2: outcome2 ? { ...outcome2, text: preview(outcome2.text, 120) } : null,
    run3: outcome3 ? { ...outcome3, text: preview(outcome3.text, 120) } : null,
    run2ToolCalls: run2ToolCalls.length,
    run3ToolCalls: run3ToolCalls.length,
    fileContentPreview: preview(contentAfterEdit, 120),
    approvals,
    checks,
    artifactsDir: sink.dir,
    limits: { profile: "edit", allowedPaths: [targetFile], maxTurns: 4, deadlineMs: 150_000 },
  };
  const logText = readFileSync(sink.logPath, "utf8");
  const leaked = secrets.some((secret) => secret.length >= 6 && logText.includes(secret));
  sink.finalize(passed && !leaked ? 0 : 1, result);
  console.log(JSON.stringify(redactSecrets(JSON.stringify(result))));
  return passed && !leaked ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", ...errorSummary(err) }));
    process.exit(1);
  });
