/**
 * Artifact sink for every real (live) run: unique directory, JSONL log,
 * structured result and the real process exit code. All lines pass through
 * the redactor; a hard leak guard runs before files are finalized.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNoSecret, redactDeep, redactSecrets } from "./redact.js";

export interface ArtifactSink {
  readonly dir: string;
  readonly logPath: string;
  readonly secrets: readonly string[];
  log(event: string, data?: Record<string, unknown>): void;
  /** Write result.json; throws if a raw secret survived redaction. */
  finalize(exitCode: number, result: Record<string, unknown>): void;
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
}

export function createArtifactSink(options: {
  artifactRoot: string;
  kind: string;
  secrets?: readonly string[];
  suffix?: string;
}): ArtifactSink {
  const secrets = options.secrets ?? [];
  const name = `${stamp()}-${options.kind}${options.suffix ? `-${options.suffix}` : ""}-${process.pid}`;
  const dir = resolve(options.artifactRoot, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, "run.log");

  const log: ArtifactSink["log"] = (event, data = {}) => {
    const safeData = redactDeep(data, secrets);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...safeData })}\n`;
    appendFileSync(logPath, line, { mode: 0o600 });
  };

  log("sink.created", { dir, kind: options.kind });

  return {
    dir,
    logPath,
    secrets,
    log,
    finalize(exitCode, result) {
      const payload = JSON.stringify(redactDeep({ ...result, exitCode }, secrets), null, 2);
      assertNoSecret(payload, secrets);
      const resultPath = join(dir, "result.json");
      writeFileSync(resultPath, `${payload}\n`, { mode: 0o600 });
      writeFileSync(join(dir, "exit-code.txt"), `${exitCode}\n`, { mode: 0o600 });
      writeFileSync(join(dir, "run.log.meta"), `${redactSecrets(`exitCode=${exitCode}`, secrets)}\n`, {
        mode: 0o600,
      });
    },
  };
}

/** Summarize an error without leaking credentials or full request bodies. */
export function errorSummary(err: unknown, secrets: readonly string[] = []): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: redactSecrets(err.message, secrets).slice(0, 800) };
  }
  return { name: typeof err, message: redactSecrets(String(err), secrets).slice(0, 800) };
}
