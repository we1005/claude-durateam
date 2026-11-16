/** Internal job record and snapshot/recovery helpers. */

import type { ApprovalRequest, JobSnapshot, PreparedTask, Usage, JobProgress } from "../task-contracts.js";
import { emptyProgress, copyProgress } from "./progress.js";
import type { JobState, WorkerModel } from "../contracts.js";

export const TEXT_PREVIEW_MAX = 400;
export const ERROR_MAX = 800;
export const EVENT_TEXT_MAX = 400;
export const APPROVAL_DESCRIPTION_MAX = 500;

export type TimerLike = ReturnType<typeof setTimeout>;

const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown_outcome",
]);

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function nextActionFor(state: JobState, approvalCount: number): JobSnapshot["nextAction"] {
  if (isTerminalState(state)) return "finish";
  if (state === "needs_attention" || approvalCount > 0) return "answer";
  return "wait";
}

export function emptyUsage(): Usage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    sdkCostEstimateUsd: null,
    providerBilledCostUsd: null,
  };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function compactText(text: string, max = TEXT_PREVIEW_MAX): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

export interface PendingApproval {
  readonly jobId: string;
  readonly runId: string;
  readonly request: ApprovalRequest;
  readonly resolve: (decision: boolean) => void;
  timer: TimerLike | null;
  settled: boolean;
}

export interface InternalJob {
  jobId: string;
  runId: string;
  attempt: number;
  sessionId: string | null;
  state: JobState;
  revision: number;
  task: PreparedTask;
  modelRequested: WorkerModel;
  modelReported: string | null;
  modelSucceeded: boolean | null;
  gatePassed: boolean | null;
  toolCallCount: number;
  latestTextPreview: string;
  lastError: string | null;
  usage: Usage;
  approvals: Map<string, PendingApproval>;
  createdAt: string;
  updatedAt: string;
  seq: number;
  runPrompt: string;
  resumeSessionId: string | null;
  forkSession: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number;
  holdingSlot: boolean;
  abort: AbortController | null;
  deadlineTimer: TimerLike | null;
  runPromise: Promise<void> | null;
  progress: JobProgress;
  reportPath?: string;
}

export function cloneTask(task: PreparedTask): PreparedTask {
  return {
    ...task,
    allowedPaths: [...task.allowedPaths],
    allowedSkillNames: [...task.allowedSkillNames],
    enabledMcpServers: [...task.enabledMcpServers],
  };
}

export function createJob(input: {
  jobId: string;
  runId: string;
  attempt: number;
  task: PreparedTask;
  seq: number;
  nowMs: number;
  runPrompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
}): InternalJob {
  const now = new Date(input.nowMs).toISOString();
  return {
    jobId: input.jobId,
    runId: input.runId,
    attempt: input.attempt,
    sessionId: null,
    state: "queued",
    revision: 0,
    task: cloneTask(input.task),
    modelRequested: input.task.model,
    modelReported: null,
    modelSucceeded: null,
    gatePassed: null,
    toolCallCount: 0,
    latestTextPreview: "",
    lastError: null,
    usage: emptyUsage(),
    approvals: new Map(),
    createdAt: now,
    updatedAt: now,
    seq: input.seq,
    runPrompt: input.runPrompt,
    resumeSessionId: input.resumeSessionId ?? null,
    forkSession: input.forkSession === true,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    holdingSlot: false,
    abort: null,
    deadlineTimer: null,
    runPromise: null,
    progress: emptyProgress(),
  };
}

export function toSnapshot(job: InternalJob, nowMs: number): JobSnapshot {
  const durationMs =
    job.startedAt !== null
      ? Math.max(0, (job.finishedAt ?? nowMs) - job.startedAt)
      : Math.max(0, job.durationMs);
  return {
    jobId: job.jobId,
    runId: job.runId,
    attempt: job.attempt,
    sessionId: job.sessionId,
    state: job.state,
    revision: job.revision,
    nextAction: nextActionFor(job.state, job.approvals.size),
    task: cloneTask(job.task),
    modelRequested: job.modelRequested,
    modelReported: job.modelReported,
    modelSucceeded: job.modelSucceeded,
    gatePassed: job.gatePassed,
    durationMs,
    toolCallCount: job.toolCallCount,
    latestTextPreview: job.latestTextPreview,
    lastError: job.lastError,
    usage: { ...job.usage },
    approvals: [...job.approvals.values()].map((pending) => ({ ...pending.request })),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: { ...copyProgress(job.progress), phase: isTerminalState(job.state) ? "settled" : job.approvals.size ? "approval" : job.progress.phase },
    ...(job.reportPath ? { reportPath: job.reportPath } : {}),
  };
}

export function cloneSnapshot(snapshot: JobSnapshot): JobSnapshot {
  return {
    ...snapshot,
    task: cloneTask(snapshot.task),
    usage: { ...snapshot.usage },
    approvals: snapshot.approvals.map((approval) => ({ ...approval })),
    ...(snapshot.progress ? { progress: copyProgress(snapshot.progress) } : {}),
  };
}

/** Slow-path recovery: never auto-retry a run. Active states become unknown_outcome. */
export function recoverSnapshot(snapshot: JobSnapshot, nowMs: number, reason: string): InternalJob {
  const terminal = isTerminalState(snapshot.state);
  return {
    jobId: snapshot.jobId,
    runId: snapshot.runId,
    attempt: snapshot.attempt,
    sessionId: snapshot.sessionId,
    state: terminal ? snapshot.state : "unknown_outcome",
    revision: snapshot.revision,
    task: cloneTask(snapshot.task),
    modelRequested: snapshot.modelRequested,
    modelReported: snapshot.modelReported,
    modelSucceeded: terminal ? snapshot.modelSucceeded : null,
    gatePassed: terminal ? snapshot.gatePassed : null,
    toolCallCount: snapshot.toolCallCount,
    latestTextPreview: snapshot.latestTextPreview,
    lastError: terminal ? snapshot.lastError : `${reason}: ${truncate(snapshot.lastError ?? "", ERROR_MAX)}`.trim(),
    usage: { ...snapshot.usage },
    approvals: new Map(),
    createdAt: snapshot.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
    seq: 0,
    runPrompt: snapshot.task.prompt,
    resumeSessionId: null,
    forkSession: false,
    startedAt: null,
    finishedAt: null,
    durationMs: snapshot.durationMs,
    holdingSlot: false,
    abort: null,
    deadlineTimer: null,
    runPromise: null,
    progress: copyProgress(snapshot.progress),
    ...(snapshot.reportPath ? { reportPath: snapshot.reportPath } : {}),
  };
}

