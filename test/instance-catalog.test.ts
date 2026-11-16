import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceCatalog, InstanceCatalogError } from "../src/instances/catalog.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "instance-catalog-")));
  roots.push(base);
  return base;
}

function writeConnection(
  base: string,
  instanceId: string,
  pid: number,
  overrides: Record<string, unknown> = {},
): { dir: string; file: string; payload: Record<string, unknown> } {
  const dir = join(base, "instances", instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: Record<string, unknown> = {
    instance: instanceId,
    pid,
    createdAt: "2025-01-01T00:00:00.000Z",
    runtime: dir,
    stateDb: join(dir, "state.db"),
    ...overrides,
  };
  const file = join(dir, `connection-${pid}.json`);
  writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return { dir, file, payload };
}

function writeRawConnection(base: string, instanceId: string, fileName: string, content: string): string {
  const dir = join(base, "instances", instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, fileName);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function makeCwd(base: string, name = "work"): string {
  const cwd = join(base, name);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

function noteFiles(base: string): string[] {
  const dir = join(base, "handoffs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
}

function handoffInput(cwd: string, instanceId: string, suffix = "1") {
  return {
    cwd,
    instanceId,
    jobId: `job-${suffix}`,
    goal: `goal ${suffix}`,
    completed: `completed ${suffix}`,
    next: `next ${suffix}`,
  };
}

describe("InstanceCatalog discovery", () => {
  it("lists valid instance directories and preserves inactive records", () => {
    const base = makeBase();
    const alpha = writeConnection(base, "alpha", 999999, {
      createdAt: "2024-01-01T00:00:00.000Z",
      stateDb: join(base, "instances", "alpha", "state", "claude-durateam.db"),
      cwd: "/ignored/extra/launcher/field",
      reuseRequested: true,
    });
    const beta = writeConnection(base, "beta.instance", 424242, { createdAt: "2024-02-01T00:00:00.000Z" });

    const catalog = new InstanceCatalog(base);
    expect(catalog.list()).toEqual([
      {
        instanceId: "alpha",
        runtimeDir: alpha.dir,
        stateDb: join(alpha.dir, "state", "claude-durateam.db"),
        createdAt: "2024-01-01T00:00:00.000Z",
        pid: 999999,
      },
      {
        instanceId: "beta.instance",
        runtimeDir: beta.dir,
        stateDb: join(beta.dir, "state.db"),
        createdAt: "2024-02-01T00:00:00.000Z",
        pid: 424242,
      },
    ]);
    expect(catalog.get("alpha")).toEqual(catalog.list()[0]);
    expect(catalog.get("missing")).toBeNull();
  });

  it("accepts an explicit null pid for an inactive record", () => {
    const base = makeBase();
    const inactive = writeConnection(base, "inactive", 777777, { pid: null });
    const catalog = new InstanceCatalog(base);
    expect(catalog.get("inactive")).toEqual({
      instanceId: "inactive",
      runtimeDir: inactive.dir,
      stateDb: join(inactive.dir, "state.db"),
      createdAt: "2025-01-01T00:00:00.000Z",
      pid: null,
    });
  });

  it("chooses the newest valid connection record and skips newer bad records", () => {
    const base = makeBase();
    writeConnection(base, "multi", 101, { createdAt: "2025-01-01T00:00:00.000Z" });
    const newest = writeConnection(base, "multi", 202, { createdAt: "2025-03-01T00:00:00.000Z" });
    writeRawConnection(base, "multi", "connection-303.json", "{not valid json\n");
    writeConnection(base, "multi", 404, {
      createdAt: "2025-05-01T00:00:00.000Z",
      runtime: join(base, "instances", "somewhere-else"),
    });
    writeConnection(base, "multi", 505, { createdAt: "not-a-date" });

    const catalog = new InstanceCatalog(base);
    expect(catalog.get("multi")).toEqual({
      instanceId: "multi",
      runtimeDir: newest.dir,
      stateDb: join(newest.dir, "state.db"),
      createdAt: "2025-03-01T00:00:00.000Z",
      pid: 202,
    });
  });

  it("skips corrupt, foreign and unsafe records without mutating them", () => {
    const base = makeBase();
    const good = writeConnection(base, "good", 123, { createdAt: "2025-01-01T00:00:00.000Z" });

    const foreign = writeConnection(base, "foreign", 234, { instance: "not-this-directory" });
    const mismatchedPid = writeConnection(base, "mismatched-pid", 345, { pid: 999 });
    const outsideRuntime = writeConnection(base, "outside-runtime", 456, {
      runtime: join(base, "outside-runtime"),
    });
    writeConnection(base, "outside-state", 567, { stateDb: join(base, "outside-state.db") });
    writeConnection(base, "traversal-state", 678, { stateDb: join(base, "outside", "state.db") });
    writeConnection(base, "bad-created", 789, { createdAt: "yesterday-ish" });
    writeRawConnection(base, "bad-json", "connection-890.json", "[]\n");
    mkdirSync(join(base, "instances", "empty"));
    writeFileSync(join(base, "instances", "not-a-directory"), "not a directory\n");
    mkdirSync(join(base, "instances", "bad name"));

    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "connection-321.json"),
      JSON.stringify({
        instance: "linked-instance",
        pid: 321,
        createdAt: "2025-02-01T00:00:00.000Z",
        runtime: join(outside),
        stateDb: join(outside, "state.db"),
      }),
    );
    symlinkSync(outside, join(base, "instances", "linked-instance"), "dir");

    const outsideNote = join(outside, "connection-654.json");
    writeFileSync(
      outsideNote,
      JSON.stringify({
        instance: "good",
        pid: 654,
        createdAt: "2025-06-01T00:00:00.000Z",
        runtime: good.dir,
        stateDb: join(good.dir, "state.db"),
      }),
    );
    symlinkSync(outsideNote, join(good.dir, "connection-654.json"));

    const stateOutside = join(outside, "state.db");
    writeFileSync(stateOutside, "outside state\n");
    const symlinkDb = writeConnection(base, "symlink-state", 765);
    symlinkSync(stateOutside, join(symlinkDb.dir, "state.db"));

    const before = readFileSync(foreign.file, "utf8");
    const catalog = new InstanceCatalog(base);
    const list = catalog.list();
    expect(list.map((record) => record.instanceId)).toEqual(["good"]);
    expect(list[0]!.pid).toBe(123);
    expect(catalog.get("foreign")).toBeNull();
    expect(catalog.get("mismatched-pid")).toBeNull();
    expect(catalog.get("outside-runtime")).toBeNull();
    expect(catalog.get("outside-state")).toBeNull();
    expect(catalog.get("traversal-state")).toBeNull();
    expect(catalog.get("bad-created")).toBeNull();
    expect(catalog.get("bad-json")).toBeNull();
    expect(catalog.get("empty")).toBeNull();
    expect(catalog.get("linked-instance")).toBeNull();
    expect(catalog.get("symlink-state")).toBeNull();
    expect(readFileSync(foreign.file, "utf8")).toBe(before);
  });

  it("validates get IDs and never treats malformed data as a record", () => {
    const base = makeBase();
    const catalog = new InstanceCatalog(base);
    expect(catalog.list()).toEqual([]);
    expect(catalog.get("unknown")).toBeNull();
    expect(() => catalog.get("../escape")).toThrow(InstanceCatalogError);
    expect(() => catalog.get("bad/name")).toThrow(InstanceCatalogError);
    expect(() => catalog.get("")).toThrow(InstanceCatalogError);

    writeConnection(base, "a".repeat(96), 1);
    expect(catalog.get("a".repeat(96))?.instanceId).toBe("a".repeat(96));
    expect(() => catalog.get("a".repeat(97))).toThrow(InstanceCatalogError);
    expect(catalog.list().map((record) => record.instanceId)).toEqual(["a".repeat(96)]);
  });
});

describe("InstanceCatalog handoff notes", () => {
  it("saves and atomically replaces handoff notes with private modes", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwd = makeCwd(base);
    const catalog = new InstanceCatalog(base);

    const first = catalog.saveHandoff(handoffInput(cwd, "inst-a", "1"));
    expect(first).toMatchObject({
      cwd: realpathSync(cwd),
      instanceId: "inst-a",
      jobId: "job-1",
      goal: "goal 1",
      completed: "completed 1",
      next: "next 1",
      name: "default",
    });
    expect(Number.isFinite(Date.parse(first.savedAt))).toBe(true);
    expect(catalog.readHandoff({ cwd })).toEqual(first);

    const second = catalog.saveHandoff(handoffInput(cwd, "inst-a", "2"));
    expect(catalog.readHandoff({ cwd })?.jobId).toBe("job-2");

    const handoffs = join(base, "handoffs");
    expect(statSync(handoffs).mode & 0o777).toBe(0o700);
    const files = noteFiles(base);
    expect(files).toHaveLength(1);
    const notePath = join(handoffs, files[0]!);
    expect(statSync(notePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(notePath, "utf8"))).toMatchObject({
      jobId: "job-2",
      name: "default",
    });
    expect(readdirSync(handoffs).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect(second.savedAt >= first.savedAt).toBe(true);
  });

  it("isolates notes by canonical cwd and explicit name", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwdA = makeCwd(base, "a");
    const cwdB = makeCwd(base, "b");
    const alias = join(base, "a-alias");
    symlinkSync(cwdA, alias, "dir");
    const catalog = new InstanceCatalog(base);

    catalog.saveHandoff({ ...handoffInput(alias, "inst-a", "alias"), name: "default" });
    catalog.saveHandoff({ ...handoffInput(cwdA, "inst-a", "review"), name: "review" });
    catalog.saveHandoff({ ...handoffInput(cwdB, "inst-a", "b"), name: "default" });
    catalog.saveHandoff({ ...handoffInput(cwdA, "inst-a", "third"), name: "third" });

    expect(catalog.readHandoff({ cwd: cwdA })?.jobId).toBe("job-alias");
    expect(catalog.readHandoff({ cwd: alias })?.jobId).toBe("job-alias");
    expect(catalog.readHandoff({ cwd: cwdA, name: "review" })?.jobId).toBe("job-review");
    expect(catalog.readHandoff({ cwd: alias, name: "review" })?.jobId).toBe("job-review");
    expect(catalog.readHandoff({ cwd: cwdB })?.jobId).toBe("job-b");
    expect(catalog.readHandoff({ cwd: cwdA, name: "not-saved" })).toBeNull();
    expect(noteFiles(base)).toHaveLength(4);

    const replacement = catalog.saveHandoff({ ...handoffInput(cwdA, "inst-a", "replacement"), name: "review" });
    expect(replacement.cwd).toBe(realpathSync(cwdA));
    expect(catalog.readHandoff({ cwd: cwdA, name: "review" })?.jobId).toBe("job-replacement");
    expect(noteFiles(base)).toHaveLength(4);
  });

  it("returns null for missing and corrupt notes and re-validates every field", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwd = makeCwd(base);
    const catalog = new InstanceCatalog(base);

    expect(catalog.readHandoff({ cwd })).toBeNull();
    const saved = catalog.saveHandoff(handoffInput(cwd, "inst-a", "1"));
    const files = noteFiles(base);
    expect(files).toHaveLength(1);
    const notePath = join(base, "handoffs", files[0]!);

    writeFileSync(notePath, "{broken json\n", { mode: 0o600 });
    expect(catalog.readHandoff({ cwd })).toBeNull();

    for (const corrupt of [
      { ...saved, cwd: join(base, "other-cwd") },
      { ...saved, name: "other-name" },
      { ...saved, instanceId: "../escape" },
      { ...saved, jobId: "" },
      { ...saved, jobId: "j".repeat(121) },
      { ...saved, goal: "g".repeat(4001) },
      { ...saved, completed: 7 },
      { ...saved, next: "n".repeat(4001) },
      { ...saved, savedAt: "not-a-date" },
    ]) {
      writeFileSync(notePath, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
      expect(catalog.readHandoff({ cwd })).toBeNull();
    }

    // Unknown note fields are ignored, never used as a file path.
    writeFileSync(notePath, `${JSON.stringify({ ...saved, extraPath: "../../outside.json" })}\n`, {
      mode: 0o600,
    });
    expect(catalog.readHandoff({ cwd })?.jobId).toBe(saved.jobId);

    // A valid rewrite after corruption is readable again.
    const repaired = catalog.saveHandoff(handoffInput(cwd, "inst-a", "repaired"));
    expect(catalog.readHandoff({ cwd })?.jobId).toBe(repaired.jobId);

    const outsideNote = join(base, "outside-note.json");
    writeFileSync(outsideNote, `${JSON.stringify({ ...repaired, name: "default" })}\n`, { mode: 0o600 });
    const current = noteFiles(base)[0]!;
    rmSync(join(base, "handoffs", current));
    symlinkSync(outsideNote, join(base, "handoffs", current));
    expect(catalog.readHandoff({ cwd })).toBeNull();

    rmSync(join(base, "handoffs", current), { force: true });
    expect(catalog.readHandoff({ cwd })).toBeNull();
  });

  it("rejects relative, missing, non-directory cwds and unsafe names", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwd = makeCwd(base);
    const fileCwd = join(base, "plain-file");
    writeFileSync(fileCwd, "not a directory\n");
    const missingCwd = join(base, "missing-cwd");
    const catalog = new InstanceCatalog(base);

    expect(() => catalog.saveHandoff({ ...handoffInput("relative-cwd", "inst-a"), cwd: "relative-cwd" })).toThrow(
      /absolute/,
    );
    expect(() => catalog.saveHandoff({ ...handoffInput(missingCwd, "inst-a") })).toThrow(/existing directory/);
    expect(() => catalog.saveHandoff({ ...handoffInput(fileCwd, "inst-a") })).toThrow(/existing directory/);
    expect(() => catalog.readHandoff({ cwd: "relative-cwd" })).toThrow(/absolute/);
    expect(() => catalog.readHandoff({ cwd: missingCwd })).toThrow(/existing directory/);
    expect(() => catalog.readHandoff({ cwd: fileCwd })).toThrow(/existing directory/);

    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), name: "../escape" })).toThrow(
      InstanceCatalogError,
    );
    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), name: "bad name" })).toThrow(
      InstanceCatalogError,
    );
    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), name: "n".repeat(97) })).toThrow(
      InstanceCatalogError,
    );
    expect(() => catalog.readHandoff({ cwd, name: "../escape" })).toThrow(InstanceCatalogError);

    const name96 = "n".repeat(96);
    catalog.saveHandoff({ ...handoffInput(cwd, "inst-a", "name96"), name: name96 });
    expect(catalog.readHandoff({ cwd, name: name96 })?.name).toBe(name96);

    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), jobId: "" })).toThrow(/jobId/);
    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), jobId: "j".repeat(121) })).toThrow(/jobId/);
    expect(() => catalog.saveHandoff({ ...handoffInput(cwd, "inst-a"), goal: "g".repeat(4001) })).toThrow(/goal/);
  });

  it("validates the referenced instance without creating handoff state on failure", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwd = makeCwd(base);
    const catalog = new InstanceCatalog(base);

    expect(() => catalog.saveHandoff(handoffInput(cwd, "missing-instance"))).toThrow(/unknown instance/);
    expect(() => catalog.saveHandoff(handoffInput(cwd, "../escape"))).toThrow(InstanceCatalogError);
    expect(() => catalog.saveHandoff(handoffInput(cwd, "a".repeat(97)))).toThrow(InstanceCatalogError);
    expect(existsSync(join(base, "handoffs"))).toBe(false);

    writeConnection(base, "bad-state", 222, { stateDb: join(base, "outside.db") });
    expect(() => catalog.saveHandoff(handoffInput(cwd, "bad-state"))).toThrow(/unknown instance/);
    expect(existsSync(join(base, "handoffs"))).toBe(false);
  });

  it("refuses to follow a symlinked handoffs directory", () => {
    const base = makeBase();
    writeConnection(base, "inst-a", 111);
    const cwd = makeCwd(base);
    const outside = join(base, "outside-handoffs");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(base, "handoffs"), "dir");
    const catalog = new InstanceCatalog(base);

    expect(lstatSync(join(base, "handoffs")).isSymbolicLink()).toBe(true);
    expect(() => catalog.saveHandoff(handoffInput(cwd, "inst-a"))).toThrow(/handoffs path/);
    expect(catalog.readHandoff({ cwd })).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
  });
});
