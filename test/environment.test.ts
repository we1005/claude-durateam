import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AUTHORIZED_KEY_FILE,
  CredentialError,
  DEFAULT_BASE_URL,
  KEY_FILE_ENV,
  assertIsolatedEnv,
  buildWorkerEnv,
  loadApiKeyFromFile,
  prepareWorkerHome,
  resolveKeyFile,
  resolveRuntimeRoot,
} from "../src/engines/environment.js";

const runtimeRoot = resolveRuntimeRoot();

function tempFile(name: string, content: string): string {
  const dir = join(runtimeRoot, "test-tmp", `${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

describe("credential loading", () => {
  it("accepts a raw single-line token and trims whitespace", () => {
    const token = `ARK-${randomBytes(8).toString("hex")}`;
    const loaded = loadApiKeyFromFile(tempFile("key.txt", `  ${token}\n\n`));
    expect(loaded.token).toBe(token);
    expect(loaded.format).toBe("raw");
  });

  it("accepts an ANTHROPIC_AUTH_TOKEN assignment", () => {
    const token = `ARK-${randomBytes(8).toString("hex")}`;
    const loaded = loadApiKeyFromFile(tempFile("key.env", `ANTHROPIC_AUTH_TOKEN=${token}\n`));
    expect(loaded.token).toBe(token);
    expect(loaded.format).toBe("env-assignment");
  });

  it("rejects multi-line files instead of guessing", () => {
    expect(() => loadApiKeyFromFile(tempFile("multi.txt", "one\ntwo\n"))).toThrowError(CredentialError);
    try {
      loadApiKeyFromFile(tempFile("multi2.txt", "one\ntwo\n"));
    } catch (err) {
      expect((err as CredentialError).code).toBe("malformed");
    }
  });

  it("rejects missing files with a non-leaking error", () => {
    try {
      loadApiKeyFromFile(join(runtimeRoot, "definitely-absent", "key.txt"));
      throw new Error("expected throw");
    } catch (err) {
      expect(err instanceof CredentialError).toBe(true);
      expect((err as CredentialError).code).toBe("missing");
      expect((err as Error).message).not.toContain("ARK-");
    }
  });

  it("rejects ambiguous non-Anthropic env assignments", () => {
    try {
      loadApiKeyFromFile(tempFile("key3.txt", `OPENAI_API_KEY=abcdefgh1234\n`));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as CredentialError).code).toBe("malformed");
    }
  });

  it("resolves the key path from env, falling back to the authorized path", () => {
    expect(resolveKeyFile({ [KEY_FILE_ENV]: "/tmp/other.txt" })).toBe("/tmp/other.txt");
    expect(resolveKeyFile({})).toBe(AUTHORIZED_KEY_FILE);
  });
});

describe("worker environment isolation", () => {
  const token = `ARK-${randomBytes(12).toString("hex")}`;
  const credential = loadApiKeyFromFile(tempFile("envkey.txt", `${token}\n`));
  const workerHome = prepareWorkerHome(runtimeRoot, `test-home-${randomBytes(4).toString("hex")}`);

  it("builds an allowlisted env and drops inherited credentials/proxies", () => {
    const saved = { ...process.env };
    process.env["ANTHROPIC_API_KEY"] = "inherited-must-not-leak";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "inherited-must-not-leak";
    process.env["HTTP_PROXY"] = "http://127.0.0.1:9";
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:9";
    try {
      const built = buildWorkerEnv({ credential, model: "glm-5.3", workerHome });
      expect(built.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(built.env["HTTP_PROXY"]).toBeUndefined();
      expect(built.env["ANTHROPIC_BASE_URL"]).toBe(DEFAULT_BASE_URL);
      expect(built.env["ANTHROPIC_AUTH_TOKEN"]).toBe(token);
      expect(built.env["HOME"]).toBe(workerHome.home);
      expect(built.env["CLAUDE_CONFIG_DIR"]).toBe(workerHome.claudeConfigDir);
      for (const tier of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
      ]) {
        expect(built.env[tier]).toBe("glm-5.3");
      }
      expect(JSON.stringify(built.summary)).not.toContain(token);
      expect(() => assertIsolatedEnv(built.env, runtimeRoot)).not.toThrow();
    } finally {
      for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("refuses a HOME outside the runtime root", () => {
    const built = buildWorkerEnv({ credential, model: "glm-5.3-flash", workerHome });
    expect(() => {
      built.env["HOME"] = "/tmp/outside";
      assertIsolatedEnv(built.env, runtimeRoot);
    }).toThrow();
  });

  it("refuses a non-Volcengine base URL", () => {
    const built = buildWorkerEnv({ credential, model: "glm-5.3", workerHome });
    built.env["ANTHROPIC_BASE_URL"] = "https://api.anthropic.com";
    expect(() => assertIsolatedEnv(built.env, runtimeRoot)).toThrow();
  });
});
