/**
 * ClaudeCode AgentRunner (P1): real SDK streaming-input runs with
 *  - isolated per-job HOME / CLAUDE_CONFIG_DIR (stable across resume),
 *  - exact-UUID resume and fork,
 *  - abort via AbortSignal, deadline enforcement,
 *  - PreToolUse path/symlink guard + real canUseTool approval callbacks,
 *  - read / edit / host coding / opt-in sandboxed-bash profiles,
 *  - pre-approved MCP catalog only, no global settings loaded,
 *  - steer() that reports `queued` and only emits `delivered` on a real SDK echo.
 *
 * Error contract (RunnerResult.error prefixes):
 *  credential:<code> | sandbox_unavailable | unsupported_capability:<detail>
 *  mcp_server_not_preapproved:<name> | aborted | timed_out | no_result | result:<subtype>
 */

import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRunner,
  ApprovalRequest,
  Priority,
  RunnerRequest,
  RunnerResult,
  SteerReceipt,
  Usage,
  WorkerEvent,
} from "../task-contracts.js";
import type { WorkerProfile } from "../contracts.js";
import {
  DEFAULT_BASE_URL,
  CredentialError,
  assertAllowedModel,
  buildWorkerEnv,
  loadApiKeyFromFile,
  prepareWorkerHome,
  resolveKeyFile,
  resolveRuntimeRoot,
} from "./environment.js";
import { loadPreapprovedMcpServers } from "./mcp-catalog.js";
import { ensureSessionTranscript, linkSharedProjectStore, SessionTranscriptError } from "./session-store.js";
import { startAuthProxy, type AuthProxyHandle } from "./auth-proxy.js";
import { buildSkillBundle, loadPreapprovedSkills, resolveResourceCatalogPath } from "./resource-catalog.js";
import { preview, redactSecrets } from "../observability/redact.js";
import { MAX_TASK_TURNS, MAX_TASK_DURATION_MS } from "../task-limits.js";

export interface QueryHandle {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
  interrupt?: () => Promise<unknown>;
  close: () => void;
}

export type QueryFactory = (input: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

export interface ClaudeAgentRunnerOptions {
  runtimeRoot?: string;
  /** Bridge-owned shared transcript config root (default `<runtime>/claude-config`). */
  configRoot?: string;
  keyFile?: string;
  baseUrl?: string;
  /** Test seam: replace the real SDK query() with a fake stream. */
  queryFactory?: QueryFactory;
  approvalTimeoutMs?: number;
  /** Absolute path to the pre-approved MCP catalog JSON. */
  mcpCatalogPath?: string;
  /** Absolute path to the operator-owned resource (skill) catalog JSON. */
  resourceCatalogPath?: string;
  /** Test-only seam: force `sandbox_unavailable` to prove fail-closed. */
  sandboxAvailableOverride?: boolean;
  /** Operator-only opt-in metadata observation; excludes all request content. */
  wireAuditPath?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const EDIT_TOOLS = [...READ_TOOLS, "Edit", "Write", "NotebookEdit"] as const;
const BASH_TOOLS = [...EDIT_TOOLS, "Bash"] as const;

/** Native subagents and everything outside the declared profiles stay off. */
const ALWAYS_DISALLOWED = [
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "Skill",
  "SlashCommand",
  "KillShell",
  "BashOutput",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "SendMessage",
  "ReportFindings",
  "ToolSearch",
  "ListAgents",
  "TaskStop",
];

const FILE_WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;
const FILE_WRITE_TOOL_SET = new Set<string>(FILE_WRITE_TOOLS);
const SENSITIVE_PATH_SEGMENTS = [".git", ".ssh", ".aws", ".gnupg"];
const SENSITIVE_BASENAMES = [".env", ".env.local", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "credentials.json"];

class StreamingQueue {
  private items: SDKUserMessage[] = [];
  private ended = false;
  private closed = false;
  private wake?: () => void;

  push(message: SDKUserMessage): boolean {
    if (this.ended || this.closed) return false;
    this.items.push(message);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
    return true;
  }

  end(): void {
    this.ended = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  close(): void {
    this.closed = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolveWake) => {
        this.wake = resolveWake;
      });
    }
  }
}

interface ActiveRun {
  runId: string;
  jobId: string;
  queue: StreamingQueue;
  controller: AbortController;
  finishing: boolean;
  emit: (event: WorkerEvent) => void;
  pendingSteers: Map<string, { messageId: string }>;
}

interface Preflight {
  profile: WorkerProfile;
  tools: readonly string[];
  allowedTools: readonly string[];
  disallowedTools: string[];
  editAllowedPaths: string[];
  cwdReal: string;
  env: Record<string, string>;
  claudeConfigDir: string;
  token: string;
  mcpServers: NonNullable<Options["mcpServers"]>;
  mcpApprovedPrefixes: string[];
  mcpApprovedTools: string[];
  skillNames: string[];
  skillPluginPath: string | null;
  sandbox: NonNullable<Options["sandbox"]> | undefined;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function sdkUserMessage(text: string, priority?: Priority, uuid?: string): SDKUserMessage {
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
  if (priority) message.priority = priority;
  if (uuid) message.uuid = uuid as SDKUserMessage["uuid"];
  return message;
}

/** Resolve a possibly non-existent path through its nearest existing ancestor. */
function realpathLoose(path: string): string {
  let current = resolve(path);
  const trailing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    trailing.unshift(current.slice(parent.length).replace(/^\/+/, ""));
    current = parent;
  }
  const real = realpathSync(current);
  return trailing.length > 0 ? join(real, ...trailing) : real;
}

function within(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isSensitive(target: string): boolean {
  const segments = target.split(sep);
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.includes(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  return SENSITIVE_BASENAMES.some((name) => base === name || base.startsWith(`${name}.`));
}

interface PathVerdict {
  ok: boolean;
  reason?: string;
}

function validateToolPath(rawPath: string, pre: Preflight, writing: boolean): PathVerdict {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(pre.cwdReal, rawPath);
  const real = realpathLoose(absolute);
  if (!within(real, pre.cwdReal)) {
    return { ok: false, reason: "path escapes the task worktree" };
  }
  if (isSensitive(real)) return { ok: false, reason: "access to a protected path is not permitted" };
  if (writing && (pre.profile === "edit" || (pre.profile === "sandboxed-bash" || pre.profile === "coding"))) {
    if (pre.editAllowedPaths.length === 0) {
      return { ok: false, reason: "edit profile without allowedPaths is not permitted" };
    }
    const allowed = pre.editAllowedPaths.some((allowedPath) => {
      const root = isAbsolute(allowedPath) ? allowedPath : resolve(pre.cwdReal, allowedPath);
      return within(real, realpathLoose(root));
    });
    if (!allowed) return { ok: false, reason: "path is outside allowedPaths" };
  }
  return { ok: true };
}

function denied(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function sanitizeJobId(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe.length === 0 || safe.includes("..")) throw new Error("invalid jobId for worker home");
  return safe;
}

export class ClaudeAgentRunner implements AgentRunner {
  private readonly runtimeRoot: string;
  private readonly configRoot: string;
  private readonly keyFile: string;
  private readonly baseUrl: string;
  private readonly queryFactory: QueryFactory;
  private readonly approvalTimeoutMs: number;
  private readonly mcpCatalogPath: string;
  private readonly resourceCatalogPath: string;
  private readonly sandboxAvailableOverride: boolean | undefined;
  private readonly wireAuditPath: string | undefined;
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: ClaudeAgentRunnerOptions = {}) {
    this.runtimeRoot = options.runtimeRoot ?? resolveRuntimeRoot();
    this.configRoot = options.configRoot ?? join(this.runtimeRoot, "claude-config");
    mkdirSync(this.configRoot, { recursive: true, mode: 0o700 });
    this.keyFile = options.keyFile ?? resolveKeyFile();
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.mcpCatalogPath = options.mcpCatalogPath ?? process.env["CLAUDE_DURATEAM_MCP_CATALOG"] ?? join(process.env["CLAUDE_DURATEAM_CONFIG_DIR"] ?? this.runtimeRoot, "config", "mcp-catalog.json");
    this.resourceCatalogPath = options.resourceCatalogPath ?? resolveResourceCatalogPath(process.env["CLAUDE_DURATEAM_CONFIG_DIR"] ?? this.runtimeRoot);
    this.sandboxAvailableOverride = options.sandboxAvailableOverride;
    this.wireAuditPath = options.wireAuditPath ?? process.env["CLAUDE_DURATEAM_WIRE_AUDIT"];
    if (this.wireAuditPath) mkdirSync(dirname(this.wireAuditPath), { recursive: true, mode: 0o700 });
    this.queryFactory =
      options.queryFactory ??
      ((input) => query(input as Parameters<typeof query>[0]) as unknown as QueryHandle);
  }

  async steer(runId: string, message: string, priority: Priority = "next"): Promise<SteerReceipt> {
    const active = this.active.get(runId);
    if (!active || active.finishing || message.trim().length === 0) {
      return { messageId: "", disposition: "unsupported" };
    }
    const messageId = randomUUID();
    const queued = active.queue.push(
      sdkUserMessage(redactSecrets(message, [this.currentTokenFor(active)]), priority, messageId),
    );
    if (!queued) return { messageId: "", disposition: "unsupported" };
    active.pendingSteers.set(messageId, { messageId });
    active.emit({ type: "notice", text: `steer queued ${messageId}` });
    // Never claim delivery here: the SDK echo is confirmed inside run().
    return { messageId, disposition: "queued" };
  }

  private currentTokenFor(active: ActiveRun): string {
    // Token lives only in the run env; never exposed elsewhere.
    return (active as ActiveRun & { token?: string }).token ?? "";
  }

  async run(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): Promise<RunnerResult> {
    const usageNull: Usage = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      sdkCostEstimateUsd: null,
      providerBilledCostUsd: null,
    };
    const fail = (error: string, extra: Partial<RunnerResult> = {}): RunnerResult => ({
      modelSucceeded: false,
      sessionId: null,
      modelReported: null,
      text: "",
      error,
      usage: usageNull,
      ...extra,
    });

    let pre: Preflight;
    try {
      pre = this.preflight(request);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    if (request.signal.aborted) return fail("aborted");

    const queue = new StreamingQueue();
    const controller = new AbortController();
    const emit = (event: WorkerEvent): void => {
      try {
        onEvent(event);
      } catch {
        /* consumer errors must not break the run */
      }
    };

    const active: ActiveRun = {
      runId: request.runId,
      jobId: request.jobId,
      queue,
      controller,
      finishing: false,
      emit,
      pendingSteers: new Map(),
    };
    (active as ActiveRun & { token?: string }).token = pre.token;
    this.active.set(request.runId, active);

    let authProxy: AuthProxyHandle | undefined;
    let queryEnv = pre.env;
    const auditPath = this.wireAuditPath;
    if ((pre.profile === "sandboxed-bash" || pre.profile === "coding") || auditPath) {
      try {
        authProxy = await startAuthProxy({ targetBaseUrl: this.baseUrl, token: pre.token,
          onRequestMetadata: auditPath ? (metadata) => {
            appendFileSync(auditPath, JSON.stringify({ time: new Date().toISOString(), jobId: request.jobId, runId: request.runId, ...metadata }) + "\n", { mode: 0o600 });
          } : undefined,
        });
        queryEnv = {
          ...pre.env,
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          ANTHROPIC_BASE_URL: authProxy.baseUrl,
          ANTHROPIC_AUTH_TOKEN: authProxy.dummyToken,
        };
      } catch {
        return fail("auth_proxy_unavailable:credential-injecting proxy could not start");
      }
    }

    let timedOut = false;
    let aborted = false;
    const deadlineMs = Math.max(1_000, request.deadlineMs || 120_000);
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const onAbort = () => {
      aborted = true;
      controller.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    queue.push(sdkUserMessage(`Your actual working directory is ${request.cwd}. Use relative project paths here. Original source project: ${request.sourceCwd}. Work autonomously within the task scope.\n\n${request.prompt}`));

    let modelReported: string | null = null;
    let sessionId: string | null = null;
    let modelSucceeded = false;
    let finalText = "";
    let resultSubtype: string | string | null = null;
    const resultErrors: string[] = [];
    let usage: Usage = usageNull;
    let toolCallCount = 0;
    const toolNames = new Map<string, string>();
    const toolPaths = new Map<string, string>();
    const assistantTexts: string[] = [];
    let lastThinkingNoticeAt = -Infinity;

    const markSteerDelivered = (candidates: Array<string | undefined>): void => {
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (!active.pendingSteers.has(candidate)) continue;
        active.pendingSteers.delete(candidate);
        emit({ type: "steer_ack", messageId: candidate });
      }
    };

    let handle: QueryHandle | undefined;
    try {
      handle = this.queryFactory({
        prompt: queue as AsyncIterable<SDKUserMessage>,
        options: {
          cwd: request.cwd,
          model: request.model,
          effort: request.effort ?? "high",
          env: queryEnv,
          abortController: controller,
          // Exact-UUID resume / optional fork. Never `continue` (directory-based).
          resume: request.resumeSessionId,
          forkSession: request.forkSession === true ? true : undefined,
          settingSources: [],
          permissionMode: pre.profile === "coding" ? "acceptEdits" : pre.profile === "sandboxed-bash" ? "default" : "dontAsk",
          tools: [...pre.tools],
          allowedTools: [...pre.allowedTools],
          disallowedTools: [...pre.disallowedTools],
          skills: pre.skillNames,
          plugins: pre.skillPluginPath
            ? [{ type: "local", path: pre.skillPluginPath, skipMcpDiscovery: true }]
            : [],
          mcpServers: pre.mcpServers as Options["mcpServers"],
          strictMcpConfig: true,
          maxTurns: request.maxTurns,
          persistSession: true,
          hooks: {
            PreToolUse: [
              { matcher: "Write|Edit|NotebookEdit|Read|Glob|Grep|Bash|Skill", hooks: [this.makePathGuard(pre)] },
            ],
          },
          canUseTool: this.makeApproval(pre, request),
          sandbox: pre.sandbox,
          stderr: (data: string) => {
            const safe = preview(redactSecrets(data, [pre.token]), 200);
            if (safe.length > 0) emit({ type: "notice", text: safe });
          },
        },
      });

      for await (const message of handle) {
        const rec = message as unknown as Record<string, unknown>;
        const type = typeof rec["type"] === "string" ? (rec["type"] as string) : "unknown";

        if (type === "system" && rec["subtype"] === "init") {
          modelReported = typeof rec["model"] === "string" ? rec["model"] : null;
          sessionId = typeof rec["session_id"] === "string" ? (rec["session_id"] as string) : null;
          emit({ type: "init", sessionId: sessionId ?? undefined, model: modelReported ?? undefined });
          continue;
        }

        if (type === "assistant") {
          emit({ type: "turn" });
          markSteerDelivered([
            typeof rec["user_message_uuid"] === "string" ? (rec["user_message_uuid"] as string) : undefined,
            ...(Array.isArray(rec["user_message_uuids"]) ? (rec["user_message_uuids"] as string[]) : []),
          ]);
          const messageObj = rec["message"] as Record<string, unknown> | undefined;
          const content = Array.isArray(messageObj?.["content"]) ? (messageObj["content"] as unknown[]) : [];
          for (const rawBlock of content) {
            const block = rawBlock as Record<string, unknown>;
            if (block["type"] === "text" && typeof block["text"] === "string") {
              const text = redactSecrets(block["text"], [pre.token]);
              assistantTexts.push(text);
              emit({ type: "text", text: preview(text, 200) });
            } else if (block["type"] === "tool_use") {
              toolCallCount += 1;
              const name = typeof block["name"] === "string" ? block["name"] : "unknown";
              const id = typeof block["id"] === "string" ? block["id"] : "";
              toolNames.set(id, name);
              const input = block["input"] as Record<string, unknown> | undefined;
              const rawPath = input?.["file_path"] ?? input?.["notebook_path"];
              if (typeof rawPath === "string" && FILE_WRITE_TOOL_SET.has(name)) {
                const rel = relative(request.cwd, resolve(request.cwd, rawPath));
                if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !isSensitive(rel)) toolPaths.set(id, rel);
              }
              emit({ type: "tool_start", toolName: name, toolCallId: id, ...(toolPaths.has(id) ? { path: toolPaths.get(id) } : {}) });
            }
          }
          if (typeof rec["error"] === "string") emit({ type: "notice", text: `assistant_error:${rec["error"]}` });
          continue;
        }

        if (type === "user") {
          const messageObj = rec["message"] as Record<string, unknown> | undefined;
          const content = Array.isArray(messageObj?.["content"]) ? (messageObj["content"] as unknown[]) : [];
          for (const rawBlock of content) {
            const block = rawBlock as Record<string, unknown>;
            if (block["type"] === "tool_result") {
              const id = typeof block["tool_use_id"] === "string" ? (block["tool_use_id"] as string) : "";
              emit({ type: "tool_end", toolName: toolNames.get(id) ?? "unknown", toolCallId: id, isError: block["is_error"] === true, ...(toolPaths.has(id) ? { path: toolPaths.get(id) } : {}) });
            }
          }
          continue;
        }

        if (type === "result") {
          if (typeof rec["num_turns"] === "number") emit({ type: "turn", turnCount: rec["num_turns"] });
          modelSucceeded = rec["subtype"] === "success" && rec["is_error"] !== true;
          resultSubtype = typeof rec["subtype"] === "string" ? (rec["subtype"] as string) : "unknown";
          const resultText = typeof rec["result"] === "string" ? (rec["result"] as string) : "";
          finalText = redactSecrets(resultText, [pre.token]);
          if (typeof rec["session_id"] === "string") sessionId = rec["session_id"] as string;
          const rawUsage = (rec["usage"] as Record<string, unknown>) ?? {};
          const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
          usage = {
            inputTokens: num(rawUsage["input_tokens"]),
            outputTokens: num(rawUsage["output_tokens"]),
            cacheReadTokens: num(rawUsage["cache_read_input_tokens"]),
            sdkCostEstimateUsd: num(rec["total_cost_usd"]),
            providerBilledCostUsd: null,
          };
          if (Array.isArray(rec["errors"])) {
            for (const error of rec["errors"] as unknown[]) resultErrors.push(preview(String(error), 300));
          }
          queue.end();
          break;
        }

        if (type === "system" && typeof rec["subtype"] === "string" && rec["subtype"] !== "init") {
          // Some providers emit a thinking heartbeat for every token. Persist a
          // bounded liveness signal instead of a SQLite event per token; never
          // retain the thinking content itself.
          if (rec["subtype"] === "thinking_tokens") {
            const now = Date.now();
            if (now - lastThinkingNoticeAt < 5_000) continue;
            lastThinkingNoticeAt = now;
          }
          emit({ type: "notice", text: `system:${rec["subtype"]}` });
        }
      }
    } catch (err) {
      resultErrors.push(preview(err instanceof Error ? err.message : String(err), 300));
    } finally {
      clearTimeout(deadlineTimer);
      request.signal.removeEventListener("abort", onAbort);
      active.finishing = true;
      queue.end();
      queue.close();
      this.active.delete(request.runId);
      if (authProxy) {
        try {
          await authProxy.close();
        } catch {
          /* proxy teardown is best effort */
        }
      }
      try {
        handle?.close();
      } catch {
        /* the run is already terminating */
      }
    }

    if (aborted || request.signal.aborted) return fail("aborted", { sessionId, modelReported, usage });
    if (timedOut) return fail("timed_out", { sessionId, modelReported, usage });
    if (!modelSucceeded) {
      const detail = resultErrors[0] ?? resultSubtype ?? "no_result";
      return fail(`result:${detail}`, {
        sessionId,
        modelReported,
        usage,
        text: finalText || preview(assistantTexts[assistantTexts.length - 1] ?? "", 400),
      });
    }
    const answer = finalText || assistantTexts[assistantTexts.length - 1] || "";
    const reportDir = join(this.runtimeRoot, "reports");
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const reportPath = join(reportDir, `${request.runId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
    writeFileSync(reportPath, answer, { mode: 0o600 });
    return {
      reportPath,
      modelSucceeded: true,
      sessionId: sessionId && isUuid(sessionId) ? sessionId : sessionId,
      modelReported,
      text: answer,
      error: null,
      usage,
    };
  }

  private preflight(request: RunnerRequest): Preflight {
    if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > MAX_TASK_TURNS) {
      throw new Error(`invalid_budget:maxTurns must be 1..${MAX_TASK_TURNS}`);
    }
    if (!Number.isInteger(request.deadlineMs) || request.deadlineMs < 1 || request.deadlineMs > MAX_TASK_DURATION_MS) {
      throw new Error(`invalid_budget:deadlineMs must be 1..${MAX_TASK_DURATION_MS}`);
    }
    try {
      assertAllowedModel(request.model);
    } catch (err) {
      throw new Error(`unsupported_capability:${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isAbsolute(request.cwd) || !existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
      throw new Error("unsupported_capability:cwd must be an existing absolute directory");
    }
    if (request.resumeSessionId && !isUuid(request.resumeSessionId)) {
      throw new Error("unsupported_capability:resumeSessionId must be an exact session UUID");
    }
    if ((request.profile === "edit" || (request.profile === "sandboxed-bash" || request.profile === "coding")) && request.allowedPaths.length === 0) {
      throw new Error("unsupported_capability:edit profile requires non-empty allowedPaths (no implicit whole-repo writes)");
    }

    let sandbox: Preflight["sandbox"];
    if (request.profile === "coding") sandbox = { enabled: false };
    if (request.profile === "sandboxed-bash") {
      if (this.sandboxAvailableOverride === false) {
        throw new Error("sandbox_unavailable:test seam forced unavailable (fail-closed, no host execution)");
      }
      const sandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("sandbox_unavailable:no OS sandbox integration on this platform");
      }
      if (process.platform === "darwin" && !sandboxExec) {
        throw new Error("sandbox_unavailable:sandbox-exec not found; refusing to run unsandboxed Bash");
      }
      sandbox = {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        network: {
          allowLocalBinding: true,
          allowedDomains: (process.env["CLAUDE_DURATEAM_NETWORK_DOMAINS"] ?? "").split(",").map(x => x.trim()).filter(Boolean),
        },
        filesystem: {
          allowWrite: [request.cwd, ...request.allowedPaths],
          // Other jobs' transcripts, worker HOMEs, the operator home and the
          // credential file location stay unreadable to Bash.
          denyRead: [this.configRoot, join(this.runtimeRoot, "jobs"), homedir(), dirname(this.keyFile)],
        },
      };
    }

    const selectedSkills = loadPreapprovedSkills({
      catalogPath: this.resourceCatalogPath,
      requested: request.allowedSkillNames,
    });
    const skillBundle =
      selectedSkills.length > 0
        ? buildSkillBundle({
            skills: selectedSkills,
            bundleRoot: join(this.runtimeRoot, "skill-bundles", sanitizeJobId(request.jobId), sanitizeJobId(request.runId)),
          })
        : null;

    const mcpPolicy = loadPreapprovedMcpServers({
      catalogPath: this.mcpCatalogPath,
      requested: request.enabledMcpServers,
    });

    const cwdReal = realpathSync(request.cwd);
    // Cross-job resume/fork: the shared bridge-owned transcript root must
    // expose the parent session under the target cwd before the SDK starts.
    const jobHome = prepareWorkerHome(this.runtimeRoot, join("jobs", sanitizeJobId(request.jobId)));
    linkSharedProjectStore(jobHome.claudeConfigDir, join(this.configRoot, "projects"));
    if (request.resumeSessionId) {
      try {
        ensureSessionTranscript(this.configRoot, request.resumeSessionId, cwdReal);
      } catch (err) {
        // If the parent transcript is unknown, let the SDK surface its own
        // "No conversation found" error instead of inventing a local state.
        if (!(err instanceof SessionTranscriptError)) throw err;
      }
    }

    let credential;
    try {
      credential = loadApiKeyFromFile(this.keyFile);
    } catch (err) {
      const code = err instanceof CredentialError ? err.code : "unreadable";
      throw new Error(`credential:${code}`);
    }

    const built = buildWorkerEnv({
      credential,
      model: request.model,
      workerHome: jobHome,
      baseUrl: this.baseUrl,
    });
    const allowedPaths = request.allowedPaths.map((p) =>
      isAbsolute(p) ? realpathLoose(p) : realpathLoose(resolve(cwdReal, p)),
    );

    const baseTools =
      request.profile === "read" ? READ_TOOLS : request.profile === "edit" ? EDIT_TOOLS : BASH_TOOLS;
    const tools = skillBundle ? [...baseTools, "Skill"] : baseTools;
    const disallowed = [...ALWAYS_DISALLOWED];
    if (skillBundle) {
      const index = disallowed.indexOf("Skill");
      if (index !== -1) disallowed.splice(index, 1);
    }
    if (request.profile !== "sandboxed-bash" && request.profile !== "coding") disallowed.push("Bash");
    if (request.profile === "read") disallowed.push("Write", "Edit", "NotebookEdit");
    // Authorized exact MCP tools join the pre-approved list; everything else
    // falls through to canUseTool (real approval) or is denied by the hook.
    // Edit profile: in-scope ordinary writes are pre-approved and run without
    // per-call approval; the PreToolUse path/protected-file gate remains the
    // boundary. Bash stays behind a real approval callback.
    const editWritesArePreapproved = request.profile === "edit" || (request.profile === "sandboxed-bash" || request.profile === "coding");
    const allowedTools = [
      ...READ_TOOLS,
      ...(request.profile === "coding" ? ["Bash"] : []),
      ...mcpPolicy.approvedTools,
      ...(skillBundle ? ["Skill"] : []),
      ...(editWritesArePreapproved ? [...FILE_WRITE_TOOLS] : []),
    ];

    return {
      profile: request.profile,
      tools,
      allowedTools,
      disallowedTools: disallowed,
      editAllowedPaths: allowedPaths,
      cwdReal,
      env: built.env,
      claudeConfigDir: built.summary.claudeConfigDir,
      token: credential.token,
      mcpServers: mcpPolicy.servers,
      mcpApprovedPrefixes: mcpPolicy.approvedPrefixes,
      mcpApprovedTools: mcpPolicy.approvedTools,
      skillNames: skillBundle?.skillNames ?? [],
      skillPluginPath: skillBundle?.pluginPath ?? null,
      sandbox,
    };
  }

  private makePathGuard(pre: Preflight): HookCallback {
    return async (input) => {
      const rec = input as unknown as Record<string, unknown>;
      if (rec["hook_event_name"] !== "PreToolUse") return {};
      const toolName = typeof rec["tool_name"] === "string" ? (rec["tool_name"] as string) : "";
      const toolInput = (rec["tool_input"] as Record<string, unknown>) ?? {};
      if (toolName === "Bash") {
        if (pre.sandbox?.enabled && toolInput["dangerouslyDisableSandbox"] === true) return denied("unsandboxed execution is not permitted");
        if (pre.profile !== "sandboxed-bash" && pre.profile !== "coding") return denied("Bash is not available in this profile");
        return {};
      }
      if (toolName === "Skill") {
        const skillValue = [toolInput["skill"], toolInput["name"], toolInput["command"]]
          .filter((value): value is string => typeof value === "string")
          .at(0);
        const bare = skillValue?.includes(":") ? skillValue.split(":").pop()! : skillValue;
        if (bare && pre.skillNames.includes(bare)) return {};
        return denied("skill is not in the task's pre-approved selection");
      }
      if (toolName.startsWith("mcp__")) {
        // Catalog' `tools` list is the exact allowlist; selecting a server alone
        // injects it but does not authorize any of its tools.
        return pre.mcpApprovedTools.includes(toolName)
          ? {}
          : denied("MCP tool is not explicitly authorized by the pre-approved catalog");
      }
      const rawPath = toolInput["file_path"] ?? toolInput["notebook_path"] ?? toolInput["path"];
      if (typeof rawPath !== "string") return {};
      const verdict = validateToolPath(rawPath, pre, FILE_WRITE_TOOL_SET.has(toolName));
      if (!verdict.ok) return denied(verdict.reason ?? "path rejected");
      if (FILE_WRITE_TOOL_SET.has(toolName) && isSensitive(rawPath)) {
        return denied("writing to a protected path is not permitted");
      }
      return {};
    };
  }

  private makeApproval(pre: Preflight, request: RunnerRequest): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      if (options.signal.aborted) return { behavior: "deny", message: "aborted" };
      if (toolName === "Bash" && pre.sandbox?.enabled && input["dangerouslyDisableSandbox"] === true) return { behavior: "deny", message: "unsandboxed execution is not permitted" };
      if (toolName.startsWith("mcp__")) {
        if (pre.mcpApprovedTools.includes(toolName)) return { behavior: "allow", updatedInput: input };
        return {
          behavior: "deny",
          message: "MCP tool is not explicitly authorized by the pre-approved catalog",
        };
      }
      const requestId = `apr-${randomUUID()}`;
      const description = options.title ?? options.description ?? `${toolName} request`;
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      try {
        const decision = await Promise.race<boolean>([
          request.requestApproval({ requestId, toolName, description } satisfies ApprovalRequest),
          new Promise<boolean>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout(false), this.approvalTimeoutMs);
          }),
          new Promise<boolean>((resolveAbort) => {
            abortListener = () => resolveAbort(false);
            options.signal.addEventListener("abort", abortListener, { once: true });
          }),
        ]);
        if (decision) return { behavior: "allow", updatedInput: input };
        return { behavior: "deny", message: `denied by unattended approval policy (${requestId})` };
      } finally {
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal.removeEventListener("abort", abortListener);
      }
    };
  }
}
