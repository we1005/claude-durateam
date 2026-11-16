/**
 * Explicit live acceptance driver (QA-owned, offline by default).
 *
 * Live execution is intentionally opt-in and refuses to start without:
 *   --execute --authorized-by <id> --candidate-sha <sha>
 * plus CLAUDE_DURATEAM_KEY_FILE in the environment (path handle only; this
 * driver never reads or prints its value).
 *
 * It launches the PRODUCTION dist/main.js via the official MCP stdio client.
 * It never uses src/scripts/acceptance-mcp-fixture.ts. No model request is made
 * unless --execute is supplied.
 *
 * Live budget: at most 5 tiny SDK runs:
 *   A edit, B edit, A follow_up, D (observed running then abort), E fork.
 * C is queued and cancelled without a model call.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distMain = join(repoRoot, "dist", "main.js");

interface Options {
  dryRun: boolean;
  execute: boolean;
  authorizedBy: string | null;
  candidateSha: string | null;
  timeoutMs: number;
  model: "glm-5.3" | "glm-5.3-flash";
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

interface Fixture {
  root: string;
  repo: string;
  worktreeRoot: string;
  stateDb: string;
  home: string;
  runtime: string;
  gateLog: string;
  keyFileForDryRun: string;
}

interface RunSession {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
  pid: number | null;
  fixture: Fixture;
  sampler: ProcessSampler | null;
  rpcLogPath: string;
}

interface McpResult {
  payload: Record<string, unknown>;
  isError: boolean;
  text: string;
}

interface JobView {
  jobId: string;
  runId: string;
  state: string;
  sessionId: string | null;
  modelReported: string | null;
  toolCallCount: number;
  latestTextPreview: string;
  approvals: Array<Record<string, unknown>>;
  task: Record<string, unknown>;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, execute: false, authorizedBy: null, candidateSha: null, timeoutMs: 180_000, model: "glm-5.3", effort: "high" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--authorized-by":
        options.authorizedBy = argv[++index] ?? null;
        break;
      case "--candidate-sha":
        options.candidateSha = argv[++index] ?? null;
        break;
      case "--model": {
        const model = argv[++index];
        if (model !== "glm-5.3" && model !== "glm-5.3-flash") throw new Error("--model must be glm-5.3 or glm-5.3-flash");
        options.model = model;
        break;
      }
      case "--effort": {
        const effort = argv[++index];
        if (!["low", "medium", "high", "xhigh", "max"].includes(effort ?? "")) throw new Error("invalid --effort");
        options.effort = effort as Options["effort"];
        break;
      }
      case "--timeout-ms": {
        const value = Number.parseInt(argv[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 30_000 || value > 600_000) throw new Error("--timeout-ms must be 30000..600000");
        options.timeoutMs = value;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.dryRun && options.execute) throw new Error("choose --dry-run or --execute, not both");
  if (!options.dryRun && !options.execute) throw new Error("explicit --dry-run or --execute is required");
  return options;
}

function git(scope: string, args: string[]): string {
  const result = spawnSync("git", ["-C", scope, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function sourceFingerprint(candidate: string | null): { head: string; dirty: string; distSha256: string } {
  if (!existsSync(distMain)) throw new Error(`production binary not found: ${distMain}; run npm run build`);
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const dirty = git(repoRoot, ["status", "--porcelain=v1"]).trim();
  const distSha256 = createHash("sha256").update(readFileSync(distMain)).digest("hex");
  if (candidate && !head.startsWith(candidate)) throw new Error(`candidate ${candidate} does not match HEAD ${head}`);
  return { head, dirty, distSha256 };
}

function makeFixture(root: string, gateLogRoot: string): Fixture {
  const repo = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const gateLog = gateLogRoot;
  for (const dir of [repo, worktreeRoot, stateDir, home, runtime, gateLog]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "QA",
    GIT_AUTHOR_EMAIL: "qa@example.invalid",
    GIT_COMMITTER_NAME: "QA",
    GIT_COMMITTER_EMAIL: "qa@example.invalid",
  };
  const runGit = (args: string[]): string => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout;
  };
  runGit(["init", "-q"]);
  runGit(["config", "user.email", "qa@example.invalid"]);
  runGit(["config", "user.name", "QA"]);
  writeFileSync(join(repo, "README.md"), "live fixture\n");
  writeFileSync(join(repo, "target-a.txt"), "base-a\n");
  writeFileSync(join(repo, "target-b.txt"), "base-b\n");
  for (let index = 1; index <= 4; index += 1) writeFileSync(join(repo, `f${index}.txt`), `file ${index}\n`);
  runGit(["add", "."]);
  runGit(["commit", "-q", "-m", "base"]);
  return {
    root,
    repo,
    worktreeRoot,
    stateDb: join(stateDir, "state.db"),
    home,
    runtime,
    gateLog,
    keyFileForDryRun: join(home, "absent-key.txt"),
  };
}

function bridgeEnv(fixture: Fixture, keyFile: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: fixture.home,
    TMPDIR: join(fixture.root, "tmp"),
    CLAUDE_DURATEAM_KEY_FILE: keyFile,
    CLAUDE_DURATEAM_RUNTIME: fixture.runtime,
    CLAUDE_DURATEAM_STATE_DB: fixture.stateDb,
    CLAUDE_DURATEAM_WORKTREE_ROOT: fixture.worktreeRoot,
    CLAUDE_DURATEAM_ALLOWED_ROOTS: fixture.repo,
    CLAUDE_DURATEAM_GATE_LOG_ROOT: fixture.gateLog,
    CLAUDE_DURATEAM_WIRE_AUDIT: join(dirname(fixture.gateLog), "wire-metadata.jsonl"),
    CLAUDE_DURATEAM_MAX_CONCURRENT: "2",
    CLAUDE_DURATEAM_MAX_QUEUED: "4",
  };
}

async function waitFor<T>(fn: () => Promise<T | false>, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms${lastError ? `; last error: ${String(lastError)}` : ""}`);
}

function parseMcp(result: { content?: unknown; isError?: boolean }): McpResult {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.find((block) => block.type === "text")?.text ?? "";
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = { raw: text };
  }
  return { payload, isError: result.isError === true, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTaskInput(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    cwd: value["cwd"] ?? null,
    model: value["model"] ?? null,
    effort: value["effort"] ?? "high",
    profile: value["profile"] ?? null,
    maxTurns: value["maxTurns"] ?? null,
    deadlineMs: value["deadlineMs"] ?? null,
    allowedPaths: value["allowedPaths"] ?? null,
    allowedSkillNames: value["allowedSkillNames"] ?? null,
    enabledMcpServers: value["enabledMcpServers"] ?? null,
  };
}

function safeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "spawn") return safeTaskInput(args) ?? {};
  if (name === "spawn_batch") {
    const tasks = Array.isArray(args["tasks"]) ? args["tasks"].map(safeTaskInput) : [];
    return { tasks };
  }
  if (name === "gate") {
    return {
      cwd: args["cwd"] ?? null,
      allowedPaths: args["allowedPaths"] ?? null,
      commands: args["commands"] ?? null,
      timeoutMs: args["timeoutMs"] ?? null,
    };
  }
  if (name === "wait") return { jobId: args["jobId"] ?? null, jobIds: args["jobIds"] ?? null, afterRevision: args["afterRevision"] ?? null, timeoutMs: args["timeoutMs"] ?? null };
  return { jobId: args["jobId"] ?? null, requestId: args["requestId"] ?? null, decision: args["decision"] ?? null, priority: args["priority"] ?? null };
}

function safeSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const task = isRecord(value["task"]) ? value["task"] : {};
  const approvals = Array.isArray(value["approvals"])
    ? value["approvals"].filter(isRecord).map((approval) => ({ requestId: approval["requestId"], toolName: approval["toolName"] }))
    : [];
  return {
    jobId: value["jobId"],
    runId: value["runId"],
    attempt: value["attempt"],
    state: value["state"],
    sessionId: value["sessionId"],
    revision: value["revision"],
    modelRequested: value["modelRequested"],
    modelReported: value["modelReported"],
    modelSucceeded: value["modelSucceeded"],
    toolCallCount: value["toolCallCount"],
    lastError: value["lastError"],
    task: {
      cwd: task["cwd"] ?? null,
      model: task["model"] ?? null,
      profile: task["profile"] ?? null,
      managedWorktree: task["managedWorktree"] ?? null,
      branch: task["branch"] ?? null,
    },
    approvals,
  };
}

function safeResult(name: string, result: McpResult): Record<string, unknown> {
  if (result.isError) {
    const error = isRecord(result.payload["error"]) ? result.payload["error"] : {};
    return { isError: true, error: error["message"] ?? null };
  }
  const payload = result.payload;
  if (Array.isArray(payload)) return { jobs: payload.map(safeSnapshot) };
  if (Array.isArray(payload["jobs"])) {
    return {
      jobs: payload["jobs"].map(safeSnapshot),
      continueIds: payload["continueIds"] ?? null,
      nextAction: payload["nextAction"] ?? null,
      timedOut: payload["timedOut"] ?? null,
    };
  }
  if (typeof payload["jobId"] === "string") return safeSnapshot(payload) ?? {};
  if (name === "gate") {
    return {
      passed: payload["passed"] ?? null,
      testsVerified: payload["testsVerified"] ?? null,
      checks: Array.isArray(payload["checks"])
        ? payload["checks"].filter(isRecord).map((check) => ({
            command: check["command"] ?? null,
            exitCode: check["exitCode"] ?? null,
            timedOut: check["timedOut"] ?? null,
            log: check["log"] ?? null,
          }))
        : [],
      violations: payload["violations"] ?? null,
      logDir: payload["logDir"] ?? null,
    };
  }
  if (name === "init") {
    const credential = isRecord(payload["credential"]) ? payload["credential"] : {};
    return {
      baseUrl: payload["baseUrl"] ?? null,
      scheduler: payload["scheduler"] ?? null,
      credentialConfigured: credential["configured"] ?? null,
      models: payload["models"] ?? null,
    };
  }
  if (name === "models") return { allowed: payload["allowed"] ?? null, default: payload["default"] ?? null, noFallback: payload["noFallback"] ?? null };
  if (name === "steer") return { messageId: payload["messageId"] ?? null, disposition: payload["disposition"] ?? null };
  if (name === "answer") return { acknowledged: payload["acknowledged"] ?? null };
  return { fields: Object.keys(payload) };
}

async function mcpCall(session: RunSession, name: string, args: Record<string, unknown>): Promise<McpResult> {
  const result = parseMcp(await session.client.callTool({ name, arguments: args }));
  try {
    appendFileSync(
      session.rpcLogPath,
      `${JSON.stringify({ ts: new Date().toISOString(), tool: name, args: safeArgs(name, args), result: safeResult(name, result) })}\n`,
      { mode: 0o600 },
    );
  } catch {
    throw new Error("evidence_log_write_failed");
  }
  return result;
}
async function mcpOk(session: RunSession, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcpCall(session, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.payload;
}

async function mcpError(session: RunSession, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await mcpCall(session, name, args);
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded: ${result.text}`);
  const error = result.payload["error"] as { message?: string } | undefined;
  return error?.message ?? result.text;
}

function jobView(payload: Record<string, unknown>): JobView {
  return {
    jobId: String(payload["jobId"] ?? ""),
    runId: String(payload["runId"] ?? ""),
    state: String(payload["state"] ?? ""),
    sessionId: typeof payload["sessionId"] === "string" ? (payload["sessionId"] as string) : null,
    modelReported: typeof payload["modelReported"] === "string" ? (payload["modelReported"] as string) : null,
    toolCallCount: Number(payload["toolCallCount"] ?? 0),
    latestTextPreview: String(payload["latestTextPreview"] ?? ""),
    approvals: Array.isArray(payload["approvals"]) ? (payload["approvals"] as Array<Record<string, unknown>>) : [],
    task: (payload["task"] as Record<string, unknown> | undefined) ?? {},
  };
}

async function status(session: RunSession, jobId: string): Promise<JobView> {
  return jobView(await mcpOk(session, "status", { jobId }));
}

async function allJobs(session: RunSession): Promise<JobView[]> {
  const payload = await mcpOk(session, "sessions", { limit: 100 });
  const jobs = Array.isArray(payload["jobs"]) ? (payload["jobs"] as Array<Record<string, unknown>>) : [];
  return jobs.map(jobView);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isUuid(value: string | null): boolean {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  comm: string;
}

class ProcessSampler {
  readonly samples: Array<Record<string, unknown>> = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly known = new Map<number, PsRow>();

  constructor(private readonly bridgePid: number) {}

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sample();
  }

  private sample(): void {
    const rows = this.readPs();
    if (rows.length === 0) return;
    const descendants = this.descendants(rows, this.bridgePid);
    const bridge = rows.find((row) => row.pid === this.bridgePid) ?? null;
    for (const row of descendants) this.known.set(row.pid, row);
    if (bridge) this.known.set(bridge.pid, bridge);
    const sample = {
      ts: new Date().toISOString(),
      bridge: bridge ? { pid: bridge.pid, ppid: bridge.ppid, rssKb: bridge.rssKb, comm: bridge.comm } : null,
      descendants: descendants.map((row) => ({ pid: row.pid, ppid: row.ppid, rssKb: row.rssKb, comm: row.comm })),
      descendantCount: descendants.length,
      descendantRssKb: descendants.reduce((sum, row) => sum + row.rssKb, 0),
      bridgeRssKb: bridge?.rssKb ?? null,
    };
    this.samples.push(sample);
  }

  private readPs(): PsRow[] {
    const result = spawnSync("ps", ["-eo", "pid,ppid,rss,comm"], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/tmp" },
      timeout: 5_000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    const rows: PsRow[] = [];
    const lines = result.stdout.split("\n").slice(1);
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), comm: match[4]!.trim() });
    }
    return rows;
  }

  private descendants(rows: PsRow[], rootPid: number): PsRow[] {
    const byParent = new Map<number, PsRow[]>();
    for (const row of rows) {
      const list = byParent.get(row.ppid) ?? [];
      list.push(row);
      byParent.set(row.ppid, list);
    }
    const out: PsRow[] = [];
    const queue = [...(byParent.get(rootPid) ?? [])];
    while (queue.length > 0) {
      const row = queue.shift()!;
      out.push(row);
      queue.push(...(byParent.get(row.pid) ?? []));
    }
    return out;
  }

  knownPids(): number[] {
    return [...this.known.keys()];
  }

  peak(): { descendantCount: number; descendantRssKb: number; bridgeRssKb: number; samples: number } {
    return {
      descendantCount: Math.max(0, ...this.samples.map((sample) => Number(sample["descendantCount"] ?? 0))),
      descendantRssKb: Math.max(0, ...this.samples.map((sample) => Number(sample["descendantRssKb"] ?? 0))),
      bridgeRssKb: Math.max(0, ...this.samples.map((sample) => Number(sample["bridgeRssKb"] ?? 0))),
      samples: this.samples.length,
    };
  }
}

async function startProductionSession(fixture: Fixture, keyFile: string, timeoutMs: number, rpcLogPath: string): Promise<RunSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distMain],
    env: bridgeEnv(fixture, keyFile),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk.toString()));
  const client = new Client({ name: "claude-durateam-live-acceptance", version: "0.1.0" });
  const session: RunSession = { client, transport, stderr, pid: null, fixture, sampler: null, rpcLogPath };
  await client.connect(transport);
  await waitFor(async () => {
    const text = stderr.join("");
    const match = /"event":"server.started".*"pid":(\d+)/.exec(text);
    if (!match) return false;
    session.pid = Number(match[1]);
    return true;
  }, timeoutMs);
  if (session.pid === null) throw new Error("server.started did not expose a pid");
  session.sampler = new ProcessSampler(session.pid);
  session.sampler.start();
  const init = await mcpOk(session, "init", {});
  const scheduler = init["scheduler"] as Record<string, unknown> | undefined;
  if (!scheduler || scheduler["available"] !== true) throw new Error(`scheduler unavailable: ${JSON.stringify(scheduler)}`);
  if (Number(scheduler["maxConcurrent"]) !== 2) throw new Error("production maxConcurrent is not 2");
  const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
  for (const required of ["spawn", "spawn_batch", "wait", "status", "sessions", "follow_up", "abort", "fork", "answer", "gate"]) {
    if (!tools.includes(required)) throw new Error(`missing MCP tool: ${required}`);
  }
  return session;
}

async function watchJob(
  session: RunSession,
  jobId: string,
  terminalStates: string[],
  timeoutMs: number,
): Promise<{ job: JobView; needsAttention: boolean; timedOut: boolean; approvalsObserved: number }> {
  const deadline = Date.now() + timeoutMs;
  let approvalsObserved = 0;
  while (Date.now() < deadline) {
    const job = await status(session, jobId);
    approvalsObserved = Math.max(approvalsObserved, job.approvals.length);
    if (job.state === "needs_attention") return { job, needsAttention: true, timedOut: false, approvalsObserved };
    if (terminalStates.includes(job.state)) return { job, needsAttention: false, timedOut: false, approvalsObserved };
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { job: await status(session, jobId), needsAttention: false, timedOut: true, approvalsObserved };
}

async function closeSession(session: RunSession): Promise<Record<string, unknown>> {
  const known = new Set(session.sampler?.knownPids() ?? []);
  try {
    await session.client.close();
  } catch {
    /* child may already be gone */
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  session.sampler?.stop();
  const alive = [...known].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const killed: number[] = [];
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  const bridgeAlive = session.pid ? (() => {
    try {
      process.kill(session.pid!, 0);
      return true;
    } catch {
      return false;
    }
  })() : false;
  return { bridgePid: session.pid, bridgeAliveAfterClose: bridgeAlive, knownPids: [...known], stoppedPids: killed };
}

async function dryRun(options: Options): Promise<number> {
  const fingerprint = sourceFingerprint(options.candidateSha);
  const runDir = join(repoRoot, ".artifacts", "qa-live", `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-dry-run-${fingerprint.head.slice(0, 7)}-${randomUUID().slice(0, 4)}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const tempRoot = join(runDir, "tmp");
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const fixture = makeFixture(tempRoot, join(runDir, "gate-logs"));
  const rpcLogPath = join(runDir, "rpc-metadata.jsonl");
  const session = await startProductionSession(fixture, fixture.keyFileForDryRun, 30_000, rpcLogPath);
  let code = 0;
  const checks: Record<string, unknown> = {};
  try {
    const init = await mcpOk(session, "init", {});
    const models = await mcpOk(session, "models", {});
    checks.schedulerAvailable = (init["scheduler"] as Record<string, unknown>)["available"] === true;
    checks.baseUrl = init["baseUrl"];
    checks.credentialConfigured = (init["credential"] as Record<string, unknown>)["configured"];
    checks.toolCount = (await session.client.listTools()).tools.length;
    checks.modelsNoFallback = models["noFallback"] === true;
    checks.tools = (await session.client.listTools()).tools.map((tool) => tool.name).sort();
    checks.noModelCalls = true;
    if (!checks.schedulerAvailable || init["baseUrl"] !== "https://ark.cn-beijing.volces.com/api/coding" || !models["noFallback"]) code = 1;
    const gateCases = [
      { name: "success", script: "console.log('gate-pass')", exit: 0 },
      { name: "failure", script: "console.error('intentional-gate-failure'); process.exit(9)", exit: 9 },
      { name: "restore", script: "console.log('gate-restored')", exit: 0 },
    ];
    const gateEvidence: Record<string, unknown>[] = [];
    for (const item of gateCases) {
      const result = await mcpOk(session, "gate", {
        cwd: fixture.repo,
        allowedPaths: ["target-a.txt"],
        commands: [[process.execPath, "-e", item.script]],
        timeoutMs: 5_000,
      });
      const actual = (result["checks"] as Record<string, unknown>[])[0];
      if (!actual || actual["exitCode"] !== item.exit || actual["timedOut"] !== false || result["passed"] !== (item.exit === 0)) {
        throw new Error(`dry_run_gate_${item.name}_mismatch`);
      }
      gateEvidence.push({ name: item.name, ...result });
    }
    checks.gateEvidence = gateEvidence;
    const jobs = await mcpOk(session, "sessions", {});
    checks.zeroJobs = Array.isArray(jobs["jobs"]) && jobs["jobs"].length === 0;
    if (!checks.zeroJobs) code = 1;
  } catch (error) {
    checks.error = error instanceof Error ? error.message : String(error);
    code = 1;
  } finally {
    const cleanup = await closeSession(session);
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    const gateEvidence = (checks.gateEvidence ?? []) as Record<string, unknown>[];
    const logPaths = gateEvidence.flatMap((entry) =>
      (entry["checks"] as Record<string, unknown>[]).map((check) => String(check["log"])),
    );
    checks.temporaryDirectoryRemoved = !existsSync(tempRoot);
    checks.gateLogsSurviveCleanup = logPaths.length === 3 && logPaths.every((path) => existsSync(path));
    if (!checks.gateLogsSurviveCleanup || !checks.temporaryDirectoryRemoved) code = 1;
    const summary = {
      mode: "dry-run",
      candidateSha: options.candidateSha,
      head: fingerprint.head,
      dirty: fingerprint.dirty,
      distSha256: fingerprint.distSha256,
      checks,
      exitCode: code,
      modelRuns: 0,
      rpcLogPath,
      cleanup,
      runDir,
      note: "No spawn/follow/fork or model request. Real production MCP gates executed 0/9/0; permanent logs verified after temporary-directory cleanup. These are new checks, not reconstructed first-live logs.",
    };
    writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ mode: "dry-run", runDir, exitCode: code }));
  return code;
}

async function liveRun(options: Options): Promise<number> {
  if (!options.authorizedBy) throw new Error("--authorized-by is required for live execution");
  if (!options.candidateSha) throw new Error("--candidate-sha is required for live execution");
  const keyFile = process.env["CLAUDE_DURATEAM_KEY_FILE"];
  if (!keyFile || !existsSync(keyFile)) throw new Error("CLAUDE_DURATEAM_KEY_FILE is not configured (path handle only)");
  const fingerprint = sourceFingerprint(options.candidateSha);
  const trackedDirty = fingerprint.dirty.split("\n").filter((line) => line.length > 0 && !line.startsWith("?? ")).join("\n");
  if (trackedDirty.length > 0) throw new Error("working tree has tracked modifications; live acceptance requires the frozen committed candidate");

  const runDir = join(repoRoot, ".artifacts", "qa-live", `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-live-${fingerprint.head.slice(0, 7)}-${randomUUID().slice(0, 4)}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const tempRoot = join(runDir, "tmp");
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const fixture = makeFixture(tempRoot, join(runDir, "gate-logs"));
  const rpcLogPath = join(runDir, "rpc-metadata.jsonl");
  const session = await startProductionSession(fixture, keyFile, 30_000, rpcLogPath);
  const markerA = `A-MARKER-${randomUUID().replace(/-/g, "")}`;
  const markerB = `B-MARKER-${randomUUID().replace(/-/g, "")}`;
  const followPrompt = "In this same session, reply with exactly the marker you wrote in the previous turn, prefixed MEM:, and nothing else. Do not use tools and do not read any files.";
  const forkPrompt = "Using only session memory inherited from the parent session, reply with exactly the marker appended in the parent turn, prefixed FORK:, and nothing else. Do not use tools.";
  const summary: Record<string, unknown> = {
    mode: "live",
    authorizedBy: options.authorizedBy,
    candidateSha: options.candidateSha,
    modelRequested: options.model,
    effortRequested: options.effort,
    head: fingerprint.head,
    distSha256: fingerprint.distSha256,
    markerA,
    markerB,
    runDir,
    rpcLogPath,
    api: null,
    startedAt: new Date().toISOString(),
    checks: {},
    tasks: {},
    approvals: [],
    gate: {},
    process: null,
    modelRuns: 0,
    cleanup: null,
  };
  let code = 0;
  const checks: Record<string, unknown> = summary["checks"] as Record<string, unknown>;
  let a: JobView | undefined;
  let b: JobView | undefined;
  let follow: JobView | undefined;
  let d: JobView | undefined;
  let e: JobView | undefined;
  let cQueued = false;
  let stopEarly = false;
  try {
    const init = await mcpOk(session, "init", {});
    checks.initSchedulerAvailable = (init["scheduler"] as Record<string, unknown>)["available"] === true;
    checks.initBaseUrl = init["baseUrl"];
    checks.credentialConfigured = (init["credential"] as Record<string, unknown>)["configured"] === true;
    if (checks.initSchedulerAvailable !== true || checks.initBaseUrl !== "https://ark.cn-beijing.volces.com/api/coding" || checks.credentialConfigured !== true) {
      throw new Error("production init preflight failed");
    }

    // A/B: two independent edit workers, explicit allowedPaths, no auto answers.
    const batch = await mcpOk(session, "spawn_batch", {
      tasks: [
        {
          prompt: `Edit only target-a.txt. Append exactly the line "${markerA}". Do not touch target-b.txt or any other file. Do not use shell or network. Reply DONE.`,
          cwd: fixture.repo,
          profile: "edit",
          model: options.model,
          effort: options.effort,
          maxTurns: 6,
          deadlineMs: options.timeoutMs,
          allowedPaths: ["target-a.txt"],
        },
        {
          prompt: `Edit only target-b.txt. Append exactly the line "${markerB}". Do not touch target-a.txt or any other file. Do not use shell or network. Reply DONE.`,
          cwd: fixture.repo,
          profile: "edit",
          model: options.model,
          effort: options.effort,
          maxTurns: 6,
          deadlineMs: options.timeoutMs,
          allowedPaths: ["target-b.txt"],
        },
      ],
    });
    const created = Array.isArray(batch) ? (batch as Array<Record<string, unknown>>) : [];
    if (created.length !== 2) throw new Error("spawn_batch did not return two jobs");
    summary["modelRuns"] = 2;
    a = jobView(created[0]!);
    b = jobView(created[1]!);
    checks.aJobId = a.jobId;
    checks.bJobId = b.jobId;

    await waitFor(async () => {
      const sa = await status(session, a!.jobId);
      const sb = await status(session, b!.jobId);
      return ["starting", "running", "needs_attention"].includes(sa.state) && ["starting", "running", "needs_attention"].includes(sb.state);
    }, options.timeoutMs);

    // C: queued cancellation while both slots are held.
    const c = await mcpOk(session, "spawn", {
      prompt: "Reply with exactly OK. Do not use tools.",
      cwd: fixture.repo,
      profile: "read",
      model: options.model,
      effort: options.effort,
      maxTurns: 2,
      deadlineMs: options.timeoutMs,
    });
    checks.cJobId = c["jobId"];
    const cState = String(c["state"]);
    cQueued = cState === "queued";
    checks.cQueuedBeforeAbort = cQueued;
    if (!cQueued) {
      await mcpOk(session, "abort", { jobId: String(c["jobId"]) });
      summary["modelRuns"] = Number(summary["modelRuns"]) + 1;
      checks.cZeroModel = false;
      stopEarly = true;
    } else {
      await mcpOk(session, "abort", { jobId: String(c["jobId"]) });
      const cAfter = await status(session, String(c["jobId"]));
      checks.cAfterAbortState = cAfter.state;
      checks.cZeroModel = cAfter.state === "cancelled" && cAfter.sessionId === null && cAfter.toolCallCount === 0;
    }

    if (!stopEarly) {
      const waitedA = await watchJob(session, a.jobId, ["succeeded", "failed", "cancelled", "timed_out", "interrupted", "unknown_outcome"], options.timeoutMs);
      const waitedB = await watchJob(session, b.jobId, ["succeeded", "failed", "cancelled", "timed_out", "interrupted", "unknown_outcome"], options.timeoutMs);
      summary["approvals"] = [waitedA, waitedB].flatMap((entry) => entry.job.approvals);
      checks.aState = waitedA.job.state;
      checks.bState = waitedB.job.state;
      checks.aSessionId = waitedA.job.sessionId;
      checks.bSessionId = waitedB.job.sessionId;
      checks.aModelReported = waitedA.job.modelReported;
      checks.bModelReported = waitedB.job.modelReported;
      checks.aCwd = waitedA.job.task["cwd"];
      checks.bCwd = waitedB.job.task["cwd"];
      checks.aBranch = waitedA.job.task["branch"];
      checks.bBranch = waitedB.job.task["branch"];
      checks.aManagedWorktree = waitedA.job.task["managedWorktree"];
      checks.bManagedWorktree = waitedB.job.task["managedWorktree"];
      checks.aNeedsAttentionObserved = waitedA.needsAttention || waitedA.approvalsObserved > 0;
      checks.bNeedsAttentionObserved = waitedB.needsAttention || waitedB.approvalsObserved > 0;
      checks.aFileMarker = readText(join(String(waitedA.job.task["cwd"] ?? "."), "target-a.txt")).includes(markerA);
      checks.bFileMarker = readText(join(String(waitedB.job.task["cwd"] ?? "."), "target-b.txt")).includes(markerB);
      checks.aBIndependentCwd = String(waitedA.job.task["cwd"]) !== String(waitedB.job.task["cwd"]);
      checks.aBIndependentBranch = String(waitedA.job.task["branch"]) !== String(waitedB.job.task["branch"]);
      if (waitedA.needsAttention) await mcpOk(session, "abort", { jobId: a.jobId });
      if (waitedB.needsAttention) await mcpOk(session, "abort", { jobId: b.jobId });
      const aGood = waitedA.job.state === "succeeded" && checks.aFileMarker === true && checks.aManagedWorktree === true;
      const bGood = waitedB.job.state === "succeeded" && checks.bFileMarker === true && checks.bManagedWorktree === true;
      if (!aGood || !bGood || waitedA.needsAttention || waitedB.needsAttention || !cQueued) {
        stopEarly = true;
      } else {
        // A follow-up: exact SID, incremental memory, no marker in prompt, zero tools.
        const followed = await mcpOk(session, "follow_up", { jobId: a.jobId, prompt: followPrompt });
        summary["modelRuns"] = Number(summary["modelRuns"]) + 1;
        follow = jobView(followed);
        checks.followRunId = follow.runId;
        checks.followSameSession = follow.sessionId === waitedA.job.sessionId;
        const followedDone = await watchJob(session, a.jobId, ["succeeded", "failed", "cancelled", "timed_out", "interrupted", "unknown_outcome"], options.timeoutMs);
        checks.followState = followedDone.job.state;
        checks.followTextHasMarker = followedDone.job.latestTextPreview.includes(markerA);
        checks.followPromptHasMarker = followPrompt.includes(markerA);
        checks.followToolCalls = followedDone.job.toolCallCount;
        if (followedDone.needsAttention) {
          await mcpOk(session, "abort", { jobId: a.jobId });
          stopEarly = true;
        }

        // Gate success/failure/restore on A's real worktree. No model calls.
        const aCwd = String(waitedA.job.task["cwd"]);
        const successCommand = ["/bin/sh", "-c", `grep -qF '${markerA}' target-a.txt`];
        const gateSuccess = await mcpOk(session, "gate", { cwd: aCwd, allowedPaths: ["target-a.txt"], commands: [successCommand] });
        checks.gateSuccess = {
          passed: gateSuccess["passed"],
          testsVerified: gateSuccess["testsVerified"],
          checks: gateSuccess["checks"],
          violations: gateSuccess["violations"],
          logDir: gateSuccess["logDir"],
        };
        const gateFailure = await mcpOk(session, "gate", { cwd: aCwd, allowedPaths: ["target-a.txt"], commands: [["/bin/sh", "-c", "exit 9"]] });
        checks.gateFailure = {
          passed: gateFailure["passed"],
          testsVerified: gateFailure["testsVerified"],
          checks: gateFailure["checks"],
          violations: gateFailure["violations"],
        };
        const gateRestore = await mcpOk(session, "gate", { cwd: aCwd, allowedPaths: ["target-a.txt"], commands: [successCommand] });
        checks.gateRestore = { passed: gateRestore["passed"], testsVerified: gateRestore["testsVerified"] };
        if (gateSuccess["passed"] !== true || gateFailure["passed"] !== false || gateRestore["passed"] !== true) stopEarly = true;

        // D: observe running + init, then abort.
        const dSpawn = await mcpOk(session, "spawn", {
          prompt: "Read README.md, then read f1.txt f2.txt f3.txt f4.txt one at a time. Then reply with one short line listing them. Do not use shell or network.",
          cwd: fixture.repo,
          profile: "read",
          model: options.model,
          effort: options.effort,
          maxTurns: 8,
          deadlineMs: options.timeoutMs,
        });
        summary["modelRuns"] = Number(summary["modelRuns"]) + 1;
        d = jobView(dSpawn);
        checks.dJobId = d.jobId;
        const dActive = await waitFor(async () => {
          const current = await status(session, d!.jobId);
          return current.state === "running" && current.sessionId !== null ? current : false;
        }, options.timeoutMs);
        checks.dObservedRunning = true;
        checks.dInitSessionId = dActive.sessionId;
        await mcpOk(session, "abort", { jobId: d.jobId });
        const dAfter = await status(session, d.jobId);
        checks.dAfterAbortState = dAfter.state;
        checks.dAborted = ["cancelled", "interrupted", "timed_out"].includes(dAfter.state);
        if (!checks.dAborted) stopEarly = true;

        // E: fork from A, new workspace/SID, memory-only, no tools.
        const forked = await mcpOk(session, "fork", { jobId: a.jobId, prompt: forkPrompt });
        summary["modelRuns"] = Number(summary["modelRuns"]) + 1;
        e = jobView(forked);
        checks.eJobId = e.jobId;
        await waitFor(async () => {
          const current = await status(session, e!.jobId);
          return current.state === "succeeded" || current.state === "failed" ? current : false;
        }, options.timeoutMs);
        const eDone = await status(session, e.jobId);
        checks.eState = eDone.state;
        checks.eNewCwd = String(eDone.task["cwd"]) !== String(waitedA.job.task["cwd"]);
        checks.eNewBranch = String(eDone.task["branch"]) !== String(waitedA.job.task["branch"]);
        checks.eNewSession = eDone.sessionId !== null && eDone.sessionId !== waitedA.job.sessionId;
        checks.eTextHasMarker = eDone.latestTextPreview.includes(markerA);
        checks.ePromptHasMarker = forkPrompt.includes(markerA);
        checks.eToolCalls = eDone.toolCallCount;
        checks.eSessionId = eDone.sessionId;
      }
    }

    if (Number(summary["modelRuns"]) > 5) {
      checks.modelBudgetExceeded = true;
      code = 1;
    }
    const required = [
      checks.initSchedulerAvailable,
      checks.credentialConfigured,
      checks.cQueuedBeforeAbort,
      checks.cZeroModel,
      checks.aState === "succeeded",
      checks.bState === "succeeded",
      checks.aBIndependentCwd,
      checks.aBIndependentBranch,
      checks.aManagedWorktree === true,
      checks.bManagedWorktree === true,
      checks.aFileMarker === true,
      checks.bFileMarker === true,
      checks.followSameSession === true,
      checks.followTextHasMarker === true,
      checks.followPromptHasMarker === false,
      checks.followToolCalls === 0,
      checks.gateSuccess && (checks.gateSuccess as Record<string, unknown>)["passed"] === true,
      checks.gateFailure && (checks.gateFailure as Record<string, unknown>)["passed"] === false,
      checks.gateRestore && (checks.gateRestore as Record<string, unknown>)["passed"] === true,
      checks.dObservedRunning === true,
      checks.dAborted === true,
      checks.eState === "succeeded",
      checks.eNewCwd === true,
      checks.eNewBranch === true,
      checks.eNewSession === true,
      checks.eTextHasMarker === true,
      checks.ePromptHasMarker === false,
      checks.eToolCalls === 0,
    ];
    if (!required.every((value) => value === true)) code = 1;

    const jobs = await allJobs(session);
    summary["tasks"] = jobs.map((job) => ({
      jobId: job.jobId,
      runId: job.runId,
      state: job.state,
      sessionId: job.sessionId,
      modelReported: job.modelReported,
      toolCallCount: job.toolCallCount,
      cwd: job.task["cwd"],
      branch: job.task["branch"],
      managedWorktree: job.task["managedWorktree"],
      latestTextPreview: job.latestTextPreview.slice(0, 120),
    }));
    summary["process"] = session.sampler?.peak() ?? null;
  } catch (error) {
    checks.error = error instanceof Error ? error.message : String(error);
    code = 1;
  } finally {
    summary["process"] = session.sampler?.peak() ?? null;
    for (const jobId of [a?.jobId, b?.jobId, d?.jobId, e?.jobId].filter((value): value is string => Boolean(value))) {
      try {
        const current = await status(session, jobId);
        if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted", "unknown_outcome"].includes(current.state)) {
          await mcpOk(session, "abort", { jobId });
        }
      } catch {
        /* best effort */
      }
    }
    const cleanup = await closeSession(session);
    summary["cleanup"] = cleanup;
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
    summary["finishedAt"] = new Date().toISOString();
    summary["exitCode"] = code;
    writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(runDir, "bridge.stderr.log"), session.stderr.join(""), { mode: 0o600 });
    writeFileSync(join(runDir, "command.txt"), `${process.argv.join(" ")}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ mode: "live", runDir, exitCode: code, checks }));
  return code;
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.dryRun) return dryRun(options);
  return liveRun(options);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
