#!/usr/bin/env node
// Minimal no-side-effect MCP stdio fixture: one `echo` tool.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

serveStdio(() => {
  const server = new McpServer({ name: "cdt-echo-fixture", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Echo payload",
      description: "Return the provided payload unchanged (fixture, no side effects)",
      inputSchema: z.object({ payload: z.string() }),
    },
    async (args) => ({ content: [{ type: "text", text: args.payload }] }),
  );
  return server;
});
