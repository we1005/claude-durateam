/**
 * Race-hardening and effort-preservation tests for the Scheduler (Task B).
 *
 * Invariants under test:
 * - Requested effort survives normalize -> workspace -> RunnerRequest -> resume/fork/restart.
 * - Malicious workspaces that rewrite requested effort are rejected before any runner run.
 * - followUp/fork must never start a second attempt on the same session while the previous
 *   runner promise is unresolved (terminal-but-slot-holding jobs), and slot bookkeeping
 *   must not leak.
 * - Events/approvals of a cancelled attempt must not corrupt the job or a newer attempt.
 * - Atomic state.commit failure fail-stops the scheduler without scheduling extra work.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import {
  AtomicMemoryStore,
  FakeRunner,
  FakeWorkspace,
  MemoryStore,
  baseTask,
  flush,
} from "./scheduler-doubles.js";

const openSchedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of openSchedulers.splice(0)) {
    try {
      await scheduler.close();
    } catch {
      // fail-stopped schedulers may reject close
    }
  }
});

function make(store: MemoryStore = new MemoryStore(), maxConcurrent = 2) {
  const runner = new FakeRunner();
  runner.autoRejectOnAbort = false;
  const workspace = new FakeWorkspace();
  const scheduler = new Scheduler({ runner, workspace, store, maxConcurrent, closeGraceMs: 20 });
  openSchedulers.push(scheduler);
  return { scheduler, runner, workspace, store };
}

describe("requested effort survives the whole pipeline", () => {
  it("forwards a nondefault effort through spawn into the RunnerRequest", async () => {
    const { scheduler, runner } = make();
    const snapshot = await scheduler.spawn(baseTask({ effort: "xhigh" }));
    expect(snapshot.task.effort).toBe("xhigh");
    await flush();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]!.request.effort).toBe("xhigh");
    expect(scheduler.status(snapshot.jobId).task.effort).toBe("xhigh");
  });

  it("keeps the requested effort across follow-up resume and fork", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ effort: "low" }));
    await flush();
    runner.runs[0]!.resolve({ sessionId: "sess-low" });
    await flush();

    const resumed = await scheduler.followUp(first.jobId, "continue with the same effort");
    expect(resumed.attempt).toBe(2);
    expect(resumed.task.effort).toBe("low");
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.effort).toBe("low");
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-low");
    expect(runner.runs[1]!.request.forkSession).toBeUndefined();
    runner.runs[1]!.resolve({ sessionId: "sess-low" });
    await flush();

    const forked = await scheduler.fork(first.jobId, "fork the low-effort conversation");
    await flush();
    expect(runner.runs).toHaveLength(3);
    expect(runner.runs[2]!.request.effort).toBe("low");
    expect(runner.runs[2]!.request.forkSession).toBe(true);
    expect(runner.runs[2]!.request.resumeSessionId).toBe("sess-low");
    expect(forked.task.effort).toBe("low");
  });

  it("keeps the requested effort across a scheduler restart (recovery from the store)", async () => {
    const store = new MemoryStore();
    {
      const { scheduler, runner } = make(store);
      const job = await scheduler.spawn(baseTask({ effort: "max" }));
      await flush();
      runner.runs[0]!.resolve({ sessionId: "sess-max" });
      await flush();
      expect(scheduler.status(job.jobId).state).toBe("succeeded");
      await scheduler.close();
    }
    const { scheduler, runner } = make(store);
    const recovered = scheduler.sessions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.task.effort).toBe("max");
    expect(recovered[0]!.sessionId).toBe("sess-max");

    const resumed = await scheduler.followUp(recovered[0]!.jobId, "resume after restart");
    expect(resumed.task.effort).toBe("max");
    await flush();
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]!.request.effort).toBe("max");
    expect(runner.runs[0]!.request.resumeSessionId).toBe("sess-max");
  });

  it("rejects invalid effort input before the workspace or runner is touched", async () => {
    const { scheduler, runner, workspace } = make();
    await expect(scheduler.spawn(baseTask({ effort: "ultra" as never }))).rejects.toMatchObject({ code: "INVALID_TASK" });
    expect(workspace.validateCalls).toHaveLength(0);
    expect(runner.runs).toHaveLength(0);
    expect(scheduler.sessions()).toHaveLength(0);
  });

  it("rejects a malicious workspace that rewrites the requested effort (spawn and fork)", async () => {
    const { scheduler, runner, workspace } = make();
    workspace.transformPrepared = (prepared) => ({ ...prepared, effort: "low" });

    await expect(scheduler.spawn(baseTask({ effort: "max" }))).rejects.toMatchObject({
      code: "WORKSPACE_INVALID",
    });
    expect(runner.runs).toHaveLength(0);
    expect(scheduler.sessions()).toHaveLength(0);

    // Fork path exercises the same guard on a terminal source job.
    workspace.transformPrepared = null;
    const source = await scheduler.spawn(baseTask({ prompt: "clean source", effort: "high" }));
    await flush();
    runner.runs[0]!.resolve({ sessionId: "sess-src" });
    await flush();
    workspace.transformPrepared = (prepared) => ({ ...prepared, effort: "max" });
    await expect(scheduler.fork(source.jobId, "fork prompt")).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    expect(runner.runs).toHaveLength(1);
  });
});

describe("terminal-before-runner-settle: followUp/fork never race the old runner", () => {
  it("rejects followUp while an aborted run's slot is still held, and allows it after settlement", async () => {
    const { scheduler, runner } = make(new MemoryStore(), 1);
    const first = await scheduler.spawn(baseTask({ prompt: "ignores abort", effort: "medium" }));
    await flush();
    expect(scheduler.status(first.jobId).state).toBe("running");

    await scheduler.abort(first.jobId);
    expect(scheduler.status(first.jobId).state).toBe("cancelled");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);

    await expect(scheduler.followUp(first.jobId, "too early")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });
    expect(runner.runs).toHaveLength(1);

    runner.runs[0]!.resolve({ sessionId: "sess-aborted" });
    await flush();

    const resumed = await scheduler.followUp(first.jobId, "safe now");
    expect(resumed.attempt).toBe(2);
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-aborted");
    expect(runner.runs[1]!.request.effort).toBe("medium");

    // Slot bookkeeping recovered: the resumed attempt is admitted immediately.
    expect(scheduler.status(first.jobId).state).toBe("running");
    runner.runs[1]!.resolve();
    await flush();
    expect(scheduler.status(first.jobId).state).toBe("succeeded");
  });

  it("rejects followUp and fork while a timed-out run's slot is still held", async () => {
    const { scheduler, runner } = make(new MemoryStore(), 1);
    const first = await scheduler.spawn(baseTask({ prompt: "deadline ignores abort", deadlineMs: 25 }));
    await flush();
    await flush(55);
    expect(scheduler.status(first.jobId).state).toBe("timed_out");

    await expect(scheduler.followUp(first.jobId, "too early")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });
    await expect(scheduler.fork(first.jobId, "too early fork")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });
    expect(runner.runs).toHaveLength(1);

    runner.runs[0]!.resolve({ sessionId: "sess-timeout" });
    await flush();
    const forked = await scheduler.fork(first.jobId, "safe fork");
    expect(forked.jobId).not.toBe(first.jobId);
    await flush();
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-timeout");
  });

  it("rejects followUp while a fail-stopped run is still unresolved (unknown_outcome)", async () => {
    const store = new AtomicMemoryStore();
    const { scheduler, runner } = make(store, 1);
    const first = await scheduler.spawn(baseTask({ prompt: "will failstop" }));
    await flush();
    store.failNextCommit = true;
    runner.runs[0]!.emit({ type: "text", text: "boom" });
    expect(scheduler.status(first.jobId).state).toBe("unknown_outcome");

    await expect(scheduler.followUp(first.jobId, "still fatal")).rejects.toMatchObject({ code: "FATAL" });
    runner.runs[0]!.reject(new Error("aborted by fail-stop"));
    await flush();
    // The slot is released on settlement, but a fail-stopped scheduler stays closed for
    // admission permanently: no new attempt can ever be enqueued after unknown_outcome.
    await expect(scheduler.followUp(first.jobId, "still fatal after settle")).rejects.toMatchObject({
      code: "FATAL",
    });
    expect(runner.runs).toHaveLength(1);
  });
});

describe("cancelled attempt events and approvals never corrupt the job", () => {
  it("drops late events from a cancelled run and leaves no residue before a follow-up", async () => {
    const { scheduler, runner } = make(new MemoryStore(), 1);
    const first = await scheduler.spawn(baseTask({ prompt: "cancelled mid-flight" }));
    await flush();

    const decision = runner.askApproval(0, "appr-1", "Bash");
    await scheduler.abort(first.jobId);
    await expect(decision).resolves.toBe(false); // drained with decision=false
    expect(scheduler.status(first.jobId).approvals).toHaveLength(0);

    runner.runs[0]!.emit({ type: "text", text: "late text after cancel" });
    runner.runs[0]!.emit({ type: "tool_start", toolName: "Bash" });
    runner.runs[0]!.emit({ type: "init", sessionId: "sess-rogue", model: "rogue-model" });

    const status = scheduler.status(first.jobId);
    expect(status.state).toBe("cancelled");
    expect(status.latestTextPreview).toBe("");
    expect(status.toolCallCount).toBe(0);
    expect(status.sessionId).toBeNull();
    expect(status.modelReported).toBeNull();

    runner.runs[0]!.resolve({ sessionId: "sess-legit" });
    await flush();
    const resumed = await scheduler.followUp(first.jobId, "fresh attempt");
    await flush();
    expect(resumed.attempt).toBe(2);
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-legit");
  });

  it("does not acknowledge forged, stale or repeated approval answers", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "approval target" }));
    await flush();
    void runner.askApproval(0, "appr-1", "Bash");
    await flush();

    await expect(scheduler.answer(first.jobId, "", true)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(scheduler.answer(first.jobId, "appr-1", "yes" as never)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(await scheduler.answer(first.jobId, "forged-id", true)).toEqual({ acknowledged: false });
    expect(await scheduler.answer(first.jobId, "appr-1", true)).toEqual({ acknowledged: true });
    expect(await scheduler.answer(first.jobId, "appr-1", true)).toEqual({ acknowledged: false }); // settled
    await flush();
    expect(runner.approvals[0]!.decision).toBe(true);
  });

  it("rejects invalid steer input and refuses steering of cancelled or aborted runs", async () => {
    const { scheduler, runner } = make();
    const first = await scheduler.spawn(baseTask({ prompt: "steer target" }));
    await flush();

    await expect(scheduler.steer(first.jobId, "msg", "urgent" as never)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(scheduler.steer(first.jobId, "   ", "next")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await scheduler.abort(first.jobId);
    const receipt = await scheduler.steer(first.jobId, "too late", "now");
    expect(receipt.disposition).toBe("unsupported");
    expect(runner.steerCalls).toHaveLength(0);
  });
});

describe("atomic commit failure fail-stop schedules no extra work", () => {
  it("aborts everything, marks unknown_outcome/cancelled, and never starts queued work", async () => {
    const store = new AtomicMemoryStore();
    const { scheduler, runner } = make(store, 1);
    const active = await scheduler.spawn(baseTask({ prompt: "active fails to persist" }));
    const queued = await scheduler.spawn(baseTask({ prompt: "queued must never start" }));
    await flush();
    expect(runner.runs).toHaveLength(1);
    expect(scheduler.status(queued.jobId).state).toBe("queued");

    store.failNextCommit = true;
    runner.runs[0]!.emit({ type: "tool_start", toolName: "Bash" });

    expect(scheduler.status(active.jobId).state).toBe("unknown_outcome");
    expect(scheduler.status(queued.jobId).state).toBe("cancelled");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);

    // Fail-stop: all admission paths closed, even with capacity free.
    await expect(scheduler.spawn(baseTask({ prompt: "rejected" }))).rejects.toMatchObject({ code: "FATAL" });
    await expect(scheduler.followUp(active.jobId, "rejected")).rejects.toMatchObject({ code: "FATAL" });
    await expect(scheduler.fork(active.jobId, "rejected")).rejects.toMatchObject({ code: "FATAL" });
    await expect(scheduler.steer(active.jobId, "rejected")).rejects.toMatchObject({ code: "FATAL" });

    // Settling the aborted runner must not schedule extra work either.
    runner.runs[0]!.resolve({ sessionId: "sess-phantom" });
    await flush(30);
    expect(runner.runs).toHaveLength(1);
    expect(scheduler.sessions({ state: "queued" })).toHaveLength(0);
    await scheduler.close(); // terminal jobs only: no commit errors, close resolves
  });

  it("fail-stop at spawn admission registers no job and blocks subsequent admission", async () => {
    const store = new AtomicMemoryStore();
    const { scheduler, runner } = make(store);
    store.failNextCommit = true;
    await expect(scheduler.spawn(baseTask({ prompt: "first spawn loses persistence" }))).rejects.toMatchObject({
      code: "PERSISTENCE_FAILED",
    });
    expect(scheduler.sessions()).toHaveLength(0);
    expect(runner.runs).toHaveLength(0);

    await flush(10); // any stray pump would have started a run by now
    expect(runner.runs).toHaveLength(0);
    await expect(scheduler.spawn(baseTask({ prompt: "second spawn" }))).rejects.toMatchObject({ code: "FATAL" });
    expect(runner.runs).toHaveLength(0);
  });
});
