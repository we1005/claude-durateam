import type { JobProgress, WorkerEvent } from "../task-contracts.js";

export function emptyProgress(): JobProgress {
  return { turns: 0, turnsEstimated: true, phase: "queued", lastActivityAt: null, lastToolAt: null, recentTools: [], touchedFiles: [],
    editWriteCount: 0, lastSteer: null, answerState: "pending", warnings: [] };
}

export function copyProgress(value?: JobProgress): JobProgress {
  return value ? structuredClone(value) : emptyProgress();
}

/** Metadata only: never receives command bodies, tool results, or reasoning. */
export function recordProgress(p: JobProgress, event: WorkerEvent, at: string): void {
  p.lastActivityAt = at;
  if (event.type === "init" || event.type === "turn") p.phase = "model";
  if (event.type === "turn") {
    if (Number.isInteger(event.turnCount) && event.turnCount! >= 0) { p.turns = event.turnCount!; p.turnsEstimated = false; }
    else p.turns += 1;
  }
  if (event.type === "tool_start") {
    p.phase = "tool";
    p.recentTools.push({ id: (event.toolCallId ?? `event-${at}-${p.recentTools.length}`).slice(0, 120),
      name: (event.toolName ?? "unknown").slice(0, 120), state: "running", at,
      ...(event.path ? { path: event.path.slice(0, 500) } : {}) });
    p.recentTools = p.recentTools.slice(-5);
  }
  if (event.type === "tool_end") {
    const tool = [...p.recentTools].reverse().find(t => event.toolCallId ? t.id === event.toolCallId : t.name === event.toolName && t.state === "running");
    if (tool) { tool.state = event.isError ? "failed" : "succeeded"; tool.at = at; }
    p.phase = p.recentTools.some(t => t.state === "running") ? "tool" : "model";
    p.lastToolAt = at;
    if (!event.isError && event.path && ["Edit", "Write", "NotebookEdit"].includes(event.toolName ?? "")) {
      p.editWriteCount += 1;
      if (!p.touchedFiles.includes(event.path) && p.touchedFiles.length < 100) p.touchedFiles.push(event.path);
    }
  }
  if (event.type === "steer_ack") p.lastSteer = { messageId: event.messageId ?? "", disposition: "delivered", at };
}
