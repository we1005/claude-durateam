/**
 * P2 live probe: real streaming steer against a running turn.
 * Queued receipt and SDK ack are recorded separately; `delivered` is only
 * claimed when the SDK echoes the steer message (steer_ack event + transcript).
 *
 * Exit: 0 pass, 1 fail, 2 blocked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
import type { SteerReceipt, WorkerEvent } from "../../task-contracts.js";
import { readSessionRecords } from "./live-transcript.js";

async function main(): Promise<number> {
  const runtimeRoot = resolveRuntimeRoot();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const cwd = join(runtimeRoot, "p2", "steer", stamp);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 5; index += 1) {
    writeFileSync(join(cwd, `note-${index}.txt`), `line for file ${index}: value-${index}\n`, { mode: 0o600 });
  }

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-steer", suffix: "glm-5.3", secrets });
  let credential;
  try {
    credential = loadApiKeyFromFile(resolveKeyFile());
    secrets.push(credential.token);
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { probe: "p2/steer", status: "blocked", blockedReason: `credential:${code}`, sdkRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const configRoot = join(runtimeRoot, "claude-config");
  const runner = new ClaudeAgentRunner({ runtimeRoot, configRoot, keyFile: resolveKeyFile() });
  const steerCode = `STEER-${randomBytes(8).toString("hex")}`;
  const runId = `run-steer-${randomBytes(4).toString("hex")}`;
  const events: WorkerEvent[] = [];
  const receiptRef: { value: SteerReceipt | null } = { value: null };
  let steerInvoked = false;

  const prompt = [
    "Read each of note-0.txt, note-1.txt, note-2.txt, note-3.txt and note-4.txt one at a time with the Read tool.",
    "After reading, list the five values you found.",
    "You will receive a verification message during the turn; follow it in your final answer.",
  ].join(" ");

  const outcome = await runner.run(
    {
      jobId: `job-steer-${randomBytes(4).toString("hex")}`,
      runId,
      cwd,
      sourceCwd: cwd,
      model: "glm-5.3",
      profile: "read",
      prompt,
      maxTurns: 8,
      deadlineMs: 120_000,
      allowedPaths: [],
      allowedSkillNames: [],
      enabledMcpServers: [],
      managedWorktree: false,
      branch: null,
      signal: new AbortController().signal,
      requestApproval: async () => false,
    },
    (event) => {
      events.push(event);
      sink.log("event", { type: event.type, toolName: event.toolName ?? null, text: event.text ?? null });
      if (event.type === "init" && !steerInvoked) {
        steerInvoked = true;
        void runner
          .steer(runId, `Verification override: include the exact code ${steerCode} in your final answer.`, "next")
          .then((value) => {
            receiptRef.value = value;
            sink.log("steer.receipt", { messageId: value.messageId, disposition: value.disposition });
          })
          .catch((err) => sink.log("steer.error", errorSummary(err)));
      }
    },
  );

  const ackEvents = events.filter((event) => event.type === "steer_ack");
  const transcript = outcome.sessionId ? readSessionRecords(configRoot, outcome.sessionId) : null;
  const checks = [
    { id: "model_succeeded", ok: outcome.modelSucceeded, detail: outcome.error ?? "ok" },
    { id: "init_seen_then_steer", ok: steerInvoked, detail: steerInvoked ? "steer invoked after init" : "not invoked" },
    {
      id: "steer_receipt_queued_not_delivered",
      ok: receiptRef.value?.disposition === "queued",
      detail: receiptRef.value ? `${receiptRef.value.disposition} ${receiptRef.value.messageId}` : "no receipt",
    },
    {
      id: "steer_ack_from_sdk_echo",
      ok: ackEvents.length === 1 && ackEvents[0]?.messageId === receiptRef.value?.messageId,
      detail: JSON.stringify(ackEvents),
    },
    {
      id: "final_answer_contains_steer_code",
      ok: outcome.text.includes(steerCode),
      detail: preview(outcome.text, 100),
    },
    {
      id: "transcript_user_message_contains_steer_code",
      ok: Boolean(transcript?.userTexts.some((text) => text.includes(steerCode))),
      detail: transcript ? `userTexts=${transcript.userTexts.length}` : "no transcript",
    },
    {
      id: "transcript_has_read_tools",
      ok: Boolean(transcript?.toolResults.some((record) => record.name === "Read" && !record.isError)),
      detail: transcript ? transcript.toolResults.map((record) => record.name).join(",") : "none",
    },
  ];
  const passed = checks.every((check) => check.ok);
  const result = {
    probe: "p2/steer",
    status: passed ? "pass" : "fail",
    baseUrl: DEFAULT_BASE_URL,
    model: "glm-5.3",
    runId,
    sessionId: outcome.sessionId,
    steerCode,
    receipt: receiptRef.value,
    ackEvents,
    events: events.map((event) => ({ type: event.type, toolName: event.toolName ?? null })),
    outcome: { ...outcome, text: preview(outcome.text, 120) },
    usageSeparate: { steerReceipt: receiptRef.value, sdkAck: ackEvents },
    checks,
    artifactsDir: sink.dir,
    sdkRunsStarted: 1,
    finishedAt: new Date().toISOString(),
  };
  const logText = (await import("node:fs")).readFileSync(sink.logPath, "utf8");
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
