/**
 * Integration gate: Git scope + real check commands.
 *
 * Contract (frozen `GateRequest` / `GateResult`):
 *  - `checks[]` contains ONLY the task-provided commands with their real exit
 *    codes. Git inspections are logged to `logDir` instead; with no commands,
 *    `checks` is empty and `testsVerified` stays false: the gate never claims
 *    "tests passed" when none were configured.
 *  - `passed = staticChecksPassed && testsVerified` (both are exposed on the
 *    returned detail). Static-only success therefore reports `passed:false`
 *    with `notVerified:["no-check-commands"]`, which callers must surface as
 *    not_verified rather than as a test pass.
 *  - Static analysis: `git diff --check`, `--raw` (modes/symlinks/submodules),
 *    `--name-status -M` (renames), `--numstat` (binary), untracked files,
 *    ignored key files. Paths are checked against hard-denied secrets/git/gate
 *    config and against the task allowlist (default-protected paths require an
 *    explicit allowlist entry).
 *  - Commands run as argv (no shell), with credentials stripped from the
 *    environment, an owned process group killed on timeout, and a unique log
 *    file each. If HEAD/branch/status/refs/worktree list/git metadata changed
 *    during inspection or commands, the gate cannot pass.
 *  - Nothing is committed, merged, pushed or deployed.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { GateRequest, GateResult } from "../task-contracts.js";
import { sanitizeCommandEnv, runCommand, runGit, type GitResult } from "./exec.js";
import { redactSecrets } from "../observability/redact.js";
import {
  PathPolicyError,
  allowlistMatches,
  classifyRepoPath,
  normalizeRepoRelative,
  stripDirMarker,
} from "./paths.js";

export interface GateResultDetail extends GateResult {
  readonly staticChecksPassed: boolean;
  readonly testsVerified: boolean;
  readonly notVerified: string[];
  readonly logDir: string;
  readonly summary: GateSummary;
  readonly checks: GateResult["checks"];
}

export interface GateSummary {
  readonly baseCommit: string | null;
  readonly branch: string | null;
  readonly changedPaths: string[];
  readonly untrackedPaths: string[];
  readonly ignoredPaths: string[];
  readonly binaryPaths: string[];
  readonly symlinkPaths: string[];
  readonly renamedPaths: Array<{ from: string; to: string }>;
}

export class GateInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GateInputError";
    this.code = code;
  }
}

export const GATE_LIMITS = {
  maxCommands: 10,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 10 * 60_000,
  maxViolations: 200,
  maxTextFileBytes: 2 * 1024 * 1024,
} as const;

const BENIGN_IGNORED = [
  /^(?:node_modules|dist|build|out|coverage|\.nyc_output|\.cache|\.next|\.turbo|\.parcel-cache|\.svelte-kit|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.gradle|\.idea|\.vscode|\.artifacts|\.runtime|target|\.terraform|vendor\/bundler)\//,
  /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/,
  /(?:^|\/)[^/]*\.(?:log|db|db-wal|db-shm|sqlite|sqlite3|tsbuildinfo|eslintcache)$/,
];

interface DiffChange {
  readonly status: string;
  readonly path: string;
  readonly fromPath: string | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly binary: boolean;
}

interface Fingerprint {
  readonly head: string;
  readonly branch: string;
  readonly statusHash: string;
  readonly diffHash: string;
  readonly refsHash: string;
  readonly worktreesHash: string;
  readonly metadataHash: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeLog(logDir: string, name: string, text: string): string {
  const path = join(logDir, name);
  writeFileSync(path, redactSecrets(text).slice(0, 512 * 1024), { mode: 0o600 });
  return path;
}

function quoteArgv(argv: readonly string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

function isBinaryContent(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > GATE_LIMITS.maxTextFileBytes) return false;
    const buffer = readFileSync(file);
    return buffer.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

function hasConflictMarker(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > GATE_LIMITS.maxTextFileBytes) return false;
    const text = readFileSync(file, "utf8");
    return /^(?:<{7}|={7}|>{7})(?: |$)/m.test(text);
  } catch {
    return false;
  }
}

function validateRequest(req: GateRequest): {
  cwd: string;
  allowedPaths: string[];
  commands: string[][];
  timeoutMs: number;
} {
  if (typeof req !== "object" || req === null) throw new GateInputError("invalid-request", "request is required");
  if (typeof req.cwd !== "string" || !isAbsolute(req.cwd) || req.cwd.includes("\u0000")) {
    throw new GateInputError("invalid-cwd", "cwd must be a non-empty absolute path");
  }
  if (!Array.isArray(req.allowedPaths)) {
    throw new GateInputError("invalid-allowed-paths", "allowedPaths must be an array");
  }
  const allowedPaths = req.allowedPaths.map((entry) => {
    if (typeof entry !== "string") throw new GateInputError("invalid-allowed-paths", "entries must be strings");
    try {
      return normalizeRepoRelative(entry);
    } catch (error) {
      if (error instanceof PathPolicyError) throw new GateInputError(error.code, error.message);
      throw error;
    }
  });
  const commands: string[][] = [];
  if (req.commands !== undefined) {
    if (!Array.isArray(req.commands)) throw new GateInputError("invalid-commands", "commands must be an array");
    if (req.commands.length > GATE_LIMITS.maxCommands) {
      throw new GateInputError("invalid-commands", `at most ${GATE_LIMITS.maxCommands} commands are allowed`);
    }
    for (const argv of req.commands) {
      if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
        throw new GateInputError("invalid-command", "each command must be a non-empty argv array (max 64 args)");
      }
      for (const arg of argv) {
        if (typeof arg !== "string" || arg.length === 0 || arg.length > 2_000 || arg.includes("\u0000") || /[\r\n]/.test(arg)) {
          throw new GateInputError("invalid-command", "argv entries must be single-line strings (max 2000 chars)");
        }
      }
      commands.push([...argv]);
    }
  }
  const timeoutMs = req.timeoutMs ?? GATE_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GATE_LIMITS.maxTimeoutMs) {
    throw new GateInputError(
      "invalid-timeout",
      `timeoutMs must be an integer between 1 and ${GATE_LIMITS.maxTimeoutMs}`,
    );
  }
  return { cwd: req.cwd, allowedPaths, commands, timeoutMs };
}

function parseRawDiff(stdout: string): DiffChange[] {
  const chunks = stdout.split("\u0000");
  const changes: DiffChange[] = [];
  let index = 0;
  while (index < chunks.length) {
    const chunk = chunks[index++]!;
    if (chunk === "") continue;
    if (!chunk.startsWith(":")) throw new Error(`unexpected raw diff record: ${chunk.slice(0, 40)}`);
    const header = chunk.slice(1).split(" ");
    if (header.length < 5) throw new Error("short raw diff header");
    const [oldMode, newMode, oldSha, newSha, status] = header as [string, string, string, string, string];
    const kind = status.charAt(0);
    let fromPath: string | null = null;
    let path: string;
    if (kind === "R" || kind === "C") {
      fromPath = chunks[index++]!;
      path = chunks[index++]!;
    } else {
      path = chunks[index++]!;
    }
    changes.push({
      status,
      path,
      fromPath,
      oldMode: oldMode!,
      newMode: newMode!,
      oldSha: oldSha!,
      newSha: newSha!,
      binary: false,
    });
  }
  return changes;
}

function parseNameStatus(stdout: string): Array<{ status: string; path: string; fromPath: string | null }> {
  const chunks = stdout.split("\u0000");
  const out: Array<{ status: string; path: string; fromPath: string | null }> = [];
  let index = 0;
  while (index < chunks.length) {
    const status = chunks[index++]!;
    if (status === "") continue;
    const kind = status.charAt(0);
    if (kind === "R" || kind === "C") {
      out.push({ status, fromPath: chunks[index++]!, path: chunks[index++]! });
    } else {
      out.push({ status, fromPath: null, path: chunks[index++]! });
    }
  }
  return out;
}

function parseNumstat(stdout: string): Array<{ path: string; fromPath: string | null; binary: boolean }> {
  const chunks = stdout.split("\u0000");
  const out: Array<{ path: string; fromPath: string | null; binary: boolean }> = [];
  let index = 0;
  while (index < chunks.length) {
    const chunk = chunks[index++]!;
    if (chunk === "") continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(chunk);
    if (!match) throw new Error(`unexpected numstat record: ${chunk.slice(0, 40)}`);
    const binary = match[1] === "-" && match[2] === "-";
    let fromPath: string | null = null;
    let path = match[3]!;
    if (path === "") {
      fromPath = chunks[index++]!;
      path = chunks[index++]!;
    }
    out.push({ path, fromPath, binary });
  }
  return out;
}

function parseNul(stdout: string): string[] {
  return stdout.split("\u0000").filter((entry) => entry.length > 0);
}

function benignIgnored(path: string): boolean {
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return BENIGN_IGNORED.some((pattern) => pattern.test(path) || pattern.test(normalized));
}

/** Keep the gate result bounded and redacted. */
function pushViolation(violations: string[], entry: string): void {
  if (violations.length >= GATE_LIMITS.maxViolations) {
    if (violations.length === GATE_LIMITS.maxViolations) violations.push("violations-truncated: more findings omitted");
    return;
  }
  violations.push(redactSecrets(entry).slice(0, 1_000));
}

export async function runGate(req: GateRequest): Promise<GateResultDetail> {
  const input = validateRequest(req);
  const logRoot = gateLogRoot();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const logDir = join(logRoot, `${stamp}-${process.pid}-${randomBytes(3).toString("hex")}`);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);

  const violations: string[] = [];
  const notVerified: string[] = [];
  const checks: GateResult["checks"] = [];
  const summary: {
    baseCommit: string | null;
    branch: string | null;
    changedPaths: string[];
    untrackedPaths: string[];
    ignoredPaths: string[];
    binaryPaths: string[];
    symlinkPaths: string[];
    renamedPaths: Array<{ from: string; to: string }>;
  } = {
    baseCommit: null,
    branch: null,
    changedPaths: [],
    untrackedPaths: [],
    ignoredPaths: [],
    binaryPaths: [],
    symlinkPaths: [],
    renamedPaths: [],
  };
  let inspections = 0;
  const inspectionLogs: string[] = [];

  const inspect = async (label: string, args: string[]): Promise<GitResult> => {
    inspections += 1;
    const result = await runGit(input.cwd, args, { timeoutMs: GATE_LIMITS.maxTimeoutMs });
    inspectionLogs.push(
      writeLog(
        logDir,
        `${String(inspections).padStart(2, "0")}-${label}.log`,
        `$ git ${quoteArgv(args)}\ncwd: ${input.cwd}\nexit: ${result.exitCode === null ? "none" : result.exitCode}${
          result.timedOut ? " (timed out)" : ""
        }${result.spawnError ? ` spawnError: ${result.spawnError}` : ""}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      ),
    );
    return result;
  };

  const finish = (): GateResultDetail => {
    const staticChecksPassed = violations.length === 0;
    const workspaceMutated = violations.some((entry) => entry.startsWith("checks-mutated-workspace"));
    const testsVerified =
      input.commands.length > 0 &&
      checks.length === input.commands.length &&
      !workspaceMutated &&
      checks.every((check) => check.exitCode === 0 && !check.timedOut);
    if (testsVerified) {
      // all required checks really ran and exited 0
    } else if (input.commands.length === 0) {
      notVerified.push("no-check-commands");
    } else if (violations.some((entry) => entry.startsWith("checks-mutated-workspace") || entry.startsWith("workspace-mutated"))) {
      notVerified.push("check-commands-not-trusted: workspace changed during the gate");
    } else if (violations.length > 0) {
      notVerified.push("check-commands-failed");
    } else {
      notVerified.push("check-commands-did-not-verify");
    }
    const passed = staticChecksPassed && testsVerified;
    const detail: GateResultDetail = {
      passed,
      violations: [...violations],
      checks: [...checks],
      staticChecksPassed,
      testsVerified,
      notVerified: [...new Set(notVerified)],
      logDir,
      summary: {
        baseCommit: summary.baseCommit,
        branch: summary.branch,
        changedPaths: [...summary.changedPaths],
        untrackedPaths: [...summary.untrackedPaths],
        ignoredPaths: [...summary.ignoredPaths],
        binaryPaths: [...summary.binaryPaths],
        symlinkPaths: [...summary.symlinkPaths],
        renamedPaths: [...summary.renamedPaths],
      },
    };
    writeLog(
      logDir,
      "gate-result.json",
      `${JSON.stringify({ ...detail, request: { cwd: input.cwd, allowedPaths: input.allowedPaths, commands: input.commands, timeoutMs: input.timeoutMs }, inspectionLogs }, null, 2)}\n`,
    );
    return detail;
  };

  let cwdReal: string;
  try {
    cwdReal = realpathSync(input.cwd);
  } catch {
    pushViolation(violations, "invalid-cwd: gate cwd does not exist");
    return finish();
  }
  if (!statSync(cwdReal).isDirectory()) {
    pushViolation(violations, "invalid-cwd: gate cwd is not a directory");
    return finish();
  }

  const top = await inspect("toplevel", ["rev-parse", "--show-toplevel"]);
  const inside = await inspect("inside-worktree", ["rev-parse", "--is-inside-work-tree"]);
  if (top.exitCode !== 0 || inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    pushViolation(violations, "not-git-worktree: cwd is not inside a git work tree");
    return finish();
  }
  const topReal = realpathSync(top.stdout.trim());
  if (topReal !== cwdReal) {
    pushViolation(violations, "cwd-not-worktree-root: gate must run at the worktree root");
    return finish();
  }
  const headResult = await inspect("head", ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.exitCode !== 0) {
    pushViolation(violations, "no-base-commit: repository has no committed HEAD");
    return finish();
  }

  for (const entry of input.allowedPaths) {
    if (classifyRepoPath(stripDirMarker(entry)) === "hard-denied") {
      pushViolation(violations, `allowlist-hard-denied: ${entry}`);
    }
  }

  const fingerprint0 = await captureFingerprint(input.cwd, logDir, "fingerprint-before", inspectionLogs, inspections);
  inspections += fingerprint0.commands;

  const check = await inspect("diff-check", ["diff", "HEAD", "--check"]);
  const raw = await inspect("diff-raw", ["diff", "HEAD", "--raw", "-z", "-M"]);
  const nameStatus = await inspect("diff-name-status", ["diff", "HEAD", "--name-status", "-z", "-M"]);
  const numstat = await inspect("diff-numstat", ["diff", "HEAD", "--numstat", "-z", "-M"]);
  const untracked = await inspect("untracked", ["ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = await inspect("ignored", ["ls-files", "-o", "-i", "--exclude-standard", "-z", "--directory"]);
  const status = await inspect("status", ["status", "--porcelain=v2", "-z", "--ignored=matching"]);

  for (const [label, result] of [
    ["diff-raw", raw],
    ["diff-name-status", nameStatus],
    ["diff-numstat", numstat],
    ["untracked", untracked],
    ["ignored", ignored],
    ["status", status],
  ] as const) {
    if (result.exitCode !== 0) {
      pushViolation(violations, `git-inspection-failed: ${label}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    }
  }
  if (check.exitCode !== 0) {
    const lines = (check.stdout || check.stderr)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 20);
    if (lines.length === 0) {
      pushViolation(violations, "git-diff-check-failed: unspecified failure");
    } else {
      for (const line of lines) pushViolation(violations, `whitespace-or-conflict: ${line}`);
    }
  }

  let changes: DiffChange[] = [];
  try {
    changes = parseRawDiff(raw.stdout);
    const named = parseNameStatus(nameStatus.stdout);
    const numstatEntries = parseNumstat(numstat.stdout);
    const rawKeys = changes.map((change) => `${change.fromPath ?? ""}=>${change.path}`).sort();
    const namedKeys = named.map((entry) => `${entry.fromPath ?? ""}=>${entry.path}`).sort();
    const numstatKeys = numstatEntries.map((entry) => `${entry.fromPath ?? ""}=>${entry.path}`).sort();
    if (rawKeys.join("\u0000") !== namedKeys.join("\u0000") || rawKeys.join("\u0000") !== numstatKeys.join("\u0000")) {
      pushViolation(violations, "diff-parser-mismatch: raw/name-status/numstat disagree");
    }
    for (const entry of numstatEntries) {
      const target = changes.find(
        (change) => change.path === entry.path && (change.fromPath ?? null) === entry.fromPath,
      );
      if (target) (target as { binary: boolean }).binary = entry.binary;
      if (entry.binary) summary.binaryPaths.push(entry.path);
    }
  } catch (error) {
    pushViolation(violations, `diff-incomplete: ${error instanceof Error ? error.message : String(error)}`);
    changes = [];
  }

  summary.changedPaths = changes.map((change) => (change.fromPath ? `${change.fromPath} -> ${change.path}` : change.path));
  summary.untrackedPaths = parseNul(untracked.stdout);
  summary.ignoredPaths = parseNul(ignored.stdout);

  const policyCheck = (label: string, path: string, mode?: { oldMode: string; newMode: string }): void => {
    let normalized: string;
    try {
      normalized = normalizeRepoRelative(path);
    } catch {
      pushViolation(violations, `invalid-path: ${label}: ${path}`);
      return;
    }
    if (classifyRepoPath(stripDirMarker(normalized)) === "hard-denied") {
      pushViolation(violations, `hard-denied-path: ${label}: ${normalized}`);
      return;
    }
    if (input.allowedPaths.length > 0 && !allowlistMatches(input.allowedPaths, normalized)) {
      pushViolation(violations, `outside-allowlist: ${label}: ${normalized}`);
      return;
    }
    if (input.allowedPaths.length === 0 && classifyRepoPath(stripDirMarker(normalized)) === "protected") {
      pushViolation(violations, `protected-path: ${label}: ${normalized}`);
      return;
    }
    if (mode) {
      if (mode.newMode === "160000" || mode.oldMode === "160000") {
        pushViolation(violations, `submodule-change: ${label}: ${normalized}`);
      }
      if (mode.newMode === "120000" || mode.oldMode === "120000") {
        summary.symlinkPaths.push(normalized);
        const absolute = join(cwdReal, stripDirMarker(normalized));
        if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
          const target = resolve(dirname(absolute), readlinkSync(absolute));
          if (!isInsideRepo(target, cwdReal)) {
            pushViolation(violations, `symlink-escape: ${label}: ${normalized} -> ${target}`);
          }
        }
      }
    }
  };

  for (const change of changes) {
    if (change.fromPath) {
      summary.renamedPaths.push({ from: change.fromPath, to: change.path });
      policyCheck(`rename-from:${change.status}`, change.fromPath, change);
    }
    policyCheck(`change:${change.status}`, change.path, change);
    const absolute = join(cwdReal, change.path);
    if (existsSync(absolute) && !isBinaryContent(absolute) && hasConflictMarker(absolute)) {
      pushViolation(violations, `conflict-marker: ${change.path}`);
    }
  }
  for (const path of summary.untrackedPaths) {
    policyCheck("untracked", path);
    const absolute = join(cwdReal, path);
    if (existsSync(absolute) && !isBinaryContent(absolute) && hasConflictMarker(absolute)) {
      pushViolation(violations, `conflict-marker: ${path}`);
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      summary.symlinkPaths.push(path);
      const target = resolve(dirname(absolute), readlinkSync(absolute));
      if (!isInsideRepo(target, cwdReal)) {
        pushViolation(violations, `symlink-escape: untracked: ${path} -> ${target}`);
      }
    }
  }
  for (const path of summary.ignoredPaths) {
    if (classifyRepoPath(stripDirMarker(path)) === "hard-denied") {
      pushViolation(violations, `ignored-secret: ${path}`);
    } else if (!benignIgnored(path)) {
      pushViolation(violations, `ignored-file: ${path}`);
    }
  }

  const fingerprint1 = await captureFingerprint(input.cwd, logDir, "fingerprint-after-inspection", inspectionLogs, inspections);
  inspections += fingerprint1.commands;
  if (fingerprint0.fingerprint.statusHash !== "" && fingerprintDiffs(fingerprint0.fingerprint, fingerprint1.fingerprint).length > 0) {
    pushViolation(
      violations,
      `workspace-mutated-by-gate-checks: ${fingerprintDiffs(fingerprint0.fingerprint, fingerprint1.fingerprint).join(",")}`,
    );
  }

  const commandsTrusted = violations.length === 0;
  if (!commandsTrusted && input.commands.length > 0) {
    notVerified.push("check-commands-skipped: static gate violations");
  } else {
    for (const [index, argv] of input.commands.entries()) {
      const result = await runCommand(argv, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: sanitizeCommandEnv(process.env),
      });
      const logPath = writeLog(
        logDir,
        `command-${String(index + 1).padStart(2, "0")}.log`,
        `$ ${quoteArgv(argv)}\ncwd: ${input.cwd}\nexit: ${
          result.exitCode === null ? "none" : result.exitCode
        }${result.timedOut ? " (timed out)" : ""}${result.signal ? ` signal: ${result.signal}` : ""}\ndurationMs: ${
          result.durationMs
        }${result.outputTruncated ? "\n(output truncated)" : ""}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
      checks.push({ command: [...argv], exitCode: result.exitCode, timedOut: result.timedOut, log: logPath });
      if (result.timedOut) pushViolation(violations, `check-timed-out: ${quoteArgv(argv)}`);
      else if (result.exitCode === null) {
        pushViolation(violations, `check-spawn-failed: ${quoteArgv(argv)}${result.spawnError ? `: ${result.spawnError}` : ""}`);
      } else if (result.exitCode !== 0) {
        pushViolation(violations, `check-failed: ${quoteArgv(argv)} exited ${result.exitCode}`);
      }
    }
    const fingerprint2 = await captureFingerprint(input.cwd, logDir, "fingerprint-after-commands", inspectionLogs, inspections);
    inspections += fingerprint2.commands;
    const mutation = fingerprintDiffs(fingerprint1.fingerprint, fingerprint2.fingerprint);
    if (mutation.length > 0) {
      pushViolation(violations, `checks-mutated-workspace: ${mutation.join(",")}; re-run the gate on a clean worktree`);
    }
  }

  summary.baseCommit = headResult.stdout.trim();
  summary.branch =
    (await inspect("branch", ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || "detached";

  return finish();
}

function isInsideRepo(target: string, repoReal: string): boolean {
  const rel = resolve(target);
  return rel === repoReal || rel.startsWith(`${repoReal}/`);
}

function fingerprintDiffs(a: Fingerprint, b: Fingerprint): string[] {
  const fields: Array<keyof Fingerprint> = ["head", "branch", "statusHash", "diffHash", "refsHash", "worktreesHash", "metadataHash"];
  return fields.filter((field) => a[field] !== b[field]);
}

async function captureFingerprint(
  cwd: string,
  logDir: string,
  name: string,
  logs: string[],
  priorInspections: number,
): Promise<{ fingerprint: Fingerprint; commands: number }> {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const calls: Array<{ label: string; result: GitResult }> = [];
  const gitCall = async (label: string, args: string[]): Promise<GitResult> => {
    const result = await runGit(cwd, args, { timeoutMs: GATE_LIMITS.maxTimeoutMs });
    calls.push({ label, result });
    return result;
  };
  const head = await gitCall("head", ["rev-parse", "HEAD"]);
  const branch = await gitCall("branch", ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = await gitCall("status", ["status", "--porcelain=v2", "-z", "--ignored=matching"]);
  const diff = await gitCall("diff", ["diff", "HEAD", "--raw", "-z", "-M"]);
  const refs = await gitCall("refs", ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]);
  const worktrees = await gitCall("worktrees", ["worktree", "list", "--porcelain"]);
  const gitDir = await gitCall("git-dir", ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await gitCall("common-dir", ["rev-parse", "--git-common-dir"]);

  const gitDirPath = gitDir.exitCode === 0 ? gitDir.stdout.trim() : "";
  const commonDirPath = commonDir.exitCode === 0 ? resolve(cwd, commonDir.stdout.trim()) : "";
  const metadata = [readTextFile(join(gitDirPath, "config")), listDir(join(gitDirPath, "hooks")), listDir(join(commonDirPath, "worktrees"))].join("|");

  const fingerprint: Fingerprint = {
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    statusHash: sha256(status.stdout),
    diffHash: sha256(diff.stdout),
    refsHash: sha256(refs.stdout),
    worktreesHash: sha256(worktrees.stdout),
    metadataHash: sha256(metadata),
  };
  logs.push(
    writeLog(
      logDir,
      `${String(priorInspections + 1).padStart(2, "0")}-${name}.log`,
      `${calls.map((call) => `$ git ${quoteArgv(call.result.gitArgs)}\nexit: ${call.result.exitCode}\n${call.result.stdout}\n${call.result.stderr}`).join("\n")}\nfingerprint: ${JSON.stringify(fingerprint)}`,
    ),
  );
  return { fingerprint, commands: calls.length };
}

function readTextFile(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return `<unreadable:${stat.size}>`;
    return readFileSync(path, "utf8");
  } catch {
    return "<missing>";
  }
}

function listDir(path: string): string {
  try {
    return readdirSync(path)
      .sort()
      .map((entry) => {
        try {
          const stat = lstatSync(join(path, entry));
          return `${entry}:${stat.size}:${stat.mode}:${Math.floor(stat.mtimeMs)}`;
        } catch {
          return `${entry}:?`;
        }
      })
      .join(",");
  } catch {
    return "<missing>";
  }
}

function gateLogRoot(): string {
  const fromEnv = process.env["CLAUDE_DURATEAM_GATE_LOG_ROOT"];
  const root = fromEnv && isAbsolute(fromEnv) ? fromEnv : join(tmpdir(), "claude-durateam-gate");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
