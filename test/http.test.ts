import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConnectorError } from "../src/errors.js";
import { API_KEY, basicHeader, jsonResponse, requestUrl, runtimeFor } from "./harness.js";

describe("HttpClient", () => {
  it("sends Authorization Basic and never puts the password in the URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(basicHeader());
      expect(headers.get("x-api-key")).toBeNull();
      expect(requestUrl(input)).not.toContain(API_KEY);
      expect(init?.redirect).toBe("manual");
      expect(headers.get("accept")).toBe("application/json");
      return Promise.resolve(jsonResponse({ username: "admin" }));
    });
    const runtime = runtimeFor(fetchImpl);
    const body = await runtime.client.getJson(
      { path: "api/v2.0/users/current", query: undefined, ttlSec: 0 },
      z.object({ username: z.string() }).loose(),
    );
    expect(body.username).toBe("admin");
  });

  it("preserves false and zero query values", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      expect(requestUrl(input)).toContain("page=0");
      expect(requestUrl(input)).toContain("public=false");
      return Promise.resolve(jsonResponse([]));
    });
    const runtime = runtimeFor(fetchImpl);
    await runtime.client.getJson(
      {
        path: "api/v2.0/projects",
        query: { page: 0, public: false },
        ttlSec: 0,
      },
      z.unknown(),
    );
  });

  it("caches a read and does not spend a second request until TTL expires", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ harbor_version: "2.16.0" })),
    );
    let now = 0;
    const runtime = runtimeFor(fetchImpl, { HARBOR_CACHE_TTL_SEC: "30" }, () => now);
    const schema = z.object({ harbor_version: z.string() });
    const first = await runtime.client.getJson(
      { path: "api/v2.0/systeminfo", query: undefined, ttlSec: 30 },
      schema,
    );
    const second = await runtime.client.getJson(
      { path: "api/v2.0/systeminfo", query: undefined, ttlSec: 30 },
      schema,
    );
    expect(first).toEqual({ harbor_version: "2.16.0" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 31_000;
    await runtime.client.getJson(
      { path: "api/v2.0/systeminfo", query: undefined, ttlSec: 30 },
      schema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps 401, 403, 404, 422, and 429 with one fetch and no retry", async () => {
    const cases: { status: number; body: unknown; code: string }[] = [
      { status: 401, body: "SIMULATED unauthorized", code: "unauthorized" },
      { status: 403, body: "SIMULATED forbidden", code: "forbidden" },
      { status: 404, body: "SIMULATED not found", code: "not_found" },
      { status: 422, body: { message: "SIMULATED invalid" }, code: "input" },
      { status: 429, body: "SIMULATED slow", code: "rate_limit" },
    ];
    for (const item of cases) {
      const fetchImpl = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          jsonResponse(
            item.body,
            item.status,
            item.status === 429 ? { "retry-after": "3" } : undefined,
          ),
        ),
      );
      const runtime = runtimeFor(fetchImpl);
      try {
        await runtime.client.getJson(
          { path: "api/v2.0/users/current", query: undefined, ttlSec: 0 },
          z.unknown(),
        );
        throw new Error(`expected ${item.code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectorError);
        if (!(error instanceof ConnectorError)) throw error;
        expect(error.code).toBe(item.code);
        expect(error.message).not.toContain(API_KEY);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "/login" } })),
    );
    const runtime = runtimeFor(fetchImpl);
    try {
      await runtime.client.getJson(
        { path: "api/v2.0/users/current", query: undefined, ttlSec: 0 },
        z.unknown(),
      );
      throw new Error("expected redirect refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).toMatch(/redirect/i);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
