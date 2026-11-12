import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME } from "../src/constants.js";
import { jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("server", () => {
  it("publishes six tools on the harbor-mcp server", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({}));
    const runtime = runtimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      expect(CONNECTOR_NAME).toBe("harbor-mcp");
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "harbor_admin",
        "harbor_artifacts",
        "harbor_projects",
        "harbor_repositories",
        "harbor_robots",
        "harbor_system",
      ]);
    } finally {
      await close();
    }
  });
});
