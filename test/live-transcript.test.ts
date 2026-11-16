import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { escapeProjectDir } from "../src/engines/session-store.js";
import { readSessionRecords } from "../src/scripts/live/live-transcript.js";

describe("live transcript reader", () => {
  it("collects queue-operation steer messages and tool results", () => {
    const root = join(process.cwd(), ".runtime", "test-tmp", `lt-${randomUUID()}`);
    const sessionId = randomUUID();
    const cwd = "/tmp/live-transcript-cwd";
    const dir = join(root, "projects", escapeProjectDir(cwd));
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "queue-operation", operation: "enqueue", content: "Verification override: STEER-abc" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "node -e 1" } }] },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: "NODE_OK" }] },
      },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
      mode: 0o600,
    });
    const records = readSessionRecords(root, sessionId);
    expect(records.transcriptPath).toBeTruthy();
    expect(records.userTexts.join("")).toContain("STEER-abc");
    expect(records.toolResults[0]?.name).toBe("Bash");
    expect(records.toolResults[0]?.text).toContain("NODE_OK");
  });
});
