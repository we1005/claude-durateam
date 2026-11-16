/**
 * Offline MCP stdio handshake check (T01): real client, real subprocess.
 * Verifies initialize, tools/list and tools/call for `init`/`models`, and that
 * the server starts with no usable credential (diagnostics never need one).
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../engines/environment.js";
import { createArtifactSink, errorSummary } from "../observability/artifacts.js";

async function main(): Promise<number> {
  const sink = createArtifactSink({ artifactRoot: ".artifacts", kind: "offline-mcp-handshake" });
  const serverPath = join(process.cwd(), "dist", "main.js");
  // Deliberately point at a non-existent key file: init/models must work without one.
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: join(resolveRuntimeRoot(), "mcp-handshake-home"),
    CLAUDE_DURATEAM_KEY_FILE: join(resolveRuntimeRoot(), "mcp-handshake-home", "absent-key.txt"),
    CLAUDE_DURATEAM_RUNTIME: resolveRuntimeRoot(),
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "claude-durateam-p0-test", version: "0.1.0" });

  const checks: Array<{ id: string; ok: boolean; detail?: string }> = [];
  try {
    await client.connect(transport);
    checks.push({ id: "initialize", ok: true });

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    sink.log("mcp.tools", { names });
    checks.push({
      id: "tools.list",
      ok: names.includes("init") && names.includes("models"),
      detail: names.join(","),
    });

    const initResult = await client.callTool({ name: "init", arguments: {} });
    const initText = (initResult.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    const initPayload = initText ? (JSON.parse(initText) as Record<string, unknown>) : {};
    checks.push({ id: "init.call", ok: Boolean(initPayload["version"]) });
    const credential = initPayload["credential"] as { configured?: boolean } | undefined;
    checks.push({
      id: "init.no_credential.needed",
      ok: credential?.configured === false,
      detail: `configured=${String(credential?.configured)}`,
    });
    checks.push({
      id: "init.base_url",
      ok: String(initPayload["baseUrl"]).includes("ark.cn-beijing.volces.com/api/coding"),
      detail: String(initPayload["baseUrl"]),
    });

    const modelsResult = await client.callTool({ name: "models", arguments: {} });
    const modelsText = (modelsResult.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text;
    const modelsPayload = modelsText ? (JSON.parse(modelsText) as Record<string, unknown>) : {};
    const allowed = Array.isArray(modelsPayload["allowed"]) ? (modelsPayload["allowed"] as string[]) : [];
    checks.push({
      id: "models.call",
      ok: allowed.includes("glm-5.3") && allowed.includes("glm-5.3-flash"),
      detail: allowed.join(","),
    });
    checks.push({ id: "models.no_fallback", ok: modelsPayload["noFallback"] === true });
  } catch (err) {
    sink.log("mcp.error", errorSummary(err));
    checks.push({ id: "handshake", ok: false, detail: errorSummary(err).message });
  } finally {
    try {
      await client.close();
    } catch {
      /* already closed */
    }
  }

  const passed = checks.every((check) => check.ok);
  sink.finalize(passed ? 0 : 1, {
    probe: "p0/mcp-handshake",
    status: passed ? "pass" : "fail",
    transport: "stdio",
    serverPath,
    checks,
    artifactsDir: sink.dir,
  });
  console.log(JSON.stringify({ status: passed ? "pass" : "fail", checks, artifactsDir: sink.dir }));
  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(JSON.stringify({ status: "fatal", ...errorSummary(err) }));
    process.exit(1);
  });
