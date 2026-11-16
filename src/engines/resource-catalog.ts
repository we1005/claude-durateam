/**
 * Operator-owned pre-approved Skill catalog.
 *
 * Tasks select skills by name only; paths never come from task input. For a
 * run with selected skills we build a minimal local plugin bundle that contains
 * ONLY the selected skill directories (no hooks, commands, agents or MCP),
 * pass it as `plugins: [{ type: 'local', path, skipMcpDiscovery: true }]`,
 * and use `skills: [names]` as the SDK context filter. A PreToolUse hook
 * additionally allowlists exact Skill tool names.
 *
 * Built-in skill metadata may still be listed by the CLI; this is documented,
 * not claimed as an unload.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const SKILL_BUNDLE_PLUGIN_NAME = "claude-durateam-skills";

interface SkillEntry {
  /** Absolute path to the skill directory containing SKILL.md. */
  dir: string;
  description?: string;
}

interface ResourceCatalogFile {
  skills?: Record<string, SkillEntry>;
}

export class SkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

export interface PreapprovedSkill {
  name: string;
  dir: string;
}

export interface SkillBundle {
  pluginPath: string;
  skillNames: string[];
}

const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Validate requested names against the operator catalog (paths are operator-owned). */
export function loadPreapprovedSkills(input: {
  catalogPath: string;
  requested: string[];
}): PreapprovedSkill[] {
  if (input.requested.length === 0) return [];
  if (!existsSync(input.catalogPath)) {
    throw new SkillCatalogError("skill_not_preapproved:resource catalog file missing");
  }
  let catalog: ResourceCatalogFile;
  try {
    catalog = JSON.parse(readFileSync(input.catalogPath, "utf8")) as ResourceCatalogFile;
  } catch {
    throw new SkillCatalogError("skill_not_preapproved:resource catalog is not valid JSON");
  }
  const skills = catalog.skills ?? {};
  const selected: PreapprovedSkill[] = [];
  for (const rawName of input.requested) {
    const name = rawName.trim();
    if (!SKILL_NAME_RE.test(name)) {
      throw new SkillCatalogError(`skill_not_preapproved:invalid skill name '${name}'`);
    }
    const entry = skills[name];
    if (!entry) throw new SkillCatalogError(`skill_not_preapproved:${name}`);
    if (!isAbsolute(entry.dir) || !existsSync(entry.dir) || !statSync(entry.dir).isDirectory()) {
      throw new SkillCatalogError(`skill_not_preapproved:${name} dir must be an existing absolute directory`);
    }
    if (!existsSync(join(entry.dir, "SKILL.md"))) {
      throw new SkillCatalogError(`skill_not_preapproved:${name} has no SKILL.md`);
    }
    selected.push({ name, dir: resolve(entry.dir) });
  }
  return selected;
}

const DENIED_SKILL_ENTRIES = new Set([".mcp.json", "hooks", ".claude-plugin", ".claude", "commands", "agents"]);

/**
 * Build a minimal plugin bundle containing only the selected skills.
 * Returns the plugin root path plus the exact names to pass to `skills`.
 */
export function buildSkillBundle(input: {
  skills: PreapprovedSkill[];
  bundleRoot: string;
}): SkillBundle {
  const pluginPath = resolve(input.bundleRoot, "plugin");
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(pluginPath, "skills"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(pluginPath, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: SKILL_BUNDLE_PLUGIN_NAME,
        version: "1.0.0",
        description: "Minimal claude-durateam skill bundle (selected skills only)",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  for (const skill of input.skills) {
    const target = join(pluginPath, "skills", skill.name);
    if (!existsSync(target)) {
      cpSync(skill.dir, target, {
        recursive: true,
        filter: (source) => {
          const base = source.split("/").pop() ?? "";
          return !DENIED_SKILL_ENTRIES.has(base);
        },
      });
    }
  }
  // Defensive: if a copied skill brought unexpected top-level entries, drop them.
  for (const entry of readdirSync(join(pluginPath, "skills"))) {
    if (!input.skills.some((skill) => skill.name === entry)) {
      throw new SkillCatalogError(`skill_bundle_invalid:unexpected bundled skill '${entry}'`);
    }
  }
  return { pluginPath, skillNames: input.skills.map((skill) => skill.name) };
}

/** Resolve the operator catalog path (env override allowed for tests/operators). */
export function resolveResourceCatalogPath(runtimeRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLAUDE_DURATEAM_RESOURCE_CATALOG"]?.trim();
  return override && isAbsolute(override) ? override : join(runtimeRoot, "config", "resource-catalog.json");
}
