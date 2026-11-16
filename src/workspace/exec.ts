/**
 * Argv-only command execution for workspace/gate operations.
 *
 * Guarantees used by the gate and worktree services:
 *  - `shell: false`: every argv element is passed verbatim, no interpolation.
 *  - `detached: true`: each child owns its own process group, so a timeout can
 *    kill the whole owned tree (`kill(-pid)`) without touching the host's
 *    other processes.
 *  - output is capped and consumed fully so a chatty child cannot block.
 *  - the real exit code / signal is always reported; spawn failures are
 *    explicit (`exitCode: null` + `spawnError`), never silently "passed".
 *
 * Read-only Git invocations additionally set `GIT_OPTIONAL_LOCKS=0` so that
 * validation cannot refresh/write the index of a user checkout.
 */

import { spawn } from "node:child_process";

export interface CommandResult {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly spawnError: string | null;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL for the whole process group. */
  readonly killGraceMs?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

/** Environment for read-only git inspection: no prompts, no index refresh. */
export const READ_ONLY_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  GIT_PAGER: "cat",
  EDITOR: "true",
  GIT_EDITOR: "true",
};

/** Strip credentials from the environment handed to gate check commands. */
const CREDENTIAL_ENV_PATTERN =
  /(?:^|_)(?:API[-_]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[-_]?KEY|AUTH)(?:_|$)/i;
const CREDENTIAL_ENV_PREFIX = /^(?:ANTHROPIC|CLAUDE|ARK|VOLC|VOLCENGINE|ZAI|Z_AI|OPENAI|AWS|AZURE|GCP)(?:_|$)/i;

export function sanitizeCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV_PATTERN.test(key)) continue;
    if (CREDENTIAL_ENV_PREFIX.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function killGroup(childPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-childPid, signal);
  } catch {
    // ESRCH: the group is already gone. Anything else must not crash the gate.
    try {
      process.kill(childPid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run an argv command without a shell. Never throws for command failures;
 * callers decide what a non-zero exit or spawn error means.
 */
export async function runCommand(
  command: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (!Array.isArray(command) || command.length === 0) {
    throw new TypeError("command must be a non-empty argv array");
  }
  const [file, ...args] = command;
  if (typeof file !== "string" || file.length === 0 || file.includes("\u0000")) {
    throw new TypeError("command[0] must be a non-empty executable name");
  }
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\u0000"))) {
    throw new TypeError("command arguments must be strings without NUL bytes");
  }

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? 500;
  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolvePromise) => {
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    let spawnError: string | null = null;
    let outputTruncated = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({
        command: [...command],
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const append = (target: "stdout" | "stderr", chunk: string): void => {
      const current = target === "stdout" ? stdout : stderr;
      const remaining = maxOutputBytes - stdout.length - stderr.length;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const text = chunk.slice(0, remaining);
      if (text.length < chunk.length) outputTruncated = true;
      if (target === "stdout") stdout = current + text;
      else stderr = current + text;
    };

    child.stdout?.on("data", (data: Buffer) => append("stdout", data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => append("stderr", data.toString("utf8")));

    const clearTimers = (): void => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      termTimer = null;
      killTimer = null;
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === "number") killGroup(child.pid, "SIGTERM");
      termTimer = setTimeout(() => {
        if (typeof child.pid === "number") killGroup(child.pid, "SIGKILL");
      }, killGraceMs);
      termTimer.unref();
    }, options.timeoutMs);

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimers();
      resolvePromise({
        command: [...command],
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        outputTruncated,
        spawnError,
      });
    };

    child.on("error", (error: Error) => {
      spawnError = error.message;
      // 'error' may fire without 'exit' (e.g. ENOENT); give it a tick.
      setTimeout(finish, 10);
    });
    child.on("exit", (code, exitSignal) => {
      exitCode = code;
      signal = exitSignal;
      finish();
    });
  });
}

export interface GitResult extends CommandResult {
  readonly gitCwd: string;
  readonly gitArgs: readonly string[];
}

/** Run `git` with argv-only arguments; never a shell, never a credential prompt. */
export async function runGit(
  cwd: string,
  gitArgs: readonly string[],
  options: { timeoutMs?: number; extraEnv?: Record<string, string>; maxOutputBytes?: number } = {},
): Promise<GitResult> {
  const result = await runCommand(["git", ...gitArgs], {
    cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes,
    env: { ...process.env, ...READ_ONLY_GIT_ENV, ...options.extraEnv },
  });
  return { ...result, gitCwd: cwd, gitArgs: [...gitArgs] };
}

/** Short, single-line description of a command result for logs/errors. */
export function describeCommandResult(result: CommandResult): string {
  const code = result.timedOut ? "timed_out" : result.exitCode === null ? "no-exit" : `exit=${result.exitCode}`;
  const detail = (result.stderr || result.stdout).trim().replace(/\s+/g, " ").slice(0, 200);
  return `${code}${result.signal ? ` signal=${result.signal}` : ""}${detail ? ` :: ${detail}` : ""}`;
}
