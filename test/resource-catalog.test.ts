import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SkillCatalogError,
  buildSkillBundle,
  loadPreapprovedSkills,
  resolveResourceCatalogPath,
} from "../src/engines/resource-catalog.js";

const root = join(process.cwd(), ".runtime", "test-tmp", `skill-catalog-${randomUUID()}`);

function makeSkill(name: string, marker: string): string {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture skill\n---\n\nReport marker ${marker} when invoked.\n`,
  );
  writeFileSync(join(dir, "notes.txt"), "asset\n");
  return dir;
}

function makeCatalog(skills: Record<string, { dir: string }>): string {
  const path = join(root, "resource-catalog.json");
  writeFileSync(path, JSON.stringify({ skills }));
  return path;
}

describe("operator-owned skill catalog", () => {
  it("loads only selected names and builds a minimal plugin bundle", () => {
    const alpha = makeSkill("alpha", "ALPHA-MARK");
    const beta = makeSkill("beta", "BETA-MARK");
    const catalogPath = makeCatalog({ alpha: { dir: alpha }, beta: { dir: beta } });

    const selected = loadPreapprovedSkills({ catalogPath, requested: ["alpha"] });
    expect(selected.map((skill) => skill.name)).toEqual(["alpha"]);

    const bundle = buildSkillBundle({ skills: selected, bundleRoot: join(root, "bundle") });
    expect(bundle.skillNames).toEqual(["alpha"]);
    expect(existsSync(join(bundle.pluginPath, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(bundle.pluginPath, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(bundle.pluginPath, "skills", "beta"))).toBe(false);
    expect(existsSync(join(bundle.pluginPath, "hooks"))).toBe(false);
    expect(existsSync(join(bundle.pluginPath, ".mcp.json"))).toBe(false);
    expect(readFileSync(join(bundle.pluginPath, "skills", "alpha", "SKILL.md"), "utf8")).toContain("ALPHA-MARK");
  });

  it("rejects unknown, invalid or path-escape skill selections before any query", () => {
    const alpha = makeSkill("alpha", "ALPHA-MARK");
    const catalogPath = makeCatalog({ alpha: { dir: alpha } });
    expect(() => loadPreapprovedSkills({ catalogPath, requested: ["not-selected"] })).toThrow(SkillCatalogError);
    expect(() => loadPreapprovedSkills({ catalogPath, requested: ["../escape"] })).toThrow(/invalid skill name/);
    expect(() => loadPreapprovedSkills({ catalogPath: "/nope.json", requested: ["alpha"] })).toThrow(
      /catalog file missing/,
    );
    const badCatalog = join(root, "bad.json");
    writeFileSync(badCatalog, JSON.stringify({ skills: { alpha: { dir: "relative/path" } } }));
    expect(() => loadPreapprovedSkills({ catalogPath: badCatalog, requested: ["alpha"] })).toThrow(
      /absolute directory/,
    );
  });

  it("resolves an absolute operator override or a private runtime default", () => {
    expect(resolveResourceCatalogPath("/runtime", { CLAUDE_DURATEAM_RESOURCE_CATALOG: "/abs/catalog.json" })).toBe(
      "/abs/catalog.json",
    );
    expect(resolveResourceCatalogPath("/runtime", { CLAUDE_DURATEAM_RESOURCE_CATALOG: "relative.json" })).toBe(
      "/runtime/config/resource-catalog.json",
    );
  });
});
