/**
 * Git workspace admission and worktree lifecycle (P1/P3, module-owned).
 *
 * Contract:
 *  - `validateBatch()` is side-effect free: it only reads (git operations use
 *    `GIT_OPTIONAL_LOCKS=0`, so a user's index is never refreshed/written) and
 *    throws `WorkspaceValidationError` with per-task issues before anything
 *    starts. It never resets or cleans user modifications.
 *  - `prepareBatch()` first validates the whole batch, then materializes
 *    resources. `read` tasks share the (real) checkout; `edit` / `sandboxed-bash`
 *    tasks get a genuine sibling worktree on a fresh `codex/...` branch from
 *    the clean base commit. Any failure removes ONLY resources created by this
 *    call, and only when they are still clean; dirty or foreign resources are
 *    reported as leftovers and never deleted.
 *  - No commit, merge, push or deploy is ever performed here.
 */

import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isWorkerModel, isWorkerProfile, type WorkerModel, type WorkerProfile } from "../contracts.js";
import type { EffortLevel, PreparedTask, TaskInput, WorkspaceService } from "../task-contracts.js";
import { runGit } from "./exec.js";
import { snapshotWorktree } from "./snapshot.js";
import {
  PathPolicyError,
  canonicalizeRepoPath,
  isInsideRoot,
  normalizeRepoRelative,
  realpathOrNull,
  resolveParentReal,
} from "./paths.js";

export const DEFAULT_BRANCH_PREFIX = "codex/";
export const DEFAULT_WORKER_MODEL: WorkerModel = "glm-5.3-flash";
/**
 * Default profile is `coding`: the workspace service exists to hand out writable
 * scratch space. Callers that only review files must pass `profile: "read"`.
 */
export const DEFAULT_WORKER_PROFILE: WorkerProfile = "coding";

export interface WorkspaceLimits {
  readonly maxBatchTasks: number;
  readonly defaultMaxTurns: number;
  readonly maxTurns: number;
  readonly defaultDeadlineMs: number;
  readonly maxDeadlineMs: number;
  readonly maxPromptChars: number;
  readonly maxAllowedPaths: number;
  readonly maxListedNames: number;
  readonly maxNameChars: number;
  readonly minFreeBytesPerWorktree: number;
  readonly gitTimeoutMs: number;
}

export const WORKSPACE_LIMITS: WorkspaceLimits = {
  maxBatchTasks: 8,
  defaultMaxTurns: 20,
  maxTurns: 100,
  defaultDeadlineMs: 15 * 60 * 1000,
  maxDeadlineMs: 6 * 60 * 60 * 1000,
  maxPromptChars: 100_000,
  maxAllowedPaths: 200,
  maxListedNames: 50,
  maxNameChars: 128,
  minFreeBytesPerWorktree: 256 * 1024 * 1024,
  gitTimeoutMs: 60_000,
};

export interface WorkspaceIssue {
  readonly index: number | null;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface GitWorkspaceServiceOptions {
  readonly allowedRoots: string[];
  readonly worktreeRoot: string;
  readonly branchPrefix?: string;
  readonly limits?: Partial<WorkspaceLimits>;
}

export interface CleanupReport {
  readonly path: string;
  readonly branch: string | null;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly dirty: boolean;
  readonly detail: string;
}

export class WorkspaceValidationError extends Error {
  readonly issues: WorkspaceIssue[];

  constructor(issues: WorkspaceIssue[]) {
    super(
      `workspace batch rejected (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues
        .slice(0, 5)
        .map((issue) => `${issue.index === null ? "batch" : `task[${issue.index}]`} ${issue.code}`)
        .join(", ")}`,
    );
    this.name = "WorkspaceValidationError";
    this.issues = issues;
  }
}

export class WorkspacePrepareError extends Error {
  readonly cleanup: CleanupReport[];

  constructor(message: string, options: { cause?: unknown; cleanup?: CleanupReport[] } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspacePrepareError";
    this.cleanup = options.cleanup ?? [];
  }

  get leftovers(): CleanupReport[] {
    return this.cleanup.filter((report) => report.worktreeRemoved === false || report.branchRemoved === false);
  }
}

interface ValidatedTask {
  readonly index: number;
  readonly prompt: string;
  readonly model: WorkerModel;
  readonly effort: EffortLevel;
  readonly profile: WorkerProfile;
  readonly maxTurns: number;
  readonly deadlineMs: number;
  readonly sourceCwd: string;
  readonly repoReal: string | null;
  readonly baseCommit: string | null;
  readonly allowedPaths: string[];
  readonly allowedSkillNames: string[];
  readonly enabledMcpServers: string[];
}

interface WorktreeResource {
  readonly sourceCwd: string;
  readonly repoReal: string;
  readonly branch: string;
  readonly path: string;
  readonly baseCommit: string;
  readonly priorWorktreeCount: number;
  readonly branchExistedBefore: boolean;
}

const IN_PROGRESS_GIT_ENTRIES = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "index.lock",
  "rebase-merge",
  "rebase-apply",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlChars(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitWorkspaceService implements WorkspaceService {
  readonly allowedRoots: readonly string[];
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly limits: WorkspaceLimits;
  private readonly allowedRootsReal: readonly string[];

  constructor(options: GitWorkspaceServiceOptions) {
    const { allowedRoots, worktreeRoot } = options;
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
      throw new WorkspaceValidationError([
        { index: null, code: "invalid-allowed-roots", message: "allowedRoots must be a non-empty array" },
      ]);
    }
    const roots: string[] = [];
    for (const raw of allowedRoots) {
      if (typeof raw !== "string" || !isAbsolute(raw)) {
        throw new WorkspaceValidationError([
          { index: null, code: "invalid-allowed-roots", message: "every allowed root must be an absolute path" },
        ]);
      }
      const real = realpathOrNull(raw);
      if (!real) {
        throw new WorkspaceValidationError([
          { index: null, code: "invalid-allowed-roots", message: "allowed root does not exist", path: raw },
        ]);
      }
      if (!statSync(real).isDirectory()) {
        throw new WorkspaceValidationError([
          { index: null, code: "invalid-allowed-roots", message: "allowed root is not a directory", path: raw },
        ]);
      }
      roots.push(real);
    }
    this.allowedRootsReal = [...new Set(roots)];
    this.allowedRoots = this.allowedRootsReal;

    if (typeof worktreeRoot !== "string" || !isAbsolute(worktreeRoot)) {
      throw new WorkspaceValidationError([
        { index: null, code: "invalid-worktree-root", message: "worktreeRoot must be an absolute path" },
      ]);
    }
    this.worktreeRoot = resolveParentReal(worktreeRoot);
    this.branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    if (!/^[a-z0-9][a-z0-9._-]*\/$/.test(this.branchPrefix) || this.branchPrefix.length > 40) {
      throw new WorkspaceValidationError([
        {
          index: null,
          code: "invalid-branch-prefix",
          message: "branchPrefix must look like 'codex/' (lowercase, one trailing slash)",
        },
      ]);
    }
    this.limits = { ...WORKSPACE_LIMITS, ...(options.limits ?? {}) };
    if (this.limits.maxBatchTasks < 1 || this.limits.maxTurns < 1 || this.limits.maxDeadlineMs < 1) {
      throw new WorkspaceValidationError([
        { index: null, code: "invalid-limits", message: "workspace limits must be positive" },
      ]);
    }
  }

  /** Side-effect free: reads paths + git only; rejects the whole batch on any issue. */
  async validateBatch(tasks: TaskInput[]): Promise<void> {
    const analysis = await this.analyzeBatch(tasks);
    if (analysis.issues.length > 0) throw new WorkspaceValidationError(analysis.issues);
  }

  /** Validate the whole batch, then create worktrees; clean up only own resources. */
  async prepareBatch(tasks: TaskInput[]): Promise<PreparedTask[]> {
    const analysis = await this.analyzeBatch(tasks);
    if (analysis.issues.length > 0) throw new WorkspaceValidationError(analysis.issues);

    if (analysis.tasks.some((task) => task.profile !== "read")) this.ensureWorktreeRoot();
    const created: WorktreeResource[] = [];
    const prepared: PreparedTask[] = [];
    try {
      for (const task of analysis.tasks) {
        if (task.profile === "read") {
          prepared.push(this.prepareRead(task));
          continue;
        }
        const resource = await this.allocateResource(task, created);
        created.push(resource);
        await this.createWorktree(resource);
        await this.verifyWorktree(resource);
        prepared.push(this.prepareWrite(task, resource));
      }
      return prepared;
    } catch (cause) {
      const cleanup = await this.cleanupCreated(created);
      throw new WorkspacePrepareError(`workspace prepare failed: ${errorMessage(cause)}`, {
        cause,
        cleanup,
      });
    }
  }

  async prepareFork(parent: PreparedTask, input: TaskInput): Promise<PreparedTask> {
    const [child] = await this.prepareBatch([input]);
    if (parent.managedWorktree && child.managedWorktree) {
      if (!isInsideRoot(realpathSync(parent.cwd), this.worktreeRoot)) throw new Error("fork parent is not a managed workspace");
      try {
        const head = await snapshotWorktree(parent.cwd, child.cwd);
        child.forkBase = { parentCwd: parent.cwd, parentHead: head };
      } catch (error) {
        throw new Error(`fork snapshot failed; inspect retained child ${child.cwd}: ${errorMessage(error)}`);
      }
    }
    return child;
  }

  /** Test seam: materialize one worktree. Overridable for fault-injection tests. */
  protected async createWorktree(resource: WorktreeResource): Promise<void> {
    const result = await runGit(
      resource.sourceCwd,
      ["worktree", "add", "-b", resource.branch, resource.path, resource.baseCommit],
      { timeoutMs: this.limits.gitTimeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
  }

  /** Test seam: remove one owned worktree/branch if still clean. */
  protected async removeWorktree(resource: WorktreeResource): Promise<CleanupReport> {
    let worktreeRemoved = false;
    let dirty = false;
    let detail = "";

    if (existsSync(resource.path)) {
      const listing = await runGit(resource.sourceCwd, ["worktree", "list", "--porcelain"], {
        timeoutMs: this.limits.gitTimeoutMs,
      });
      const registered = new RegExp(`^worktree ${escapeRegExp(resource.path)}$`, "m").test(listing.stdout);
      if (!registered) {
        try {
          const entries = readdirSync(resource.path);
          if (entries.length === 0) {
            rmdirSync(resource.path);
            worktreeRemoved = true;
            detail = "removed empty unregistered directory";
          } else {
            dirty = true;
            detail = "unregistered directory is not empty; left in place";
          }
        } catch (error) {
          dirty = true;
          detail = `unregistered directory unreadable: ${errorMessage(error)}`;
        }
      } else {
        const status = await runGit(resource.path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
          timeoutMs: this.limits.gitTimeoutMs,
        });
        if (status.exitCode !== 0) {
          dirty = true;
          detail = `cleanliness check failed: ${(status.stderr || status.stdout).trim().slice(0, 200)}`;
        } else if (status.stdout.length > 0) {
          dirty = true;
          detail = "worktree contains local changes; left in place";
        } else {
          const remove = await runGit(resource.sourceCwd, ["worktree", "remove", resource.path], {
            timeoutMs: this.limits.gitTimeoutMs,
          });
          worktreeRemoved = remove.exitCode === 0;
          detail = worktreeRemoved
            ? "worktree removed"
            : `git worktree remove failed: ${(remove.stderr || remove.stdout).trim().slice(0, 200)}`;
        }
      }
    } else {
      worktreeRemoved = true;
      detail = "worktree path already absent";
    }

    let branchRemoved = false;
    if (!resource.branchExistedBefore) {
      const ref = await runGit(resource.sourceCwd, ["rev-parse", "--verify", `refs/heads/${resource.branch}`], {
        timeoutMs: this.limits.gitTimeoutMs,
      });
      if (ref.exitCode === 0) {
        const sha = ref.stdout.trim();
        if (sha === resource.baseCommit) {
          const deleted = await runGit(resource.sourceCwd, ["branch", "-D", resource.branch], {
            timeoutMs: this.limits.gitTimeoutMs,
          });
          branchRemoved = deleted.exitCode === 0;
        } else {
          detail += "; branch moved since creation; left in place";
        }
      } else {
        branchRemoved = true;
      }
    } else {
      branchRemoved = true;
      detail += "; pre-existing branch left untouched";
    }

    return {
      path: resource.path,
      branch: resource.branch,
      worktreeRemoved,
      branchRemoved,
      dirty,
      detail: detail.trim(),
    };
  }

  private async cleanupCreated(created: WorktreeResource[]): Promise<CleanupReport[]> {
    const reports: CleanupReport[] = [];
    for (const resource of [...created].reverse()) {
      try {
        reports.push(await this.removeWorktree(resource));
      } catch (error) {
        reports.push({
          path: resource.path,
          branch: resource.branch,
          worktreeRemoved: false,
          branchRemoved: false,
          dirty: true,
          detail: `cleanup failed: ${errorMessage(error)}`,
        });
      }
    }
    if (created.length > 0) {
      await runGit(created[0]!.sourceCwd, ["worktree", "prune"], { timeoutMs: this.limits.gitTimeoutMs });
    }
    return reports;
  }

  private ensureWorktreeRoot(): void {
    mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
    if (!statSync(this.worktreeRoot).isDirectory()) {
      throw new WorkspacePrepareError(`worktreeRoot is not a directory: ${this.worktreeRoot}`);
    }
    const real = realpathSync(this.worktreeRoot);
    if (real !== this.worktreeRoot) {
      throw new WorkspacePrepareError(
        `worktreeRoot changed identity (symlink?) between construction and use: ${this.worktreeRoot} -> ${real}`,
      );
    }
  }

  private prepareRead(task: ValidatedTask): PreparedTask {
    return {
      cwd: task.sourceCwd,
      sourceCwd: task.sourceCwd,
      model: task.model,
      effort: task.effort,
      profile: task.profile,
      prompt: task.prompt,
      maxTurns: task.maxTurns,
      deadlineMs: task.deadlineMs,
      allowedPaths: task.allowedPaths,
      allowedSkillNames: task.allowedSkillNames,
      enabledMcpServers: task.enabledMcpServers,
      managedWorktree: false,
      branch: null,
    };
  }

  private prepareWrite(task: ValidatedTask, resource: WorktreeResource): PreparedTask {
    const cwd = realpathSync(resource.path);
    return {
      cwd,
      sourceCwd: task.sourceCwd,
      model: task.model,
      effort: task.effort,
      profile: task.profile,
      prompt: task.prompt,
      maxTurns: task.maxTurns,
      deadlineMs: task.deadlineMs,
      allowedPaths: task.allowedPaths,
      allowedSkillNames: task.allowedSkillNames,
      enabledMcpServers: task.enabledMcpServers,
      managedWorktree: true,
      branch: resource.branch,
    };
  }

  private async allocateResource(task: ValidatedTask, inFlight: readonly WorktreeResource[]): Promise<WorktreeResource> {
    const sourceCwd = task.sourceCwd;
    const repoReal = task.repoReal;
    const baseCommit = task.baseCommit;
    if (!repoReal || !baseCommit) throw new Error("write task is missing repository metadata");
    const slug = slugify(task.prompt);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nonce = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const leaf = `${slug}-${nonce}`.slice(0, 60);
      const branch = `${this.branchPrefix}${leaf}`;
      const path = join(this.worktreeRoot, `wt-${leaf}`);
      if (existSyncSafe(path)) continue;
      if (inFlight.some((entry) => entry.path === path || entry.branch === branch)) continue;
      const ref = await runGit(sourceCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        timeoutMs: this.limits.gitTimeoutMs,
      });
      if (ref.exitCode === 0) continue;
      if (ref.exitCode !== 1) {
        throw new Error(`git show-ref failed: ${(ref.stderr || ref.stdout).trim().slice(0, 300)}`);
      }
      const worktrees = await runGit(sourceCwd, ["worktree", "list", "--porcelain"], {
        timeoutMs: this.limits.gitTimeoutMs,
      });
      if (worktrees.exitCode !== 0) {
        throw new Error(`git worktree list failed: ${(worktrees.stderr || worktrees.stdout).trim().slice(0, 300)}`);
      }
      if (worktrees.stdout.split("\n").some((line) => line === `worktree ${path}`)) continue;
      const listing = matchingWorktreeLines(worktrees.stdout, path);
      return {
        sourceCwd,
        repoReal,
        branch,
        path,
        baseCommit,
        priorWorktreeCount: listing,
        branchExistedBefore: false,
      };
    }
    throw new Error("could not allocate a unique worktree/branch name after 5 attempts");
  }

  private async verifyWorktree(resource: WorktreeResource): Promise<void> {
    const head = await runGit(resource.path, ["rev-parse", "HEAD"], { timeoutMs: this.limits.gitTimeoutMs });
    if (head.exitCode !== 0 || head.stdout.trim() !== resource.baseCommit) {
      throw new Error(
        `new worktree HEAD mismatch (expected ${resource.baseCommit}, got ${head.stdout.trim() || "error"})`,
      );
    }
    const branch = await runGit(resource.path, ["symbolic-ref", "--short", "HEAD"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (branch.exitCode !== 0 || branch.stdout.trim() !== resource.branch) {
      throw new Error(`new worktree is not on ${resource.branch}: ${(branch.stderr || branch.stdout).trim()}`);
    }
    const status = await runGit(resource.path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (status.exitCode !== 0 || status.stdout.length > 0) {
      throw new Error("new worktree is not clean right after creation");
    }
    const common = await runGit(resource.path, ["rev-parse", "--git-common-dir"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (common.exitCode !== 0) throw new Error("could not read the new worktree common dir");
    const commonDir = resolve(resource.path, common.stdout.trim());
    const sourceCommon = await runGit(resource.sourceCwd, ["rev-parse", "--git-common-dir"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (sourceCommon.exitCode !== 0) throw new Error("could not read the source repository common dir");
    const sourceCommonDir = resolve(resource.sourceCwd, sourceCommon.stdout.trim());
    if (!samePath(commonDir, sourceCommonDir)) {
      throw new Error("new worktree does not share the source repository's object store");
    }
  }

  private async analyzeBatch(
    tasks: TaskInput[],
  ): Promise<{ issues: WorkspaceIssue[]; tasks: ValidatedTask[] }> {
    const issues: WorkspaceIssue[] = [];
    if (!Array.isArray(tasks)) {
      return {
        issues: [{ index: null, code: "invalid-batch", message: "tasks must be an array" }],
        tasks: [],
      };
    }
    if (tasks.length > this.limits.maxBatchTasks) {
      return {
        issues: [
          {
            index: null,
            code: "batch-too-large",
            message: `at most ${this.limits.maxBatchTasks} tasks may be prepared at once`,
          },
        ],
        tasks: [],
      };
    }

    const validated: ValidatedTask[] = [];
    for (const [index, raw] of tasks.entries()) {
      const task = await this.analyzeTask(index, raw, issues);
      if (task) validated.push(task);
    }

    const writeTasks = validated.filter((task) => task.profile !== "read");
    if (writeTasks.length > 0) {
      this.checkWorktreeRoot(writeTasks, issues);
    }
    return { issues, tasks: validated };
  }

  private checkWorktreeRoot(writeTasks: readonly ValidatedTask[], issues: WorkspaceIssue[]): void {
    for (const task of writeTasks) {
      if (task.repoReal && isInsideRoot(this.worktreeRoot, task.repoReal)) {
        issues.push({
          index: task.index,
          code: "worktree-root-inside-repo",
          message: "worktreeRoot must be outside the source repository",
          path: this.worktreeRoot,
        });
      }
    }
    const existing = nearestExisting(this.worktreeRoot);
    if (!existing) {
      issues.push({
        index: null,
        code: "worktree-root-invalid",
        message: "worktreeRoot has no existing ancestor",
        path: this.worktreeRoot,
      });
      return;
    }
    try {
      accessSync(existing, fsConstants.W_OK);
    } catch {
      issues.push({
        index: null,
        code: "worktree-root-not-writable",
        message: "worktreeRoot parent is not writable",
        path: existing,
      });
      return;
    }
    try {
      const stats = statfsSync(existing);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const required = this.limits.minFreeBytesPerWorktree * writeTasks.length;
      if (Number.isFinite(freeBytes) && freeBytes < required) {
        issues.push({
          index: null,
          code: "insufficient-disk-space",
          message: `need ${required} free bytes for ${writeTasks.length} worktree(s), found ${freeBytes}`,
          path: existing,
        });
      }
    } catch {
      // statfs is best effort; worktree creation will fail loudly if the disk is full.
    }
    if (existsSync(this.worktreeRoot) && !statSync(this.worktreeRoot).isDirectory()) {
      issues.push({
        index: null,
        code: "worktree-root-invalid",
        message: "worktreeRoot exists but is not a directory",
        path: this.worktreeRoot,
      });
    }
  }

  private async analyzeTask(
    index: number,
    raw: TaskInput,
    issues: WorkspaceIssue[],
  ): Promise<ValidatedTask | null> {
    const push = (code: string, message: string, path?: string): void => {
      issues.push({ index, code, message, ...(path === undefined ? {} : { path }) });
    };
    if (!isPlainObject(raw)) {
      push("invalid-task", "task must be an object");
      return null;
    }

    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    if (prompt.trim().length === 0) push("invalid-prompt", "prompt must be a non-empty string");
    else if (prompt.length > this.limits.maxPromptChars) {
      push("invalid-prompt", `prompt exceeds ${this.limits.maxPromptChars} characters`);
    } else if (prompt.includes("\u0000")) push("invalid-prompt", "prompt must not contain NUL");

    let model: WorkerModel = DEFAULT_WORKER_MODEL;
    if (raw.model !== undefined) {
      if (!isWorkerModel(raw.model)) push("invalid-model", "model must be one of glm-5.3 / glm-5.3-flash");
      else model = raw.model;
    }

    let effort: EffortLevel = "high";
    if (raw.effort !== undefined) {
      if (!["low", "medium", "high", "xhigh", "max"].includes(raw.effort)) {
        push("invalid-effort", "effort must be low, medium, high, xhigh or max");
      } else effort = raw.effort;
    }

    let profile: WorkerProfile = DEFAULT_WORKER_PROFILE;
    if (raw.profile !== undefined) {
      if (!isWorkerProfile(raw.profile)) push("invalid-profile", "profile must be read / edit / sandboxed-bash / coding");
      else profile = raw.profile;
    }

    let maxTurns = this.limits.defaultMaxTurns;
    if (raw.maxTurns !== undefined) {
      if (
        typeof raw.maxTurns !== "number" ||
        !Number.isInteger(raw.maxTurns) ||
        raw.maxTurns < 1 ||
        raw.maxTurns > this.limits.maxTurns
      ) {
        push("invalid-max-turns", `maxTurns must be an integer between 1 and ${this.limits.maxTurns}`);
      } else maxTurns = raw.maxTurns;
    }

    let deadlineMs = this.limits.defaultDeadlineMs;
    if (raw.deadlineMs !== undefined) {
      if (
        typeof raw.deadlineMs !== "number" ||
        !Number.isInteger(raw.deadlineMs) ||
        raw.deadlineMs < 1 ||
        raw.deadlineMs > this.limits.maxDeadlineMs
      ) {
        push(
          "invalid-deadline",
          `deadlineMs must be an integer between 1 and ${this.limits.maxDeadlineMs} (${this.limits.maxDeadlineMs / 60_000} min)`,
        );
      } else deadlineMs = raw.deadlineMs;
    }

    const skillNames = this.validateNameList(raw.allowedSkillNames, index, "allowedSkillNames", issues);
    const mcpServers = this.validateNameList(raw.enabledMcpServers, index, "enabledMcpServers", issues);

    if (typeof raw.cwd !== "string" || raw.cwd.length === 0) {
      push("invalid-cwd", "cwd must be a non-empty absolute path");
      return null;
    }
    if (!isAbsolute(raw.cwd) || raw.cwd.startsWith("~") || raw.cwd.includes("\u0000")) {
      push("invalid-cwd", "cwd must be an absolute path without NUL or ~", raw.cwd);
      return null;
    }
    const cwdReal = realpathOrNull(raw.cwd);
    if (!cwdReal) {
      push("invalid-cwd", "cwd does not exist", raw.cwd);
      return null;
    }
    if (!statSync(cwdReal).isDirectory()) {
      push("invalid-cwd", "cwd is not a directory", raw.cwd);
      return null;
    }
    if (!this.allowedRootsReal.some((root) => isInsideRoot(cwdReal, root))) {
      push("cwd-outside-allowed-roots", "cwd is outside every configured allowed root", cwdReal);
      return null;
    }

    let repoReal: string | null = null;
    let baseCommit: string | null = null;
    if (profile !== "read") {
      const inspection = await this.inspectRepository(index, cwdReal, issues);
      if (inspection) {
        repoReal = inspection.repoReal;
        baseCommit = inspection.baseCommit;
      }
    }

    const allowedPaths: string[] = [];
    if (raw.allowedPaths !== undefined) {
      if (!Array.isArray(raw.allowedPaths)) {
        push("invalid-allowed-paths", "allowedPaths must be an array of repo-relative paths");
      } else if (raw.allowedPaths.length > this.limits.maxAllowedPaths) {
        push("invalid-allowed-paths", `allowedPaths exceeds ${this.limits.maxAllowedPaths} entries`);
      } else {
        const rootForPaths = repoReal ?? cwdReal;
        for (const entry of raw.allowedPaths) {
          if (typeof entry !== "string") {
            push("invalid-allowed-paths", "every allowedPaths entry must be a string");
            continue;
          }
          try {
            const canonical = canonicalizeRepoPath(rootForPaths, raw.cwd, entry, { forAllowlist: true });
            if (allowPathRepetition(allowedPaths, canonical.repoRelative)) continue;
            allowedPaths.push(canonical.repoRelative);
          } catch (error) {
            if (error instanceof PathPolicyError) push(error.code, error.message, entry);
            else push("invalid-allowed-path", errorMessage(error), entry);
          }
        }
      }
    }

    if (issues.some((issue) => issue.index === index)) return null;
    return {
      index,
      prompt,
      model,
      effort,
      profile,
      maxTurns,
      deadlineMs,
      sourceCwd: cwdReal,
      repoReal,
      baseCommit,
      allowedPaths,
      allowedSkillNames: skillNames,
      enabledMcpServers: mcpServers,
    };
  }

  private validateNameList(
    value: unknown,
    index: number,
    label: "allowedSkillNames" | "enabledMcpServers",
    issues: WorkspaceIssue[],
  ): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      issues.push({ index, code: `invalid-${label}`, message: `${label} must be an array of names` });
      return [];
    }
    if (value.length > this.limits.maxListedNames) {
      issues.push({
        index,
        code: `invalid-${label}`,
        message: `${label} exceeds ${this.limits.maxListedNames} entries`,
      });
      return [];
    }
    const out: string[] = [];
    for (const entry of value) {
      if (
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.length > this.limits.maxNameChars ||
        controlChars(entry) ||
        entry.includes("\u0000")
      ) {
        issues.push({ index, code: `invalid-${label}`, message: `invalid ${label} entry` });
        continue;
      }
      const trimmed = entry.trim();
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  private async inspectRepository(
    index: number,
    cwdReal: string,
    issues: WorkspaceIssue[],
  ): Promise<{ repoReal: string; baseCommit: string } | null> {
    const push = (code: string, message: string): void => {
      issues.push({ index, code, message });
    };
    const inside = await runGit(cwdReal, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      push("not-git-repository", "write profiles require a git checkout");
      return null;
    }
    const top = await runGit(cwdReal, ["rev-parse", "--show-toplevel"], { timeoutMs: this.limits.gitTimeoutMs });
    if (top.exitCode !== 0) {
      push("not-git-repository", `git rev-parse failed: ${(top.stderr || top.stdout).trim().slice(0, 200)}`);
      return null;
    }
    const repoReal = realpathOrNull(top.stdout.trim());
    if (!repoReal) {
      push("not-git-repository", "repository top-level cannot be resolved");
      return null;
    }
    if (!samePath(repoReal, cwdReal)) {
      push("cwd-not-repo-root", "write task cwd must be the repository root");
      return null;
    }
    const head = await runGit(cwdReal, ["rev-parse", "--verify", "HEAD^{commit}"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (head.exitCode !== 0) {
      push("no-base-commit", "repository has no committed base commit");
      return null;
    }
    const baseCommit = head.stdout.trim();

    const gitDirResult = await runGit(cwdReal, ["rev-parse", "--absolute-git-dir"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (gitDirResult.exitCode === 0) {
      const gitDir = gitDirResult.stdout.trim();
      for (const entry of IN_PROGRESS_GIT_ENTRIES) {
        if (existsSync(join(gitDir, entry))) {
          push("operation-in-progress", `repository has an in-progress operation (${entry}); refusing to branch`);
          break;
        }
      }
    }

    const status = await runGit(cwdReal, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      timeoutMs: this.limits.gitTimeoutMs,
    });
    if (status.exitCode !== 0) {
      push("git-read-failed", `git status failed: ${(status.stderr || status.stdout).trim().slice(0, 200)}`);
      return null;
    }
    if (status.stdout.length > 0) {
      const changes = status.stdout.split("\u0000").filter((entry) => entry.length > 0).length;
      push("dirty-base", `base checkout is not clean (${changes} status entries); refusing without touching them`);
      return null;
    }
    return { repoReal, baseCommit };
  }
}

function allowPathRepetition(existing: readonly string[], candidate: string): boolean {
  const normalized = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
  return existing.some((entry) => {
    const entryNormalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    return entryNormalized === normalized;
  });
}

function existSyncSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nearestExisting(path: string): string | null {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/** Number of registered worktrees whose path equals `path`. */
function matchingWorktreeLines(porcelain: string, path: string): number {
  return porcelain.split("\n").filter((line) => line === `worktree ${path}`).length;
}

/** Normalize a caller's allowlist for the gate (no fs needed). */
export function normalizeGateAllowlist(entries: readonly string[]): string[] {
  return entries.map((entry) => normalizeRepoRelative(entry));
}
