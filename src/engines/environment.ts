/**
 * Isolated Worker environment for the Volcengine Coding Plan.
 *
 * Design constraints (P0):
 *  - The Claude Code process receives an allowlist-built env, NOT `...process.env`.
 *    This removes inherited ANTHROPIC_API_KEY / OAuth tokens / proxy settings
 *    that could silently fall back to the user's primary Claude subscription.
 *  - HOME and CLAUDE_CONFIG_DIR both point inside `.runtime/`, so the primary
 *    `~/.claude`, `~/.claude.json` and `~/.codex` are never read or written.
 *  - The API token is read at runtime from an operator-provided file path (env
 *    var `CLAUDE_DURATEAM_KEY_FILE`), never from argv, never logged.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_VERSION } from "../version.js";
import { WORKER_MODELS, type WorkerModel } from "../contracts.js";

/** Volcengine Coding Plan, Anthropic-compatible base URL (NOT /api/v3). */
export const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding";

/** Operator-authorized credential file on this machine (path only, never content). */
export const AUTHORIZED_KEY_FILE = join(homedir(), ".config", "claude-durateam", "credentials", "volcengine.key");

export const KEY_FILE_ENV = "CLAUDE_DURATEAM_KEY_FILE";
export const RUNTIME_ROOT_ENV = "CLAUDE_DURATEAM_RUNTIME";

/** Env vars allowed to leak from the parent process (everything else is dropped). */
const INHERITED_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SYSTEM_VERSION_COMPAT",
] as const;

/** Variables that must never reach a Worker subprocess. */
const FORBIDDEN_IN_WORKER_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export class CredentialError extends Error {
  readonly code: "missing" | "unreadable" | "malformed" | "too-large";

  constructor(code: CredentialError["code"], message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

export interface LoadedCredential {
  /** Raw token value. Must never be logged or serialized. */
  readonly token: string;
  readonly format: "raw" | "env-assignment";
  readonly sourcePath: string;
  readonly sourceBytes: number;
}

/** Resolve the credential file path from env (explicit path beats the default). */
export function resolveKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[KEY_FILE_ENV]?.trim();
  return override && override.length > 0 ? override : AUTHORIZED_KEY_FILE;
}

/**
 * Load the token from a file. Accepts a pure token (trimmed) or a
 * `ANTHROPIC_AUTH_TOKEN=...` / `ARK_API_KEY=...` assignment.
 * Error messages never contain the file content.
 */
export function loadApiKeyFromFile(filePath: string): LoadedCredential {
  if (!isAbsolute(filePath)) {
    throw new CredentialError("malformed", "credential path must be absolute");
  }
  let raw: Buffer;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new CredentialError("unreadable", "credential path is not a regular file");
    if (stat.size > 8192) throw new CredentialError("too-large", "credential file is unexpectedly large");
    raw = readFileSync(filePath);
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    throw new CredentialError("missing", `credential file is not readable (${code})`);
  }

  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new CredentialError("malformed", "credential file is empty");

  // Reject multi-line payloads instead of guessing which line is the secret.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new CredentialError("malformed", "credential file must contain exactly one non-empty line");
  }
  const line = lines[0]!.trim();

  // Any `NAME=value` line is treated as an assignment. Unknown names are
  // rejected rather than silently used as a raw token (e.g. OPENAI_API_KEY).
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
  const allowedNames = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ARK_API_KEY", "API_KEY"];
  let token = line;
  let format: LoadedCredential["format"] = "raw";
  if (assignment) {
    const name = assignment[1]!.toUpperCase();
    if (!allowedNames.includes(name)) {
      throw new CredentialError(
        "malformed",
        "credential file uses an unrecognized variable name in an assignment; refusing ambiguous source",
      );
    }
    token = assignment[2]!.trim().replace(/^["']|["']$/g, "");
    format = "env-assignment";
  }

  if (token.length < 8) throw new CredentialError("malformed", "credential value is too short");
  if (/\s/.test(token)) throw new CredentialError("malformed", "credential value contains whitespace");

  return {
    token,
    format,
    sourcePath: filePath,
    sourceBytes: raw.length,
  };
}

export interface WorkerHome {
  readonly root: string;
  readonly home: string;
  readonly claudeConfigDir: string;
}

/**
 * Create an isolated HOME + CLAUDE_CONFIG_DIR under the runtime root.
 * Also seeds `.claude.json` so the CLI skips onboarding inside the sandbox.
 */
export function prepareWorkerHome(runtimeRoot: string, tag: string): WorkerHome {
  const root = join(resolve(runtimeRoot), tag);
  const home = join(root, "home");
  const claudeConfigDir = join(home, ".claude");
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  const onboardingFile = join(home, ".claude.json");
  if (!existsSync(onboardingFile)) {
    writeFileSync(onboardingFile, `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  // Some CLI builds resolve the global config file from CLAUDE_CONFIG_DIR.
  const alternate = join(claudeConfigDir, ".claude.json");
  if (!existsSync(alternate)) {
    writeFileSync(alternate, `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return { root, home, claudeConfigDir };
}

export interface BuildWorkerEnvInput {
  readonly credential: LoadedCredential;
  readonly model: WorkerModel;
  readonly workerHome: WorkerHome;
  readonly baseUrl?: string;
  readonly clientApp?: string;
  /** Bridge-owned shared transcript config root (cross-job resume/fork). */
  readonly claudeConfigDir?: string;
}

export interface WorkerEnvSummary {
  readonly baseUrl: string;
  readonly model: WorkerModel;
  readonly home: string;
  readonly claudeConfigDir: string;
  readonly inheritedKeys: string[];
  readonly setKeys: string[];
}

export interface BuiltWorkerEnv {
  readonly env: Record<string, string>;
  readonly summary: WorkerEnvSummary;
}

/**
 * Build the subprocess env. The result replaces the SDK child environment
 * entirely (`Options.env` semantics), so it must carry PATH/HOME itself.
 */
export function buildWorkerEnv(input: BuildWorkerEnvInput): BuiltWorkerEnv {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const env: Record<string, string> = {};
  const inheritedKeys: string[] = [];

  for (const key of INHERITED_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
      inheritedKeys.push(key);
    }
  }

  // Isolated identity: never the real HOME. The config dir may be a
  // bridge-owned shared root so sessions survive across jobs/worktrees.
  env["HOME"] = input.workerHome.home;
  env["CLAUDE_CONFIG_DIR"] = input.claudeConfigDir ?? input.workerHome.claudeConfigDir;

  // Volcengine Coding Plan routing for every model tier, so no tier falls back
  // to an Anthropic default model.
  env["ANTHROPIC_BASE_URL"] = baseUrl;
  env["ANTHROPIC_AUTH_TOKEN"] = input.credential.token;
  env["ANTHROPIC_MODEL"] = input.model;
  env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = input.model;
  env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = input.model;
  env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = input.model;
  env["CLAUDE_CODE_SUBAGENT_MODEL"] = input.model;

  // Do not spend Coding Plan quota on background telemetry / update traffic.
  env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  env["DISABLE_AUTOUPDATER"] = "1";
  env["NO_COLOR"] = "1";
  env["CLAUDE_AGENT_SDK_CLIENT_APP"] = input.clientApp ?? `claude-durateam/${PACKAGE_VERSION}`;

  for (const forbidden of FORBIDDEN_IN_WORKER_ENV) {
    if (env[forbidden] !== undefined) {
      throw new Error(`forbidden variable leaked into worker env: ${forbidden}`);
    }
  }

  const summary: WorkerEnvSummary = {
    baseUrl,
    model: input.model,
    home: input.workerHome.home,
    claudeConfigDir: env["CLAUDE_CONFIG_DIR"]!,
    inheritedKeys,
    setKeys: Object.keys(env).sort(),
  };
  return { env, summary };
}

/**
 * Hard isolation check before any real invocation: the worker HOME must sit
 * inside the runtime root, and no credential/proxy variable may be inherited
 * from the operator's own Claude/Codex configuration.
 */
export function assertIsolatedEnv(env: Record<string, string>, runtimeRoot: string): void {
  const runtimeReal = resolve(runtimeRoot) + sep;
  const home = env["HOME"];
  const configDir = env["CLAUDE_CONFIG_DIR"];
  if (!home || !configDir) throw new Error("worker env missing HOME/CLAUDE_CONFIG_DIR");
  if (!(resolve(home) + sep).startsWith(runtimeReal)) {
    throw new Error("worker HOME is outside the runtime root; refusing isolated run");
  }
  if (!(resolve(configDir) + sep).startsWith(resolve(home) + sep)) {
    throw new Error("CLAUDE_CONFIG_DIR must live inside the worker HOME");
  }
  for (const forbidden of FORBIDDEN_IN_WORKER_ENV) {
    if (env[forbidden] !== undefined) throw new Error(`forbidden variable present: ${forbidden}`);
  }
  if (env["ANTHROPIC_BASE_URL"] !== DEFAULT_BASE_URL) {
    throw new Error("unexpected ANTHROPIC_BASE_URL for Volcengine Coding Plan");
  }
  for (const tier of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    if (!env[tier] || !(WORKER_MODELS as readonly string[]).includes(env[tier]!)) {
      throw new Error(`model tier ${tier} is not a whitelisted GLM model`);
    }
  }
}

export function assertAllowedModel(model: string): asserts model is WorkerModel {
  if (!(WORKER_MODELS as readonly string[]).includes(model)) {
    throw new Error(`model not allowed: ${model} (allowed: ${WORKER_MODELS.join(", ")})`);
  }
}

/** Private per-user runtime; never dirty or require writing to the installed package. */
export function resolveRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[RUNTIME_ROOT_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("runtime root override must be absolute");
    return override;
  }
  return join(homedir(), ".local", "share", "claude-durateam");
}
