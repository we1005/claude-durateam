/** Shared fakes for scheduler tests. No filesystem, network, credentials or model calls. */

import { randomUUID } from "node:crypto";
import type {
  AgentRunner,
  JobSnapshot,
  PreparedTask,
  Priority,
  RunnerRequest,
  RunnerResult,
  StateStore,
  SteerReceipt,
  TaskInput,
  WorkerEvent,
  WorkspaceService,
} from "../src/task-contracts.js";
import type { InternalJob } from "../src/scheduler/job.js";
import { emptyUsage } from "../src/scheduler/job.js";

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface RunHandle {
  readonly request: RunnerRequest;
  readonly events: WorkerEvent[];
  settled: boolean;
  emit(event: WorkerEvent): void;
  resolve(result?: Partial<RunnerResult>): void;
  reject(error: unknown): void;
}

export class FakeRunner implements AgentRunner {
  readonly runs: RunHandle[] = [];
  readonly steerCalls: { runId: string; message: string; priority: Priority }[] = [];
  readonly approvals: { runId: string; requestId: string; decision?: boolean }[] = [];
  autoRejectOnAbort = true;
  steerImpl: (runId: string, message: string, priority: Priority) => Promise<SteerReceipt> = async () => ({
    messageId: `msg-${randomUUID().slice(0, 8)}`,
    disposition: "queued",
  });

  run(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): Promise<RunnerResult> {
    const completion = deferred<RunnerResult>();
    const sessionId = randomUUID();
    const handle: RunHandle = {
      request,
      events: [],
      settled: false,
      emit: (event) => {
        handle.events.push(event);
        onEvent(event);
      },
      resolve: (partial = {}) => {
        if (handle.settled) return;
        handle.settled = true;
        completion.resolve({
          modelSucceeded: true,
          sessionId,
          modelReported: request.model,
          text: "done",
          error: null,
          usage: emptyUsage(),
          ...partial,
        });
      },
      reject: (error) => {
        if (handle.settled) return;
        handle.settled = true;
        completion.reject(error);
      },
    };
    this.runs.push(handle);
    if (this.autoRejectOnAbort) {
      request.signal.addEventListener(
        "abort",
        () => {
          if (!handle.settled) {
            handle.settled = true;
            const reason = request.signal.reason;
            completion.reject(reason instanceof Error ? reason : new Error("aborted"));
          }
        },
        { once: true },
      );
    }
    return completion.promise;
  }

  async steer(runId: string, message: string, priority: Priority): Promise<SteerReceipt> {
    this.steerCalls.push({ runId, message, priority });
    return this.steerImpl(runId, message, priority);
  }

  askApproval(runIndex: number, requestId: string, toolName = "Bash"): Promise<boolean> {
    const run = this.runs[runIndex]!;
    const promise = run.request.requestApproval({
      requestId,
      toolName,
      description: `approve ${toolName}`,
    });
    const record: { runId: string; requestId: string; decision?: boolean } = { runId: run.request.runId, requestId };
    this.approvals.push(record);
    void promise.then((decision) => {
      record.decision = decision;
    });
    return promise;
  }

  runRequest(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): RunHandle {
    const index = this.runs.length;
    void this.run(request, onEvent);
    return this.runs[index]!;
  }
}

export class FakeWorkspace implements WorkspaceService {
  readonly validateCalls: TaskInput[][] = [];
  readonly prepareCalls: TaskInput[][] = [];
  validateError: Error | null = null;
  prepareError: Error | null = null;
  validateHook: ((tasks: TaskInput[]) => void) | null = null;
  prepareHook: (() => void) | null = null;
  transformPrepared: ((prepared: PreparedTask, index: number) => PreparedTask) | null = null;
  private workspaceCounter = 0;

  async validateBatch(tasks: TaskInput[]): Promise<void> {
    this.validateCalls.push(tasks.map((task) => ({ ...task })));
    this.validateHook?.(tasks);
    if (this.validateError) throw this.validateError;
  }

  async prepareBatch(tasks: TaskInput[]): Promise<PreparedTask[]> {
    this.prepareCalls.push(tasks.map((task) => ({ ...task })));
    this.prepareHook?.();
    if (this.prepareError) throw this.prepareError;
    return tasks.map((task, index) => {
      const profile = task.profile ?? "read";
      const managed = profile !== "read";
      const cwd = managed ? `/fake/wt/${this.workspaceCounter++}` : task.cwd;
      const prepared: PreparedTask = {
        cwd,
        sourceCwd: task.cwd,
        model: task.model ?? "glm-5.3",
        effort: task.effort ?? "high",
        profile,
        prompt: task.prompt,
        maxTurns: task.maxTurns ?? 20,
        deadlineMs: task.deadlineMs ?? 600_000,
        allowedPaths: task.allowedPaths ?? [],
        allowedSkillNames: task.allowedSkillNames ?? [],
        enabledMcpServers: task.enabledMcpServers ?? [],
        managedWorktree: managed,
        branch: managed ? `agent/test/${this.workspaceCounter}` : null,
      };
      return this.transformPrepared ? this.transformPrepared(prepared, index) : prepared;
    });
  }
}

export class MemoryStore implements StateStore {
  readonly snapshots = new Map<string, JobSnapshot>();
  readonly events: { jobId: string; revision: number; event: unknown }[] = [];
  owner = false;
  closed = false;
  closeCalls = 0;
  acquireCalls = 0;
  saves = 0;
  appends = 0;
  failNextSave = false;
  failNextAppend = false;

  acquireOwner(): void {
    this.acquireCalls += 1;
    if (this.owner) throw new Error("store is already owned by another scheduler");
    this.owner = true;
  }

  load(): JobSnapshot[] {
    return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
  }

  save(snapshot: JobSnapshot): void {
    this.saves += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected save failure");
    }
    this.snapshots.set(snapshot.jobId, structuredClone(snapshot));
  }

  appendEvent(jobId: string, revision: number, event: unknown): void {
    this.appends += 1;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("injected appendEvent failure");
    }
    this.events.push({ jobId, revision, event });
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    this.owner = false;
  }
}

export class AtomicMemoryStore extends MemoryStore {
  commitCalls = 0;
  failNextCommit = false;

  override save(): void {
    throw new Error("legacy save() must not be used when commit() is available");
  }

  override appendEvent(): void {
    throw new Error("legacy appendEvent() must not be used when commit() is available");
  }

  commit(snapshot: JobSnapshot, event: unknown): void {
    this.commitCalls += 1;
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("injected transaction failure");
    }
    const copy = structuredClone(snapshot);
    this.snapshots.set(snapshot.jobId, copy);
    this.events.push({ jobId: snapshot.jobId, revision: snapshot.revision, event });
  }
}

export function baseTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    cwd: "/repo/main",
    prompt: "Do one bounded thing",
    model: "glm-5.3",
    profile: "read",
    maxTurns: 5,
    deadlineMs: 30_000,
    allowedPaths: [],
    allowedSkillNames: [],
    enabledMcpServers: [],
    ...overrides,
  };
}

export function seedSnapshot(overrides: Partial<JobSnapshot> & { jobId: string }): JobSnapshot {
  const task: PreparedTask = {
    cwd: "/repo/main",
    sourceCwd: "/repo/main",
    model: "glm-5.3",
    profile: "read",
    prompt: "seed prompt",
    maxTurns: 5,
    deadlineMs: 30_000,
    allowedPaths: [],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: false,
    branch: null,
  };
  const now = new Date().toISOString();
  return {
    jobId: overrides.jobId,
    runId: `${overrides.jobId}-run-seeded`,
    attempt: 1,
    sessionId: null,
    state: "succeeded",
    revision: 3,
    nextAction: "finish",
    task,
    modelRequested: "glm-5.3",
    modelReported: "glm-5.3",
    modelSucceeded: true,
    gatePassed: null,
    durationMs: 1000,
    toolCallCount: 1,
    latestTextPreview: "seeded",
    lastError: null,
    usage: emptyUsage(),
    approvals: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Wait for microtask pump + timer callbacks without depending on a model. */
export async function flush(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function schedulerJob(runner: FakeRunner, index: number): InternalJob {
  const handle = runner.runs[index];
  if (!handle) throw new Error(`runner run ${index} was not started`);
  return handle as unknown as InternalJob;
}
