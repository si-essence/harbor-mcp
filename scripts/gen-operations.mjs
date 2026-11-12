#!/usr/bin/env node
/**
 * Generate harbor.routes.json and src/operations.ts from spec/api-inventory.json.
 * Inventory is extracted from goharbor/harbor v2.16.0 api/v2.0/swagger.yaml.
 * Default runs read only the committed inventory.
 *
 *   node scripts/gen-operations.mjs --source-root /path/to/harbor --write-inventory
 *   node scripts/gen-operations.mjs --check
 *   node scripts/gen-operations.mjs --source-root /path/to/harbor --check
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "spec", "api-inventory.json");
const routesPath = join(root, "harbor.routes.json");
const outPath = join(root, "src", "operations.ts");
const PINNED_VERSION = "2.16.0";
const PINNED_LICENSE = "Apache-2.0";
const BASE = "/api/v2.0";

const WRITE_GATE =
  "Requires confirm true and HARBOR_ALLOW_WRITES=true. Otherwise this is a dry-run preview and no HTTP write is sent.";

const PAGE = [
  { name: "page", required: false, type: "integer" },
  { name: "page_size", required: false, type: "integer" },
];
const DOC = [{ name: "document", type: "object", required: true }];
const DOC_OPT = [{ name: "document", type: "object", required: false }];

function r(tool, action, summary, extra = {}) {
  return { tool, action, write: false, destructive: false, summary, ...extra };
}
function w(tool, action, summary, extra = {}) {
  const destructive = extra.destructive === true;
  const warning = extra.warning ?? `${summary} ${WRITE_GATE}`;
  return { tool, action, write: true, destructive, summary, warning, ...extra };
}

/** @type {Record<string, object>} */
const MAP = {
  [`GET ${BASE}/health`]: r("harbor_system", "health", "Health of Harbor components."),
  [`GET ${BASE}/ping`]: r("harbor_system", "ping", "Liveness ping."),
  [`GET ${BASE}/search`]: r("harbor_system", "search", "Search projects and repositories.", {
    query: [{ name: "q", required: true }],
  }),
  [`GET ${BASE}/statistics`]: r(
    "harbor_system",
    "statistics",
    "Project and repository statistics.",
  ),
  [`GET ${BASE}/systeminfo`]: r("harbor_system", "systeminfo", "Public system information."),
  [`GET ${BASE}/systeminfo/volumes`]: r("harbor_system", "volumes", "System volume capacity."),
  [`GET ${BASE}/users/current`]: r("harbor_system", "current_user", "Authenticated user profile."),
  [`GET ${BASE}/users/current/permissions`]: r(
    "harbor_system",
    "current_permissions",
    "Permissions of the authenticated user.",
    {
      query: [
        { name: "scope", required: false },
        { name: "relative", required: false, type: "boolean" },
      ],
    },
  ),
  [`GET ${BASE}/projects`]: r("harbor_projects", "list", "List projects visible to the user.", {
    query: [
      ...PAGE,
      { name: "name", required: false },
      { name: "public", required: false, type: "boolean" },
      { name: "owner", required: false },
      { name: "with_detail", required: false, type: "boolean" },
    ],
  }),
  [`POST ${BASE}/projects`]: w("harbor_projects", "create", "Create a project.", { body: DOC }),
  [`GET ${BASE}/projects/{project_name_or_id}`]: r("harbor_projects", "get", "Get one project."),
  [`PUT ${BASE}/projects/{project_name_or_id}`]: w(
    "harbor_projects",
    "update",
    "Update a project.",
    {
      body: DOC,
    },
  ),
  [`DELETE ${BASE}/projects/{project_name_or_id}`]: w(
    "harbor_projects",
    "delete",
    "Delete a project and its repositories.",
    { destructive: true },
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/_deletable`]: r(
    "harbor_projects",
    "deletable",
    "Whether the project can be deleted.",
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/summary`]: r(
    "harbor_projects",
    "summary",
    "Project summary including repo counts and quotas.",
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/members`]: r(
    "harbor_projects",
    "members_list",
    "List project members.",
    { query: [...PAGE, { name: "entityname", required: false }] },
  ),
  [`POST ${BASE}/projects/{project_name_or_id}/members`]: w(
    "harbor_projects",
    "members_add",
    "Add a project member.",
    { body: DOC },
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/members/{mid}`]: r(
    "harbor_projects",
    "member_get",
    "Get one project member.",
  ),
  [`PUT ${BASE}/projects/{project_name_or_id}/members/{mid}`]: w(
    "harbor_projects",
    "member_update",
    "Update a project member role.",
    { body: DOC },
  ),
  [`DELETE ${BASE}/projects/{project_name_or_id}/members/{mid}`]: w(
    "harbor_projects",
    "member_remove",
    "Remove a project member.",
    { destructive: true },
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/metadatas/`]: r(
    "harbor_projects",
    "metadata_list",
    "List project metadata.",
  ),
  [`POST ${BASE}/projects/{project_name_or_id}/metadatas/`]: w(
    "harbor_projects",
    "metadata_add",
    "Add project metadata.",
    { body: DOC },
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/metadatas/{meta_name}`]: r(
    "harbor_projects",
    "metadata_get",
    "Get one project metadata entry.",
  ),
  [`PUT ${BASE}/projects/{project_name_or_id}/metadatas/{meta_name}`]: w(
    "harbor_projects",
    "metadata_update",
    "Update one project metadata entry.",
    { body: DOC },
  ),
  [`DELETE ${BASE}/projects/{project_name_or_id}/metadatas/{meta_name}`]: w(
    "harbor_projects",
    "metadata_delete",
    "Delete one project metadata entry.",
    { destructive: true },
  ),
  [`GET ${BASE}/repositories`]: r(
    "harbor_repositories",
    "list_all",
    "List repositories across projects.",
    {
      query: [...PAGE, { name: "q", required: false }],
    },
  ),
  [`GET ${BASE}/projects/{project_name}/repositories`]: r(
    "harbor_repositories",
    "list",
    "List repositories in a project.",
    { query: [...PAGE, { name: "q", required: false }] },
  ),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}`]: r(
    "harbor_repositories",
    "get",
    "Get one repository. repository_name is double-URL-encoded.",
  ),
  [`PUT ${BASE}/projects/{project_name}/repositories/{repository_name}`]: w(
    "harbor_repositories",
    "update",
    "Update repository description.",
    { body: DOC },
  ),
  [`DELETE ${BASE}/projects/{project_name}/repositories/{repository_name}`]: w(
    "harbor_repositories",
    "delete",
    "Delete a repository and its artifacts.",
    { destructive: true },
  ),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts`]: r(
    "harbor_artifacts",
    "list",
    "List artifacts in a repository.",
    {
      query: [
        ...PAGE,
        { name: "q", required: false },
        { name: "with_tag", required: false, type: "boolean" },
        { name: "with_label", required: false, type: "boolean" },
        { name: "with_scan_overview", required: false, type: "boolean" },
      ],
    },
  ),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}`]: r(
    "harbor_artifacts",
    "get",
    "Get one artifact by digest or tag.",
    {
      query: [
        { name: "with_tag", required: false, type: "boolean" },
        { name: "with_label", required: false, type: "boolean" },
      ],
    },
  ),
  [`DELETE ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}`]:
    w("harbor_artifacts", "delete", "Delete an artifact.", { destructive: true }),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/tags`]:
    r("harbor_artifacts", "tags_list", "List tags on an artifact.", { query: PAGE }),
  [`POST ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/tags`]:
    w("harbor_artifacts", "tag_create", "Create a tag on an artifact.", {
      body: [{ name: "name", type: "string", required: true }],
    }),
  [`DELETE ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/tags/{tag_name}`]:
    w("harbor_artifacts", "tag_delete", "Delete a tag from an artifact.", { destructive: true }),
  [`POST ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/labels`]:
    w("harbor_artifacts", "label_add", "Attach a label to an artifact.", { body: DOC }),
  [`DELETE ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/labels/{label_id}`]:
    w("harbor_artifacts", "label_remove", "Detach a label from an artifact.", {
      destructive: true,
    }),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/additions/vulnerabilities`]:
    r("harbor_artifacts", "vulns", "Read the vulnerability addition for an artifact."),
  [`POST ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/scan`]:
    w("harbor_artifacts", "scan", "Trigger a vulnerability scan on an artifact."),
  [`GET ${BASE}/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}/accessories`]:
    r("harbor_artifacts", "accessories", "List accessory artifacts such as signatures."),
  [`GET ${BASE}/robots`]: r("harbor_robots", "list", "List robot accounts.", {
    query: [...PAGE, { name: "q", required: false }],
  }),
  [`POST ${BASE}/robots`]: w(
    "harbor_robots",
    "create",
    "Create a robot account. secret is shown once.",
    {
      body: DOC,
      reveal: true,
    },
  ),
  [`GET ${BASE}/robots/{robot_id}`]: r("harbor_robots", "get", "Get one robot account."),
  [`PUT ${BASE}/robots/{robot_id}`]: w("harbor_robots", "update", "Update a robot account.", {
    body: DOC,
  }),
  [`PATCH ${BASE}/robots/{robot_id}`]: w(
    "harbor_robots",
    "refresh_secret",
    "Refresh a robot secret. The new secret is shown once.",
    { body: DOC_OPT, reveal: true, destructive: true },
  ),
  [`DELETE ${BASE}/robots/{robot_id}`]: w("harbor_robots", "delete", "Delete a robot account.", {
    destructive: true,
  }),
  [`GET ${BASE}/quotas`]: r("harbor_admin", "quotas_list", "List project quotas.", { query: PAGE }),
  [`GET ${BASE}/quotas/{id}`]: r("harbor_admin", "quota_get", "Get one quota."),
  [`GET ${BASE}/labels`]: r("harbor_admin", "labels_list", "List labels.", {
    query: [...PAGE, { name: "name", required: false }, { name: "scope", required: false }],
  }),
  [`POST ${BASE}/labels`]: w("harbor_admin", "label_create", "Create a label.", { body: DOC }),
  [`GET ${BASE}/labels/{label_id}`]: r("harbor_admin", "label_get", "Get one label."),
  [`PUT ${BASE}/labels/{label_id}`]: w("harbor_admin", "label_update", "Update a label.", {
    body: DOC,
  }),
  [`DELETE ${BASE}/labels/{label_id}`]: w("harbor_admin", "label_delete", "Delete a label.", {
    destructive: true,
  }),
  [`GET ${BASE}/system/gc/schedule`]: r(
    "harbor_admin",
    "gc_schedule",
    "Read the garbage collection schedule.",
  ),
  [`GET ${BASE}/system/gc`]: r("harbor_admin", "gc_history", "Garbage collection job history.", {
    query: PAGE,
  }),
  [`POST ${BASE}/system/gc/schedule`]: w(
    "harbor_admin",
    "gc_schedule_create",
    "Create or run a garbage collection schedule.",
    { body: DOC, destructive: true },
  ),
  [`PUT ${BASE}/system/gc/schedule`]: w(
    "harbor_admin",
    "gc_schedule_update",
    "Update the garbage collection schedule.",
    { body: DOC, destructive: true },
  ),
  [`GET ${BASE}/retentions/metadatas`]: r(
    "harbor_admin",
    "retention_metadata",
    "Retention policy metadata (supported algorithms and tags).",
  ),
  [`GET ${BASE}/retentions/{id}`]: r("harbor_admin", "retention_get", "Get a retention policy."),
  [`GET ${BASE}/projects/{project_name_or_id}/webhook/policies`]: r(
    "harbor_admin",
    "webhook_list",
    "List webhook policies for a project.",
    { query: PAGE },
  ),
  [`GET ${BASE}/projects/{project_name_or_id}/webhook/events`]: r(
    "harbor_admin",
    "webhook_events",
    "Supported webhook event types.",
  ),
};

function excludeReason(method, path) {
  if (method === "HEAD") {
    return "HEAD probes are excluded. JSON GET/POST coverage is mapped instead.";
  }
  const rules = [
    ["/ldap/", "LDAP administration is excluded from the management toolset."],
    ["/internalconfig", "Internal config dump is excluded. It is not a user management call."],
    [
      "/configurations",
      "System configuration get/update is excluded. It exposes and writes instance secrets.",
    ],
    ["/p2p/", "P2P preheat instance administration is excluded."],
    ["/preheat/", "Project P2P preheat policies and executions are excluded."],
    ["/immutabletagrules", "Immutable tag rule administration is excluded from lean coverage."],
    [
      "/webhook/",
      "Webhook policy writes, executions, jobs, and logs are excluded. List and events are mapped.",
    ],
    ["/usergroups", "User group administration is excluded."],
    ["/icons/", "Raw icon binary endpoints are excluded."],
    ["/roles", "RBAC role catalog administration is excluded."],
    [
      "/replication/",
      "Replication policies and executions are excluded. They involve remote registries.",
    ],
    ["/registries", "Replication registry credentials are excluded."],
    ["/scans/all/", "Scan-all metrics are excluded. Per-artifact scan is mapped."],
    ["/scans/schedule/", "Scheduled scan-all metrics are excluded."],
    ["/systeminfo/getcert", "Raw certificate download is excluded. systeminfo JSON is mapped."],
    ["/system/oidc/", "OIDC ping and identity-provider administration are excluded."],
    [
      "/system/gc/",
      "Per-job GC stop and log endpoints are excluded. Schedule and history are mapped.",
    ],
    ["/system/purgeaudit", "Audit log purge jobs are excluded from lean coverage."],
    ["/system/CVEAllowlist", "System CVE allowlist administration is excluded."],
    [
      "/system/scanAll/",
      "Instance-wide scan-all schedule and stop are excluded. Per-artifact scan is mapped.",
    ],
    ["/jobservice/", "Jobservice worker, queue, and job-stop administration is excluded."],
    ["/schedules", "Global job schedule pause catalog is excluded. GC schedule is mapped."],
    [
      "/retentions",
      "Retention policy writes and executions are excluded. Metadata and get are mapped.",
    ],
    ["/scanners", "Scanner registration, including credentials, is excluded."],
    [
      "/users",
      "User directory, password, CLI secret, and sysadmin writes are excluded. current user is mapped.",
    ],
    ["/export/cve", "CVE export jobs and binary downloads are excluded."],
    [
      "/security/",
      "Security hub summary and vulnerability search are excluded from lean coverage.",
    ],
    ["/permissions", "The permissions catalog is excluded. current_permissions is mapped."],
    ["/audit-logs", "Instance audit log listing is excluded from lean coverage."],
    ["/auditlog-exts", "Extended audit log listing is excluded from lean coverage."],
    ["/logs", "Project audit logs are excluded from lean coverage."],
    [
      "/scanner",
      "Per-project scanner assignment is excluded. Scanner registration is also excluded.",
    ],
    [
      "/artifacts",
      "Copy-artifact, scan-stop, report logs, and generic additions are excluded. Core artifact calls are mapped.",
    ],
    ["/quotas/", "Quota writes are excluded. Quota list and get are mapped."],
  ];
  for (const [needle, reason] of rules) {
    if (path.includes(needle)) return reason;
  }
  return undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function extractSwaggerRoutes(source) {
  const start = source.indexOf("\npaths:");
  if (start === -1 && !source.startsWith("paths:")) {
    throw new Error("paths: not found in swagger.yaml");
  }
  const body = start === -1 ? source : source.slice(start + 1);
  const routes = [];
  const seen = new Set();
  let currentPath;
  let currentMethod;
  let operationId;
  const flush = () => {
    if (currentPath === undefined || currentMethod === undefined) return;
    const path = `${BASE}${currentPath}`;
    const id = operationId ?? `${currentMethod} ${path}`;
    const key = `${currentMethod} ${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      routes.push({
        method: currentMethod,
        path,
        operationId: id,
        sourceFile: "api/v2.0/swagger.yaml",
      });
    }
    currentMethod = undefined;
    operationId = undefined;
  };
  for (const raw of body.split("\n")) {
    if (raw.length > 0 && !raw.startsWith(" ") && !raw.startsWith("paths:")) {
      flush();
      break;
    }
    const pathMatch = /^  ['"]?(\/[^:'"]*)['"]?:$/.exec(raw);
    if (pathMatch !== null) {
      flush();
      currentPath = pathMatch[1];
      currentMethod = undefined;
      operationId = undefined;
      continue;
    }
    const methodMatch = /^    (get|post|put|patch|delete|head|options):$/.exec(raw);
    if (methodMatch !== null) {
      flush();
      currentMethod = methodMatch[1].toUpperCase();
      operationId = undefined;
      continue;
    }
    const opMatch = /^      operationId:\s*(\S+)\s*$/.exec(raw);
    if (opMatch !== null && currentMethod !== undefined) {
      operationId = opMatch[1];
    }
  }
  flush();
  routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  if (routes.length < 150) {
    throw new Error(`Expected Harbor swagger paths, found ${String(routes.length)}`);
  }
  return routes;
}

export function routeTreeSha256(files, routes) {
  const lines = [
    ...files.map((file) => `${file.path} ${file.sha256}`),
    ...routes.map((route) => `${route.method} ${route.path} ${route.operationId}`),
  ];
  return sha256(`${lines.join("\n")}\n`);
}

export function extractInventory(sourceRoot) {
  const swaggerPath = join(sourceRoot, "api/v2.0/swagger.yaml");
  const licensePath = join(sourceRoot, "LICENSE");
  const swagger = readFileSync(swaggerPath);
  const license = readFileSync(licensePath, "utf8");
  if (!license.includes("Apache License") || !license.includes("Version 2.0")) {
    throw new Error("Expected Apache License Version 2.0 in LICENSE");
  }
  const routes = extractSwaggerRoutes(swagger.toString("utf8"));
  const files = [{ path: "api/v2.0/swagger.yaml", sha256: sha256(swagger) }];
  return {
    project: "goharbor/harbor",
    version: PINNED_VERSION,
    license: PINNED_LICENSE,
    root: "api/v2.0/swagger.yaml",
    sourceSha256: sha256(swagger),
    routeTreeSha256: routeTreeSha256(files, routes),
    extractor:
      "scripts/gen-operations.mjs walks swagger 2.0 paths and HTTP methods in api/v2.0/swagger.yaml",
    files,
    routes,
  };
}

function assertInventory(inventory) {
  if (inventory.version !== PINNED_VERSION) {
    throw new Error(`spec version ${String(inventory.version)} is not ${PINNED_VERSION}`);
  }
  if (inventory.license !== PINNED_LICENSE) {
    throw new Error("spec license must be Apache-2.0");
  }
  if (!/^[a-f0-9]{64}$/.test(inventory.routeTreeSha256)) {
    throw new Error("spec routeTreeSha256 is missing");
  }
  if (!/^[a-f0-9]{64}$/.test(inventory.sourceSha256)) {
    throw new Error("spec sourceSha256 is missing");
  }
  if (!Array.isArray(inventory.files) || inventory.files.length < 1) {
    throw new Error("spec file list is too small");
  }
  if (!Array.isArray(inventory.routes) || inventory.routes.length < 150) {
    throw new Error(
      `spec route list must cover v2.16.0 /api/v2.0 operations, found ${String(inventory.routes?.length)}`,
    );
  }
  const expected = routeTreeSha256(inventory.files, inventory.routes);
  if (expected !== inventory.routeTreeSha256) {
    throw new Error("routeTreeSha256 does not match the committed files and routes");
  }
  return inventory;
}

export function loadInventory() {
  return assertInventory(JSON.parse(readFileSync(specPath, "utf8")));
}

function pathParamsOf(path) {
  const names = [];
  const re = /\{([^}]+)\}/g;
  let match;
  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

function fieldType(field, fallback = "string") {
  return field.type ?? fallback;
}

function buildRow(operation, mapped) {
  const pathParams = pathParamsOf(operation.path);
  const query = mapped.query ?? [];
  const body = mapped.body ?? [];
  const fields = [
    ...pathParams.map((name) => ({
      name,
      type: "string",
      required: true,
      in: "path",
    })),
    ...query.map((field) => ({
      name: field.name,
      type: fieldType(field),
      required: field.required,
      in: "query",
    })),
  ];
  return {
    method: operation.method,
    path: operation.path,
    tool: mapped.tool,
    action: mapped.action,
    routeId: operation.operationId,
    operationId: operation.operationId,
    write: mapped.write,
    destructive: mapped.destructive,
    kind: mapped.kind ?? "json",
    reveal: mapped.reveal === true,
    summary: mapped.summary,
    pathParams,
    queryParams: query.map((field) => field.name),
    fields,
    bodyFields: body.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
    })),
    headerFields: [],
    warnings: mapped.warning === undefined ? [] : [mapped.warning],
  };
}

function planOperations(operations) {
  for (const key of Object.keys(MAP)) {
    if (!operations.some((item) => `${item.method} ${item.path}` === key)) {
      throw new Error(`Mapped route is not in the extracted inventory: ${key}`);
    }
  }
  const rows = [];
  const exclusions = [];
  const pairs = new Set();
  const missing = [];
  for (const operation of operations) {
    const key = `${operation.method} ${operation.path}`;
    const mapped = MAP[key];
    if (mapped !== undefined) {
      const pair = `${mapped.tool}:${mapped.action}`;
      if (pairs.has(pair)) throw new Error(`Duplicate tool action ${pair}`);
      pairs.add(pair);
      rows.push(buildRow(operation, mapped));
      continue;
    }
    const reason = excludeReason(operation.method, operation.path);
    if (reason === undefined) {
      missing.push(key);
      continue;
    }
    if (reason.length < 20) throw new Error(`Exclusion reason too short for ${key}`);
    exclusions.push({
      method: operation.method,
      path: operation.path,
      routeId: operation.operationId,
      operationId: operation.operationId,
      reason,
    });
  }
  if (missing.length > 0) {
    throw new Error(`Unmapped Harbor operations (map or exclude each): ${missing.join(", ")}`);
  }
  return { rows, exclusions };
}

function tsString(value) {
  return JSON.stringify(value);
}

function emitObjectList(items, indent) {
  if (items.length === 0) return "[]";
  if (items.length === 1) return `[${items[0]}]`;
  const inner = indent + "  ";
  return `[\n${items.map((item) => `${inner}${item}`).join(",\n")},\n${indent}]`;
}

function emitFields(fields, withIn, indent) {
  const items = fields.map((field) => {
    const loc = withIn && field.in !== undefined ? `, in: ${tsString(field.in)}` : "";
    return `{ name: ${tsString(field.name)}, type: ${tsString(field.type)}, required: ${field.required}${loc} }`;
  });
  return emitObjectList(items, indent);
}

function emitRow(row) {
  const warningItems = row.warnings.map((item) => tsString(item));
  const oneLineWarnings = `[${warningItems.join(", ")}]`;
  const warnings =
    warningItems.length === 0
      ? "[]"
      : oneLineWarnings.length <= 80
        ? oneLineWarnings
        : `[\n      ${warningItems.join(",\n      ")},\n    ]`;
  return `  row(${tsString(row.method)}, ${tsString(row.path)}, ${tsString(row.tool)}, {
    action: ${tsString(row.action)},
    routeId: ${tsString(row.routeId)},
    operationId: ${tsString(row.operationId)},
    write: ${row.write},
    destructive: ${row.destructive},
    kind: ${tsString(row.kind)},
    reveal: ${row.reveal},
    summary: ${tsString(row.summary)},
    pathParams: [${row.pathParams.map((name) => tsString(name)).join(", ")}],
    queryParams: [${row.queryParams.map((name) => tsString(name)).join(", ")}],
    fields: ${emitFields(row.fields, true, "    ")},
    bodyFields: ${emitFields(row.bodyFields, false, "    ")},
    headerFields: ${emitFields(row.headerFields, false, "    ")},
    warnings: ${warnings},
  })`;
}

function emitExclusions(exclusions) {
  if (exclusions.length === 0) return "";
  return exclusions
    .map(
      (row) => `  {
    method: ${tsString(row.method)},
    path: ${tsString(row.path)},
    routeId: ${tsString(row.routeId)},
    operationId: ${tsString(row.operationId)},
    reason:
      ${tsString(row.reason)},
  }`,
    )
    .join(",\n");
}

function emitOperations(rows, exclusions) {
  return `/** Generated by scripts/gen-operations.mjs from goharbor/harbor v2.16.0 api/v2.0/swagger.yaml. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type ResponseKind = "json" | "empty" | "text";

export interface FieldSchema {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly in?: "path" | "query";
}

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly routeId: string;
  readonly tool: string;
  readonly action: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly kind: ResponseKind;
  readonly reveal: boolean;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly fields: readonly FieldSchema[];
  readonly bodyFields: readonly FieldSchema[];
  readonly headerFields: readonly FieldSchema[];
  readonly warnings: readonly string[];
}

export interface ExcludedOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly routeId: string;
  readonly operationId: string;
  readonly reason: string;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    routeId: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    kind: ResponseKind;
    reveal: boolean;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    fields: readonly FieldSchema[];
    bodyFields: readonly FieldSchema[];
    headerFields: readonly FieldSchema[];
    warnings: readonly string[];
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    routeId: options.routeId,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    kind: options.kind,
    reveal: options.reveal,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    fields: options.fields,
    bodyFields: options.bodyFields,
    headerFields: options.headerFields,
    warnings: options.warnings,
  };
}

export const SOURCE_VERSION = ${tsString(PINNED_VERSION)};

export const OPERATIONS: readonly Operation[] = [
${rows.map((row) => emitRow(row)).join(",\n")},
];

export const EXCLUSIONS: readonly ExcludedOperation[] = [${exclusions.length === 0 ? "" : `\n${emitExclusions(exclusions)}\n`}];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find(
    (operation) => operation.tool === tool && operation.action === action,
  );
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Harbor operation \${tool} \${action}.\`);
  }
  return found;
}
`;
}

function catalog(inventory, plan) {
  return {
    source: {
      project: inventory.project,
      version: inventory.version,
      license: inventory.license,
      root: inventory.root,
      sourceSha256: inventory.sourceSha256,
      routeTreeSha256: inventory.routeTreeSha256,
      files: inventory.files,
    },
    operations: inventory.routes.map((operation) => {
      const row = plan.rows.find((item) => item.routeId === operation.operationId);
      const excluded = plan.exclusions.find((item) => item.operationId === operation.operationId);
      if (row !== undefined) {
        return {
          method: operation.method,
          path: operation.path,
          operationId: operation.operationId,
          sourceFile: operation.sourceFile,
          exclude: false,
          tool: row.tool,
          action: row.action,
          write: row.write,
          destructive: row.destructive,
          summary: row.summary,
        };
      }
      if (excluded !== undefined) {
        return {
          method: operation.method,
          path: operation.path,
          operationId: operation.operationId,
          sourceFile: operation.sourceFile,
          exclude: true,
          reason: excluded.reason,
        };
      }
      throw new Error(`Missing plan for ${operation.operationId}`);
    }),
  };
}

function readFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function main() {
  const writeInventory = process.argv.includes("--write-inventory");
  const check = process.argv.includes("--check");
  const sourceRoot =
    readFlag("--source-root") ?? (check ? undefined : process.env["HARBOR_SOURCE_ROOT"]);
  let inventory;
  if (sourceRoot !== undefined && sourceRoot.length > 0) {
    const extracted = extractInventory(sourceRoot);
    if (writeInventory) {
      mkdirSync(join(root, "spec"), { recursive: true });
      writeFileSync(specPath, `${JSON.stringify(extracted, null, 2)}\n`);
      inventory = extracted;
    } else {
      inventory = loadInventory();
      if (inventory.routeTreeSha256 !== extracted.routeTreeSha256) {
        throw new Error(
          "Extracted route tree does not match spec/api-inventory.json. Review the diff, then re-run with --write-inventory.",
        );
      }
    }
  } else {
    inventory = loadInventory();
  }

  const plan = planOperations(inventory.routes);
  const operationsText = emitOperations(plan.rows, plan.exclusions);
  const catalogJson = `${JSON.stringify(catalog(inventory, plan), null, 2)}\n`;

  const summary = `${plan.rows.length} mapped routes, ${plan.exclusions.length} excluded routes, ${plan.rows.length} registry actions for inventoried HTTP operations\n`;
  if (check) {
    const currentOps = readFileSync(outPath, "utf8");
    const currentRoutes = readFileSync(routesPath, "utf8");
    if (currentOps !== operationsText || currentRoutes !== catalogJson) {
      throw new Error(
        "Generated operations are stale. Run node scripts/gen-operations.mjs and commit the result.",
      );
    }
    process.stderr.write(summary);
    return;
  }

  writeFileSync(outPath, operationsText);
  writeFileSync(routesPath, catalogJson);
  process.stderr.write(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "generator failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
