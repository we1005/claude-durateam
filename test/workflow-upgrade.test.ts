import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FakeRunner, FakeWorkspace, MemoryStore, baseTask, flush } from "./scheduler-doubles.js";
import { GitWorkspaceService } from "../src/workspace/git-workspace.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

it("runs five workers together, queues the sixth, and persists concise progress across reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdt-progress-"));
  const runner = new FakeRunner();
  const store = new SqliteStateStore({ path: join(dir, "state.db"), registerExitHandler: false });
  const scheduler = new Scheduler({ runner, workspace: new FakeWorkspace(), store, closeGraceMs: 20 });
  let reloaded: Scheduler | undefined;
  try {
    const jobs = await scheduler.spawnBatch(Array.from({length: 6}, (_, n) => baseTask({prompt: `task-${n}`})));
    await flush(); expect(runner.runs).toHaveLength(5);
    expect(scheduler.status(jobs[5]!.jobId).state).toBe("queued");
    const r = runner.runs[0]!;
    r.emit({type: "turn"});
    r.emit({type: "tool_start", toolName: "Write", toolCallId: "write1", path: "src/a.mjs"});
    r.emit({type: "tool_end", toolName: "Write", toolCallId: "write1", path: "src/a.mjs", isError: false});
    r.emit({type: "tool_start", toolName: "Bash", toolCallId: "bash1"});
    r.emit({type: "tool_end", toolName: "Bash", toolCallId: "bash1", isError: true});
    await scheduler.steer(jobs[0]!.jobId, "finish");
    r.emit({type: "steer_ack", messageId: "confirmed-message"});
    r.resolve({text: ""}); await flush();
    expect(runner.runs).toHaveLength(6);
    const done = scheduler.status(jobs[0]!.jobId);
    expect(done.progress).toMatchObject({turns: 1, touchedFiles: ["src/a.mjs"], editWriteCount: 1, answerState: "missing",
      lastSteer: {disposition:"delivered",messageId:"confirmed-message"}});
    expect(done.progress!.recentTools[1]!.state).toBe("failed");
    expect(done.progress!.warnings).toContain("model_returned_empty_answer");
    // Returned snapshots cannot mutate the live record.
    done.progress!.touchedFiles.push("forged");
    expect(scheduler.status(jobs[0]!.jobId).progress!.touchedFiles).toEqual(["src/a.mjs"]);
    await scheduler.close();
    const restoredStore = new SqliteStateStore({path: join(dir,"state.db"),registerExitHandler:false});
    reloaded = new Scheduler({runner:new FakeRunner(),workspace:new FakeWorkspace(),store:restoredStore,closeGraceMs:20});
    expect(reloaded.status(jobs[0]!.jobId).progress!.touchedFiles).toEqual(["src/a.mjs"]);
    expect(reloaded.status(jobs[0]!.jobId).progress!.lastSteer!.disposition).toBe("delivered");
  } finally { await reloaded?.close(); await scheduler.close(); rmSync(dir,{recursive:true,force:true}); }
});

it("fork carries parent committed/uncommitted/new/deleted files into an independent worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdt-fork-files-")); const repo=join(dir,"repo");mkdirSync(repo);
  const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
  git(repo,"init","-q");git(repo,"config","user.name","Fixture");git(repo,"config","user.email","fixture@local");
  writeFileSync(join(repo,"a.txt"),"base");writeFileSync(join(repo,"delete.txt"),"delete");
  writeFileSync(join(repo,".gitignore"),".env\n");git(repo,"add",".");git(repo,"commit","-qm","base");
  const workspace=new GitWorkspaceService({allowedRoots:[dir],worktreeRoot:join(dir,"worktrees")});
  const runner=new FakeRunner();const scheduler=new Scheduler({runner,workspace,store:new MemoryStore(),closeGraceMs:20});
  try {
    const parent=await scheduler.spawn({cwd:repo,prompt:"parent",profile:"edit",allowedPaths:["a.txt"]});await flush();
    const parentDir=runner.runs[0]!.request.cwd;
    writeFileSync(join(parentDir,"a.txt"),"parent committed");git(parentDir,"add","a.txt");git(parentDir,"commit","-qm","parent edit");
    writeFileSync(join(parentDir,"a.txt"),"parent dirty");
    mkdirSync(join(parentDir,"new"));writeFileSync(join(parentDir,"new","child.txt"),"new content");
    rmSync(join(parentDir,"delete.txt"));writeFileSync(join(parentDir,".env"),"SYNTHETIC_ONLY");
    runner.runs[0]!.resolve();await flush();
    const child=await scheduler.fork(parent.jobId,"continue from these files");await flush();
    expect(child.task.cwd).not.toBe(parentDir);
    expect(readFileSync(join(child.task.cwd,"a.txt"),"utf8")).toBe("parent dirty");
    expect(readFileSync(join(child.task.cwd,"new","child.txt"),"utf8")).toBe("new content");
    expect(existsSync(join(child.task.cwd,"delete.txt"))).toBe(false);
    expect(existsSync(join(child.task.cwd,".env"))).toBe(false);
    writeFileSync(join(child.task.cwd,"a.txt"),"child edit");
    expect(readFileSync(join(parentDir,"a.txt"),"utf8")).toBe("parent dirty");
    expect(readFileSync(join(repo,"a.txt"),"utf8")).toBe("base");
    expect(child.task.forkBase?.parentHead).toBe(git(parentDir,"rev-parse","HEAD"));
  } finally { await scheduler.close();rmSync(dir,{recursive:true,force:true}); }
});
