import { readFileSync } from "node:fs";
import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  HARBOR_PASSWORD: z
    .string({ error: invalid })
    .min(1, { error: invalid })
    .max(4096, { error: invalid }),
  HARBOR_USERNAME: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(255, { error: invalid }),
  HARBOR_URL: z.url({ error: invalid }),
  HARBOR_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  HARBOR_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HARBOR_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HARBOR_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HARBOR_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  secret: Secret;
  username: string;
  baseUrl: BaseUrl;
  allowWrites: boolean;
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (query_or_hash).");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (
    path === "/api" ||
    path.endsWith("/api") ||
    path === "/api/v2.0" ||
    path.endsWith("/api/v2.0")
  ) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HARBOR_URL (api_prefix). Pass the origin only. The client adds /api/v2.0/...",
    );
  }
  if (path !== "/") {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (origin_only).");
  }
  return brandBaseUrl(url.origin);
}

function readPassword(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = read(env, "HARBOR_PASSWORD");
  if (fromEnv !== undefined) return fromEnv;
  const filePath = read(env, "HARBOR_PASSWORD_FILE");
  if (filePath === undefined) return undefined;
  try {
    const text = readFileSync(filePath, "utf8").trim();
    return text.length === 0 ? undefined : text;
  } catch {
    throw new ConnectorError("config", "Invalid environment: HARBOR_PASSWORD_FILE (unreadable).");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "HARBOR_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HARBOR_URL (required). Set it to the self-hosted Harbor origin, for example http://127.0.0.1:18080.",
    );
  }
  const usernameRaw = read(env, "HARBOR_USERNAME");
  if (usernameRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HARBOR_USERNAME (required). Robot accounts use a username such as robot$project+name.",
    );
  }
  const secretRaw = readPassword(env);
  if (secretRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HARBOR_PASSWORD (required). Sent as HTTP Basic. HARBOR_PASSWORD_FILE is accepted instead of HARBOR_PASSWORD.",
    );
  }

  const parsed = EnvSchema.safeParse({
    HARBOR_PASSWORD: secretRaw,
    HARBOR_USERNAME: usernameRaw,
    HARBOR_URL: urlRaw,
    HARBOR_ALLOW_WRITES: read(env, "HARBOR_ALLOW_WRITES"),
    HARBOR_PER_MINUTE: read(env, "HARBOR_PER_MINUTE"),
    HARBOR_TIMEOUT_MS: read(env, "HARBOR_TIMEOUT_MS"),
    HARBOR_CONTACT: read(env, "HARBOR_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    HARBOR_CACHE_TTL_SEC: read(env, "HARBOR_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  if (hasControlChar(data.HARBOR_PASSWORD)) {
    throw new ConnectorError("config", "Invalid environment: HARBOR_PASSWORD (control_character).");
  }
  if (hasControlChar(data.HARBOR_USERNAME)) {
    throw new ConnectorError("config", "Invalid environment: HARBOR_USERNAME (control_character).");
  }
  const secret = brandSecret(data.HARBOR_PASSWORD);
  const baseUrl = normalizeBaseUrl(data.HARBOR_URL);
  const contact = data.HARBOR_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: HARBOR_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  if (baseUrl.includes(secret)) {
    throw new ConnectorError("config", "Invalid environment: HARBOR_URL (contains_secret).");
  }
  if (contact.includes(secret) || userAgent.includes(secret)) {
    throw new ConnectorError("config", "Invalid environment: HARBOR_CONTACT (contains_secret).");
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const allowWrites = data.HARBOR_ALLOW_WRITES === "true";

  return {
    secret,
    username: data.HARBOR_USERNAME,
    baseUrl,
    allowWrites,
    perMinute: boundedInt(data.HARBOR_PER_MINUTE, 30, 1, 10_000, "HARBOR_PER_MINUTE"),
    timeoutMs: boundedInt(data.HARBOR_TIMEOUT_MS, 20_000, 100, 120_000, "HARBOR_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.HARBOR_CACHE_TTL_SEC, 60, 0, 86_400, "HARBOR_CACHE_TTL_SEC"),
    userAgent,
  };
}
