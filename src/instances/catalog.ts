/**
 * Filesystem catalog for launcher-created instances and per-instance handoff
 * notes.
 *
 * Instances are discovered by scanning `<baseDir>/instances/<instanceId>/`
 * for `connection-<pid>.json` records. There is deliberately no central
 * mutable index: a stale directory with a valid connection record remains a
 * catalog entry, while malformed metadata is ignored. This module never
 * probes processes, reads state databases or takes over scheduling ownership.
 *
 * Notes live in `<baseDir>/handoffs/<sha256(cwd + name)>.json`. The caller's
 * cwd is canonicalized with realpath before hashing, so aliases of the same
 * directory share notes and different names remain isolated. Writes use a
 * unique private temp file followed by an atomic rename.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface InstanceRecord {
  instanceId: string;
  runtimeDir: string;
  stateDb: string;
  createdAt: string;
  pid: number | null;
}

export interface HandoffNote {
  cwd: string;
  instanceId: string;
  jobId: string;
  goal: string;
  completed: string;
  next: string;
  name: string;
  savedAt: string;
}

export class InstanceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceCatalogError";
  }
}

/** IDs/names are single path components with a conservative character set. */
const SIMPLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const CONNECTION_FILE_RE = /^connection-([0-9]+)\.json$/;
const DEFAULT_HANDOFF_NAME = "default";
const MAX_JOB_ID_LENGTH = 120;
const MAX_HANDOFF_TEXT_LENGTH = 4000;
const MAX_METADATA_BYTES = 1024 * 1024;

type DirectoryState = "missing" | "directory" | "unsafe";
type JsonObject = Record<string, unknown>;

interface ConnectionCandidate {
  record: InstanceRecord;
  createdAtMs: number;
  mtimeMs: number;
}

function fail(message: string): never {
  throw new InstanceCatalogError(message);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSimpleId(value: unknown): value is string {
  return typeof value === "string" && SIMPLE_ID_RE.test(value);
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidJobId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_JOB_ID_LENGTH &&
    !value.includes("\u0000")
  );
}

function isValidHandoffText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_HANDOFF_TEXT_LENGTH &&
    !value.includes("\u0000")
  );
}

function isWithin(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isStrictlyWithin(child: string, root: string): boolean {
  return isWithin(child, root) && relative(root, child) !== "";
}

function directoryState(path: string): DirectoryState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return isNotFound(error) ? "missing" : "unsafe";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
  return "directory";
}

/**
 * Resolve a path through every existing ancestor. Missing trailing components
 * are appended to the canonical ancestor. A dangling symlink or an existing
 * component that cannot be resolved returns null instead of escaping.
 */
function canonicalProspective(path: string): string | null {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cursor);
      return missing.length > 0 ? resolve(real, ...missing) : real;
    } catch (error) {
      if (!isNotFound(error)) return null;
      let entry;
      try {
        entry = lstatSync(cursor);
      } catch (lstatError) {
        if (!isNotFound(lstatError)) return null;
      }
      if (entry) return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function canonicalExistingDirectory(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\u0000")) {
    fail(`${label} must be a non-empty absolute directory path`);
  }
  if (!isAbsolute(raw)) fail(`${label} must be an absolute path`);
  let stat;
  try {
    stat = statSync(raw);
  } catch {
    fail(`${label} must be an existing directory`);
  }
  if (!stat.isDirectory()) fail(`${label} must be an existing directory`);
  try {
    return realpathSync(raw);
  } catch {
    fail(`${label} must be an existing directory`);
  }
}

function normalizeHandoffName(name: unknown): string {
  if (name === undefined) return DEFAULT_HANDOFF_NAME;
  if (!isValidSimpleId(name)) {
    fail("handoff name must match [A-Za-z0-9][A-Za-z0-9._-]{0,95}");
  }
  return name;
}

function noteFileName(cwd: string, name: string): string {
  const digest = createHash("sha256").update(`${cwd}\u0000${name}`, "utf8").digest("hex");
  return `${digest}.json`;
}

function parseConnectionFile(
  file: string,
  instanceId: string,
  runtimeDir: string,
  runtimeReal: string,
  filePid: number,
): ConnectionCandidate | null {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  if (typeof parsed["instance"] !== "string" || parsed["instance"] !== instanceId) return null;
  if (parsed["pid"] === null) {
    // The interface permits an explicit null pid for records whose process is
    // already gone; the launcher's filename still carries the original pid.
  } else if (
    typeof parsed["pid"] !== "number" ||
    !Number.isSafeInteger(parsed["pid"]) ||
    parsed["pid"] <= 0 ||
    parsed["pid"] !== filePid
  ) {
    return null;
  }
  if (!isValidDateString(parsed["createdAt"])) return null;
  if (typeof parsed["runtime"] !== "string" || !isAbsolute(parsed["runtime"])) return null;

  const runtime = resolve(parsed["runtime"]);
  if (runtime !== runtimeDir) {
    const runtimeCanonical = canonicalProspective(runtime);
    if (runtimeCanonical === null || runtimeCanonical !== runtimeReal) return null;
  }

  if (typeof parsed["stateDb"] !== "string" || !isAbsolute(parsed["stateDb"])) return null;
  const stateDb = resolve(parsed["stateDb"]);
  if (!isStrictlyWithin(stateDb, runtimeDir)) return null;
  const stateDbCanonical = canonicalProspective(stateDb);
  if (stateDbCanonical === null || !isStrictlyWithin(stateDbCanonical, runtimeReal)) return null;

  return {
    record: {
      instanceId,
      runtimeDir,
      stateDb,
      createdAt: parsed["createdAt"],
      pid: parsed["pid"],
    },
    createdAtMs: Date.parse(parsed["createdAt"]),
    mtimeMs: stat.mtimeMs,
  };
}

function parseHandoff(raw: unknown, expectedCwd: string, expectedName: string): HandoffNote | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw["cwd"] !== "string" || raw["cwd"] !== expectedCwd) return null;
  if (!isValidSimpleId(raw["instanceId"])) return null;
  if (!isValidJobId(raw["jobId"])) return null;
  if (!isValidHandoffText(raw["goal"])) return null;
  if (!isValidHandoffText(raw["completed"])) return null;
  if (!isValidHandoffText(raw["next"])) return null;
  if (typeof raw["name"] !== "string" || raw["name"] !== expectedName) return null;
  if (!isValidDateString(raw["savedAt"])) return null;

  return {
    cwd: raw["cwd"],
    instanceId: raw["instanceId"],
    jobId: raw["jobId"],
    goal: raw["goal"],
    completed: raw["completed"],
    next: raw["next"],
    name: raw["name"],
    savedAt: raw["savedAt"],
  };
}

export class InstanceCatalog {
  readonly baseDir: string;
  private readonly instancesDir: string;
  private readonly handoffsDir: string;

  constructor(baseDir: string) {
    if (typeof baseDir !== "string" || baseDir.length === 0 || baseDir.includes("\u0000")) {
      fail("baseDir must be a non-empty path");
    }
    this.baseDir = resolve(baseDir);
    this.instancesDir = join(this.baseDir, "instances");
    this.handoffsDir = join(this.baseDir, "handoffs");
  }

  /** All valid instance records, including records whose processes are gone. */
  list(): InstanceRecord[] {
    const rootReal = this.readableInstancesRoot();
    if (rootReal === null) return [];

    let entries;
    try {
      entries = readdirSync(this.instancesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const records: InstanceRecord[] = [];
    for (const entry of entries) {
      if (!isValidSimpleId(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const record = this.readInstanceDirectory(join(this.instancesDir, entry.name), entry.name, rootReal);
      if (record !== null) records.push(record);
    }
    records.sort((left, right) =>
      left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
    );
    return records;
  }

  /** Look up one instance directory directly; never throws for malformed data. */
  get(instanceId: string): InstanceRecord | null {
    if (!isValidSimpleId(instanceId)) {
      fail("instanceId must match [A-Za-z0-9][A-Za-z0-9._-]{0,95}");
    }
    const rootReal = this.readableInstancesRoot();
    if (rootReal === null) return null;
    return this.readInstanceDirectory(join(this.instancesDir, instanceId), instanceId, rootReal);
  }

  /**
   * Persist a handoff note for a canonical cwd and name. The referenced
   * instance must already be discoverable through this catalog.
   */
  saveHandoff(input: {
    cwd: string;
    instanceId: string;
    jobId: string;
    goal: string;
    completed: string;
    next: string;
    name?: string;
  }): HandoffNote {
    if (!isPlainObject(input)) fail("handoff input must be an object");
    const instanceId = input["instanceId"];
    if (!isValidSimpleId(instanceId)) {
      fail("instanceId must match [A-Za-z0-9][A-Za-z0-9._-]{0,95}");
    }
    if (this.get(instanceId) === null) fail(`unknown instance '${instanceId}'`);

    const cwd = canonicalExistingDirectory(input["cwd"], "cwd");
    const name = normalizeHandoffName(input["name"]);
    const jobId = input["jobId"];
    if (!isValidJobId(jobId)) {
      fail(`jobId must be non-empty and at most ${MAX_JOB_ID_LENGTH} characters`);
    }
    for (const [field, value] of [
      ["goal", input["goal"]],
      ["completed", input["completed"]],
      ["next", input["next"]],
    ] as const) {
      if (!isValidHandoffText(value)) {
        fail(`${field} must be a string of at most ${MAX_HANDOFF_TEXT_LENGTH} characters`);
      }
    }

    const note: HandoffNote = {
      cwd,
      instanceId,
      jobId,
      goal: input["goal"] as string,
      completed: input["completed"] as string,
      next: input["next"] as string,
      name,
      savedAt: new Date().toISOString(),
    };

    const handoffsDir = this.ensureHandoffsDirectory();
    const target = join(handoffsDir, noteFileName(cwd, name));
    const temp = join(handoffsDir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(note)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, target);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Best-effort cleanup; never mask the original write error.
      }
      throw error;
    }
    return note;
  }

  /** Read a handoff note; missing or malformed notes are simply absent. */
  readHandoff(input: { cwd: string; name?: string }): HandoffNote | null {
    if (!isPlainObject(input)) fail("handoff input must be an object");
    const cwd = canonicalExistingDirectory(input["cwd"], "cwd");
    const name = normalizeHandoffName(input["name"]);

    if (directoryState(this.handoffsDir) !== "directory") return null;
    const target = join(this.handoffsDir, noteFileName(cwd, name));

    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_METADATA_BYTES) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    } catch {
      return null;
    }
    return parseHandoff(parsed, cwd, name);
  }

  private readableInstancesRoot(): string | null {
    if (directoryState(this.instancesDir) !== "directory") return null;
    try {
      return realpathSync(this.instancesDir);
    } catch {
      return null;
    }
  }

  private readInstanceDirectory(dir: string, instanceId: string, rootReal: string): InstanceRecord | null {
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      return null;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;

    let dirReal: string;
    try {
      dirReal = realpathSync(dir);
    } catch {
      return null;
    }
    if (!isStrictlyWithin(dirReal, rootReal)) return null;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    let newest: ConnectionCandidate | null = null;
    for (const entry of entries) {
      const match = CONNECTION_FILE_RE.exec(entry.name);
      if (match === null || entry.isSymbolicLink() || !entry.isFile()) continue;
      const filePid = Number(match[1]);
      if (!Number.isSafeInteger(filePid) || filePid <= 0) continue;

      const candidate = parseConnectionFile(join(dir, entry.name), instanceId, dir, dirReal, filePid);
      if (candidate === null) continue;
      if (
        newest === null ||
        candidate.createdAtMs > newest.createdAtMs ||
        (candidate.createdAtMs === newest.createdAtMs && candidate.mtimeMs > newest.mtimeMs) ||
        (candidate.createdAtMs === newest.createdAtMs &&
          candidate.mtimeMs === newest.mtimeMs &&
          (candidate.record.pid ?? 0) > (newest.record.pid ?? 0))
      ) {
        newest = candidate;
      }
    }
    return newest === null ? null : newest.record;
  }

  private ensureHandoffsDirectory(): string {
    const state = directoryState(this.handoffsDir);
    if (state === "unsafe") fail("handoffs path must be a private directory, not a symlink or file");
    if (state === "missing") {
      try {
        mkdirSync(this.handoffsDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        fail(`cannot create handoffs directory: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (directoryState(this.handoffsDir) !== "directory") {
      fail("handoffs path must be a private directory, not a symlink or file");
    }
    try {
      chmodSync(this.handoffsDir, 0o700);
    } catch (error) {
      fail(`cannot secure handoffs directory: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return this.handoffsDir;
  }
}
