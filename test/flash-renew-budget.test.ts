import { it, expect } from "vitest";
import { Scheduler } from "../src/scheduler/index.js";
import { FakeRunner, FakeWorkspace, MemoryStore, baseTask, flush } from "./scheduler-doubles.js";

it("renews a retained conversation's budgets without changing permissions, model or effort", async () => {
  const runner = new FakeRunner();const store = new MemoryStore();
  const s = new Scheduler({ runner, store, workspace: new FakeWorkspace(), closeGraceMs: 20 });
  try {
    const first = await s.spawn(baseTask({ effort: "high", model: "glm-5.3-flash", maxTurns: 2, deadlineMs: 5000 }));
    await flush();runner.runs[0]!.resolve({ sessionId: "retained-session" });await flush();
    const previous = s.status(first.jobId);
    await expect(s.followUp(first.jobId, "continue", { maxTurns: 101 })).rejects.toMatchObject({ code: "INVALID_TASK" });
    expect(s.status(first.jobId).attempt).toBe(previous.attempt);
    expect(s.status(first.jobId).task).toEqual(previous.task);
    const resumed = await s.followUp(first.jobId, "continue", { maxTurns: 35, deadlineMs: 900000, model: "glm-5.3" } as any);
    await flush();const request = runner.runs[1]!.request;
    expect(resumed.task.maxTurns).toBe(35);expect(resumed.task.deadlineMs).toBe(900000);
    expect(request.resumeSessionId).toBe("retained-session");expect(request.maxTurns).toBe(35);
    expect(request.model).toBe("glm-5.3-flash");expect(request.effort).toBe("high");
    expect(request.profile).toBe(previous.task.profile);expect(request.allowedPaths).toEqual(previous.task.allowedPaths);
    expect(store.snapshots.get(first.jobId)!.task.deadlineMs).toBe(900000);
    runner.runs[1]!.resolve({ sessionId: "retained-session" });await flush();
  } finally { await s.close(); }
});
