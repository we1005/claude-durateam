import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadPreapprovedMcpServers, McpCatalogError } from "../src/engines/mcp-catalog.js";

const root = join(process.cwd(), ".runtime", "test-tmp", `mcp-catalog-${randomUUID()}`);

function catalog(): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, "catalog.json");
  writeFileSync(
    path,
    JSON.stringify({
      servers: {
        alpha: { command: "/usr/bin/true", tools: ["echo"] },
        beta: { command: "/usr/bin/true" },
      },
    }),
  );
  return path;
}

describe("pre-approved MCP catalog", () => {
  it("exposes exact selected prefixes and authorized tool names only", () => {
    const policy = loadPreapprovedMcpServers({ catalogPath: catalog(), requested: ["alpha"] });
    expect(Object.keys(policy.servers)).toEqual(["alpha"]);
    expect(policy.approvedPrefixes).toEqual(["mcp__alpha__"]);
    expect(policy.approvedTools).toEqual(["mcp__alpha__echo"]);
  });

  it("rejects unselected servers and unsafe catalog entries", () => {
    expect(() => loadPreapprovedMcpServers({ catalogPath: catalog(), requested: ["gamma"] })).toThrow(
      McpCatalogError,
    );
    const badPath = join(root, "bad.json");
    writeFileSync(badPath, JSON.stringify({ servers: { bad: { command: "relative-binary" } } }));
    expect(() => loadPreapprovedMcpServers({ catalogPath: badPath, requested: ["bad"] })).toThrow(
      /command must be an absolute path/,
    );
  });

  it("returns an empty policy when no server is selected", () => {
    expect(loadPreapprovedMcpServers({ catalogPath: "/nonexistent", requested: [] })).toEqual({
      servers: {},
      approvedPrefixes: [],
      approvedTools: [],
    });
  });
});
