/**
 * P2 live probe: sandboxed-bash profile.
 *
 * Phase 1 (1 live call): real Bash through the SDK with sandbox settings.
 *   - simple Node test + write inside the worktree must succeed;
 *   - write outside the worktree must be denied by the sandbox;
 *   - read a synthetic canary outside the worktree (under the private config
 *     root) must be denied; canary content is never printed;
 *   - ANTHROPIC_AUTH_TOKEN presence in the Bash env is recorded as a boolean only.
 * Evidence comes from the persisted session transcript (tool results), not
 * from the model's prose.
 *
 * Phase 2 (0 calls): forced sandbox-unavailable seam must fail closed before
 * any model call (no host-execution fallback).
 *
 * Exit: 0 pass, 1 fail, 2 blocked (credential).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

async function main(): Promise<number> {
  const runtimeRoot = resolveRuntimeRoot();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const base = join(runtimeRoot, "p2", "sandbox", stamp);
  const cwd = join(base, "project");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  writeFileSync(join(cwd, "README.md"), "# sandbox probe project\n", { mode: 0o600 });

  const configRoot = join(runtimeRoot, "claude-config");
  const canaryDir = join(configRoot, `canary-${randomBytes(4).toString("hex")}`);
  mkdirSync(canaryDir, { recursive: true, mode: 0o700 });
  const canaryPath = join(canaryDir, "secret.txt");
  const canaryValue = `SYNTH-CANARY-${randomBytes(8).toString("hex")}`;
  writeFileSync(canaryPath, `${canaryValue}\n`, { mode: 0o600 });
  const canaryHash = createHash("sha256").update(readFileSync(canaryPath)).digest("hex");
  const outsideWrite = join(base, "outside-write.txt");

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-sandbox-bash", suffix: "glm-5.3", secrets });
  let credential;
  try {
    credential = loadApiKeyFromFile(resolveKeyFile());
    secrets.push(credential.token);
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { probe: "p2/sandbox-bash", status: "blocked", blockedReason: `credential:${code}`, sdkRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const runner = new ClaudeAgentRunner({ runtimeRoot, configRoot, keyFile: resolveKeyFile() });
  const approvals: string[] = [];
  const events: WorkerEvent[] = [];
  const sessionDir = `job-sandbox-${randomBytes(4).toString("hex")}`;
  const prompt = [
    "Use the Bash tool to run these five commands, one per Bash call, and then report every marker you observed:",
    '1) node -e "console.log(\'NODE_OK\', 2+2)"',
    '2) node -e "require(\'node:fs\').writeFileSync(\'sandbox-inside.txt\',\'inside-ok\'); console.log(\'INSIDE_WRITE_OK\')"',
    `3) node -e "try{require('node:fs').writeFileSync('${outsideWrite}','x');console.log('OUTSIDE_WRITE_OK')}catch(e){console.log('OUTSIDE_WRITE_DENIED')}"`,
    `4) node -e "try{require('node:fs').readFileSync('${canaryPath}','utf8');console.log('CANARY_READ_OK')}catch(e){console.log('CANARY_READ_DENIED')}"`,
    '5) node -e "const t=process.env.ANTHROPIC_AUTH_TOKEN||\'\';console.log(\'TOKEN_CLASS:\'+(t.startsWith(\'cdt-proxy-\')?\'PROXY_DUMMY\':\'OTHER\'));console.log(\'BASE_URL_CLASS:\'+(String(process.env.ANTHROPIC_BASE_URL||\'\').includes(\'127.0.0.1\')?\'LOOPBACK\':\'DIRECT\'))"',
    `6) node -e "try{require('node:fs').readFileSync('${resolveKeyFile()}','utf8');console.log('KEYFILE_READ_OK')}catch(e){console.log('KEYFILE_READ_DENIED')}"`,
    "Do not use Write/Edit. Do not print any secret value; only the marker words.",
  ].join("\n");

  const outcome: RunnerResult = await runner.run(
    {
      jobId: sessionDir,
      runId: `run-${randomBytes(4).toString("hex")}`,
      cwd,
      sourceCwd: cwd,
      model: "glm-5.3",
      profile: "sandboxed-bash",
      prompt,
      maxTurns: 8,
      deadlineMs: 180_000,
      allowedPaths: ["."],
      allowedSkillNames: [],
      enabledMcpServers: [],
      managedWorktree: false,
      branch: null,
      signal: new AbortController().signal,
      requestApproval: async (approval) => {
        const granted = approval.toolName === "Bash";
        approvals.push(`${approval.toolName}:${preview(approval.description, 80)}`);
        sink.log("approval", { toolName: approval.toolName, requestId: approval.requestId, granted });
        return granted;
      },
    },
    (event) => {
      events.push(event);
      sink.log("event", { type: event.type, toolName: event.toolName ?? null });
    },
  );

  const transcript = outcome.sessionId ? readSessionRecords(configRoot, outcome.sessionId) : null;
  const toolText = transcript?.toolResults.map((record) => record.text).join("\n") ?? "";
  const bashResults = transcript?.toolResults.filter((record) => record.name === "Bash") ?? [];
  const transcriptPath = outcome.sessionId ? findSessionTranscript(configRoot, outcome.sessionId) : null;
  const sandboxExisted = existsSync("/usr/bin/sandbox-exec");
  const insideFileExists = existsSync(join(cwd, "sandbox-inside.txt"));
  const outsideFileExists = existsSync(outsideWrite);
  const canaryHashAfter = createHash("sha256").update(readFileSync(canaryPath)).digest("hex");
  const tokenClass = /TOKEN_CLASS:(PROXY_DUMMY|OTHER)/.exec(toolText)?.[1] ?? null;
  const baseUrlClass = /BASE_URL_CLASS:(LOOPBACK|DIRECT)/.exec(toolText)?.[1] ?? null;
  const keyFileReadDenied = toolText.includes("KEYFILE_READ_DENIED") && !toolText.includes("KEYFILE_READ_OK");

  // Phase 2: forced unavailable must fail closed with zero model calls.
  const closedRunner = new ClaudeAgentRunner({
    runtimeRoot,
    configRoot,
    keyFile: resolveKeyFile(),
    sandboxAvailableOverride: false,
  });
  const closed = await closedRunner.run(
    {
      jobId: `job-sandbox-closed-${randomBytes(4).toString("hex")}`,
      runId: `run-closed-${randomBytes(4).toString("hex")}`,
      cwd,
      sourceCwd: cwd,
      model: "glm-5.3",
      profile: "sandboxed-bash",
      prompt: "This must never run.",
      maxTurns: 1,
      deadlineMs: 30_000,
      allowedPaths: ["."],
      allowedSkillNames: [],
      enabledMcpServers: [],
      managedWorktree: false,
      branch: null,
      signal: new AbortController().signal,
      requestApproval: async () => false,
    },
    () => {},
  );

  const checks = [
    { id: "model_succeeded", ok: outcome.modelSucceeded, detail: outcome.error ?? "ok" },
    { id: "sandbox_exec_present", ok: sandboxExisted, detail: sandboxExisted ? "present" : "missing" },
    {
      id: "bash_tool_used_via_real_approval",
      ok: bashResults.length > 0 && approvals.some((entry) => entry.startsWith("Bash:")),
      detail: `bashResults=${bashResults.length} approvals=${approvals.join(" | ")}`,
    },
    { id: "node_test_ran", ok: toolText.includes("NODE_OK"), detail: "NODE_OK marker" },
    {
      id: "inside_write_allowed",
      ok: toolText.includes("INSIDE_WRITE_OK") && insideFileExists,
      detail: `marker=${toolText.includes("INSIDE_WRITE_OK")} file=${insideFileExists}`,
    },
    {
      id: "outside_write_denied_by_sandbox",
      ok: toolText.includes("OUTSIDE_WRITE_DENIED") && !toolText.includes("OUTSIDE_WRITE_OK") && !outsideFileExists,
      detail: `deniedMarker=${toolText.includes("OUTSIDE_WRITE_DENIED")} fileExists=${outsideFileExists}`,
    },
    {
      id: "outside_canary_read_denied",
      ok: toolText.includes("CANARY_READ_DENIED") && !toolText.includes("CANARY_READ_OK"),
      detail: `deniedMarker=${toolText.includes("CANARY_READ_DENIED")}`,
    },
    { id: "canary_unchanged", ok: canaryHash === canaryHashAfter, detail: "sha256 compared" },
    {
      id: "bash_gets_proxy_dummy_not_real_token",
      ok: tokenClass === "PROXY_DUMMY",
      detail: `TOKEN_CLASS:${tokenClass ?? "UNKNOWN"}`,
    },
    {
      id: "bash_base_url_is_loopback_proxy",
      ok: baseUrlClass === "LOOPBACK",
      detail: `BASE_URL_CLASS:${baseUrlClass ?? "UNKNOWN"}`,
    },
    {
      id: "credential_keyfile_read_denied",
      ok: keyFileReadDenied,
      detail: keyFileReadDenied ? "KEYFILE_READ_DENIED" : "not denied",
    },
    {
      id: "sandbox_unavailable_fails_closed",
      ok: closed.modelSucceeded === false && /sandbox_unavailable/.test(closed.error ?? "") && closed.sessionId === null,
      detail: closed.error ?? "unexpected run",
    },
  ];
  const passed = checks.every((check) => check.ok);
  const result = {
    probe: "p2/sandbox-bash",
    status: passed ? "pass" : "fail",
    baseUrl: DEFAULT_BASE_URL,
    model: "glm-5.3",
    cwd,
    configRoot,
    sessionId: outcome.sessionId,
    transcriptPath,
    sdkRunsStarted: 1,
    approvals,
    bashToolResults: bashResults.length,
    sandboxEnforced: toolText.includes("OUTSIDE_WRITE_DENIED") && !outsideFileExists,
    tokenEnvExposedInBash: tokenClass !== "PROXY_DUMMY",
    tokenClass,
    baseUrlClass,
    keyFileReadDenied,
    outsideWriteFileExists: outsideFileExists,
    insideFileExists,
    canaryUnchanged: canaryHash === canaryHashAfter,
    sandboxAvailableOverride: true,
    failClosedResult: { modelSucceeded: closed.modelSucceeded, error: closed.error, sessionId: closed.sessionId },
    outcome: { ...outcome, text: preview(outcome.text, 120) },
    usage: outcome.usage,
    checks,
    artifactsDir: sink.dir,
    finishedAt: new Date().toISOString(),
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
