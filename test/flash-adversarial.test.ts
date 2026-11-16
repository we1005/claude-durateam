/**
 * Task C — independent adversarial offline integration tests.
 *
 * Real GitWorkspaceService + SqliteStateStore + Scheduler driven by a small
 * deterministic inline test Runner. Temporary real git repositories, no network,
 * no API keys, bounded waits, owned processes only.
 *
 * These tests are intentionally independent of test/scheduler-doubles.ts and
 * re-derive expectations from the public contracts (src/task-contracts.ts,
 * src/scheduler/{scheduler,validation,errors}.ts, src/workspace/*.ts,
 * src/state/sqlite.ts).
 */
import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Scheduler } from "../src/scheduler/index.js";
import { GitWorkspaceService, WorkspaceValidationError, WORKSPACE_LIMITS } from "../src/workspace/index.js";
import { SqliteStateStore, StateStoreError, StoreOwnershipError } from "../src/state/index.js";
import type {
  AgentRunner,
  JobSnapshot,
  PreparedTask,
  RunnerRequest,
  RunnerResult,
  TaskInput,
  WorkerEvent,
} from "../src/task-contracts.js";

// ---------------------------------------------------------------- helpers

const TMP_BASE = mkdtempSync(join(tmpdir(), "flash-adversarial-"));
const CREATED_DIRS: string[] = [];

afterEach(() => {
  for (const dir of CREATED_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(label: string): string {
  const dir = mkdtempSync(join(TMP_BASE, `${label}-`));
  CREATED_DIRS.push(dir);
  return dir;
}

/** Bounded poller — never hangs. */
async function until(condition: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what} after ${ms}ms`);
}

/** Create a real, clean git repository with one committed file under src/.
 * The repo MUST live inside the harness `base` so it is within the workspace
 * service's approved allowedRoots (sibling temp dirs would be rejected as
 * cwd-outside-allowed-roots before the behavior under test is reached). */
function makeGitRepo(parent: string, label: string): { repo: string; repoReal: string } {
  const repo = join(parent, label);
  mkdirSync(repo, { recursive: true });
  CREATED_DIRS.push(repo);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "adversarial@example.invalid"]);
  git(["config", "user.name", "Adversarial QA"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return { repo, repoReal: realpathSync(repo) };
}

function makeWorkspace(base: string): GitWorkspaceService {
  return new GitWorkspaceService({
    allowedRoots: [base],
    worktreeRoot: join(base, "wt-root"),
    limits: {
      // Do not fail on small tmp volumes; keep the other limits at defaults.
      minFreeBytesPerWorktree: 0,
      gitTimeoutMs: WORKSPACE_LIMITS.gitTimeoutMs,
    },
  });
}

interface RunHandle {
  readonly request: RunnerRequest;
  settled: boolean;
  emit(event: WorkerEvent): void;
  resolve(partial?: Partial<RunnerResult>): void;
  reject(error: unknown): void;
}

/** Deterministic in-process runner: runs only settle when the test says so. */
class TestRunner implements AgentRunner {
  readonly runs: RunHandle[] = [];
  steerCalls = 0;

  run(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): Promise<RunnerResult> {
    let settle!: (result: RunnerResult) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<RunnerResult>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const sessionId = `sess-${this.runs.length + 1}`;
    const handle: RunHandle = {
      request,
      settled: false,
      emit: (event) => onEvent(event),
      resolve: (partial = {}) => {
        if (handle.settled) return;
        handle.settled = true;
        settle({
          modelSucceeded: true,
          sessionId,
          modelReported: request.model,
          text: "done",
          error: null,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            sdkCostEstimateUsd: null,
            providerBilledCostUsd: null,
          },
          ...partial,
        });
      },
      reject: (error) => {
        if (handle.settled) return;
        handle.settled = true;
        fail(error);
      },
    };
    this.runs.push(handle);
    // Real runners settle when aborted; keep the scheduler's slot lifecycle honest.
    request.signal.addEventListener(
      "abort",
      () => {
        if (!handle.settled) {
          handle.settled = true;
          const reason = request.signal.reason;
          fail(reason instanceof Error ? reason : new Error("aborted"));
        }
      },
      { once: true },
    );
    return promise;
  }

  async steer(): Promise<{ messageId: string; disposition: "queued" }> {
    this.steerCalls += 1;
    return { messageId: `msg-${this.steerCalls}`, disposition: "queued" };
  }
}

interface Harness {
  scheduler: Scheduler;
  runner: TestRunner;
  store: SqliteStateStore;
  workspace: GitWorkspaceService;
  base: string;
}

function makeHarness(options: { maxConcurrent?: number; maxQueued?: number; base?: string } = {}): Harness {
  const base = options.base ?? freshDir("harness");
  const runner = new TestRunner();
  const workspace = makeWorkspace(base);
  const store = new SqliteStateStore({
    path: join(base, "state", "jobs.db"),
    hostToken: `host-${base.slice(-6)}`,
    leaseTtlMs: 30_000,
    registerExitHandler: false,
  });
  const scheduler = new Scheduler({
    runner,
    workspace,
    store,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxQueued: options.maxQueued ?? 8,
    approvalTimeoutMs: 1_000,
    maxWaitTimeoutMs: 5_000,
    closeGraceMs: 2_000,
    idPrefix: "ADV",
  });
  return { scheduler, runner, store, workspace, base };
}

async function stop(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  try {
    await harness.scheduler.close();
  } catch {
    // close best-effort; ownership release matters more than close errors here
    try {
      harness.store.releaseOwner();
      harness.store.close();
    } catch {
      /* ignore */
    }
  }
}

function editTask(repo: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    cwd: repo,
    prompt: "edit the app",
    profile: "edit",
    ...overrides,
  };
}

function readTask(repo: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    cwd: repo,
    prompt: "review the app",
    profile: "read",
    ...overrides,
  };
}

/** Minimal durable-looking in-flight snapshot (matches assertStoredSnapshot). */
function runningSnapshot(jobId: string): JobSnapshot {
  const now = new Date().toISOString();
  const task: PreparedTask = {
    cwd: "/tmp/does-not-matter",
    sourceCwd: "/tmp/does-not-matter",
    model: "glm-5.3",
    effort: "high",
    profile: "edit",
    prompt: "in-flight when the owner died",
    maxTurns: 5,
    deadlineMs: 60_000,
    allowedPaths: [],
    allowedSkillNames: [],
    enabledMcpServers: [],
    managedWorktree: true,
    branch: "codex/lost",
  };
  return {
    jobId,
    runId: `${jobId}-run-1-deadbeef`,
    attempt: 1,
    sessionId: "sess-lost",
    state: "running",
    revision: 3,
    nextAction: "wait",
    task,
    modelRequested: "glm-5.3",
    modelReported: "glm-5.3",
    modelSucceeded: null,
    gatePassed: null,
    durationMs: 1_000,
    toolCallCount: 2,
    latestTextPreview: "working",
    lastError: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      sdkCostEstimateUsd: null,
      providerBilledCostUsd: null,
    },
    approvals: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------- tests

describe("adversarial: admission atomicity and path policy", () => {
  it("rejects a batch with one bad model/effort without starting any run or creating worktrees", async () => {
    const harness = makeHarness();
    try {
      const { repo } = makeGitRepo(harness.base, "rejectbatch");
      const good = editTask(repo);
      const badModel = editTask(repo, { prompt: "bad model task", model: "gpt-4o" as never });
      const badEffort = editTask(repo, { prompt: "bad effort task", effort: "ultra" as never });

      // Each invalid field is rejected by scheduler admission itself with
      // INVALID_TASK (before the workspace is consulted), tested field by field.
      await expect(harness.scheduler.spawn(badModel)).rejects.toMatchObject({ code: "INVALID_TASK" });
      expect(harness.store.load()).toEqual([]);
      expect(harness.runner.runs).toEqual([]);

      await expect(harness.scheduler.spawn(badEffort)).rejects.toMatchObject({ code: "INVALID_TASK" });
      expect(harness.store.load()).toEqual([]);
      expect(harness.runner.runs).toEqual([]);

      // One invalid member poisons the whole batch, atomically: even the valid
      // task must not start or persist.
      await expect(harness.scheduler.spawnBatch([good, badModel, badEffort])).rejects.toMatchObject({
        code: "INVALID_TASK",
      });
      expect(harness.store.load()).toEqual([]);
      expect(harness.runner.runs).toEqual([]);

      // No managed worktree was created for any batch member.
      const root = join(harness.base, "wt-root");
      const children = existsSync(root) ? readdirSync(root) : [];
      expect(children.filter((entry) => entry.startsWith("wt-"))).toEqual([]);

      // Sanity: the same repo with a valid contract is admissible, proving the
      // rejections above come from the invalid fields, not the fixture.
      const ok = await harness.scheduler.spawnBatch([good]);
      expect(ok).toHaveLength(1);
      await until(() => harness.runner.runs.length === 1, 5_000, "sanity run starts");
      harness.runner.runs[0]!.resolve();
      await harness.scheduler.wait([ok[0]!.jobId], { timeoutMs: 5_000 });
    } finally {
      await stop(harness);
    }
  });

  it("enforces the path allowlist contract: hard-denied, traversal and escaping absolute paths", async () => {
    const harness = makeHarness();
    try {
      const { repo } = makeGitRepo(harness.base, "pathpolicy");
      const workspace = harness.workspace;

      const hardDenied = readTask(repo, { allowedPaths: ["src/", ".env"] });
      await expect(workspace.validateBatch([hardDenied])).rejects.toBeInstanceOf(WorkspaceValidationError);
      const deniedIssues = await workspace.validateBatch([hardDenied]).then(
        () => [],
        (error: WorkspaceValidationError) => error.issues.map((issue) => issue.code),
      );
      expect(deniedIssues).toContain("hard-denied-path");

      const traversal = readTask(repo, { allowedPaths: ["../outside"] });
      await expect(workspace.validateBatch([traversal])).rejects.toBeInstanceOf(WorkspaceValidationError);

      const escaping = readTask(repo, { allowedPaths: ["/etc"] });
      await expect(workspace.validateBatch([escaping])).rejects.toBeInstanceOf(WorkspaceValidationError);
      const escapeIssues = await workspace.validateBatch([escaping]).then(
        () => [],
        (error: WorkspaceValidationError) => error.issues.map((issue) => issue.code),
      );
      expect(escapeIssues).toContain("outside-repo");

      // Scoped, legitimate allowlist for a read task is accepted (READ stays possible
      // even though only writes are scoped — this is the regression guard for the
      // fixed bridge bug where allowedPaths wrongly restricted ordinary reads).
      const scoped = readTask(repo, { allowedPaths: ["src/"] });
      await expect(workspace.validateBatch([scoped])).resolves.toBeUndefined();
    } finally {
      await stop(harness);
    }
  });
});

describe("adversarial: capacity admission under concurrency", () => {
  it("refuses batches that exceed maxConcurrent+maxQueued and rejects further spawns while saturated", async () => {
    const harness = makeHarness({ maxConcurrent: 1, maxQueued: 1 });
    try {
      const { repo } = makeGitRepo(harness.base, "capacity");
      const tasks = [1, 2, 3].map((n) => editTask(repo, { prompt: `task ${n}` }));

      await expect(harness.scheduler.spawnBatch(tasks)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
      expect(harness.runner.runs).toEqual([]);

      // Two fit exactly (1 running + 1 queued).
      const snapshots = await harness.scheduler.spawnBatch(tasks.slice(0, 2));
      expect(snapshots).toHaveLength(2);
      await until(() => harness.runner.runs.length === 1, 3_000, "first run starts");
      expect(harness.scheduler.status(snapshots[0]!.jobId).state).toBe("running");

      // Now holding=1, queued=1: nothing more fits.
      await expect(harness.scheduler.spawn(tasks[2]!)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

      // FIFO order: the first admitted job is the one that started.
      const running = harness.scheduler.sessions({ state: "running" });
      expect(running).toHaveLength(1);
      expect(running[0]!.jobId).toBe(snapshots[0]!.jobId);
    } finally {
      await stop(harness);
    }
  });
});

describe("adversarial: real workspace semantics, effort/model propagation", () => {
  it("prepares read tasks in place and edit tasks in managed worktrees, preserving nondefault effort", async () => {
    const harness = makeHarness({ maxConcurrent: 2 });
    try {
      const { repo, repoReal } = makeGitRepo(harness.base, "propagation");
      const tasks: TaskInput[] = [
        readTask(repo, { allowedPaths: ["src/"] }),
        editTask(repo, { prompt: "edit with effort", effort: "xhigh", model: "glm-5.3-flash", allowedPaths: ["src/"] }),
      ];
      const snapshots = await harness.scheduler.spawnBatch(tasks);
      expect(snapshots).toHaveLength(2);
      await until(() => harness.runner.runs.length === 2, 5_000, "both runs start");

      const [readRun, editRun] = harness.runner.runs;

      // Read profile: no managed worktree; worker runs directly in the source checkout.
      expect(readRun!.request.profile).toBe("read");
      expect(readRun!.request.managedWorktree).toBe(false);
      expect(readRun!.request.branch).toBeNull();
      expect(realpathSync(readRun!.request.cwd)).toBe(repoReal);
      // Default effort is "high" for this bridge and reaches the runner.
      expect(readRun!.request.effort).toBe("high");
      expect(readRun!.request.allowedPaths).toEqual(["src/"]);
      expect(readRun!.request.model).toBe("glm-5.3-flash");

      // Edit profile: managed worktree with its own branch, outside the source repo.
      expect(editRun!.request.profile).toBe("edit");
      expect(editRun!.request.managedWorktree).toBe(true);
      expect(editRun!.request.branch).toMatch(/^codex\//);
      expect(realpathSync(editRun!.request.cwd)).not.toBe(repoReal);
      expect(existsSync(join(editRun!.request.cwd, "src", "app.ts"))).toBe(true);
      // Nondefault effort and requested model survive workspace preparation unchanged.
      expect(editRun!.request.effort).toBe("xhigh");
      expect(editRun!.request.model).toBe("glm-5.3-flash");
      expect(editRun!.request.allowedPaths).toEqual(["src/"]);

      readRun!.resolve();
      editRun!.resolve({ modelReported: "glm-5.3-flash" });
      const result = await harness.scheduler.wait(snapshots.map((snapshot) => snapshot.jobId), { timeoutMs: 5_000 });
      expect(result.timedOut).toBe(false);
      expect(result.nextAction).toBe("finish");
      for (const job of result.jobs) {
        expect(job.state).toBe("succeeded");
        expect(job.modelSucceeded).toBe(true);
        expect(job.sessionId).toBeTypeOf("string");
      }
      expect(result.jobs[1]!.modelReported).toBe("glm-5.3-flash");
    } finally {
      await stop(harness);
    }
  });
});

describe("adversarial: sqlite ownership and crash recovery", () => {
  it("refuses a second same-host owner and recovers in-flight jobs to unknown_outcome on takeover", async () => {
    const base = freshDir("ownership");
    const dbPath = join(base, "state", "jobs.db");
    let fakeNow = 1_000_000;
    const ownerA = new SqliteStateStore({
      path: dbPath,
      hostToken: "host-a",
      leaseTtlMs: 400,
      heartbeatIntervalMs: 0,
      now: () => fakeNow,
      registerExitHandler: false,
    });
    let ownerB: SqliteStateStore | null = null;
    let ownerC: SqliteStateStore | null = null;
    try {
      ownerA.acquireOwner();
      const lost: JobSnapshot = runningSnapshot("ADV-00001");
      ownerA.save(lost);
      expect(ownerA.load().map((job) => job.state)).toEqual(["running"]);

      // Same host, live pid: takeover must be refused even with an old clock.
      fakeNow += 60_000;
      ownerB = new SqliteStateStore({
        path: dbPath,
        hostToken: "host-a",
        leaseTtlMs: 400,
        heartbeatIntervalMs: 0,
        now: () => fakeNow,
        registerExitHandler: false,
      });
      expect(() => ownerB!.acquireOwner()).toThrow(StoreOwnershipError);
      expect(() => ownerB!.save(runningSnapshot("ADV-00002"))).toThrow(StateStoreError);
      expect(ownerB!.load().map((job) => job.jobId)).toEqual(["ADV-00001"]);

      // Owner A "crashes" (never releases). After the cross-host lease window the
      // store may be taken over, and in-flight work must become unknown_outcome —
      // never silently re-claimed as healthy.
      fakeNow += 60_000;
      ownerC = new SqliteStateStore({
        path: dbPath,
        hostToken: "host-b",
        leaseTtlMs: 400,
        heartbeatIntervalMs: 0,
        now: () => fakeNow,
        registerExitHandler: false,
      });
      ownerC!.acquireOwner();
      expect(ownerC!.recoveredJobIds).toEqual(["ADV-00001"]);
      const recovered = ownerC!.load();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.state).toBe("unknown_outcome");
      expect(recovered[0]!.modelSucceeded).toBeNull();
      expect(recovered[0]!.revision).toBeGreaterThan(lost.revision);

      // Resource metadata survives the recovery and stays job-scoped.
      ownerC!.recordArtifact("ADV-00001", { kind: "log", path: "/tmp/adv.log", bytes: 12 });
      expect(ownerC!.listArtifacts("ADV-00001")).toHaveLength(1);
      expect(() => ownerC!.recordArtifact("ADV-99999", { kind: "log", path: "/tmp/x.log" })).toThrow(StateStoreError);
    } finally {
      ownerC?.close();
      ownerB?.close();
      // Owner A is intentionally left "crashed"; closing it here would release the
      // lease we asserted against, so only the handle is dropped.
      try {
        (ownerA as unknown as { db: { close(): void } }).db.close();
      } catch {
        /* already closed */
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("adversarial: resume, fork and abort idempotency", () => {
  it("resumes the same session on followUp and forks into an independent worktree preserving effort", async () => {
    const harness = makeHarness({ maxConcurrent: 3 });
    try {
      const { repo } = makeGitRepo(harness.base, "forkresume");
      const first = await harness.scheduler.spawn(
        editTask(repo, { prompt: "original run", effort: "max", model: "glm-5.3-flash", allowedPaths: ["src/"] }),
      );
      await until(() => harness.runner.runs.length === 1, 5_000, "first run");
      const run1 = harness.runner.runs[0]!;
      expect(run1.request.effort).toBe("max");
      run1.resolve({ sessionId: "sess-root" });
      await harness.scheduler.wait([first.jobId], { timeoutMs: 5_000 });

      // followUp resumes the exact session, no fork.
      const resumed = await harness.scheduler.followUp(first.jobId, "continue please");
      expect(resumed.attempt).toBe(2);
      await until(() => harness.runner.runs.length === 2, 5_000, "second run");
      const run2 = harness.runner.runs[1]!;
      expect(run2.request.resumeSessionId).toBe("sess-root");
      expect(run2.request.forkSession ?? false).toBe(false);
      run2.resolve({ sessionId: "sess-root-2" });
      await harness.scheduler.wait([first.jobId], { timeoutMs: 5_000 });

      // fork creates a new job in an independent managed worktree with inherited contract.
      const forked = await harness.scheduler.fork(first.jobId, "branch off");
      expect(forked.jobId).not.toBe(first.jobId);
      expect(forked.task.effort).toBe("max");
      expect(forked.task.model).toBe("glm-5.3-flash");
      await until(() => harness.runner.runs.length === 3, 5_000, "fork run");
      const run3 = harness.runner.runs[2]!;
      expect(run3.request.jobId).toBe(forked.jobId);
      expect(run3.request.resumeSessionId).toBe("sess-root-2");
      expect(run3.request.forkSession).toBe(true);
      expect(run3.request.effort).toBe("max");
      expect(run3.request.allowedPaths).toEqual(["src/"]);
      expect(realpathSync(run3.request.cwd)).not.toBe(realpathSync(run1.request.cwd));
      run3.resolve({ sessionId: "sess-fork" });
      await harness.scheduler.wait([forked.jobId], { timeoutMs: 5_000 });
    } finally {
      await stop(harness);
    }
  });

  it("abort is idempotent, ignores late runner callbacks and frees the concurrency slot", async () => {
    const harness = makeHarness({ maxConcurrent: 1, maxQueued: 8 });
    try {
      const { repo } = makeGitRepo(harness.base, "abort");
      const first = await harness.scheduler.spawn(editTask(repo, { prompt: "abort me" }));
      await until(() => harness.runner.runs.length === 1, 5_000, "first run");
      const handle = harness.runner.runs[0]!;

      handle.emit({ type: "text", text: "partial output before abort" });
      const aborted = await harness.scheduler.abort(first.jobId);
      expect(aborted.state).toBe("cancelled");
      const revisionAtAbort = aborted.revision;

      // Second abort on the terminal job returns the same persisted snapshot.
      const again = await harness.scheduler.abort(first.jobId);
      expect(again.state).toBe("cancelled");
      expect(again.revision).toBe(revisionAtAbort);

      // The abort signal reached the runner exactly once; run rejects asynchronously.
      await until(() => handle.settled, 2_000, "runner settles after abort");

      // Late events and a late result must not resurrect the job.
      handle.emit({ type: "text", text: "late text" });
      handle.emit({ type: "tool_start", toolName: "Bash" });
      handle.resolve({ text: "late completion" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const after = harness.scheduler.status(first.jobId);
      expect(after.state).toBe("cancelled");
      expect(after.revision).toBe(revisionAtAbort);
      expect(after.latestTextPreview).not.toBe("late text");
      expect(after.toolCallCount).toBe(0);

      // Slot is released once the runner promise settles: capacity is available again.
      const second = await harness.scheduler.spawn(editTask(repo, { prompt: "second task" }));
      await until(() => harness.runner.runs.length === 2, 5_000, "second run starts after abort");
      expect(harness.runner.runs[1]!.request.jobId).toBe(second.jobId);
      harness.runner.runs[1]!.resolve();
      await harness.scheduler.wait([second.jobId], { timeoutMs: 5_000 });
    } finally {
      await stop(harness);
    }
  });
});
