/**
 * MCP tool surface (P1): init/models/spawn/spawn_batch/wait/status/sessions/
 * follow_up/abort/steer/fork/answer (+ optional gate).
 *
 * Handlers are thin: all scheduling semantics live in SchedulerService, all
 * SDK semantics live in ClaudeAgentRunner. Errors are returned as `isError`
 * results with redacted messages, never as silent success.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type {
  GateRequest,
  GateResult,
  JobSnapshot,
  Priority,
  SchedulerService,
  SteerReceipt,
  TaskInput,
} from "../task-contracts.js";
import { MODEL_ROUTES, WORKER_MODELS } from "../contracts.js";
import { DEFAULT_BASE_URL, KEY_FILE_ENV, loadApiKeyFromFile, resolveKeyFile, resolveRuntimeRoot } from "../engines/environment.js";
import { redactSecrets } from "../observability/redact.js";
import { PACKAGE_VERSION } from "../version.js";
import { MAX_TASK_TURNS, MAX_TASK_DURATION_MS } from "../task-limits.js";

export const SERVER_NAME = "claude-durateam";
export const SERVER_VERSION = PACKAGE_VERSION;
export const MAX_BATCH_TASKS = 8;

export interface McpDeps {
  scheduler: SchedulerService;
  schedulerInfo: { available: boolean; reason?: string; maxConcurrent: number; maxQueued: number };
  gate?: (request: GateRequest) => Promise<GateResult>;
  resolveScheduler?: (instanceId?: string) => Promise<SchedulerService>;
  listStored?: (cwd?: string) => { instanceId: string; snapshot: JobSnapshot }[];
  handoff?: (args: { action: "save" | "read"; cwd: string; instanceId?: string; jobId?: string; goal?: string; completed?: string; next?: string; name?: string }) => unknown;
}

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message: redactSecrets(message) } }) }],
    isError: true,
  };
}

function credentialStatus(): { configured: boolean; reason?: string; format?: string; bytes?: number } {
  try {
    const credential = loadApiKeyFromFile(resolveKeyFile());
    return { configured: true, format: credential.format, bytes: credential.sourceBytes };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "unknown";
    return { configured: false, reason: `credential:${code}` };
  }
}

const taskInputSchema = z.object({
  instanceId: z.string().optional(),
  prompt: z.string().min(1).max(20_000),
  cwd: z.string().min(1),
  model: z.enum(WORKER_MODELS).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().default("high"),
  profile: z.enum(["read", "edit", "sandboxed-bash", "coding"]).optional(),
  maxTurns: z.number().int().min(1).max(MAX_TASK_TURNS).optional(),
  deadlineMs: z.number().int().min(1_000).max(MAX_TASK_DURATION_MS).optional(),
  allowedPaths: z.array(z.string()).max(32).optional(),
  allowedSkillNames: z.array(z.string()).max(16).optional(),
  enabledMcpServers: z.array(z.string()).max(8).optional(),
});

function boundedSnapshot(snapshot: JobSnapshot, instanceId?: string): Record<string, unknown> {
  return {
    jobId: snapshot.jobId,
    instanceId: instanceId ?? process.env["CLAUDE_DURATEAM_INSTANCE"] ?? null,
    progress: snapshot.progress ? { ...snapshot.progress,
      idleMs: snapshot.progress.lastActivityAt ? Math.max(0, Date.now() - Date.parse(snapshot.progress.lastActivityAt)) : null,
      toolIdleMs: snapshot.progress.lastToolAt ? Math.max(0, Date.now() - Date.parse(snapshot.progress.lastToolAt)) : null,
    } : null,
    reportPath: snapshot.reportPath ?? null,
    runId: snapshot.runId,
    attempt: snapshot.attempt,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    revision: snapshot.revision,
    nextAction: snapshot.nextAction,
    task: {
      cwd: snapshot.task.cwd,
      model: snapshot.task.model,
      effort: snapshot.task.effort ?? "high",
      profile: snapshot.task.profile,
      allowedPaths: snapshot.task.allowedPaths,
      maxTurns: snapshot.task.maxTurns,
      deadlineMs: snapshot.task.deadlineMs,
      managedWorktree: snapshot.task.managedWorktree,
      branch: snapshot.task.branch,
      forkBase: snapshot.task.forkBase ?? null,
    },
    modelRequested: snapshot.modelRequested,
    modelReported: snapshot.modelReported,
    modelSucceeded: snapshot.modelSucceeded,
    gatePassed: snapshot.gatePassed,
    durationMs: snapshot.durationMs,
    toolCallCount: snapshot.toolCallCount,
    latestTextPreview: snapshot.latestTextPreview,
    lastError: snapshot.lastError,
    usage: snapshot.usage,
    approvals: snapshot.approvals,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const schedulerFor = async (instanceId?: string): Promise<SchedulerService> => {
    if (deps.resolveScheduler) return deps.resolveScheduler(instanceId);
    if (instanceId && instanceId !== process.env["CLAUDE_DURATEAM_INSTANCE"]) throw new Error("instance routing unavailable");
    requireScheduler(); return deps.scheduler;
  };
  server.registerTool(
    "init",
    {
      title: "Initialize claude-durateam",
      description:
        "Read-only diagnostics: versions, routing, models, credential presence (never the value), scheduler availability and isolation limits. Does not call a model.",
      inputSchema: z.object({ cwd: z.string().optional() }),
    },
    async () =>
      ok({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        phase: "P3",
        node: process.version,
        baseUrl: DEFAULT_BASE_URL,
        provider: "volcengine-coding-plan",
        apiProtocol: "anthropic-compatible",
        models: MODEL_ROUTES,
        defaults: { model: "glm-5.3-flash", effort: "high", profile: "coding" },
        connection: {
          instanceId: process.env["CLAUDE_DURATEAM_INSTANCE"] ?? null,
          runtimeDir: resolveRuntimeRoot(),
          configDir: process.env["CLAUDE_DURATEAM_CONFIG_DIR"] ?? resolveRuntimeRoot(),
          scope: process.env["CLAUDE_DURATEAM_INSTANCE"] ? "codex-connection" : "configured-runtime",
        },
        credential: { keyFileEnv: KEY_FILE_ENV, ...credentialStatus() },
        scheduler: deps.schedulerInfo,
        isolation: {
          settingSources: [],
          isolatedHomePerJob: true,
          stableHomeAcrossResume: true,
          profiles: ["read", "edit", "sandboxed-bash", "coding"],
          sandboxRequiredForBash: false,
          codingSandboxEnabled: false,
          preapprovedMcpCatalogOnly: true,
          skillAllowlistSupported: true,
        },
        capabilities: {
          spawn: deps.schedulerInfo.available,
          spawn_batch: deps.schedulerInfo.available,
          wait: deps.schedulerInfo.available,
          follow_up: deps.schedulerInfo.available,
          abort: deps.schedulerInfo.available,
          steer: deps.schedulerInfo.available,
          fork: deps.schedulerInfo.available,
          answer: deps.schedulerInfo.available,
          gate: deps.gate !== undefined,
          handoff: deps.handoff !== undefined,
        },
        notes: [
          "steer returns queued; delivered is only reported after a real SDK echo",
          "write profiles require non-empty allowedPaths",
          "skills are selected from the operator catalog; unselected calls are denied",
          "coding uses acceptEdits and pre-approved Bash without an OS sandbox; sandboxed-bash is opt-in",
          "unattended approvals default to deny",
        ],
      }),
  );

  server.registerTool(
    "models",
    {
      title: "List allowed models",
      description: "Allowed GLM models. Routing never falls back to Anthropic-hosted models.",
      inputSchema: z.object({ filter: z.string().optional() }),
    },
    async (args) => {
      const filter = args.filter?.toLowerCase();
      const models = MODEL_ROUTES.filter((route) => (filter ? route.id.includes(filter) : true));
      return ok({ models, allowed: WORKER_MODELS, default: "glm-5.3-flash", noFallback: true });
    },
  );

  const requireScheduler = (): void => {
    if (!deps.schedulerInfo.available) {
      throw new Error(
        `scheduler_unavailable:${deps.schedulerInfo.reason ?? "scheduler/workspace/state modules not composed"}`,
      );
    }
  };

  server.registerTool(
    "spawn",
    {
      title: "Spawn a worker (non-blocking)",
      description: "Start one Claude Agent SDK worker asynchronously; returns immediately with a jobId and state.",
      inputSchema: taskInputSchema,
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        return ok(boundedSnapshot(await scheduler.spawn(args as TaskInput), args.instanceId));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "spawn_batch",
    {
      title: "Spawn a batch of workers",
      description:
        "Validate the whole batch before starting anything; returns one snapshot per task. Independent worktrees are prepared by the workspace service.",
      inputSchema: z.object({ instanceId: z.string().optional(), tasks: z.array(taskInputSchema).min(1).max(MAX_BATCH_TASKS) }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const snapshots = await scheduler.spawnBatch(args.tasks as TaskInput[]);
        return ok(snapshots.map(job => boundedSnapshot(job, args.instanceId)));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait for job events",
      description:
        "Bounded event wait (max 30s). Timeout means no new state in this call, not job failure; continue with continueIds.",
      inputSchema: z.object({
        instanceId: z.string().optional(),
        jobId: z.string().optional(),
        jobIds: z.array(z.string()).max(16).optional(),
        afterRevision: z.union([z.number().int().min(0), z.record(z.string(), z.number().int().min(0))]).optional(),
        timeoutMs: z.number().int().min(500).max(30_000).optional(),
      }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const ids = args.jobIds ?? (args.jobId ? [args.jobId] : []);
        if (ids.length === 0) return err("wait requires jobId or jobIds");
        const result = await scheduler.wait(ids, {
          afterRevision: args.afterRevision,
          timeoutMs: args.timeoutMs ?? 30_000,
        });
        return ok({ ...result, jobs: result.jobs.map(job => boundedSnapshot(job, args.instanceId)) });
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "status",
    {
      title: "Job status",
      description: "Bounded snapshot for one job. Verbose is accepted but output stays bounded.",
      inputSchema: z.object({ instanceId: z.string().optional(), jobId: z.string(), verbose: z.boolean().optional() }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        return ok(boundedSnapshot(scheduler.status(args.jobId), args.instanceId));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "sessions",
    {
      title: "List known jobs/sessions",
      description: "Filter and paginate known jobs; secrets and full transcripts are not returned.",
      inputSchema: z.object({
        instanceId: z.string().optional(),
        includeStored: z.boolean().optional(),
        cwd: z.string().optional(),
        state: z.enum(["queued", "starting", "running", "needs_attention", "succeeded", "failed", "cancelled", "timed_out", "interrupted", "unknown_outcome"]).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const jobs = scheduler.sessions({
          cwd: args.cwd,
          state: args.state,
          offset: args.offset,
          limit: args.limit ?? 20,
        });
        const stored = args.includeStored ? (deps.listStored?.(args.cwd) ?? []).filter(item => !args.state || item.snapshot.state === args.state).filter(item => item.instanceId !== (args.instanceId ?? process.env["CLAUDE_DURATEAM_INSTANCE"]))
          .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 20)).map(item => boundedSnapshot(item.snapshot, item.instanceId)) : [];
        return ok({ jobs: jobs.map(job => boundedSnapshot(job, args.instanceId)), stored });
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "follow_up",
    {
      title: "Continue an idle session",
      description: "Exactly-UUID resume of an idle job; never uses directory-based continue.",
      inputSchema: z.object({ instanceId: z.string().optional(), jobId: z.string(), prompt: z.string().min(1).max(20_000),
        maxTurns: z.number().int().min(1).max(MAX_TASK_TURNS).optional(),
        deadlineMs: z.number().int().min(1000).max(MAX_TASK_DURATION_MS).optional(),
      }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const budget = args.maxTurns !== undefined || args.deadlineMs !== undefined
          ? { ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}), ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}) } : undefined;
        return ok(boundedSnapshot(budget
          ? await scheduler.followUp(args.jobId, args.prompt, budget)
          : await scheduler.followUp(args.jobId, args.prompt), args.instanceId));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "abort",
    {
      title: "Abort a job",
      description: "Best-effort interrupt; partial writes are not rolled back.",
      inputSchema: z.object({ instanceId: z.string().optional(), jobId: z.string() }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        return ok(boundedSnapshot(await scheduler.abort(args.jobId), args.instanceId));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "steer",
    {
      title: "Steer a running job",
      description:
        "Queue a message for the running turn. `delivered` is only reported after the SDK echoes it; otherwise the disposition stays queued or unsupported.",
      inputSchema: z.object({
        jobId: z.string(),
        message: z.string().min(1).max(2_000),
        instanceId: z.string().optional(),
        priority: z.enum(["next", "later", "now"]).optional(),
      }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const receipt: SteerReceipt = await scheduler.steer(
          args.jobId,
          args.message,
          (args.priority ?? "next") as Priority,
        );
        return ok(receipt);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "fork",
    {
      title: "Fork a job session",
      description: "Fork the Claude session (SDK forkSession), distinct from a Git branch/worktree.",
      inputSchema: z.object({ instanceId: z.string().optional(), jobId: z.string(), prompt: z.string().min(1).max(20_000).optional() }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        return ok(boundedSnapshot(await scheduler.fork(args.jobId, args.prompt ?? "Continue the task."), args.instanceId));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "answer",
    {
      title: "Answer a pending approval",
      description:
        "Resolve one real canUseTool approval raised by the runner. Unknown ids fail; there is no blanket auto-approve.",
      inputSchema: z.object({ instanceId: z.string().optional(), jobId: z.string(), requestId: z.string(), decision: z.boolean() }),
    },
    async (args) => {
      try {
        const scheduler = await schedulerFor(args.instanceId);
        const result = await scheduler.answer(args.jobId, args.requestId, args.decision);
        return ok(result);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  if (deps.handoff) {
    server.registerTool("handoff", {
      description: "Save/read a project handoff. Read returns instanceId/jobId for cross-window follow_up; active owners are never taken over.",
      inputSchema: z.object({ action: z.enum(["save", "read"]), cwd: z.string(), instanceId: z.string().optional(), jobId: z.string().optional(),
        name: z.string().optional(), goal: z.string().max(4000).optional(), completed: z.string().max(4000).optional(), next: z.string().max(4000).optional() }),
    }, async args => { try { return ok(await deps.handoff!(args)); } catch (error) { return err(error instanceof Error ? error.message : String(error)); } });
  }

  if (deps.gate) {
    server.registerTool(
      "gate",
      {
        title: "Run integration gate",
        description: "Run the workspace gate (diff scope + configured commands) for a completed job worktree.",
        inputSchema: z.object({
          cwd: z.string(),
          allowedPaths: z.array(z.string()).max(32).optional(),
          commands: z.array(z.array(z.string()).min(1).max(16)).max(16).optional(),
          timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
        }),
      },
      async (args) => {
        try {
          const result = await deps.gate!({
            cwd: args.cwd,
            allowedPaths: args.allowedPaths ?? [],
            commands: args.commands,
            timeoutMs: args.timeoutMs,
          });
          return ok(result);
        } catch (error) {
          return err(error instanceof Error ? error.message : String(error));
        }
      },
    );
  }
}
