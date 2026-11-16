#!/usr/bin/env node
// Explicitly authorized fallback only. One pipe preserves one MCP connection.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--config' && isAbsolute(args[1]))) {
  process.stderr.write('Usage: node mcp-client.mjs [--config /absolute/config.toml]\n');
  process.exit(2);
}
const configFile = args[1] ?? join(homedir(), '.codex/config.toml');
let client;
let input;
try {
  const config = JSON.parse(execFileSync('python3', ['-c',
    'import json,pathlib,sys,tomllib; print(json.dumps(tomllib.loads(pathlib.Path(sys.argv[1]).read_text())["mcp_servers"]["claude_durateam"]))',
    configFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (config.enabled === false) throw new Error('disabled');
  const entry = config.args?.find(arg => typeof arg === 'string' && isAbsolute(arg) && /\.[cm]?js$/.test(arg));
  if (!entry || typeof config.command !== 'string') throw new Error('unsupported registration');
  const require = createRequire(entry);
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);
  const transport = new StdioClientTransport({
    command: config.command, args: config.args,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), ...config.env },
    stderr: 'pipe',
  });
  // Do not echo server stderr or configuration: either could contain operator data.
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'claude-durateam-skill-fallback', version: '1.0.0' });
  await client.connect(transport);
  process.stdout.write(JSON.stringify({ ready: true, connection: 'official-mcp-client-stdio', pid: transport.pid }) + '\n');
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ error: 'invalid_json' }) + '\n');
      continue;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      process.stdout.write(JSON.stringify({ error: 'invalid_request' }) + '\n');
      continue;
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    if (request.close === true) {
      await client.close();
      process.stdout.write(JSON.stringify({ id, closed: true }) + '\n');
      break;
    }
    if (request.list !== true && typeof request.name !== 'string') {
      process.stdout.write(JSON.stringify({ id, error: 'missing_tool_name' }) + '\n');
      continue;
    }
    try {
      const result = request.list === true ? await client.listTools() : await client.callTool({
        name: request.name, arguments: request.arguments ?? {},
      }, undefined, { timeout: (config.tool_timeout_sec ?? 120) * 1_000 });
      process.stdout.write(JSON.stringify({ id, result }) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ id, error: 'mcp_request_failed' }) + '\n');
    }
  }
} catch {
  process.stderr.write('MCP fallback unavailable: check enabled local Node registration, Python 3.11+, installed official MCP Client, and server ownership. No model was deliberately substituted.\n');
  process.exitCode = 1;
} finally {
  input?.close();
  await client?.close().catch(() => {});
}
