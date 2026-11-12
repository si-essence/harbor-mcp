import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const USERNAME = "admin";
export const API_KEY = "super-secret/key+value=99";
export const BASE = "https://harbor.test";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HARBOR_URL: BASE,
    HARBOR_USERNAME: USERNAME,
    HARBOR_PASSWORD: API_KEY,
    HARBOR_CACHE_TTL_SEC: "0",
    HARBOR_ALLOW_WRITES: "true",
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | null;
  authorization: string | null;
  accept: string | null;
  contentType: string | null;
  extraHeaders: Record<string, string>;
  redirect: RequestRedirect | undefined;
  body: unknown;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  let body: unknown;
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  } else body = init.body;
  const extraHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    extraHeaders[key] = value;
  });
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    apiKey: headers.get("x-api-key"),
    authorization: headers.get("authorization"),
    accept: headers.get("accept"),
    contentType: headers.get("content-type"),
    extraHeaders,
    redirect: init?.redirect,
    body,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  const extra = headers ?? {};
  if (body === null || body === undefined) {
    return new Response(null, { status, headers: extra });
  }
  if (typeof body === "string") {
    return new Response(body, {
      status,
      headers: { "content-type": "text/plain", ...extra },
    });
  }
  return Response.json(body, { status, headers: extra });
}

export function basicHeader(username = USERNAME, password = API_KEY): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
