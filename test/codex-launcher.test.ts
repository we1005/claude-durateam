import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

it('independent Codex connections get distinct stores; explicit reuse still rejects an active owner', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const base = mkdtempSync(join(tmpdir(), 'cdt-codex-connection-'));
  const clients: Client[] = [];
  async function connect(instance?: string) {
    const c = new Client({ name: 'connection-test', version: '1.0.0' });clients.push(c);
    await c.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(root, 'scripts/codex-mcp-launcher.mjs')], stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: base, CLAUDE_DURATEAM_RUNTIME: base,
        CLAUDE_DURATEAM_ALLOWED_ROOTS: root, CLAUDE_DURATEAM_KEY_FILE: join(base, 'absent'),
        ...(instance ? { CLAUDE_DURATEAM_INSTANCE: instance } : {}) },
    }));
    const result = await c.callTool({ name: 'init', arguments: {} });
    return JSON.parse((result.content as {type:string;text:string}[]).find(x => x.type === 'text')!.text);
  }
  try {
    const [one, two] = await Promise.all([connect(), connect()]);
    expect(one.scheduler.available).toBe(true);expect(two.scheduler.available).toBe(true);
    expect(one.connection.instanceId).not.toBe(two.connection.instanceId);
    expect(one.connection.configDir).toBe(base);
    expect(two.connection.configDir).toBe(base);
    expect(JSON.parse(readFileSync(join(base,'config/resource-catalog.json'),'utf8'))).toEqual({skills:{}});
    expect(one.connection.scope).toBe('codex-connection');
    const ids = readdirSync(join(base, 'instances'));expect(ids).toHaveLength(2);
    const paths = ids.map(id => {
      const dir = join(base, 'instances', id);
      const file = readdirSync(dir).find(x => x.startsWith('connection-'))!;
      return JSON.parse(readFileSync(join(dir, file), 'utf8')).stateDb;
    });expect(new Set(paths).size).toBe(2);
    const conflict = await connect(ids[0]);expect(conflict.scheduler.available).toBe(false);
    expect(conflict.scheduler.reason).toContain('ownership');
    await Promise.all(clients.map(c => c.close()));clients.length = 0;
    const recovered = await connect(ids[0]);expect(recovered.scheduler.available).toBe(true);
    expect(recovered.connection.instanceId).toBe(ids[0]);
  } finally { await Promise.all(clients.map(c => c.close()));rmSync(base, { recursive: true, force: true }); }
}, 30000);
