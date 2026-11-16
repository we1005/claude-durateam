import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import { AtomicMemoryStore, baseTask, FakeRunner, FakeWorkspace, flush } from "./scheduler-doubles.js";

const openSchedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of openSchedulers.splice(0)) {
    try {
      await scheduler.close();
    } catch {
      // fatal scheduler still releases the store
    }
  }
});

function make() {
  const runner = new FakeRunner();
  const workspace = new FakeWorkspace();
  const store = new AtomicMemoryStore();
  const scheduler = new Scheduler({ runner, workspace, store, closeGraceMs: 20 });
  openSchedulers.push(scheduler);
  return { scheduler, runner, store };
}

describe("StateStore.commit v1.1", () => {
  it("uses one commit() call per transition and never falls back to save/appendEvent", async () => {
    const { scheduler, runner, store } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "atomic commit" }));
    await flush();
    runner.runs[0]!.emit({ type: "init", sessionId: "sess-commit" });
    runner.runs[0]!.resolve({ sessionId: "sess-commit" });
    await flush();

    expect(store.commitCalls).toBeGreaterThanOrEqual(4);
    expect(store.saves).toBe(0);
    expect(store.appends).toBe(0);
    expect(scheduler.status(job.jobId).state).toBe("succeeded");
  });

  it("rolls back a spawn whose commit fails and rejects subsequent work", async () => {
    const { scheduler, runner, store } = make();
    store.failNextCommit = true;
    await expect(scheduler.spawn(baseTask({ prompt: "commit fail spawn" }))).rejects.toMatchObject({
      code: "PERSISTENCE_FAILED",
    });
    expect(store.snapshots.size).toBe(0);
    expect(store.commitCalls).toBe(1);
    await flush();
    expect(runner.runs).toHaveLength(0);
    expect(() => scheduler.status("CDT-00001")).toThrowError(/unknown jobId/);

    await expect(scheduler.spawn(baseTask({ prompt: "blocked after fatal" }))).rejects.toMatchObject({ code: "FATAL" });
    expect(store.snapshots.size).toBe(0);
  });

  it("does not claim an event or success when a mid-run commit fails", async () => {
    const { scheduler, runner, store } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "mid run commit fail" }));
    await flush();
    const run = runner.runs[0]!;
    run.emit({ type: "init", sessionId: "sess-mid" });
    const durableRevision = store.snapshots.get(job.jobId)!.revision;
    store.failNextCommit = true;
    run.emit({ type: "tool_start", toolName: "Write" });

    expect(run.request.signal.aborted).toBe(true);
    const failed = scheduler.status(job.jobId);
    expect(failed.state).toBe("unknown_outcome");
    expect(failed.modelSucceeded).toBeNull();
    expect(failed.lastError).toContain("transaction failure");
    expect(store.snapshots.get(job.jobId)!.revision).toBe(durableRevision);
    expect(store.snapshots.get(job.jobId)!.state).toBe("running");
    await expect(scheduler.spawn(baseTask({ prompt: "blocked" }))).rejects.toMatchObject({ code: "FATAL" });
  });

  it("rejects answer() when the approval transaction fails and still denies the runner", async () => {
    const { scheduler, runner, store } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "approval commit fail" }));
    await flush();
    const decision = runner.askApproval(0, "req-commit-fail");
    store.failNextCommit = true;

    await expect(scheduler.answer(job.jobId, "req-commit-fail", true)).rejects.toMatchObject({
      code: "PERSISTENCE_FAILED",
    });
    expect(await decision).toBe(false);
    expect(scheduler.status(job.jobId).state).toBe("unknown_outcome");
    expect(scheduler.status(job.jobId).approvals).toEqual([]);
    await expect(scheduler.spawn(baseTask({ prompt: "blocked" }))).rejects.toMatchObject({ code: "FATAL" });
  });
});
