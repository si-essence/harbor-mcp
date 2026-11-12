import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import {
  GENERIC_UPSTREAM,
  createSecretScope,
  redact,
  redactUnknown,
  redactUpstream,
  suppliedSecrets,
} from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";
import { API_KEY, jsonResponse } from "./harness.js";

const ENCODED = encodeURIComponent(API_KEY);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(API_KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the token, its url encoding, query params, and Authorization values", () => {
    const raw = [
      `key=${API_KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?token=${API_KEY}&x=1`,
      `Authorization: ${API_KEY}`,
      `Authorization: Bearer ${API_KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [API_KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("token=[redacted]");
    expect(cleaned).toContain("Authorization: [redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("does not substring-mask secrets shorter than 8 characters", () => {
    const password = "a b";
    expect(redact(`rejected ${password} and the rest`, [password])).toContain(password);
    const scope = createSecretScope([], { password });
    expect(scope.hasShort).toBe(true);
    expect(redactUpstream(`rejected ${password}`, scope)).toBe(GENERIC_UPSTREAM);
    expect(
      redactUnknown({ action: "list", password, message: `rejected ${password}` }, scope),
    ).toEqual({ action: "list", password: "[redacted]", message: "[redacted]" });
  });

  it("redacts nested value, token, and percent-encoded forms", () => {
    const secret = "fixture-secret-value-long";
    const cleaned = JSON.stringify(
      redactUnknown(
        {
          secret: { value: secret },
          title: `see ${API_KEY} ${encodeURIComponent(secret)}`,
        },
        createSecretScope([API_KEY], { value: secret }),
      ),
    );
    assertNoKey("nested", cleaned);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("[redacted]");
  });

  it("collects a request-supplied secret value", () => {
    expect(suppliedSecrets({ value: "abc" })).toContain("abc");
    const long = `x${"y".repeat(70)}`;
    expect(suppliedSecrets({ nested: { value: long } })).toContain(long);
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([API_KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${API_KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the token out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    const rawFailure = `connect failed ${API_KEY} ${ENCODED}`;

    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      assertNoKey("request url", url);
      const header = new Headers(init?.headers).get("authorization");
      expect(header).toMatch(/^Basic /);
      expect(header).not.toContain(API_KEY);
      call += 1;
      if (call === 1) {
        return Promise.resolve(jsonResponse({ username: "admin", token: API_KEY }));
      }
      throw new Error(rawFailure);
    });

    const runtime = createRuntime(
      loadConfig(
        {
          HARBOR_URL: "https://harbor.test",
          HARBOR_USERNAME: "admin",
          HARBOR_PASSWORD: API_KEY,
          HARBOR_CACHE_TTL_SEC: "0",
        },
        [],
      ),
      {
        fetchImpl,
        logger: createLogger([API_KEY], (line) => {
          logs.push(line);
        }),
      },
    );
    const connected = await connectServer(runtime);
    try {
      const me = readToolText(
        await connected.client.callTool({
          name: "harbor_system",
          arguments: { action: "current_user" },
        }),
      );
      assertNoKey("current_user", me.text);
      expect(me.text).toContain("[redacted]");
      const health = readToolText(
        await connected.client.callTool({
          name: "harbor_system",
          arguments: { action: "health" },
        }),
      );
      expect(health.isError).toBe(true);
      assertNoKey("health error", health.text);
    } finally {
      await connected.close();
      spy.mockRestore();
    }
    assertNoKey("logs", logs.join("\n"));
    assertNoKey("console", consoleLines.join("\n"));
  });
});
