import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { resolveRuntimeRoot } from "../src/engines/environment.js";

const runtimeRoot = resolveRuntimeRoot();
const serverPath = join(process.cwd(), "dist", "main.js");

describe("MCP stdio handshake (built server)", () => {
  it(
    "lists init/models and calls them without credentials",
    async () => {
      const home = join(runtimeRoot, "test-tmp", `mcp-home-${Date.now()}`);
      mkdirSync(home, { recursive: true });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          CLAUDE_DURATEAM_KEY_FILE: join(home, "absent-key.txt"),
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "vitest", version: "0.0.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names).toContain("init");
        expect(names).toContain("models");

        const init = await client.callTool({ name: "init", arguments: {} });
        const initText = (init.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
        const payload = JSON.parse(initText) as {
          baseUrl: string;
          credential: { configured: boolean };
          models: Array<{ id: string }>;
        };
        expect(payload.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/coding");
        expect(payload.credential.configured).toBe(false);
        expect(payload.models.map((model) => model.id)).toContain("glm-5.3");

        const models = await client.callTool({ name: "models", arguments: {} });
        const modelsText = (models.content as Array<{ type: string; text?: string }>)[0]?.text ?? "{}";
        const modelsPayload = JSON.parse(modelsText) as { allowed: string[]; noFallback: boolean };
        expect(modelsPayload.allowed).toContain("glm-5.3-flash");
        expect(modelsPayload.noFallback).toBe(true);
      } finally {
        await client.close();
      }
    },
    40_000,
  );
});
