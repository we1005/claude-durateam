import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Options, SDKMessage, SDKUserMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentRunner, type QueryFactory, type QueryHandle } from "../src/engines/agent-runner.js";
import { resolveRuntimeRoot } from "../src/engines/environment.js";
import { escapeProjectDir } from "../src/engines/session-store.js";
import type { RunnerRequest, WorkerEvent } from "../src/task-contracts.js";

const runtimeRoot = resolveRuntimeRoot();
const cwd = join(runtimeRoot, "test-tmp", `runner-${randomUUID()}`);
mkdirSync(cwd, { recursive: true });
const configRoot = join(runtimeRoot, "test-tmp", `claude-config-${randomUUID()}`);
mkdirSync(configRoot, { recursive: true });
const keyFile = join(cwd, "key.txt");
writeFileSync(keyFile, `ARK-${randomUUID().replace(/-/g, "")}\n`, { mode: 0o600 });
const SESSION = randomUUID();

class FakeStream {
  private queue: SDKMessage[] = [];
  private ended = false;
  private wake?: () => void;
  push(message: SDKMessage): void {
    this.queue.push(message);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
  end(): void {
    this.ended = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
  async *iterate(): AsyncIterableIterator<SDKMessage> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function harness(): {
  factory: QueryFactory;
 junctions: FakeStream;
  options: () => Options;
} {
  const stream = new FakeStream();
  let captured: Options | undefined;
  const factory: QueryFactory = (input) => {
    captured = input.options;
    const handle: QueryHandle = {
      [Symbol.asyncIterator]: () => stream.iterate(),
      close: () => stream.end(),
    };
    return handle;
  };
  return {
    factory,
    junctions: stream,
    options: () => {
      if (!captured) throw new Error("query options not captured");
      return captured;
    },
  };
}

const INIT = {
  type: "system",
  subtype: "init",
  model: "glm-5.3",
  session_id: SESSION,
  permissionMode: "dontAsk",
  apiKeySource: "none",
  tools: ["Read", "Glob", "Grep"],
  mcp_servers: [],
  skills: [],
  cwd: "",
} as unknown as SDKMessage;

function assistant(toolUseId: string, text: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION,
    message: {
      model: "glm-5.3",
      content: [
        { type: "text", text },
        { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "target.txt" } },
      ],
    },
  } as unknown as SDKMessage;
}

function toolResult(toolUseId: string): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "nonce" }],
    },
  } as unknown as SDKMessage;
}

function result(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    duration_ms: 1200,
    result: text,
    session_id: SESSION,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    modelUsage: { "glm-5.3": {} },
    errors: [],
  } as unknown as SDKMessage;
}

function makeRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    jobId: `job-${randomUUID().slice(0, 8)}`,
    runId: `run-${randomUUID().slice(0, 8)}`,
    cwd,
    sourceCwd: cwd,
    model: "glm-5.3",
    profile: "read",
    prompt: "read target.txt",
    maxTurns: 3,
    deadlineMs: 5_000,
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

function makeRunner(h: ReturnType<typeof harness>): ClaudeAgentRunner {
  return new ClaudeAgentRunner({
    runtimeRoot,
    configRoot,
    keyFile,
    queryFactory: h.factory,
    approvalTimeoutMs: 500,
    mcpCatalogPath: join(runtimeRoot, "test-tmp", "no-catalog.json"),
  });
}

function seedTranscript(sessionId: string, cwdPath: string): void {
  const dir = join(configRoot, "projects", escapeProjectDir(cwdPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `{"sessionId":"${sessionId}"}\n`, { mode: 0o600 });
}

describe("ClaudeAgentRunner", () => {
  it("coding supplies pre-approved Bash without an OS sandbox or bypassPermissions", async () => {
    const h = harness(); const runner = makeRunner(h);
    const run = runner.run(makeRequest({profile:"coding", allowedPaths:["target.txt"]}), () => {});
    h.junctions.push(INIT);
    await new Promise<void>(resolve => setImmediate(resolve)); // credential proxy listens before query creation
    const options=h.options();
    expect(options.tools).toContain("Bash");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowedTools).toContain("Bash");
    expect(options.sandbox).toMatchObject({enabled:false});
    const verdict=await options.canUseTool!("Bash",{command:"node --test",dangerouslyDisableSandbox:true},{signal:new AbortController().signal,toolUseID:"escape"} as any);
    expect(verdict.behavior).toBe("deny");
    h.junctions.push(result("done"));await run;
  });

  it("runs a read task and maps init/usage/events", async () => {
    const h = harness();
    const events: WorkerEvent[] = [];
    const runner = makeRunner(h);
    const request = makeRequest({ maxTurns: 35 });
    const runPromise = runner.run(request, (event) => events.push(event));
    h.junctions.push(INIT);
    h.junctions.push(assistant("tu-1", "reading"));
    h.junctions.push(toolResult("tu-1"));
    h.junctions.push(result("done"));
    const outcome = await runPromise;
    expect(outcome.modelSucceeded).toBe(true);
    expect(outcome.sessionId).toBe(SESSION);
    expect(outcome.modelReported).toBe("glm-5.3");
    expect(outcome.usage.inputTokens).toBe(100);
    expect(outcome.usage.outputTokens).toBe(20);
    expect(outcome.usage.sdkCostEstimateUsd).toBe(0.01);
    expect(outcome.usage.providerBilledCostUsd).toBeNull();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["init", "text", "tool_start", "tool_end"]),
    );
    const options = h.options();
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.effort).toBe("high");
    expect(options.maxTurns).toBe(35);
  });

  it("passes the exact resume UUID and forks only when forkSession is true", async () => {
    seedTranscript(SESSION, cwd);
    const resumeHarness = harness();
    const resumeRunner = makeRunner(resumeHarness);
    const resumeRun = resumeRunner.run(makeRequest({ resumeSessionId: SESSION }), () => {});
    resumeHarness.junctions.push(INIT);
    resumeHarness.junctions.push(result("resumed"));
    await resumeRun;
    const resumeOptions = resumeHarness.options();
    expect(resumeOptions.resume).toBe(SESSION);
    expect(resumeOptions.forkSession).toBeUndefined();
    expect(resumeOptions.continue).toBeUndefined();

    const forkHarness = harness();
    const forkRunner = makeRunner(forkHarness);
    const forkRun = forkRunner.run(makeRequest({ resumeSessionId: SESSION, forkSession: true }), () => {});
    forkHarness.junctions.push(INIT);
    forkHarness.junctions.push(result("forked"));
    await forkRun;
    const forkOptions = forkHarness.options();
    expect(forkOptions.resume).toBe(SESSION);
    expect(forkOptions.forkSession).toBe(true);
    expect(forkOptions.continue).toBeUndefined();
  });

  it("coalesces thinking heartbeats without losing tools, other notices, or the result", async () => {
    const h = harness();
    const events: WorkerEvent[] = [];
    const run = makeRunner(h).run(makeRequest(), (event) => events.push(event));
    h.junctions.push(INIT);
    for (let i = 0; i < 1_000; i += 1) {
      h.junctions.push({ type: "system", subtype: "thinking_tokens", text: "private reasoning" } as unknown as SDKMessage);
    }
    h.junctions.push(assistant("bounded-tool", "working"));
    h.junctions.push(toolResult("bounded-tool"));
    h.junctions.push({ type: "system", subtype: "status" } as unknown as SDKMessage);
    h.junctions.push(result("completed"));
    const outcome = await run;
    expect(outcome.modelSucceeded).toBe(true);
    expect(outcome.text).toBe("completed");
    expect(events.filter((event) => event.type === "notice" && event.text === "system:thinking_tokens")).toHaveLength(1);
    expect(events).toContainEqual({ type: "notice", text: "system:status" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_start", toolName: "Read" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", toolName: "Read" }));
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("refuses edit profiles with empty allowedPaths before calling the model", async () => {
    const h = harness();
    const runner = makeRunner(h);
    const outcome = await runner.run(makeRequest({ profile: "edit", allowedPaths: [] }), () => {});
    expect(outcome.modelSucceeded).toBe(false);
    expect(outcome.error).toMatch(/unsupported_capability:edit profile requires non-empty allowedPaths/);
  });


  it("queues steer and only acks it after a real SDK echo", async () => {
    const h = harness();
    const events: WorkerEvent[] = [];
    const runner = makeRunner(h);
    const request = makeRequest();
    const runPromise = runner.run(request, (event) => events.push(event));
    await Promise.resolve();
    const receipt = await runner.steer(request.runId, "focus on target.txt", "next");
    expect(receipt.disposition).toBe("queued");
    expect(receipt.messageId).toMatch(/^[0-9a-f-]{36}$/);
    h.junctions.push({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: SESSION,
      user_message_uuid: receipt.messageId,
      message: { model: "glm-5.3", content: [{ type: "text", text: "steered" }] },
    } as unknown as SDKMessage);
    h.junctions.push(result("steered done"));
    const outcome = await runPromise;
    expect(outcome.modelSucceeded).toBe(true);
    expect(events).toContainEqual({ type: "steer_ack", messageId: receipt.messageId });
    expect(await runner.steer(request.runId, "late", "next")).toEqual({
      messageId: "",
      disposition: "unsupported",
    });
  });

  it("edit profile auto-approves in-scope writes; Bash keeps real approval", async () => {
    // Edit + dontAsk: in-scope writes are pre-approved, no per-write approval.
    const editHarness = harness();
    const editRunner = makeRunner(editHarness);
    const editRun = editRunner.run(makeRequest({ profile: "edit", allowedPaths: ["target.txt"] }), () => {});
    editHarness.junctions.push(INIT);
    const editOptions = editHarness.options();
    expect(editOptions.permissionMode).toBe("dontAsk");
    expect(editOptions.allowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
    editHarness.junctions.push(result("edited"));
    await editRun;

    // Bash still goes through a real canUseTool approval and default-denies.
    const bashHarness = harness();
    const bashRunner = makeRunner(bashHarness);
    const bashRun = bashRunner.run(
      makeRequest({ profile: "sandboxed-bash", allowedPaths: ["."], requestApproval: async () => false }),
      () => {},
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        bashHarness.options();
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    }
    bashHarness.junctions.push(INIT);
    const bashOptions = bashHarness.options();
    expect(bashOptions.permissionMode).toBe("default");
    expect(bashOptions.allowedTools).not.toContain("Bash");
    const denyResult: PermissionResult = await bashOptions.canUseTool!(
      "Bash",
      { command: "echo hi" },
      { signal: new AbortController().signal },
    );
    expect(denyResult.behavior).toBe("deny");
    bashHarness.junctions.push(result("bash denied"));
    await bashRun;
  });

  it("denies path escapes via the PreToolUse guard", async () => {
    const h = harness();
    const runner = makeRunner(h);
    const runPromise = runner.run(makeRequest({ profile: "edit", allowedPaths: ["target.txt"] }), () => {});
    h.junctions.push(INIT);
    const hook = h.options().hooks!.PreToolUse![0]!.hooks[0]!;
    const verdict = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "../../outside.txt" },
        tool_use_id: "tu-x",
        session_id: SESSION,
        transcript_path: "/dev/null",
        cwd,
      } as never,
      "tu-x",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(verdict.hookSpecificOutput?.permissionDecision).toBe("deny");
    // Bash goes through the approval callback/OS sandbox, not the file-path hook.
    const bashVerdict = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_use_id: "tu-bash",
        session_id: SESSION,
        transcript_path: "/dev/null",
        cwd,
      } as never,
      "tu-bash",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    // In the edit profile Bash is denied by profile policy, not by a path check.
    expect(bashVerdict.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(bashVerdict.hookSpecificOutput?.permissionDecisionReason).toMatch(/not available in this profile/);
    expect(bashVerdict.hookSpecificOutput?.permissionDecisionReason).not.toMatch(/allowedPaths/);
    h.junctions.push(result("done"));
    await runPromise;
  });

  it("sandboxed-bash gets a proxy dummy token, never the real credential", async () => {
    const h = harness();
    const runner = makeRunner(h);
    const runPromise = runner.run(makeRequest({ profile: "sandboxed-bash", allowedPaths: ["."] }), () => {});
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        h.options();
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
    }
    h.junctions.push(INIT);
    const env = h.options().env as Record<string, string>;
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toMatch(/^cdt-proxy-/);
    expect(env["ANTHROPIC_AUTH_TOKEN"]).not.toBe(readFileSync(keyFile, "utf8").trim());
    expect(env["ANTHROPIC_BASE_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    h.junctions.push(result("proxied"));
    await runPromise;
  });

  it("fails closed when sandbox availability is forced unavailable", async () => {
    const h = harness();
    const runner = new ClaudeAgentRunner({
      runtimeRoot,
      configRoot,
      keyFile,
      queryFactory: h.factory,
      sandboxAvailableOverride: false,
    });
    const outcome = await runner.run(makeRequest({ profile: "sandboxed-bash", allowedPaths: ["."] }), () => {});
    expect(outcome.modelSucceeded).toBe(false);
    expect(outcome.error).toMatch(/sandbox_unavailable/);
    expect(outcome.sessionId).toBeNull();
  });

  it("allows only selected MCP prefixes and catalog-authorized tools", async () => {
    const catalogDir = join(runtimeRoot, "test-tmp", `catalog-${randomUUID()}`);
    mkdirSync(catalogDir, { recursive: true });
    const catalogPath = join(catalogDir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ servers: { alpha: { command: "/usr/bin/true", tools: ["echo"] } } }));

    const h = harness();
    const runner = new ClaudeAgentRunner({
      runtimeRoot,
      configRoot,
      keyFile,
      queryFactory: h.factory,
      mcpCatalogPath: catalogPath,
    });
    const runPromise = runner.run(makeRequest({ enabledMcpServers: ["alpha"] }), () => {});
    h.junctions.push(INIT);
    const options = h.options();
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["alpha"]);
    expect(options.allowedTools).toContain("mcp__alpha__echo");

    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const selected = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__alpha__echo",
        tool_input: {},
        tool_use_id: "mcp-1",
        session_id: SESSION,
        transcript_path: "/dev/null",
        cwd,
      } as never,
      "mcp-1",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(selected.hookSpecificOutput?.permissionDecision).toBeUndefined();

    const unselected = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__beta__echo",
        tool_input: {},
        tool_use_id: "mcp-2",
        session_id: SESSION,
        transcript_path: "/dev/null",
        cwd,
      } as never,
      "mcp-2",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(unselected.hookSpecificOutput?.permissionDecision).toBe("deny");

    const deniedApproval = await options.canUseTool!(
      "mcp__alpha__other",
      {},
      { signal: new AbortController().signal },
    );
    expect(deniedApproval.behavior).toBe("deny");

    h.junctions.push(result("done"));
    await runPromise;
  });

  it("keeps Skill off by default and gates selected skills by exact name", async () => {
    // Default: no selected skills -> no Skill tool and Skill remains disallowed.
    const defaultHarness = harness();
    const defaultRunner = makeRunner(defaultHarness);
    const defaultRun = defaultRunner.run(makeRequest(), () => {});
    defaultHarness.junctions.push(INIT);
    const defaultOptions = defaultHarness.options();
    expect(defaultOptions.tools).not.toContain("Skill");
    expect(defaultOptions.disallowedTools).toContain("Skill");
    expect(defaultOptions.plugins).toEqual([]);
    defaultHarness.junctions.push(result("done"));
    await defaultRun;

    const skillDir = join(runtimeRoot, "test-tmp", `skill-${randomUUID()}`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: fixture\n---\nReport ALPHA.\n");
    const catalogPath = join(runtimeRoot, "test-tmp", `resource-${randomUUID()}.json`);
    writeFileSync(catalogPath, JSON.stringify({ skills: { alpha: { dir: skillDir } } }));

    const h = harness();
    const runner = new ClaudeAgentRunner({
      runtimeRoot,
      configRoot,
      keyFile,
      queryFactory: h.factory,
      resourceCatalogPath: catalogPath,
    });
    const runPromise = runner.run(makeRequest({ allowedSkillNames: ["alpha"] }), () => {});
    h.junctions.push(INIT);
    const options = h.options();
    expect(options.tools).toContain("Skill");
    expect(options.allowedTools).toContain("Skill");
    expect(options.disallowedTools).not.toContain("Skill");
    expect(options.skills).toEqual(["alpha"]);
    expect(options.plugins?.[0]).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(options.plugins?.[0]?.path).toContain("/plugin");

    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const allow = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "alpha" },
        tool_use_id: "sk-1",
        session_id: SESSION,
        transcript_path: "/dev/null",
        cwd,
      } as never,
      "sk-1",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(allow.hookSpecificOutput?.permissionDecision).toBeUndefined();
    for (const name of ["beta", "deep-research"]) {
      const deny = (await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Skill",
          tool_input: { skill: name },
          tool_use_id: `sk-${name}`,
          session_id: SESSION,
          transcript_path: "/dev/null",
          cwd,
        } as never,
        `sk-${name}`,
        { signal: new AbortController().signal },
      )) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(deny.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
    h.junctions.push(result("skilled"));
    await runPromise;
  });

  it("rejects unapproved skill names before querying", async () => {
    const catalogPath = join(runtimeRoot, "test-tmp", `resource-empty-${randomUUID()}.json`);
    writeFileSync(catalogPath, JSON.stringify({ skills: {} }));
    const h = harness();
    const runner = new ClaudeAgentRunner({
      runtimeRoot,
      configRoot,
      keyFile,
      queryFactory: h.factory,
      resourceCatalogPath: catalogPath,
    });
    const outcome = await runner.run(makeRequest({ allowedSkillNames: ["not-approved"] }), () => {});
    expect(outcome.modelSucceeded).toBe(false);
    expect(outcome.error).toMatch(/skill_not_preapproved:not-approved/);
    expect(outcome.sessionId).toBeNull();
  });

  it("refuses non-catalog MCP servers", async () => {
    const runner = new ClaudeAgentRunner({
      runtimeRoot,
      configRoot,
      keyFile,
      queryFactory: harness().factory,
      mcpCatalogPath: join(runtimeRoot, "test-tmp", "absent-catalog.json"),
    });
    const outcome = await runner.run(makeRequest({ enabledMcpServers: ["unknown-server"] }), () => {});
    expect(outcome.error).toMatch(/mcp_server_not_preapproved/);
  });

  it("returns aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = makeRunner(harness());
    const outcome = await runner.run(makeRequest({ signal: controller.signal }), () => {});
    expect(outcome.error).toBe("aborted");
  });
});
