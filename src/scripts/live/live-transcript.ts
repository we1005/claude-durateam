/**
 * Read a completed session transcript from the bridge-owned config root.
 * Used by live probes as local, deterministic evidence of tool outputs
 * (no content is printed; callers only assert sentinel markers).
 */

import { readFileSync } from "node:fs";
import { findSessionTranscript } from "../../engines/session-store.js";

export interface ToolRecord {
  name: string;
  text: string;
  isError: boolean;
}

export interface SessionRecords {
  transcriptPath: string | null;
  toolResults: ToolRecord[];
  userTexts: string[];
  assistantTexts: string[];
}

type Rec = Record<string, unknown>;

function blocks(value: unknown): Rec[] {
  return Array.isArray(value) ? (value as Rec[]).filter((item) => item && typeof item === "object") : [];
}

export function readSessionRecords(configRoot: string, sessionId: string): SessionRecords {
  const transcriptPath = findSessionTranscript(configRoot, sessionId);
  const out: SessionRecords = { transcriptPath, toolResults: [], userTexts: [], assistantTexts: [] };
  if (!transcriptPath) return out;
  const toolNames = new Map<string, string>();
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Rec;
    try {
      entry = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    // Steer messages are persisted as queue-operation records, not user frames.
    if (entry["type"] === "queue-operation" && typeof entry["content"] === "string") {
      out.userTexts.push(entry["content"]);
      continue;
    }
    const message = entry["message"] as Rec | undefined;
    if (!message) continue;
    const content = blocks(message["content"]);
    if (entry["type"] === "assistant") {
      for (const block of content) {
        if (block["type"] === "tool_use" && typeof block["id"] === "string") {
          toolNames.set(block["id"], typeof block["name"] === "string" ? block["name"] : "unknown");
        } else if (block["type"] === "text" && typeof block["text"] === "string") {
          out.assistantTexts.push(block["text"]);
        }
      }
    } else if (entry["type"] === "user") {
      if (typeof message["content"] === "string") out.userTexts.push(message["content"]);
      for (const block of content) {
        if (block["type"] === "tool_result") {
          const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
          const raw = block["content"];
          const text = typeof raw === "string"
            ? raw
            : blocks(raw).map((part) => (typeof part["text"] === "string" ? part["text"] : "")).join("");
          out.toolResults.push({ name: toolNames.get(id) ?? "unknown", text, isError: block["is_error"] === true });
        } else if (block["type"] === "text" && typeof block["text"] === "string") {
          out.userTexts.push(block["text"]);
        }
      }
    }
  }
  return out;
}
