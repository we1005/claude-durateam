/**
 * Compact, structural summaries of Claude Agent SDK messages.
 *
 * We deliberately do not print raw SDK frames: they contain full prompts,
 * file contents and environment echo. The probe keeps only the fields needed
 * to prove the tool chain (tool names, target path, previews, usage numbers).
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { preview, redactSecrets } from "../observability/redact.js";

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface ToolUseObserved {
  readonly id: string;
  readonly name: string;
  readonly filePath?: string;
  readonly inputPreview: string;
}

export interface ToolResultObserved {
  readonly toolUseId: string;
  readonly isError: boolean;
  readonly textPreview: string;
  readonly textLength: number;
}

export interface InitObserved {
  readonly model: string;
  readonly sessionId: string;
  readonly claudeCodeVersion?: string;
  readonly permissionMode?: string;
  readonly apiKeySource?: string;
  readonly tools: string[];
  readonly mcpServers: string[];
  readonly skills?: string[];
  readonly cwd?: string;
}

export interface ResultObserved {
  readonly subtype: string;
  readonly isError: boolean;
  readonly numTurns?: number;
  readonly durationMs?: number;
  readonly resultText: string;
  readonly sessionId?: string;
  readonly totalCostUsd?: number;
  readonly usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  readonly modelUsageKeys: string[];
  readonly errors: string[];
}

export interface ProbeObservation {
  init?: InitObserved;
  toolUses: ToolUseObserved[];
  toolResults: ToolResultObserved[];
  assistantTexts: string[];
  assistantErrors: string[];
  result?: ResultObserved;
  messageTypes: Record<string, number>;
}

/**
 * Convert one SDK message into zero or more compact trace entries and update
 * the accumulated observation. `secrets` are redacted from every preview.
 */
export function absorbMessage(observation: ProbeObservation, message: SDKMessage, secrets: readonly string[]): Rec {
  const type = asString((message as Rec)["type"]) ?? "unknown";
  const subtype = asString((message as Rec)["subtype"]);
  observation.messageTypes[type] = (observation.messageTypes[type] ?? 0) + 1;

  if (type === "system" && subtype === "init") {
    const rec = message as Rec;
    const init: InitObserved = {
      model: asString(rec["model"]) ?? "unknown",
      sessionId: asString(rec["session_id"]) ?? "",
      claudeCodeVersion: asString(rec["claude_code_version"]),
      permissionMode: asString(rec["permissionMode"]),
      apiKeySource: asString(rec["apiKeySource"]),
      tools: asArray(rec["tools"]).map((t) => String(t)),
      mcpServers: asArray(rec["mcp_servers"]).map((s) => {
        const srv = asRec(s);
        return srv ? `${String(srv["name"])}:${String(srv["status"])}` : "unknown";
      }),
      skills: asArray(rec["skills"]).map((s) => String(s)),
      cwd: asString(rec["cwd"]),
    };
    observation.init = init;
    return {
      kind: "init",
      model: init.model,
      sessionId: init.sessionId,
      permissionMode: init.permissionMode,
      apiKeySource: init.apiKeySource,
      claudeCodeVersion: init.claudeCodeVersion,
      tools: init.tools,
      mcpServers: init.mcpServers,
      skillsCount: init.skills?.length ?? 0,
    };
  }

  if (type === "assistant") {
    const messageObj = asRec((message as Rec)["message"]);
    const model = asString(messageObj?.["model"]);
    const blocks = asArray(messageObj?.["content"]);
    const assistantError = asString((message as Rec)["error"]);
    if (assistantError) observation.assistantErrors.push(assistantError);
    const summary: Rec = {
      kind: "assistant",
      model,
      parentToolUseId: (message as Rec)["parent_tool_use_id"] ?? null,
      error: assistantError,
    };
    for (const rawBlock of blocks) {
      const block = asRec(rawBlock);
      if (!block) continue;
      const blockType = asString(block["type"]);
      if (blockType === "text") {
        const text = asString(block["text"]) ?? "";
        const safePreview = preview(redactSecrets(text, secrets), 200);
        observation.assistantTexts.push(safePreview);
        summary["textPreview"] = safePreview;
      } else if (blockType === "tool_use") {
        const input = asRec(block["input"]) ?? {};
        const filePath = asString(input["file_path"]) ?? asString(input["path"]);
        const toolUse: ToolUseObserved = {
          id: asString(block["id"]) ?? "",
          name: asString(block["name"]) ?? "unknown",
          filePath,
          inputPreview: preview(redactSecrets(JSON.stringify(input), secrets), 160),
        };
        observation.toolUses.push(toolUse);
        summary["toolUse"] = { name: toolUse.name, id: toolUse.id, filePath, inputPreview: toolUse.inputPreview };
      }
    }
    return summary;
  }

  if (type === "user") {
    const messageObj = asRec((message as Rec)["message"]);
    const content = messageObj?.["content"];
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : asArray(content);
    const summary: Rec = { kind: "user", blocks: [] };
    for (const rawBlock of blocks) {
      const block = asRec(rawBlock);
      if (!block) continue;
      if (asString(block["type"]) !== "tool_result") continue;
      const toolUseId = asString(block["tool_use_id"]) ?? "";
      const rawContent = block["content"];
      let text = "";
      if (typeof rawContent === "string") text = rawContent;
      else if (Array.isArray(rawContent)) {
        text = rawContent
          .map((part) => {
            const p = asRec(part);
            return asString(p?.["text"]) ?? "";
          })
          .join("");
      }
      const structured = (message as Rec)["tool_use_result"];
      if (structured !== undefined && text.length === 0) text = JSON.stringify(structured);
      const observed: ToolResultObserved = {
        toolUseId,
        isError: block["is_error"] === true,
        textPreview: preview(redactSecrets(text, secrets), 200),
        textLength: text.length,
      };
      observation.toolResults.push(observed);
      (summary["blocks"] as Rec[]).push({
        toolUseId,
        isError: observed.isError,
        textLength: observed.textLength,
        textPreview: observed.textPreview,
      });
    }
    return summary;
  }

  if (type === "result") {
    const rec = message as Rec;
    const usage = asRec(rec["usage"]) ?? {};
    const modelUsage = asRec(rec["modelUsage"]) ?? {};
    const resultText = asString(rec["result"]) ?? "";
    const result: ResultObserved = {
      subtype: subtype ?? "unknown",
      isError: rec["is_error"] === true,
      numTurns: asNumber(rec["num_turns"]),
      durationMs: asNumber(rec["duration_ms"]),
      resultText: redactSecrets(resultText, secrets),
      sessionId: asString(rec["session_id"]),
      totalCostUsd: asNumber(rec["total_cost_usd"]),
      usage: {
        inputTokens: asNumber(usage["input_tokens"]),
        outputTokens: asNumber(usage["output_tokens"]),
        cacheReadInputTokens: asNumber(usage["cache_read_input_tokens"]),
        cacheCreationInputTokens: asNumber(usage["cache_creation_input_tokens"]),
      },
      modelUsageKeys: Object.keys(modelUsage),
      errors: asArray(rec["errors"]).map((e) => preview(redactSecrets(String(e), secrets), 300)),
    };
    observation.result = result;
    return {
      kind: "result",
      subtype: result.subtype,
      isError: result.isError,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      modelUsageKeys: result.modelUsageKeys,
      usage: result.usage,
      sdkCostEstimateUsd: result.totalCostUsd,
      resultPreview: preview(result.resultText, 300),
      errors: result.errors,
    };
  }

  return { kind: "other", type, subtype };
}
