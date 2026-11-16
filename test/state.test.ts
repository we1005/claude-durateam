import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteStateStore, StateStoreError, StoreOwnershipError } from "../src/state/sqlite.js";
import type { JobSnapshot, PreparedTask } from "../src/task-contracts.js";

function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  const task: PreparedTask = {
    cwd: "/tmp/fixture",
    sourceCwd: "/tmp/fixture",
    model: "glm-5.3",
    profile: "edit",
    prompt: "do the thing",
    maxTurns: 5,
    deadlineMs: 60_000,
    allowedPaths: ["src/"],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: true,
    branch: "codex/fixture",
  };
  return {
    jobId: "job-1",
    runId: "run-1",
    attempt: 1,
    sessionId: null,
    state: "running",
    revision: 0,
    nextAction: "wait",
    task,
    modelRequested: "glm-5.3",
    modelReported: "glm-5.3",
    modelSucceeded: null,
    gatePassed: null,
    durationMs: 0,
    toolCallCount: 0,
    latestTextPreview: "",
    lastError: null,
    usage: {
      inputTokens: null,
      outputTokens: 12,
      cacheReadTokens: null,
      sdkCostEstimateUsd: null,
      providerBilledCostUsd: null,
    },
    approvals: [],
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:01.000Z",
    ...overrides,
  };
}

let root = "";
let dbPath = "";
const openStores: SqliteStateStore[] = [];

function track(store: SqliteStateStore): SqliteStateStore {
  openStores.push(store);
  return store;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdt-state-"));
  dbPath = join(root, "state.db");
});

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("SqliteStateStore basic persistence", () => {
  it("round-trips a job snapshot through save/load", () => {
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    store.acquireOwner();
    store.save(snapshot({ approvals: [{ requestId: "req-1", toolName: "Bash", description: "rm -rf build" }] }));
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    const job = loaded[0]!;
    expect(job.jobId).toBe("job-1");
    expect(job.task.branch).toBe("codex/fixture");
    expect(job.task.allowedPaths).toEqual(["src/"]);
    expect(job.usage.outputTokens).toBe(12);
    expect(job.usage.inputTokens).toBeNull();
    expect(job.approvals).toEqual([{ requestId: "req-1", toolName: "Bash", description: "rm -rf build" }]);
  });

  it("persists across close/reopen and rejects revision regressions", () => {
    const first = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    first.acquireOwner();
    first.save(snapshot());
    first.save(snapshot({ state: "succeeded", revision: 2, gatePassed: true }));
    first.close();
    const second = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    second.acquireOwner();
    const loaded = second.load()[0]!;
    expect(loaded.state).toBe("succeeded");
    expect(loaded.revision).toBe(2);
    expect(loaded.gatePassed).toBe(true);
    expect(() => second.save(snapshot({ revision: 1 }))).toThrowError(StateStoreError);
  });

  it("appends ordered events and refuses revision regressions", () => {
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    store.acquireOwner();
    store.save(snapshot());
    store.appendEvent("job-1", 0, { type: "init", sessionId: "s-1" });
    store.appendEvent("job-1", 1, { type: "text", text: "hello", token: "Bearer abcdefghijklmnop" });
    const events = store.loadEvents("job-1", { afterRevision: 0 });
    expect(events.map((event) => event.revision)).toEqual([0, 1]);
    const redacted = JSON.stringify(events[1]!.event);
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(() => store.appendEvent("job-1", 0, { type: "late" })).toThrowError(StateStoreError);
    expect(() => store.appendEvent("missing", 0, {})).toThrowError(StateStoreError);
  });

  it("requires ownership for writes but allows read-only load", () => {
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    expect(() => store.save(snapshot())).toThrowError(StateStoreError);
    expect(() => store.appendEvent("job-1", 0, {})).toThrowError(StateStoreError);
    expect(store.load()).toEqual([]);
  });

  it("records approvals/gates/artifacts and resolves approvals exactly once", () => {
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    store.acquireOwner();
    store.save(snapshot({ approvals: [{ requestId: "req-1", toolName: "Bash", description: "deploy" }] }));
    expect(store.resolveApproval("job-1", "req-1", false)).toBe(true);
    expect(store.resolveApproval("job-1", "req-1", true)).toBe(false);
    expect(store.pendingApprovals("job-1")).toEqual([]);
    expect(store.listApprovals("job-1")[0]?.decision).toBe(false);
    const gateId = store.recordGate("job-1", "run-1", {
      passed: false,
      staticChecksPassed: true,
      testsVerified: false,
      violations: [],
      checks: [],
      logDir: join(root, "logs"),
    });
    expect(gateId).toMatch(/[0-9a-f-]{36}/);
    const artifact = store.recordArtifact("job-1", { kind: "log", path: join(root, "run.log"), bytes: 12 });
    expect(store.listArtifacts("job-1")[0]?.artifactId).toBe(artifact.artifactId);
  });

  it("releases the lease on close; double close is idempotent and closed stores throw", () => {
    const first = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    first.acquireOwner();
    first.close();
    first.close();
    expect(() => first.load()).toThrowError(/closed/);
    const second = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    second.acquireOwner();
    expect(second.ownerInfo()?.pid).toBe(process.pid);
  });

  it("refuses a second live instance in the same process", () => {
    const first = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    first.acquireOwner();
    const second = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    expect(() => second.acquireOwner()).toThrowError(StoreOwnershipError);
    expect(first.ownerInfo()?.pid).toBe(process.pid);
    first.releaseOwner();
    expect(() => second.acquireOwner()).not.toThrow();
  });

  it("treats a stale heartbeat from a dead pid as recoverable", () => {
    const first = new SqliteStateStore({ path: dbPath, registerExitHandler: false });
    first.acquireOwner();
    first.save(snapshot());
    // Simulate a crashed owner: dead pid in the lease, no release.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE leases SET ownerPid = 999999, heartbeatAtMs = ? WHERE leaseId = 'store'").run(Date.now() - 5000);
    raw.close();
    const second = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    second.acquireOwner();
    expect(second.recoveredJobIds).toEqual(["job-1"]);
    const job = second.load()[0]!;
    expect(job.state).toBe("unknown_outcome");
    expect(job.revision).toBe(1);
    expect(job.nextAction).toBe("answer");
    first.close();
  });
});

describe("SqliteStateStore atomic commit (v1.1)", () => {
  it("rolls back snapshot AND event when the event insert is rejected by a real trigger", () => {
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    store.acquireOwner();
    store.save(snapshot({ state: "running", revision: 0, gatePassed: null }));
    expect(store.commit).toBeTypeOf("function");

    const ddl = new DatabaseSync(dbPath);
    ddl.exec("CREATE TRIGGER fail_event_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
    ddl.close();

    const transition = snapshot({ state: "succeeded", revision: 1, gatePassed: true });
    expect(() => store.commit!(transition, { type: "text", text: "done" })).toThrowError(/injected event failure/);

    // Fail-stop must be a full rollback: job row, runs row and events all unchanged.
    const loaded = store.load()[0]!;
    expect(loaded.state).toBe("running");
    expect(loaded.revision).toBe(0);
    expect(loaded.gatePassed).toBeNull();
    expect(store.loadEvents("job-1")).toEqual([]);
    const inspect = new DatabaseSync(dbPath, { readOnly: true });
    expect((inspect.prepare("SELECT state FROM runs WHERE runId = 'run-1'").get() as { state: string }).state).toBe("running");
    expect((inspect.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(0);
    inspect.close();

    // Same transition succeeds once the injected failure is removed.
    const undo = new DatabaseSync(dbPath);
    undo.exec("DROP TRIGGER fail_event_insert");
    undo.close();
    store.commit!(transition, { type: "text", text: "done" });
    const after = store.load()[0]!;
    expect(after.state).toBe("succeeded");
    expect(after.revision).toBe(1);
    expect(after.gatePassed).toBe(true);
    expect(store.loadEvents("job-1").map((event) => event.revision)).toEqual([1]);
  });

  it("keeps ownership and revision guards, and leaves no partial write", () => {
    const unowned = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    expect(() => unowned.commit!(snapshot(), {})).toThrowError(StateStoreError);
    const store = track(new SqliteStateStore({ path: dbPath, registerExitHandler: false }));
    store.acquireOwner();
    store.save(snapshot({ revision: 2, state: "running" }));
    expect(() => store.commit!(snapshot({ revision: 1, state: "succeeded" }), { type: "late" })).toThrowError(
      StateStoreError,
    );
    expect(store.load()[0]!.revision).toBe(2);
    expect(store.loadEvents("job-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------- real processes

interface ChildHandle {
  child: ChildProcess;
  lines: string[];
  waitFor: (needle: string) => Promise<string>;
}

function spawnChild(scriptPath: string, args: string[], env: Record<string, string>): ChildHandle {
  const lines: string[] = [];
  const waiters: Array<{ needle: string; resolve: (line: string) => void }> = [];
  const child = spawn(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onLine = (line: string): void => {
    lines.push(line);
    for (const waiter of waiters.splice(0)) {
      if (line.includes(waiter.needle)) waiter.resolve(line);
      else waiters.push(waiter);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter((entry) => entry.length > 0)) onLine(line);
  });
  child.stderr?.on("data", (chunk: Buffer) => onLine(`STDERR:${chunk.toString("utf8").trim()}`));
  return {
    child,
    lines,
    waitFor: (needle) =>
      new Promise<string>((resolve, reject) => {
        const existing = lines.find((line) => line.includes(needle));
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${needle}; got ${lines.join(" | ")}`)), 15_000);
        waiters.push({
          needle,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      }),
  };
}

function waitExit(handle: ChildHandle): Promise<number | null> {
  return new Promise((resolve, reject) => {
    handle.child.on("exit", (code) => resolve(code));
    setTimeout(() => reject(new Error(`child did not exit: ${handle.lines.join(" | ")}`)), 15_000);
  });
}

function jobStatesFromDisk(path: string): Array<{ jobId: string; state: string; revision: number }> {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare("SELECT jobId, state, revision FROM jobs ORDER BY jobId").all() as unknown as Array<{
      jobId: string;
      state: string;
      revision: number;
    }>;
  } finally {
    raw.close();
  }
}

const CHILD_SCRIPT = `
const mod = await import(process.env.CDT_STATE_MODULE);
const { SqliteStateStore } = mod;
const store = new SqliteStateStore({ path: process.env.CDT_DB, registerExitHandler: false });
const mode = process.argv[2];
if (mode === 'probe') {
  try {
    store.acquireOwner();
  } catch (error) {
    console.log('CONFLICT:' + (error && error.code ? error.code : 'unknown'));
    process.exit(3);
  }
  console.log('ACQUIRED');
  console.log('RECOVERED:' + JSON.stringify(store.recoveredJobIds));
  console.log('AFTER:' + JSON.stringify(store.load().map((job) => [job.jobId, job.state, job.revision, Boolean(job.lastError)])));
  store.close();
  process.exit(0);
}
store.acquireOwner();
store.save(JSON.parse(process.env.CDT_SNAPSHOT));
store.appendEvent('job-1', 0, { type: 'init' });
console.log('READY');
setInterval(() => {}, 1000);
`;

describe("SqliteStateStore real-process ownership and crash recovery", () => {
  it("refuses a second live process, then recovers a SIGKILLed owner as unknown_outcome (no replay)", async () => {
    const scriptPath = join(root, "child.mjs");
    writeFileSync(scriptPath, CHILD_SCRIPT);
    const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "state", "sqlite.js")).href;
    const env = { CDT_STATE_MODULE: moduleUrl, CDT_DB: dbPath, CDT_SNAPSHOT: JSON.stringify(snapshot()) };

    // Process A: real owner with an in-flight `running` job.
    const owner = spawnChild(scriptPath, ["hold"], env);
    await owner.waitFor("READY");

    // Negative control: while the owner is alive, disk state must NOT be recovered.
    expect(jobStatesFromDisk(dbPath)).toEqual([{ jobId: "job-1", state: "running", revision: 0 }]);

    // Process B: must be refused with an ownership conflict, without mutating state.
    const probe1 = spawnChild(scriptPath, ["probe"], env);
    expect(await waitExit(probe1)).toBe(3);
    expect(probe1.lines.join("\n")).toContain("CONFLICT:ownership-conflict");
    expect(jobStatesFromDisk(dbPath)).toEqual([{ jobId: "job-1", state: "running", revision: 0 }]);

    // Simulate a crash: SIGKILL, no release, stale-by-liveness only.
    process.kill(owner.child.pid!, "SIGKILL");
    await waitExit(owner);

    // Process C: takes over and marks the in-flight job unknown_outcome.
    const probe2 = spawnChild(scriptPath, ["probe"], env);
    expect(await waitExit(probe2)).toBe(0);
    expect(probe2.lines.join("\n")).toContain("ACQUIRED");
    expect(probe2.lines.join("\n")).toContain('RECOVERED:["job-1"]');
    const after = jobStatesFromDisk(dbPath);
    expect(after).toEqual([{ jobId: "job-1", state: "unknown_outcome", revision: 1 }]);
  }, 60_000);
});
