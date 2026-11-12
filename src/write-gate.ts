import type { QueryMap } from "./http.js";
import {
  asSecretScope,
  currentSecretScope,
  createSecretScope,
  redact,
  redactUnknown,
  type SecretScope,
} from "./redact.js";
import type { Runtime } from "./runtime.js";

export const WRITES_DISABLED = "HARBOR_ALLOW_WRITES is not true. The write was not sent.";

export interface WritePlan {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly summary: string;
  readonly warnings: readonly string[];
}

export function previewWrite(
  plan: WritePlan,
  blocked: boolean,
  reason: string | undefined,
  secrets: SecretScope | readonly string[],
): Record<string, unknown> {
  const scope = createSecretScope(asSecretScope(secrets).all, plan.body, plan.query, plan.headers);
  const payload: Record<string, unknown> = {
    executed: false,
    dry_run: true,
    blocked,
    method: plan.method,
    path: redact(plan.path, scope.maskable),
    summary: plan.summary,
    warnings: [...plan.warnings],
  };
  if (reason !== undefined) payload["reason"] = reason;
  if (plan.query !== undefined) payload["query"] = redactUnknown(plan.query, scope);
  if (plan.body !== undefined) payload["body"] = redactUnknown(plan.body, scope);
  if (plan.headers !== undefined) payload["headers"] = redactUnknown(plan.headers, scope);
  return payload;
}

export function decideWrite(
  allowWrites: boolean,
  confirm: boolean | undefined,
  plan: WritePlan,
  secrets: SecretScope | readonly string[],
): { kind: "preview"; payload: Record<string, unknown> } | { kind: "execute" } {
  if (confirm !== true) {
    return { kind: "preview", payload: previewWrite(plan, false, undefined, secrets) };
  }
  if (!allowWrites) {
    return { kind: "preview", payload: previewWrite(plan, true, WRITES_DISABLED, secrets) };
  }
  return { kind: "execute" };
}

export async function withWrite<T>(
  runtime: Runtime,
  confirm: boolean | undefined,
  plan: WritePlan,
  run: () => Promise<T>,
): Promise<Record<string, unknown>> {
  const scope = currentSecretScope(runtime.scope);
  const decision = decideWrite(runtime.config.allowWrites, confirm, plan, scope);
  if (decision.kind === "preview") return decision.payload;
  const result = await run();
  return {
    executed: true,
    dry_run: false,
    blocked: false,
    warnings: [...plan.warnings],
    result,
  };
}
