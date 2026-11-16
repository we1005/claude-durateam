import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGate, GateInputError } from "../src/workspace/gate.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

let root = "";
let repo = "";
let logs = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdt-gate-"));
  logs = join(root, "gate-logs");
  process.env["CLAUDE_DURATEAM_GATE_LOG_ROOT"] = logs;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "worker@local");
  git(repo, "config", "user.name", "worker");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nconfig/\n");
  writeFileSync(join(repo, "secret.bin"), Buffer.from([0, 1, 2, 3]));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
});

afterEach(() => {
  delete process.env["CLAUDE_DURATEAM_GATE_LOG_ROOT"];
  rmSync(root, { recursive: true, force: true });
});

function gate(overrides: Partial<Parameters<typeof runGate>[0]> = {}) {
  return runGate({ cwd: repo, allowedPaths: [], ...overrides });
}

function pollDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      try {
        process.kill(pid, 0);
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tick, 50);
      } catch {
        resolve(true);
      }
    };
    tick();
  });
}

describe("runGate static analysis", () => {
  it("clean checkout without commands does not claim tests passed", async () => {
    const result = await gate();
    expect(result.checks).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.staticChecksPassed).toBe(true);
    expect(result.testsVerified).toBe(false);
    expect(result.notVerified).toContain("no-check-commands");
    expect(result.passed).toBe(false);
    expect(existsSync(join(result.logDir, "gate-result.json"))).toBe(true);
    // The gate itself must not dirty the checkout.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("runs a clean command as real argv with a unique log and exit code", async () => {
    const result = await gate({ commands: [["node", "-e", "console.log(process.argv[1])", "$(id)"]] });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.exitCode).toBe(0);
    expect(result.testsVerified).toBe(true);
    expect(result.staticChecksPassed).toBe(true);
    expect(result.passed).toBe(true);
    const log = readFileSync(result.checks[0]!.log, "utf8");
    expect(log).toContain("$(id)"); // no shell interpolation
    expect(result.logDir.startsWith(logs)).toBe(true);
  });

  it("reports a failing command with its real exit code", async () => {
    const result = await gate({ commands: [["node", "-e", "process.exit(3)"]] });
    expect(result.checks[0]!.exitCode).toBe(3);
    expect(result.testsVerified).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.violations.join("\n")).toContain("check-failed");
  });

  it("detects commands that mutate the workspace (file write and commit) and refuses to pass", async () => {
    const write = await gate({ commands: [["node", "-e", "require('fs').writeFileSync('created.txt','x')"]] });
    expect(write.testsVerified).toBe(false);
    expect(write.violations.join("\n")).toContain("checks-mutated-workspace");
    rmSync(join(repo, "created.txt"), { force: true });

    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    const baseline = git(repo, "rev-parse", "HEAD").trim();
    const commit = await gate({
      allowedPaths: ["src/"],
      commands: [["git", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-am", "mutated"]],
    });
    expect(commit.violations.join("\n")).toContain("checks-mutated-workspace");
    expect(commit.passed).toBe(false);
    expect(commit.summary.baseCommit).toBe(baseline);
  });

  it("times out a check, kills its owned process tree, and leaves unrelated processes alive", async () => {
    const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const pidsFile = join(root, "pids.json");
    const script = [
      "const cp=require('child_process');",
      "const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});",
      "require('fs').writeFileSync(process.argv[1],JSON.stringify({self:process.pid,child:child.pid}));",
      "setInterval(()=>{},1000);",
    ].join("");
    const result = await gate({
      timeoutMs: 400,
      commands: [["node", "-e", script, pidsFile]],
    });
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { self: number; child: number };
    expect(result.checks[0]!.timedOut).toBe(true);
    expect(result.checks[0]!.exitCode).toBeNull();
    expect(await pollDead(pids.self)).toBe(true);
    expect(await pollDead(pids.child)).toBe(true);
    try {
      process.kill(bystander.pid!, 0);
    } finally {
      bystander.kill("SIGKILL");
    }
    expect(result.passed).toBe(false);
  });

  it("enforces hard-denied, allowlist and protected defaults", async () => {
    writeFileSync(join(repo, ".env"), "SECRET=x\n");
    const env = await gate({ allowedPaths: [".env"] });
    expect(env.violations.join("\n")).toContain("allowlist-hard-denied");
    expect(env.violations.join("\n")).toContain("hard-denied-path");
    expect(env.staticChecksPassed).toBe(false);

    writeFileSync(join(repo, "package.json"), '{"name":"changed"}\n');
    rmSync(join(repo, ".env"), { force: true });
    const outside = await gate({ allowedPaths: ["src/"] });
    expect(outside.violations.join("\n")).toContain("outside-allowlist: change:M: package.json");
    const authorized = await gate({ allowedPaths: ["package.json"] });
    expect(authorized.violations).toEqual([]);
    expect(authorized.staticChecksPassed).toBe(true);
    const implicit = await gate({ allowedPaths: [] });
    expect(implicit.violations.join("\n")).toContain("protected-path: change:M: package.json");
  });

  it("checks renames on both sides and rejects protected rename targets", async () => {
    git(repo, "mv", "src/a.ts", "src/b.ts");
    const allowed = await gate({ allowedPaths: ["src/"] });
    expect(allowed.violations).toEqual([]);
    expect(allowed.summary.renamedPaths).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);

    rmSync(join(repo, "src/b.ts"));
    git(repo, "checkout", "HEAD", "--", "src/a.ts");
    git(repo, "rm", "-q", "package.json");
    git(repo, "mv", "src/a.ts", "package.json");
    const rejected = await gate({ allowedPaths: ["src/"] });
    expect(rejected.violations.join("\n")).toContain("outside-allowlist");
    expect(rejected.staticChecksPassed).toBe(false);
  });

  it("detects symlink escapes even when the symlink path is allowed", async () => {
    symlinkSync("/etc/passwd", join(repo, "leak"));
    git(repo, "add", "leak");
    const result = await gate({ allowedPaths: ["leak"] });
    expect(result.summary.symlinkPaths).toContain("leak");
    expect(result.violations.join("\n")).toContain("symlink-escape");
    expect(result.staticChecksPassed).toBe(false);
  });

  it("handles untracked/ignored key files and benign ignored entries", async () => {
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    const allowed = await gate({ allowedPaths: ["src/"] });
    expect(allowed.summary.untrackedPaths).toContain("src/new.ts");
    expect(allowed.violations).toEqual([]);

    writeFileSync(join(repo, "loose.ts"), "export const l = 1;\n");
    const rejected = await gate({ allowedPaths: ["src/"] });
    expect(rejected.violations.join("\n")).toContain("outside-allowlist: untracked: loose.ts");

    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "x.js"), "x");
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "secret.txt"), "hidden config");
    const ignored = await gate({ allowedPaths: ["src/"] });
    expect(ignored.summary.ignoredPaths.join("\n")).toContain("node_modules/");
    expect(ignored.violations.join("\n")).toContain("ignored-file: config/");
    expect(ignored.violations.join("\n")).not.toContain("ignored-file: node_modules/");
  });

  it("reports whitespace/conflict problems from git diff --check", async () => {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;   \n");
    const result = await gate({ allowedPaths: ["src/"] });
    expect(result.violations.join("\n")).toContain("whitespace-or-conflict");
    expect(result.staticChecksPassed).toBe(false);
  });

  it("rejects a cwd that is not the worktree root and malformed input", async () => {
    const sub = await runGate({ cwd: join(repo, "src"), allowedPaths: [] });
    expect(sub.violations.join("\n")).toContain("cwd-not-worktree-root");
    expect(sub.checks).toEqual([]);
    await expect(runGate({ cwd: "repo", allowedPaths: [] } as any)).rejects.toBeInstanceOf(GateInputError);
    await expect(runGate({ cwd: join(root, "missing"), allowedPaths: [] })).resolves.toBeTruthy();
  });
});
