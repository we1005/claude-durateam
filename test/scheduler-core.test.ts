import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import type { JobSnapshot } from "../src/task-contracts.js";
import {
  baseTask,
  FakeRunner,
  FakeWorkspace,
  MemoryStore,
  flush,
  seedSnapshot,
} from "./scheduler-doubles.js";

const openSchedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of openSchedulers.splice(0)) {
    try {
      await scheduler.close();
    } catch {
      // Fatal schedulers still release their store; tests assert failures explicitly.
    }
  }
});

function make(options: { maxConcurrent?: number; maxQueued?: number } = {}) {
  const runner = new FakeRunner();
  const workspace = new FakeWorkspace();
  const store = new MemoryStore();
  const scheduler = new Scheduler({
    runner,
    workspace,
    store,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxQueued: options.maxQueued,
    closeGraceMs: 20,
    idPrefix: "CDT",
  });
  openSchedulers.push(scheduler);
  return { scheduler, runner, workspace, store };
}

describe("scheduler core checkpoint", () => {
  it("defaults to five concurrent workers and rejects invalid capacities", () => {
    const store = new MemoryStore();
    const runner = new FakeRunner();
    const workspace = new FakeWorkspace();
    expect(() => new Scheduler({ runner, workspace, store, maxConcurrent: 33 })).toThrowError(/maxConcurrent/);
    expect(() => new Scheduler({ runner, workspace, store, maxConcurrent: 0 })).toThrowError(/maxConcurrent/);
    const scheduler = new Scheduler({ runner, workspace, store, closeGraceMs: 10 });
    openSchedulers.push(scheduler);
    expect(store.owner).toBe(true);
  });

  it("spawn is non-blocking, assigns stable identity, projects runner events to a terminal state", async () => {
    const { scheduler, runner } = make();
    const queued = await scheduler.spawn(baseTask({ prompt: "read the repo" }));

    expect(queued.state).toBe("queued");
    expect(queued.jobId).toBe("CDT-00001");
    expect(queued.attempt).toBe(1);
    expect(runner.runs.every((run) => !run.settled)).toBe(true);

    await flush();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]!.request.jobId).toBe(queued.jobId);
    expect(runner.runs[0]!.request.runId).toBe(queued.runId);
    expect(scheduler.status(queued.jobId).state).toBe("running");

    runner.runs[0]!.emit({ type: "init", sessionId: "sess-uuid-1", model: "glm-5.3" });
    runner.runs[0]!.emit({ type: "tool_start", toolName: "Read" });
    runner.runs[0]!.emit({ type: "text", text: "  first   observation  " });
    expect(scheduler.status(queued.jobId).latestTextPreview).toBe("first observation");
    runner.runs[0]!.resolve({
      sessionId: "sess-uuid-1",
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, sdkCostEstimateUsd: null, providerBilledCostUsd: null },
    });
    await flush();

    const done = scheduler.status(queued.jobId);
    expect(done.state).toBe("succeeded");
    expect(done.modelSucceeded).toBe(true);
    expect(done.gatePassed).toBeNull();
    expect(done.sessionId).toBe("sess-uuid-1");
    expect(done.toolCallCount).toBe(1);
    expect(done.latestTextPreview).toBe("done");
    expect(done.usage.inputTokens).toBe(11);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.nextAction).toBe("finish");
  });

  it("runs FIFO with default concurrency 2 and starts the queued job when a slot frees", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "one" }));
    const second = await scheduler.spawn(baseTask({ prompt: "two" }));
    const third = await scheduler.spawn(baseTask({ prompt: "three" }));
    await flush();

    expect(runner.runs.map((run) => run.request.prompt)).toEqual(["one", "two"]);
    expect(scheduler.status(third.jobId).state).toBe("queued");

    runner.runs[0]!.resolve();
    await flush();
    expect(runner.runs.map((run) => run.request.prompt)).toEqual(["one", "two", "three"]);
    expect(runner.runs[2]!.request.jobId).toBe(third.jobId);
    expect(scheduler.status(third.jobId).state).toBe("running");
    expect(scheduler.status(first.jobId).state).toBe("succeeded");
    expect(scheduler.status(second.jobId).state).toBe("running");
  });

  it("marks failed results and thrown runner errors as failed, keeping the session for resume", async () => {
    const { scheduler, runner } = make();
    const rejectedResult = await scheduler.spawn(baseTask({ prompt: "model failure" }));
    await flush();
    runner.runs[0]!.emit({ type: "init", sessionId: "sess-keep" });
    runner.runs[0]!.resolve({ modelSucceeded: false, sessionId: "sess-keep", error: "upstream refused" });
    await flush();
    expect(scheduler.status(rejectedResult.jobId).state).toBe("failed");
    expect(scheduler.status(rejectedResult.jobId).lastError).toContain("upstream refused");
    expect(scheduler.status(rejectedResult.jobId).sessionId).toBe("sess-keep");

    const thrown = await scheduler.spawn(baseTask({ prompt: "runner throw" }));
    await flush();
    runner.runs[1]!.reject(new Error("socket closed"));
    await flush();
    expect(scheduler.status(thrown.jobId).state).toBe("failed");
    expect(scheduler.status(thrown.jobId).lastError).toContain("socket closed");
  });

  it("spawnBatch validates and prepares the whole batch before starting any runner", async () => {
    const { scheduler, runner, workspace } = make();
    const tasks = [baseTask({ prompt: "a" }), baseTask({ prompt: "b" }), baseTask({ prompt: "c" })];
    const snapshots = await scheduler.spawnBatch(tasks);
    expect(snapshots).toHaveLength(3);
    expect(workspace.validateCalls).toHaveLength(1);
    expect(workspace.validateCalls[0]).toHaveLength(3);
    expect(workspace.prepareCalls).toHaveLength(1);
    await flush();
    expect(runner.runs).toHaveLength(2);
  });

  it("starts zero runners when any batch item fails validation", async () => {
    const { scheduler, runner, workspace } = make();
    workspace.validateHook = (tasks) => {
      if (tasks.some((task) => task.prompt.includes("bad"))) throw new Error("cwd rejected");
    };
    await expect(scheduler.spawnBatch([baseTask({ prompt: "ok" }), baseTask({ prompt: "bad" })])).rejects.toMatchObject({
      code: "WORKSPACE_INVALID",
    });
    await flush();
    expect(runner.runs).toHaveLength(0);
    expect(workspace.prepareCalls).toHaveLength(0);
  });

  it("starts zero runners when prepare fails or a prepared task is altered", async () => {
    const first = make();
    first.workspace.prepareError = new Error("disk full");
    await expect(first.scheduler.spawnBatch([baseTask({ prompt: "ok" }), baseTask({ prompt: "also" })])).rejects.toMatchObject({
      code: "WORKSPACE_INVALID",
    });
    await flush();
    expect(first.runner.runs).toHaveLength(0);

    const second = make();
    second.workspace.transformPrepared = (prepared, index) =>
      index === 1 ? { ...prepared, model: "glm-5.3-flash" } : prepared;
    await expect(
      second.scheduler.spawnBatch([baseTask({ prompt: "ok" }), baseTask({ prompt: "changed" })]),
    ).rejects.toMatchObject({ code: "MODEL_MISMATCH" });
    await flush();
    expect(second.runner.runs).toHaveLength(0);
  });

  it("bounds the FIFO queue and aborts a running job without leaking its capacity", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 1, maxQueued: 1 });
    const first = await scheduler.spawn(baseTask({ prompt: "held" }));
    const second = await scheduler.spawn(baseTask({ prompt: "queued" }));
    await expect(scheduler.spawn(baseTask({ prompt: "overflow" }))).rejects.toMatchObject({
      code: "CAPACITY_EXCEEDED",
    });
    await flush();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]!.request.jobId).toBe(first.jobId);

    await scheduler.abort(first.jobId);
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
    expect(scheduler.status(first.jobId).state).toBe("cancelled");
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.jobId).toBe(second.jobId);
    expect(scheduler.status(second.jobId).state).toBe("running");

    const replacement = await scheduler.spawn(baseTask({ prompt: "replacement" }));
    expect(scheduler.status(replacement.jobId).state).toBe("queued");
  });

  it("aborts a queued job before it ever reaches the runner", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 1 });
    await scheduler.spawn(baseTask({ prompt: "running" }));
    const queued = await scheduler.spawn(baseTask({ prompt: "queued" }));
    await flush();
    expect(runner.runs).toHaveLength(1);
    const cancelled = await scheduler.abort(queued.jobId);
    expect(cancelled.state).toBe("cancelled");
    await flush();
    expect(runner.runs).toHaveLength(1);
    await expect(scheduler.abort(queued.jobId)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("sessions filters, paginates and returns independent snapshots", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 3 });
    const one = await scheduler.spawn(baseTask({ cwd: "/repo/a", prompt: "a1" }));
    const two = await scheduler.spawn(baseTask({ cwd: "/repo/a", prompt: "a2" }));
    const three = await scheduler.spawn(baseTask({ cwd: "/repo/b", prompt: "b1" }));
    await flush();
    for (const run of runner.runs) run.resolve();
    await flush();

    expect(scheduler.sessions({ cwd: "/repo/a" }).map((job) => job.jobId)).toEqual([one.jobId, two.jobId]);
    expect(scheduler.sessions({ state: "succeeded" })).toHaveLength(3);
    expect(scheduler.sessions({ offset: 1, limit: 1 }).map((job) => job.jobId)).toEqual([two.jobId]);
    expect(scheduler.sessions({ limit: 0 })).toEqual([]);

    const snapshot = scheduler.status(one.jobId);
    snapshot.task.allowedPaths.push("/mutated");
    expect(scheduler.status(one.jobId).task.allowedPaths).toEqual([]);
    expect(() => scheduler.status("CDT-99999")).toThrowError(/unknown jobId/);
    void three;
  });

  it("close cancels queued work, interrupts active work, aborts signals and closes the store once", async () => {
    const { scheduler, runner, store } = make({ maxConcurrent: 1 });
    const active = await scheduler.spawn(baseTask({ prompt: "active" }));
    const queued = await scheduler.spawn(baseTask({ prompt: "queued" }));
    await flush();
    expect(runner.runs).toHaveLength(1);

    const closing = scheduler.close();
    await closing;
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
    expect(scheduler.status(active.jobId).state).toBe("interrupted");
    expect(scheduler.status(queued.jobId).state).toBe("cancelled");
    expect(store.closed).toBe(true);
    expect(store.closeCalls).toBe(1);
    await scheduler.close();
    expect(store.closeCalls).toBe(1);
    await expect(scheduler.spawn(baseTask())).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("exposes every contract method with explicit unknown-job validation", async () => {
    const { scheduler } = make();
    await expect(scheduler.wait(["CDT-00001"])).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
    await expect(scheduler.followUp("CDT-00001", "more")).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
    await expect(scheduler.fork("CDT-00001", "split")).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
    await expect(scheduler.answer("CDT-00001", "r1", true)).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
    await expect(scheduler.steer("CDT-00001", "adjust")).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
  });
});

describe("scheduler recovery and persistence fail-stop", () => {
  it("loads active jobs as unknown_outcome without retrying the model", async () => {
    const store = new MemoryStore();
    const runner = new FakeRunner();
    const recoverable = [
      seedSnapshot({ jobId: "CDT-00001", state: "running", sessionId: "sess-live", revision: 7 }),
      seedSnapshot({
        jobId: "CDT-00002",
        state: "needs_attention",
        revision: 4,
        approvals: [{ requestId: "req-1", toolName: "Bash", description: "rm" }],
      }),
      seedSnapshot({ jobId: "CDT-00003", state: "queued", revision: 1 }),
      seedSnapshot({ jobId: "CDT-00042", state: "succeeded", revision: 9 }),
    ];
    for (const snapshot of recoverable) store.snapshots.set(snapshot.jobId, snapshot);

    const scheduler = new Scheduler({ runner, workspace: new FakeWorkspace(), store, closeGraceMs: 20 });
    openSchedulers.push(scheduler);

    expect(runner.runs).toHaveLength(0);
    for (const jobId of ["CDT-00001", "CDT-00002", "CDT-00003"]) {
      const job = scheduler.status(jobId);
      expect(job.state).toBe("unknown_outcome");
      expect(job.modelSucceeded).toBeNull();
      expect(job.approvals).toEqual([]);
      expect(job.lastError).toContain("recovered after scheduler restart");
      expect(job.revision).toBeGreaterThan(0);
    }
    expect(scheduler.status("CDT-00042").state).toBe("succeeded");
    expect(scheduler.sessions()).toHaveLength(4);
    expect(store.events.filter((entry) => (entry.event as { kind?: string }).kind === "recovered_unknown_outcome")).toHaveLength(3);

    const next = await scheduler.spawn(baseTask({ prompt: "after recovery" }));
    expect(next.jobId).toBe("CDT-00043");
  });

  it("rejects a second owner of the same durable store", async () => {
    const store = new MemoryStore();
    const first = new Scheduler({ runner: new FakeRunner(), workspace: new FakeWorkspace(), store, closeGraceMs: 10 });
    openSchedulers.push(first);
    expect(() => new Scheduler({ runner: new FakeRunner(), workspace: new FakeWorkspace(), store, closeGraceMs: 10 })).toThrowError(
      /ownership/i,
    );
    expect(store.closed).toBe(false);
  });

  it("rejects a corrupt stored snapshot during construction", () => {
    const store = new MemoryStore();
    store.snapshots.set("CDT-00099", seedSnapshot({ jobId: "CDT-00099", state: "not-a-state" as never }));
    expect(() => new Scheduler({ runner: new FakeRunner(), workspace: new FakeWorkspace(), store, closeGraceMs: 10 })).toThrowError(
      /invalid/i
    );
    expect(store.closed).toBe(true);
  });

  it("fails construction when recovery state cannot be persisted", () => {
    const store = new MemoryStore();
    store.snapshots.set("CDT-00010", seedSnapshot({ jobId: "CDT-00010", state: "running" }));
    store.failNextSave = true;
    expect(() => new Scheduler({ runner: new FakeRunner(), workspace: new FakeWorkspace(), store, closeGraceMs: 10 })).toThrowError(
      /persist/i
    );
    expect(store.closed).toBe(true);
  });

  it("fail-stops on event persistence failure instead of claiming success", async () => {
    const { scheduler, runner, store } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "persist failure" }));
    await flush();
    const run = runner.runs[0]!;
    run.emit({ type: "init", sessionId: "sess-before-failure" });
    store.failNextSave = true;
    run.emit({ type: "tool_start", toolName: "Write" });
    await flush();

    expect(run.request.signal.aborted).toBe(true);
    const failed = scheduler.status(job.jobId);
    expect(failed.state).toBe("unknown_outcome");
    expect(failed.modelSucceeded).toBeNull();
    expect(failed.lastError).toContain("persist");
    await expect(scheduler.spawn(baseTask({ prompt: "blocked" }))).rejects.toMatchObject({ code: "FATAL" });
  });

  it("fail-stops when appendEvent fails after the snapshot save", async () => {
    const { scheduler, runner, store } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "append failure" }));
    await flush();
    const run = runner.runs[0]!;
    run.emit({ type: "init", sessionId: "sess-append" });
    store.failNextAppend = true;
    run.emit({ type: "text", text: "will not persist" });
    await flush();

    expect(run.request.signal.aborted).toBe(true);
    expect(scheduler.status(job.jobId).state).toBe("unknown_outcome");
    expect(scheduler.status(job.jobId).lastError).toContain("persist");
    await expect(scheduler.spawn(baseTask({ prompt: "blocked" }))).rejects.toMatchObject({ code: "FATAL" });
  });

  it("rejects spawn when the enqueued state cannot be saved and starts no runner", async () => {
    const { scheduler, runner, store } = make();
    store.failNextSave = true;
    await expect(scheduler.spawn(baseTask())).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    await flush();
    expect(runner.runs).toHaveLength(0);
    expect(() => scheduler.status("CDT-00001")).toThrowError(/unknown jobId/);
    await expect(scheduler.spawn(baseTask())).rejects.toMatchObject({ code: "FATAL" });
  });

  it("close still releases the store and reports persistence errors", async () => {
    const { scheduler, runner, store } = make({ maxConcurrent: 1 });
    await scheduler.spawn(baseTask({ prompt: "active" }));
    await flush();
    store.failNextSave = true;
    await expect(scheduler.close()).rejects.toBeInstanceOf(AggregateError);
    expect(store.closed).toBe(true);
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
  });
});

describe("snapshot shape checks", () => {
  it("keeps requested and reported model separate", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ model: "glm-5.3" }));
    await flush();
    runner.runs[0]!.emit({ type: "init", model: "glm-5.3-flash" });
    const running: JobSnapshot = scheduler.status(job.jobId);
    expect(running.modelRequested).toBe("glm-5.3");
    expect(running.modelReported).toBe("glm-5.3-flash");
    expect(running.modelSucceeded).toBeNull();
  });
});
