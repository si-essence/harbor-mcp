import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  GENERIC_UPSTREAM,
  MIN_SUBSTRING_SECRET,
  createSecretScope,
  suppliedSecrets,
} from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { API_KEY, jsonResponse } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const LONG_SECRET = `LONG-SECRET-${"W".repeat(70)}`;
const SHORT = {
  one: "~",
  two: "qz",
  three: "p@!",
  four: "xYz!",
} as const;

function leakForms(secret: string): string[] {
  const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  return [...new Set(forms.filter((form) => form.length > 0))];
}

function assertNoLeak(label: string, text: string, secret: string): void {
  for (const form of leakForms(secret)) {
    expect(text, `${label} must not contain ${JSON.stringify(form)}`).not.toContain(form);
  }
}

function simulated422(secret: string): Response {
  return jsonResponse(
    {
      message: `SIMULATED HTTP 422 rejected ${secret} enc=${encodeURIComponent(secret)}`,
    },
    422,
  );
}

async function withCaptured(
  fetchImpl: typeof fetch,
  run: (
    client: Awaited<ReturnType<typeof connectServer>>["client"],
    logs: string[],
  ) => Promise<void>,
): Promise<void> {
  const logs: string[] = [];
  const runtime = createRuntime(
    loadConfig(
      {
        HARBOR_URL: "https://harbor.test",
        HARBOR_USERNAME: "admin",
        HARBOR_PASSWORD: API_KEY,
        HARBOR_CACHE_TTL_SEC: "0",
        HARBOR_ALLOW_WRITES: "true",
      },
      [],
    ),
    {
      fetchImpl,
      logger: {
        info: (message) => {
          logs.push(message);
        },
        error: (message) => {
          logs.push(message);
        },
      },
    },
  );
  const connected = await connectServer(runtime);
  try {
    await run(connected.client, logs);
  } finally {
    await connected.close();
  }
}

describe("request-scoped secrets", () => {
  it("collects nested short, long, secret, password, and userinfo with no length floor", () => {
    const found = suppliedSecrets({
      secret: SHORT.one,
      token: LONG_SECRET,
      nested: { password: SHORT.two },
      url: "http://echo-user:url-pass-9@127.0.0.1:9/path",
    });
    expect(found).toEqual(
      expect.arrayContaining([SHORT.one, SHORT.two, LONG_SECRET, "echo-user", "url-pass-9"]),
    );
    const first = createSecretScope([API_KEY], { secret: "alpha-one" });
    const second = createSecretScope([API_KEY], { secret: "beta-two" });
    expect(first.all).toContain("alpha-one");
    expect(first.all).not.toContain("beta-two");
    expect(second.all).toContain("beta-two");
    expect(second.all).not.toContain("alpha-one");
    expect(MIN_SUBSTRING_SECRET).toBe(8);
  });

  it("redacts secret values on preview, success, error, and logs without accumulating", async () => {
    const cases = [
      { name: "short value", secret: SHORT.three },
      { name: "long value", secret: LONG_SECRET },
    ];
    for (const item of cases) {
      const previewFetch: typeof fetch = () => {
        throw new Error("SIMULATED fetch must not run on preview");
      };
      await withCaptured(previewFetch, async (client, logs) => {
        const result = readToolText(
          await client.callTool({
            name: "harbor_robots",
            arguments: {
              action: "create",
              document: { name: "mcp", secret: item.secret },
            },
          }),
        );
        expect(result.isError, item.name).toBe(false);
        assertNoLeak(`${item.name} preview output`, result.text, item.secret);
        assertNoLeak(`${item.name} preview logs`, logs.join("\n"), item.secret);
      });

      const errorFetch: typeof fetch = () => Promise.resolve(simulated422(item.secret));
      await withCaptured(errorFetch, async (client, logs) => {
        const result = readToolText(
          await client.callTool({
            name: "harbor_robots",
            arguments: {
              action: "create",
              document: { name: "mcp", secret: item.secret },
              confirm: true,
            },
          }),
        );
        expect(result.isError, item.name).toBe(true);
        assertNoLeak(`${item.name} error output`, result.text, item.secret);
        assertNoLeak(`${item.name} error logs`, logs.join("\n"), item.secret);
        if (item.secret.length < 8) expect(result.text).toContain(GENERIC_UPSTREAM);
      });

      const okFetch: typeof fetch = () => Promise.resolve(jsonResponse({ name: "mcp-label" }));
      await withCaptured(okFetch, async (client, logs) => {
        const result = readToolText(
          await client.callTool({
            name: "harbor_admin",
            arguments: {
              action: "label_create",
              document: { name: "mcp-label", password: item.secret },
              confirm: true,
            },
          }),
        );
        expect(result.isError, item.name).toBe(false);
        assertNoLeak(`${item.name} success output`, result.text, item.secret);
        assertNoLeak(`${item.name} success logs`, logs.join("\n"), item.secret);
      });
    }
  });
});
