/**
 * Independent acceptance integration suite (offline).
 *
 * Uses the real MCP stdio surface, real Scheduler, GitWorkspaceService,
 * SqliteStateStore and gate, with an explicitly injected QA fake runner
 * (src/scripts/acceptance-mcp-fixture.ts). No provider credentials, no network.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(repoRoot, "src", "scripts", "acceptance-mcp-fixture.ts");

interface FixturePaths {
  root: string;
  repo: string;
  worktreeRoot: string;
  stateDb: string;
  fakeLog: string;
  home: string;
}

interface Session {
  fixture: FixturePaths;
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
  pid?: number;
  killed: boolean;
}

interface McpCall {
  payload: Record<string, unknown>;
  isError: boolean;
  text: string;
}

const openSessions: Session[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const session of openSessions.splice(0)) {
    if (!session.killed) {
      try {
        await session.client.close();
      } catch {
        /* child may already be gone */
      }
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "QA",
      GIT_AUTHOR_EMAIL: "qa@example.invalid",
      GIT_COMMITTER_NAME: "QA",
      GIT_COMMITTER_EMAIL: "qa@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function makeFixture(): FixturePaths {
  const root = mkdtempSync(join(tmpdir(), "cdt-int-"));
  roots.push(root);
  const repo = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  const stateDb = join(root, "state", "state.db");
  mkdirSync(dirname(stateDb), { recursive: true });
  const fakeLog = join(root, "fake-runner.jsonl");

  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "qa@example.invalid"]);
  git(repo, ["config", "user.name", "QA"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return { root, repo, worktreeRoot, stateDb, fakeLog, home };
}

function fixtureEnv(fixture: FixturePaths, options: { cap?: number; maxQueued?: number; abortDelayMs?: number; triggerFail?: boolean } = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: fixture.home,
    CLAUDE_DURATEAM_KEY_FILE: join(fixture.home, "absent-key.txt"),
    CDT_QA_FIXTURE_ROOT: fixture.repo,
    CDT_QA_WORKTREE_ROOT: fixture.worktreeRoot,
    CDT_QA_STATE_DB: fixture.stateDb,
    CDT_QA_FAKE_LOG: fixture.fakeLog,
    CDT_QA_MAX_CONCURRENT: String(options.cap ?? 2),
    CDT_QA_MAX_QUEUED: String(options.maxQueued ?? 8),
    CDT_QA_ABORT_DELAY_MS: String(options.abortDelayMs ?? 100),
    ...(options.triggerFail ? { CDT_QA_TRIGGER_FAIL_EVENTS: "1" } : {}),
  };
}

async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs = 10_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== false) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error("waitFor timed out");
}

async function startSession(
  fixture: FixturePaths,
  options: { cap?: number; maxQueued?: number; abortDelayMs?: number; triggerFail?: boolean } = {},
): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fixturePath],
    env: fixtureEnv(fixture, options),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr.push(chunk.toString());
  });
  const client = new Client({ name: "claude-durateam-qa-integration", version: "0.1.0" });
  const session: Session = { fixture, client, transport, stderr, killed: false };
  openSessions.push(session);
  await client.connect(transport);
  await waitFor(async () => {
    const text = stderr.join("");
    const match = /"event":"qa.launcher.started".*"pid":(\d+)/.exec(text);
    if (!match) return false;
    session.pid = Number(match[1]);
    return true;
  }, 15_000);
  return session;
}

async function call(session: Session, name: string, args: Record<string, unknown>): Promise<McpCall> {
  const result = await session.client.callTool({ name, arguments: args });
  const block = (result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text");
  const text = block?.text ?? "";
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = { raw: text };
  }
  return { payload, isError: result.isError === true, text };
}

async function ok(session: Session, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await call(session, name, args);
  expect(result.isError, `${name} should succeed: ${result.text}`).toBe(false);
  return result.payload;
}

async function err(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(session, name, args);
  expect(result.isError, `${name} should fail: ${result.text}`).toBe(true);
  const error = result.payload["error"] as { message?: string } | undefined;
  return error?.message ?? result.text;
}

function fakeLog(fixture: FixturePaths): Array<Record<string, unknown>> {
  if (!existsSync(fixture.fakeLog)) return [];
  return readFileSync(fixture.fakeLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function status(session: Session, jobId: string): Promise<Record<string, unknown>> {
  return ok(session, "status", { jobId });
}

async function sessions(session: Session): Promise<Array<Record<string, unknown>>> {
  const payload = await ok(session, "sessions", { limit: 100 });
  return payload["jobs"] as Array<Record<string, unknown>>;
}

async function waitUntilState(
  session: Session,
  jobId: string,
  wanted: string[],
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const job = await status(session, jobId);
    return wanted.includes(String(job["state"])) ? job : false;
  }, timeoutMs, 40);
}

describe("acceptance integration: MCP stdio + real scheduler/workspace/SQLite with QA fake runner", () => {
  it("spawn is async; responses stay compact and omit the long prompt; logs are stderr-only", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture);
    const marker = `PROMPT-${randomUUID()}`;
    const longPrompt = `QA_HANG ${marker} ${"x".repeat(15_000)}`;
    const started = Date.now();
    const snapshot = await ok(session, "spawn", { prompt: longPrompt, cwd: fixture.repo, profile: "read" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(["queued", "starting", "running"]).toContain(String(snapshot["state"]));
    const jobId = String(snapshot["jobId"]);

    const init = await ok(session, "init", {});
    expect((init["scheduler"] as Record<string, unknown>)["available"]).toBe(true);
    expect((init["scheduler"] as Record<string, unknown>)["maxConcurrent"]).toBe(2);

    await waitUntilState(session, jobId, ["running"]);
    const statusPayload = await status(session, jobId);
    const waitPayload = await ok(session, "wait", { jobId, timeoutMs: 500 });
    const sessionsPayload = { jobs: await sessions(session) };
    const combined = JSON.stringify([snapshot, init, statusPayload, waitPayload, sessionsPayload]);
    expect(combined.includes(marker)).toBe(false);
    expect(combined.length).toBeLessThan(20_000);
    expect(session.stderr.join("").includes("qa.launcher.started")).toBe(true);
    await ok(session, "abort", { jobId });
  }, 30_000);

  it("spawn_batch with one bad item starts zero jobs and zero runners", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture);
    const before = fakeLog(fixture).length;
    const error = await err(session, "spawn_batch", {
      tasks: [
        { prompt: "valid read", cwd: fixture.repo, profile: "read" },
        { prompt: "bad cwd", cwd: join(fixture.root, "does-not-exist"), profile: "read" },
      ],
    });
    expect(error).toMatch(/workspace|validate|invalid/i);
    expect((await sessions(session)).length).toBe(0);
    expect(fakeLog(fixture).length).toBe(before);
  }, 20_000);

  it("two edit tasks get independent real worktrees, branches and files", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { cap: 2 });
    const snapshots = (await ok(session, "spawn_batch", {
      tasks: [
        { prompt: "QA_WRITE first", cwd: fixture.repo, profile: "edit", allowedPaths: ["."] },
        { prompt: "QA_WRITE second", cwd: fixture.repo, profile: "edit", allowedPaths: ["."] },
      ],
    })) as unknown as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(2);
    const jobs = snapshots.map((entry) => String(entry["jobId"]));
    const first = await waitUntilState(session, jobs[0]!, ["succeeded"]);
    const second = await waitUntilState(session, jobs[1]!, ["succeeded"]);
    const firstTask = first["task"] as Record<string, unknown>;
    const secondTask = second["task"] as Record<string, unknown>;
    const firstCwd = String(firstTask["cwd"]);
    const secondCwd = String(secondTask["cwd"]);
    expect(firstCwd).not.toBe(secondCwd);
    expect(firstCwd).not.toBe(fixture.repo);
    expect(secondCwd).not.toBe(fixture.repo);
    expect(firstTask["managedWorktree"]).toBe(true);
    expect(secondTask["managedWorktree"]).toBe(true);
    expect(String(firstTask["branch"])).not.toBe(String(secondTask["branch"]));
    expect(existsSync(join(firstCwd, `qa-output-${jobs[0]}.txt`))).toBe(true);
    expect(existsSync(join(secondCwd, `qa-output-${jobs[1]}.txt`))).toBe(true);
    expect(git(fixture.repo, ["status", "--porcelain"]).trim()).toBe("");
    const listed = git(fixture.repo, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain(firstCwd);
    expect(listed).toContain(secondCwd);
  }, 30_000);

  it("concurrency respects caps 1, 2 and 3; queued jobs do not run early", async () => {
    for (const cap of [1, 2, 3]) {
      const fixture = makeFixture();
      const session = await startSession(fixture, { cap });
      const total = cap + 2;
      const snapshots = (await ok(session, "spawn_batch", {
        tasks: Array.from({ length: total }, (_, index) => ({
          prompt: `QA_HANG cap${cap} task${index}`,
          cwd: fixture.repo,
          profile: "read",
        })),
      })) as unknown as Array<Record<string, unknown>>;
      const ids = snapshots.map((entry) => String(entry["jobId"]));
      await waitFor(async () => {
        const jobs = await sessions(session);
        return jobs.filter((job) => ["starting", "running"].includes(String(job["state"]))).length >= cap;
      }, 10_000);
      const jobs = await sessions(session);
      const active = jobs.filter((job) => ["starting", "running"].includes(String(job["state"]))).length;
      const queued = jobs.filter((job) => String(job["state"]) === "queued").length;
      expect(active).toBeLessThanOrEqual(cap);
      expect(active).toBe(cap);
      expect(queued).toBe(total - cap);
      for (const id of ids) await ok(session, "abort", { jobId: id });
      await session.client.close();
      session.killed = true;
    }
  }, 60_000);

  it("late abort keeps the slot until the runner settles; queued abort never starts a runner", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { cap: 2, abortDelayMs: 800 });
    const snapshots = (await ok(session, "spawn_batch", {
      tasks: [
        { prompt: "QA_HANG A", cwd: fixture.repo, profile: "read" },
        { prompt: "QA_HANG B", cwd: fixture.repo, profile: "read" },
        { prompt: "QA_HANG C", cwd: fixture.repo, profile: "read" },
      ],
    })) as unknown as Array<Record<string, unknown>>;
    const [a, b, c] = snapshots.map((entry) => String(entry["jobId"]));
    await waitFor(async () => {
      const jobs = await sessions(session);
      const active = jobs.filter((job) => ["starting", "running"].includes(String(job["state"]))).length;
      const queued = jobs.filter((job) => String(job["state"]) === "queued").length;
      return active === 2 && queued === 1;
    }, 10_000);

    await ok(session, "abort", { jobId: a! });
    const afterAbort = await status(session, a!);
    expect(afterAbort["state"]).toBe("cancelled");
    await ok(session, "abort", { jobId: c! });
    expect((await status(session, c!))["state"]).toBe("cancelled");

    const d = await ok(session, "spawn", { prompt: "QA_HANG D", cwd: fixture.repo, profile: "read" });
    expect(d["state"]).toBe("queued");
    await waitUntilState(session, String(d["jobId"]), ["running"], 10_000);
    const log = fakeLog(fixture);
    expect(log.filter((entry) => entry["event"] === "run_start" && entry["jobId"] === c).length).toBe(0);
    expect(log.filter((entry) => entry["event"] === "run_start" && entry["jobId"] === String(d["jobId"])).length).toBe(1);
    await ok(session, "abort", { jobId: b! });
    await ok(session, "abort", { jobId: String(d["jobId"]) });
  }, 30_000);

  it("wait short timeout does not change the job or its revision", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture);
    const snapshot = await ok(session, "spawn", { prompt: "QA_HANG wait", cwd: fixture.repo, profile: "read" });
    const jobId = String(snapshot["jobId"]);
    const running = await waitUntilState(session, jobId, ["running"]);
    const revision = running["revision"];
    const started = Date.now();
    const waited = await ok(session, "wait", { jobId, timeoutMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(waited["timedOut"]).toBe(true);
    expect((waited["jobs"] as Array<Record<string, unknown>>)[0]!["state"]).toBe("running");
    expect((waited["jobs"] as Array<Record<string, unknown>>)[0]!["revision"]).toBe(revision);
    expect(waited["continueIds"]).toEqual([jobId]);
    expect(waited["nextAction"]).toBe("wait");
    await ok(session, "abort", { jobId });
  }, 20_000);

  it("follow_up passes the exact session UUID and keeps the session", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture);
    const first = await ok(session, "spawn", { prompt: "initial", cwd: fixture.repo, profile: "read" });
    const jobId = String(first["jobId"]);
    const done = await waitUntilState(session, jobId, ["succeeded"]);
    const sessionId = String(done["sessionId"]);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const follow = await ok(session, "follow_up", { jobId, prompt: "QA_STALE_APPROVAL follow" });
    expect(String(follow["runId"])).not.toBe(String(done["runId"]));
    expect(Number(follow["attempt"])).toBe(2);
    await waitUntilState(session, jobId, ["succeeded"]);
    const run = fakeLog(fixture).find(
      (entry) => entry["event"] === "run_start" && entry["jobId"] === jobId && entry["runId"] === String(follow["runId"]),
    );
    expect(run?.["resumeSessionId"]).toBe(sessionId);
    expect(run?.["forkSession"]).toBe(false);
    expect(String((await status(session, jobId))["sessionId"])).toBe(sessionId);
    const stale = fakeLog(fixture).find(
      (entry) => entry["event"] === "stale_approval_result" && entry["jobId"] === jobId,
    );
    expect(stale?.["approved"]).toBe(false);
    expect((await ok(session, "answer", { jobId, requestId: `QA-STALE-${jobId}`, decision: true }))["acknowledged"]).toBe(false);
  }, 30_000);

  it("fork creates a new worktree and passes parent UUID plus forkSession=true", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { cap: 2 });
    const source = await ok(session, "spawn", { prompt: "QA_WRITE source", cwd: fixture.repo, profile: "edit", allowedPaths: ["."] });
    const sourceId = String(source["jobId"]);
    const done = await waitUntilState(session, sourceId, ["succeeded"]);
    const sourceTask = done["task"] as Record<string, unknown>;
    const sourceSession = String(done["sessionId"]);
    const forked = await ok(session, "fork", { jobId: sourceId, prompt: "QA_WRITE fork" });
    const forkId = String(forked["jobId"]);
    expect(["queued", "starting", "running", "succeeded"]).toContain(String(forked["state"]));
    await waitUntilState(session, forkId, ["succeeded"]);
    const forkDone = await status(session, forkId);
    const forkTask = forkDone["task"] as Record<string, unknown>;
    expect(String(forkTask["cwd"])).not.toBe(String(sourceTask["cwd"]));
    expect(String(forkTask["branch"])).not.toBe(String(sourceTask["branch"]));
    expect(forkDone["sessionId"]).not.toBe(sourceSession);
    const run = fakeLog(fixture).find((entry) => entry["event"] === "run_start" && entry["jobId"] === forkId);
    expect(run?.["resumeSessionId"]).toBe(sourceSession);
    expect(run?.["forkSession"]).toBe(true);
    expect(git(fixture.repo, ["worktree", "list", "--porcelain"])).toContain(String(forkTask["cwd"]));
  }, 30_000);

  it("approval rejects wrong job/request and accepts only the real pending request", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { cap: 2 });
    const made = (await ok(session, "spawn_batch", {
      tasks: [
        { prompt: "QA_APPROVAL first", cwd: fixture.repo, profile: "read" },
        { prompt: "QA_APPROVAL second", cwd: fixture.repo, profile: "read" },
      ],
    })) as unknown as Array<Record<string, unknown>>;
    const [a, b] = made.map((entry) => String(entry["jobId"]));
    const statusA = await waitUntilState(session, a!, ["needs_attention"]);
    const statusB = await waitUntilState(session, b!, ["needs_attention"]);
    const reqA = String((statusA["approvals"] as Array<Record<string, unknown>>)[0]!["requestId"]);
    const reqB = String((statusB["approvals"] as Array<Record<string, unknown>>)[0]!["requestId"]);
    expect(reqA).not.toBe(reqB);

    expect((await ok(session, "answer", { jobId: a!, requestId: reqB, decision: true }))["acknowledged"]).toBe(false);
    expect((await ok(session, "answer", { jobId: b!, requestId: reqA, decision: true }))["acknowledged"]).toBe(false);
    expect((await ok(session, "answer", { jobId: a!, requestId: reqA, decision: true }))["acknowledged"]).toBe(true);
    await waitUntilState(session, a!, ["succeeded"]);
    expect((await ok(session, "answer", { jobId: b!, requestId: reqB, decision: false }))["acknowledged"]).toBe(true);
    await waitUntilState(session, b!, ["failed"]);
  }, 30_000);

  it("restart does not replay an in-flight job; it becomes unknown_outcome and does not hold the old slot", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { cap: 1, abortDelayMs: 1_000 });
    const snapshot = await ok(session, "spawn", { prompt: "QA_HANG crash", cwd: fixture.repo, profile: "read" });
    const jobId = String(snapshot["jobId"]);
    await waitUntilState(session, jobId, ["running"]);
    expect(session.pid).toBeTruthy();

    const second = spawnSync(process.execPath, ["--import", "tsx", fixturePath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: fixtureEnv(fixture, { cap: 1 }),
    });
    expect(second.status).toBe(3);
    expect(second.stderr).toContain("ownership");

    const startsBefore = fakeLog(fixture).filter((entry) => entry["event"] === "run_start" && entry["jobId"] === jobId).length;
    process.kill(session.pid!, "SIGKILL");
    session.killed = true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));

    const restarted = await startSession(fixture, { cap: 1, abortDelayMs: 1_000 });
    const recovered = await status(restarted, jobId);
    expect(recovered["state"]).toBe("unknown_outcome");
    expect(String(recovered["lastError"])).toMatch(/recovered|unknown/i);
    const startsAfter = fakeLog(fixture).filter((entry) => entry["event"] === "run_start" && entry["jobId"] === jobId).length;
    expect(startsAfter).toBe(startsBefore);
    const fresh = await ok(restarted, "spawn", { prompt: "QA_HANG after restart", cwd: fixture.repo, profile: "read" });
    const freshId = String(fresh["jobId"]);
    await waitUntilState(restarted, freshId, ["running"]);
    await ok(restarted, "abort", { jobId: freshId });
  }, 40_000);

  it("real SQLite event-trigger failure rolls back the commit and fail-stops the scheduler", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture, { triggerFail: true });
    const spawnError = await err(session, "spawn", { prompt: "trigger failure", cwd: fixture.repo, profile: "read" });
    expect(spawnError).toMatch(/persist|trigger|fatal|failed/i);
    expect((await sessions(session)).length).toBe(0);
    expect(fakeLog(fixture).length).toBe(0);

    const db = new DatabaseSync(fixture.stateDb);
    try {
      const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
      const events = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
      expect(jobs.n).toBe(0);
      expect(events.n).toBe(0);
    } finally {
      db.close();
    }

    const second = await err(session, "spawn", { prompt: "after fatal", cwd: fixture.repo, profile: "read" });
    expect(second).toMatch(/fatal|failed state|persistence/i);
    expect(fakeLog(fixture).length).toBe(0);
  }, 30_000);

  it("gate runs the real command and reports its real non-zero exit", async () => {
    const fixture = makeFixture();
    const session = await startSession(fixture);
    const gate = await ok(session, "gate", {
      cwd: fixture.repo,
      allowedPaths: [],
      commands: [["/bin/sh", "-c", "exit 7"]],
    });
    expect(gate["passed"]).toBe(false);
    expect(gate["testsVerified"]).toBe(false);
    const checks = gate["checks"] as Array<Record<string, unknown>>;
    expect(checks).toHaveLength(1);
    expect(checks[0]!["exitCode"]).toBe(7);
    expect(checks[0]!["timedOut"]).toBe(false);
    expect((gate["violations"] as string[]).some((entry) => entry.includes("check-failed"))).toBe(true);
    expect(existsSync(String(gate["logDir"]))).toBe(true);
  }, 30_000);
});
