import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXCLUSIONS, OPERATIONS, SOURCE_VERSION, toolNames } from "../src/operations.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface InventoryFile {
  path: string;
  sha256: string;
}

interface InventoryRoute {
  method: string;
  path: string;
  operationId: string;
  sourceFile: string;
}

interface Inventory {
  project: string;
  version: string;
  license: string;
  sourceSha256: string;
  routeTreeSha256: string;
  files: InventoryFile[];
  routes: InventoryRoute[];
}

function loadInventory(): Inventory {
  return JSON.parse(
    readFileSync(new URL("../spec/api-inventory.json", import.meta.url), "utf8"),
  ) as Inventory;
}

function treeHash(files: InventoryFile[], routes: InventoryRoute[]): string {
  const lines = [
    ...files.map((file) => `${file.path} ${file.sha256}`),
    ...routes.map((route) => `${route.method} ${route.path} ${route.operationId}`),
  ];
  return createHash("sha256")
    .update(`${lines.join("\n")}\n`)
    .digest("hex");
}

function keyOf(row: { method: string; path: string }): string {
  return `${row.method} ${row.path}`;
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (entry.endsWith(".mjs") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("route coverage", () => {
  const inventory = loadInventory();
  const routes = JSON.parse(
    readFileSync(new URL("../harbor.routes.json", import.meta.url), "utf8"),
  ) as {
    source: {
      version: string;
      license: string;
      routeTreeSha256: string;
      files: InventoryFile[];
    };
    operations: {
      method: string;
      path: string;
      operationId: string;
      exclude?: boolean;
      reason?: string;
      tool?: string;
      action?: string;
    }[];
  };

  it("pins Harbor 2.16.0 Apache-2.0 with the /api/v2.0 inventory", () => {
    expect(SOURCE_VERSION).toBe("2.16.0");
    expect(inventory.version).toBe("2.16.0");
    expect(inventory.license).toBe("Apache-2.0");
    expect(inventory.project).toBe("goharbor/harbor");
    expect(inventory.routes.length).toBe(208);
    expect(OPERATIONS.length + EXCLUSIONS.length).toBe(inventory.routes.length);
    expect(toolNames()).toEqual([
      "harbor_admin",
      "harbor_artifacts",
      "harbor_projects",
      "harbor_repositories",
      "harbor_robots",
      "harbor_system",
    ]);
  });

  it("keeps inventory hashes independent of the handwritten map", () => {
    expect(inventory.routeTreeSha256).toBe(treeHash(inventory.files, inventory.routes));
    expect(inventory.routeTreeSha256).toBe(routes.source.routeTreeSha256);
    const mapped = new Set(OPERATIONS.map(keyOf));
    const excluded = new Set(EXCLUSIONS.map(keyOf));
    for (const route of inventory.routes) {
      const key = keyOf(route);
      expect(mapped.has(key) || excluded.has(key), key).toBe(true);
      expect(mapped.has(key) && excluded.has(key), key).toBe(false);
    }
  });

  it("maps project repository artifact robot routes and excludes config ldap scanners", () => {
    expect(
      OPERATIONS.some((row) => row.tool === "harbor_projects" && row.action === "create"),
    ).toBe(true);
    expect(OPERATIONS.some((row) => row.tool === "harbor_artifacts" && row.action === "scan")).toBe(
      true,
    );
    expect(
      OPERATIONS.some((row) => row.tool === "harbor_robots" && row.action === "refresh_secret"),
    ).toBe(true);
    expect(EXCLUSIONS.some((row) => row.path.includes("/configurations"))).toBe(true);
    expect(EXCLUSIONS.some((row) => row.path.includes("/ldap/"))).toBe(true);
    expect(EXCLUSIONS.some((row) => row.path.includes("/scanners"))).toBe(true);
    expect(EXCLUSIONS.some((row) => row.path.includes("/registries"))).toBe(true);
    expect(EXCLUSIONS.every((row) => row.reason.length >= 20)).toBe(true);
  });

  it("double-encodes repository_name in the operations path template", () => {
    const getRepo = OPERATIONS.find(
      (row) => row.tool === "harbor_repositories" && row.action === "get",
    );
    expect(getRepo?.path).toContain("{repository_name}");
    expect(getRepo?.pathParams).toContain("repository_name");
  });

  it("matches generator --check from the committed inventory", () => {
    const result = spawnSync(process.execPath, ["scripts/gen-operations.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(`${String(OPERATIONS.length)} mapped routes`);
    expect(result.stderr).toContain(`${String(EXCLUSIONS.length)} excluded routes`);
    expect(result.stderr).toContain("registry actions for inventoried HTTP operations");
  });

  it("does not hardcode an absolute workspace path in scripts, tests, or src", () => {
    const banned = ["/work", "space"].join("");
    const files = [
      ...walkSources(join(repoRoot, "scripts")),
      ...walkSources(join(repoRoot, "src")),
      ...walkSources(join(repoRoot, "test")),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(readFileSync(file, "utf8").includes(banned), file).toBe(false);
    }
  });
});
