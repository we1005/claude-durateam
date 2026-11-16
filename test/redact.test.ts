import { describe, expect, it } from "vitest";
import { assertNoSecret, preview, redactDeep, redactSecrets } from "../src/observability/redact.js";
import { isWorkerModel, isWorkerProfile } from "../src/contracts.js";

const SECRET = "ARK-SECRET-abcdef0123456789";

describe("redaction", () => {
  it("masks exact secrets, bearer tokens and api-key headers", () => {
    const input = [
      `token=${SECRET}`,
      `Authorization: Bearer ${SECRET}`,
      `{"x-api-key": "${SECRET}"}`,
      "sk-1234567890abcdefghij",
    ].join(" | ");
    const out = redactSecrets(input, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("sk-1234567890abcdefghij");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts nested structures", () => {
    const payload = { a: [SECRET], b: { c: `x ${SECRET}` } };
    const redacted = redactDeep(payload, [SECRET]);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });

  it("fails hard when a secret survives", () => {
    expect(() => assertNoSecret(`prefix ${SECRET}`, [SECRET])).toThrow(/leak guard/);
    expect(() => assertNoSecret("clean payload", [SECRET])).not.toThrow();
  });

  it("truncates previews to a single bounded line", () => {
    expect(preview("a\n b\tc", 10)).toBe("a b c");
    expect(preview("x".repeat(50), 10).endsWith("…")).toBe(true);
  });
});

describe("model and profile guards", () => {
  it("accepts only whitelisted models", () => {
    expect(isWorkerModel("glm-5.3")).toBe(true);
    expect(isWorkerModel("glm-5.3-flash")).toBe(true);
    expect(isWorkerModel("claude-opus-4")).toBe(false);
  });

  it("accepts only known profiles", () => {
    expect(isWorkerProfile("read")).toBe(true);
    expect(isWorkerProfile("edit")).toBe(true);
    expect(isWorkerProfile("sandboxed-bash")).toBe(true);
    expect(isWorkerProfile("bypass")).toBe(false);
  });
});
