import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "./exec.js";
import { classifyRepoPath, normalizeRepoRelative, canonicalizeRepoPath } from "./paths.js";

/** Copy a settled parent's file state, including deletions/untracked files, never Git internals or ignored secrets. */
export async function snapshotWorktree(parent: string, child: string): Promise<string> {
  async function git(cwd: string, args: string[]): Promise<string> {
    const r = await runGit(cwd, args, { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 });
    if (r.exitCode !== 0 || r.outputTruncated) throw new Error(`fork snapshot git inspection failed: ${args[0]}`);
    return r.stdout;
  }
  const head = (await git(parent, ["rev-parse", "HEAD"])).trim();
  const parentFiles = (await git(parent, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  const childFiles = (await git(child, ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean);
  const expected = new Map<string, string | null>();
  let bytes = 0;
  for (const raw of new Set([...parentFiles, ...childFiles])) {
    const path = normalizeRepoRelative(raw);
    if (classifyRepoPath(path) === "hard-denied") continue;
    const from = join(parent, path);
    const to = join(child, path);
    // Validate every existing ancestor, even for a deleted source path.
    canonicalizeRepoPath(parent, parent, path, { forAllowlist: true });
    canonicalizeRepoPath(child, child, path, { forAllowlist: true });
    if (!existsSync(from)) {
      expected.set(path, null);
      if (existsSync(to)) rmSync(to);
      continue;
    }
    const stat = lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`fork snapshot requires ordinary files: ${path}`);
    bytes += stat.size;
    if (bytes > 256 * 1024 * 1024) throw new Error("fork snapshot exceeds 256 MiB");
    const digest = createHash("sha256").update(readFileSync(from)).digest("hex");
    expected.set(path, digest);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, stat.mode & 0o777);
    if (createHash("sha256").update(readFileSync(to)).digest("hex") !== digest) throw new Error("fork source changed during copy");
  }
  for (const [path, digest] of expected) {
    const from = join(parent, path);
    if (digest === null ? existsSync(from) : !existsSync(from) || createHash("sha256").update(readFileSync(from)).digest("hex") !== digest) {
      throw new Error("fork source changed during snapshot; retry after its writers settle");
    }
  }
  const afterFiles = (await git(parent, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  if (head !== (await git(parent, ["rev-parse", "HEAD"])).trim() || JSON.stringify(parentFiles) !== JSON.stringify(afterFiles)) {
    throw new Error("fork source Git state changed during snapshot");
  }
  return head;
}
