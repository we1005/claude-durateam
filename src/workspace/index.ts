/** Public workspace surface for the scheduler integration. */
export {
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_WORKER_MODEL,
  DEFAULT_WORKER_PROFILE,
  GitWorkspaceService,
  WORKSPACE_LIMITS,
  WorkspacePrepareError,
  WorkspaceValidationError,
} from "./git-workspace.js";
export type {
  CleanupReport,
  GitWorkspaceServiceOptions,
  WorkspaceIssue,
  WorkspaceLimits,
} from "./git-workspace.js";
export { GateInputError, GATE_LIMITS, runGate } from "./gate.js";
export type { GateResultDetail, GateSummary } from "./gate.js";
export { PathPolicyError, classifyRepoPath, normalizeRepoRelative } from "./paths.js";
