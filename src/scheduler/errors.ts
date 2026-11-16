/** Scheduler-specific error type. Codes are stable so callers can branch without message parsing. */

export type SchedulerErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_TASK"
  | "INVALID_ARGUMENT"
  | "CLOSED"
  | "FATAL"
  | "UNKNOWN_JOB"
  | "CAPACITY_EXCEEDED"
  | "JOB_NOT_IDLE"
  | "SESSION_UNAVAILABLE"
  | "MODEL_MISMATCH"
  | "PROFILE_MISMATCH"
  | "WORKSPACE_INVALID"
  | "NOT_IMPLEMENTED"
  | "STEER_FAILED"
  | "OWNERSHIP_CONFLICT"
  | "STORE_LOAD_FAILED"
  | "CORRUPT_STORE"
  | "PERSISTENCE_FAILED";

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "SchedulerError";
    this.code = code;
  }
}

export function isSchedulerError(value: unknown): value is SchedulerError {
  return value instanceof SchedulerError;
}

/** Short, single-line description that never assumes the value is an Error. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
