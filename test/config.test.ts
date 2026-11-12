import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";

const SECRET = "super-secret/key+value=99";
const URL = "http://127.0.0.1:18080";
const USER = "admin";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function base(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HARBOR_URL: URL, HARBOR_USERNAME: USER, HARBOR_PASSWORD: SECRET, ...extra };
}

describe("loadConfig", () => {
  it("requires HARBOR_URL, HARBOR_USERNAME, and HARBOR_PASSWORD", () => {
    const missingUrl = messageOf(catchError(() => loadConfig({}, [])));
    expect(missingUrl).toContain("HARBOR_URL");
    expect(missingUrl).toContain("required");
    const missingUser = messageOf(catchError(() => loadConfig({ HARBOR_URL: URL }, [])));
    expect(missingUser).toContain("HARBOR_USERNAME");
    const missingSecret = messageOf(
      catchError(() => loadConfig({ HARBOR_URL: URL, HARBOR_USERNAME: USER }, [])),
    );
    expect(missingSecret).toContain("HARBOR_PASSWORD");
    expect(missingSecret).toContain("required");
    expect(missingSecret).not.toContain(SECRET);
  });

  it("applies defaults when origin, username, and password are set", () => {
    const config = loadConfig(base(), []);
    expect(config.secret).toBe(SECRET);
    expect(config.username).toBe(USER);
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("reads HARBOR_PASSWORD_FILE when HARBOR_PASSWORD is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "harbor-mcp-"));
    const filePath = join(dir, "password");
    writeFileSync(filePath, `${SECRET}\n`, { mode: 0o600 });
    const config = loadConfig(
      { HARBOR_URL: URL, HARBOR_USERNAME: USER, HARBOR_PASSWORD_FILE: filePath },
      [],
    );
    expect(config.secret).toBe(SECRET);
  });

  it("lets --http override the transport", () => {
    expect(loadConfig(base({ MCP_TRANSPORT: "stdio" }), ["node", "app", "--http"]).transport).toBe(
      "http",
    );
  });

  it("enables writes only when HARBOR_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig(base({ HARBOR_ALLOW_WRITES: "true" }), []).allowWrites).toBe(true);
    expect(loadConfig(base({ HARBOR_ALLOW_WRITES: "TRUE" }), []).allowWrites).toBe(false);
    expect(loadConfig(base({ HARBOR_ALLOW_WRITES: "1" }), []).allowWrites).toBe(false);
  });

  it("rejects userinfo, query, /api suffix, path, and non-http URLs", () => {
    expect(
      messageOf(
        catchError(() =>
          loadConfig(
            {
              HARBOR_URL: "http://user:pass@127.0.0.1:18080",
              HARBOR_USERNAME: USER,
              HARBOR_PASSWORD: SECRET,
            },
            [],
          ),
        ),
      ),
    ).toContain("userinfo");
    expect(
      messageOf(
        catchError(() =>
          loadConfig(
            {
              HARBOR_URL: "http://127.0.0.1:18080/?x=1",
              HARBOR_USERNAME: USER,
              HARBOR_PASSWORD: SECRET,
            },
            [],
          ),
        ),
      ),
    ).toContain("query_or_hash");
    expect(
      messageOf(
        catchError(() =>
          loadConfig(
            {
              HARBOR_URL: "http://127.0.0.1:18080/api",
              HARBOR_USERNAME: USER,
              HARBOR_PASSWORD: SECRET,
            },
            [],
          ),
        ),
      ),
    ).toContain("api_prefix");
    expect(
      messageOf(
        catchError(() =>
          loadConfig(
            {
              HARBOR_URL: "http://127.0.0.1:18080/harbor",
              HARBOR_USERNAME: USER,
              HARBOR_PASSWORD: SECRET,
            },
            [],
          ),
        ),
      ),
    ).toContain("origin_only");
    expect(
      messageOf(
        catchError(() =>
          loadConfig(
            { HARBOR_URL: "ftp://127.0.0.1:18080", HARBOR_USERNAME: USER, HARBOR_PASSWORD: SECRET },
            [],
          ),
        ),
      ),
    ).toContain("invalid_url");
  });
});
