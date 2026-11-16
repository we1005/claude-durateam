import { afterEach, describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import { baseTask, FakeRunner, FakeWorkspace, MemoryStore, flush } from "./scheduler-doubles.js";

const openSchedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of openSchedulers.splice(0)) {
    try {
      await scheduler.close();
    } catch {
      // Fatal schedulers still release their store.
    }
  }
});

function make(options: { maxConcurrent?: number; maxQueued?: number; approvalTimeoutMs?: number; maxWaitTimeoutMs?: number } = {}) {
  const runner = new FakeRunner();
  const workspace = new FakeWorkspace();
  const store = new MemoryStore();
  const scheduler = new Scheduler({
    runner,
    workspace,
    store,
    maxConcurrent: options.maxConcurrent,
    maxQueued: options.maxQueued,
    approvalTimeoutMs: options.approvalTimeoutMs,
    maxWaitTimeoutMs: options.maxWaitTimeoutMs,
    closeGraceMs: 20,
  });
  openSchedulers.push(scheduler);
  return { scheduler, runner, workspace, store };
}

describe("scheduler wait", () => {
  it("returns finished jobs immediately and reports continueIds/nextAction", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "wait job" }));
    await flush();
    runner.runs[0]!.resolve({ sessionId: "sess-wait" });
    await flush();

    const result = await scheduler.wait([job.jobId], { timeoutMs: 100 });
    expect(result.timedOut).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.state).toBe("succeeded");
    expect(result.continueIds).toEqual([]);
    expect(result.nextAction).toBe("finish");
  });

  it("long-polls on revision changes without busy waiting", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "poll" }));
    await flush();
    const baseline = scheduler.status(job.jobId).revision;
    const waiting = scheduler.wait([job.jobId], { afterRevision: baseline, timeoutMs: 1000 });
    await flush();
    runner.runs[0]!.emit({ type: "tool_start", toolName: "Read" });
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.jobs[0]!.toolCallCount).toBe(1);
    expect(result.continueIds).toEqual([job.jobId]);
    expect(result.nextAction).toBe("wait");
  });

  it("wait timeout does not cancel the job and respects the configured cap", async () => {
    const { scheduler, runner } = make({ maxWaitTimeoutMs: 30 });
    const job = await scheduler.spawn(baseTask({ prompt: "timeout" }));
    await flush();
    const baseline = scheduler.status(job.jobId).revision;
    const started = Date.now();
    const result = await scheduler.wait([job.jobId], { afterRevision: baseline, timeoutMs: 5000 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
    expect(result.jobs[0]!.state).toBe("running");
    expect(runner.runs[0]!.request.signal.aborted).toBe(false);
  });

  it("supports per-job afterRevision records and rejects invalid requests", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 2 });
    const first = await scheduler.spawn(baseTask({ prompt: "first" }));
    const second = await scheduler.spawn(baseTask({ prompt: "second" }));
    await flush();
    runner.runs[1]!.emit({ type: "text", text: "second moved" });
    const result = await scheduler.wait([first.jobId, second.jobId], {
      afterRevision: { [first.jobId]: scheduler.status(first.jobId).revision, [second.jobId]: 0 },
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(false);
    expect(result.jobs.map((job) => job.latestTextPreview)).toEqual(["", "second moved"]);

    await expect(scheduler.wait([])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(scheduler.wait([first.jobId, first.jobId])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(scheduler.wait(["CDT-00999"])).rejects.toMatchObject({ code: "UNKNOWN_JOB" });
  });

  it("resolves an in-flight wait when close interrupts the job", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "closing" }));
    await flush();
    const waiting = scheduler.wait([job.jobId], {
      afterRevision: scheduler.status(job.jobId).revision,
      timeoutMs: 5000,
    });
    await flush();
    const closing = scheduler.close();
    const result = await waiting;
    await closing;
    expect(result.jobs[0]!.state).toBe("interrupted");
    expect(result.nextAction).toBe("finish");
    expect(runner.runs[0]!.request.signal.aborted).toBe(true);
  });
});

describe("scheduler deadline", () => {
  it("starts the deadline only when execution begins", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 1 });
    const running = await scheduler.spawn(baseTask({ prompt: "long", deadlineMs: 10_000 }));
    const queued = await scheduler.spawn(baseTask({ prompt: "short", deadlineMs: 25 }));
    await flush();
    await flush(60);
    expect(scheduler.status(queued.jobId).state).toBe("queued");

    runner.runs[0]!.resolve();
    await flush();
    expect(scheduler.status(queued.jobId).state).toBe("running");
    await flush(60);
    const timedOut = scheduler.status(queued.jobId);
    expect(timedOut.state).toBe("timed_out");
    expect(timedOut.lastError).toContain("deadline");
    expect(runner.runs[1]!.request.signal.aborted).toBe(true);

    const replacement = await scheduler.spawn(baseTask({ prompt: "replacement" }));
    await flush();
    expect(runner.runs.some((run) => run.request.jobId === replacement.jobId)).toBe(true);
  });
});

describe("follow-up and fork", () => {
  it("resumes the exact session UUID with a new runId and attempt", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "initial" }));
    await flush();
    runner.runs[0]!.emit({ type: "init", sessionId: "sess-exact-uuid" });
    runner.runs[0]!.resolve({ sessionId: "sess-exact-uuid" });
    await flush();
    const finished = scheduler.status(job.jobId);
    expect(finished.sessionId).toBe("sess-exact-uuid");
    expect(finished.attempt).toBe(1);

    const follow = await scheduler.followUp(job.jobId, "continue the work");
    expect(follow.jobId).toBe(job.jobId);
    expect(follow.attempt).toBe(2);
    expect(follow.runId).not.toBe(finished.runId);
    expect(follow.state).toBe("queued");
    await expect(scheduler.followUp(job.jobId, "parallel")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });

    await flush();
    expect(runner.runs[1]!.request.prompt).toBe("continue the work");
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-exact-uuid");
    expect(runner.runs[1]!.request.forkSession).toBeUndefined();
  });

  it("rejects follow-up while running and without a session", async () => {
    const { scheduler, runner } = make();
    const running = await scheduler.spawn(baseTask({ prompt: "running" }));
    await flush();
    await expect(scheduler.followUp(running.jobId, "too early")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });

    const noSession = await scheduler.spawn(baseTask({ prompt: "no session" }));
    await flush();
    runner.runs[1]!.resolve({ sessionId: null });
    await flush();
    await expect(scheduler.followUp(noSession.jobId, "resume")).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE" });
  });

  it("forks a new independent workspace before requesting SDK forkSession", async () => {
    const { scheduler, runner, workspace } = make({ maxConcurrent: 2 });
    const source = await scheduler.spawn(baseTask({ prompt: "source", profile: "edit" }));
    await flush();
    runner.runs[0]!.resolve({ sessionId: "sess-source" });
    await flush();
    const before = scheduler.status(source.jobId);
    expect(before.task.managedWorktree).toBe(true);
    expect(runner.runs[0]!.request.cwd).toBe("/fake/wt/0");

    const forked = await scheduler.fork(source.jobId, "forked prompt");
    expect(forked.jobId).not.toBe(source.jobId);
    expect(forked.attempt).toBe(1);
    expect(forked.state).toBe("queued");
    await flush();
    expect(workspace.prepareCalls).toHaveLength(2);
    expect(runner.runs[1]!.request.forkSession).toBe(true);
    expect(runner.runs[1]!.request.resumeSessionId).toBe("sess-source");
    expect(runner.runs[1]!.request.cwd).not.toBe(before.task.cwd);
    expect(scheduler.status(source.jobId).state).toBe("succeeded");
  });

  it("rejects fork while running, without a session, or without an independent workspace", async () => {
    const { scheduler, runner } = make();
    const running = await scheduler.spawn(baseTask({ prompt: "running fork", profile: "edit" }));
    await flush();
    await expect(scheduler.fork(running.jobId, "early")).rejects.toMatchObject({ code: "JOB_NOT_IDLE" });
    runner.runs[0]!.resolve({ sessionId: null });
    await flush();
    await expect(scheduler.fork(running.jobId, "no session")).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE" });
  });
});

describe("steering and approvals", () => {
  it("forwards steer only for executing runs and never fabricates queued acknowledgement", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 1 });
    const running = await scheduler.spawn(baseTask({ prompt: "running" }));
    const queued = await scheduler.spawn(baseTask({ prompt: "queued" }));
    await flush();

    const unsupported = await scheduler.steer(queued.jobId, "change direction");
    expect(unsupported.disposition).toBe("unsupported");
    expect(unsupported.messageId.length).toBeGreaterThan(0);
    expect(runner.steerCalls).toHaveLength(0);

    runner.steerImpl = async () => ({ messageId: "msg-delivered", disposition: "delivered" });
    const receipt = await scheduler.steer(running.jobId, "focus tests", "now");
    expect(receipt).toEqual({ messageId: "msg-delivered", disposition: "delivered" });
    expect(runner.steerCalls[0]).toMatchObject({ runId: running.runId, message: "focus tests", priority: "now" });

    runner.steerImpl = async () => {
      throw new Error("stream closed");
    };
    await expect(scheduler.steer(running.jobId, "too late")).rejects.toMatchObject({ code: "STEER_FAILED" });

    runner.runs[0]!.resolve();
    await flush();
    const finished = await scheduler.steer(running.jobId, "after finish");
    expect(finished.disposition).toBe("unsupported");
  });

  it("requires a real pending requestId bound to the current run", async () => {
    const { scheduler, runner } = make({ maxConcurrent: 2 });
    const first = await scheduler.spawn(baseTask({ prompt: "approval one" }));
    const second = await scheduler.spawn(baseTask({ prompt: "approval two" }));
    await flush();
    const firstDecision = runner.askApproval(0, "req-first");
    const secondDecision = runner.askApproval(1, "req-second");
    await flush();

    expect(scheduler.status(first.jobId).state).toBe("needs_attention");
    expect(scheduler.status(first.jobId).nextAction).toBe("answer");
    const answerWait = await scheduler.wait([first.jobId], { timeoutMs: 10 });
    expect(answerWait.nextAction).toBe("answer");
    expect(answerWait.continueIds).toEqual([first.jobId]);

    expect(await scheduler.answer(first.jobId, "req-second", true)).toEqual({ acknowledged: false });
    expect(await scheduler.answer(second.jobId, "req-first", false)).toEqual({ acknowledged: false });
    expect(await scheduler.answer(first.jobId, "req-first", true)).toEqual({ acknowledged: true });
    await firstDecision;
    expect(scheduler.status(first.jobId).state).toBe("running");
    expect(scheduler.status(first.jobId).approvals).toEqual([]);
    expect(scheduler.status(second.jobId).state).toBe("needs_attention");

    expect(await scheduler.answer(second.jobId, "req-second", false)).toEqual({ acknowledged: true });
    await secondDecision;
    await expect(scheduler.answer(second.jobId, "req-second", true)).resolves.toEqual({ acknowledged: false });
  });

  it("denies approvals on timeout without requiring an answer", async () => {
    const { scheduler, runner } = make({ approvalTimeoutMs: 25 });
    const job = await scheduler.spawn(baseTask({ prompt: "approval timeout" }));
    await flush();
    const decision = runner.askApproval(0, "req-timeout");
    await flush(50);
    expect(await decision).toBe(false);
    expect(scheduler.status(job.jobId).state).toBe("running");
    expect(scheduler.status(job.jobId).approvals).toEqual([]);
    expect(await scheduler.answer(job.jobId, "req-timeout", true)).toEqual({ acknowledged: false });
  });

  it("denies pending approvals when the run is aborted", async () => {
    const { scheduler, runner } = make();
    const job = await scheduler.spawn(baseTask({ prompt: "abort approval" }));
    await flush();
    const decision = runner.askApproval(0, "req-abort");
    await scheduler.abort(job.jobId);
    expect(await decision).toBe(false);
    expect(scheduler.status(job.jobId).state).toBe("cancelled");
    expect(scheduler.status(job.jobId).approvals).toEqual([]);
  });
});
