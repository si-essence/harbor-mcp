import { z, type core } from "zod";
import { confirmField } from "./confirm.js";
import { OPERATIONS } from "./operations.js";
import { jsonObjectSchema } from "./schemas.js";
import { fixedError } from "./zod-messages.js";

export { confirmField };

const actionError = fixedError("action must be a published Harbor operation for this tool");
const idError = fixedError("id must be 1 to 256 characters");
const nameError = fixedError("name must be 1 to 250 characters");
const pageError = fixedError("page must be an integer from 1 to 1000000");
const pageSizeError = fixedError("page_size must be an integer from 1 to 100");
const stringError = fixedError("must be 1 to 4096 characters");
const qError = fixedError("q must be at most 1024 characters");

export function actionField(actions: [string, ...string[]]): z.ZodType<string> {
  return z.enum(actions, { error: actionError }).describe("Harbor operation to call.");
}

function inputKeysFor(tool: string, action: string): ReadonlySet<string> | undefined {
  const operation = OPERATIONS.find((item) => item.tool === tool && item.action === action);
  if (operation === undefined) return undefined;
  const keys = new Set<string>(["action"]);
  for (const field of operation.fields) keys.add(field.name);
  for (const field of operation.bodyFields) keys.add(field.name);
  for (const field of operation.headerFields) keys.add(field.name);
  if (operation.write) keys.add("confirm");
  return keys;
}

function rejectForeignFields(tool: string) {
  return (value: { action: string }, ctx: core.$RefinementCtx): void => {
    const allowed = inputKeysFor(tool, value.action);
    if (allowed === undefined) return;
    for (const key of Object.keys(value)) {
      if (allowed.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is not valid for ${value.action}`,
      });
    }
  };
}

const optionalId = z
  .string()
  .trim()
  .min(1, { error: idError })
  .max(256, { error: idError })
  .optional();

const optionalName = z
  .string()
  .trim()
  .min(1, { error: nameError })
  .max(250, { error: nameError })
  .optional();

const optionalPage = z
  .number()
  .int()
  .min(1, { error: pageError })
  .max(1_000_000, { error: pageError })
  .optional();

const optionalPageSize = z
  .number()
  .int()
  .min(1, { error: pageSizeError })
  .max(100, { error: pageSizeError })
  .optional();

const optionalString = z
  .string()
  .min(1, { error: stringError })
  .max(4096, { error: stringError })
  .optional();

const optionalQ = z.string().max(1024, { error: qError }).optional();

const optionalDocument = jsonObjectSchema.optional();

const optionalBool = z.boolean().optional();

export const systemInput = z
  .object({
    action: actionField([
      "health",
      "ping",
      "search",
      "statistics",
      "systeminfo",
      "volumes",
      "current_user",
      "current_permissions",
    ]),
    q: optionalQ,
    scope: optionalString,
    relative: optionalBool,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_system"));

export const projectsInput = z
  .object({
    action: actionField([
      "list",
      "create",
      "get",
      "update",
      "delete",
      "deletable",
      "summary",
      "members_list",
      "members_add",
      "member_get",
      "member_update",
      "member_remove",
      "metadata_list",
      "metadata_add",
      "metadata_get",
      "metadata_update",
      "metadata_delete",
    ]),
    project_name_or_id: optionalId,
    project_name: optionalName,
    mid: optionalId,
    meta_name: optionalId,
    document: optionalDocument,
    name: optionalName,
    public: optionalBool,
    owner: optionalString,
    with_detail: optionalBool,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_projects"));

export const repositoriesInput = z
  .object({
    action: actionField(["list", "list_all", "get", "update", "delete"]),
    project_name: optionalName,
    repository_name: optionalString,
    document: optionalDocument,
    q: optionalQ,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_repositories"));

export const artifactsInput = z
  .object({
    action: actionField([
      "list",
      "get",
      "delete",
      "tags_list",
      "tag_create",
      "tag_delete",
      "label_add",
      "label_remove",
      "vulns",
      "scan",
      "accessories",
    ]),
    project_name: optionalName,
    repository_name: optionalString,
    reference: optionalString,
    tag_name: optionalName,
    label_id: optionalId,
    document: optionalDocument,
    name: optionalName,
    with_tag: optionalBool,
    with_label: optionalBool,
    with_scan_overview: optionalBool,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_artifacts"));

export const robotsInput = z
  .object({
    action: actionField(["list", "create", "get", "update", "refresh_secret", "delete"]),
    robot_id: optionalId,
    document: optionalDocument,
    q: optionalQ,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_robots"));

export const adminInput = z
  .object({
    action: actionField([
      "quotas_list",
      "quota_get",
      "labels_list",
      "label_create",
      "label_get",
      "label_update",
      "label_delete",
      "gc_schedule",
      "gc_history",
      "gc_schedule_create",
      "gc_schedule_update",
      "retention_metadata",
      "retention_get",
      "webhook_list",
      "webhook_events",
    ]),
    id: optionalId,
    label_id: optionalId,
    project_name_or_id: optionalId,
    document: optionalDocument,
    name: optionalName,
    scope: optionalString,
    page: optionalPage,
    page_size: optionalPageSize,
    confirm: confirmField,
  })
  .strict()
  .superRefine(rejectForeignFields("harbor_admin"));

export type SystemInput = z.infer<typeof systemInput>;
export type ProjectsInput = z.infer<typeof projectsInput>;
export type RepositoriesInput = z.infer<typeof repositoriesInput>;
export type ArtifactsInput = z.infer<typeof artifactsInput>;
export type RobotsInput = z.infer<typeof robotsInput>;
export type AdminInput = z.infer<typeof adminInput>;
