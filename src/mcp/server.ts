/**
 * MCP server factory. Tools are registered against the frozen SchedulerService
 * contract; dependency composition happens in main.ts.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { registerTools, SERVER_NAME, SERVER_VERSION, type McpDeps } from "./tools.js";

export { SERVER_NAME, SERVER_VERSION, MAX_BATCH_TASKS, type McpDeps } from "./tools.js";

export function createServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, deps);
  return server;
}
