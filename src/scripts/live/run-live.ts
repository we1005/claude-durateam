/**
 * Explicit live suite (consumes Volcengine Coding Plan quota):
 *   1. SDK read probe — glm-5.3
 *   2. SDK read probe — glm-5.3-flash
 *   3. CLI read probe — glm-5.3
 *   4. Negative endpoint probe — one invalid token (auth rejection, no quota)
 *
 * Each child writes its own `.artifacts` directory; this runner additively
 * stores stdout/stderr and the real exit code per step.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../../engines/environment.js";

interface Step {
  name: string;
  script: string;
  args: string[];
  live: boolean;
}

const steps: Step[] = [
  { name: "sdk-glm-5.3", script: "dist/scripts/live/probe-sdk.js", args: ["--model", "glm-5.3"], live: true },
  { name: "sdk-glm-5.3-flash", script: "dist/scripts/live/probe-sdk.js", args: ["--model", "glm-5.3-flash"], live: true },
  { name: "cli-glm-5.3", script: "dist/scripts/live/probe-cli.js", args: ["--model", "glm-5.3"], live: true },
  { name: "edit-resume-glm-5.3", script: "dist/scripts/live/probe-edit-resume.js", args: ["--model", "glm-5.3"], live: true },
  { name: "negative-wrong-token", script: "dist/scripts/live/probe-negative.js", args: ["--case", "wrong-token"], live: true },
  { name: "negative-missing-key", script: "dist/scripts/live/probe-negative.js", args: ["--case", "missing"], live: false },
  { name: "negative-malformed-key", script: "dist/scripts/live/probe-negative.js", args: ["--case", "malformed"], live: false },
];

async function runStep(step: Step, dir: string): Promise<number> {
  const log = spawn(process.execPath, [step.script, ...step.args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  log.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  log.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const code = await new Promise<number>((resolve) => log.on("close", (c) => resolve(c ?? 1)));
  writeFileSync(join(dir, `${step.name}.stdout.json`), stdout, { mode: 0o600 });
  writeFileSync(join(dir, `${step.name}.stderr.log`), stderr, { mode: 0o600 });
  writeFileSync(join(dir, `${step.name}.exit-code.txt`), `${code}\n`, { mode: 0o600 });
  return code;
}

async function main(): Promise<number> {
  const dir = join(resolveRuntimeRoot(), "live-suite", new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const results: Array<{ name: string; live: boolean; exitCode: number }> = [];
  for (const step of steps) {
    process.stderr.write(`[run-live] ${step.name} (${step.live ? "LIVE" : "offline"})\n`);
    const exitCode = await runStep(step, dir);
    results.push({ name: step.name, live: step.live, exitCode });
  }
  const summary = {
    suite: "p0-live",
    dir,
    quotaConsumingSteps: results.filter((r) => r.live).map((r) => r.name),
    results,
    passed: results.every((r) => r.exitCode === 0),
    note: "Each live step performs one tiny bounded task; cost is reported from the SDK estimate only.",
  };
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary));
  return summary.passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", message: String(err) }));
    process.exit(1);
  });
