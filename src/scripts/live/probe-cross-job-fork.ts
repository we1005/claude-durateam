/**
 * P1 live probe: cross-job fork semantic.
 *
 * Parent job A edits a file with a memory-only marker. A *new* job B (new
 * jobId + different cwd/worktree) must fork the parent session: the SDK must
 * report a new SID that retains the parent context with zero tool calls.
 * A follow_up in job B must then resume that forked SID with the same SID.
 * The parent transcript must remain byte-identical.
 *
 * Exit: 0 pass, 1 fail, 2 blocked (no credential, no network).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
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
import type { RunnerRequest, RunnerResult, WorkerEvent } from "../../task-contracts.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", default: "glm-5.3" },
      "parent-session": { type: "string" },
      "parent-marker": { type: "string" },
      "child-dir": { type: "string", default: "工作区-中文" },
    },
    strict: true,
  });
  const model = values.model === "glm-5.3-flash" ? "glm-5.3-flash" : "glm-5.3";
  const reusedParent = values["parent-session"]?.trim() || null;
  const runtimeRoot = resolveRuntimeRoot();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const baseDir = join(runtimeRoot, "p1", "crossjob", stamp);
  const cwdA = join(baseDir, "worktree-a");
  const cwdB = join(baseDir, values["child-dir"] ?? "工作区-中文");
  mkdirSync(cwdB, { recursive: true, mode: 0o700 });
  writeFileSync(join(cwdB, "README.md"), "# child worktree (non-ascii path)\n", { mode: 0o600 });

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-cross-job-fork", suffix: model, secrets });
  let credential;
  try {
    credential = loadApiKeyFromFile(resolveKeyFile());
    secrets.push(credential.token);
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { probe: "p1/cross-job-fork", status: "blocked", blockedReason: `credential:${code}`, sdkRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const configRoot = join(runtimeRoot, "claude-config");
  const runner = new ClaudeAgentRunner({ runtimeRoot, keyFile: resolveKeyFile(), configRoot });
  const marker = reusedParent ? (values["parent-marker"] ?? "").trim() : `CDT-XJOB-${randomBytes(8).toString("hex")}`;
  const targetFile = "target.txt";
  const targetPath = join(cwdA, targetFile);
  if (!reusedParent) {
    mkdirSync(cwdA, { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, "parent-base\n", { mode: 0o600 });
  }

  const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];
  const eventsA: WorkerEvent[] = [];
  const jobA = reusedParent ? "reused-parent" : `job-cross-a-${randomBytes(4).toString("hex")}`;
  const runA: RunnerRequest | null = reusedParent ? null : {
    jobId: jobA,
    runId: `run-a-${randomBytes(4).toString("hex")}`,
    cwd: cwdA,
    sourceCwd: cwdA,
    model,
    profile: "edit",
    prompt: [
      "Use the Edit tool to append a new line to target.txt.",
      `The new line must contain exactly this marker: ${marker}`,
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
      const okApproval = approval.toolName === "Edit" && approval.description.includes(targetFile);
      sink.log("parent.approval", { toolName: approval.toolName, requestId: approval.requestId, granted: okApproval });
      return okApproval;
    },
  };
  const nullUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, sdkCostEstimateUsd: null, providerBilledCostUsd: null };
  const outcomeA: RunnerResult = runA
    ? await runner.run(runA, (event) => {
        eventsA.push(event);
        sink.log("parent.event", { type: event.type, toolName: event.toolName ?? null });
      })
    : { modelSucceeded: true, sessionId: reusedParent, modelReported: null, text: "", error: null, usage: nullUsage };

  if (reusedParent) {
    checks.push({ id: "parent.reused_existing_session", ok: Boolean(reusedParent), detail: reusedParent ?? "none" });
    checks.push({ id: "parent.marker_supplied", ok: marker.length > 0, detail: `len=${marker.length}` });
  } else {
    checks.push({ id: "parent.model_succeeded", ok: outcomeA.modelSucceeded, detail: outcomeA.error ?? "ok" });
    checks.push({ id: "parent.session_uuid", ok: Boolean(outcomeA.sessionId), detail: outcomeA.sessionId ?? "none" });
    checks.push({
      id: "parent.file_updated",
      ok: readFileSync(targetPath, "utf8").includes(marker),
      detail: `bytes=${readFileSync(targetPath, "utf8").length}`,
    });
  }

  const parentTranscript = outcomeA.sessionId ? findSessionTranscript(configRoot, outcomeA.sessionId) : null;
  const parentHashBefore = parentTranscript
    ? createHash("sha256").update(readFileSync(parentTranscript)).digest("hex")
    : null;
  checks.push({ id: "parent.transcript_in_shared_root", ok: Boolean(parentTranscript), detail: parentTranscript ?? "missing" });

  const memoryPrompt =
    "Using only session memory inherited from the parent session, reply with exactly the marker " +
    "that was appended there, prefixed XJOB: and nothing else. Do not use any tools and do not read files.";
  const eventsB: WorkerEvent[] = [];
  const jobB = `job-cross-b-${randomBytes(4).toString("hex")}`;
  const forkRun: RunnerRequest | null = outcomeA.sessionId
    ? {
        jobId: jobB,
        runId: `run-b1-${randomBytes(4).toString("hex")}`,
        cwd: cwdB,
        sourceCwd: cwdB,
        model,
        profile: "read",
        prompt: memoryPrompt,
        maxTurns: 2,
        deadlineMs: 120_000,
        allowedPaths: [],
        allowedSkillNames: [],
        enabledMcpServers: [],
        managedWorktree: false,
        branch: null,
        signal: new AbortController().signal,
        requestApproval: async () => false,
        resumeSessionId: outcomeA.sessionId,
        forkSession: true,
      }
    : null;
  const outcomeB: RunnerResult | null = forkRun
    ? await runner.run(forkRun, (event) => {
        eventsB.push(event);
        sink.log("fork.event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
      })
    : null;
  const forkTools = eventsB.filter((event) => event.type === "tool_start" || event.type === "tool_end");

  checks.push({ id: "fork.ran", ok: Boolean(outcomeB), detail: outcomeB?.error ?? "no parent session" });
  checks.push({ id: "fork.model_succeeded", ok: outcomeB?.modelSucceeded === true, detail: outcomeB?.error ?? "ok" });
  checks.push({
    id: "fork.new_session_id",
    ok: Boolean(outcomeB?.sessionId && outcomeA.sessionId && outcomeB.sessionId !== outcomeA.sessionId),
    detail: `parent=${outcomeA.sessionId ?? "none"} fork=${outcomeB?.sessionId ?? "none"}`,
  });
  checks.push({
    id: "fork.memory_retained_no_marker_in_prompt",
    ok: Boolean(outcomeB && outcomeB.text.includes(marker) && !memoryPrompt.includes(marker)),
    detail: preview(outcomeB?.text ?? "", 80),
  });
  checks.push({ id: "fork.zero_tool_calls", ok: forkTools.length === 0, detail: forkTools.length.toString() });

  const eventsFollow: WorkerEvent[] = [];
  const followRun: RunnerRequest | null = outcomeB?.sessionId
    ? {
        ...forkRun!,
        runId: `run-b2-${randomBytes(4).toString("hex")}`,
        resumeSessionId: outcomeB.sessionId,
        forkSession: false,
        prompt:
          "In this forked session, reply again with exactly the inherited marker, prefixed FOLLOW: and nothing else. " +
          "Do not use any tools and do not read files.",
      }
    : null;
  const outcomeFollow: RunnerResult | null = followRun
    ? await runner.run(followRun, (event) => {
        eventsFollow.push(event);
        sink.log("follow.event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
      })
    : null;
  const followTools = eventsFollow.filter((event) => event.type === "tool_start" || event.type === "tool_end");
  const followPrompt = followRun?.prompt ?? "";

  checks.push({ id: "follow.ran", ok: Boolean(outcomeFollow), detail: outcomeFollow?.error ?? "no fork session" });
  checks.push({ id: "follow.model_succeeded", ok: outcomeFollow?.modelSucceeded === true, detail: outcomeFollow?.error ?? "ok" });
  checks.push({
    id: "follow.same_session_id",
    ok: Boolean(outcomeB?.sessionId && outcomeFollow?.sessionId === outcomeB.sessionId),
    detail: `fork=${outcomeB?.sessionId ?? "none"} follow=${outcomeFollow?.sessionId ?? "none"}`,
  });
  checks.push({
    id: "follow.memory_retained_no_marker_in_prompt",
    ok: Boolean(outcomeFollow && outcomeFollow.text.includes(marker) && !followPrompt.includes(marker)),
    detail: preview(outcomeFollow?.text ?? "", 80),
  });
  checks.push({ id: "follow.zero_tool_calls", ok: followTools.length === 0, detail: followTools.length.toString() });

  const parentAfter = outcomeA.sessionId ? findSessionTranscript(configRoot, outcomeA.sessionId) : null;
  const parentHashAfter = parentAfter
    ? createHash("sha256").update(readFileSync(parentAfter)).digest("hex")
    : null;
  checks.push({
    id: "parent.transcript_unchanged",
    ok: Boolean(parentHashBefore && parentHashAfter && parentHashBefore === parentHashAfter),
    detail: `before=${parentHashBefore?.slice(0, 12) ?? "null"} after=${parentHashAfter?.slice(0, 12) ?? "null"}`,
  });

  const passed = checks.every((check) => check.ok);
  const result = {
    probe: "p1/cross-job-fork",
    status: passed ? "pass" : "fail",
    baseUrl: DEFAULT_BASE_URL,
    model,
    configRoot,
    jobA,
    jobB,
    parentReused: Boolean(reusedParent),
    cwdB,
    sessionA: outcomeA.sessionId,
    sessionB: outcomeB?.sessionId ?? null,
    sessionFollow: outcomeFollow?.sessionId ?? null,
    sdkRunsStarted: (runA ? 1 : 0) + (outcomeB ? 1 : 0) + (outcomeFollow ? 1 : 0),
    runA: runA ? { ...outcomeA, text: preview(outcomeA.text, 100) } : null,
    runB: outcomeB ? { ...outcomeB, text: preview(outcomeB.text, 100) } : null,
    runFollow: outcomeFollow ? { ...outcomeFollow, text: preview(outcomeFollow.text, 100) } : null,
    toolCalls: { parent: eventsA.filter((e) => e.type === "tool_start").length, fork: forkTools.length, follow: followTools.length },
    checks,
    compatWarnings: [
      "canUseTool is shadowed for allowed read tools (Read/Glob/Grep); writes stay behind a real approval callback + PreToolUse",
      "cross-job fork relies on the bridge-owned shared CLAUDE_CONFIG_DIR transcript root; per-job HOME stays isolated",
    ],
    artifactsDir: sink.dir,
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
