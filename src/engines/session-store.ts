/**
 * Bridge-owned session transcript store.
 *
 * Claude Code stores transcripts under `<CLAUDE_CONFIG_DIR>/projects/<cwd-key>/<session>.jsonl`.
 * A new job gets a new HOME/config keyed by its own cwd, so a cross-job fork
 * would otherwise fail with "No conversation found". This module makes the
 * bridge's own config root a shared family store: it finds a parent transcript
 * anywhere under that root and copies (never moves) it into the target cwd's
 * project directory before resume/fork. The parent transcript is left untouched.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export class SessionTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptError";
  }
}

/** Claude Code's project directory key for a cwd (observed: non-alnum -> '-'). */
export function escapeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function projectDir(configRoot: string, cwd: string): string {
  return join(configRoot, "projects", escapeProjectDir(cwd));
}

/** Find the newest transcript file for a session anywhere in the shared root. */
export function findSessionTranscript(configRoot: string, sessionId: string): string | null {
  const projectsRoot = join(configRoot, "projects");
  if (!existsSync(projectsRoot)) return null;
  const candidates: string[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const file = join(projectsRoot, entry, `${sessionId}.jsonl`);
    if (existsSync(file)) candidates.push(file);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0]!;
}

export interface TranscriptAvailability {
  source: string;
  target: string;
  copied: boolean;
}

/**
 * Ensure the session transcript exists under the target cwd's project dir.
 * Throws `session_not_found:<uuid>` when the parent transcript is unknown.
 */
export function ensureSessionTranscript(
  configRoot: string,
  sessionId: string,
  cwd: string,
): TranscriptAvailability {
  const source = findSessionTranscript(configRoot, sessionId);
  if (!source) throw new SessionTranscriptError(`session_not_found:${sessionId}`);
  const targetDir = projectDir(configRoot, cwd);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const target = join(targetDir, `${sessionId}.jsonl`);
  let copied = false;
  if (!existsSync(target)) {
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    copied = true;
  }
  // Copy subagent transcripts when present (same session directory name).
  const sourceSubdir = join(dirname(source), sessionId);
  const targetSubdir = join(targetDir, sessionId);
  if (existsSync(sourceSubdir) && !existsSync(targetSubdir)) {
    cpSync(sourceSubdir, targetSubdir, { recursive: true });
  }
  return { source, target, copied };
}

/**
 * Give a per-job CLAUDE_CONFIG_DIR (inside its isolated HOME) a `projects`
 * symlink into the bridge-owned shared family store. Transcripts therefore
 * live in one store while the env still satisfies per-job HOME isolation.
 * Existing per-job transcripts are merged into the shared store without
 * overwriting an older family copy.
 */
export function linkSharedProjectStore(claudeConfigDir: string, sharedProjectsRoot: string): void {
  mkdirSync(sharedProjectsRoot, { recursive: true, mode: 0o700 });
  const link = join(claudeConfigDir, "projects");
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) {
      const target = resolve(claudeConfigDir, readlinkSync(link));
      if (target === resolve(sharedProjectsRoot)) return;
      rmSync(link);
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(link)) {
        const targetPath = join(sharedProjectsRoot, entry);
        if (!existsSync(targetPath)) cpSync(join(link, entry), targetPath, { recursive: true });
      }
      rmSync(link, { recursive: true, force: true });
    } else {
      rmSync(link, { force: true });
    }
  }
  symlinkSync(sharedProjectsRoot, link, "dir");
}
