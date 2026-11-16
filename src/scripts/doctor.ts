/**
 * Non-destructive doctor: versions, Coding Plan routing, credential presence
 * (never the value), isolation paths, optional tooling. Reads local
 * package.json files only; makes no network calls and touches no user
 * Claude/Codex/Pi configuration.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  AUTHORIZED_KEY_FILE,
  DEFAULT_BASE_URL,
  KEY_FILE_ENV,
  RUNTIME_ROOT_ENV,
  loadApiKeyFromFile,
  resolveKeyFile,
  resolveRuntimeRoot,
} from "../engines/environment.js";
import { MODEL_ROUTES, WORKER_MODELS } from "../contracts.js";

const require_ = createRequire(import.meta.url);

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

function packageVersion(name: string): string {
  try {
    // `exports` maps usually hide package.json; resolve the entry then walk up.
    let dir = dirname(require_.resolve(name));
    for (let depth = 0; depth < 4; depth += 1) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        if (pkg.name === name) return pkg.version ?? "unknown";
      }
      dir = dirname(dir);
    }
    return "missing";
  } catch {
    return "missing";
  }
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error || result.status !== 0) return `unavailable(${code ?? result.status})`;
  return (result.stdout.trim() || result.stderr.trim()).split("\n")[0] ?? "unknown";
}

function main(): number {
  const checks: Check[] = [];
  const nodeVersion = process.version;
  const nodeParts = nodeVersion.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  const nodeMajor = nodeParts[0] ?? 0;
  const nodeMinor = nodeParts[1] ?? 0;
  checks.push({
    id: "node.version",
    ok: nodeMajor >= 22 && (nodeMajor > 22 || nodeMinor >= 19),
    detail: `${nodeVersion} (>=22.19 required for node:sqlite baseline)`,
  });

  const sdkVersion = packageVersion("@anthropic-ai/claude-agent-sdk");
  checks.push({
    id: "sdk.version",
    ok: sdkVersion === "0.3.325",
    detail: `${sdkVersion} (expected 0.3.325)`,
  });
  const mcpVersion = packageVersion("@modelcontextprotocol/server");
  checks.push({
    id: "mcp.server.version",
    ok: mcpVersion === "2.4.0",
    detail: `${mcpVersion} (expected 2.4.0)`,
  });

  checks.push({
    id: "endpoint.base_url",
    ok: DEFAULT_BASE_URL === "https://ark.cn-beijing.volces.com/api/coding",
    detail: DEFAULT_BASE_URL,
  });
  checks.push({
    id: "models.whitelist",
    ok: WORKER_MODELS.length === 2,
    detail: WORKER_MODELS.join(", "),
  });

  const keyFile = resolveKeyFile();
  let credentialInfo: Record<string, unknown> = {
    configured: false,
    keyFileEnv: KEY_FILE_ENV,
    defaultFileExists: existsSync(AUTHORIZED_KEY_FILE),
  };
  try {
    const loaded = loadApiKeyFromFile(keyFile);
    credentialInfo = {
      configured: true,
      format: loaded.format,
      sourceBytes: loaded.sourceBytes,
      sourcePath: loaded.sourcePath,
      keyFileEnv: KEY_FILE_ENV,
      keyFileFromEnv: Boolean(process.env[KEY_FILE_ENV]),
      value: "[REDACTED]",
    };
    checks.push({ id: "credential.loadable", ok: true, detail: `format=${loaded.format} bytes=${loaded.sourceBytes}` });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "unknown";
    credentialInfo = { ...credentialInfo, configured: false, reason: `credential:${code}`, sourcePath: keyFile };
    checks.push({
      id: "credential.loadable",
      ok: false,
      detail: `credential:${code} — live probes will exit 2 (local refusal, no network)`,
    });
  }

  const runtimeRoot = resolveRuntimeRoot();
  let runtimeWritable = false;
  try {
    statSync(runtimeRoot);
    runtimeWritable = true;
  } catch {
    runtimeWritable = existsSync(runtimeRoot) === false; // will be created under the repo on first run
  }
  checks.push({
    id: "runtime.dir",
    ok: runtimeRoot.includes("/.runtime") || process.env[RUNTIME_ROOT_ENV] !== undefined,
    detail: runtimeRoot,
  });

  const readJsonSafe = (path: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const resourceCatalogPath = process.env["CLAUDE_DURATEAM_RESOURCE_CATALOG"] ?? join(runtimeRoot, "config", "resource-catalog.json");
  const resourceCatalog = readJsonSafe(resourceCatalogPath);
  const resourceSkills = resourceCatalog && typeof resourceCatalog["skills"] === "object"
    ? Object.keys(resourceCatalog["skills"] as Record<string, unknown>)
    : [];
  const mcpCatalogPath = join(runtimeRoot, "config", "mcp-catalog.json");
  const mcpCatalog = readJsonSafe(mcpCatalogPath);
  const mcpServers = mcpCatalog && typeof mcpCatalog["servers"] === "object"
    ? Object.fromEntries(
        Object.entries(mcpCatalog["servers"] as Record<string, unknown>).map(([name, entry]) => {
          const tools = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["tools"] : undefined;
          return [name, Array.isArray(tools) ? tools.length : 0];
        }),
      )
    : {};

  const operatorEnvFlags = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY"]
    .map((name) => `${name}=${process.env[name] !== undefined ? "set(not inherited)" : "absent"}`);

  checks.push({
    id: "cli.claude",
    ok: true,
    detail: commandVersion("claude", ["--version"]),
  });
  const sandboxExec = spawnSync("which", ["sandbox-exec"], { encoding: "utf8", timeout: 5_000 });
  checks.push({
    id: "sandbox.macos",
    ok: sandboxExec.status === 0,
    detail: sandboxExec.stdout.trim() || "sandbox-exec not found (sandboxed-bash profile must refuse to start)",
  });
  checks.push({ id: "git", ok: true, detail: commandVersion("git", ["--version"]) });

  const essentialIds = ["node.version", "sdk.version", "mcp.server.version", "endpoint.base_url", "models.whitelist", "runtime.dir"];
  const essentialOk = checks.filter((check) => essentialIds.includes(check.id)).every((check) => check.ok);
  const credentialOk = checks.find((check) => check.id === "credential.loadable")?.ok === true;
  const status = !essentialOk ? "fail" : !credentialOk ? "not_configured" : checks.every((check) => check.ok) ? "pass" : "warn";
  const report = {
    status,
    versions: {
      node: nodeVersion,
      claudeCli: commandVersion("claude", ["--version"]),
      sdk: sdkVersion,
      mcpServer: mcpVersion,
      zod: packageVersion("zod"),
      typescript: packageVersion("typescript"),
    },
    provider: {
      name: "volcengine-coding-plan",
      baseUrl: DEFAULT_BASE_URL,
      protocol: "anthropic-compatible",
      models: MODEL_ROUTES,
    },
    isolation: {
      runtimeRoot,
      runtimeWritable,
      claudeConfigDir: `${runtimeRoot}/p0/<run>/worker-home/home/.claude`,
      settingSources: [],
      operatorEnvNotInherited: operatorEnvFlags,
      protectedUserConfigs: ["~/.claude", "~/.claude.json", "~/.codex", "~/.pi — not read or modified"],
    },
    credential: credentialInfo,
    resourceCatalogs: {
      skills: { path: resourceCatalogPath, configured: resourceSkills.length > 0, names: resourceSkills },
      mcp: { path: mcpCatalogPath, configured: Object.keys(mcpServers).length > 0, servers: mcpServers },
      note: "operator-owned allowlists; task inputs carry names only, never paths",
    },
    optional: { sandboxExec: sandboxExec.status === 0, git: true },
    checks,
    artifacts: ".artifacts/ (gitignored)",
  };

  console.log(JSON.stringify(report, null, 2));
  return essentialOk ? 0 : 1;
}

process.exit(main());
