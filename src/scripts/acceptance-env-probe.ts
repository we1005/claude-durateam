/**
 * Acceptance-only probe (QA-owned; not product runtime).
 *
 * Runs the real ClaudeAgentRunner preflight with a fake SDK stream and prints
 * a JSON summary of the effective worker env. It never contacts a provider and
 * never prints credential values. Used by test/acceptance-runner-safety.test.ts
 * to prove that hostile parent env vars (ANTHROPIC_API_KEY / OAuth / proxy /
 * unrelated secrets) are not inherited into the worker env.
 */

import { ClaudeAgentRunner, type QueryFactory } from "../engines/agent-runner.js";
import { DEFAULT_BASE_URL } from "../engines/environment.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunnerRequest } from "../task-contracts.js";
import { existsSync, statSync } from "node:fs";

const REQUIRED = ["CDT_QA_RUNTIME", "CDT_QA_KEY_FILE", "CDT_QA_CWD", "CDT_QA_MODEL"] as const;
const FORBIDDEN = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const CANARY_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTP_PROXY", "OPENAI_API_KEY", "CDT_QA_SECRET"] as const;

function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(1);
}

function main(): void {
  for (const name of REQUIRED) {
    if (!process.env[name]) fail(`missing-env:${name}`);
  }
  const runtimeRoot = process.env["CDT_QA_RUNTIME"]!;
  const keyFile = process.env["CDT_QA_KEY_FILE"]!;
  const cwd = process.env["CDT_QA_CWD"]!;
  const model = process.env["CDT_QA_MODEL"]!;
  if (!existsSync(runtimeRoot) || !statSync(runtimeRoot).isDirectory()) fail("runtime-missing");
  if (!existsSync(keyFile)) fail("key-missing");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail("cwd-missing");

  let captured: Options | undefined;
  const factory: QueryFactory = (input) => {
    captured = input.options;
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000001", model } as unknown as SDKMessage;
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        session_id: "00000000-0000-4000-8000-000000000001",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      } as unknown as SDKMessage;
    }
    return {
      [Symbol.asyncIterator]: () => stream(),
      close: () => {},
    };
  };

  const runner = new ClaudeAgentRunner({ runtimeRoot, keyFile, queryFactory: factory });
  const request: RunnerRequest = {
    jobId: "job-acceptance-env-probe",
    runId: "run-acceptance-env-probe",
    cwd,
    sourceCwd: cwd,
    model: model as RunnerRequest["model"],
    profile: "read",
    prompt: "acceptance env probe",
    maxTurns: 1,
    deadlineMs: 30_000,
    allowedPaths: [],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: false,
    branch: null,
    signal: new AbortController().signal,
    requestApproval: async () => false,
  };

  void runner
    .run(request, () => {})
    .then((result) => {
      const env = (captured?.env ?? {}) as Record<string, string>;
      const runtime = runtimeRoot.replace(/\/+$/, "");
      const home = env["HOME"] ?? "";
      const configDir = env["CLAUDE_CONFIG_DIR"] ?? "";
      const forbiddenPresent = Object.fromEntries(FORBIDDEN.map((name) => [name, env[name] !== undefined]));
      const canaryLeakedNames = CANARY_ENV_NAMES.filter((name) => {
        const value = process.env[name];
        return Boolean(value && value.length >= 6 && Object.values(env).includes(value));
      });
      const modelTierKeys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ];
      const checks = {
        modelSucceeded: result.modelSucceeded,
        homeUnderRuntime: Boolean(home && (home === runtime || home.startsWith(`${runtime}/`))),
        configUnderHome: Boolean(home && configDir && configDir.startsWith(`${home}/`)),
        baseUrlExact: env["ANTHROPIC_BASE_URL"] === DEFAULT_BASE_URL,
        modelTiersExact: modelTierKeys.every((key) => env[key] === model),
        tokenPresent: typeof env["ANTHROPIC_AUTH_TOKEN"] === "string" && env["ANTHROPIC_AUTH_TOKEN"]!.length > 0,
        pathInherited: typeof env["PATH"] === "string" && env["PATH"]!.length > 0,
        noForbiddenEnv: Object.values(forbiddenPresent).every((present) => present === false),
        noCanaryLeak: canaryLeakedNames.length === 0,
        noOfficialFallbackKey: env["ANTHROPIC_API_KEY"] === undefined && env["CLAUDE_CODE_OAUTH_TOKEN"] === undefined,
        optionsCwdExact: captured?.cwd === cwd,
        optionsModelExact: captured?.model === model,
        settingSourcesEmpty: Array.isArray(captured?.settingSources) && captured!.settingSources!.length === 0,
        strictMcpConfigEnabled: captured?.strictMcpConfig === true,
      };
      const ok = Object.values(checks).every(Boolean);
      const payload = {
        ok,
        checks,
        forbiddenPresent,
        canaryLeakedNames,
        envKeyNames: Object.keys(env).sort(),
        home,
        configDir,
        baseUrl: env["ANTHROPIC_BASE_URL"] ?? null,
        authTokenPresent: checks.tokenPresent,
        result: {
          modelSucceeded: result.modelSucceeded,
          modelReported: result.modelReported,
          sessionId: result.sessionId,
          error: result.error,
        },
      };
      console.log(JSON.stringify(payload));
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      fail(`run-error:${error instanceof Error ? error.name : "unknown"}`);
    });
}

main();
