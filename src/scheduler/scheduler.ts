import { emptyProgress, recordProgress } from "./progress.js";
/**
 * Checkpoint scheduler: admission, FIFO queue, runner event projection, terminal states,
 * crash fail-stop recovery and graceful close.
 *
 * Implemented contract methods: spawn/spawnBatch/status/sessions/abort/close.
 * The remaining SchedulerService methods throw NOT_IMPLEMENTED until the next increment.
 */

import { randomUUID } from "node:crypto";
import { JOB_STATES, type JobState } from "../contracts.js";
import type {
  AgentRunner,
  ApprovalRequest,
  JobSnapshot,
  PreparedTask,
  Priority,
  RunnerRequest,
  RunnerResult,
  SchedulerService,
  StateStore,
  SteerReceipt,
  TaskInput,
  Usage,
  WaitResult,
  WorkspaceService,
} from "../task-contracts.js";
import { SchedulerError, describeError } from "./errors.js";
import {
  compactText,
  createJob,
  emptyUsage,
  isTerminalState,
  nextActionFor,
  recoverSnapshot,
  toSnapshot,
  truncate,
  type InternalJob,
  type PendingApproval,
  ERROR_MAX,
  EVENT_TEXT_MAX,
  TEXT_PREVIEW_MAX,
  APPROVAL_DESCRIPTION_MAX,
} from "./job.js";
import {
  assertPreparedMatchesRequest,
  assertPreparedTask,
  assertPromptText,
  assertStoredSnapshot,
  assertTaskInput,
  normalizeSchedulerOptions,
  type NormalizedSchedulerOptions,
} from "./validation.js";
import { WaitHub } from "./waits.js";

export interface SchedulerOptions {
  runner: AgentRunner;
  workspace: WorkspaceService;
  store: StateStore;
  maxConcurrent?: number;
  maxQueued?: number;
  approvalTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  closeGraceMs?: number;
  idPrefix?: string;
}

const RECOVERY_REASON = "recovered after scheduler restart; previous run outcome is unknown";

function assertDependencies(options: SchedulerOptions): void {
  const { runner, workspace, store } = options;
  if (!runner || typeof runner.run !== "function" || typeof runner.steer !== "function") {
    throw new SchedulerError("INVALID_OPTIONS", "options.runner must implement run/steer");
  }
  if (!workspace || typeof workspace.validateBatch !== "function" || typeof workspace.prepareBatch !== "function") {
    throw new SchedulerError("INVALID_OPTIONS", "options.workspace must implement validateBatch/prepareBatch");
  }
  if (
    !store ||
    typeof store.acquireOwner !== "function" ||
    typeof store.load !== "function" ||
    typeof store.save !== "function" ||
    typeof store.appendEvent !== "function" ||
    typeof store.close !== "function"
  ) {
    throw new SchedulerError("INVALID_OPTIONS", "options.store must implement acquireOwner/load/save/appendEvent/close");
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUsage(value: unknown): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyUsage();
  const record = value as Record<string, unknown>;
  const numberOrNull = (entry: unknown): number | null =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? entry : null;
  return {
    inputTokens: numberOrNull(record["inputTokens"]),
    outputTokens: numberOrNull(record["outputTokens"]),
    cacheReadTokens: numberOrNull(record["cacheReadTokens"]),
    sdkCostEstimateUsd: numberOrNull(record["sdkCostEstimateUsd"]),
    providerBilledCostUsd: numberOrNull(record["providerBilledCostUsd"]),
  };
}

function normalizeApprovalRequest(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"].trim() : "";
  const toolName = typeof record["toolName"] === "string" ? record["toolName"].trim() : "";
  if (requestId.length === 0 || requestId.length > 256 || toolName.length === 0) return null;
  const description = typeof record["description"] === "string" ? truncate(record["description"], APPROVAL_DESCRIPTION_MAX) : "";
  return { requestId, toolName: truncate(toolName, 120), description };
}

function normalizeRunnerResult(value: unknown): RunnerResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["modelSucceeded"] !== "boolean") return null;
  return {
    modelSucceeded: record["modelSucceeded"],
    sessionId: typeof record["sessionId"] === "string" && record["sessionId"].length > 0 ? record["sessionId"] : null,
    modelReported:
      typeof record["modelReported"] === "string" && record["modelReported"].length > 0 ? record["modelReported"] : null,
    text: typeof record["text"] === "string" ? record["text"] : "",
    error:
      typeof record["error"] === "string" && record["error"].length > 0 ? truncate(record["error"], ERROR_MAX) : null,
    usage: normalizeUsage(record["usage"]),
  };
}

export class Scheduler implements SchedulerService {
  private readonly options: NormalizedSchedulerOptions;
  private readonly runner: AgentRunner;
  private readonly workspace: WorkspaceService;
  private readonly store: StateStore;
  private readonly waiterHub: WaitHub;
  private readonly jobs = new Map<string, InternalJob>();
  private executing = 0;
  private nextSeq = 1;
  private jobCounter = 1;
  private pumpScheduled = false;
  private admission: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  private storageOpen = true;
  private fatalError: Error | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: SchedulerOptions) {
    if (!options || typeof options !== "object") throw new SchedulerError("INVALID_OPTIONS", "scheduler options are required");
    assertDependencies(options);
    this.options = normalizeSchedulerOptions(options);
    this.runner = options.runner;
    this.workspace = options.workspace;
    this.store = options.store;
    this.waiterHub = new WaitHub((jobId) => {
      const job = this.jobs.get(jobId);
      return job ? { revision: job.revision, nextAction: nextActionFor(job.state, job.approvals.size) } : null;
    }, this.options.maxWaitTimeoutMs);

    let acquired = false;
    try {
      try {
        this.store.acquireOwner();
      } catch (error) {
        throw new SchedulerError("OWNERSHIP_CONFLICT", `unable to acquire state store ownership: ${describeError(error)}`, {
          cause: error,
        });
      }
      acquired = true;
      let loaded: JobSnapshot[];
      try {
        loaded = this.store.load();
      } catch (error) {
        throw new SchedulerError("STORE_LOAD_FAILED", `unable to load scheduler state: ${describeError(error)}`, {
          cause: error,
        });
      }
      this.installLoadedJobs(loaded);
    } catch (error) {
      if (acquired) {
        this.storageOpen = false;
        try {
          this.store.close();
        } catch {
          // Preserve the constructor error.
        }
      }
      throw error;
    }
  }

  async spawn(task: TaskInput): Promise<JobSnapshot> {
    const [snapshot] = await this.admit([task], "spawn");
    if (!snapshot) throw new SchedulerError("PERSISTENCE_FAILED", "spawn did not register a job");
    return snapshot;
  }

  async spawnBatch(tasks: TaskInput[]): Promise<JobSnapshot[]> {
    return this.admit(tasks, "spawnBatch");
  }

  status(jobId: string): JobSnapshot {
    const job = this.requireJob(jobId);
    return toSnapshot(job, this.now());
  }

  sessions(options?: { cwd?: string; state?: JobState; offset?: number; limit?: number }): JobSnapshot[] {
    const cwd = options?.cwd;
    const state = options?.state;
    const offset = options?.offset ?? 0;
    const limit = options?.limit;
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
      throw new SchedulerError("INVALID_ARGUMENT", "sessions cwd must be a non-empty string");
    }
    if (state !== undefined && !(JOB_STATES as readonly string[]).includes(state)) {
      throw new SchedulerError("INVALID_ARGUMENT", `unknown job state filter: ${String(state)}`);
    }
    if (!Number.isInteger(offset) || offset < 0) throw new SchedulerError("INVALID_ARGUMENT", "offset must be an integer >= 0");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new SchedulerError("INVALID_ARGUMENT", "limit must be an integer >= 0");
    }

    const ordered = [...this.jobs.values()].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0;
    });
    const filtered = ordered.filter((job) => {
      if (cwd !== undefined && job.task.cwd !== cwd && job.task.sourceCwd !== cwd) return false;
      if (state !== undefined && job.state !== state) return false;
      return true;
    });
    const page = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
    return page.map((job) => toSnapshot(job, this.now()));
  }

  async abort(jobId: string): Promise<JobSnapshot> {
    this.assertOperational();
    const job = this.requireJob(jobId);
    if (isTerminalState(job.state)) return toSnapshot(job, this.now());

    const previousState = job.state;
    if (job.state === "queued") {
      this.drainApprovals(job, false, "aborted before start");
      job.state = "cancelled";
      job.finishedAt = this.now();
      job.lastError = "aborted before execution started";
      const snapshot = this.commit(job, { kind: "aborted", previousState });
      return snapshot;
    }

    this.drainApprovals(job, false, "run aborted");
    this.clearDeadline(job);
    this.abortRun(job, "run aborted by operator");
    job.state = "cancelled";
    job.finishedAt = this.now();
    job.lastError = "aborted by operator";
    // Slot is released only when runner.run's promise settles (hard maxConcurrent).
    return this.commit(job, { kind: "aborted", previousState });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const promise = this.withAdmission(async () => this.performClose()).finally(() => {
      this.closed = true;
    });
    this.closePromise = promise;
    return promise;
  }

  // ---- Wait / follow-up / steer / fork / approvals -------------------------------

  async wait(
    jobIds: string[],
    options: { afterRevision?: number | Record<string, number>; timeoutMs?: number } = {},
  ): Promise<WaitResult> {
    this.assertOperational();
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      throw new SchedulerError("INVALID_ARGUMENT", "wait requires at least one jobId");
    }
    if (new Set(jobIds).size !== jobIds.length) throw new SchedulerError("INVALID_ARGUMENT", "wait jobIds must be unique");
    const jobs = jobIds.map((jobId) => this.requireJob(jobId));

    const requestedTimeout = options.timeoutMs ?? this.options.maxWaitTimeoutMs;
    if (!Number.isInteger(requestedTimeout) || requestedTimeout < 0) {
      throw new SchedulerError("INVALID_ARGUMENT", "timeoutMs must be an integer >= 0");
    }
    const timeoutMs = Math.min(requestedTimeout, this.options.maxWaitTimeoutMs);

    const gate = new Map<string, number>();
    let immediate = false;
    const afterRevision = options.afterRevision;
    if (afterRevision === undefined) {
      for (const job of jobs) {
        gate.set(job.jobId, job.revision);
        if (nextActionFor(job.state, job.approvals.size) !== "wait") immediate = true;
      }
    } else if (typeof afterRevision === "number") {
      if (!Number.isInteger(afterRevision) || afterRevision < 0) {
        throw new SchedulerError("INVALID_ARGUMENT", "afterRevision must be an integer >= 0");
      }
      for (const job of jobs) {
        gate.set(job.jobId, afterRevision);
        if (job.revision > afterRevision) immediate = true;
      }
    } else if (afterRevision !== null && typeof afterRevision === "object" && !Array.isArray(afterRevision)) {
      for (const [key, value] of Object.entries(afterRevision)) {
        if (!Number.isInteger(value) || value < 0) {
          throw new SchedulerError("INVALID_ARGUMENT", `afterRevision[${key}] must be an integer >= 0`);
        }
      }
      for (const job of jobs) {
        const baseline = (afterRevision as Record<string, number>)[job.jobId] ?? 0;
        gate.set(job.jobId, baseline);
        if (job.revision > baseline) immediate = true;
      }
    } else {
      throw new SchedulerError("INVALID_ARGUMENT", "afterRevision must be a number or a per-job record");
    }

    const outcome = await this.waiterHub.wait(jobIds, gate, immediate, timeoutMs);
    return this.buildWaitResult(jobs, outcome.timedOut);
  }

  async followUp(jobId: string, prompt: string, budget?: { maxTurns?: number; deadlineMs?: number }): Promise<JobSnapshot> {
    this.assertOperational();
    assertPromptText(prompt, "follow-up prompt");
    return this.withAdmission(async () => {
      this.assertOperational();
      const job = this.requireJob(jobId);
      if (!isTerminalState(job.state)) {
        throw new SchedulerError("JOB_NOT_IDLE", `job ${jobId} is ${job.state}; follow-up requires a terminal run`);
      }
      // Terminal state alone is not enough: after abort/deadline/fail-stop the job stays
      // terminal while the old runner promise is still unresolved and still holds its slot
      // (hard maxConcurrent). Enqueuing a resumption now would leak the executing counter
      // and could run two attempts against the same session concurrently.
      if (job.holdingSlot) {
        throw new SchedulerError(
          "JOB_NOT_IDLE",
          `job ${jobId} is ${job.state} but its runner has not settled yet; retry once the run's slot is released`,
        );
      }
      if (!job.sessionId) throw new SchedulerError("SESSION_UNAVAILABLE", `job ${jobId} has no session to resume`);
      if (this.availableCapacity() < 1) throw new SchedulerError("CAPACITY_EXCEEDED", "no queue capacity for follow-up");

      const nextTask = { ...job.task,
        ...(budget?.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
        ...(budget?.deadlineMs !== undefined ? { deadlineMs: budget.deadlineMs } : {}),
      };
      assertTaskInput(nextTask, 0);
      // Renew budgets only; model, permissions, cwd and conversation remain fixed.
      job.task = nextTask;

      job.attempt += 1;
      job.runId = this.newRunId(job.jobId, job.attempt);
      job.state = "queued";
      job.seq = this.nextSeq++;
      job.runPrompt = prompt;
      job.resumeSessionId = job.sessionId;
      job.forkSession = false;
      job.startedAt = null;
      job.finishedAt = null;
      job.durationMs = 0;
      job.modelReported = null;
      job.modelSucceeded = null;
      job.gatePassed = null;
      job.toolCallCount = 0;
      job.progress = emptyProgress();
      job.reportPath = undefined;
      job.latestTextPreview = "";
      job.lastError = null;
      job.usage = emptyUsage();
      // holdingSlot stays exactly as the settlement path left it: false here, because an
      // occupied slot was rejected above. Never clear it manually or executing leaks.
      this.drainApprovals(job, false, "follow-up reset");
      const snapshot = this.commit(job, {
        kind: "follow_up_enqueued",
        attempt: job.attempt,
        resumeSessionId: job.sessionId,
      });
      this.requestPump();
      return snapshot;
    });
  }

  async steer(jobId: string, message: string, priority: Priority = "next"): Promise<SteerReceipt> {
    this.assertOperational();
    const job = this.requireJob(jobId);
    assertPromptText(message, "steer message");
    if (priority !== "next" && priority !== "later" && priority !== "now") {
      throw new SchedulerError("INVALID_ARGUMENT", `unsupported steer priority: ${String(priority)}`);
    }
    const executing =
      (job.state === "starting" || job.state === "running" || job.state === "needs_attention") &&
      job.abort !== null &&
      !job.abort.signal.aborted;
    if (!executing) {
      return { messageId: randomUUID(), disposition: "unsupported" };
    }
    try {
      const receipt = await this.runner.steer(job.runId, message, priority);
      if (
        !receipt ||
        typeof receipt.messageId !== "string" ||
        receipt.messageId.length === 0 ||
        (receipt.disposition !== "queued" && receipt.disposition !== "delivered" && receipt.disposition !== "unsupported")
      ) {
        throw new Error("runner returned a malformed steer receipt");
      }
      if (job.progress.lastSteer?.messageId !== receipt.messageId || job.progress.lastSteer.disposition !== "delivered") {
        job.progress.lastSteer = { messageId: receipt.messageId, disposition: receipt.disposition, at: new Date(this.now()).toISOString() };
      }
      this.commit(job, { kind: "steer_receipt", messageId: receipt.messageId, disposition: receipt.disposition });
      return { messageId: receipt.messageId, disposition: receipt.disposition };
    } catch (error) {
      throw new SchedulerError("STEER_FAILED", `steer failed for ${jobId}: ${describeError(error)}`, { cause: error });
    }
  }

  async fork(jobId: string, prompt: string): Promise<JobSnapshot> {
    this.assertOperational();
    assertPromptText(prompt, "fork prompt");
    return this.withAdmission(async () => {
      this.assertOperational();
      const source = this.requireJob(jobId);
      if (!isTerminalState(source.state)) {
        throw new SchedulerError("JOB_NOT_IDLE", `job ${jobId} is ${source.state}; fork requires a terminal run`);
      }
      // Same invariant as followUp: a terminal-but-unsettled runner still owns the session;
      // forking now would run two attempts against one session concurrently.
      if (source.holdingSlot) {
        throw new SchedulerError(
          "JOB_NOT_IDLE",
          `job ${jobId} is ${source.state} but its runner has not settled yet; retry once the run's slot is released`,
        );
      }
      if (!source.sessionId) throw new SchedulerError("SESSION_UNAVAILABLE", `job ${jobId} has no session to fork`);
      if (this.availableCapacity() < 1) throw new SchedulerError("CAPACITY_EXCEEDED", "no queue capacity for fork");

      const input: TaskInput = {
        cwd: source.task.sourceCwd,
        prompt,
        model: source.task.model,
        effort: source.task.effort ?? "high",
        profile: source.task.profile,
        maxTurns: source.task.maxTurns,
        deadlineMs: source.task.deadlineMs,
        allowedPaths: [...source.task.allowedPaths],
        allowedSkillNames: [...source.task.allowedSkillNames],
        enabledMcpServers: [...source.task.enabledMcpServers],
      };

      let prepared: PreparedTask;
      try {
        await this.workspace.validateBatch([input]);
        const batch = this.workspace.prepareFork
          ? [await this.workspace.prepareFork(source.task, input)]
          : await this.workspace.prepareBatch([input]);
        if (!Array.isArray(batch) || batch.length !== 1) throw new Error("workspace returned an unexpected fork batch");
        prepared = batch[0]!;
      } catch (error) {
        throw new SchedulerError("WORKSPACE_INVALID", `fork workspace preparation failed: ${describeError(error)}`, {
          cause: error,
        });
      }
      assertPreparedTask(prepared, "fork prepared");
      assertPreparedMatchesRequest(prepared, input, "fork prepared");
      if (source.task.managedWorktree) {
        if (!prepared.managedWorktree) {
          throw new SchedulerError("WORKSPACE_INVALID", "fork requires a managed worktree for a managed source task");
        }
        if (prepared.cwd === source.task.cwd) {
          throw new SchedulerError("WORKSPACE_INVALID", "fork requires an independent workspace path");
        }
      }
      this.assertOperational();

      const newJobId = this.allocateJobId();
      const job = createJob({
        jobId: newJobId,
        runId: this.newRunId(newJobId, 1),
        attempt: 1,
        task: prepared,
        seq: this.nextSeq++,
        nowMs: this.now(),
        runPrompt: prompt,
        resumeSessionId: source.sessionId,
        forkSession: true,
      });
      this.jobs.set(newJobId, job);
      try {
        const snapshot = this.commit(job, { kind: "fork_enqueued", sourceJobId: source.jobId });
        this.requestPump();
        return snapshot;
      } catch (error) {
        this.jobs.delete(newJobId);
        throw error;
      }
    });
  }

  async answer(jobId: string, requestId: string, decision: boolean): Promise<{ acknowledged: boolean }> {
    this.assertOperational();
    const job = this.requireJob(jobId);
    if (typeof decision !== "boolean") throw new SchedulerError("INVALID_ARGUMENT", "decision must be a boolean");
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new SchedulerError("INVALID_ARGUMENT", "requestId must be a non-empty string");
    }
    const pending = job.approvals.get(requestId);
    if (!pending || pending.settled || pending.runId !== job.runId || isTerminalState(job.state)) {
      return { acknowledged: false };
    }
    this.clearApprovalTimer(pending);
    pending.settled = true;
    job.approvals.delete(requestId);
    if (job.state === "needs_attention" && job.approvals.size === 0) job.state = "running";
    try {
      this.commit(job, { kind: "approval_answered", requestId, decision });
    } catch (error) {
      pending.resolve(false);
      throw error;
    }
    pending.resolve(decision);
    return { acknowledged: true };
  }

  private buildWaitResult(jobs: InternalJob[], timedOut: boolean): WaitResult {
    const snapshots = jobs.map((job) => toSnapshot(job, this.now()));
    const anyAnswer = jobs.some((job) => nextActionFor(job.state, job.approvals.size) === "answer");
    const anyActive = jobs.some((job) => nextActionFor(job.state, job.approvals.size) !== "finish");
    const nextAction: WaitResult["nextAction"] = anyAnswer ? "answer" : anyActive ? "wait" : "finish";
    const continueIds = jobs
      .filter((job) => nextActionFor(job.state, job.approvals.size) !== "finish")
      .map((job) => job.jobId);
    return { jobs: snapshots, continueIds, nextAction, timedOut };
  }

  // ---- Admission / queue ----------------------------------------------------------------

  private withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.admission.then(() => operation());
    this.admission = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async admit(tasks: TaskInput[], operation: "spawn" | "spawnBatch"): Promise<JobSnapshot[]> {
    this.assertOperational();
    return this.withAdmission(async () => {
      this.assertOperational();
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new SchedulerError("INVALID_TASK", `${operation} requires at least one task`);
      }
      for (let index = 0; index < tasks.length; index += 1) assertTaskInput(tasks[index]!, index);
      if (this.availableCapacity() < tasks.length) {
        throw new SchedulerError(
          "CAPACITY_EXCEEDED",
          `${operation} needs ${tasks.length} slot(s) but only ${this.availableCapacity()} are available`,
        );
      }

      let prepared: PreparedTask[];
      try {
        await this.workspace.validateBatch(tasks);
        prepared = await this.workspace.prepareBatch(tasks);
      } catch (error) {
        throw new SchedulerError("WORKSPACE_INVALID", `${operation} workspace validation/prepare failed: ${describeError(error)}`, {
          cause: error,
        });
      }
      if (!Array.isArray(prepared) || prepared.length !== tasks.length) {
        throw new SchedulerError("WORKSPACE_INVALID", `${operation} workspace returned an unexpected prepared batch`);
      }
      for (let index = 0; index < prepared.length; index += 1) {
        assertPreparedTask(prepared[index], `prepared[${index}]`);
        assertPreparedMatchesRequest(prepared[index]!, tasks[index]!, `prepared[${index}]`);
      }
      this.assertOperational();

      const created: InternalJob[] = [];
      const snapshots: JobSnapshot[] = [];
      try {
        for (let index = 0; index < prepared.length; index += 1) {
          const task = prepared[index]!;
          const jobId = this.allocateJobId();
          const job = createJob({
            jobId,
            runId: this.newRunId(jobId, 1),
            attempt: 1,
            task,
            seq: this.nextSeq++,
            nowMs: this.now(),
            runPrompt: task.prompt,
          });
          this.jobs.set(jobId, job);
          created.push(job);
          snapshots.push(this.commit(job, { kind: "job_enqueued", operation, model: task.model, profile: task.profile }));
        }
      } catch (error) {
        for (const job of created) this.jobs.delete(job.jobId);
        throw error;
      }
      this.requestPump();
      return snapshots;
    });
  }

  private availableCapacity(): number {
    let holding = 0;
    let queued = 0;
    for (const job of this.jobs.values()) {
      if (job.holdingSlot) holding += 1;
      if (job.state === "queued") queued += 1;
    }
    return Math.max(0, this.options.maxConcurrent - holding) + Math.max(0, this.options.maxQueued - queued);
  }

  private requestPump(): void {
    if (this.pumpScheduled || this.closing || this.fatalError || !this.storageOpen) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closing || this.fatalError || !this.storageOpen) return;
    while (this.executing < this.options.maxConcurrent) {
      const job = this.nextQueuedJob();
      if (!job) return;
      this.startJob(job);
      if (this.fatalError) return;
    }
  }

  private nextQueuedJob(): InternalJob | null {
    let best: InternalJob | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== "queued") continue;
      if (!best || job.seq < best.seq) best = job;
    }
    return best;
  }

  // ---- Run lifecycle --------------------------------------------------------------------

  private startJob(job: InternalJob): void {
    if (job.state !== "queued") return;
    job.state = "starting";
    job.startedAt = this.now();
    job.finishedAt = null;
    job.holdingSlot = true;
    this.executing += 1;
    const controller = new AbortController();
    job.abort = controller;

    try {
      this.commit(job, {
        kind: "run_starting",
        runId: job.runId,
        attempt: job.attempt,
        model: job.task.model,
        resume: job.resumeSessionId !== null,
        fork: job.forkSession,
      });
    } catch {
      this.releaseSlot(job);
      return;
    }

    const runId = job.runId;
    if (job.deadlineTimer === null) {
      const timer = setTimeout(() => this.onDeadline(job, runId), job.task.deadlineMs);
      (timer as { unref?: () => void }).unref?.();
      job.deadlineTimer = timer;
    }

    const request: RunnerRequest = {
      cwd: job.task.cwd,
      sourceCwd: job.task.sourceCwd,
      model: job.task.model,
      profile: job.task.profile,
      prompt: job.runPrompt,
      effort: job.task.effort ?? "high",
      maxTurns: job.task.maxTurns,
      deadlineMs: job.task.deadlineMs,
      allowedPaths: [...job.task.allowedPaths],
      allowedSkillNames: [...job.task.allowedSkillNames],
      enabledMcpServers: [...job.task.enabledMcpServers],
      managedWorktree: job.task.managedWorktree,
      branch: job.task.branch,
      jobId: job.jobId,
      runId: job.runId,
      signal: controller.signal,
      requestApproval: (request: ApprovalRequest) => this.requestApproval(job, runId, request),
      ...(job.resumeSessionId !== null ? { resumeSessionId: job.resumeSessionId } : {}),
      ...(job.forkSession ? { forkSession: true } : {}),
    };

    try {
      const returned = this.runner.run(request, (event) => this.onWorkerEvent(job, runId, event));
      if (job.state === "starting") {
        job.state = "running";
        this.commitFromEvent(job, { kind: "run_running" });
      }
      job.runPromise = Promise.resolve(returned).then(
        (result) => this.guardRunHandler(job, () => this.onRunSettled(job, runId, result)),
        (error) => this.guardRunHandler(job, () => this.onRunRejected(job, runId, error)),
      );
    } catch (error) {
      job.runPromise = Promise.resolve();
      this.guardRunHandler(job, () => this.onRunRejected(job, runId, error));
    }
  }

  private onWorkerEvent(job: InternalJob, runId: string, event: import("../task-contracts.js").WorkerEvent): void {
    if (job.runId !== runId || this.closed || !this.storageOpen) return;
    if (!event || typeof event !== "object") return;
    if (isTerminalState(job.state)) return;

    recordProgress(job.progress, event, new Date(this.now()).toISOString());
    if (event.type === "init") {
      let changed = false;
      if (typeof event.sessionId === "string" && event.sessionId.length > 0 && job.sessionId !== event.sessionId) {
        job.sessionId = event.sessionId;
        changed = true;
      }
      if (typeof event.model === "string" && event.model.length > 0 && job.modelReported !== event.model) {
        job.modelReported = event.model;
        changed = true;
      }
      if (job.state === "starting") {
        job.state = "running";
        changed = true;
      }
      if (changed) this.commitFromEvent(job, { kind: "worker_init", sessionId: job.sessionId, model: job.modelReported });
      return;
    }

    if (job.state === "starting") job.state = "running";
    switch (event.type) {
      case "turn": {
        this.commitFromEvent(job, { kind: "turn", turns: job.progress.turns });
        break;
      }
      case "text": {
        if (typeof event.text === "string" && event.text.trim().length > 0) {
          job.latestTextPreview = compactText(event.text, TEXT_PREVIEW_MAX);
          this.commitFromEvent(job, { kind: "worker_text", preview: job.latestTextPreview });
        }
        break;
      }
      case "tool_start": {
        job.toolCallCount += 1;
        this.commitFromEvent(job, { kind: "tool_start", toolName: truncate(String(event.toolName ?? ""), 120), count: job.toolCallCount });
        break;
      }
      case "tool_end": {
        this.commitFromEvent(job, { kind: "tool_end", toolName: truncate(String(event.toolName ?? ""), 120) });
        break;
      }
      case "steer_ack": {
        this.commitFromEvent(job, { kind: "steer_ack", messageId: truncate(String(event.messageId ?? ""), 120) });
        break;
      }
      case "notice": {
        this.commitFromEvent(job, { kind: "worker_notice", text: truncate(String(event.text ?? ""), EVENT_TEXT_MAX) });
        break;
      }
      default:
        break;
    }
  }

  private onRunSettled(job: InternalJob, runId: string, rawResult: unknown): void {
    if (job.runId !== runId) return;
    const result = normalizeRunnerResult(rawResult);

    if (this.fatalError || this.closing || !this.storageOpen || isTerminalState(job.state)) {
      if (result?.sessionId && !job.sessionId) job.sessionId = result.sessionId;
      this.finalizeRun(job);
      return;
    }

    job.finishedAt = this.now();
    if (!result) {
      job.state = "failed";
      job.modelSucceeded = false;
      job.lastError = "runner returned a malformed result";
      this.commitFromEvent(job, { kind: "run_finished", state: job.state });
      this.finalizeRun(job);
      return;
    }

    job.progress.answerState = result.text.trim() ? "present" : "missing";
    job.progress.phase = "settled";
    if (result.modelSucceeded && !result.text.trim()) job.progress.warnings.push("model_returned_empty_answer");
    if (result.modelSucceeded && job.task.profile !== "read" && job.progress.editWriteCount === 0) job.progress.warnings.push("no_file_tool_write_receipt_check_workspace_and_bash_outputs");
    job.reportPath = typeof (rawResult as {reportPath?: unknown}).reportPath === "string" ? (rawResult as {reportPath:string}).reportPath : undefined;
    job.modelSucceeded = result.modelSucceeded;
    if (result.sessionId) job.sessionId = result.sessionId;
    if (result.modelReported) job.modelReported = result.modelReported;
    job.usage = result.usage;
    if (result.text.length > 0) job.latestTextPreview = compactText(result.text, TEXT_PREVIEW_MAX);
    job.state = result.modelSucceeded ? "succeeded" : "failed";
    job.lastError = result.error ? truncate(result.error, ERROR_MAX) : null;
    this.commitFromEvent(job, {
      kind: "run_finished",
      state: job.state,
      modelSucceeded: result.modelSucceeded,
      sessionId: job.sessionId,
    });
    this.finalizeRun(job);
  }

  private onRunRejected(job: InternalJob, runId: string, error: unknown): void {
    if (job.runId !== runId) return;
    if (this.fatalError || this.closing || !this.storageOpen || isTerminalState(job.state)) {
      this.finalizeRun(job);
      return;
    }
    job.state = "failed";
    job.modelSucceeded = false;
    job.finishedAt = this.now();
    job.lastError = truncate(`runner error: ${describeError(error)}`, ERROR_MAX);
    this.commitFromEvent(job, { kind: "run_error", error: job.lastError });
    this.finalizeRun(job);
  }

  private finalizeRun(job: InternalJob): void {
    this.drainApprovals(job, false, "run finalized");
    this.clearDeadline(job);
    job.abort = null;
    this.releaseSlot(job);
    this.requestPump();
  }

  private guardRunHandler(job: InternalJob, handler: () => void): void {
    try {
      handler();
    } catch (error) {
      this.failScheduler(new SchedulerError("FATAL", `internal scheduler failure: ${describeError(error)}`, { cause: error }), job);
      this.finalizeRun(job);
    }
  }

  private releaseSlot(job: InternalJob): void {
    if (!job.holdingSlot) return;
    job.holdingSlot = false;
    this.executing = Math.max(0, this.executing - 1);
  }

  private abortRun(job: InternalJob, reason: string): void {
    const controller = job.abort;
    if (!controller || controller.signal.aborted) return;
    try {
      controller.abort(new Error(reason));
    } catch {
      // Abort signals must never break scheduler cleanup.
    }
  }

  private clearDeadline(job: InternalJob): void {
    if (job.deadlineTimer !== null) {
      clearTimeout(job.deadlineTimer);
      job.deadlineTimer = null;
    }
  }

  // ---- Persistence ----------------------------------------------------------------------

  private writeSnapshot(job: InternalJob, event: Record<string, unknown>): JobSnapshot {
    if (!this.storageOpen) throw new SchedulerError("CLOSED", "state store is closed");
    job.revision += 1;
    const nowMs = this.now();
    job.updatedAt = new Date(nowMs).toISOString();
    const snapshot = toSnapshot(job, nowMs);
    if (typeof this.store.commit === "function") {
      this.store.commit(snapshot, event);
    } else {
      this.store.save(snapshot);
      this.store.appendEvent(job.jobId, snapshot.revision, event);
    }
    this.waiterHub.notify();
    return snapshot;
  }

  private commit(job: InternalJob, event: Record<string, unknown>): JobSnapshot {
    if (this.fatalError) {
      throw new SchedulerError("FATAL", `state persistence is unavailable: ${this.fatalError.message}`, {
        cause: this.fatalError,
      });
    }
    try {
      return this.writeSnapshot(job, event);
    } catch (error) {
      const failure =
        error instanceof SchedulerError && error.code === "PERSISTENCE_FAILED"
          ? error
          : new SchedulerError("PERSISTENCE_FAILED", `failed to persist ${job.jobId}: ${describeError(error)}`, {
              cause: error,
            });
      this.failScheduler(failure, job);
      throw failure;
    }
  }

  private commitFromEvent(job: InternalJob, event: Record<string, unknown>): void {
    try {
      this.commit(job, event);
    } catch {
      // commit() already fail-stopped the scheduler; event callbacks must not break the runner.
    }
  }

  /** Fail-stop: no durable truth means no claimed outcome. Abort owned runs and stop accepting work. */
  private failScheduler(error: Error, culprit: InternalJob): void {
    if (this.fatalError) return;
    this.fatalError = error;
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    for (const job of this.jobs.values()) {
      const isCulprit = job.jobId === culprit.jobId;
      if (isTerminalState(job.state) && !isCulprit) continue;
      const wasQueued = job.state === "queued";
      this.drainApprovals(job, false, "scheduler persistence failure");
      this.clearDeadline(job);
      this.abortRun(job, "scheduler persistence failure");
      if (wasQueued) {
        job.state = "cancelled";
        job.lastError = "cancelled after scheduler state persistence failure";
      } else {
        job.state = "unknown_outcome";
        job.modelSucceeded = null;
        job.gatePassed = null;
        job.lastError = truncate(`state persistence failed: ${error.message}`, ERROR_MAX);
      }
      job.finishedAt = now;
      job.revision += 1;
      job.updatedAt = nowIso;
    }
    this.waiterHub.close();
  }

  private installLoadedJobs(loaded: JobSnapshot[]): void {
    if (!Array.isArray(loaded)) throw new SchedulerError("CORRUPT_STORE", "state store load() must return an array");
    const recoveries: { job: InternalJob; previousState: string }[] = [];
    for (let index = 0; index < loaded.length; index += 1) {
      const candidate = loaded[index];
      try {
        assertStoredSnapshot(candidate, `stored job #${index}`);
      } catch (error) {
        throw new SchedulerError("CORRUPT_STORE", `stored job #${index} is invalid: ${describeError(error)}`, { cause: error });
      }
      if (this.jobs.has(candidate.jobId)) throw new SchedulerError("CORRUPT_STORE", `duplicate stored jobId ${candidate.jobId}`);
      const job = recoverSnapshot(candidate, this.now(), RECOVERY_REASON);
      this.jobs.set(job.jobId, job);
      if (!isTerminalState(candidate.state) || candidate.approvals.length > 0) {
        recoveries.push({ job, previousState: candidate.state });
      }
    }

    const prefixPattern = new RegExp(`^${escapeRegExp(this.options.idPrefix)}-(\\d+)$`);
    let maxJobNumber = 0;
    for (const job of this.jobs.values()) {
      const match = prefixPattern.exec(job.jobId);
      if (match) maxJobNumber = Math.max(maxJobNumber, Number(match[1]));
    }
    this.jobCounter = maxJobNumber + 1;
    this.nextSeq = 1;

    for (const { job, previousState } of recoveries) {
      const event =
        previousState === job.state
          ? { kind: "recovered_approvals_discarded", previousState }
          : { kind: "recovered_unknown_outcome", previousState, reason: RECOVERY_REASON };
      try {
        this.writeSnapshot(job, event);
      } catch (error) {
        throw new SchedulerError("PERSISTENCE_FAILED", `failed to persist recovery for ${job.jobId}: ${describeError(error)}`, {
          cause: error,
        });
      }
    }
  }

  // ---- Close ---------------------------------------------------------------------------

  private async performClose(): Promise<void> {
    const errors: unknown[] = [];
    for (const job of this.jobs.values()) {
      if (isTerminalState(job.state)) continue;
      const wasQueued = job.state === "queued";
      this.drainApprovals(job, false, "scheduler closing");
      this.clearDeadline(job);
      this.abortRun(job, "scheduler closing");
      job.state = wasQueued ? "cancelled" : "interrupted";
      job.finishedAt = this.now();
      job.lastError = wasQueued
        ? "scheduler closed before execution started"
        : "scheduler closed while execution was active; partial writes are possible";
      try {
        this.commit(job, { kind: wasQueued ? "closed_before_start" : "closed_during_run" });
      } catch (error) {
        errors.push(error);
        if (this.fatalError) break;
      }
    }

    const pending = [...this.jobs.values()]
      .map((job) => job.runPromise)
      .filter((promise): promise is Promise<void> => promise !== null);
    if (pending.length > 0) {
      await this.waitBounded(Promise.allSettled(pending), this.options.closeGraceMs);
    }
    // Bounded cleanup: force-release only after waiting for real settlement.
    for (const job of this.jobs.values()) this.releaseSlot(job);

    this.waiterHub.close();
    this.storageOpen = false;
    try {
      this.store.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, `scheduler close failed to persist ${errors.length} update(s)`);
  }

  private async waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        promise.then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // ---- Approvals / deadline -------------------------------------------------------------

  private requestApproval(job: InternalJob, runId: string, raw: ApprovalRequest): Promise<boolean> {
    if (
      !this.storageOpen ||
      this.closing ||
      this.fatalError ||
      job.runId !== runId ||
      isTerminalState(job.state)
    ) {
      return Promise.resolve(false);
    }
    const request = normalizeApprovalRequest(raw);
    if (!request) return Promise.resolve(false);
    if (job.approvals.has(request.requestId)) return Promise.resolve(false);

    let resolveDecision!: (decision: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
    });
    const pending: PendingApproval = {
      jobId: job.jobId,
      runId,
      request,
      resolve: resolveDecision,
      timer: null,
      settled: false,
    };
    const timer = setTimeout(() => this.onApprovalTimeout(job, runId, request.requestId), this.options.approvalTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    pending.timer = timer;
    job.approvals.set(request.requestId, pending);
    job.state = "needs_attention";
    try {
      this.commit(job, {
        kind: "approval_requested",
        requestId: request.requestId,
        toolName: request.toolName,
        description: truncate(request.description, APPROVAL_DESCRIPTION_MAX),
      });
    } catch {
      this.settleApproval(job, request.requestId, false);
    }
    return decision;
  }

  private onApprovalTimeout(job: InternalJob, runId: string, requestId: string): void {
    if (job.runId !== runId || this.fatalError || !this.storageOpen) return;
    const pending = job.approvals.get(requestId);
    if (!pending || pending.settled) return;
    this.clearApprovalTimer(pending);
    pending.settled = true;
    job.approvals.delete(requestId);
    if (job.state === "needs_attention" && job.approvals.size === 0 && !isTerminalState(job.state)) {
      job.state = "running";
    }
    try {
      this.commit(job, { kind: "approval_timeout", requestId, decision: false });
    } catch {
      // failScheduler already aborted the run.
    }
    pending.resolve(false);
  }

  private settleApproval(job: InternalJob, requestId: string, decision: boolean): void {
    const pending = job.approvals.get(requestId);
    if (!pending) return;
    this.clearApprovalTimer(pending);
    job.approvals.delete(requestId);
    if (!pending.settled) {
      pending.settled = true;
      pending.resolve(decision);
    }
  }

  private drainApprovals(job: InternalJob, decision: boolean, _reason: string): number {
    let drained = 0;
    for (const [requestId, pending] of [...job.approvals.entries()]) {
      this.clearApprovalTimer(pending);
      job.approvals.delete(requestId);
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve(decision);
        drained += 1;
      }
    }
    return drained;
  }

  private clearApprovalTimer(pending: PendingApproval): void {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private onDeadline(job: InternalJob, runId: string): void {
    job.deadlineTimer = null;
    if (
      job.runId !== runId ||
      isTerminalState(job.state) ||
      this.fatalError ||
      this.closing ||
      !this.storageOpen
    ) {
      return;
    }
    const previousState = job.state;
    this.drainApprovals(job, false, "deadline exceeded");
    this.abortRun(job, `deadline of ${job.task.deadlineMs}ms exceeded`);
    job.state = "timed_out";
    job.finishedAt = this.now();
    job.lastError = truncate(`deadline of ${job.task.deadlineMs}ms exceeded`, ERROR_MAX);
    // Keep occupying maxConcurrent until the runner promise actually settles.
    this.commitFromEvent(job, { kind: "deadline_exceeded", deadlineMs: job.task.deadlineMs, previousState });
  }

  // ---- Identity / guards ----------------------------------------------------------------

  private allocateJobId(): string {
    const prefix = this.options.idPrefix;
    for (;;) {
      const jobId = `${prefix}-${String(this.jobCounter).padStart(5, "0")}`;
      this.jobCounter += 1;
      if (!this.jobs.has(jobId)) return jobId;
    }
  }

  private newRunId(jobId: string, attempt: number): string {
    return `${jobId}-run-${attempt}-${randomUUID().slice(0, 8)}`;
  }

  private requireJob(jobId: string): InternalJob {
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new SchedulerError("INVALID_ARGUMENT", "jobId must be a non-empty string");
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new SchedulerError("UNKNOWN_JOB", `unknown jobId: ${jobId}`);
    return job;
  }

  private assertOperational(): void {
    if (this.closed) throw new SchedulerError("CLOSED", "scheduler is closed");
    if (this.closing) throw new SchedulerError("CLOSED", "scheduler is closing");
    if (this.fatalError) {
      throw new SchedulerError("FATAL", `scheduler is in a failed state: ${this.fatalError.message}`, {
        cause: this.fatalError,
      });
    }
  }

  private now(): number {
    return Date.now();
  }
}
