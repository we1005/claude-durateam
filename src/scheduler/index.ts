/** Public scheduler surface. Integration: re-export Scheduler here. */

export { Scheduler, type SchedulerOptions } from "./scheduler.js";
export { SchedulerError, describeError, isSchedulerError, type SchedulerErrorCode } from "./errors.js";
export {
  emptyUsage,
  isTerminalState,
  nextActionFor,
  TEXT_PREVIEW_MAX,
  ERROR_MAX,
  EVENT_TEXT_MAX,
} from "./job.js";
export {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  MAX_CONCURRENT_LIMIT,
  MAX_WAIT_TIMEOUT_MS,
} from "./validation.js";
