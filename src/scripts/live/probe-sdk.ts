/**
 * P0 live probe (SDK path): one small, bounded Read task against the
 * Volcengine Coding Plan endpoint, through the official Claude Agent SDK.
 *
 * It answers exactly one question: does a real Claude Code Agent, running with
 * `settingSources: []` and an isolated HOME/CLAUDE_CONFIG_DIR, successfully
 * execute `Read` -> tool result -> final answer on `glm-5.3` / `glm-5.3-flash`?
 *
 * Usage:
 *   npm run test:live:sdk -- --model glm-5.3
 *   CLAUDE_DURATEAM_KEY_FILE=/path/to/key npm run test:live:sdk -- --model glm-5.3-flash
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = blocked before any network call.
 */

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import {
  WORKER_MODELS,
  isWorkerModel,
  type WorkerModel,
} from "../../contracts.js";
import {
  DEFAULT_BASE_URL,
  CredentialError,
  assertAllowedModel,
  assertIsolatedEnv,
  buildWorkerEnv,
  loadApiKeyFromFile,
  prepareWorkerHome,
  resolveKeyFile,
  resolveRuntimeRoot,
  type LoadedCredential,
} from "../../engines/environment.js";
import { absorbMessage, type ProbeObservation } from "../../engines/sdk-messages.js";
import { createArtifactSink, errorSummary, type ArtifactSink } from "../../observability/artifacts.js";
import { assertNoSecret, preview, redactSecrets } from "../../observability/redact.js";

interface Check {
  id: string;
  ok: boolean;
  detail?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProbeDeps {
  runDir: string;
  projectDir: string;
  targetFile: string;
  decoyFile: string;
  nonce: string;
  decoyNonce: string;
}

function makeProbeFiles(runDir: string): ProbeDeps {
  const suffix = randomBytes(6).toString("hex");
  const projectDir = join(runDir, "project");
  const targetFile = `probe-${suffix}.txt`;
  const decoyFile = `decoy-${suffix}.txt`;
  const nonce = `CDT-${randomBytes(12).toString("base64url")}`;
  const decoyNonce = `CDT-${randomBytes(12).toString("base64url")}`;
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, targetFile), `${nonce}\n`, { mode: 0o600 });
  writeFileSync(join(projectDir, decoyFile), `${decoyNonce}\n`, { mode: 0o600 });
  writeFileSync(
    join(projectDir, "README.md"),
    "# P0 probe workspace\n\nThis directory exists only for the claude-durateam P0 read probe.\n",
    { mode: 0o600 },
  );
  return { runDir, projectDir, targetFile, decoyFile, nonce, decoyNonce };
}

function buildPrompt(targetFile: string): string {
  return [
    "You are a constrained verification worker.",
    `Use the Read tool to open the file named ${targetFile} in the current working directory.`,
    "The file contains exactly one random marker string on a single line.",
    "Reply with that marker string and nothing else.",
    "Do not guess and do not read any other file. If the Read tool fails, reply exactly READ_FAILED.",
  ].join(" ");
}

interface RunOutcome {
  observation: ProbeObservation;
  timedOut: boolean;
  error?: { name: string; message: string };
  stderrLines: string[];
}

async function runReadProbe(options: {
  env: Record<string, string>;
  projectDir: string;
  targetFile: string;
  model: WorkerModel;
  timeoutMs: number;
  secrets: readonly string[];
  sink: ArtifactSink;
}): Promise<RunOutcome> {
  const observation: ProbeObservation = {
    toolUses: [],
    toolResults: [],
    assistantTexts: [],
    messageTypes: {},
    assistantErrors: [],
  };
  const stderrLines: string[] = [];
  const controller = new AbortController();
  let timedOut = false;
  let hardTimer: NodeJS.Timeout | undefined;

  const softTimer = setTimeout(() => {
    timedOut = true;
    options.sink.log("timeout.soft_abort", { timeoutMs: options.timeoutMs });
    controller.abort();
    hardTimer = setTimeout(() => {
      options.sink.log("timeout.hard_exit", {});
      process.exit(1);
    }, 20_000);
    hardTimer.unref?.();
  }, options.timeoutMs);
  softTimer.unref?.();

  const queryOptions: Options = {
    cwd: options.projectDir,
    model: options.model,
    env: options.env,
    abortController: controller,
    // Isolation: load no filesystem settings (no user/project/local config).
    settingSources: [],
    permissionMode: "dontAsk",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: [
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
      "BashOutput",
      "KillShell",
      "WebFetch",
      "WebSearch",
      "Task",
      "Skill",
      "SlashCommand",
    ],
    skills: [],
    plugins: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: 3,
    persistSession: true,
    stderr: (data: string) => {
      const safe = redactSecrets(data, options.secrets).replace(/\s+/g, " ").trim();
      if (safe.length === 0 || stderrLines.length > 80) return;
      if (stderrLines[stderrLines.length - 1] === safe) return;
      stderrLines.push(preview(safe, 240));
    },
  };

  const q = query({ prompt: buildPrompt(options.targetFile), options: queryOptions });

  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      const trace = absorbMessage(observation, message, options.secrets);
      options.sink.log("sdk.message", trace);
    }
  } catch (err) {
    return {
      observation,
      timedOut,
      error: errorSummary(err, options.secrets),
      stderrLines,
    };
  } finally {
    clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    try {
      q.close();
    } catch {
      /* the run is already terminating */
    }
  }

  return { observation, timedOut, stderrLines };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", default: "glm-5.3" },
      "timeout-ms": { type: "string", default: "180000" },
      "keep-files": { type: "boolean", default: false },
    },
    strict: true,
  });

  const modelArg = values.model;
  if (!isWorkerModel(modelArg)) {
    throw new Error(`unsupported --model: ${modelArg} (allowed: ${WORKER_MODELS.join(", ")})`);
  }
  assertAllowedModel(modelArg);
  const model: WorkerModel = modelArg;
  const timeoutMs = Number.parseInt(values["timeout-ms"], 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000) {
    throw new Error("--timeout-ms must be >= 30000");
  }

  const runtimeRoot = resolveRuntimeRoot();
  const runId = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${model}-${randomBytes(3).toString("hex")}`;
  const runDir = join(runtimeRoot, "p0", "sdk", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const artifactRoot = ".artifacts";
  let credential: LoadedCredential | undefined;
  const secrets: string[] = [];
  const sink = createArtifactSink({
    artifactRoot,
    kind: "live-sdk-read",
    suffix: model,
    secrets,
  });

  const baseResult = {
    probe: "p0/sdk-read",
    modelRequested: model,
    baseUrl: DEFAULT_BASE_URL,
    keyFileEnv: "CLAUDE_DURATEAM_KEY_FILE",
    runtimeDir: runDir,
    startedAt: new Date().toISOString(),
  };

  try {
    try {
      const keyFile = resolveKeyFile();
      const loaded = loadApiKeyFromFile(keyFile);
      credential = loaded;
      secrets.push(loaded.token);
      sink.log("credential.loaded", {
        format: loaded.format,
        sourceBytes: loaded.sourceBytes,
        sourceFile: loaded.sourcePath,
      });
    } catch (err) {
      const summary = errorSummary(err);
      const code = err instanceof CredentialError ? err.code : "unknown";
      sink.log("credential.blocked", { code, ...summary });
      const result = {
        ...baseResult,
        status: "blocked",
        blockedReason: `credential:${code}`,
        checks: [{ id: "credential.loaded", ok: false, detail: summary.message }],
        sdkRunsStarted: 0,
      };
      sink.finalize(2, result);
      console.log(JSON.stringify(redactSecrets(JSON.stringify(result))));
      return 2;
    }

    const workerHome = prepareWorkerHome(runDir, "worker-home");
    if (!credential) throw new Error("credential missing after load");
    const built = buildWorkerEnv({ credential, model, workerHome });
    assertIsolatedEnv(built.env, runtimeRoot);
    sink.log("env.ready", {
      baseUrl: built.summary.baseUrl,
      model: built.summary.model,
      home: built.summary.home,
      configDir: built.summary.claudeConfigDir,
      setKeys: built.summary.setKeys.filter(
        (k) => !k.includes("TOKEN") && !k.includes("KEY") && !k.includes("SECRET"),
      ),
      inheritedKeys: built.summary.inheritedKeys,
    });

    const files = makeProbeFiles(runDir);
    const outcome = await runReadProbe({
      env: built.env,
      projectDir: files.projectDir,
      targetFile: files.targetFile,
      model,
      timeoutMs,
      secrets,
      sink,
    });
    const { observation } = outcome;

    const readToolUse = observation.toolUses.find(
      (use) => use.name === "Read" && use.filePath?.includes(files.targetFile),
    );
    const readResult = readToolUse
      ? observation.toolResults.find((result) => result.toolUseId === readToolUse.id)
      : undefined;
    const finalText = observation.result?.resultText ?? "";
    const finalAnswer = finalText;

    const checks: Check[] = [
      { id: "credential.loaded", ok: Boolean(credential) },
      { id: "env.isolated", ok: true, detail: `HOME=${built.summary.home}` },
      { id: "init.received", ok: Boolean(observation.init) },
      {
        id: "init.model.reported",
        ok: Boolean(observation.init?.model) && (observation.init?.model ?? "").toLowerCase().includes("glm"),
        detail: `requested=${model} reported=${observation.init?.model ?? "none"}`,
      },
      {
        id: "init.session_id.uuid",
        ok: UUID_RE.test(observation.init?.sessionId ?? ""),
        detail: observation.init?.sessionId ?? "none",
      },
      {
        id: "init.mcp.servers.empty",
        ok: (observation.init?.mcpServers.length ?? -1) === 0,
        detail: JSON.stringify(observation.init?.mcpServers ?? null),
      },
      {
        id: "init.tools.no_write_or_exec",
        ok:
          observation.init !== undefined &&
          !observation.init.tools.some((tool) =>
            ["Write", "Edit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task"].includes(tool),
          ),
        detail: observation.init?.tools.join(",") ?? "none",
      },
      {
        id: "tooluse.read.target_file",
        ok: Boolean(readToolUse),
        detail: readToolUse ? `id=${readToolUse.id} path=${readToolUse.filePath}` : "no Read tool_use observed",
      },
      {
        id: "toolresult.read.success",
        ok: Boolean(readResult) && readResult?.isError === false,
        detail: readResult ? `len=${readResult.textLength}` : "no tool_result observed",
      },
      {
        id: "toolresult.read.nonce",
        ok: Boolean(readResult) && readResult!.textPreview.includes(files.nonce),
        detail: readResult ? "checked in tool_result preview" : "no tool_result",
      },
      {
        id: "result.success",
        ok: observation.result?.subtype === "success" && observation.result?.isError === false,
        detail: observation.result ? `subtype=${observation.result.subtype} is_error=${observation.result.isError}` : "no result",
      },
      {
        id: "result.final_answer.nonce",
        ok: finalAnswer.includes(files.nonce),
        detail: finalAnswer.includes(files.nonce) ? "nonce present" : "nonce missing",
      },
      {
        id: "isolation.no_subscription_fallback",
        ok: observation.init?.apiKeySource === "none",
        detail: `apiKeySource=${observation.init?.apiKeySource ?? "unknown"}`,
      },
      {
        id: "run.not_timed_out",
        ok: !outcome.timedOut,
        detail: outcome.timedOut ? `aborted after ${timeoutMs}ms` : "within budget",
      },
      { id: "secrets.absent_from_log", ok: false, detail: "checked below" },
    ];

    if (outcome.error) sink.log("sdk.error", outcome.error);
    if (observation.assistantErrors.length > 0) {
      sink.log("sdk.assistant.errors", { errors: observation.assistantErrors });
    }
    if (outcome.stderrLines.length > 0) sink.log("sdk.stderr", { lines: outcome.stderrLines.slice(-20) });

    // Hard leak guard on the JSONL trace before finalizing.
    let logText = "";
    try {
      logText = readFileSync(sink.logPath, "utf8");
    } catch {
      logText = "";
    }
    const secretLeak = secrets.some((secret) => secret.length >= 6 && logText.includes(secret));
    const leakCheck = checks.find((check) => check.id === "secrets.absent_from_log");
    if (leakCheck) {
      leakCheck.ok = !secretLeak;
      if (secretLeak) {
        leakCheck.detail = "credential appeared in run.log — purged";
        writeFileSync(sink.logPath, "[purged by leak guard]\n", { mode: 0o600 });
      }
    }

    const passed = checks.every((check) => check.ok);
    const compatWarnings: string[] = [];
    if (observation.init?.model && observation.init.model !== model) {
      compatWarnings.push(
        `endpoint reported model '${observation.init.model}' for requested '${model}' (check alias routing)`,
      );
    }
    if (observation.result?.usage.outputTokens === undefined && (observation.result?.usage.inputTokens ?? 0) > 0) {
      compatWarnings.push("usage.output_tokens missing from result; token accounting is partial");
    }
    if (observation.result && observation.result.modelUsageKeys.length === 0) {
      compatWarnings.push("modelUsage empty; per-model usage unavailable on this endpoint");
    }
    if (observation.init?.skills && observation.init.skills.length > 0) {
      compatWarnings.push(`skills loaded despite skills:[]: ${observation.init.skills.join(",")}`);
    }

    const result = {
      ...baseResult,
      status: passed ? "pass" : "fail",
      finishedAt: new Date().toISOString(),
      sdkRunsStarted: 1,
      modelReported: observation.init?.model ?? null,
      sessionId: observation.init?.sessionId ?? observation.result?.sessionId ?? null,
      init: observation.init ?? null,
      toolChain: {
        toolUses: observation.toolUses.map((use) => ({ name: use.name, filePath: use.filePath, id: use.id })),
        toolResults: observation.toolResults.map((res) => ({
          toolUseId: res.toolUseId,
          isError: res.isError,
          textLength: res.textLength,
          nonceVisible: res.textPreview.includes(files.nonce),
        })),
        assistantTextCount: observation.assistantTexts.length,
      },
      result: observation.result
        ? {
            subtype: observation.result.subtype,
            isError: observation.result.isError,
            numTurns: observation.result.numTurns,
            durationMs: observation.result.durationMs,
            sessionId: observation.result.sessionId,
            usage: observation.result.usage,
            modelUsageKeys: observation.result.modelUsageKeys,
            sdkCostEstimateUsd: observation.result.totalCostUsd,
            costNote: "SDK local estimate only; NOT Volcengine Coding Plan billing",
            errors: observation.result.errors,
          }
        : null,
      answerPreview: preview(finalText, 80),
      expectedNonceLength: files.nonce.length,
      nonceMatched: finalAnswer.includes(files.nonce),
      decoyNonceLeaked: finalAnswer.includes(files.decoyNonce),
      checks,
      compatWarnings,
      messageTypes: observation.messageTypes,
      stderrTail: outcome.stderrLines.slice(-5),
      artifactsDir: sink.dir,
      probeFiles: values["keep-files"] ? { projectDir: files.projectDir } : { projectDir: "(retained in runtime dir)" },
      limits: {
        maxTurns: 3,
        tools: ["Read", "Glob", "Grep"],
        settingSources: [],
        isolatedHome: true,
        timeoutMs,
      },
    };

    sink.finalize(passed ? 0 : 1, result);
    console.log(JSON.stringify(redactSecrets(JSON.stringify(result))));
    return passed ? 0 : 1;
  } catch (err) {
    const summary = errorSummary(err, secrets);
    sink.log("probe.fatal", summary);
    sink.finalize(1, {
      ...baseResult,
      status: "fail",
      fatal: summary,
      artifactsDir: sink.dir,
    });
    console.log(JSON.stringify(redactSecrets(JSON.stringify({ status: "fail", ...summary, artifactsDir: sink.dir }))));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", ...errorSummary(err) }));
    process.exit(1);
  });
