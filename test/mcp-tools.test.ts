import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { createServer } from "../src/mcp/server.js";
import type {
  GateRequest,
  GateResult,
  JobSnapshot,
  Priority,
  SchedulerService,
  SteerReceipt,
  TaskInput,
  WaitResult,
} from "../src/task-contracts.js";

const sessions: JobSnapshot[] = [];

function snapshot(task: TaskInput): JobSnapshot {
  const jobId = `CDT-${randomUUID().slice(0, 8)}`;
  const value: JobSnapshot = {
    jobId,
    runId: `run-${jobId}`,
    attempt: 1,
    sessionId: null,
    state: "queued",
    revision: 1,
    nextAction: "wait",
    task: {
      cwd: task.cwd,
      sourceCwd: task.cwd,
      model: task.model ?? "glm-5.3",
      profile: task.profile ?? "read",
      prompt: task.prompt,
      maxTurns: task.maxTurns ?? 5,
      deadlineMs: task.deadlineMs ?? 120_000,
      allowedPaths: task.allowedPaths ?? [],
      allowedSkillNames: task.allowedSkillNames ?? [],
      enabledMcpServers: task.enabledMcpServers ?? [],
      managedWorktree: false,
      branch: null,
    },
    modelRequested: task.model ?? "glm-5.3",
    modelReported: null,
    modelSucceeded: null,
    gatePassed: null,
    durationMs: 0,
    toolCallCount: 0,
    latestTextPreview: "",
    lastError: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      sdkCostEstimateUsd: null,
      providerBilledCostUsd: null,
    },
    approvals: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sessions.push(value);
  return value;
}

class FakeScheduler implements SchedulerService {
  readonly calls: string[] = [];
  async spawn(task: TaskInput): Promise<JobSnapshot> {
    this.calls.push("spawn");
    return snapshot(task);
  }
  async spawnBatch(tasks: TaskInput[]): Promise<JobSnapshot[]> {
    this.calls.push("spawn_batch");
    return tasks.map(snapshot);
  }
  status(jobId: string): JobSnapshot {
    this.calls.push("status");
    return sessions.find((job) => job.jobId === jobId) ?? snapshot({ cwd: "/tmp", prompt: "x" });
  }
  sessions(): JobSnapshot[] {
    this.calls.push("sessions");
    return sessions;
  }
  async wait(jobIds: string[]): Promise<WaitResult> {
    this.calls.push("wait");
    return { jobs: sessions.filter((job) => jobIds.includes(job.jobId)), continueIds: jobIds, nextAction: "wait", timedOut: false };
  }
  async followUp(jobId: string, prompt: string): Promise<JobSnapshot> {
    this.calls.push("follow_up");
    return snapshot({ cwd: "/tmp", prompt });
  }
  async abort(jobId: string): Promise<JobSnapshot> {
    this.calls.push("abort");
    return snapshot({ cwd: "/tmp", prompt: jobId });
  }
  async steer(_jobId: string, _message: string, _priority?: Priority): Promise<SteerReceipt> {
    this.calls.push("steer");
    return { messageId: randomUUID(), disposition: "queued" };
  }
  async fork(_jobId: string, prompt: string): Promise<JobSnapshot> {
    this.calls.push("fork");
    return snapshot({ cwd: "/tmp", prompt });
  }
  async answer(): Promise<{ acknowledged: boolean }> {
    this.calls.push("answer");
    return { acknowledged: true };
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
}

describe("MCP tool surface (P1)", () => {
  it("exposes the full contract and dispatches to SchedulerService", async () => {
    const scheduler = new FakeScheduler();
    const gate = async (request: GateRequest): Promise<GateResult> => ({
      passed: true,
      violations: [],
      checks: [{ command: request.commands?.[0] ?? ["true"], exitCode: 0, timedOut: false, log: "" }],
    });
    const server = createServer({
      scheduler,
      schedulerInfo: { available: true, maxConcurrent: 2, maxQueued: 32 },
      gate,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as never);
    const client = new Client({ name: "vitest-p1", version: "0.0.0" });
    await client.connect(clientTransport as never);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "abort",
          "answer",
          "fork",
          "follow_up",
          "gate",
          "init",
          "models",
          "sessions",
          "spawn",
          "spawn_batch",
          "status",
          "steer",
          "wait",
        ].sort(),
      );

      const spawn = await client.callTool({
        name: "spawn",
        arguments: { prompt: "read a file", cwd: "/tmp", model: "glm-5.3", profile: "read" },
      });
      const spawnText = (spawn.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      expect(JSON.parse(spawnText).jobId).toMatch(/^CDT-/);
      // Compact output must not echo the full prompt on any snapshot-returning tool.
      expect(spawnText).not.toContain("read a file");
      expect(spawnText).not.toContain('"prompt"');

      const steer = await client.callTool({
        name: "steer",
        arguments: { jobId: "CDT-1", message: "focus", priority: "next" },
      });
      const steerText = (steer.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      expect(JSON.parse(steerText).disposition).toBe("queued");

      const follow = await client.callTool({
        name: "follow_up",
        arguments: { jobId: "CDT-1", prompt: "continue with a very long private prompt" },
      });
      const followText = (follow.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      expect(followText).not.toContain("very long private prompt");
      expect(followText).not.toContain('"prompt"');

      const answer = await client.callTool({
        name: "answer",
        arguments: { jobId: "CDT-1", requestId: "apr-1", decision: false },
      });
      expect(answer.isError).toBeFalsy();

      const gateResult = await client.callTool({
        name: "gate",
        arguments: { cwd: "/tmp", allowedPaths: ["src"], commands: [["true"]] },
      });
      const gateText = (gateResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
      expect(JSON.parse(gateText).passed).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the tools listed but returns scheduler_unavailable honestly when uncomposed", async () => {
    const unavailable: SchedulerService = new (class {
      private fail(): never {
        throw new Error("scheduler_unavailable:missing modules");
      }
      async spawn(): Promise<JobSnapshot> {
        this.fail();
      }
      async spawnBatch(): Promise<JobSnapshot[]> {
        this.fail();
      }
      status(): JobSnapshot {
        this.fail();
      }
      sessions(): JobSnapshot[] {
        this.fail();
      }
      async wait(): Promise<never> {
        this.fail();
      }
      async followUp(): Promise<JobSnapshot> {
        this.fail();
      }
      async abort(): Promise<JobSnapshot> {
        this.fail();
      }
      async steer(): Promise<never> {
        this.fail();
      }
      async fork(): Promise<JobSnapshot> {
        this.fail();
      }
      async answer(): Promise<never> {
        this.fail();
      }
      async close(): Promise<void> {}
    })() as unknown as SchedulerService;
    const server = createServer({
      scheduler: unavailable,
      schedulerInfo: { available: false, reason: "missing modules", maxConcurrent: 2, maxQueued: 32 },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport as never);
    const client = new Client({ name: "vitest-p1b", version: "0.0.0" });
    await client.connect(clientTransport as never);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("spawn");
      const spawn = await client.callTool({ name: "spawn", arguments: { prompt: "x", cwd: "/tmp" } });
      expect(spawn.isError).toBe(true);
      const text = (spawn.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toContain("scheduler_unavailable");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
