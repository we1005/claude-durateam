#!/usr/bin/env node
/** One Codex MCP connection owns one durable namespace; stdout is MCP only. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const base = process.env.CLAUDE_DURATEAM_RUNTIME ?? join(homedir(), '.local/share/claude-durateam/codex');
if (!isAbsolute(base)) throw new Error('CLAUDE_DURATEAM_RUNTIME must be absolute');
const requested = process.env.CLAUDE_DURATEAM_INSTANCE;
if (requested !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(requested)) {
  throw new Error('CLAUDE_DURATEAM_INSTANCE must be a simple instance name');
}
const instance = requested ?? `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14)}-${randomUUID().slice(0,12)}`;
const runtime = join(base, 'instances', instance);
mkdirSync(runtime, { recursive: true, mode: 0o700 });
process.env.CLAUDE_DURATEAM_RUNTIME = runtime;
process.env.CLAUDE_DURATEAM_INSTANCE_BASE = base;
process.env.CLAUDE_DURATEAM_CONFIG_DIR ??= base;
const operatorConfig = join(process.env.CLAUDE_DURATEAM_CONFIG_DIR, 'config');
mkdirSync(operatorConfig, { recursive: true, mode: 0o700 });
for (const [file, empty] of [['resource-catalog.json', {skills:{}}], ['mcp-catalog.json', {servers:{}}]]) {
  try { writeFileSync(join(operatorConfig, file), JSON.stringify(empty) + '\n', {flag:'wx',mode:0o600}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
process.env.CLAUDE_DURATEAM_INSTANCE = instance;
// An explicit DB is an intentional shared-owner override; keep its fail-closed semantics.
process.env.CLAUDE_DURATEAM_STATE_DB ??= join(runtime, 'state/claude-durateam.db');
writeFileSync(join(runtime, `connection-${process.pid}.json`), JSON.stringify({
  instance, pid: process.pid, createdAt: new Date().toISOString(), cwd: process.cwd(),
  runtime, stateDb: process.env.CLAUDE_DURATEAM_STATE_DB, reuseRequested: requested !== undefined,
}, null, 2) + '\n', { mode: 0o600 });
process.stderr.write(JSON.stringify({ event: 'codex.instance', instance, runtime }) + '\n');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
await import(pathToFileURL(join(root, 'dist/main.js')).href);
