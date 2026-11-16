/**
 * Durable SQLite state store (Node built-in `node:sqlite`, no extra packages).
 *
 * Features required by the contract:
 *  - tables for jobs / runs / events / approvals / sessions / leases /
 *    artifacts / gates;
 *  - atomic writes (single WAL transactions) and monotonic revisions;
 *  - durable, exclusive store ownership (hostname token + owning PID) so two
 *    processes cannot drive the same store, plus a heartbeat so a live owner
 *    is never misdiagnosed as dead;
 *  - crash recovery that NEVER blindly replays: when a dead/stale owner is
 *    detected, every in-flight job (`starting` / `running` / `needs_attention`)
 *    is atomically moved to `unknown_outcome` and an event is recorded, so a
 *    plain `load()` cannot present it as restartable work;
 *  - `close()` releases the lease deterministically.
 *
 * Extra (non-contract) helpers exist for schedulers/doctor and are documented
 * below; the `StateStore` interface itself is unchanged.
 *
 * Known limits (reported, not hidden):
 *  - cross-host ownership cannot verify a foreign PID. A foreign-host lease is
 *    taken over only after its heartbeat is stale for one full TTL; a fresh
 *    foreign heartbeat is always refused.
 *  - PID reuse within the TTL is treated as a live owner (refuse, then retry).
 *  - The store is a durable scheduling record, not a transcript: worktree
 *    content and SDK side effects must still be inspected before retrying.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JOB_STATES, isWorkerProfile, type JobState, type WorkerModel } from "../contracts.js";
import { redactSecrets } from "../observability/redact.js";
import type { ApprovalRequest, GateResult, JobSnapshot, PreparedTask, StateStore, Usage } from "../task-contracts.js";

export interface SqliteStateStoreOptions {
  readonly path: string;
  /** Owner-liveness window. Default 120_000 ms (min 250 ms). */
  readonly leaseTtlMs?: number;
  /** Auto heartbeat interval. Default `leaseTtlMs / 3`, `0` disables it. */
  readonly heartbeatIntervalMs?: number;
  /** Override host identity (tests). Defaults to the stored/OS hostname. */
  readonly hostToken?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
  /** Register a process-exit lease release. Default true. */
  readonly registerExitHandler?: boolean;
}

export type StateStoreErrorCode =
  | "closed"
  | "not-owner"
  | "ownership-conflict"
  | "schema-unsupported"
  | "invalid-snapshot"
  | "invalid-event"
  | "revision-regression"
  | "unknown-job"
  | "corrupt-row"
  | "io";

export class StateStoreError extends Error {
  readonly code: StateStoreErrorCode;

  constructor(code: StateStoreErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StateStoreError";
    this.code = code;
  }
}

export class StoreOwnershipError extends StateStoreError {
  readonly ownerPid: number | null;
  readonly ownerHost: string | null;

  constructor(message: string, owner: { pid: number | null; host: string | null }) {
    super("ownership-conflict", message);
    this.name = "StoreOwnershipError";
    this.ownerPid = owner.pid;
    this.ownerHost = owner.host;
  }
}

export interface OwnerInfo {
  readonly pid: number;
  readonly hostToken: string;
  readonly instanceToken: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly releasedAt: string | null;
}

export interface StoredEvent {
  readonly seq: number;
  readonly revision: number;
  readonly event: unknown;
  readonly createdAt: string;
  readonly truncated: boolean;
}

export interface GateRecord {
  readonly passed: boolean;
  readonly staticChecksPassed?: boolean;
  readonly testsVerified?: boolean;
  readonly violations: string[];
  readonly checks: GateResult["checks"];
  readonly logDir?: string;
}

export interface ArtifactRecordInput {
  readonly kind: string;
  readonly path: string;
  readonly bytes?: number | null;
  readonly sha256?: string | null;
  readonly runId?: string | null;
}

export interface StoredArtifact extends ArtifactRecordInput {
  readonly artifactId: string;
  readonly jobId: string;
  readonly createdAt: string;
}

export const STATE_SCHEMA_VERSION = 1;
const STORE_LEASE_ID = "store";
const DEFAULT_LEASE_TTL_MS = 120_000;
const MIN_LEASE_TTL_MS = 250;
const MAX_EVENT_JSON_BYTES = 32 * 1024;
const IN_FLIGHT_STATES: readonly JobState[] = ["starting", "running", "needs_attention"];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  jobId TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  sessionId TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  nextAction TEXT NOT NULL,
  taskJson TEXT NOT NULL,
  sourceCwd TEXT NOT NULL,
  worktreePath TEXT NOT NULL,
  profile TEXT NOT NULL,
  modelRequested TEXT NOT NULL,
  modelReported TEXT,
  modelSucceeded INTEGER,
  gatePassed INTEGER,
  durationMs INTEGER NOT NULL,
  toolCallCount INTEGER NOT NULL,
  latestTextPreview TEXT NOT NULL,
  lastError TEXT,
  usageJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastEventRevision INTEGER NOT NULL,
  ownerPid INTEGER,
  ownerHost TEXT
);
CREATE TABLE IF NOT EXISTS job_metadata (
  jobId TEXT PRIMARY KEY REFERENCES jobs(jobId) ON DELETE CASCADE,
  progressJson TEXT,
  reportPath TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  runId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  profile TEXT NOT NULL,
  modelRequested TEXT NOT NULL,
  modelReported TEXT,
  sourceCwd TEXT NOT NULL,
  worktreePath TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  runId TEXT NOT NULL,
  modelReported TEXT,
  sourceCwd TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  eventJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_job_revision ON events(jobId, revision, seq);
CREATE TABLE IF NOT EXISTS approvals (
  requestId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  toolName TEXT NOT NULL,
  description TEXT NOT NULL,
  decision INTEGER,
  requestedAt TEXT NOT NULL,
  decidedAt TEXT
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(jobId, decision);
CREATE TABLE IF NOT EXISTS leases (
  leaseId TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  jobId TEXT,
  ownerPid INTEGER NOT NULL,
  hostToken TEXT NOT NULL,
  instanceToken TEXT NOT NULL,
  acquiredAtMs INTEGER NOT NULL,
  heartbeatAtMs INTEGER NOT NULL,
  releasedAtMs INTEGER
);
CREATE TABLE IF NOT EXISTS gates (
  gateId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  runId TEXT NOT NULL,
  passed INTEGER NOT NULL,
  staticChecksPassed INTEGER,
  testsVerified INTEGER,
  violationsJson TEXT NOT NULL,
  checksJson TEXT NOT NULL,
  logDir TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifactId TEXT PRIMARY KEY,
  jobId TEXT NOT NULL REFERENCES jobs(jobId) ON DELETE CASCADE,
  runId TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  bytes INTEGER,
  createdAt TEXT NOT NULL
);
`;

interface LeaseRow {
  leaseId: string;
  kind: string;
  jobId: string | null;
  ownerPid: number;
  hostToken: string;
  instanceToken: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  releasedAtMs: number | null;
}

interface JobRow {
  jobId: string;
  runId: string;
  attempt: number;
  sessionId: string | null;
  state: string;
  revision: number;
  nextAction: string;
  taskJson: string;
  sourceCwd: string;
  worktreePath: string;
  profile: string;
  modelRequested: string;
  modelReported: string | null;
  modelSucceeded: number | null;
  gatePassed: number | null;
  durationMs: number;
  toolCallCount: number;
  latestTextPreview: string;
  lastError: string | null;
  usageJson: string;
  createdAt: string;
  updatedAt: string;
  lastEventRevision: number;
}

interface ApprovalRow {
  requestId: string;
  toolName: string;
  description: string;
  decision: number | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new StateStoreError("invalid-snapshot", `${label} must be a non-negative number or null`);
  }
  return value;
}

export class SqliteStateStore implements StateStore {
  readonly path: string;
  readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly options: SqliteStateStoreOptions;
  private readonly now: () => number;
  private readonly db: DatabaseSync;
  private readonly effectiveHost: string;
  private readonly instanceToken = randomUUID();
  private readonly exitHandler: (() => void) | null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private acquired = false;
  private closed = false;
  private interruptedJobIds: string[] = [];

  constructor(options: SqliteStateStoreOptions) {
    if (!isPlainObject(options) || !nonEmptyString(options.path)) {
      throw new StateStoreError("io", "path must be a non-empty string");
    }
    this.options = options;
    this.leaseTtlMs = Math.max(MIN_LEASE_TTL_MS, options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const interval = options.heartbeatIntervalMs ?? Math.max(MIN_LEASE_TTL_MS, Math.floor(this.leaseTtlMs / 3));
    this.heartbeatIntervalMs = interval > 0 ? Math.max(50, interval) : 0;
    this.now = options.now ?? (() => Date.now());

    const memory = options.path === ":memory:";
    this.path = memory ? options.path : realPathForNewFile(options.path);
    if (!memory) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.path, { enableForeignKeyConstraints: true, timeout: 5_000 });
    if (!memory && existsSync(this.path)) {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // best effort on filesystems that do not support chmod (e.g. FAT)
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.initSchema();
    this.effectiveHost = options.hostToken ?? this.readMetaHost() ?? hostname();
    this.writeMeta("host_token", this.effectiveHost);

    this.exitHandler = options.registerExitHandler === false ? null : () => {
      try {
        this.releaseLeaseSync();
      } catch {
        /* process is exiting */
      }
    };
    if (this.exitHandler) process.on("exit", this.exitHandler);
  }

  // ---------------------------------------------------------------- ownership

  /**
   * Acquire exclusive durable ownership. Re-acquiring from the same instance
   * is idempotent; another live owner is always refused. A dead/stale owner
   * triggers recovery (in-flight jobs -> `unknown_outcome`), never replay.
   */
  acquireOwner(): void {
    this.requireOpen();
    const result = this.transaction(() => {
      const lease = this.readLease(STORE_LEASE_ID);
      if (this.acquired && lease) {
        if (lease.instanceToken === this.instanceToken && lease.releasedAtMs === null) {
          this.touchLease();
          return { acquired: true, recovered: [] as string[] };
        }
        this.acquired = false;
      }
      if (lease && lease.releasedAtMs === null && lease.instanceToken !== this.instanceToken) {
        const sameHost = lease.hostToken === this.effectiveHost;
        const pidAlive = sameHost ? defaultPidAlive(lease.ownerPid) : false;
        const ageMs = this.now() - lease.heartbeatAtMs;
        if (!sameHost && ageMs < this.leaseTtlMs * 10) {
          throw new StoreOwnershipError(
            `state store is owned by host ${lease.hostToken} (pid ${lease.ownerPid}) with a heartbeat ${ageMs}ms old; refusing cross-host takeover`,
            { pid: lease.ownerPid, host: lease.hostToken },
          );
        }
        if (sameHost && pidAlive) {
          throw new StoreOwnershipError(
            `state store is owned by live pid ${lease.ownerPid} on this host (heartbeat ${ageMs}ms old); refusing takeover`,
            { pid: lease.ownerPid, host: lease.hostToken },
          );
        }
        const recovered = this.recoverInterruptedJobs(lease);
        this.writeLease({
          leaseId: STORE_LEASE_ID,
          kind: "store",
          jobId: null,
          ownerPid: process.pid,
          hostToken: this.effectiveHost,
          instanceToken: this.instanceToken,
          acquiredAtMs: this.now(),
          heartbeatAtMs: this.now(),
          releasedAtMs: null,
        });
        for (const jobId of recovered) {
          this.insertEvent(jobId, this.currentRevision(jobId), {
            type: "owner_recovery",
            priorOwnerPid: lease.ownerPid,
            priorOwnerHost: lease.hostToken,
            reason: "previous owner is dead or its heartbeat expired",
            disposition: "unknown_outcome",
          });
        }
        return { acquired: true, recovered };
      }
      this.writeLease({
        leaseId: STORE_LEASE_ID,
        kind: "store",
        jobId: null,
        ownerPid: process.pid,
        hostToken: this.effectiveHost,
        instanceToken: this.instanceToken,
        acquiredAtMs: this.now(),
        heartbeatAtMs: this.now(),
        releasedAtMs: null,
      });
      return { acquired: true, recovered: [] as string[] };
    });

    if (!result.acquired) throw new StateStoreError("io", "ownership acquisition failed unexpectedly");
    this.acquired = true;
    this.interruptedJobIds = result.recovered;
    this.startHeartbeat();
  }

  /** Refresh the durable lease; throws if another owner took the store over. */
  heartbeat(): void {
    this.requireOwner();
    this.touchLease();
  }

  /** Jobs that this acquisition moved to `unknown_outcome` (empty on clean start). */
  get recoveredJobIds(): readonly string[] {
    return this.interruptedJobIds;
  }

  ownerInfo(): OwnerInfo | null {
    this.requireOpen();
    const lease = this.readLease(STORE_LEASE_ID);
    if (!lease) return null;
    return {
      pid: lease.ownerPid,
      hostToken: lease.hostToken,
      instanceToken: lease.instanceToken,
      acquiredAt: iso(lease.acquiredAtMs),
      heartbeatAt: iso(lease.heartbeatAtMs),
      releasedAt: lease.releasedAtMs === null ? null : iso(lease.releasedAtMs),
    };
  }

  /** Release the lease without closing the database (used by close()). */
  releaseOwner(): void {
    this.requireOpen();
    if (!this.acquired) return;
    this.releaseLeaseSync();
    this.acquired = false;
    this.stopHeartbeat();
  }

  // --------------------------------------------------------------- state API

  load(): JobSnapshot[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY createdAt ASC, jobId ASC")
      .all() as unknown as JobRow[];
    return rows.map((row) => this.rowToSnapshot(row));
  }

  save(snapshot: JobSnapshot): void {
    this.requireOwner();
    this.validateSnapshot(snapshot);
    const context = this.leaseContext();
    this.transaction(() => {
      const existing = this.readJobRevisions(snapshot.jobId);
      if (existing && snapshot.revision < existing.revision) {
        throw new StateStoreError(
          "revision-regression",
          `job ${snapshot.jobId} revision ${snapshot.revision} would regress from ${existing.revision}`,
        );
      }
      this.persistSnapshotInTx(snapshot, existing?.lastEventRevision ?? 0, context);
    });
  }

  appendEvent(jobId: string, revision: number, event: unknown): void {
    this.requireOwner();
    if (!nonEmptyString(jobId)) throw new StateStoreError("invalid-event", "jobId must be a non-empty string");
    if (!Number.isInteger(revision) || revision < 0) {
      throw new StateStoreError("invalid-event", "revision must be a non-negative integer");
    }
    this.transaction(() => {
      const job = this.readJobRevisions(jobId);
      if (!job) throw new StateStoreError("unknown-job", `cannot append an event for unknown job ${jobId}`);
      if (revision < job.lastEventRevision) {
        throw new StateStoreError(
          "revision-regression",
          `event revision ${revision} for ${jobId} is older than ${job.lastEventRevision}`,
        );
      }
      this.appendEventInTx(jobId, revision, event);
    });
  }

  /**
   * v1.1 optional atomic transition: persist the snapshot AND its event inside
   * one `BEGIN IMMEDIATE`. Any failing write (including a rejected event
   * INSERT) rolls the whole transition back, so a scheduler can never leave a
   * state/revision ahead of its event log. No nested transactions are used;
   * the helpers below assume they already run inside this transaction.
   */
  commit(snapshot: JobSnapshot, event: unknown): void {
    this.requireOwner();
    this.validateSnapshot(snapshot);
    const context = this.leaseContext();
    this.transaction(() => {
      const existing = this.readJobRevisions(snapshot.jobId);
      if (existing && snapshot.revision < existing.revision) {
        throw new StateStoreError(
          "revision-regression",
          `job ${snapshot.jobId} revision ${snapshot.revision} would regress from ${existing.revision}`,
        );
      }
      if (existing && snapshot.revision < existing.lastEventRevision) {
        throw new StateStoreError(
          "revision-regression",
          `event revision ${snapshot.revision} for ${snapshot.jobId} is older than ${existing.lastEventRevision}`,
        );
      }
      this.persistSnapshotInTx(snapshot, existing?.lastEventRevision ?? 0, context);
      this.appendEventInTx(snapshot.jobId, snapshot.revision, event);
    });
  }

  close(): void {
    if (this.closed) return;
    this.stopHeartbeat();
    if (this.exitHandler) process.off("exit", this.exitHandler);
    try {
      this.releaseLeaseSync();
    } catch {
      /* never mask a close failure with a lease-release error */
    }
    this.closed = true;
    this.acquired = false;
    this.db.close();
  }

  // ------------------------------------------------------------- extra helpers

  pendingApprovals(jobId: string): ApprovalRequest[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT requestId, toolName, description FROM approvals WHERE jobId = ? AND decision IS NULL ORDER BY requestedAt ASC")
      .all(jobId) as unknown as ApprovalRow[];
    return rows.map((row) => ({
      requestId: row.requestId,
      toolName: row.toolName,
      description: row.description,
    }));
  }

  /** Record a human/scheduler decision; only pending approvals can be decided. */
  resolveApproval(jobId: string, requestId: string, decision: boolean): boolean {
    this.requireOwner();
    const result = this.db
      .prepare("UPDATE approvals SET decision = ?, decidedAt = ? WHERE jobId = ? AND requestId = ? AND decision IS NULL")
      .run(decision ? 1 : 0, iso(this.now()), jobId, requestId);
    return Number(result.changes) > 0;
  }

  listApprovals(jobId: string): Array<ApprovalRequest & { decision: boolean | null; decidedAt: string | null }> {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT requestId, toolName, description, decision, decidedAt FROM approvals WHERE jobId = ? ORDER BY requestedAt ASC")
      .all(jobId) as unknown as Array<ApprovalRow & { decidedAt: string | null }>;
    return rows
      .filter((row): row is ApprovalRow & { decidedAt: string | null } => typeof row.requestId === "string")
      .map((row) => ({
        requestId: row.requestId,
        toolName: row.toolName,
        description: row.description,
        decision: row.decision === null ? null : row.decision === 1,
        decidedAt: row.decidedAt ?? null,
      }));
  }

  recordGate(jobId: string, runId: string, gate: GateRecord): string {
    this.requireOwner();
    if (!nonEmptyString(jobId) || !nonEmptyString(runId)) {
      throw new StateStoreError("invalid-snapshot", "jobId and runId are required for a gate record");
    }
    const gateId = randomUUID();
    const violations = gate.violations.map((entry) => redactSecrets(entry).slice(0, 2_000));
    const checks = gate.checks.map((entry) => ({ ...entry, log: redactSecrets(entry.log) }));
    this.transaction(() => {
      const job = this.db.prepare("SELECT 1 AS ok FROM jobs WHERE jobId = ?").get(jobId);
      if (!job) throw new StateStoreError("unknown-job", `cannot record a gate for unknown job ${jobId}`);
      this.db
        .prepare(
          "INSERT INTO gates (gateId, jobId, runId, passed, staticChecksPassed, testsVerified, violationsJson, checksJson, logDir, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          gateId,
          jobId,
          runId,
          gate.passed ? 1 : 0,
          gate.staticChecksPassed === undefined ? null : gate.staticChecksPassed ? 1 : 0,
          gate.testsVerified === undefined ? null : gate.testsVerified ? 1 : 0,
          JSON.stringify(violations),
          JSON.stringify(checks),
          gate.logDir ?? null,
          iso(this.now()),
        );
    });
    return gateId;
  }

  recordArtifact(jobId: string, artifact: ArtifactRecordInput): StoredArtifact {
    this.requireOwner();
    if (!nonEmptyString(jobId)) throw new StateStoreError("invalid-snapshot", "jobId is required");
    if (!nonEmptyString(artifact.kind) || !nonEmptyString(artifact.path)) {
      throw new StateStoreError("invalid-snapshot", "artifact kind and path are required");
    }
    const record: StoredArtifact = {
      artifactId: randomUUID(),
      jobId,
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes ?? null,
      sha256: artifact.sha256 ?? null,
      runId: artifact.runId ?? null,
      createdAt: iso(this.now()),
    };
    this.transaction(() => {
      const job = this.db.prepare("SELECT 1 AS ok FROM jobs WHERE jobId = ?").get(jobId);
      if (!job) throw new StateStoreError("unknown-job", `cannot record an artifact for unknown job ${jobId}`);
      this.db
        .prepare(
          "INSERT INTO artifacts (artifactId, jobId, runId, kind, path, sha256, bytes, createdAt) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          record.artifactId,
          record.jobId,
          record.runId ?? null,
          record.kind,
          record.path,
          record.sha256 ?? null,
          record.bytes ?? null,
          record.createdAt,
        );
    });
    return record;
  }

  listArtifacts(jobId: string): StoredArtifact[] {
    this.requireOpen();
    const rows = this.db
      .prepare("SELECT artifactId, jobId, runId, kind, path, sha256, bytes, createdAt FROM artifacts WHERE jobId = ? ORDER BY createdAt ASC")
      .all(jobId) as unknown as Array<{
      artifactId: string;
      jobId: string;
      runId: string | null;
      kind: string;
      path: string;
      sha256: string | null;
      bytes: number | null;
      createdAt: string;
    }>;
    return rows.map((row) => ({
      artifactId: row.artifactId,
      jobId: row.jobId,
      runId: row.runId ?? null,
      kind: row.kind,
      path: row.path,
      sha256: row.sha256 ?? null,
      bytes: row.bytes ?? null,
      createdAt: row.createdAt,
    }));
  }

  loadEvents(jobId: string, options: { afterRevision?: number; limit?: number } = {}): StoredEvent[] {
    this.requireOpen();
    const afterRevision = options.afterRevision ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new StateStoreError("invalid-event", "afterRevision must be a non-negative integer");
    }
    const rows = this.db
      .prepare("SELECT seq, revision, eventJson, createdAt, truncated FROM events WHERE jobId = ? AND revision >= ? ORDER BY seq ASC LIMIT ?")
      .all(jobId, afterRevision, limit) as unknown as Array<{
      seq: number;
      revision: number;
      eventJson: string;
      createdAt: string;
      truncated: number;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      revision: row.revision,
      event: parseJson(row.eventJson, `event ${row.seq}`),
      createdAt: row.createdAt,
      truncated: row.truncated === 1,
    }));
  }

  sessionJobId(sessionId: string): string | null {
    this.requireOpen();
    const row = this.db.prepare("SELECT jobId FROM sessions WHERE sessionId = ?").get(sessionId) as
      | { jobId: string }
      | undefined;
    return row ? row.jobId : null;
  }

  // ------------------------------------------------------------------ internals

  private initSchema(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > STATE_SCHEMA_VERSION) {
      throw new StateStoreError(
        "schema-unsupported",
        `state store schema v${version} is newer than v${STATE_SCHEMA_VERSION}; refusing to open`,
      );
    }
    this.transaction(() => {
      this.db.exec(SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION}`);
    });
  }

  private requireOpen(): void {
    if (this.closed) throw new StateStoreError("closed", "state store is closed");
  }

  private requireOwner(): void {
    this.requireOpen();
    if (!this.acquired) {
      throw new StateStoreError("not-owner", "acquireOwner() must be called before mutating the state store");
    }
  }

  private leaseContext(): { pid: number; host: string } {
    return { pid: process.pid, host: this.effectiveHost };
  }

  private readMetaHost(): string | null {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'host_token'").get() as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO schema_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private readLease(leaseId: string): LeaseRow | null {
    const row = this.db.prepare("SELECT * FROM leases WHERE leaseId = ?").get(leaseId) as LeaseRow | undefined;
    return row ?? null;
  }

  private writeLease(lease: LeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO leases (leaseId, kind, jobId, ownerPid, hostToken, instanceToken, acquiredAtMs, heartbeatAtMs, releasedAtMs)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(leaseId) DO UPDATE SET ownerPid=excluded.ownerPid, hostToken=excluded.hostToken,
           instanceToken=excluded.instanceToken, acquiredAtMs=excluded.acquiredAtMs,
           heartbeatAtMs=excluded.heartbeatAtMs, releasedAtMs=excluded.releasedAtMs`,
      )
      .run(
        lease.leaseId,
        lease.kind,
        lease.jobId,
        lease.ownerPid,
        lease.hostToken,
        lease.instanceToken,
        lease.acquiredAtMs,
        lease.heartbeatAtMs,
        lease.releasedAtMs,
      );
  }

  private touchLease(): void {
    const result = this.db
      .prepare(
        "UPDATE leases SET heartbeatAtMs = ? WHERE leaseId = ? AND instanceToken = ? AND releasedAtMs IS NULL",
      )
      .run(this.now(), STORE_LEASE_ID, this.instanceToken);
    if (Number(result.changes) === 0) {
      throw new StateStoreError(
        "ownership-conflict",
        "lease heartbeat failed: this instance no longer owns the store",
      );
    }
  }

  private releaseLeaseSync(): void {
    if (this.closed) return;
    this.db
      .prepare("UPDATE leases SET releasedAtMs = ? WHERE leaseId = ? AND instanceToken = ? AND releasedAtMs IS NULL")
      .run(this.now(), STORE_LEASE_ID, this.instanceToken);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs === 0) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.touchLease();
      } catch {
        this.stopHeartbeat();
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private recoverInterruptedJobs(lease: LeaseRow): string[] {
    const recovered: string[] = [];
    const nowIso = iso(this.now());
    const jobs = this.db
      .prepare("SELECT jobId, revision, state FROM jobs WHERE state IN ('starting','running','needs_attention')")
      .all() as unknown as Array<{ jobId: string; revision: number; state: string }>;
    for (const job of jobs) {
      const nextRevision = job.revision + 1;
      this.db
        .prepare("UPDATE jobs SET state = 'unknown_outcome', revision = ?, nextAction = 'answer', lastError = ?, updatedAt = ? WHERE jobId = ?")
        .run(
          nextRevision,
          `previous store owner (pid ${lease.ownerPid} on ${lease.hostToken}) disappeared while state was '${job.state}'; outcome is unknown, inspect git/worktree before retrying`,
          nowIso,
          job.jobId,
        );
      recovered.push(job.jobId);
    }
    return recovered;
  }

  private currentRevision(jobId: string): number {
    const row = this.db.prepare("SELECT revision FROM jobs WHERE jobId = ?").get(jobId) as
      | { revision: number }
      | undefined;
    if (!row) throw new StateStoreError("unknown-job", `unknown job ${jobId}`);
    return row.revision;
  }

  private insertEvent(jobId: string, revision: number, event: unknown): void {
    let serialized: string;
    try {
      serialized = redactSecrets(JSON.stringify(event) ?? "null");
    } catch (error) {
      throw new StateStoreError("invalid-event", "event is not JSON-serializable", { cause: error });
    }
    let truncated = 0;
    if (serialized.length > MAX_EVENT_JSON_BYTES) {
      serialized = JSON.stringify({
        truncated: true,
        originalBytes: serialized.length,
        preview: serialized.slice(0, MAX_EVENT_JSON_BYTES - 64),
      });
      truncated = 1;
    }
    this.db
      .prepare("INSERT INTO events (jobId, revision, eventJson, createdAt, truncated) VALUES (?,?,?,?,?)")
      .run(jobId, revision, serialized, iso(this.now()), truncated);
  }

  private readJobRevisions(jobId: string): { revision: number; lastEventRevision: number } | null {
    const row = this.db
      .prepare("SELECT revision, lastEventRevision FROM jobs WHERE jobId = ?")
      .get(jobId) as { revision: number; lastEventRevision: number } | undefined;
    return row ?? null;
  }

  /** All snapshot-related rows; caller owns the surrounding transaction. */
  private persistSnapshotInTx(
    snapshot: JobSnapshot,
    priorLastEventRevision: number,
    context: { pid: number; host: string },
  ): void {
    const usageJson = JSON.stringify(snapshot.usage);
    this.db
      .prepare(
        `INSERT INTO jobs (
          jobId, runId, attempt, sessionId, state, revision, nextAction, taskJson, sourceCwd,
          worktreePath, profile, modelRequested, modelReported, modelSucceeded, gatePassed,
          durationMs, toolCallCount, latestTextPreview, lastError, usageJson, createdAt, updatedAt,
          lastEventRevision, ownerPid, ownerHost
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(jobId) DO UPDATE SET
          runId=excluded.runId, attempt=excluded.attempt, sessionId=excluded.sessionId,
          state=excluded.state, revision=excluded.revision, nextAction=excluded.nextAction,
          taskJson=excluded.taskJson, sourceCwd=excluded.sourceCwd, worktreePath=excluded.worktreePath,
          profile=excluded.profile, modelRequested=excluded.modelRequested,
          modelReported=excluded.modelReported, modelSucceeded=excluded.modelSucceeded,
          gatePassed=excluded.gatePassed, durationMs=excluded.durationMs,
          toolCallCount=excluded.toolCallCount, latestTextPreview=excluded.latestTextPreview,
          lastError=excluded.lastError, usageJson=excluded.usageJson, createdAt=excluded.createdAt,
          updatedAt=excluded.updatedAt, ownerPid=excluded.ownerPid, ownerHost=excluded.ownerHost`,
      )
      .run(
        snapshot.jobId,
        snapshot.runId,
        snapshot.attempt,
        snapshot.sessionId,
        snapshot.state,
        snapshot.revision,
        snapshot.nextAction,
        JSON.stringify(snapshot.task),
        snapshot.task.sourceCwd,
        snapshot.task.cwd,
        snapshot.task.profile,
        snapshot.modelRequested,
        snapshot.modelReported,
        snapshot.modelSucceeded === null ? null : snapshot.modelSucceeded ? 1 : 0,
        snapshot.gatePassed === null ? null : snapshot.gatePassed ? 1 : 0,
        snapshot.durationMs,
        snapshot.toolCallCount,
        snapshot.latestTextPreview,
        snapshot.lastError,
        usageJson,
        snapshot.createdAt,
        snapshot.updatedAt,
        Math.max(snapshot.revision, priorLastEventRevision),
        context.pid,
        context.host,
      );

    this.db.prepare(`INSERT INTO job_metadata(jobId,progressJson,reportPath) VALUES(?,?,?)
      ON CONFLICT(jobId) DO UPDATE SET progressJson=excluded.progressJson,reportPath=excluded.reportPath`)
      .run(snapshot.jobId, snapshot.progress ? JSON.stringify(snapshot.progress) : null, snapshot.reportPath ?? null);

    this.db
      .prepare(
        `INSERT INTO runs (runId, jobId, attempt, state, profile, modelRequested, modelReported,
          sourceCwd, worktreePath, startedAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(runId) DO UPDATE SET state=excluded.state, modelReported=excluded.modelReported,
          updatedAt=excluded.updatedAt`,
      )
      .run(
        snapshot.runId,
        snapshot.jobId,
        snapshot.attempt,
        snapshot.state,
        snapshot.task.profile,
        snapshot.modelRequested,
        snapshot.modelReported,
        snapshot.task.sourceCwd,
        snapshot.task.cwd,
        snapshot.createdAt,
        snapshot.updatedAt,
      );

    if (snapshot.sessionId) {
      this.db
        .prepare(
          `INSERT INTO sessions (sessionId, jobId, runId, modelReported, sourceCwd, lastSeenAt)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(sessionId) DO UPDATE SET jobId=excluded.jobId, runId=excluded.runId,
             modelReported=excluded.modelReported, lastSeenAt=excluded.lastSeenAt`,
        )
        .run(
          snapshot.sessionId,
          snapshot.jobId,
          snapshot.runId,
          snapshot.modelReported,
          snapshot.task.sourceCwd,
          snapshot.updatedAt,
        );
    }

    for (const approval of snapshot.approvals) {
      this.db
        .prepare(
          `INSERT INTO approvals (requestId, jobId, revision, toolName, description, decision, requestedAt, decidedAt)
           VALUES (?,?,?,?,?,NULL,?,NULL)
           ON CONFLICT(requestId) DO UPDATE SET
             toolName=excluded.toolName, description=excluded.description, revision=excluded.revision`,
        )
        .run(
          approval.requestId,
          snapshot.jobId,
          snapshot.revision,
          approval.toolName,
          approval.description,
          snapshot.updatedAt,
        );
    }
  }

  /** Event row + lastEventRevision bump; caller owns the transaction. */
  private appendEventInTx(jobId: string, revision: number, event: unknown): void {
    this.insertEvent(jobId, revision, event);
    this.db.prepare("UPDATE jobs SET lastEventRevision = ? WHERE jobId = ?").run(revision, jobId);
  }

  private rowToSnapshot(row: JobRow): JobSnapshot {
    const meta = this.db.prepare("SELECT progressJson,reportPath FROM job_metadata WHERE jobId=?").get(row.jobId) as {progressJson:string|null;reportPath:string|null}|undefined;
    const task = parseJson(row.taskJson, `job ${row.jobId} task`) as PreparedTask;
    if (!isPlainObject(task) || !nonEmptyString(task.cwd) || !isWorkerProfile(task.profile)) {
      throw new StateStoreError("corrupt-row", `job ${row.jobId} has an invalid task payload`);
    }
    const usage = parseJson(row.usageJson, `job ${row.jobId} usage`) as Usage;
    const approvals = this.pendingApprovals(row.jobId);
    const state = row.state as JobState;
    if (!(JOB_STATES as readonly string[]).includes(state)) {
      throw new StateStoreError("corrupt-row", `job ${row.jobId} has unknown state ${row.state}`);
    }
    return {
      jobId: row.jobId,
      ...(meta?.progressJson ? { progress: JSON.parse(meta.progressJson) } : {}),
      ...(meta?.reportPath ? { reportPath: meta.reportPath } : {}),
      runId: row.runId,
      attempt: row.attempt,
      sessionId: row.sessionId,
      state,
      revision: row.revision,
      nextAction: row.nextAction as JobSnapshot["nextAction"],
      task,
      modelRequested: row.modelRequested as WorkerModel,
      modelReported: row.modelReported,
      modelSucceeded: row.modelSucceeded === null ? null : row.modelSucceeded === 1,
      gatePassed: row.gatePassed === null ? null : row.gatePassed === 1,
      durationMs: row.durationMs,
      toolCallCount: row.toolCallCount,
      latestTextPreview: row.latestTextPreview,
      lastError: row.lastError,
      usage: {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        sdkCostEstimateUsd: usage?.sdkCostEstimateUsd ?? null,
        providerBilledCostUsd: usage?.providerBilledCostUsd ?? null,
      },
      approvals,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private validateSnapshot(snapshot: JobSnapshot): void {
    if (!isPlainObject(snapshot)) throw new StateStoreError("invalid-snapshot", "snapshot must be an object");
    if (!nonEmptyString(snapshot.jobId)) throw new StateStoreError("invalid-snapshot", "jobId is required");
    if (!nonEmptyString(snapshot.runId)) throw new StateStoreError("invalid-snapshot", "runId is required");
    if (!Number.isInteger(snapshot.attempt) || snapshot.attempt < 1) {
      throw new StateStoreError("invalid-snapshot", "attempt must be a positive integer");
    }
    if (!(JOB_STATES as readonly string[]).includes(snapshot.state)) {
      throw new StateStoreError("invalid-snapshot", `unknown job state ${String(snapshot.state)}`);
    }
    if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new StateStoreError("invalid-snapshot", "revision must be a non-negative integer");
    }
    if (snapshot.nextAction !== "wait" && snapshot.nextAction !== "answer" && snapshot.nextAction !== "finish") {
      throw new StateStoreError("invalid-snapshot", "nextAction must be wait / answer / finish");
    }
    if (!isPlainObject(snapshot.task) || !nonEmptyString(snapshot.task.cwd)) {
      throw new StateStoreError("invalid-snapshot", "task.cwd is required");
    }
    if (!isWorkerProfile(snapshot.task.profile)) {
      throw new StateStoreError("invalid-snapshot", "task.profile is invalid");
    }
    if (!Array.isArray(snapshot.approvals)) {
      throw new StateStoreError("invalid-snapshot", "approvals must be an array");
    }
    for (const approval of snapshot.approvals) {
      if (
        !isPlainObject(approval) ||
        !nonEmptyString(approval.requestId) ||
        !nonEmptyString(approval.toolName) ||
        typeof approval.description !== "string"
      ) {
        throw new StateStoreError("invalid-snapshot", "approval entries need requestId/toolName/description");
      }
    }
    if (!isPlainObject(snapshot.usage)) throw new StateStoreError("invalid-snapshot", "usage is required");
    optionalNumber(snapshot.usage.inputTokens, "usage.inputTokens");
    optionalNumber(snapshot.usage.outputTokens, "usage.outputTokens");
    optionalNumber(snapshot.usage.cacheReadTokens, "usage.cacheReadTokens");
    optionalNumber(snapshot.usage.sdkCostEstimateUsd, "usage.sdkCostEstimateUsd");
    optionalNumber(snapshot.usage.providerBilledCostUsd, "usage.providerBilledCostUsd");
    if (typeof snapshot.createdAt !== "string" || typeof snapshot.updatedAt !== "string") {
      throw new StateStoreError("invalid-snapshot", "createdAt/updatedAt must be ISO strings");
    }
    if (!Number.isFinite(snapshot.durationMs) || snapshot.durationMs < 0) {
      throw new StateStoreError("invalid-snapshot", "durationMs must be a non-negative number");
    }
    if (!Number.isInteger(snapshot.toolCallCount) || snapshot.toolCallCount < 0) {
      throw new StateStoreError("invalid-snapshot", "toolCallCount must be a non-negative integer");
    }
  }

  private transaction<T>(fn: () => T): T {
    this.requireOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* keep the original error */
      }
      throw error;
    }
  }
}

function realPathForNewFile(input: string): string {
  if (!isAbsolute(input)) {
    throw new StateStoreError("io", "state store path must be absolute or ':memory:'");
  }
  if (existsSync(input)) return realpathSync(input);
  const parent = dirname(input);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentReal = realpathSync(parent);
  return `${parentReal}/${input.split("/").pop() ?? "state.db"}`;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new StateStoreError("corrupt-row", `${label} is not valid JSON`, { cause: error });
  }
}

/** Stable short hash helper for diagnostics (not used for security). */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Guard for callers that want to assert a path is a regular state file. */
export function assertStateFilePath(path: string): void {
  if (path === ":memory:") return;
  if (!isAbsolute(path)) throw new StateStoreError("io", "state store path must be absolute");
  if (existsSync(path) && !statSync(path).isFile()) {
    throw new StateStoreError("io", "state store path exists but is not a file");
  }
}
