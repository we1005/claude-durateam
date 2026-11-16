/** Event-driven long-poll registry for Scheduler.wait. No polling loops, no leaked timers. */

import type { JobSnapshot } from "../task-contracts.js";
import type { InternalJob } from "./job.js";
import { nextActionFor } from "./job.js";

type NextAction = JobSnapshot["nextAction"];

interface Waiter {
  readonly jobIds: readonly string[];
  readonly gate: ReadonlyMap<string, number>;
  readonly resolve: (result: { timedOut: boolean }) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class WaitHub {
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly probe: (jobId: string) => { revision: number; nextAction: NextAction } | null,
    private readonly maxTimeoutMs: number,
  ) {}

  get size(): number {
    return this.waiters.size;
  }

  /** Immediate when the gate already advanced; otherwise resolves on the next matching revision. */
  wait(jobIds: readonly string[], gate: ReadonlyMap<string, number>, immediate: boolean, timeoutMs: number): Promise<{ timedOut: boolean }> {
    if (immediate) return Promise.resolve({ timedOut: false });
    const effectiveTimeout = Math.max(0, Math.min(timeoutMs, this.maxTimeoutMs));
    return new Promise((resolve) => {
      const waiter: Waiter = { jobIds, gate, resolve, timer: null, done: false };
      this.waiters.add(waiter);
      waiter.timer = setTimeout(() => this.settle(waiter, true), effectiveTimeout);
      (waiter.timer as { unref?: () => void }).unref?.();
    });
  }

  notify(): void {
    for (const waiter of this.waiters) {
      if (waiter.done) continue;
      if (this.advanced(waiter)) this.settle(waiter, false);
    }
  }

  close(): void {
    for (const waiter of [...this.waiters]) this.settle(waiter, true);
  }

  private advanced(waiter: Waiter): boolean {
    for (const jobId of waiter.jobIds) {
      const current = this.probe(jobId);
      if (!current) return true;
      const baseline = waiter.gate.get(jobId) ?? 0;
      if (current.revision > baseline) return true;
    }
    return false;
  }

  private settle(waiter: Waiter, timedOut: boolean): void {
    if (waiter.done) return;
    waiter.done = true;
    this.waiters.delete(waiter);
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    waiter.resolve({ timedOut });
  }
}

/** Preserve approval payloads out of an internal job snapshot. */
export function pendingApprovals(job: InternalJob): JobSnapshot["approvals"] {
  return [...job.approvals.values()].map((pending) => ({ ...pending.request }));
}
