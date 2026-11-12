import { ConnectorError } from "./errors.js";
import type {
  AdminInput,
  ArtifactsInput,
  ProjectsInput,
  RepositoriesInput,
  RobotsInput,
  SystemInput,
} from "./fields.js";
import { definedBody, definedQuery, fillPath } from "./json.js";
import type { QueryMap, QueryValue } from "./http.js";
import { jsonValueSchema } from "./schemas.js";
import { requireOp, type HttpMethod, type Operation } from "./operations.js";
import { currentSecretScope, type SecretScope } from "./redact.js";
import type { Runtime } from "./runtime.js";
import { sanitizePayload } from "./sanitize.js";
import { withWrite, type WritePlan } from "./write-gate.js";

type ToolArgs =
  SystemInput | ProjectsInput | RepositoriesInput | ArtifactsInput | RobotsInput | AdminInput;

function asArgs(value: ToolArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function requirePresent(value: unknown, label: string): unknown {
  if (value === undefined) {
    throw new ConnectorError("input", `${label} is required for this action.`);
  }
  return value;
}

function pathParamsOf(operation: Operation, args: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of operation.pathParams) {
    const value = requirePresent(args[name], name);
    if (typeof value === "number" && Number.isFinite(value)) {
      params[name] = String(value);
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new ConnectorError("input", `${name} is required for this action.`);
    }
    params[name] = value;
  }
  return params;
}

function queryOf(operation: Operation, args: Record<string, unknown>): QueryMap | undefined {
  const record: Record<string, QueryValue | undefined> = {};
  for (const field of operation.fields) {
    if (field.in !== "query") continue;
    const value = args[field.name];
    if (field.required) requirePresent(value, field.name);
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      record[field.name] = value;
      continue;
    }
    throw new ConnectorError("input", `${field.name} must be a string, number, or boolean.`);
  }
  return definedQuery(record);
}

function bodyOf(operation: Operation, args: Record<string, unknown>): unknown {
  if (operation.bodyFields.length === 0) return undefined;
  const documentField = operation.bodyFields.find((field) => field.name === "document");
  if (documentField !== undefined) {
    const document = args["document"];
    if (documentField.required) requirePresent(document, "document");
    return document;
  }
  const record: Record<string, unknown> = {};
  for (const field of operation.bodyFields) {
    const value = args[field.name];
    if (field.required) requirePresent(value, field.name);
    if (value === undefined) continue;
    record[field.name] = value;
  }
  return definedBody(record);
}

function planFor(
  operation: Operation,
  path: string,
  body: unknown,
  query: QueryMap | undefined,
): WritePlan {
  if (operation.method === "GET" || operation.method === "HEAD") {
    throw new ConnectorError("config", "Write plan cannot use GET.");
  }
  return {
    method: operation.method,
    path,
    query,
    body,
    headers: undefined,
    summary: operation.summary,
    warnings: operation.warnings,
  };
}

async function send(
  runtime: Runtime,
  method: HttpMethod,
  path: string,
  query: QueryMap | undefined,
  body: unknown,
): Promise<unknown> {
  if (method === "GET") {
    return runtime.client.getJson({ path, query, ttlSec: runtime.cacheTtlSec }, jsonValueSchema);
  }
  const request = { path, query, body, headers: undefined };
  if (method === "POST") return runtime.client.postJson(request, jsonValueSchema);
  if (method === "PUT") return runtime.client.putJson(request, jsonValueSchema);
  if (method === "PATCH") return runtime.client.patchJson(request, jsonValueSchema);
  return runtime.client.deleteJson(request, jsonValueSchema);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(
  operation: Operation,
  payload: unknown,
  scope: SecretScope,
): Record<string, unknown> {
  const revealed =
    operation.reveal && isRecord(payload) && typeof payload["secret"] === "string"
      ? payload["secret"]
      : undefined;
  const sanitized = sanitizePayload(payload, scope, operation.write ? [] : operation.warnings);
  if (revealed !== undefined) {
    sanitized["secret"] = revealed;
    sanitized["__reveal"] = true;
  }
  return sanitized;
}

export async function dispatch(
  runtime: Runtime,
  tool: string,
  args: ToolArgs,
): Promise<Record<string, unknown>> {
  const record = asArgs(args);
  const action = record["action"];
  if (typeof action !== "string") {
    throw new ConnectorError("input", "action is required.");
  }
  const operation = requireOp(tool, action);
  const path = fillPath(operation.path, pathParamsOf(operation, record));
  const query = queryOf(operation, record);
  const body = bodyOf(operation, record);
  const scope = currentSecretScope(runtime.scope);
  if (operation.write) {
    const plan = planFor(operation, path, body, query);
    return withWrite(runtime, args.confirm, plan, async () => {
      const result = await send(runtime, operation.method, plan.path, query, body);
      return present(operation, result, scope);
    });
  }
  const result = await send(runtime, operation.method, path, query, body);
  return present(operation, result, scope);
}

export async function handleSystem(
  runtime: Runtime,
  args: SystemInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_system", args);
}

export async function handleProjects(
  runtime: Runtime,
  args: ProjectsInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_projects", args);
}

export async function handleRepositories(
  runtime: Runtime,
  args: RepositoriesInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_repositories", args);
}

export async function handleArtifacts(
  runtime: Runtime,
  args: ArtifactsInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_artifacts", args);
}

export async function handleRobots(
  runtime: Runtime,
  args: RobotsInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_robots", args);
}

export async function handleAdmin(
  runtime: Runtime,
  args: AdminInput,
): Promise<Record<string, unknown>> {
  return dispatch(runtime, "harbor_admin", args);
}
