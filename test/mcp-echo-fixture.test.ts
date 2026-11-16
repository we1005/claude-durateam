import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";

describe("MCP echo fixture", () => {
  it("serves one no-side-effect echo tool over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "test", "fixtures", "mcp-echo-server.mjs")],
      env: { PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "fixture-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const echoed = await client.callTool({ name: "echo", arguments: { payload: "FIXTURE-OK" } });
      const text = (echoed.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(text).toBe("FIXTURE-OK");
    } finally {
      await client.close();
    }
  }, 20_000);
});
