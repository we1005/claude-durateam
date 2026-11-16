import { DatabaseSync } from "node:sqlite";
import { existsSync, realpathSync } from "node:fs";
import type { SchedulerService, JobSnapshot } from "../task-contracts.js";
import { InstanceCatalog } from "./catalog.js";

interface OpenInstance {
  scheduler: SchedulerService;
  info: { available: boolean; reason?: string };
  cleanup: () => Promise<void>;
}

/** Route explicitly addressed jobs; SQLite ownership, not PID guesses, authorizes execution. */
export class InstanceManager {
  readonly catalog: InstanceCatalog;
  private readonly opened = new Map<string, Promise<OpenInstance>>();
  constructor(readonly baseDir: string, readonly currentId: string, private readonly current: SchedulerService,
    private readonly open: (runtime: string, stateDb: string) => Promise<OpenInstance>) {
    this.catalog = new InstanceCatalog(baseDir);
  }

  async resolve(instanceId = this.currentId): Promise<SchedulerService> {
    if (instanceId === this.currentId) return this.current;
    const record = this.catalog.get(instanceId);
    if (!record) throw new Error("unknown_instance");
    let pending = this.opened.get(instanceId);
    if (!pending) {
      pending = this.open(record.runtimeDir, record.stateDb);
      this.opened.set(instanceId, pending);
    }
    const instance = await pending.catch(error => { this.opened.delete(instanceId); throw error; });
    if (!instance.info.available) {
      this.opened.delete(instanceId);
      await instance.cleanup();
      throw new Error(`instance_unavailable:${instance.info.reason ?? "ownership conflict"}`);
    }
    return instance.scheduler;
  }

  listStored(cwd?: string): { instanceId: string; snapshot: JobSnapshot }[] {
    const out: { instanceId: string; snapshot: JobSnapshot }[] = [];
    for (const record of this.catalog.list()) {
      if (record.instanceId === this.currentId || !existsSync(record.stateDb)) continue;
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(record.stateDb, { readOnly: true, timeout: 1000 });
        const rows = db.prepare("SELECT * FROM jobs ORDER BY updatedAt DESC LIMIT 100").all() as Record<string, any>[];
        for (const row of rows) {
          if (cwd && row.sourceCwd !== cwd && row.worktreePath !== cwd) continue;
          const task = JSON.parse(row.taskJson);
          let meta: { progressJson?: string; reportPath?: string } | undefined;
          try { meta = db.prepare("SELECT progressJson,reportPath FROM job_metadata WHERE jobId=?").get(row.jobId) as typeof meta; } catch { /* old store */ }
          out.push({ instanceId: record.instanceId, snapshot: {
            jobId: row.jobId, runId: row.runId, attempt: row.attempt, sessionId: row.sessionId, state: row.state,
            revision: row.revision, nextAction: row.nextAction, task, modelRequested: row.modelRequested,
            modelReported: row.modelReported, modelSucceeded: row.modelSucceeded === null ? null : !!row.modelSucceeded,
            gatePassed: row.gatePassed === null ? null : !!row.gatePassed, durationMs: row.durationMs,
            toolCallCount: row.toolCallCount, latestTextPreview: row.latestTextPreview, lastError: row.lastError,
            usage: JSON.parse(row.usageJson), approvals: [], createdAt: row.createdAt, updatedAt: row.updatedAt,
            ...(meta?.progressJson ? { progress: JSON.parse(meta.progressJson) } : {}),
            ...(meta?.reportPath ? { reportPath: meta.reportPath } : {}),
          } });
          if (out.length >= 100) return out;
        }
      } catch { /* unavailable/corrupt stores do not prevent discovering other instances */ }
      finally { db?.close(); }
    }
    return out;
  }

  async handoff(args: { action: "save" | "read"; cwd: string; instanceId?: string; jobId?: string;
    goal?: string; completed?: string; next?: string; name?: string }): Promise<unknown> {
    if (args.action === "read") {
      const note = this.catalog.readHandoff(args);
      return { note, resumeHint: note ? { tool: "follow_up", instanceId: note.instanceId, jobId: note.jobId, prompt: note.next,
        ownership: "A live owner rejects resumption; close the former connection or let it finish there." } : null };
    }
    if (!args.jobId) throw new Error("handoff_save_requires_jobId");
    const instanceId = args.instanceId ?? this.currentId;
    const scheduler = await this.resolve(instanceId);
    const job = scheduler.status(args.jobId);
    if (realpathSync(args.cwd) !== realpathSync(job.task.sourceCwd)) throw new Error("handoff_cwd_mismatch");
    return this.catalog.saveHandoff({ cwd: args.cwd, instanceId, jobId: args.jobId, goal: args.goal ?? "",
      completed: args.completed ?? "", next: args.next ?? "", name: args.name });
  }

  async close(): Promise<void> {
    const entries = [...this.opened.values()]; this.opened.clear();
    const results = await Promise.allSettled(entries.map(async entry => (await entry).cleanup()));
    const rejected = results.find(r => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}
