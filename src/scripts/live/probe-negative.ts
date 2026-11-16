/**
 * P0 negative credential probes.
 *
 *  - `missing`  : absent key file must be refused locally, with ZERO network calls.
 *  - `malformed`: multi-line / ambiguous credential file must be refused locally.
 *  - `wrong-token`: a syntactically valid but invalid token must be rejected by
 *    the endpoint, with no fallback to an Anthropic subscription credential and
 *    no credential value in artifacts.
 *
 * Exit codes: 0 = expected behavior observed, 1 = unexpected.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CredentialError,
  assertIsolatedEnv,
  buildWorkerEnv,
  loadApiKeyFromFile,
  prepareWorkerHome,
  resolveRuntimeRoot,
} from "../../engines/environment.js";
import type { WorkerModel } from "../../contracts.js";
import { absorbMessage, type ProbeObservation } from "../../engines/sdk-messages.js";
import { createArtifactSink, errorSummary } from "../../observability/artifacts.js";
import { redactSecrets } from "../../observability/redact.js";

async function exerciseSdkWithToken(options: {
  env: Record<string, string>;
  projectDir: string;
  model: WorkerModel;
  timeoutMs: number;
  secrets: readonly string[];
}): Promise<ProbeObservation> {
  const observation: ProbeObservation = {
    toolUses: [],
    toolResults: [],
    assistantTexts: [],
    assistantErrors: [],
    messageTypes: {},
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const queryOptions: Options = {
    cwd: options.projectDir,
    model: options.model,
    env: options.env,
    abortController: controller,
    settingSources: [],
    permissionMode: "dontAsk",
    tools: ["Read"],
    allowedTools: ["Read"],
    disallowedTools: ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "Task", "Skill"],
    skills: [],
    plugins: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: 1,
    persistSession: false,
  };
  const q = query({ prompt: "Reply with exactly: PROBE_ERROR_PATH", options: queryOptions });
  try {
    for await (const message of q as AsyncIterable<SDKMessage>) {
      absorbMessage(observation, message, options.secrets);
    }
  } catch {
    // Auth failures may surface as a thrown error after the error result.
  } finally {
    clearTimeout(timer);
    try {
      q.close();
    } catch {
      /* terminating */
    }
  }
  return observation;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      case: { type: "string", default: "missing" },
      model: { type: "string", default: "glm-5.3" },
      "timeout-ms": { type: "string", default: "90000" },
    },
    strict: true,
  });
  const testCase = values.case;
  if (!["missing", "malformed", "wrong-token"].includes(testCase)) {
    throw new Error(`unsupported --case: ${testCase}`);
  }

  const runtimeRoot = resolveRuntimeRoot();
  const runDir = join(
    runtimeRoot,
    "p0",
    "negative",
    `${testCase}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const secrets: string[] = [];
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: `live-negative-${testCase}`, secrets });

  const keyFile = join(runDir, "input-key.txt");
  let expected: "refused-local" | "refused-endpoint" = "refused-local";

  if (testCase === "missing") {
    // Deliberately do not create the file. No credential is loaded, so no secret exists.
  } else if (testCase === "malformed") {
    writeFileSync(keyFile, "line-one\nline-two\n", { mode: 0o600 });
  } else {
    // Fake token with a plausible shape; never the operator's real credential.
    const fake = `ARK-FAKE-${randomBytes(18).toString("base64url")}`;
    writeFileSync(keyFile, `${fake}\n`, { mode: 0o600 });
    secrets.push(fake);
    expected = "refused-endpoint";
  }

  const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];
  let sdkRunsStarted = 0;
  let modelReported: string | null = null;
  let apiKeySource: string | null = null;
  let resultSummary: Record<string, unknown> | null = null;

  try {
    const credential = loadApiKeyFromFile(keyFile);
    secrets.push(credential.token);
    checks.push({ id: "credential.accepted", ok: true });
    const workerHome = prepareWorkerHome(runDir, "worker-home");
    const built = buildWorkerEnv({ credential, model: values.model as WorkerModel, workerHome });
    assertIsolatedEnv(built.env, runtimeRoot);
    const projectDir = join(runDir, "project");
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(projectDir, "README.md"), "# negative probe\n", { mode: 0o600 });

    sdkRunsStarted = 1;
    const observation = await exerciseSdkWithToken({
      env: built.env,
      projectDir,
      model: values.model as WorkerModel,
      timeoutMs: Number.parseInt(values["timeout-ms"], 10),
      secrets,
    });
    modelReported = observation.init?.model ?? null;
    apiKeySource = observation.init?.apiKeySource ?? null;
    resultSummary = observation.result
      ? {
          subtype: observation.result.subtype,
          isError: observation.result.isError,
          errors: observation.result.errors,
          usage: observation.result.usage,
        }
      : null;

    checks.push({
      id: "endpoint.rejected",
      ok: observation.result?.subtype !== "success",
      detail: observation.result?.subtype ?? "no result",
    });
    checks.push({
      id: "no.subscription.fallback",
      ok: observation.init?.apiKeySource === "none",
      detail: `apiKeySource=${observation.init?.apiKeySource ?? "unknown"}`,
    });
    checks.push({
      id: "no.successful.assistant",
      ok: observation.assistantErrors.length > 0 || observation.result?.isError !== false,
      detail: observation.assistantErrors.join(","),
    });
  } catch (err) {
    const code = err instanceof CredentialError ? err.code : "unknown";
    checks.push({ id: "credential.refused.locally", ok: code !== "unknown", detail: `code=${code}` });
    checks.push({ id: "no.sdk.run", ok: sdkRunsStarted === 0 });
  }

  const passed = checks.every((check) => check.ok) && expected === (sdkRunsStarted === 0 ? "refused-local" : "refused-endpoint");
  const result = {
    probe: "p0/negative",
    case: testCase,
    expected,
    status: passed ? "pass" : "fail",
    sdkRunsStarted,
    modelReported,
    apiKeySource,
    result: resultSummary,
    checks,
    artifactsDir: sink.dir,
    finishedAt: new Date().toISOString(),
  };

  const logText = readLogSafe(sink.logPath);
  const leak = secrets.some((secret) => secret.length >= 6 && logText.includes(secret));
  if (leak) {
    writeFileSync(sink.logPath, "[purged by leak guard]\n", { mode: 0o600 });
    checks.push({ id: "secrets.absent_from_log", ok: false });
  } else {
    checks.push({ id: "secrets.absent_from_log", ok: true });
  }

  const finalPassed = checks.every((check) => check.ok);
  sink.finalize(finalPassed ? 0 : 1, { ...result, status: finalPassed ? "pass" : "fail" });
  console.log(JSON.stringify(redactSecrets(JSON.stringify({ ...result, status: finalPassed ? "pass" : "fail", checks }))));
  return finalPassed ? 0 : 1;
}

function readLogSafe(path: string): string {
  try {
    return process.getBuiltinModule("node:fs").readFileSync(path, "utf8") as string;
  } catch {
    return "";
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", ...errorSummary(err) }));
    process.exit(1);
  });
