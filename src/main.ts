/**
 * stdio MCP entry point with dependency composition.
 *
 * The scheduler / workspace / state / gate modules are owned by other
 * components and may not exist yet. Composition tries the agreed module paths;
 * when a dependency is missing the server still starts and exposes the full
 * contract tool surface, but every scheduling call returns a structured
 * `scheduler_unavailable` error instead of pretending to work.
 *
 * stdout belongs to JSON-RPC; all diagnostics go to stderr.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { GateRequest, GateResult, JobSnapshot, Priority, SchedulerService, SteerReceipt, TaskInput, WaitResult } from "./task-contracts.js";
import { ClaudeAgentRunner } from "./engines/agent-runner.js";
import { resolveRuntimeRoot } from "./engines/environment.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./mcp/server.js";
import { DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_LIMIT } from "./scheduler/validation.js";
import { InstanceManager } from "./instances/manager.js";
import { redactSecrets } from "./observability/redact.js";
import type { JobState } from "./contracts.js";

const log = (event: string, data: Record<string, unknown> = {}) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, server: SERVER_NAME, ...data })}\n`);
};

class UnavailableScheduler implements SchedulerService {
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new Error(`scheduler_unavailable:${this.reason}`);
  }
  async spawn(_task: TaskInput): Promise<JobSnapshot> {
    this.fail();
  }
  async spawnBatch(_tasks: TaskInput[]): Promise<JobSnapshot[]> {
    this.fail();
  }
  status(_jobId: string): JobSnapshot {
    this.fail();
  }
  sessions(_options?: { cwd?: string; state?: JobState; offset?: number; limit?: number }): JobSnapshot[] {
    this.fail();
  }
  async wait(_jobIds: string[], _options?: { afterRevision?: number | Record<string, number>; timeoutMs?: number }): Promise<WaitResult> {
    this.fail();
  }
  async followUp(_jobId: string, _prompt: string): Promise<JobSnapshot> {
    this.fail();
  }
  async abort(_jobId: string): Promise<JobSnapshot> {
    this.fail();
  }
  async steer(_jobId: string, _message: string, _priority?: Priority): Promise<SteerReceipt> {
    this.fail();
  }
  async fork(_jobId: string, _prompt: string): Promise<JobSnapshot> {
    this.fail();
  }
  async answer(_jobId: string, _requestId: string, _decision: boolean): Promise<{ acknowledged: boolean }> {
    this.fail();
  }
  async close(): Promise<void> {
    /* nothing to close */
  }
}

interface LoadedModule {
  module: Record<string, unknown>;
  path: string;
}

async function loadFirst(paths: string[], exportName: string): Promise<LoadedModule | null> {
  for (const candidate of paths) {
    try {
      const module = (await import(candidate)) as Record<string, unknown>;
      if (typeof module[exportName] === "function") {
        return { module, path: candidate };
      }
    } catch {
      continue;
    }
  }
  return null;
}

interface Composition {
  scheduler: SchedulerService;
  gate?: (request: GateRequest) => Promise<GateResult>;
  info: { available: boolean; reason?: string; maxConcurrent: number; maxQueued: number };
  cleanup: () => Promise<void>;
}

export async function compose(runtimeOverride?: string, stateDbOverride?: string): Promise<Composition> {
  const runtimeRoot = runtimeOverride ?? resolveRuntimeRoot();
  const allowedRoots = (process.env["CLAUDE_DURATEAM_ALLOWED_ROOTS"] ?? process.cwd())
    .split(",")
    .map((entry) => resolve(entry.trim()))
    .filter((entry) => entry.length > 0);
  const maxConcurrentRaw = Number(process.env["CLAUDE_DURATEAM_MAX_CONCURRENT"] ?? DEFAULT_MAX_CONCURRENT);
  if (!Number.isInteger(maxConcurrentRaw) || maxConcurrentRaw < 1 || maxConcurrentRaw > MAX_CONCURRENT_LIMIT) {
    throw new Error(`CLAUDE_DURATEAM_MAX_CONCURRENT must be 1..${MAX_CONCURRENT_LIMIT}`);
  }
  const maxConcurrent = maxConcurrentRaw;
  const maxQueued = Math.max(Number.parseInt(process.env["CLAUDE_DURATEAM_MAX_QUEUED"] ?? "32", 10) || 32, 1);

  const runner = new ClaudeAgentRunner({ runtimeRoot });

  const schedulerModule = await loadFirst(["./scheduler/index.js", "./scheduler/scheduler.js", "./scheduler.js"], "Scheduler");
  const workspaceModule = await loadFirst(
    ["./workspace/index.js", "./workspace/git-workspace.js", "./workspace/worktree.js", "./workspace.js"],
    "GitWorkspaceService",
  );
  const stateModule = await loadFirst(["./state/index.js", "./state/sqlite.js", "./state/sqlite-store.js"], "SqliteStateStore");
  const gateModule =
    workspaceModule && typeof workspaceModule.module["runGate"] === "function"
      ? { module: workspaceModule.module, path: `${workspaceModule.path}#runGate` }
      : await loadFirst(["./workspace/index.js", "./workspace/gate.js", "./acceptance/gate.js", "./gate.js"], "runGate");

  if (!schedulerModule || !workspaceModule || !stateModule) {
    const missing = [
      !schedulerModule ? "scheduler(Scheduler)" : null,
      !workspaceModule ? "workspace(GitWorkspaceService)" : null,
      !stateModule ? "state(SqliteStateStore)" : null,
    ].filter(Boolean);
    return {
      scheduler: new UnavailableScheduler(`missing modules: ${missing.join(", ")}`),
      info: { available: false, reason: `missing modules: ${missing.join(", ")}`, maxConcurrent, maxQueued },
      cleanup: async () => {},
    };
  }

  const stateDir = join(runtimeRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = new (stateModule.module["SqliteStateStore"] as new (options: { path: string }) => {
    close?: () => void;
  })({ path: stateDbOverride ?? (runtimeOverride ? join(stateDir, "claude-durateam.db") : process.env["CLAUDE_DURATEAM_STATE_DB"] ?? join(stateDir, "claude-durateam.db")) });

  const workspace = new (workspaceModule.module["GitWorkspaceService"] as new (options: {
    allowedRoots: string[];
    worktreeRoot: string;
  }) => unknown)({
    allowedRoots,
    // Keep default write workspaces beside the approved source tree, outside
    // its checkout and outside the private credential/runtime HOME subtree.
    worktreeRoot: process.env["CLAUDE_DURATEAM_WORKTREE_ROOT"] ?? join(
      dirname(allowedRoots[0]!), ".claude-durateam-worktrees",
      createHash("sha256").update(allowedRoots.join("\0")).digest("hex").slice(0, 12),
    ),
  });

  try {
    const scheduler = new (schedulerModule.module["Scheduler"] as new (options: {
      runner: ClaudeAgentRunner;
      workspace: unknown;
      store: unknown;
      maxConcurrent: number;
      maxQueued: number;
    }) => SchedulerService)({ runner, workspace, store, maxConcurrent, maxQueued });

    const gate = gateModule
      ? (request: GateRequest) => (gateModule.module["runGate"] as (req: GateRequest) => Promise<GateResult>)(request)
      : undefined;

    log("composition.ready", {
      modules: [schedulerModule.path, workspaceModule.path, stateModule.path, gateModule?.path ?? null],
      allowedRoots,
      maxConcurrent,
      maxQueued,
    });

    return {
      scheduler,
      gate,
      info: { available: true, maxConcurrent, maxQueued },
      cleanup: async () => {
        try {
          await scheduler.close();
        } finally {
          store.close?.();
        }
      },
    };
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    store.close?.();
    log("composition.failed", { reason });
    return {
      scheduler: new UnavailableScheduler(reason),
      info: { available: false, reason, maxConcurrent, maxQueued },
      cleanup: async () => {},
    };
  }
}

async function main(): Promise<void> {
  const composition = await compose();
  const { scheduler, gate, info } = composition;
  const base = process.env["CLAUDE_DURATEAM_INSTANCE_BASE"];
  const instanceId = process.env["CLAUDE_DURATEAM_INSTANCE"];
  const manager = base && instanceId ? new InstanceManager(base, instanceId, scheduler, compose) : undefined;

  const handle = serveStdio(
    () =>
      createServer({
        scheduler,
        schedulerInfo: info,
        gate,
        ...(manager ? {
          resolveScheduler: (id?: string) => manager.resolve(id),
          listStored: (cwd?: string) => manager.listStored(cwd),
          handoff: (args: Parameters<InstanceManager["handoff"]>[0]) => manager.handoff(args),
        } : {}),
      }),
    {
      legacy: "serve",
      onerror: (error) => log("transport.error", { message: error.message }),
    },
  );

  log("server.started", {
    version: SERVER_VERSION,
    pid: process.pid,
    schedulerAvailable: info.available,
    schedulerReason: info.reason ?? null,
    moduleUrl: pathToFileURL(import.meta.url).href,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log("server.shutdown", { signal });
    try {
      await handle.close();
    } finally {
      try {
        try { await manager?.close(); } finally { await composition.cleanup(); }
      } finally {
        process.exit(0);
      }
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log("server.fatal", { message: redactSecrets(error instanceof Error ? error.message : String(error)) });
  process.exit(1);
});
