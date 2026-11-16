import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

it("retains real production MCP gate logs after cleanup without starting any model", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, ["dist/scripts/acceptance-live-mcp.js", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    timeout: 25_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  const summary = JSON.parse(readFileSync(resolve(output.runDir, "summary.json"), "utf8"));
  expect(summary.modelRuns).toBe(0);
  expect(summary.checks.zeroJobs).toBe(true);
  expect(summary.checks.temporaryDirectoryRemoved).toBe(true);
  expect(summary.checks.gateLogsSurviveCleanup).toBe(true);
  const evidence = summary.checks.gateEvidence;
  expect(evidence.map((item: any) => item.checks[0].exitCode)).toEqual([0, 9, 0]);
  const markers = ["gate-pass", "intentional-gate-failure", "gate-restored"];
  evidence.forEach((item: any, index: number) => {
    expect(existsSync(item.checks[0].log)).toBe(true);
    expect(readFileSync(item.checks[0].log, "utf8")).toContain(markers[index]);
  });
  const calls = readFileSync(summary.rpcLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.filter((call) => call.tool === "gate")).toHaveLength(3);
  expect(calls.some((call) => ["spawn", "spawn_batch", "follow_up", "fork"].includes(call.tool))).toBe(false);
}, 30_000);
