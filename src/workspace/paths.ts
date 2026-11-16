/**
 * Path policy shared by admission (validateBatch) and the integration gate.
 *
 * Three classes of paths:
 *  - `hard-denied`: secrets, git internals and this project's own gate
 *    configuration. NEVER writable, not even when named in `allowedPaths`,
 *    because a worker must not be able to read/forge credentials or widen its
 *    own permission contract.
 *  - `protected`: business-critical defaults (package manifests, lockfiles, CI,
 *    deploy/infra, build-tool config). Denied by default, but a task contract
 *    may explicitly authorize them by naming them in `allowedPaths`.
 *  - `ok`: ordinary business code.
 *
 * All patterns operate on POSIX, repo-relative paths without a leading `./`.
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathClass = "ok" | "protected" | "hard-denied";

/** Absolute-required, traversal/symlink-safe path policy failures. */
export class PathPolicyError extends Error {
  readonly code: PathPolicyCode;
  readonly path: string | undefined;

  constructor(code: PathPolicyCode, message: string, path?: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
    this.path = path;
  }
}

export type PathPolicyCode =
  | "invalid-path"
  | "absolute-path"
  | "path-traversal"
  | "outside-repo"
  | "symlink-path"
  | "hard-denied-path"
  | "not-a-directory"
  | "missing-path";

/** Secret / git / gate-config paths: not grantable through `allowedPaths`. */
const HARD_DENIED_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)\.gitmodules$/,
  /(?:^|\/)\.git-credentials$/,
  /(?:^|\/)\.env(?:\.[^/]*)?$/,
  /(?:^|\/)[^/]*\.env$/,
  /(?:^|\/)\.envrc$/,
  /(?:^|\/)[^/]*\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /(?:^|\/)\.(?:ssh|aws|azure|gcloud|kube|docker|gnupg|password-store)\//,
  /(?:^|\/)\.(?:npmrc|netrc|pypirc|yarnrc|yarnrc\.yml|htpasswd)$/,
  /(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /(?:^|\/)(?:auth|tokens?|passwords?|apikeys?)\.(?:json|ya?ml)$/i,
  /(?:^|\/)[^/]*\.(?:secret|secrets)$/i,
  /(?:^|\/)\.claude\//,
  /(?:^|\/)\.codex\//,
  /(?:^|\/)\.pi-lsp\.json$/,
  /(?:^|\/)\.mcp\.json$/,
  /(?:^|\/)(?:claude[-_]durateam|agent-gate|task-gate|gate-config)[^/]*\.(?:json|ya?ml|toml)$/i,
];

/** Business defaults that a task contract may explicitly authorize. */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/,
  /^\.github\/(?:workflows|actions)\//,
  /^\.github\/dependabot\.(?:yml|yaml)$/,
  /^(?:\.gitlab-ci\.yml|\.travis\.yml|appveyor\.yml|bitbucket-pipelines\.yml|Jenkinsfile|azure-pipelines[^/]*\.ya?ml|\.drone\.yml)$/,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.teamcity\//,
  /^(?:Dockerfile|Dockerfile\.[^/]+|docker-compose[^/]*\.ya?ml|compose\.ya?ml|\.dockerignore|Containerfile)$/i,
  /^(?:deploy|deployment|deployments|infra|infrastructure|terraform|k8s|kubernetes|helm|charts|ops|manifests|release)\//,
  /(?:^|\/)[^/]*\.tfstate(?:\.backup)?$/,
  /^(?:Makefile|GNUmakefile)$/,
  /^tsconfig[^/]*\.json$/,
  /^(?:vitest|jest|karma|playwright|cypress|ava)\.config\.[cm]?[jt]s$/,
  /^(?:\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s)$/,
  /^\.(?:gitignore|gitattributes|npmignore)$/,
  /^(?:\.releaserc[^/]*|semantic-release[^/]*|lerna\.json|nx\.json)$/,
  /^(?:\.nvmrc|\.node-version|\.tool-versions)$/,
];

/** Classify a normalized repo-relative POSIX path. Hard denial wins. */
export function classifyRepoPath(repoRelative: string): PathClass {
  const candidate = repoRelative.replace(/^\.\//, "");
  if (!candidate) return "hard-denied";
  for (const pattern of HARD_DENIED_PATTERNS) {
    if (pattern.test(candidate)) return "hard-denied";
  }
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(candidate)) return "protected";
  }
  return "ok";
}

/** True when the path is under a hard-denied or explicit-protected rule. */
export function isDeniedByDefault(repoRelative: string): boolean {
  return classifyRepoPath(repoRelative) !== "ok";
}

/** Normalize caller-supplied repo-relative path; throws on escapes/absolutes. */
export function normalizeRepoRelative(raw: string): string {
  const input = raw.trim();
  if (!input) throw new PathPolicyError("invalid-path", "path must not be empty", raw);
  if (input.includes("\u0000")) throw new PathPolicyError("invalid-path", "path must not contain NUL", raw);
  if (input.includes("\\")) throw new PathPolicyError("invalid-path", "path must use forward slashes", raw);
  if (input.startsWith("~")) throw new PathPolicyError("invalid-path", "~ paths are not allowed", raw);
  if (isAbsolute(input)) throw new PathPolicyError("absolute-path", "path must be repo-relative", raw);
  const hasTrailingSlash = input.endsWith("/");
  const body = hasTrailingSlash ? input.slice(0, -1) : input;
  const segments = body.split("/");
  if (segments.some((segment) => segment === "")) {
    throw new PathPolicyError("invalid-path", "path must not contain empty segments", raw);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new PathPolicyError("path-traversal", "path must not traverse upward", raw);
  }
  const cleaned = segments.filter((segment) => segment !== ".");
  if (cleaned.length === 0) return ".";
  const normalized = cleaned.join("/");
  return hasTrailingSlash ? `${normalized}/` : normalized;
}

/** Strip a single trailing slash used as a directory marker. */
export function stripDirMarker(repoRelative: string): string {
  return repoRelative.endsWith("/") && repoRelative.length > 1 ? repoRelative.slice(0, -1) : repoRelative;
}

/** Real path of an existing file/dir, or null when it does not exist. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolve a (possibly not-yet-existing) path to its real location, resolving
 * every existing ancestor. New path components are appended verbatim, so a
 * symlinked parent cannot smuggle a path outside its root.
 */
export function resolveParentReal(path: string): string {
  if (isAbsolute(path) === false) throw new PathPolicyError("invalid-path", "path must be absolute", path);
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : resolve(current);
  return missing.length > 0 ? resolve(base, ...missing) : base;
}

/** Containment check on already-canonical absolute paths. */
export function isInsideRoot(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Assert `child` is inside `root` (both canonical), throws otherwise. */
export function assertInsideRoot(child: string, root: string, label: string): void {
  if (!isInsideRoot(child, root)) {
    throw new PathPolicyError("outside-repo", `${label} escapes its allowed root`, child);
  }
}

/**
 * Reject repo-relative paths that traverse any existing symlink component.
 * Symlinked parents must be resolved by the caller's contract, not silently
 * followed, so the gate can compare literal Git paths with the allowlist.
 */
export function assertNoSymlinkTraversal(repoRootReal: string, repoRelative: string, raw: string): void {
  const stripped = stripDirMarker(repoRelative);
  if (stripped === ".") return;
  let cursor = repoRootReal;
  for (const segment of stripped.split("/")) {
    cursor = join(cursor, segment);
    let entry;
    try {
      entry = lstatSync(cursor);
    } catch {
      return; // remaining components do not exist yet
    }
    if (entry.isSymbolicLink()) {
      throw new PathPolicyError("symlink-path", "symlinked path components are not supported", raw);
    }
  }
}

/**
 * Convert an absolute or repo-relative input into a canonical repo-relative
 * path, rejecting traversal, symlinked components and hard-denied targets.
 * Returns the normalized path plus whether it currently exists as a directory.
 */
export function canonicalizeRepoPath(
  repoRootReal: string,
  repoRootName: string,
  raw: string,
  options: { forAllowlist: boolean } = { forAllowlist: true },
): { repoRelative: string; isDirectory: boolean; pathClass: PathClass } {
  const input = raw.trim();
  if (!input) throw new PathPolicyError("invalid-path", "path must not be empty", raw);
  let candidate: string;
  if (isAbsolute(input)) {
    if (input.includes("\u0000")) throw new PathPolicyError("invalid-path", "path must not contain NUL", raw);
    const resolvedInput = resolve(input);
    const rel = relative(repoRootReal, resolvedInput);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new PathPolicyError("outside-repo", `${repoRootName}: path is outside the checkout`, raw);
    }
    candidate = rel.split(sep).join("/");
  } else {
    candidate = normalizeRepoRelative(input);
  }
  const pathClass = classifyRepoPath(stripDirMarker(candidate));
  if (options.forAllowlist && pathClass === "hard-denied") {
    throw new PathPolicyError("hard-denied-path", "this path cannot be authorized (secret/git/gate config)", raw);
  }
  assertNoSymlinkTraversal(repoRootReal, candidate, raw);
  const stripped = stripDirMarker(candidate);
  const absolute = stripped === "." ? repoRootReal : join(repoRootReal, stripped);
  let isDirectory = false;
  if (existsSync(absolute)) {
    const stat = statSync(absolute);
    isDirectory = stat.isDirectory();
    // A symlink as the final component is a symlinked path component too.
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new PathPolicyError("symlink-path", "symlinked path components are not supported", raw);
    }
  }
  if (isDirectory && stripped !== "." && !candidate.endsWith("/")) {
    candidate = `${candidate}/`;
  }
  return { repoRelative: candidate, isDirectory, pathClass };
}

/** Directory/prefix allowlist match; entries are repo-relative POSIX paths. */
export function allowlistMatches(allowlist: readonly string[], repoRelative: string): boolean {
  if (allowlist.length === 0) return true;
  const target = stripDirMarker(repoRelative);
  for (const entryRaw of allowlist) {
    const entry = stripDirMarker(entryRaw);
    if (entry === ".") return true;
    if (target === entry) return true;
    if (target.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/** Identity helper used by tests/diagnostics. */
export function pathClassRank(pathClass: PathClass): number {
  return pathClass === "hard-denied" ? 2 : pathClass === "protected" ? 1 : 0;
}
