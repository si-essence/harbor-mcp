#!/usr/bin/env node
/**
 * Live check against an isolated local Harbor v2.16.0 core on loopback.
 * Spawns dist/index.js over stdio. Reads HARBOR_PASSWORD or
 * HARBOR_PASSWORD_FILE. Unsets DATABASE_URL. Does not print secrets.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

delete process.env["DATABASE_URL"];

const root = fileURLToPath(new URL("..", import.meta.url));
const passwordFile = process.env["HARBOR_PASSWORD_FILE"] ?? "";
const username = process.env["HARBOR_USERNAME"] ?? "admin";
const PROJECT = process.env["HARBOR_LIVE_PROJECT"] ?? "mcpchk";
const DENY = "mcpdeny";
const LABEL = "mcp-live-label";
const ROBOT = "mcp-live-robot";
const REPO = "team/app";
const TAG = "live";
const PREVIEW_TAG = "mcppreview";
const BLOCKED_TAG = "mcpblocked";
const EXTRA_TAG = "mcpextra";
const PREVIEW_DESC = "preview-desc";
const BLOCKED_DESC = "blocked-desc";
const LIVE_DESC = "live-desc";
const toolsDir = process.env["HARBOR_TOOLS_DIR"] ?? "";
const CRANE =
  process.env["HARBOR_CRANE"] ?? (toolsDir.length > 0 ? `${toolsDir}/bin/crane` : "crane");

function readPassword() {
  const fromEnv = process.env["HARBOR_PASSWORD"] ?? "";
  if (fromEnv.trim().length > 0) return fromEnv.trim();
  if (passwordFile.length === 0) return "";
  try {
    return readFileSync(passwordFile, "utf8").trim();
  } catch {
    return "";
  }
}

const password = readPassword();
const baseUrl = process.env["HARBOR_URL"] ?? "http://127.0.0.1:18080";

/** @type {string[]} */
const secrets = [];
if (password.length >= 8) {
  secrets.push(password);
  secrets.push(Buffer.from(`${username}:${password}`, "utf8").toString("base64"));
}

/** @type {string[]} */
const stderrChunks = [];

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*)\S+/gi, "$1[redacted]");
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 220) shortened = `${shortened.slice(0, 217)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
let passed = 0;
/** @type {string[]} */
const rows = [];
/** @type {string[]} */
const realStatuses = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return (
    value !== null &&
    typeof value !== "undefined" &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * @param {string} text
 */
function assertNoSecret(text) {
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
/**
 * @param {unknown} json
 */
function asItems(json) {
  if (!isRecord(json)) return [];
  const items = json["items"];
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

/**
 * @param {Record<string, unknown> | null} json
 */
function descriptionOf(json) {
  if (!isRecord(json)) return "";
  const nested = isRecord(json["result"]) ? json["result"] : json;
  return String(nested["description"] ?? "");
}

/**
 * @param {Record<string, unknown> | null} json
 */
function labelIdsOf(json) {
  if (!isRecord(json)) return [];
  const nested = isRecord(json["result"]) ? json["result"] : json;
  const labels = nested["labels"];
  if (!Array.isArray(labels)) return [];
  return labels.filter(isRecord).map((item) => String(item["id"] ?? ""));
}

/**
 * Push a one-file OCI image through core /v2. Docker config is 0600 under /tmp and removed after.
 * @returns {{ code: number, detail: string }}
 */
function pushImage() {
  const dock = mkdtempSync("/tmp/harbor-mcp-dock-");
  const layer = mkdtempSync("/tmp/harbor-mcp-layer-");
  chmodSync(dock, 0o700);
  chmodSync(layer, 0o700);
  try {
    writeFileSync(`${layer}/hello.txt`, "mcp-live\n", { mode: 0o600 });
    execFileSync("tar", ["-cf", `${layer}/layer.tar`, "-C", layer, "hello.txt"]);
    const host = new URL(baseUrl).host;
    const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    writeFileSync(
      `${dock}/config.json`,
      JSON.stringify({ auths: { [host]: { auth: basic } } }),
      { mode: 0o600 },
    );
    const env = { ...process.env, DOCKER_CONFIG: dock };
    delete env["DATABASE_URL"];
    const stdout = execFileSync(
      CRANE,
      [
        "append",
        "--insecure",
        "--oci-empty-base",
        "-f",
        `${layer}/layer.tar`,
        "-t",
        `${host}/${PROJECT}/${REPO}:${TAG}`,
      ],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, detail: stdout };
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error ? String(error.stdout ?? "") : "";
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, detail: `${message}\n${stdout}\n${stderr}` };
  } finally {
    rmSync(dock, { recursive: true, force: true });
    rmSync(layer, { recursive: true, force: true });
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {string} [authUser]
 * @param {string} [authPassword]
 */
async function harborFetch(path, init = {}, authUser = username, authPassword = password) {
  const url = `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (!headers.has("authorization")) {
    const basic = Buffer.from(`${authUser}:${authPassword}`, "utf8").toString("base64");
    headers.set("authorization", `Basic ${basic}`);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
  });
  const text = await response.text();
  assertNoSecret(text);
  return { status: response.status, text };
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
    assertNoSecret(text);
    /** @type {Record<string, unknown> | null} */
    let json = null;
    try {
      const parsed = JSON.parse(text);
      json = isRecord(parsed) ? parsed : null;
    } catch {
      json = null;
    }
    return { isError: result.isError === true, text, json };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assertNoSecret(text);
    return { isError: true, text, json: null };
  }
}

/**
 * @param {Record<string, string | undefined>} extra
 */
function childEnv(extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "DATABASE_URL") continue;
    if (
      key === "HARBOR_PASSWORD" ||
      key === "HARBOR_URL" ||
      key === "HARBOR_ALLOW_WRITES" ||
      key === "HARBOR_USERNAME"
    ) {
      continue;
    }
    env[key] = value;
  }
  delete env["DATABASE_URL"];
  env["HARBOR_URL"] = baseUrl;
  env["HARBOR_USERNAME"] = username;
  env["HARBOR_PASSWORD"] = password;
  env["HARBOR_CACHE_TTL_SEC"] = "0";
  env["HARBOR_PER_MINUTE"] = "600";
  env["HARBOR_ALLOW_WRITES"] = "true";
  env["HARBOR_TIMEOUT_MS"] = "30000";
  env["MCP_TRANSPORT"] = "stdio";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * @param {Record<string, string | undefined>} extra
 * @param {(client: import("@modelcontextprotocol/sdk/client/index.js").Client) => Promise<void>} run
 */
async function withServer(extra, run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv(extra),
    stderr: "pipe",
  });
  const client = new Client({ name: "harbor-live-check", version: "0" });
  const childErr = transport.stderr;
  if (childErr !== null && typeof childErr.on === "function") {
    childErr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
  }
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

/**
 * @param {unknown} payload
 */
function nestedResult(payload) {
  if (!isRecord(payload)) return {};
  return isRecord(payload["result"]) ? payload["result"] : payload;
}

async function main() {
  if (baseUrl.trim().length === 0) {
    writeError("FAIL  live-check  Set HARBOR_URL.");
    process.exit(1);
  }
  if (password.length === 0) {
    writeError(
      "FAIL  live-check  Set HARBOR_PASSWORD or HARBOR_PASSWORD_FILE. No password is printed.",
    );
    process.exit(1);
  }

  await withServer({ HARBOR_ALLOW_WRITES: "true" }, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    record(
      "tool list",
      names.join(",") ===
        "harbor_admin,harbor_artifacts,harbor_projects,harbor_repositories,harbor_robots,harbor_system",
      `tools=${names.join(",")}`,
    );

    const ping = await call(client, "harbor_system", { action: "ping" });
    record("ping", ping.isError === false, clip(ping.text));

    const health = await call(client, "harbor_system", { action: "health" });
    const healthText = JSON.stringify(health.json ?? health.text);
    record("health", health.isError === false && healthText.includes("core"), clip(health.text));

    const info = await call(client, "harbor_system", { action: "systeminfo" });
    record("systeminfo", info.isError === false, clip(info.text));

    const me = await call(client, "harbor_system", { action: "current_user" });
    record(
      "current_user",
      me.isError === false && JSON.stringify(me.json ?? {}).includes("admin"),
      clip(me.text),
    );

    const stats = await call(client, "harbor_system", { action: "statistics" });
    record("statistics", stats.isError === false, clip(stats.text));

    const search = await call(client, "harbor_system", { action: "search", q: "library" });
    record("search", search.isError === false, clip(search.text));

    const list = await call(client, "harbor_projects", { action: "list" });
    record("projects list", list.isError === false, clip(list.text));

    const missing = await call(client, "harbor_projects", {
      action: "get",
      project_name_or_id: "no-such-mcp-project",
    });
    record(
      "missing project",
      missing.isError === true && missing.text.includes("404"),
      clip(missing.text),
    );
    const missingHttp = await harborFetch("api/v2.0/projects/no-such-mcp-project");
    realStatuses.push(`get-missing-project HTTP ${String(missingHttp.status)}`);

    const preview = await call(client, "harbor_projects", {
      action: "create",
      document: { project_name: PROJECT, metadata: { public: "true" } },
    });
    const afterPreview = await harborFetch(`api/v2.0/projects/${PROJECT}`);
    realStatuses.push(`get-after-create-preview HTTP ${String(afterPreview.status)}`);
    record(
      "create project preview",
      preview.isError === false &&
        preview.json?.["executed"] === false &&
        preview.json?.["dry_run"] === true &&
        preview.json?.["method"] === "POST" &&
        afterPreview.status === 404,
      `followup_status=${String(afterPreview.status)} ${clip(preview.text)}`,
    );
  });

  await withServer({ HARBOR_ALLOW_WRITES: "false" }, async (client) => {
    const blocked = await call(client, "harbor_projects", {
      action: "create",
      document: { project_name: PROJECT, metadata: { public: "true" } },
      confirm: true,
    });
    const afterBlocked = await harborFetch(`api/v2.0/projects/${PROJECT}`);
    realStatuses.push(`get-after-create-blocked HTTP ${String(afterBlocked.status)}`);
    record(
      "create project blocked",
      blocked.isError === false &&
        blocked.json?.["blocked"] === true &&
        blocked.json?.["executed"] === false &&
        afterBlocked.status === 404,
      clip(blocked.text),
    );
  });

  /** @type {string} */
  let digest = "";
  /** @type {string} */
  let labelId = "";
  /** @type {string} */
  let baselineDesc = "";
  let artifactReady = false;

  await withServer({ HARBOR_ALLOW_WRITES: "true" }, async (client) => {
    const created = await call(client, "harbor_projects", {
      action: "create",
      document: { project_name: PROJECT, metadata: { public: "true" } },
      confirm: true,
    });
    const afterCreate = await harborFetch(`api/v2.0/projects/${PROJECT}`);
    realStatuses.push(`get-after-create HTTP ${String(afterCreate.status)}`);
    record(
      "create project confirmed",
      created.isError === false &&
        created.json?.["executed"] === true &&
        afterCreate.status === 200,
      `status=${String(afterCreate.status)} ${clip(created.text)}`,
    );

    const conflict = await harborFetch("api/v2.0/projects", {
      method: "POST",
      body: JSON.stringify({ project_name: PROJECT, metadata: { public: "true" } }),
    });
    realStatuses.push(`create-conflict HTTP ${String(conflict.status)}`);
    record(
      "create conflict",
      conflict.status === 409 || conflict.status === 400,
      `status=${String(conflict.status)}`,
    );

    const summary = await call(client, "harbor_projects", {
      action: "summary",
      project_name_or_id: PROJECT,
    });
    record("project summary", summary.isError === false, clip(summary.text));

    const pushed = pushImage();
    record("crane push", pushed.code === 0, clip(pushed.detail));
    if (pushed.code !== 0) return;

    const repos = await call(client, "harbor_repositories", {
      action: "list",
      project_name: PROJECT,
    });
    const repoNames = asItems(repos.json).map((item) => String(item["name"] ?? ""));
    record(
      "repositories list",
      repos.isError === false && repoNames.includes(`${PROJECT}/${REPO}`),
      clip(repos.text),
    );

    const gotRepo = await call(client, "harbor_repositories", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
    });
    baselineDesc = descriptionOf(gotRepo.json);
    record(
      "repository get",
      gotRepo.isError === false && String(gotRepo.json?.["name"] ?? "").endsWith(`/${REPO}`),
      clip(gotRepo.text),
    );

    const updatePreview = await call(client, "harbor_repositories", {
      action: "update",
      project_name: PROJECT,
      repository_name: REPO,
      document: { description: PREVIEW_DESC },
    });
    const afterUpdatePreview = await call(client, "harbor_repositories", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
    });
    record(
      "repository update preview",
      updatePreview.isError === false &&
        updatePreview.json?.["executed"] === false &&
        updatePreview.json?.["dry_run"] === true &&
        String(updatePreview.json?.["path"] ?? "").includes("team%252Fapp") &&
        descriptionOf(afterUpdatePreview.json) === baselineDesc,
      `desc=${descriptionOf(afterUpdatePreview.json)} ${clip(updatePreview.text)}`,
    );

    const arts = await call(client, "harbor_artifacts", {
      action: "list",
      project_name: PROJECT,
      repository_name: REPO,
    });
    const artItems = asItems(arts.json);
    digest = String(artItems[0]?.["digest"] ?? "");
    record(
      "artifacts list",
      arts.isError === false && digest.startsWith("sha256:"),
      `digest=${digest} ${clip(arts.text)}`,
    );
    if (!digest.startsWith("sha256:")) return;
    artifactReady = true;

    const byDigest = await call(client, "harbor_artifacts", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
    });
    record(
      "artifact get digest",
      byDigest.isError === false && String(byDigest.json?.["digest"] ?? "") === digest,
      clip(byDigest.text),
    );

    const byTag = await call(client, "harbor_artifacts", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
      reference: TAG,
    });
    record(
      "artifact get tag",
      byTag.isError === false && String(byTag.json?.["digest"] ?? "") === digest,
      clip(byTag.text),
    );

    const tags = await call(client, "harbor_artifacts", {
      action: "tags_list",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
    });
    const tagNames = asItems(tags.json).map((item) => String(item["name"] ?? ""));
    record("tags list", tags.isError === false && tagNames.includes(TAG), clip(tags.text));

    const tagPreview = await call(client, "harbor_artifacts", {
      action: "tag_create",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
      name: PREVIEW_TAG,
    });
    const tagsAfterPreview = await call(client, "harbor_artifacts", {
      action: "tags_list",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
    });
    const previewPath = String(tagPreview.json?.["path"] ?? "");
    record(
      "tag create preview",
      tagPreview.isError === false &&
        tagPreview.json?.["executed"] === false &&
        tagPreview.json?.["dry_run"] === true &&
        previewPath.includes("team%252Fapp") &&
        previewPath.includes("sha256%3A") &&
        !previewPath.includes("%253A") &&
        !asItems(tagsAfterPreview.json).some((item) => item["name"] === PREVIEW_TAG),
      clip(tagPreview.text),
    );

    const existingLabels = await call(client, "harbor_admin", {
      action: "labels_list",
      name: LABEL,
      scope: "g",
    });
    const existingItems = Array.isArray(existingLabels.json?.["items"])
      ? existingLabels.json["items"]
      : [];
    for (const item of existingItems) {
      if (!isRecord(item) || item["name"] !== LABEL) continue;
      const existingId = String(item["id"] ?? "");
      if (existingId.length === 0) continue;
      await call(client, "harbor_admin", {
        action: "label_delete",
        label_id: existingId,
        confirm: true,
      });
    }

    const label = await call(client, "harbor_admin", {
      action: "label_create",
      document: { name: LABEL, color: "#A9B6BE", scope: "g" },
      confirm: true,
    });
    const listedLabels = await call(client, "harbor_admin", {
      action: "labels_list",
      name: LABEL,
      scope: "g",
    });
    const labelItems = Array.isArray(listedLabels.json?.["items"])
      ? listedLabels.json["items"]
      : [];
    const match = labelItems.find((item) => isRecord(item) && item["name"] === LABEL);
    labelId = match && isRecord(match) ? String(match["id"] ?? "") : "";
    record(
      "label create",
      label.isError === false &&
        label.json?.["executed"] === true &&
        listedLabels.isError === false &&
        labelId.length > 0,
      `id=${labelId} ${clip(label.text)}`,
    );

    if (labelId.length > 0) {
      const labelPreview = await call(client, "harbor_artifacts", {
        action: "label_add",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
        document: { id: Number(labelId) },
      });
      const afterLabelPreview = await call(client, "harbor_artifacts", {
        action: "get",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
        with_label: true,
      });
      record(
        "label add preview",
        labelPreview.isError === false &&
          labelPreview.json?.["executed"] === false &&
          labelPreview.json?.["dry_run"] === true &&
          !labelIdsOf(afterLabelPreview.json).includes(labelId),
        clip(labelPreview.text),
      );
    } else {
      record("label add preview", false, "no label id");
    }
  });

  await withServer({ HARBOR_ALLOW_WRITES: "false" }, async (client) => {
    if (!artifactReady) {
      record("repository update blocked", false, "no artifact");
      record("tag create blocked", false, "no artifact");
      record("label add blocked", false, "no artifact");
      return;
    }
    const blockedUpdate = await call(client, "harbor_repositories", {
      action: "update",
      project_name: PROJECT,
      repository_name: REPO,
      document: { description: BLOCKED_DESC },
      confirm: true,
    });
    const afterBlockedUpdate = await call(client, "harbor_repositories", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
    });
    record(
      "repository update blocked",
      blockedUpdate.isError === false &&
        blockedUpdate.json?.["blocked"] === true &&
        blockedUpdate.json?.["executed"] === false &&
        descriptionOf(afterBlockedUpdate.json) === baselineDesc,
      clip(blockedUpdate.text),
    );

    const blockedTag = await call(client, "harbor_artifacts", {
      action: "tag_create",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
      name: BLOCKED_TAG,
      confirm: true,
    });
    const tagsAfterBlocked = await call(client, "harbor_artifacts", {
      action: "tags_list",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
    });
    record(
      "tag create blocked",
      blockedTag.isError === false &&
        blockedTag.json?.["blocked"] === true &&
        blockedTag.json?.["executed"] === false &&
        !asItems(tagsAfterBlocked.json).some((item) => item["name"] === BLOCKED_TAG),
      clip(blockedTag.text),
    );

    const blockedLabel = await call(client, "harbor_artifacts", {
      action: "label_add",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
      document: { id: Number(labelId) },
      confirm: true,
    });
    const afterBlockedLabel = await call(client, "harbor_artifacts", {
      action: "get",
      project_name: PROJECT,
      repository_name: REPO,
      reference: digest,
      with_label: true,
    });
    record(
      "label add blocked",
      labelId.length > 0 &&
        blockedLabel.isError === false &&
        blockedLabel.json?.["blocked"] === true &&
        blockedLabel.json?.["executed"] === false &&
        !labelIdsOf(afterBlockedLabel.json).includes(labelId),
      clip(blockedLabel.text),
    );
  });

  await withServer({ HARBOR_ALLOW_WRITES: "true" }, async (client) => {
    if (artifactReady) {
      const updated = await call(client, "harbor_repositories", {
        action: "update",
        project_name: PROJECT,
        repository_name: REPO,
        document: { description: LIVE_DESC },
        confirm: true,
      });
      const afterUpdate = await call(client, "harbor_repositories", {
        action: "get",
        project_name: PROJECT,
        repository_name: REPO,
      });
      record(
        "repository update confirmed",
        updated.isError === false &&
          updated.json?.["executed"] === true &&
          descriptionOf(afterUpdate.json) === LIVE_DESC,
        clip(afterUpdate.text),
      );

      const tagged = await call(client, "harbor_artifacts", {
        action: "tag_create",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
        name: EXTRA_TAG,
        confirm: true,
      });
      const tagsAfter = await call(client, "harbor_artifacts", {
        action: "tags_list",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
      });
      record(
        "tag create confirmed",
        tagged.isError === false &&
          tagged.json?.["executed"] === true &&
          asItems(tagsAfter.json).some((item) => item["name"] === EXTRA_TAG),
        clip(tagged.text),
      );

      const dup = await harborFetch(
        `api/v2.0/projects/${PROJECT}/repositories/${encodeURIComponent(encodeURIComponent(REPO))}/artifacts/${encodeURIComponent(digest)}/tags`,
        { method: "POST", body: JSON.stringify({ name: EXTRA_TAG }) },
      );
      realStatuses.push(`tag-duplicate HTTP ${String(dup.status)}`);
      record("tag duplicate", dup.status === 409, `status=${String(dup.status)}`);

      const deletedTag = await call(client, "harbor_artifacts", {
        action: "tag_delete",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
        tag_name: EXTRA_TAG,
        confirm: true,
      });
      const tagsAfterDelete = await call(client, "harbor_artifacts", {
        action: "tags_list",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
      });
      record(
        "tag delete confirmed",
        deletedTag.isError === false &&
          deletedTag.json?.["executed"] === true &&
          !asItems(tagsAfterDelete.json).some((item) => item["name"] === EXTRA_TAG) &&
          asItems(tagsAfterDelete.json).some((item) => item["name"] === TAG),
        clip(deletedTag.text),
      );

      if (labelId.length > 0) {
        const added = await call(client, "harbor_artifacts", {
          action: "label_add",
          project_name: PROJECT,
          repository_name: REPO,
          reference: digest,
          document: { id: Number(labelId) },
          confirm: true,
        });
        const afterAdd = await call(client, "harbor_artifacts", {
          action: "get",
          project_name: PROJECT,
          repository_name: REPO,
          reference: digest,
          with_label: true,
        });
        record(
          "label add confirmed",
          added.isError === false &&
            added.json?.["executed"] === true &&
            labelIdsOf(afterAdd.json).includes(labelId),
          clip(afterAdd.text),
        );

        const removed = await call(client, "harbor_artifacts", {
          action: "label_remove",
          project_name: PROJECT,
          repository_name: REPO,
          reference: digest,
          label_id: labelId,
          confirm: true,
        });
        const afterRemove = await call(client, "harbor_artifacts", {
          action: "get",
          project_name: PROJECT,
          repository_name: REPO,
          reference: digest,
          with_label: true,
        });
        record(
          "label remove confirmed",
          removed.isError === false &&
            removed.json?.["executed"] === true &&
            !labelIdsOf(afterRemove.json).includes(labelId),
          clip(removed.text),
        );

        const deletedLabel = await call(client, "harbor_admin", {
          action: "label_delete",
          label_id: labelId,
          confirm: true,
        });
        record(
          "label delete",
          deletedLabel.isError === false && deletedLabel.json?.["executed"] === true,
          clip(deletedLabel.text),
        );
      } else {
        record("label add confirmed", false, "no label id");
        record("label remove confirmed", false, "no label id");
        record("label delete", false, "no label id");
      }

      const deletePreview = await call(client, "harbor_artifacts", {
        action: "delete",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
      });
      const stillThere = await harborFetch(
        `api/v2.0/projects/${PROJECT}/repositories/${encodeURIComponent(encodeURIComponent(REPO))}/artifacts/${encodeURIComponent(digest)}`,
      );
      realStatuses.push(`get-after-artifact-delete-preview HTTP ${String(stillThere.status)}`);
      record(
        "artifact delete preview",
        deletePreview.isError === false &&
          deletePreview.json?.["executed"] === false &&
          deletePreview.json?.["dry_run"] === true &&
          String(deletePreview.json?.["path"] ?? "").includes("sha256%3A") &&
          stillThere.status === 200,
        `status=${String(stillThere.status)} ${clip(deletePreview.text)}`,
      );

      const deletedArt = await call(client, "harbor_artifacts", {
        action: "delete",
        project_name: PROJECT,
        repository_name: REPO,
        reference: digest,
        confirm: true,
      });
      const artGone = await harborFetch(
        `api/v2.0/projects/${PROJECT}/repositories/${encodeURIComponent(encodeURIComponent(REPO))}/artifacts/${encodeURIComponent(digest)}`,
      );
      realStatuses.push(`get-after-artifact-delete HTTP ${String(artGone.status)}`);
      record(
        "artifact delete confirmed",
        deletedArt.isError === false &&
          deletedArt.json?.["executed"] === true &&
          artGone.status === 404,
        `status=${String(artGone.status)} ${clip(deletedArt.text)}`,
      );

      const repoDeletePreview = await call(client, "harbor_repositories", {
        action: "delete",
        project_name: PROJECT,
        repository_name: REPO,
      });
      const repoStill = await harborFetch(
        `api/v2.0/projects/${PROJECT}/repositories/${encodeURIComponent(encodeURIComponent(REPO))}`,
      );
      realStatuses.push(`get-after-repository-delete-preview HTTP ${String(repoStill.status)}`);
      record(
        "repository delete preview",
        repoDeletePreview.isError === false &&
          repoDeletePreview.json?.["executed"] === false &&
          repoStill.status === 200,
        `status=${String(repoStill.status)}`,
      );

      const deletedRepo = await call(client, "harbor_repositories", {
        action: "delete",
        project_name: PROJECT,
        repository_name: REPO,
        confirm: true,
      });
      const repoGone = await harborFetch(
        `api/v2.0/projects/${PROJECT}/repositories/${encodeURIComponent(encodeURIComponent(REPO))}`,
      );
      realStatuses.push(`get-after-repository-delete HTTP ${String(repoGone.status)}`);
      record(
        "repository delete confirmed",
        deletedRepo.isError === false &&
          deletedRepo.json?.["executed"] === true &&
          repoGone.status === 404,
        `status=${String(repoGone.status)} ${clip(deletedRepo.text)}`,
      );
    }

    const deny = await call(client, "harbor_projects", {
      action: "create",
      document: { project_name: DENY, metadata: { public: "false" } },
      confirm: true,
    });
    const denyGet = await harborFetch(`api/v2.0/projects/${DENY}`);
    record(
      "private project create",
      deny.isError === false && deny.json?.["executed"] === true && denyGet.status === 200,
      `status=${String(denyGet.status)}`,
    );

    const robot = await call(client, "harbor_robots", {
      action: "create",
      document: {
        name: ROBOT,
        duration: -1,
        level: "project",
        permissions: [
          {
            kind: "project",
            namespace: PROJECT,
            access: [{ resource: "repository", action: "pull" }],
          },
        ],
      },
      confirm: true,
    });
    const robotBody = nestedResult(robot.json);
    const robotId = String(robotBody["id"] ?? robot.json?.["id"] ?? "");
    const robotName = String(robotBody["name"] ?? robot.json?.["name"] ?? "");
    const robotSecret = String(robot.json?.["secret"] ?? robotBody["secret"] ?? "");
    if (robotSecret.length >= 8) secrets.push(robotSecret);
    const stderrSoFar = stderrChunks.join("");
    const logsClean = robotSecret.length < 8 || !stderrSoFar.includes(robotSecret);
    record(
      "robot create",
      robot.isError === false &&
        robot.json?.["executed"] === true &&
        robotId.length > 0 &&
        robotSecret.length >= 8 &&
        robotName.startsWith("robot") &&
        logsClean,
      `id=${robotId} secret_len=${String(robotSecret.length)} logs_clean=${String(logsClean)}`,
    );

    if (robotSecret.length >= 8 && robotName.length > 0) {
      const forbidden = await harborFetch(
        `api/v2.0/projects/${DENY}`,
        {},
        robotName,
        robotSecret,
      );
      realStatuses.push(`robot-get-other-project HTTP ${String(forbidden.status)}`);
      record(
        "limited robot forbidden",
        forbidden.status === 403,
        `status=${String(forbidden.status)}`,
      );
    } else {
      record("limited robot forbidden", false, "no robot secret");
    }

    if (robotId.length > 0) {
      const deletedRobot = await call(client, "harbor_robots", {
        action: "delete",
        robot_id: robotId,
        confirm: true,
      });
      const stderrAfter = stderrChunks.join("");
      record(
        "robot delete",
        deletedRobot.isError === false &&
          deletedRobot.json?.["executed"] === true &&
          (robotSecret.length < 8 || !stderrAfter.includes(robotSecret)),
        clip(deletedRobot.text),
      );
    } else {
      record("robot delete", false, "no robot id");
    }

    if (denyGet.status === 200) {
      await call(client, "harbor_projects", {
        action: "delete",
        project_name_or_id: DENY,
        confirm: true,
      });
    }

    const deletedProject = await call(client, "harbor_projects", {
      action: "delete",
      project_name_or_id: PROJECT,
      confirm: true,
    });
    const afterDelete = await harborFetch(`api/v2.0/projects/${PROJECT}`);
    realStatuses.push(`get-after-delete HTTP ${String(afterDelete.status)}`);
    record(
      "delete project confirmed",
      deletedProject.isError === false &&
        deletedProject.json?.["executed"] === true &&
        afterDelete.status === 404,
      `status=${String(afterDelete.status)} ${clip(deletedProject.text)}`,
    );
  });

  await withServer(
    { HARBOR_ALLOW_WRITES: "true", HARBOR_PASSWORD: "wrong-password-value-xx" },
    async (client) => {
      const bad = await call(client, "harbor_system", { action: "current_user" });
      record(
        "bad password",
        bad.isError === true && (bad.text.includes("401") || bad.text.includes("unauthorized")),
        clip(bad.text),
      );
    },
  );
  const badHttp = await harborFetch("api/v2.0/users/current", {
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:wrong-password-value-xx`, "utf8").toString("base64")}`,
    },
  });
  realStatuses.push(`bad-password HTTP ${String(badHttp.status)}`);

  for (const line of rows) writeLine(line);
  writeLine(`real HTTP statuses: ${realStatuses.join("; ")}`);
  writeLine(`live-check ${String(passed)} passed, ${String(failed)} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  writeError(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
