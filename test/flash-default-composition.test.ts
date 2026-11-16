import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("default composition admits an edit without dirtying the source or installing state inside the package", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "flash-defaults-")));
  const repo = join(base, "repo"); const home = join(base, "home");
  mkdirSync(repo); mkdirSync(home);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.name", "QA"]); git(["config", "user.email", "qa@local"]);
  writeFileSync(join(repo, "target.txt"), "base\n");git(["add", "."]);git(["commit", "-qm", "base"]);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist/main.js")], cwd: repo, stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_DURATEAM_KEY_FILE: join(base, "absent-key") } });
  const client = new Client({ name: "default-composition-test", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse((result.content as { type: string; text: string }[]).find(x => x.type === "text")!.text);
    expect(result.isError, JSON.stringify(value)).not.toBe(true); return value;
  };
  try {
    await client.connect(transport);
    const init = await call("init", {});expect(init.scheduler.available).toBe(true);
    const job = await call("spawn", { cwd: repo, prompt: "local admission only", model: "glm-5.3-flash", effort: "high", profile: "edit", allowedPaths: ["target.txt"] });
    expect(job.task.managedWorktree).toBe(true);expect(job.task.effort).toBe("high");
    expect(job.task.cwd.startsWith(repo + "/")).toBe(false);
    expect(job.task.cwd.startsWith(root + "/")).toBe(false);
    expect(existsSync(join(home, ".local/share/claude-durateam/state/claude-durateam.db"))).toBe(true);
    const deadline = Date.now() + 5000;let final = job;
    while (!["succeeded", "failed", "cancelled", "timed_out"].includes(final.state) && Date.now() < deadline) {
      const waited = await call("wait", { jobId: job.jobId, afterRevision: final.revision, timeoutMs: 1000 }); final = waited.jobs[0];
    }
    expect(final.state).toBe("failed");expect(final.sessionId).toBeNull();expect(final.lastError).toContain("credential:missing");
    expect(git(["status", "--porcelain"])).toBe("");
  } finally { await client.close();rmSync(base, { recursive: true, force: true }); }
}, 20000);
