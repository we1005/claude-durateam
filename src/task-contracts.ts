/** Cross-module contract v1. Owned by the coordinator; implementations stay autonomous. */
import type { JobState, WorkerModel, WorkerProfile } from './contracts.js';

export type Priority = 'next' | 'later' | 'now';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface TaskInput {
  cwd: string;
  prompt: string;
  model?: WorkerModel;
  /** Claude Agent SDK effort level. Defaults to high for this bridge. */
  effort?: EffortLevel;
  profile?: WorkerProfile;
  maxTurns?: number;
  deadlineMs?: number;
  allowedPaths?: string[];
  allowedSkillNames?: string[];
  enabledMcpServers?: string[];
}
export interface PreparedTask {
  cwd: string;
  sourceCwd: string;
  model: WorkerModel;
  effort?: EffortLevel;
  profile: WorkerProfile;
  prompt: string;
  maxTurns: number;
  deadlineMs: number;
  allowedPaths: string[];
  allowedSkillNames: string[];
  enabledMcpServers: string[];
  managedWorktree: boolean;
  branch: string | null;
  forkBase?: { parentCwd: string; parentHead: string };
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  sdkCostEstimateUsd: number | null;
  providerBilledCostUsd: number | null;
}
export interface WorkerEvent {
  type: 'init' | 'text' | 'tool_start' | 'tool_end' | 'steer_ack' | 'notice' | 'turn';
  sessionId?: string;
  model?: string;
  text?: string;
  toolName?: string;
  messageId?: string;
  toolCallId?: string;
  path?: string;
  isError?: boolean;
  turnCount?: number;
}
export interface JobProgress {
  turns: number;
  turnsEstimated: boolean;
  phase: 'queued' | 'model' | 'tool' | 'approval' | 'settled';
  lastActivityAt: string | null;
  lastToolAt: string | null;
  recentTools: { id: string; name: string; state: 'running' | 'succeeded' | 'failed'; path?: string; at: string }[];
  touchedFiles: string[];
  editWriteCount: number;
  lastSteer: { messageId: string; disposition: 'queued' | 'delivered' | 'unsupported'; at: string } | null;
  answerState: 'pending' | 'present' | 'missing';
  warnings: string[];
}
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  description: string;
}
export interface RunnerRequest extends PreparedTask {
  jobId: string;
  runId: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  signal: AbortSignal;
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
}
export interface RunnerResult {
  modelSucceeded: boolean;
  sessionId: string | null;
  modelReported: string | null;
  text: string;
  error: string | null;
  usage: Usage;
  reportPath?: string;
}
export interface SteerReceipt {
  messageId: string;
  disposition: 'queued' | 'delivered' | 'unsupported';
}
export interface AgentRunner {
  run(request: RunnerRequest, onEvent: (event: WorkerEvent) => void): Promise<RunnerResult>;
  steer(runId: string, message: string, priority: Priority): Promise<SteerReceipt>;
}
export interface JobSnapshot {
  jobId: string;
  runId: string;
  attempt: number;
  sessionId: string | null;
  state: JobState;
  revision: number;
  nextAction: 'wait' | 'answer' | 'finish';
  task: PreparedTask;
  modelRequested: WorkerModel;
  modelReported: string | null;
  modelSucceeded: boolean | null;
  gatePassed: boolean | null;
  durationMs: number;
  toolCallCount: number;
  latestTextPreview: string;
  lastError: string | null;
  usage: Usage;
  approvals: ApprovalRequest[];
  createdAt: string;
  updatedAt: string;
  progress?: JobProgress;
  reportPath?: string;
}
export interface WorkspaceService {
  /** No writes/model calls. Validate every batch item before prepareBatch. */
  validateBatch(tasks: TaskInput[]): Promise<void>;
  /** Creates isolated edit worktrees; rollback only newly created clean resources on failure. */
  prepareBatch(tasks: TaskInput[]): Promise<PreparedTask[]>;
  /** Isolated snapshot of parent's current tracked + ordinary untracked files. */
  prepareFork?(parent: PreparedTask, input: TaskInput): Promise<PreparedTask>;
}
export interface StateStore {
  /** Must reject another active owner of the same durable store. */
  acquireOwner(): void;
  load(): JobSnapshot[];
  save(snapshot: JobSnapshot): void;
  appendEvent(jobId: string, revision: number, event: unknown): void;
  /** Production stores atomically persist a transition and its event; legacy fakes may omit. */
  commit?(snapshot: JobSnapshot, event: unknown): void;
  close(): void;
}
export interface GateRequest {
  cwd: string;
  allowedPaths: string[];
  commands?: string[][];
  timeoutMs?: number;
}
export interface GateResult {
  passed: boolean;
  violations: string[];
  checks: { command: string[]; exitCode: number | null; timedOut: boolean; log: string }[];
}

export interface WaitResult {
  jobs: JobSnapshot[];
  continueIds: string[];
  nextAction: 'wait' | 'answer' | 'finish';
  timedOut: boolean;
}
export interface SchedulerService {
  spawn(task: TaskInput): Promise<JobSnapshot>;
  spawnBatch(tasks: TaskInput[]): Promise<JobSnapshot[]>;
  status(jobId: string): JobSnapshot;
  sessions(options?: { cwd?: string; state?: JobState; offset?: number; limit?: number }): JobSnapshot[];
  wait(jobIds: string[], options?: { afterRevision?: number | Record<string, number>; timeoutMs?: number }): Promise<WaitResult>;
  followUp(jobId: string, prompt: string, budget?: { maxTurns?: number; deadlineMs?: number }): Promise<JobSnapshot>;
  abort(jobId: string): Promise<JobSnapshot>;
  steer(jobId: string, message: string, priority?: Priority): Promise<SteerReceipt>;
  fork(jobId: string, prompt: string): Promise<JobSnapshot>;
  answer(jobId: string, requestId: string, decision: boolean): Promise<{ acknowledged: boolean }>;
  close(): Promise<void>;
}
