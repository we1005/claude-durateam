/**
 * P0 CLI-path probe: `claude -p` against the Volcengine Coding Plan with an
 * isolated HOME/config, `--restricted` (no user/project/local settings) and
 * Read-only tools. One tiny task; bounded by a wall clock.
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = blocked before any network call.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isWorkerModel, type WorkerModel } from "../../contracts.js";
import {
  CredentialError,
  DEFAULT_BASE_URL,
  assertIsolatedEnv,
  buildWorkerEnv,
  loadApiKeyFromFile,
  prepareWorkerHome,
  resolveKeyFile,
  resolveRuntimeRoot,
  type LoadedCredential,
} from "../../engines/environment.js";
import { absorbMessage, type ProbeObservation } from "../../engines/sdk-messages.js";
import { createArtifactSink, errorSummary } from "../../observability/artifacts.js";
import { preview, redactSecrets } from "../../observability/redact.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CliRun {
  observation: ProbeObservation;
  timedOut: boolean;
  exitCode: number | null;
  stderrLines: string[];
  rawStdoutJunk: string[];
}

function buildClaudeArgs(prompt: string, model: WorkerModel): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read,Glob,Grep",
    "--tools",
    "Read,Glob,Grep",
    // Ignore user/project/local settings and confine file tools to the cwd.
    "--restricted",
    "--strict-mcp-config",
  ];
}

async function runCli(options: {
  env: Record<string, string>;
  projectDir: string;
  prompt: string;
  model: WorkerModel;
  timeoutMs: number;
  secrets: readonly string[];
}): Promise<CliRun> {
  const observation: ProbeObservation = {
    toolUses: [],
    toolResults: [],
    assistantTexts: [],
    assistantErrors: [],
    messageTypes: {},
  };
  const stderrLines: string[] = [];
  const rawStdoutJunk: string[] = [];
  const args = buildClaudeArgs(options.prompt, options.model);
  const bin = process.env["CDT_CLAUDE_BIN"] ?? "claude";

  return await new Promise<CliRun>((resolveRun) => {
    let timedOut = false;
    let finished = false;
    const child = spawn(bin, args, {
      cwd: options.projectDir,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, options.timeoutMs);
    killTimer.unref?.();

    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      resolveRun({ observation, timedOut, exitCode, stderrLines, rawStdoutJunk });
    };

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0) continue;
        try {
          const parsed = JSON.parse(trimmedLine) as SDKMessage;
          absorbMessage(observation, parsed, options.secrets);
        } catch {
          if (rawStdoutJunk.length < 20) {
            rawStdoutJunk.push(preview(redactSecrets(trimmedLine, options.secrets), 200));
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const safe = redactSecrets(chunk.toString("utf8"), options.secrets).replace(/\s+/g, " ").trim();
      if (safe.length > 0 && stderrLines.length < 80) stderrLines.push(preview(safe, 240));
    });

    child.on("error", (err) => {
      stderrLines.push(preview(redactSecrets(String(err), options.secrets), 240));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", default: "glm-5.3" },
      "timeout-ms": { type: "string", default: "120000" },
    },
    strict: true,
  });
  const modelArg = values.model;
  if (!isWorkerModel(modelArg)) throw new Error(`unsupported --model: ${modelArg}`);
  const model: WorkerModel = modelArg;
  const timeoutMs = Number.parseInt(values["timeout-ms"], 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) throw new Error("--timeout-ms must be >= 30000");

  const runtimeRoot = resolveRuntimeRoot();
  const runId = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${model}-${randomBytes(3).toString("hex")}`;
  const runDir = join(runtimeRoot, "p0", "cli", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "live-cli-read", suffix: model, secrets });
  const baseResult = {
    probe: "p0/cli-read",
    modelRequested: model,
    baseUrl: DEFAULT_BASE_URL,
    runtimeDir: runDir,
    startedAt: new Date().toISOString(),
    cliArgs: buildClaudeArgs("<prompt>", model),
  };

  let credential: LoadedCredential;
  try {
    const loaded = loadApiKeyFromFile(resolveKeyFile());
    secrets.push(loaded.token);
    credential = loaded;
    sink.log("credential.loaded", { format: loaded.format, sourceBytes: loaded.sourceBytes });
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    sink.finalize(2, { ...baseResult, status: "blocked", blockedReason: `credential:${code}`, cliRunsStarted: 0 });
    console.log(JSON.stringify({ status: "blocked", blockedReason: `credential:${code}` }));
    return 2;
  }

  const workerHome = prepareWorkerHome(runDir, "worker-home");
  const built = buildWorkerEnv({ credential, model, workerHome });
  assertIsolatedEnv(built.env, runtimeRoot);
  sink.log("env.ready", {
    baseUrl: built.summary.baseUrl,
    home: built.summary.home,
    configDir: built.summary.claudeConfigDir,
    inheritedKeys: built.summary.inheritedKeys,
  });

  const suffix = randomBytes(6).toString("hex");
  const projectDir = join(runDir, "project");
  const targetFile = `probe-${suffix}.txt`;
  const decoyFile = `decoy-${suffix}.txt`;
  const nonce = `CDT-${randomBytes(12).toString("base64url")}`;
  const decoyNonce = `CDT-${randomBytes(12).toString("base64url")}`;
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, targetFile), `${nonce}\n`, { mode: 0o600 });
  writeFileSync(join(projectDir, decoyFile), `${decoyNonce}\n`, { mode: 0o600 });
  const prompt = [
    "You are a constrained verification worker.",
    `Use the Read tool to open the file named ${targetFile} in the current working directory.`,
    "The file contains exactly one random marker string on a single line.",
    "Reply with that marker string and nothing else.",
    "Do not guess and do not read any other file. If the Read tool fails, reply exactly READ_FAILED.",
  ].join(" ");

  const run = await runCli({ env: built.env, projectDir, prompt, model, timeoutMs, secrets });
  const observation = run.observation;
  const readToolUse = observation.toolUses.find(
    (use) => use.name === "Read" && use.filePath?.includes(targetFile),
  );
  const readResult = readToolUse
    ? observation.toolResults.find((result) => result.toolUseId === readToolUse.id)
    : undefined;
  const finalText = observation.result?.resultText ?? "";

  const checks = [
    { id: "credential.loaded", ok: true },
    { id: "cli.exit.zero", ok: run.exitCode === 0, detail: `exit=${run.exitCode}` },
    { id: "init.received", ok: Boolean(observation.init) },
    {
      id: "init.model.reported",
      ok: (observation.init?.model ?? "").toLowerCase().includes("glm"),
      detail: `requested=${model} reported=${observation.init?.model ?? "none"}`,
    },
    { id: "init.session_id.uuid", ok: UUID_RE.test(observation.init?.sessionId ?? "") },
    {
      id: "init.mcp.servers.empty",
      ok: (observation.init?.mcpServers.length ?? -1) === 0,
      detail: JSON.stringify(observation.init?.mcpServers ?? null),
    },
    {
      id: "init.tools.no_write_or_exec",
      ok: !(observation.init?.tools ?? []).some((tool) =>
        ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "Task"].includes(tool),
      ),
      detail: (observation.init?.tools ?? []).join(","),
    },
    { id: "tooluse.read.target_file", ok: Boolean(readToolUse) },
    { id: "toolresult.read.success", ok: Boolean(readResult) && readResult?.isError === false },
    {
      id: "toolresult.read.nonce",
      ok: Boolean(readResult) && readResult!.textPreview.includes(nonce),
    },
    {
      id: "result.success",
      ok: observation.result?.subtype === "success" && observation.result?.isError === false,
      detail: observation.result?.subtype ?? "none",
    },
    { id: "result.final_answer.nonce", ok: finalText.includes(nonce) },
    {
      id: "isolation.no_subscription_fallback",
      ok: observation.init?.apiKeySource === "none",
      detail: `apiKeySource=${observation.init?.apiKeySource ?? "unknown"}`,
    },
    { id: "stdout.jsonl.clean", ok: run.rawStdoutJunk.length === 0, detail: run.rawStdoutJunk.join(" | ") },
    { id: "run.not_timed_out", ok: !run.timedOut },
  ];
  const passed = checks.every((check) => check.ok);

  if (run.stderrLines.length > 0) sink.log("cli.stderr", { lines: run.stderrLines.slice(-20) });
  const result = {
    ...baseResult,
    status: passed ? "pass" : "fail",
    finishedAt: new Date().toISOString(),
    cliRunsStarted: 1,
    modelReported: observation.init?.model ?? null,
    sessionId: observation.init?.sessionId ?? observation.result?.sessionId ?? null,
    init: observation.init ?? null,
    toolChain: {
      toolUses: observation.toolUses.map((use) => ({ name: use.name, filePath: use.filePath })),
      toolResults: observation.toolResults.map((res) => ({
        isError: res.isError,
        textLength: res.textLength,
        nonceVisible: res.textPreview.includes(nonce),
      })),
    },
    result: observation.result
      ? {
          subtype: observation.result.subtype,
          isError: observation.result.isError,
          numTurns: observation.result.numTurns,
          durationMs: observation.result.durationMs,
          usage: observation.result.usage,
          modelUsageKeys: observation.result.modelUsageKeys,
          sdkCostEstimateUsd: observation.result.totalCostUsd,
          errors: observation.result.errors,
        }
      : null,
    answerPreview: preview(finalText, 80),
    nonceMatched: finalText.includes(nonce),
    decoyNonceLeaked: finalText.includes(decoyNonce),
    checks,
    stderrTail: run.stderrLines.slice(-5),
    stdoutJunk: run.rawStdoutJunk,
    exitCodeObserved: run.exitCode,
    timedOut: run.timedOut,
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
