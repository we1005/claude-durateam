import { readFileSync } from "node:fs";

/** One source of truth for package, MCP handshake and diagnostics. */
export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
