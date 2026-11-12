import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import {
  adminInput,
  artifactsInput,
  projectsInput,
  repositoriesInput,
  robotsInput,
  systemInput,
} from "./fields.js";
import {
  handleAdmin,
  handleArtifacts,
  handleProjects,
  handleRepositories,
  handleRobots,
  handleSystem,
} from "./handlers.js";
import { toolIsWrite } from "./operations.js";
import type { Runtime } from "./runtime.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  registerConnectorTool,
  type ToolAnnotations,
  type ToolContext,
} from "./tools.js";

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx: ToolContext = { secrets: runtime.secrets, logger: runtime.logger };

  registerConnectorTool(
    server,
    {
      name: toolName("harbor_system"),
      description: toolDescription(
        "Harbor health, ping, search, statistics, systeminfo, volumes, and the current user. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: health, ping, search, statistics, systeminfo, volumes, current_user, current_permissions.",
      ),
      inputSchema: systemInput,
      annotations: annotationsFor("harbor_system"),
      handler: (args) => handleSystem(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("harbor_projects"),
      description: toolDescription(
        "Project list, get, summary, create, update, delete, members, and metadata. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: list, create, get, update, delete, deletable, summary, members_list, members_add, member_get, member_update, member_remove, metadata_list, metadata_add, metadata_get, metadata_update, metadata_delete.",
      ),
      inputSchema: projectsInput,
      annotations: annotationsFor("harbor_projects"),
      handler: (args) => handleProjects(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("harbor_repositories"),
      description: toolDescription(
        "Repository list, get, description update, and delete. Repository names with slashes are double-URL-encoded. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: list, list_all, get, update, delete.",
      ),
      inputSchema: repositoriesInput,
      annotations: annotationsFor("harbor_repositories"),
      handler: (args) => handleRepositories(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("harbor_artifacts"),
      description: toolDescription(
        "Artifact list and get, tags, artifact labels, vulnerability addition, scan trigger, and delete. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: list, get, delete, tags_list, tag_create, tag_delete, label_add, label_remove, vulns, scan, accessories.",
      ),
      inputSchema: artifactsInput,
      annotations: annotationsFor("harbor_artifacts"),
      handler: (args) => handleArtifacts(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("harbor_robots"),
      description: toolDescription(
        "Robot account list, get, create, update, secret refresh, and delete. Create and refresh return secret once in the tool result and never in logs. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: list, create, get, update, refresh_secret, delete.",
      ),
      inputSchema: robotsInput,
      annotations: annotationsFor("harbor_robots"),
      handler: (args) => handleRobots(runtime, args),
    },
    ctx,
  );
  registerConnectorTool(
    server,
    {
      name: toolName("harbor_admin"),
      description: toolDescription(
        "Quotas, labels, GC schedule and history, retention metadata, and webhook policy list. GC schedule writes and label writes are gated. Writes run only when confirm is true and HARBOR_ALLOW_WRITES=true. Actions: quotas_list, quota_get, labels_list, label_create, label_get, label_update, label_delete, gc_schedule, gc_history, gc_schedule_create, gc_schedule_update, retention_metadata, retention_get, webhook_list, webhook_events.",
      ),
      inputSchema: adminInput,
      annotations: annotationsFor("harbor_admin"),
      handler: (args) => handleAdmin(runtime, args),
    },
    ctx,
  );
  return server;
}

function annotationsFor(name: string): ToolAnnotations {
  return toolIsWrite(name) ? WRITE_DESTRUCTIVE : READ_ONLY_REMOTE;
}
