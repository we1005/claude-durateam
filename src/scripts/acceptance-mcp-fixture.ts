/**
 * Acceptance-only MCP fixture (QA-owned; NOT a production entry point).
 *
 * Serves the real MCP tool surface with the real Scheduler, GitWorkspaceService,
 * SqliteStateStore and gate, but with an explicitly injected fake AgentRunner.
 * This is the only place a fake runner exists for integration acceptance; production
 * src/main.ts always constructs ClaudeAgentRunner.
 *
 * Output contract: stdout is JSON-RPC only; every diagnostic goes to stderr.
 * No provider credential is read; the runner never calls the network.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Scheduler } from "../scheduler/index.js";
import { GitWorkspaceService, runGate } from "../workspace/index.js";
import { SqliteStateStore } from "../state/index.js";
import { createServer } from "../mcp/server.js";
import type { AgentRunner, Priority, RunnerRequest, RunnerResult, SteerReceipt, WorkerEvent, Usage } from "../task-contracts.js";

const log = (event: string, data: Record<string, unknown> = {}): void => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function appendLog(path: string, record: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

const emptyUsage: Usage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  sdkCostEstimateUsd: null,
  providerBilledCostUsd: null,
};

class FakeRunner implements AgentRunner {
  private readonly fakeLog: string;
  private readonly abortDelayMs: number;
  private readonly callbacks = new Map<string, Array<(request: { requestId: string; toolName: string; description: string }) => Promise<boolean>>>();

  constructor(fakeLog: string, abortDelayMs: number) {
    this.fakeLog = fakeLog;
    this.abortDelayMs = abortDelayMs;
  }

  async steer(runId: string, message: string, priority: Priority): Promise<SteerReceipt> {
    appendLog(this.fakeLog, { event: "steer_received", runId, priority, messageLength: message.length });
    return { messageId: randomUUID(), disposition: "queued" };
  }

  async run(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): Promise<RunnerResult> {
    const existing = this.callbacks.get(request.jobId) ?? [];
    existing.push(request.requestApproval);
    this.callbacks.set(request.jobId, existing);

    const sessionId =
      request.resumeSessionId && request.forkSession !== true ? request.resumeSessionId : randomUUID();
    const flags = request.prompt.includes("QA_") ? request.prompt.match(/QA_[A-Z_]+(?::[A-Za-z0-9_-]+)?/g) ?? [] : [];
    appendLog(this.fakeLog, {
      event: "run_start",
      jobId: request.jobId,
      runId: request.runId,
      profile: request.profile,
      cwd: request.cwd,
      resumeSessionId: request.resumeSessionId ?? null,
      forkSession: request.forkSession === true,
      promptFlags: flags,
      promptLength: request.prompt.length,
    });

    onEvent({ type: "init", sessionId, model: request.model });

    if (request.prompt.includes("QA_FAIL")) {
      appendLog(this.fakeLog, { event: "run_end", runId: request.runId, outcome: "failed" });
      return {
        modelSucceeded: false,
        sessionId,
        modelReported: request.model,
        text: "",
        error: "QA_FAIL requested",
        usage: emptyUsage,
      };
    }

    if (request.prompt.includes("QA_APPROVAL")) {
      const requestId = `QA-REQ-${request.runId}`;
      const approved = await request.requestApproval({
        requestId,
        toolName: "Edit",
        description: `QA approval for ${request.jobId}`,
      });
      appendLog(this.fakeLog, { event: "approval_result", jobId: request.jobId, runId: request.runId, requestId, approved });
      if (!approved) {
        return {
          modelSucceeded: false,
          sessionId,
          modelReported: request.model,
          text: "",
          error: "QA_APPROVAL denied",
          usage: emptyUsage,
        };
      }
    }

    if (request.prompt.includes("QA_STALE_APPROVAL")) {
      const stale = this.callbacks.get(request.jobId)?.[0];
      if (stale) {
        const approved = await stale({
          requestId: `QA-STALE-${request.jobId}`,
          toolName: "Edit",
          description: "stale approval from an older run",
        });
        appendLog(this.fakeLog, { event: "stale_approval_result", jobId: request.jobId, runId: request.runId, approved });
      }
    }

    if (request.prompt.includes("QA_WRITE")) {
      try {
        writeFileSync(join(request.cwd, `qa-output-${request.jobId}.txt`), `${request.jobId} ${request.runId}\n`);
        appendLog(this.fakeLog, { event: "file_written", jobId: request.jobId, runId: request.runId, cwd: request.cwd });
      } catch (error) {
        return {
          modelSucceeded: false,
          sessionId,
          modelReported: request.model,
          text: "",
          error: `QA_WRITE failed: ${error instanceof Error ? error.message : String(error)}`,
          usage: emptyUsage,
        };
      }
    }

    if (request.prompt.includes("QA_HANG")) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, this.abortDelayMs));
      appendLog(this.fakeLog, { event: "run_end", runId: request.runId, outcome: "aborted" });
      return {
        modelSucceeded: false,
        sessionId,
        modelReported: request.model,
        text: "",
        error: "aborted",
        usage: emptyUsage,
      };
    }

    const slow = /QA_SLOW:(\d+)/.exec(request.prompt);
    if (slow) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Number(slow[1]));
        request.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (request.signal.aborted) {
        appendLog(this.fakeLog, { event: "run_end", runId: request.runId, outcome: "aborted" });
        return {
          modelSucceeded: false,
          sessionId,
          modelReported: request.model,
          text: "",
          error: "aborted",
          usage: emptyUsage,
        };
      }
    }

    const text = `QA_OK ${request.jobId}`;
    onEvent({ type: "text", text });
    appendLog(this.fakeLog, { event: "run_end", runId: request.runId, outcome: "succeeded", sessionId });
    return {
      modelSucceeded: true,
      sessionId,
      modelReported: request.model,
      text,
      error: null,
      usage: emptyUsage,
    };
  }
}

async function main(): Promise<void> {
  const fixtureRoot = required("CDT_QA_FIXTURE_ROOT");
  const worktreeRoot = required("CDT_QA_WORKTREE_ROOT");
  const statePath = required("CDT_QA_STATE_DB");
  const fakeLog = required("CDT_QA_FAKE_LOG");
  mkdirSync(join(worktreeRoot, ".."), { recursive: true, mode: 0o700 });
  const maxConcurrent = Number.parseInt(process.env["CDT_QA_MAX_CONCURRENT"] ?? "2", 10);
  const maxQueued = Number.parseInt(process.env["CDT_QA_MAX_QUEUED"] ?? "8", 10);
  const abortDelayMs = Number.parseInt(process.env["CDT_QA_ABORT_DELAY_MS"] ?? "100", 10);

  const store = new SqliteStateStore({ path: statePath });
  if (process.env["CDT_QA_TRIGGER_FAIL_EVENTS"] === "1") {
    const db = new DatabaseSync(statePath);
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS qa_fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'QA_TRIGGER_FAILURE'); END;",
    );
    db.close();
    log("qa.trigger.installed");
  }

  const workspace = new GitWorkspaceService({ allowedRoots: [fixtureRoot], worktreeRoot });
  const runner = new FakeRunner(fakeLog, abortDelayMs);
  let scheduler: Scheduler;
  try {
    scheduler = new Scheduler({
      runner,
      workspace,
      store,
      maxConcurrent,
      maxQueued,
    });
  } catch (error) {
    log("qa.launcher.ownership_or_startup_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      store.close();
    } catch {
      /* ignore */
    }
    process.exit(3);
  }

  const server = createServer({
    scheduler,
    schedulerInfo: { available: true, maxConcurrent, maxQueued },
    gate: (request) => runGate(request),
  });

  const handle = serveStdio(() => server, {
    legacy: "serve",
    onerror: (error) => log("qa.transport.error", { message: error.message }),
  });
  log("qa.launcher.started", {
    pid: process.pid,
    maxConcurrent,
    maxQueued,
    fixtureRoot,
    worktreeRoot,
    statePath,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log("qa.launcher.shutdown", { signal });
    try {
      await handle.close();
    } finally {
      try {
        await scheduler.close();
      } finally {
        store.close();
        process.exit(0);
      }
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log("qa.launcher.fatal", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
