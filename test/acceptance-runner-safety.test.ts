/**
 * Independent QA acceptance tests for the P1 ClaudeAgentRunner.
 *
 * These tests use the runner's public fake-SDK seam (`queryFactory`) and QA-owned
 * temporary fixtures. They do not import the author's test helpers, do not read
 * real credentials, and never call a live provider.
 *
 * Focus: real profile tool surface, path/symlink/allowedPaths guard, credential
 * fail-closed + env isolation, exact resume UUID / fork wiring, result failure /
 * abort / steer honesty.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentRunner, type ClaudeAgentRunnerOptions, type QueryFactory } from "../src/engines/agent-runner.js";
import { DEFAULT_BASE_URL } from "../src/engines/environment.js";
import type { RunnerRequest, WorkerEvent } from "../src/task-contracts.js";

type StreamBuilder = (prompt: string | AsyncIterable<SDKUserMessage>, options: Options) => AsyncIterable<SDKMessage>;

interface Capture {
  calls: number;
  options?: Options;
  input?: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options };
}

interface Fixture {
  root: string;
  project: string;
  outside: string;
  runtimeRoot: string;
  keyFile: string;
  token: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(keyMode: "valid" | "missing" | "malformed" | "unknown-assignment" = "valid"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "cdt-qa-"));
  roots.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  const runtimeRoot = join(root, "runtime");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(project, "target.txt"), "base-line\n");
  writeFileSync(join(project, "other.txt"), "other\n");
  writeFileSync(join(outside, "secret.txt"), "outside-secret\n");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), "[core]\n");
  symlinkSync(outside, join(project, "link-out"), "dir");
  symlinkSync(join(outside, "secret.txt"), join(project, "link-file"));
  const token = `QA-DUMMY-${randomUUID()}`;
  const keyFile = join(root, "key.txt");
  if (keyMode === "valid") writeFileSync(keyFile, `${token}\n`, { mode: 0o600 });
  if (keyMode === "malformed") writeFileSync(keyFile, "LINE-ONE\nLINE-TWO\n", { mode: 0o600 });
  if (keyMode === "unknown-assignment") writeFileSync(keyFile, `OPENAI_API_KEY=${token}\n`, { mode: 0o600 });
  return { root, project, outside, runtimeRoot, keyFile, token };
}

function requestFor(fx: Fixture, overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    jobId: `job-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    cwd: fx.project,
    sourceCwd: fx.project,
    model: "glm-5.3",
    profile: "read",
    prompt: "acceptance prompt",
    maxTurns: 4,
    deadlineMs: 30_000,
    allowedPaths: [],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: false,
    branch: null,
    signal: new AbortController().signal,
    requestApproval: async () => false,
    ...overrides,
  };
}

function runnerFor(fx: Fixture, factory: QueryFactory, extra: Partial<ClaudeAgentRunnerOptions> = {}): ClaudeAgentRunner {
  return new ClaudeAgentRunner({ runtimeRoot: fx.runtimeRoot, keyFile: fx.keyFile, queryFactory: factory, ...extra });
}

function captureFactory(builder: StreamBuilder): { factory: QueryFactory; capture: Capture } {
  const capture: Capture = { calls: 0 };
  const factory: QueryFactory = (input) => {
    capture.calls += 1;
    capture.options = input.options;
    capture.input = input;
    const stream = builder(input.prompt, input.options);
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
      close: () => {},
      interrupt: async () => {},
    };
  };
  return { factory, capture };
}

function initMessage(sessionId: string, model = "glm-5.3"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId, model } as unknown as SDKMessage;
}

function assistantText(text: string): SDKMessage {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } } as unknown as SDKMessage;
}

function assistantToolUse(id: string, name: string): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  } as unknown as SDKMessage;
}

function userToolResult(id: string): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  } as unknown as SDKMessage;
}

function successResult(sessionId: string, usage: Record<string, unknown> = { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 5 }): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: sessionId,
    usage,
    total_cost_usd: 0.02,
  } as unknown as SDKMessage;
}

function failureResult(sessionId: string, detail = "boom"): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [detail],
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function successBuilder(sessionId: string, options: { text?: string; tool?: boolean } = {}): StreamBuilder {
  return () =>
    (async function* (): AsyncGenerator<SDKMessage> {
      yield initMessage(sessionId);
      if (options.tool) {
        yield assistantToolUse("tool-1", "Read");
        yield userToolResult("tool-1");
      }
      if (options.text !== "") yield assistantText(options.text ?? "done");
      yield successResult(sessionId);
    })();
}

function pathHook(options: Options): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const pre = (options.hooks as unknown as {
    PreToolUse?: Array<{ hooks?: Array<(input: Record<string, unknown>) => Promise<Record<string, unknown>>> }>;
  } | undefined)?.PreToolUse;
  const hook = pre?.[0]?.hooks?.[0];
  if (typeof hook !== "function") throw new Error("runner did not wire a PreToolUse path hook");
  return hook;
}

async function pathDecision(options: Options, toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  const out = await pathHook(options)({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput });
  const rec = out as { hookSpecificOutput?: { permissionDecision?: string } };
  return rec?.hookSpecificOutput?.permissionDecision ?? "allow";
}

async function approvalDecision(options: Options, toolName: string, input: Record<string, unknown>, signal: AbortSignal) {
  const canUse = options.canUseTool as unknown as (
    name: string,
    input: unknown,
    context: unknown,
  ) => Promise<{ behavior: string; message?: string; updatedInput?: unknown }>;
  if (typeof canUse !== "function") throw new Error("runner did not wire canUseTool");
  return canUse(toolName, input, { signal, suggestions: [], decisionReason: "qa acceptance" });
}

function forbiddenEnvKeys(env: Record<string, string> | undefined): string[] {
  const names = [
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
    "OPENAI_API_KEY",
    "CDT_QA_SECRET",
  ];
  return names.filter((name) => env?.[name] !== undefined);
}

describe("acceptance: profile tool surface actually passed to SDK", () => {
  it("read profile: exact read-only tools, dontAsk, no settings/skills/plugins/MCP leakage", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { maxTurns: 35 }), () => {});

    expect(result.modelSucceeded).toBe(true);
    expect(capture.calls).toBe(1);
    const o = capture.options!;
    expect(o.cwd).toBe(fx.project);
    expect(o.model).toBe("glm-5.3");
    expect(o.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(o.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "NotebookEdit"]));
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.skills).toEqual([]);
    expect(o.plugins).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(true);
    expect(o.maxTurns).toBe(35);
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it("rejects over-limit direct SDK budgets before starting a model", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const result = await runnerFor(fx, factory).run(requestFor(fx, { maxTurns: 999 }), () => {});
    expect(result.modelSucceeded).toBe(false);
    expect(result.error).toContain("invalid_budget:");
    expect(capture.calls).toBe(0);
  });

  it("edit profile: adds Edit/Write/NotebookEdit but no Bash; allowedTools is not a write whitelist", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(
      requestFor(fx, { profile: "edit", allowedPaths: ["."], maxTurns: 3 }),
      () => {},
    );

    expect(result.modelSucceeded).toBe(true);
    const o = capture.options!;
    expect(o.tools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Read"]));
    expect(o.tools).not.toContain("Bash");
    expect(o.disallowedTools).toContain("Bash");
    expect(o.disallowedTools).not.toContain("Edit");
    expect(o.disallowedTools).not.toContain("Write");
    // Edit profile: in-scope Edit/Write/NotebookEdit are pre-approved; the
    // PreToolUse path gate remains the boundary for out-of-scope paths.
    expect(o.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit"]));
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.maxTurns).toBe(3);
    expect((o.hooks as unknown as { PreToolUse?: unknown[] }).PreToolUse?.length).toBeGreaterThan(0);
  });

  it("sandboxed-bash either fails closed or wires an explicit failIfUnavailable sandbox", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      const result = await runner.run(
        requestFor(fx, { profile: "sandboxed-bash", allowedPaths: ["."] }),
        () => {},
      );
      expect(result.modelSucceeded).toBe(true);
      const o = capture.options!;
      expect(o.tools).toContain("Bash");
      const sandbox = o.sandbox as unknown as Record<string, unknown>;
      expect(sandbox["enabled"]).toBe(true);
      expect(sandbox["failIfUnavailable"]).toBe(true);
      expect(sandbox["allowUnsandboxedCommands"]).toBe(false);
      expect(sandbox["autoAllowBashIfSandboxed"]).toBe(false);
      const fs = sandbox["filesystem"] as { allowWrite?: string[] } | undefined;
      expect(fs?.allowWrite).toEqual(expect.arrayContaining([fx.project]));
    } else {
      const result = await runner.run(requestFor(fx, { profile: "sandboxed-bash", allowedPaths: ["."] }), () => {});
      expect(result.error ?? "").toMatch(/^sandbox_unavailable:/);
      expect(result.modelSucceeded).toBe(false);
      expect(capture.calls).toBe(0);
    }
  });

  it("flash model is routed through every model tier, never to a Claude default", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID(), { text: "ok" }));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { model: "glm-5.3-flash" }), () => {});
    expect(result.modelSucceeded).toBe(true);
    const env = capture.options!.env as Record<string, string>;
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(env[key]).toBe("glm-5.3-flash");
    }
  });

  it("unknown model is rejected before query()", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);

    const unknownModel = await runner.run(
      requestFor(fx, { model: "claude-sonnet-4-5" as RunnerRequest["model"] }),
      () => {},
    );
    expect(unknownModel.modelSucceeded).toBe(false);
    expect(unknownModel.error ?? "").toMatch(/^unsupported_capability:/);
    expect(capture.calls).toBe(0);
  });

  it("selected catalog skills are supported; unapproved names are rejected before query()", async () => {
    const fx = fixture();
    const skillDir = join(fx.root, "skills", "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: alpha\ndescription: acceptance fixture\n---\n\nReply ALPHA.\n",
    );
    const catalogDir = join(fx.runtimeRoot, "config");
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(
      join(catalogDir, "resource-catalog.json"),
      JSON.stringify({ skills: { alpha: { dir: skillDir } } }),
    );

    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const allowed = await runner.run(requestFor(fx, { allowedSkillNames: ["alpha"] }), () => {});
    expect(allowed.modelSucceeded).toBe(true);
    expect(capture.calls).toBe(1);
    const o = capture.options!;
    expect(o.skills).toEqual(["alpha"]);
    expect(o.tools).toContain("Skill");
    expect(o.allowedTools).toContain("Skill");
    expect(o.disallowedTools).not.toContain("Skill");
    const plugins = o.plugins as unknown as Array<Record<string, unknown>>;
    expect(plugins[0]?.["type"]).toBe("local");
    expect(plugins[0]?.["skipMcpDiscovery"]).toBe(true);
    expect(await pathDecision(o, "Skill", { skill: "alpha" })).toBe("allow");
    expect(await pathDecision(o, "Skill", { skill: "not-selected" })).toBe("deny");

    const denied = runnerFor(fx, factory);
    const deniedResult = await denied.run(requestFor(fx, { allowedSkillNames: ["not-approved"] }), () => {});
    expect(deniedResult.modelSucceeded).toBe(false);
    expect(deniedResult.error ?? "").toMatch(/^skill_not_preapproved:/);
    expect(capture.calls).toBe(1);
  });
});

describe("acceptance: path and allowedPaths guard", () => {
  it("edit: allowed file passes; sibling, ../, absolute-outside and parent-symlink escapes are denied", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(
      requestFor(fx, { profile: "edit", allowedPaths: ["target.txt"] }),
      () => {},
    );
    expect(result.modelSucceeded).toBe(true);
    const o = capture.options!;

    expect(await pathDecision(o, "Write", { file_path: "target.txt" })).toBe("allow");
    expect(await pathDecision(o, "Edit", { file_path: join(fx.project, "target.txt") })).toBe("allow");
    expect(await pathDecision(o, "Write", { file_path: "other.txt" })).toBe("deny");
    // Write ownership must not prevent ordinary project-context reads.
    expect(await pathDecision(o, "Read", { file_path: "other.txt" })).toBe("allow");
    expect(await pathDecision(o, "Grep", { path: fx.project, pattern: "interface" })).toBe("allow");
    expect(await pathDecision(o, "Read", { file_path: "../outside/secret.txt" })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: "../outside/secret.txt" })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: join(fx.outside, "secret.txt") })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: "link-out/new.txt" })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: "link-file" })).toBe("deny");
    expect(await pathDecision(o, "NotebookEdit", { notebook_path: "link-out/new.ipynb" })).toBe("deny");
  });

  it("edit: sensitive writes (.git/.env) are denied even when inside allowedPaths; Bash denied", async () => {
    const fx = fixture();
    writeFileSync(join(fx.project, ".env"), "SECRET=1\n");
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    await runner.run(requestFor(fx, { profile: "edit", allowedPaths: ["."] }), () => {});
    const o = capture.options!;

    expect(await pathDecision(o, "Write", { file_path: ".git/config" })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: ".env" })).toBe("deny");
    expect(await pathDecision(o, "Write", { file_path: "target.txt" })).toBe("allow");
    expect(await pathDecision(o, "Bash", { command: "echo hi" })).toBe("deny");
  });

  it("read: outside/symlink reads denied, inside read allowed, MCP and Bash tools denied", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    await runner.run(requestFor(fx), () => {});
    const o = capture.options!;

    expect(await pathDecision(o, "Read", { file_path: "target.txt" })).toBe("allow");
    expect(await pathDecision(o, "Read", { file_path: join(fx.project, "target.txt") })).toBe("allow");
    expect(await pathDecision(o, "Read", { file_path: "../outside/secret.txt" })).toBe("deny");
    expect(await pathDecision(o, "Read", { file_path: join(fx.outside, "secret.txt") })).toBe("deny");
    expect(await pathDecision(o, "Read", { file_path: "link-file" })).toBe("deny");
    expect(await pathDecision(o, "Bash", { command: "echo hi" })).toBe("deny");
    expect(await pathDecision(o, "mcp__approved__tool", {})).toBe("deny");
  });
});

describe("acceptance: credentials fail closed and worker env is isolated", () => {
  it("missing credential: credential:missing, zero SDK calls, no fallback model/session", async () => {
    const fx = fixture("missing");
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx), () => {});
    expect(result.modelSucceeded).toBe(false);
    expect(result.error).toBe("credential:missing");
    expect(result.sessionId).toBeNull();
    expect(result.modelReported).toBeNull();
    expect(capture.calls).toBe(0);
  });

  it("malformed / ambiguous credential files: credential:malformed, zero SDK calls", async () => {
    for (const mode of ["malformed", "unknown-assignment"] as const) {
      const fx = fixture(mode);
      const { factory, capture } = captureFactory(successBuilder(randomUUID()));
      const runner = runnerFor(fx, factory);
      const result = await runner.run(requestFor(fx), () => {});
      expect(result.modelSucceeded).toBe(false);
      expect(result.error).toBe("credential:malformed");
      expect(capture.calls).toBe(0);
    }
  });

  it("valid dummy credential: isolated HOME/CLAUDE_CONFIG_DIR, Volcengine base URL, no official fallback keys", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx), () => {});
    expect(result.modelSucceeded).toBe(true);
    const env = capture.options!.env as Record<string, string>;

    expect(env["HOME"]?.startsWith(resolve(fx.runtimeRoot))).toBe(true);
    expect(env["CLAUDE_CONFIG_DIR"]?.startsWith(`${env["HOME"]}/`)).toBe(true);
    expect(env["ANTHROPIC_BASE_URL"]).toBe(DEFAULT_BASE_URL);
    expect(env["ANTHROPIC_AUTH_TOKEN"] === fx.token).toBe(true);
    expect(env["PATH"]?.length).toBeGreaterThan(0);
    expect(forbiddenEnvKeys(env)).toEqual([]);
    expect(env["ANTHROPIC_MODEL"]).toBe("glm-5.3");
  });

  it("hostile parent env (API key/OAuth/proxy) is not inherited by a child-process runner", () => {
    const fx = fixture();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const canary = {
      api: `QA-CANARY-API-${randomUUID()}`,
      oauth: `QA-CANARY-OAUTH-${randomUUID()}`,
      proxy: `http://QA-CANARY-PROXY-${randomUUID()}.invalid:9`,
      unrelated: `QA-CANARY-UNRELATED-${randomUUID()}`,
    };
    const probe = join(repoRoot, "src", "scripts", "acceptance-env-probe.ts");
    expect(existsSync(probe)).toBe(true);
    const res = spawnSync(process.execPath, ["--import", "tsx", probe], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        CDT_QA_RUNTIME: fx.runtimeRoot,
        CDT_QA_KEY_FILE: fx.keyFile,
        CDT_QA_CWD: fx.project,
        CDT_QA_MODEL: "glm-5.3",
        ANTHROPIC_API_KEY: canary.api,
        CLAUDE_CODE_OAUTH_TOKEN: canary.oauth,
        HTTP_PROXY: canary.proxy,
        OPENAI_API_KEY: canary.unrelated,
        CDT_QA_SECRET: canary.unrelated,
      },
    });
    const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    for (const value of Object.values(canary)) {
      expect(combined.includes(value)).toBe(false);
    }
    expect(res.status).toBe(0);
    const lines = (res.stdout ?? "").trim().split("\n");
    const payload = JSON.parse(lines[lines.length - 1]!) as {
      ok: boolean;
      forbiddenPresent: Record<string, boolean>;
      canaryLeakedNames: string[];
      envKeyNames: string[];
    };
    expect(payload.ok).toBe(true);
    expect(Object.values(payload.forbiddenPresent).every((present) => present === false)).toBe(true);
    expect(payload.canaryLeakedNames).toEqual([]);
    expect(payload.envKeyNames).not.toContain("ANTHROPIC_API_KEY");
    expect(payload.envKeyNames).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("acceptance: run result, abort, steer honesty, resume/fork wiring", () => {
  it("success result maps usage honestly (provider billed stays null) and emits tool events", async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    const { factory, capture } = captureFactory(successBuilder(sessionId, { tool: true }));
    const runner = runnerFor(fx, factory);
    const events: WorkerEvent[] = [];
    const result = await runner.run(requestFor(fx), (event) => events.push(event));

    expect(result.modelSucceeded).toBe(true);
    expect(result.sessionId).toBe(sessionId);
    expect(result.modelReported).toBe("glm-5.3");
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(3);
    expect(result.usage.cacheReadTokens).toBe(5);
    expect(result.usage.sdkCostEstimateUsd).toBe(0.02);
    expect(result.usage.providerBilledCostUsd).toBeNull();
    expect(events.some((event) => event.type === "tool_start" && event.toolName === "Read")).toBe(true);
    expect(events.some((event) => event.type === "tool_end" && event.toolName === "Read")).toBe(true);
    expect(capture.calls).toBe(1);
  });

  it("failed SDK result: modelSucceeded=false, real error, session kept, usage null (not zero)", async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    const { factory } = captureFactory(() =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield initMessage(sessionId);
        yield failureResult(sessionId, "boom");
      })(),
    );
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx), () => {});
    expect(result.modelSucceeded).toBe(false);
    expect(result.error ?? "").toMatch(/^result:/);
    expect(result.error ?? "").toContain("boom");
    expect(result.sessionId).toBe(sessionId);
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
    expect(result.usage.cacheReadTokens).toBeNull();
    expect(result.usage.sdkCostEstimateUsd).toBeNull();
    expect(result.usage.providerBilledCostUsd).toBeNull();
  });

  it("abort: signal aborts the SDK controller, run ends aborted, session preserved", async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    let captured: Options | undefined;
    const factory: QueryFactory = (input) => {
      captured = input.options;
      async function* stream(): AsyncGenerator<SDKMessage> {
        yield initMessage(sessionId);
        const signal = input.options.abortController!.signal;
        await new Promise<void>((resolveWait) => {
          if (signal.aborted) resolveWait();
          else signal.addEventListener("abort", () => resolveWait(), { once: true });
        });
        throw new Error("aborted by test");
      }
      return { [Symbol.asyncIterator]: () => stream(), close: () => {}, interrupt: async () => {} };
    };
    const runner = runnerFor(fx, factory);
    const controller = new AbortController();
    const req = requestFor(fx, { signal: controller.signal });
    let sawInit!: () => void;
    const initSeen = new Promise<void>((resolveInit) => {
      sawInit = resolveInit;
    });
    const runPromise = runner.run(req, (event) => {
      if (event.type === "init") sawInit();
    });
    await initSeen;
    controller.abort();
    const result = await runPromise;
    expect(result.modelSucceeded).toBe(false);
    expect(result.error).toBe("aborted");
    expect(result.sessionId).toBe(sessionId);
    expect(captured?.abortController?.signal.aborted).toBe(true);
  });

  it("steer: queued is not delivered; delivered only after SDK echo; late steer unsupported", async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    let steerMessageId = "";
    let steerSeen: SDKUserMessage | undefined;
    let originalResolve!: () => void;
    const originalSeen = new Promise<void>((resolveOriginal) => {
      originalResolve = resolveOriginal;
    });
    const received: SDKUserMessage[] = [];

    const factory: QueryFactory = (input) => {
      async function* stream(): AsyncGenerator<SDKMessage> {
        yield initMessage(sessionId);
        const prompt = input.prompt as AsyncIterable<SDKUserMessage>;
        for await (const message of prompt) {
          received.push(message);
          if (received.length === 1) {
            originalResolve();
            continue;
          }
          steerSeen = message;
          steerMessageId = String(message.uuid ?? "");
          yield {
            type: "assistant",
            message: { role: "assistant", content: [] },
            user_message_uuid: message.uuid,
          } as unknown as SDKMessage;
          yield successResult(sessionId);
          return;
        }
      }
      return { [Symbol.asyncIterator]: () => stream(), close: () => {}, interrupt: async () => {} };
    };

    const runner = runnerFor(fx, factory);
    const events: WorkerEvent[] = [];
    const req = requestFor(fx);
    const runPromise = runner.run(req, (event) => events.push(event));

    await originalSeen;
    const receipt = await runner.steer(req.runId, "please adjust", "next");
    expect(receipt.disposition).toBe("queued");
    expect(receipt.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events.some((event) => event.type === "steer_ack")).toBe(false);

    const result = await runPromise;
    expect(result.modelSucceeded).toBe(true);
    expect(steerSeen?.message.content === "please adjust").toBe(true);
    expect(steerSeen?.priority).toBe("next");
    const acks = events.filter((event) => event.type === "steer_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.messageId).toBe(receipt.messageId);
    expect(steerMessageId).toBe(receipt.messageId);

    const late = await runner.steer(req.runId, "too late", "later");
    expect(late.disposition).toBe("unsupported");
    expect(late.messageId).toBe("");
  });

  it("steer is never upgraded to delivered when the SDK ignores the message", async () => {
    const fx = fixture();
    const sessionId = randomUUID();
    let originalResolve!: () => void;
    const originalSeen = new Promise<void>((resolveOriginal) => {
      originalResolve = resolveOriginal;
    });
    let consumeSteerResolve!: () => void;
    const consumeSteer = new Promise<void>((resolveSteer) => {
      consumeSteerResolve = resolveSteer;
    });

    const factory: QueryFactory = (input) => {
      async function* stream(): AsyncGenerator<SDKMessage> {
        yield initMessage(sessionId);
        const prompt = input.prompt as AsyncIterable<SDKUserMessage>;
        let count = 0;
        for await (const _message of prompt) {
          count += 1;
          if (count === 1) {
            originalResolve();
            continue;
          }
          consumeSteerResolve();
          yield successResult(sessionId);
          return;
        }
      }
      return { [Symbol.asyncIterator]: () => stream(), close: () => {}, interrupt: async () => {} };
    };

    const runner = runnerFor(fx, factory);
    const events: WorkerEvent[] = [];
    const req = requestFor(fx);
    const runPromise = runner.run(req, (event) => events.push(event));
    await originalSeen;
    const receipt = await runner.steer(req.runId, "ignored steer");
    expect(receipt.disposition).toBe("queued");
    await consumeSteer;
    const result = await runPromise;
    expect(result.modelSucceeded).toBe(true);
    expect(events.filter((event) => event.type === "steer_ack")).toHaveLength(0);
  });

  it("fresh run: options.resume is undefined and no directory-based continue option", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    await runner.run(requestFor(fx), () => {});
    const o = capture.options!;
    expect(o.resume).toBeUndefined();
    expect(o.forkSession).toBeUndefined();
    expect("continue" in (o as unknown as Record<string, unknown>)).toBe(false);
  });

  it("resume: exact UUID reaches SDK options and result keeps the same session", async () => {
    const fx = fixture();
    const parent = randomUUID();
    const { factory, capture } = captureFactory(successBuilder(parent));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { resumeSessionId: parent }), () => {});
    const o = capture.options!;
    expect(o.resume).toBe(parent);
    expect(o.forkSession).toBeUndefined();
    expect("continue" in (o as unknown as Record<string, unknown>)).toBe(false);
    expect(result.sessionId).toBe(parent);
    expect(result.modelSucceeded).toBe(true);
  });

  it("fork: parent UUID plus forkSession=true reaches SDK, result gets a new UUID", async () => {
    const fx = fixture();
    const parent = randomUUID();
    const forked = randomUUID();
    const { factory, capture } = captureFactory(successBuilder(forked));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { resumeSessionId: parent, forkSession: true }), () => {});
    const o = capture.options!;
    expect(o.resume).toBe(parent);
    expect(o.forkSession).toBe(true);
    expect(result.sessionId).toBe(forked);
    expect(result.sessionId).not.toBe(parent);
  });

  it("invalid resume id is rejected before query(); no silent continue/cwd fallback", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { resumeSessionId: "not-a-uuid" }), () => {});
    expect(result.modelSucceeded).toBe(false);
    expect(result.error ?? "").toMatch(/^unsupported_capability:/);
    expect(capture.calls).toBe(0);
  });

  it("approval callback denies by default, allows only explicit true, denies aborted/timeout", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));

    const denied = runnerFor(fx, factory);
    await denied.run(requestFor(fx, { requestApproval: async () => false }), () => {});
    const deniedOptions = capture.options!;
    const deniedResult = await approvalDecision(deniedOptions, "Write", { file_path: "target.txt" }, new AbortController().signal);
    expect(deniedResult.behavior).toBe("deny");
    expect(deniedResult.message ?? "").toMatch(/denied by unattended approval policy/);

    const allowedCapture = captureFactory(successBuilder(randomUUID()));
    const allowed = runnerFor(fx, allowedCapture.factory);
    await allowed.run(requestFor(fx, { requestApproval: async () => true }), () => {});
    const allowedResult = await approvalDecision(allowedCapture.capture.options!, "Write", { file_path: "target.txt" }, new AbortController().signal);
    expect(allowedResult.behavior).toBe("allow");
    expect(allowedResult.updatedInput).toEqual({ file_path: "target.txt" });

    const aborted = runnerFor(fx, factory);
    await aborted.run(requestFor(fx), () => {});
    const abortedController = new AbortController();
    abortedController.abort();
    const abortedResult = await approvalDecision(capture.options!, "Write", { file_path: "target.txt" }, abortedController.signal);
    expect(abortedResult.behavior).toBe("deny");

    const timeoutCapture = captureFactory(successBuilder(randomUUID()));
    const timeoutRunner = runnerFor(fx, timeoutCapture.factory, { approvalTimeoutMs: 25 });
    await timeoutRunner.run(requestFor(fx, { requestApproval: () => new Promise<boolean>(() => {}) }), () => {});
    const started = Date.now();
    const timeoutResult = await approvalDecision(timeoutCapture.capture.options!, "Write", { file_path: "target.txt" }, new AbortController().signal);
    expect(timeoutResult.behavior).toBe("deny");
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});

describe("acceptance: MCP catalog is an allowlist, not inheritance", () => {
  it("requested server must be in the pre-approved catalog; unlisted request fails before query()", async () => {
    const fx = fixture();
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { enabledMcpServers: ["not-approved"] }), () => {});
    expect(result.modelSucceeded).toBe(false);
    expect(result.error ?? "").toMatch(/^mcp_server_not_preapproved:/);
    expect(capture.calls).toBe(0);
  });

  it("approved catalog entry reaches SDK options; MCP tool call is still hook-denied (defense in depth)", async () => {
    const fx = fixture();
    mkdirSync(join(fx.runtimeRoot, "config"), { recursive: true });
    writeFileSync(
      join(fx.runtimeRoot, "config", "mcp-catalog.json"),
      JSON.stringify({ servers: { approved: { command: "/bin/echo", args: ["ok"] } } }),
    );
    const { factory, capture } = captureFactory(successBuilder(randomUUID()));
    const runner = runnerFor(fx, factory);
    const result = await runner.run(requestFor(fx, { enabledMcpServers: ["approved"] }), () => {});
    expect(result.modelSucceeded).toBe(true);
    const servers = capture.options!.mcpServers as Record<string, { type?: string; command?: string }>;
    expect(servers["approved"]?.type).toBe("stdio");
    expect(servers["approved"]?.command).toBe("/bin/echo");
    expect(await pathDecision(capture.options!, "mcp__approved__echo", {})).toBe("deny");
  });
});
