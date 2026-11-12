import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fillPath } from "../src/json.js";
import { OPERATIONS, type Operation } from "../src/operations.js";
import { GENERIC_UPSTREAM } from "../src/redact.js";
import { WRITES_DISABLED } from "../src/write-gate.js";
import { API_KEY, basicHeader, jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = [
  "harbor_admin",
  "harbor_artifacts",
  "harbor_projects",
  "harbor_repositories",
  "harbor_robots",
  "harbor_system",
];
const WRITE_TOOLS = new Set(
  OPERATIONS.filter((operation) => operation.write).map((operation) => operation.tool),
);
const WRITES = OPERATIONS.filter((operation) => operation.write);

function requiredArgs(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  for (const field of operation.fields) {
    if (!field.required) continue;
    if (field.name === "project_name" || field.name === "project_name_or_id") {
      args[field.name] = "library";
    } else if (field.name === "repository_name") args[field.name] = "busybox/app";
    else if (field.name === "reference") args[field.name] = "sha256:abc";
    else if (field.name === "tag_name") args[field.name] = "latest";
    else if (field.name === "meta_name") args[field.name] = "public";
    else if (
      field.name === "label_id" ||
      field.name === "robot_id" ||
      field.name === "mid" ||
      field.name === "id"
    ) {
      args[field.name] = "1";
    } else args[field.name] = "x";
  }
  for (const field of operation.bodyFields) {
    if (!field.required) continue;
    if (field.name === "document") args["document"] = { project_name: "mcp-test", public: false };
    else if (field.name === "name") args["name"] = "mcp-tag";
    else args[field.name] = "x";
  }
  return args;
}

function pathParamsOf(operation: Operation, args: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of operation.pathParams) {
    const value = args[name];
    params[name] = typeof value === "number" ? String(value) : String(value);
  }
  return params;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(API_KEY);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("harbor tools", () => {
  it("publishes every tool with confirm only on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(40);
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).toContain("action");
        if (WRITE_TOOLS.has(tool.name)) expect(schema).toContain("confirm");
      }
    });
  });

  it("sends Authorization Basic and never puts the password in the URL", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expect(captured.authorization).toBe(basicHeader());
      expect(captured.apiKey).toBeNull();
      expect(captured.url).not.toContain(API_KEY);
      expect(captured.redirect).toBe("manual");
      return jsonResponse({ username: "admin" });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const me = await call(client, "harbor_system", { action: "current_user" });
      expect(me.isError).toBe(false);
      expect(me.json).toMatchObject({ username: "admin" });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/v2.0/users/current");
  });

  it("runs the full write gate matrix with zero HTTP on previews", async () => {
    for (const operation of WRITES) {
      const args = requiredArgs(operation);
      const cases: { env: string | undefined; confirm: unknown; expectWrite: boolean }[] = [
        { env: undefined, confirm: undefined, expectWrite: false },
        { env: undefined, confirm: false, expectWrite: false },
        { env: undefined, confirm: true, expectWrite: false },
        { env: "true", confirm: undefined, expectWrite: false },
        { env: "true", confirm: false, expectWrite: false },
        { env: "true", confirm: true, expectWrite: true },
        { env: "TRUE", confirm: true, expectWrite: false },
        { env: "1", confirm: true, expectWrite: false },
      ];
      for (const item of cases) {
        const extra: NodeJS.ProcessEnv = {};
        if (item.env === undefined) extra["HARBOR_ALLOW_WRITES"] = "";
        else extra["HARBOR_ALLOW_WRITES"] = item.env;
        const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
        await withClient(fetchImpl, extra, async (client) => {
          const payload = { ...args };
          if (item.confirm !== undefined) payload["confirm"] = item.confirm;
          const result = await call(client, operation.tool, payload);
          expect(result.isError, `${operation.routeId} ${item.env} ${String(item.confirm)}`).toBe(
            false,
          );
          if (item.expectWrite) {
            expect(result.json).toMatchObject({ executed: true, dry_run: false, blocked: false });
            expect(calls).toHaveLength(1);
            expect(calls[0]?.method).toBe(operation.method);
            const filled = fillPath(operation.path, pathParamsOf(operation, args));
            expect(calls[0]?.url).toContain(`/${filled}`);
          } else {
            expect(result.json).toMatchObject({ executed: false, dry_run: true });
            expect(calls).toHaveLength(0);
            if (item.confirm === true && item.env !== "true") {
              expect(result.json).toMatchObject({ blocked: true, reason: WRITES_DISABLED });
            }
          }
        });
      }
    }
  });

  it("rejects unknown fields, wrong actions, and string confirm before HTTP", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({}));
    await withClient(fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const unknown = await call(client, "harbor_projects", {
        action: "create",
        document: { project_name: "x" },
        madeUp: true,
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("madeUp");
      const wrong = await call(client, "harbor_projects", { action: "scan" });
      expect(wrong.isError).toBe(true);
      const missing = await call(client, "harbor_projects", { action: "get" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain("project_name_or_id");
      const stringConfirm = await call(client, "harbor_projects", {
        action: "delete",
        project_name_or_id: "library",
        confirm: "true",
      });
      expect(stringConfirm.isError).toBe(true);
      expect(stringConfirm.text).toContain("confirm");
    });
    expect(calls).toHaveLength(0);
  });

  it("preserves false, 0, and empty values on confirmed writes", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ id: 1 }));
    await withClient(fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const patched = await call(client, "harbor_projects", {
        action: "update",
        project_name_or_id: "library",
        document: { timeout: 0, public: false, name: "" },
        confirm: true,
      });
      expect(patched.json).toMatchObject({ executed: true });
    });
    expect(calls[0]?.body).toEqual({ timeout: 0, public: false, name: "" });
  });

  it("double-URL-encodes repository names that contain a slash", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ name: "busybox/app" }));
    await withClient(fetchImpl, {}, async (client) => {
      const got = await call(client, "harbor_repositories", {
        action: "get",
        project_name: "library",
        repository_name: "busybox/app",
      });
      expect(got.isError).toBe(false);
    });
    expect(calls[0]?.url).toContain("/api/v2.0/projects/library/repositories/busybox%252Fapp");
  });

  it("encodes a digest reference once and a slashed repository name twice", () => {
    const path = fillPath(
      "/api/v2.0/projects/{project_name}/repositories/{repository_name}/artifacts/{reference}",
      {
        project_name: "library",
        repository_name: "team/app",
        reference: "sha256:abc",
      },
    );
    expect(path).toBe(
      "api/v2.0/projects/library/repositories/team%252Fapp/artifacts/sha256%3Aabc",
    );
  });

  it("shows a robot secret once in the tool result and never in the preview body", async () => {
    const generated = "robot-secret-ONCE-9f3c21aa";
    const preview = jsonFetch(() => jsonResponse({ secret: generated }));
    await withClient(preview.fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "harbor_robots", {
        action: "create",
        document: { name: "mcp", duration: -1, level: "system", permissions: [] },
      });
      expect(result.json).toMatchObject({ dry_run: true, executed: false });
      expect(JSON.stringify(result.json)).not.toContain(generated);
      expect(preview.calls).toHaveLength(0);
    });

    const success = jsonFetch(() => jsonResponse({ id: 9, name: "mcp", secret: generated }));
    await withClient(success.fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "harbor_robots", {
        action: "create",
        document: { name: "mcp", duration: -1, level: "system", permissions: [] },
        confirm: true,
      });
      expect(result.json).toMatchObject({ executed: true });
      expect(result.json?.["secret"]).toBe(generated);
      const nested = result.json?.["result"] as Record<string, unknown> | undefined;
      expect(nested?.["secret"]).toBe(generated);
    });
    expect(success.calls).toHaveLength(1);
  });
});

describe("secret leak regressions", () => {
  it("redacts long and short secret values in preview, success, error, and logs", async () => {
    const long = "LONG-SECRET-VALUE-ABCDEFGH";
    const short = "ab";
    const preview = jsonFetch(() => jsonResponse({ name: "mcp" }));
    await withClient(preview.fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "harbor_robots", {
        action: "create",
        document: { name: "mcp", secret: long },
      });
      expect(result.json).toMatchObject({ dry_run: true, executed: false });
      expect(JSON.stringify(result.json)).not.toContain(long);
      expect(result.text).not.toContain(long);
    });
    expect(preview.calls).toHaveLength(0);

    const success = jsonFetch(() => jsonResponse({ name: "mcp-label" }));
    await withClient(success.fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "harbor_admin", {
        action: "label_create",
        document: { name: "mcp-label", password: long },
        confirm: true,
      });
      expect(result.json).toMatchObject({ executed: true });
      expect(result.text).not.toContain(long);
      expect(JSON.stringify(result.json)).not.toContain(long);
    });
    expect(success.calls[0]?.body).toMatchObject({ name: "mcp-label", password: long });

    const nested = jsonFetch(() =>
      jsonResponse({ message: `SIMULATED HTTP 422 echoed ${short}` }, 422),
    );
    await withClient(nested.fetchImpl, { HARBOR_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "harbor_robots", {
        action: "create",
        document: { name: "mcp", secret: short },
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(GENERIC_UPSTREAM);
      expect(result.text).not.toContain(short);
    });
    expect(nested.calls).toHaveLength(1);
  });
});
