/**
 * Pre-approved MCP server catalog.
 *
 * Only servers explicitly listed here may be injected into a Worker. User/project
 * MCP configuration is never loaded (`settingSources: []` + `strictMcpConfig`).
 * Requesting anything else fails instead of silently succeeding.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

interface CatalogEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Exact tool names authorized for automatic use (no per-call approval). */
  tools?: string[];
  /** Optional note for humans; ignored at runtime. */
  description?: string;
}

interface CatalogFile {
  servers?: Record<string, CatalogEntry>;
}

export class McpCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCatalogError";
  }
}

export interface PreapprovedMcpPolicy {
  servers: NonNullable<Options["mcpServers"]>;
  /** `mcp__<server>__` prefixes for explicitly selected catalog servers. */
  approvedPrefixes: string[];
  /** Exact `mcp__<server>__<tool>` names authorized by the catalog entry. */
  approvedTools: string[];
}

export function loadPreapprovedMcpServers(input: {
  catalogPath: string;
  requested: string[];
}): PreapprovedMcpPolicy {
  if (input.requested.length === 0) return { servers: {}, approvedPrefixes: [], approvedTools: [] };
  if (!existsSync(input.catalogPath)) {
    throw new McpCatalogError("mcp_server_not_preapproved:catalog file missing");
  }
  let catalog: CatalogFile;
  try {
    catalog = JSON.parse(readFileSync(input.catalogPath, "utf8")) as CatalogFile;
  } catch {
    throw new McpCatalogError("mcp_server_not_preapproved:catalog file is not valid JSON");
  }
  const servers = catalog.servers ?? {};
  const out: Record<string, CatalogEntry & { type: "stdio" }> = {};
  const approvedTools: string[] = [];
  for (const name of input.requested) {
    const entry = servers[name];
    if (!entry) {
      throw new McpCatalogError(`mcp_server_not_preapproved:${name}`);
    }
    if (!entry.command.startsWith("/")) {
      throw new McpCatalogError(`mcp_server_not_preapproved:${name} command must be an absolute path`);
    }
    if ((entry.tools ?? []).some((tool) => !/^[A-Za-z0-9_-]+$/.test(tool))) {
      throw new McpCatalogError(`mcp_server_not_preapproved:${name} has invalid tool names`);
    }
    for (const tool of entry.tools ?? []) approvedTools.push(`mcp__${name}__${tool}`);
    out[name] = { type: "stdio", command: entry.command, args: entry.args, env: entry.env };
  }
  return {
    servers: out as NonNullable<Options["mcpServers"]>,
    approvedPrefixes: input.requested.map((name) => `mcp__${name}__`),
    approvedTools,
  };
}
