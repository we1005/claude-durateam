import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import { baseTask, FakeRunner, FakeWorkspace, MemoryStore, flush } from "./scheduler-doubles.js";

const openSchedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of openSchedulers.splice(0)) {
    try {
      await scheduler.close();
    } catch {
      // expected for forced-cleanup tests
    }
  }
});

function make() {
  const runner = new FakeRunner();
  runner.autoRejectOnAbort = false;
  const workspace = new FakeWorkspace();
  const store = new MemoryStore();
  const scheduler = new Scheduler({ runner, workspace, store, maxConcurrent: 1, closeGraceMs: 20 });
  openSchedulers.push(scheduler);
  return { scheduler, runner, store };
}

describe("hard maxConcurrent follows the runner execution lifecycle", () => {
  it("keeps A's slot after abort until A.run actually settles, so B cannot start early", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "ignores abort" }));
    const second = await scheduler.spawn(baseTask({ prompt: "waits for real settle" }));
    await flush();
    expect(runner.runs).toHaveLength(1);

    const aborted = await scheduler.abort(first.jobId);
    expect(aborted.state).toBe("cancelled");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
    expect(scheduler.status(second.jobId).state).toBe("queued");
    await flush(40);
    expect(runner.runs).toHaveLength(1);
    expect(scheduler.status(second.jobId).state).toBe("queued");

    runner.runs[0]!.resolve({ sessionId: "sess-after-abort" });
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.jobId).toBe(second.jobId);
    expect(scheduler.status(second.jobId).state).toBe("running");
  });

  it("keeps the slot after deadline timeout until the runner promise settles", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "deadline ignores abort", deadlineMs: 25 }));
    const second = await scheduler.spawn(baseTask({ prompt: "waits for deadline settle" }));
    await flush();
    await flush(55);

    expect(scheduler.status(first.jobId).state).toBe("timed_out");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
    expect(scheduler.status(second.jobId).state).toBe("queued");
    expect(runner.runs).toHaveLength(1);
    await flush(40);
    expect(runner.runs).toHaveLength(1);

    runner.runs[0]!.resolve();
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.jobId).toBe(second.jobId);
  });

  it("close waits for real settlement up to its bound, then completes", async () => {
    const { scheduler, runner, store } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "active ignores abort" }));
    const second = await scheduler.spawn(baseTask({ prompt: "queued at close" }));
    await flush();
    const started = Date.now();
    await scheduler.close();
    expect(Date.now() - started).toBeLessThan(500);
    expect(store.closed).toBe(true);
    expect(scheduler.status(first.jobId).state).toBe("interrupted");
    expect(scheduler.status(second.jobId).state).toBe("cancelled");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
  });
});
