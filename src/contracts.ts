/** Shared worker models, execution profiles and observable task states. */

export const WORKER_MODELS = ["glm-5.3", "glm-5.3-flash"] as const;
export type WorkerModel = (typeof WORKER_MODELS)[number];

export const WORKER_PROFILES = ["read", "edit", "sandboxed-bash", "coding"] as const;
export type WorkerProfile = (typeof WORKER_PROFILES)[number];

/** Terminal/non-terminal states the scheduler will publish in P1. */
export const JOB_STATES = [
  "queued",
  "starting",
  "running",
  "needs_attention",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown_outcome",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export function isWorkerModel(value: unknown): value is WorkerModel {
  return typeof value === "string" && (WORKER_MODELS as readonly string[]).includes(value);
}

export function isWorkerProfile(value: unknown): value is WorkerProfile {
  return typeof value === "string" && (WORKER_PROFILES as readonly string[]).includes(value);
}

/** Model routing for the Volcengine Coding Plan (Anthropic-compatible endpoint). */
export interface ModelRoute {
  readonly id: WorkerModel;
  readonly notes: string;
  /** Whether P0 proved a real tool-calling round trip on this model. */
  readonly verifiedInP0: boolean;
}

export const MODEL_ROUTES: readonly ModelRoute[] = [
  {
    id: "glm-5.3",
    notes: "Primary model. P0 gate model for the Read tool chain.",
    verifiedInP0: true,
  },
  {
    id: "glm-5.3-flash",
    notes: "Low-cost variant; separately validated in P0 (no automatic downgrade).",
    verifiedInP0: true,
  },
];
