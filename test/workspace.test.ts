import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitWorkspaceService,
  WorkspacePrepareError,
  WorkspaceValidationError,
} from "../src/workspace/git-workspace.js";
import type { TaskInput } from "../src/task-contracts.js";

function sh(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

let root = "";
let repo = "";

function initRepo(): void {
  root = mkdtempSync(join(tmpdir(), "cdt-ws-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "worker@local");
  git(repo, "config", "user.name", "worker");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(repo, ".env"), "ANTHROPIC_AUTH_TOKEN=do-not-touch\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
}

function service(worktreeRoot = join(root, "worktrees")): GitWorkspaceService {
  return new GitWorkspaceService({ allowedRoots: [root], worktreeRoot });
}

function writeTask(prompt: string, extra: Partial<TaskInput> = {}): TaskInput {
  return { cwd: repo, prompt, profile: "edit", ...extra };
}

/** Fault-injection seam used only for atomic-cleanup tests. */
class FaultyWorkspace extends GitWorkspaceService {
  calls = 0;
  failAt = 2;
  afterCreate: ((path: string) => void) | null = null;

  protected override async createWorktree(resource: any): Promise<void> {
    this.calls += 1;
    await super.createWorktree(resource);
    if (this.afterCreate) this.afterCreate(resource.path);
    if (this.calls === this.failAt) throw new Error("injected failure");
  }
}

beforeEach(initRepo);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitWorkspaceService admission", () => {
  it("validateBatch is side-effect free (no worktreeRoot creation, no branch/status change)", async () => {
    const worktreeRoot = join(root, "worktrees");
    const svc = service(worktreeRoot);
    const statusBefore = git(repo, "status", "--porcelain=v2", "-z");
    const headBefore = git(repo, "rev-parse", "HEAD");
    await svc.validateBatch([writeTask("first"), writeTask("second")]);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(git(repo, "status", "--porcelain=v2", "-z")).toBe(statusBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "branch", "--list", "codex/*")).toBe("");
  });

  it("rejects the whole batch when any item is invalid (no resources created)", async () => {
    const svc = service();
    await expect(
      svc.validateBatch([writeTask("ok"), writeTask("bad", { model: "gpt-5" as any })]),
    ).rejects.toBeInstanceOf(WorkspaceValidationError);
    const error = (await svc
      .validateBatch([writeTask("ok"), writeTask("bad", { model: "gpt-5" as any })])
      .catch((err) => err)) as WorkspaceValidationError;
    expect(error.issues.map((issue) => issue.code)).toContain("invalid-model");
    expect(error.issues.find((issue) => issue.code === "invalid-model")?.index).toBe(1);
  });

  it("rejects cwd outside allowed roots and relative cwd", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cdt-outside-"));
    try {
      git(outside, "init", "-q", "-b", "main");
      const svc = service();
      const err = (await svc
        .validateBatch([{ cwd: outside, prompt: "x", profile: "read" }])
        .catch((error) => error)) as WorkspaceValidationError;
      expect(err.issues[0]?.code).toBe("cwd-outside-allowed-roots");
      const relative = (await svc
        .validateBatch([{ cwd: "repo", prompt: "x", profile: "read" }])
        .catch((error) => error)) as WorkspaceValidationError;
      expect(relative.issues[0]?.code).toBe("invalid-cwd");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects dirty base without resetting or deleting the user change", async () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2; // user edit\n");
    const svc = service();
    const err = (await svc.validateBatch([writeTask("x")]).catch((error) => error)) as WorkspaceValidationError;
    expect(err.issues.some((issue) => issue.code === "dirty-base")).toBe(true);
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toContain("user edit");
    expect(git(repo, "status", "--porcelain")).toContain("src/a.ts");
  });

  it("rejects symlink traversal, traversal and secrets in allowedPaths, but allows explicit package.json", async () => {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "secret.txt"), "x");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(root, "outside"), join(repo, "linked"));
    git(repo, "add", "linked");
    git(repo, "commit", "-qm", "link");
    const svc = service();
    const bad = (await svc
      .validateBatch([writeTask("x", { allowedPaths: ["../escape.txt", "linked/payload.txt", ".env", ".git/config"] })])
      .catch((error) => error)) as WorkspaceValidationError;
    const codes = bad.issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["path-traversal", "symlink-path", "hard-denied-path", "hard-denied-path"]),
    );
    await expect(
      svc.validateBatch([writeTask("x", { allowedPaths: ["package.json", "src/a.ts"] })]),
    ).resolves.toBeUndefined();
  });

  it("rejects repo-root / non-git / worktreeRoot inside repo for write profiles", async () => {
    const svc = service(join(repo, "inside"));
    const err = (await svc.validateBatch([writeTask("x")]).catch((error) => error)) as WorkspaceValidationError;
    expect(err.issues.map((issue) => issue.code)).toContain("worktree-root-inside-repo");
    const nonRoot = (await svc
      .validateBatch([{ cwd: join(repo, "src"), prompt: "x", profile: "edit" }])
      .catch((error) => error)) as WorkspaceValidationError;
    expect(nonRoot.issues.map((issue) => issue.code)).toContain("cwd-not-repo-root");
  });
});

describe("GitWorkspaceService prepareBatch", () => {
  it("read profile shares the checkout; no worktree/branch is created", async () => {
    const svc = service();
    const [prepared] = await svc.prepareBatch([{ cwd: repo, prompt: "review", profile: "read" }]);
    expect(prepared!.managedWorktree).toBe(false);
    expect(prepared!.branch).toBeNull();
    expect(prepared!.cwd).toBe(git(repo, "rev-parse", "--show-toplevel").trim());
    expect(prepared!.sourceCwd).toBe(prepared!.cwd);
    expect(existsSync(join(root, "worktrees"))).toBe(false);
  });

  it("creates two independent codex/ worktrees from the same clean base", async () => {
    const svc = service();
    const prepared = await svc.prepareBatch([writeTask("alpha"), writeTask("beta")]);
    expect(prepared).toHaveLength(2);
    for (const task of prepared) {
      expect(task.managedWorktree).toBe(true);
      expect(task.branch).toMatch(/^codex\/[a-z0-9-]+/);
      expect(task.sourceCwd).toBe(git(repo, "rev-parse", "--show-toplevel").trim());
      expect(existsSync(task.cwd)).toBe(true);
      expect(git(task.cwd, "rev-parse", "HEAD").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
      expect(git(task.cwd, "symbolic-ref", "--short", "HEAD").trim()).toBe(task.branch);
      expect(git(task.cwd, "rev-parse", "--git-common-dir").trim()).toBe(
        git(repo, "rev-parse", "--absolute-git-dir").trim(),
      );
    }
    expect(prepared[0]!.cwd).not.toBe(prepared[1]!.cwd);

    // True isolation: writes stay in their own checkout, source stays clean.
    writeFileSync(join(prepared[0]!.cwd, "src", "a.ts"), "export const a = 99;\n");
    expect(readFileSync(join(prepared[1]!.cwd, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(git(prepared[0]!.cwd, "status", "--porcelain")).toContain("src/a.ts");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--list", "codex/*")).not.toBe("");
    // No commit/merge/push happened.
    expect(git(prepared[0]!.cwd, "rev-parse", "HEAD").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("cleans up only resources created by this call when a later item fails", async () => {
    const svc = new FaultyWorkspace({ allowedRoots: [root], worktreeRoot: join(root, "worktrees") });
    const error = (await svc.prepareBatch([writeTask("one"), writeTask("two")]).catch((err) => err)) as WorkspacePrepareError;
    expect(error).toBeInstanceOf(WorkspacePrepareError);
    expect(error.cleanup).toHaveLength(2);
    expect(error.cleanup.every((report) => report.worktreeRemoved && report.branchRemoved)).toBe(true);
    expect(existsSync(join(root, "worktrees"))).toBe(true);
    expect(readdirSync(join(root, "worktrees"))).toEqual([]);
    expect(git(repo, "branch", "--list", "codex/*")).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("never deletes a dirty owned worktree or a foreign user directory", async () => {
    const worktreeRoot = join(root, "worktrees");
    mkdirSync(join(worktreeRoot, "user-dir"), { recursive: true });
    writeFileSync(join(worktreeRoot, "user-dir", "keep.txt"), "user data\n");
    const svc = new FaultyWorkspace({ allowedRoots: [root], worktreeRoot });
    svc.afterCreate = (path) => writeFileSync(join(path, "dirty.txt"), "worker output\n");
    const error = (await svc.prepareBatch([writeTask("one"), writeTask("two")]).catch((err) => err)) as WorkspacePrepareError;
    const dirty = error.cleanup.filter((report) => report.dirty);
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty[0]!.worktreeRemoved).toBe(false);
    expect(readFileSync(join(worktreeRoot, "user-dir", "keep.txt"), "utf8")).toBe("user data\n");
    expect(existsSync(join(dirty[0]!.path, "dirty.txt"))).toBe(true);
  });
});
