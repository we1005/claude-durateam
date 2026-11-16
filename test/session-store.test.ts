import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureSessionTranscript,
  escapeProjectDir,
  findSessionTranscript,
  SessionTranscriptError,
} from "../src/engines/session-store.js";

function tempRoot(tag: string): string {
  return join(process.cwd(), ".runtime", "test-tmp", `store-${tag}-${randomUUID()}`);
}

describe("bridge-owned transcript store", () => {
  it("escapes cwd to the Claude Code project key", () => {
    expect(escapeProjectDir("/Volumes/a/repo/.runtime/p1/project")).toBe(
      "-Volumes-a-repo--runtime-p1-project",
    );
  });

  it("maps non-ASCII cwd deterministically (SDK layout not officially verified)", () => {
    // The copy relies on the locked SDK layout; non-ASCII mapping is a
    // documented unverified assumption, not a claimed official API.
    expect(escapeProjectDir("/tmp/中文 目录")).toBe(escapeProjectDir("/tmp/中文 目录"));
    expect(escapeProjectDir("/tmp/中文 目录")).not.toBe(escapeProjectDir("/tmp/ascii-dir"));
  });

  it("copies a parent transcript into the target cwd without touching the parent", () => {
    const root = tempRoot("copy");
    const sessionId = randomUUID();
    const parentCwd = "/parent/worktree";
    const childCwd = "/child/worktree";
    mkdirSync(join(root, "projects", escapeProjectDir(parentCwd)), { recursive: true });
    const parentFile = join(root, "projects", escapeProjectDir(parentCwd), `${sessionId}.jsonl`);
    writeFileSync(parentFile, "transcript-bytes\n", { mode: 0o600 });
    const parentHash = createHash("sha256").update(readFileSync(parentFile)).digest("hex");

    const result = ensureSessionTranscript(root, sessionId, childCwd);
    expect(result.copied).toBe(true);
    const targetFile = join(root, "projects", escapeProjectDir(childCwd), `${sessionId}.jsonl`);
    expect(readFileSync(targetFile, "utf8")).toBe("transcript-bytes\n");
    expect(createHash("sha256").update(readFileSync(parentFile)).digest("hex")).toBe(parentHash);

    // Second call is a no-op (already available), and lookup finds the family copy.
    const second = ensureSessionTranscript(root, sessionId, childCwd);
    expect(second.copied).toBe(false);
    expect(findSessionTranscript(root, sessionId)).toBeTruthy();
    expect(findSessionTranscript(root, randomUUID())).toBeNull();
  });

  it("throws session_not_found when the parent transcript is unknown", () => {
    const root = tempRoot("missing");
    mkdirSync(root, { recursive: true });
    expect(() => ensureSessionTranscript(root, randomUUID(), "/x")).toThrow(SessionTranscriptError);
    try {
      ensureSessionTranscript(root, randomUUID(), "/x");
    } catch (error) {
      expect((error as Error).message).toMatch(/session_not_found:/);
    }
  });
});
