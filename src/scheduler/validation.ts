/** Runtime validation for scheduler inputs, prepared tasks and recovered snapshots. */

import type { JobSnapshot, PreparedTask, TaskInput, Usage } from "../task-contracts.js";
import { JOB_STATES, isWorkerModel, isWorkerProfile, type JobState } from "../contracts.js";
import { SchedulerError, describeError } from "./errors.js";
import { MAX_TASK_TURNS, MAX_TASK_DURATION_MS } from "../task-limits.js";

export const DEFAULT_MAX_CONCURRENT = 5;
export const MAX_CONCURRENT_LIMIT = 32;
export const DEFAULT_MAX_QUEUED = 8;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_WAIT_TIMEOUT_MS = 30_000;
export const DEFAULT_CLOSE_GRACE_MS = 10_000;

export interface NormalizedSchedulerOptions {
  maxConcurrent: number;
  maxQueued: number;
  approvalTimeoutMs: number;
  maxWaitTimeoutMs: number;
  closeGraceMs: number;
  idPrefix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: "INVALID_OPTIONS" | "INVALID_TASK" | "INVALID_ARGUMENT" | "WORKSPACE_INVALID" | "CORRUPT_STORE", message: string): never {
  throw new SchedulerError(code, message);
}

function requireString(value: unknown, field: string, label: string, code: "INVALID_TASK" | "WORKSPACE_INVALID" | "CORRUPT_STORE"): string {
  if (typeof value !== "string" || value.length === 0) fail(code, `${label}: ${field} must be a non-empty string`);
  if (value.includes("\u0000")) fail(code, `${label}: ${field} must not contain NUL bytes`);
  return value;
}

function requireStringArray(value: unknown, field: string, label: string, code: "INVALID_TASK" | "WORKSPACE_INVALID" | "CORRUPT_STORE"): void {
  if (!Array.isArray(value)) fail(code, `${label}: ${field} must be an array`);
  value.forEach((entry, index) => requireString(entry, `${field}[${index}]`, label, code));
}

function optionalInteger(value: unknown, field: string, label: string, code: "INVALID_TASK" | "WORKSPACE_INVALID" | "CORRUPT_STORE", min: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < min) fail(code, `${label}: ${field} must be an integer >= ${min}`);
}

function optionalBoolean(value: unknown, field: string, label: string, code: "WORKSPACE_INVALID" | "CORRUPT_STORE"): void {
  if (typeof value !== "boolean") fail(code, `${label}: ${field} must be a boolean`);
}

export function normalizeSchedulerOptions(input: {
  maxConcurrent?: number;
  maxQueued?: number;
  approvalTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  closeGraceMs?: number;
  idPrefix?: string;
}): NormalizedSchedulerOptions {
  const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_LIMIT) {
    fail("INVALID_OPTIONS", `maxConcurrent must be an integer between 1 and ${MAX_CONCURRENT_LIMIT}`);
  }
  const maxQueued = input.maxQueued ?? DEFAULT_MAX_QUEUED;
  if (!Number.isInteger(maxQueued) || maxQueued < 0) fail("INVALID_OPTIONS", "maxQueued must be an integer >= 0");
  const approvalTimeoutMs = input.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  if (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs < 1) fail("INVALID_OPTIONS", "approvalTimeoutMs must be an integer >= 1");
  const maxWaitTimeoutMs = input.maxWaitTimeoutMs ?? MAX_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(maxWaitTimeoutMs) || maxWaitTimeoutMs < 1 || maxWaitTimeoutMs > MAX_WAIT_TIMEOUT_MS) {
    fail("INVALID_OPTIONS", `maxWaitTimeoutMs must be an integer between 1 and ${MAX_WAIT_TIMEOUT_MS}`);
  }
  const closeGraceMs = input.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  if (!Number.isInteger(closeGraceMs) || closeGraceMs < 0) fail("INVALID_OPTIONS", "closeGraceMs must be an integer >= 0");
  const idPrefix = input.idPrefix ?? "CDT";
  if (typeof idPrefix !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(idPrefix)) {
    fail("INVALID_OPTIONS", "idPrefix must match /^[A-Za-z][A-Za-z0-9_-]{0,31}$/");
  }
  return { maxConcurrent, maxQueued, approvalTimeoutMs, maxWaitTimeoutMs, closeGraceMs, idPrefix };
}

export function assertPromptText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_ARGUMENT", `${label} must be a non-empty string`);
  if (value.includes("\u0000")) fail("INVALID_ARGUMENT", `${label} must not contain NUL bytes`);
  return value;
}

export function assertTaskInput(value: TaskInput, index: number): void {
  if (!isRecord(value)) fail("INVALID_TASK", `task[${index}] must be an object`);
  const label = `task[${index}]`;
  requireString(value.cwd, "cwd", label, "INVALID_TASK");
  const prompt = requireString(value.prompt, "prompt", label, "INVALID_TASK");
  if (prompt.trim().length === 0) fail("INVALID_TASK", `${label}: prompt must not be blank`);
  if (value.model !== undefined && !isWorkerModel(value.model)) fail("INVALID_TASK", `${label}: unsupported model`);
  if (value.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.effort as string)) fail("INVALID_TASK", `${label}: unsupported effort`);
  if (value.profile !== undefined && !isWorkerProfile(value.profile)) fail("INVALID_TASK", `${label}: unsupported profile`);
  optionalInteger(value.maxTurns, "maxTurns", label, "INVALID_TASK", 1);
  optionalInteger(value.deadlineMs, "deadlineMs", label, "INVALID_TASK", 1);
  if (value.maxTurns !== undefined && value.maxTurns > MAX_TASK_TURNS) fail("INVALID_TASK", `${label}: maxTurns exceeds ${MAX_TASK_TURNS}`);
  if (value.deadlineMs !== undefined && value.deadlineMs > MAX_TASK_DURATION_MS) fail("INVALID_TASK", `${label}: deadlineMs exceeds ${MAX_TASK_DURATION_MS}`);
  if (value.allowedPaths !== undefined) requireStringArray(value.allowedPaths, "allowedPaths", label, "INVALID_TASK");
  if (value.allowedSkillNames !== undefined) requireStringArray(value.allowedSkillNames, "allowedSkillNames", label, "INVALID_TASK");
  if (value.enabledMcpServers !== undefined) requireStringArray(value.enabledMcpServers, "enabledMcpServers", label, "INVALID_TASK");
}

export function assertPreparedTask(value: unknown, label: string): asserts value is PreparedTask {
  if (!isRecord(value)) fail("WORKSPACE_INVALID", `${label} must be an object`);
  const code = "WORKSPACE_INVALID" as const;
  requireString(value.cwd, "cwd", label, code);
  requireString(value.sourceCwd, "sourceCwd", label, code);
  const prompt = requireString(value.prompt, "prompt", label, code);
  if (prompt.trim().length === 0) fail(code, `${label}: prompt must not be blank`);
  if (!isWorkerModel(value.model)) fail(code, `${label}: model is not a supported worker model`);
  if (value.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.effort as string)) fail(code, `${label}: effort is not supported`);
  if (!isWorkerProfile(value.profile)) fail(code, `${label}: profile is not a supported worker profile`);
  if (!Number.isInteger(value.maxTurns) || (value.maxTurns as number) < 1) fail(code, `${label}: maxTurns must be an integer >= 1`);
  if (!Number.isInteger(value.deadlineMs) || (value.deadlineMs as number) < 1) fail(code, `${label}: deadlineMs must be an integer >= 1`);
  requireStringArray(value.allowedPaths, "allowedPaths", label, code);
  requireStringArray(value.allowedSkillNames, "allowedSkillNames", label, code);
  requireStringArray(value.enabledMcpServers, "enabledMcpServers", label, code);
  if (typeof value.managedWorktree !== "boolean") fail(code, `${label}: managedWorktree must be a boolean`);
  if (value.branch !== null && typeof value.branch !== "string") fail(code, `${label}: branch must be a string or null`);
  if (value.managedWorktree) {
    if (typeof value.branch !== "string" || value.branch.length === 0) fail(code, `${label}: managed worktrees require a branch`);
  } else if (value.branch !== null) {
    fail(code, `${label}: unmanaged tasks must not set a branch`);
  }
  if (value.profile !== "read" && !value.managedWorktree) {
    fail(code, `${label}: write-capable profiles require a managed worktree`);
  }
}

export function assertPreparedMatchesRequest(prepared: PreparedTask, request: TaskInput, label: string): void {
  if (prepared.prompt !== request.prompt) fail("WORKSPACE_INVALID", `${label}: workspace must not rewrite the prompt`);
  if (request.model !== undefined && prepared.model !== request.model) {
    throw new SchedulerError("MODEL_MISMATCH", `${label}: workspace changed requested model ${request.model} to ${prepared.model}`);
  }
  if (request.effort !== undefined && prepared.effort !== request.effort) {
    fail("WORKSPACE_INVALID", `${label}: workspace changed requested effort`);
  }
  if (request.profile !== undefined && prepared.profile !== request.profile) {
    throw new SchedulerError("PROFILE_MISMATCH", `${label}: workspace changed requested profile ${request.profile} to ${prepared.profile}`);
  }
  if (request.maxTurns !== undefined && prepared.maxTurns !== request.maxTurns) {
    fail("WORKSPACE_INVALID", `${label}: workspace changed requested maxTurns`);
  }
  if (request.deadlineMs !== undefined && prepared.deadlineMs !== request.deadlineMs) {
    fail("WORKSPACE_INVALID", `${label}: workspace changed requested deadlineMs`);
  }
}

function assertUsage(value: unknown, label: string): asserts value is Usage {
  if (!isRecord(value)) fail("CORRUPT_STORE", `${label}: usage must be an object`);
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "sdkCostEstimateUsd", "providerBilledCostUsd"]) {
    const entry = value[field];
    if (entry !== null && (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)) {
      fail("CORRUPT_STORE", `${label}: usage.${field} must be a finite number or null`);
    }
  }
}

export function assertStoredSnapshot(value: unknown, label: string): asserts value is JobSnapshot {
  if (!isRecord(value)) fail("CORRUPT_STORE", `${label} must be an object`);
  requireString(value.jobId, "jobId", label, "CORRUPT_STORE");
  requireString(value.runId, "runId", label, "CORRUPT_STORE");
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) fail("CORRUPT_STORE", `${label}: attempt must be an integer >= 1`);
  if (typeof value.state !== "string" || !(JOB_STATES as readonly string[]).includes(value.state)) fail("CORRUPT_STORE", `${label}: unknown job state`);
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) fail("CORRUPT_STORE", `${label}: revision must be an integer >= 0`);
  if (value.sessionId !== null && typeof value.sessionId !== "string") fail("CORRUPT_STORE", `${label}: sessionId must be a string or null`);
  if (!isWorkerModel(value.modelRequested)) fail("CORRUPT_STORE", `${label}: modelRequested is invalid`);
  if (value.modelReported !== null && typeof value.modelReported !== "string") fail("CORRUPT_STORE", `${label}: modelReported must be a string or null`);
  if (value.modelSucceeded !== null && typeof value.modelSucceeded !== "boolean") fail("CORRUPT_STORE", `${label}: modelSucceeded must be a boolean or null`);
  if (value.gatePassed !== null && typeof value.gatePassed !== "boolean") fail("CORRUPT_STORE", `${label}: gatePassed must be a boolean or null`);
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) fail("CORRUPT_STORE", `${label}: durationMs must be >= 0`);
  if (!Number.isInteger(value.toolCallCount) || (value.toolCallCount as number) < 0) fail("CORRUPT_STORE", `${label}: toolCallCount must be an integer >= 0`);
  if (typeof value.latestTextPreview !== "string") fail("CORRUPT_STORE", `${label}: latestTextPreview must be a string`);
  if (value.lastError !== null && typeof value.lastError !== "string") fail("CORRUPT_STORE", `${label}: lastError must be a string or null`);
  assertUsage(value.usage, label);
  if (!Array.isArray(value.approvals)) fail("CORRUPT_STORE", `${label}: approvals must be an array`);
  value.approvals.forEach((approval, index) => {
    if (!isRecord(approval)) fail("CORRUPT_STORE", `${label}: approvals[${index}] must be an object`);
    requireString(approval.requestId, `approvals[${index}].requestId`, label, "CORRUPT_STORE");
    requireString(approval.toolName, `approvals[${index}].toolName`, label, "CORRUPT_STORE");
    if (typeof approval.description !== "string") fail("CORRUPT_STORE", `${label}: approvals[${index}].description must be a string`);
  });
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) fail("CORRUPT_STORE", `${label}: createdAt is not a date`);
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) fail("CORRUPT_STORE", `${label}: updatedAt is not a date`);
  try {
    assertPreparedTask(value.task, `${label}: task`);
  } catch (error) {
    throw new SchedulerError("CORRUPT_STORE", `${label}: invalid prepared task: ${describeError(error)}`, { cause: error });
  }
}
