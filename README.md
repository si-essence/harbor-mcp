# harbor-mcp

MCP connector for a self-hosted [Harbor](https://github.com/goharbor/harbor) v2.16.0 REST API. It speaks official `/api/v2.0` JSON over stdio and over stateless Streamable HTTP on localhost.

Harbor is Apache-2.0 software (`LICENSE` in the v2.16.0 source tree). This connector is MIT. It does not copy Harbor source. It is not affiliated with goharbor/harbor.

`spec/api-inventory.json` is a compact extraction of every `/api/v2.0` operation in v2.16.0 `api/v2.0/swagger.yaml`. It records the release version, Apache-2.0, file sha256s, and `routeTreeSha256`. `scripts/gen-operations.mjs` maps that inventory onto tool actions or exclusions and writes `src/operations.ts` and `harbor.routes.json`. A route that is neither mapped nor excluded fails generation. Do not edit `src/operations.ts` by hand. Default generation and `npm run ci` read only the committed inventory.

`HARBOR_URL`, `HARBOR_USERNAME`, and `HARBOR_PASSWORD` (or `HARBOR_PASSWORD_FILE`) are required. There is no default origin. The connector does not start Harbor. Each request sends `Authorization: Basic`. Credentials are never placed in the URL. Robot accounts use the same Basic auth with a username such as `robot$project+name`.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

```json
{
  "mcpServers": {
    "harbor": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "HARBOR_URL": "http://127.0.0.1:18080",
        "HARBOR_USERNAME": "admin",
        "HARBOR_PASSWORD": "...",
        "HARBOR_ALLOW_WRITES": "false"
      }
    }
  }
}
```

The password is a Harbor user password or a robot secret. The connector never prints it.

HTTP mode has no authentication of its own. Keep it on localhost. Do not put secrets in a Docker image.

```bash
docker build -t harbor-mcp .
docker run -p 127.0.0.1:3000:3000 \
  -e HARBOR_URL=http://127.0.0.1:18080 \
  -e HARBOR_USERNAME=admin \
  -e HARBOR_PASSWORD=... \
  harbor-mcp
```

Regenerate the registry from the committed inventory.

```bash
npm run gen:operations
node scripts/gen-operations.mjs --check
```

Refresh the inventory from an official v2.16.0 tree. This is the only command that reads route source. Keep that tree outside this MIT connector (for example `/workspace/tools/harbor/upstream`).

```bash
node scripts/gen-operations.mjs --source-root /path/to/harbor --write-inventory
node scripts/gen-operations.mjs --source-root /path/to/harbor --check
```

`HARBOR_SOURCE_ROOT` is accepted by a write run. `--check` ignores that variable unless you also pass `--source-root`.

`scripts/live-check.mjs` talks to a real server over stdio. Set `HARBOR_URL`. Set `HARBOR_USERNAME`. Set `HARBOR_PASSWORD` or `HARBOR_PASSWORD_FILE` to a chmod 600 file outside this repo. The script unsets `DATABASE_URL`. It prints pass or fail lines only, and it redacts passwords and live robot secrets. It does not run inside `npm run ci`. A missing password is a failure.

Isolated local runtime scripts live under `/workspace/tools/harbor` (`start.sh`, `stop.sh`). They keep Postgres data and secrets under `/tmp/harbor-mcp`.

## Config

| Variable               | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `HARBOR_URL`           | Required. Origin only, `http` or `https`, no userinfo, query, hash, or path. Example `http://127.0.0.1:18080`. |
| `HARBOR_USERNAME`      | Required. Harbor user or robot account (`robot$project+name`).                                                 |
| `HARBOR_PASSWORD`      | Required unless `HARBOR_PASSWORD_FILE` is set. Sent as HTTP Basic. Redacted in logs, errors, and results.      |
| `HARBOR_PASSWORD_FILE` | Optional. chmod 600 file whose trimmed contents are the password. Used when `HARBOR_PASSWORD` is omitted.      |
| `HARBOR_ALLOW_WRITES`  | Must be the literal `true` before a confirmed write is sent.                                                   |
| `HARBOR_PER_MINUTE`    | Local request budget. Default 30. Cache hits do not spend it. Live-check sets 600.                             |
| `HARBOR_TIMEOUT_MS`    | Upstream timeout. Default 20000.                                                                               |
| `HARBOR_CACHE_TTL_SEC` | Read cache TTL. Default 60. Writes clear the cache.                                                            |
| `HARBOR_CONTACT`       | Contact token in the User-Agent. Must not contain the password.                                                |
| `MCP_TRANSPORT`        | `stdio` or `http`. `--http` overrides.                                                                         |
| `PORT`                 | HTTP port. Default 3000.                                                                                       |

Invalid values are reported by field name and issue code. The rejected value is not included.

Calls go to `/api/v2.0/...` paths from the operations registry. `Accept` is `application/json`. JSON writes send `Content-Type: application/json`. Redirects are refused so credentials are not forwarded. There are no automatic retries, including HTTP 429. Credentials are never placed in the URL, query, or User-Agent.

Harbor CSRF tokens are not sent. Harbor's Basic-auth API does not require them.

Repository names that contain a slash (nested OCI names) are double-URL-encoded (`team/app` becomes `team%252Fapp`) the way Harbor's API expects. Digest references are encoded once (`sha256:abc` becomes `sha256%3Aabc`). `harbor_artifacts` `get` and `list` accept `with_label`. Harbor omits labels unless that flag is true.

## Safety

Reads run without a write flag. A write is sent only when `confirm` is the boolean `true` and `HARBOR_ALLOW_WRITES=true`. That gate covers every mutation in the registry: project create/update/delete, member add/update/remove, metadata writes, repository update/delete, artifact delete, tag create/delete, artifact label add/remove, scan trigger, robot create/update/refresh/delete, label create/update/delete, and GC schedule create/update. Omit `confirm`, or pass boolean `false`, and the tool returns a dry-run preview of method, path, query, and body. It sends nothing. `blocked` is false on that preview, whether or not writes are enabled. `confirm: true` with writes disabled returns the same preview with `blocked` true and the reason `HARBOR_ALLOW_WRITES is not true. The write was not sent.` The string `"true"` is rejected.

Omitted fields are dropped. `public: false` and `timeout: 0` are sent when you set them. A field that is not valid for the selected action is rejected before any request is sent. Unknown fields are rejected.

HTTP 401 is unauthorized. HTTP 403 is forbidden. HTTP 400 and 422 are invalid input. HTTP 404 is not found. HTTP 409 is conflict. HTTP 429 includes Retry-After when the header is present. Other failures are server, network, or timeout. Response bodies are capped at 1,000,000 bytes.

Every non-empty string or number under a sensitive key on that request is a secret, at any nesting depth and inside arrays or objects below that key, including 1-character values and values longer than 64 characters. Sensitive keys include `secret`, `token`, `password`, `authorization`, `apiKey`/`apikey`, `session`, `cookie`, `credential`, `passphrase`, `privateKey`, `value`, and similar names. The configured password (substring-masked at length 8 or more) and any URL userinfo found in the request are included too. Secrets are collected once per request and are not kept for the next call.

Sensitive-key values become `[redacted]` in objects. Substring masking of free text (raw, percent-encoded any-case hex, and JSON-escaped forms) runs only for secrets of length 8 or more. If the request carries a shorter credential, upstream free-text error bodies and log detail are replaced with `upstream detail omitted because this request carried a short credential`. Object keys and this connector's preview envelope (`method`, `path`, `summary`, `executed`, and the other write-gate fields) are not rewritten. That rule covers MCP success results, MCP error text, write previews, HTTP and network errors, and every logger line.

Robot `create` and `refresh_secret` return the new `secret` once in the structured tool result so the caller can store it. That value is never written to logs. Previews redact it. Later reads of the same robot do not include the secret.

## Tools

Six tools. Each takes `action` plus the fields for that action. Fields for a different action are rejected.

| Tool                  | Actions                                                                                                                                                                                                                    | Routes                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `harbor_system`       | health, ping, search, statistics, systeminfo, volumes, current_user, current_permissions                                                                                                                                   | GET `/api/v2.0/health`, `/ping`, `/search`, `/statistics`, `/systeminfo`, `/systeminfo/volumes`, `/users/current`, `/users/current/permissions` |
| `harbor_projects`     | list, create, get, update, delete, deletable, summary, members_list, members_add, member_get, member_update, member_remove, metadata_list, metadata_add, metadata_get, metadata_update, metadata_delete                    | `/api/v2.0/projects` and members/metadata subpaths                                                                                              |
| `harbor_repositories` | list, list_all, get, update, delete                                                                                                                                                                                        | `/api/v2.0/projects/{project_name}/repositories` and `/api/v2.0/repositories`                                                                   |
| `harbor_artifacts`    | list, get, delete, tags_list, tag_create, tag_delete, label_add, label_remove, vulns, scan, accessories                                                                                                                    | artifact, tag, label, scan, and vulnerability addition paths                                                                                    |
| `harbor_robots`       | list, create, get, update, refresh_secret, delete                                                                                                                                                                          | `/api/v2.0/robots`                                                                                                                              |
| `harbor_admin`        | quotas_list, quota_get, labels_list, label_create, label_get, label_update, label_delete, gc_schedule, gc_history, gc_schedule_create, gc_schedule_update, retention_metadata, retention_get, webhook_list, webhook_events | quotas, labels, GC schedule/history, retention get, webhook list/events                                                                         |

Writes need `document` for JSON bodies (project create, member add, robot create, label create, GC schedule, metadata, repository update). Tag create uses `name`.

62 of 208 v2.16.0 `/api/v2.0` operations are mapped. 146 are excluded. The registry has 62 actions. See `harbor.routes.json` for every mapping and exclusion reason.

## Coverage and exclusions

In scope: health/ping/search/statistics/systeminfo/volumes, current user and permissions, project CRUD plus members and metadata, repository list/get/update/delete, artifact list/get/delete, tags, artifact labels, vulnerability addition, scan trigger, accessories, robot CRUD and secret refresh, quotas read, labels CRUD, GC schedule read/create/update and history, retention metadata and get, webhook policy list and event types.

Excluded with a stored reason, grouped:

- User directory, password, CLI secret, and sysadmin writes (`/users` except current user).
- LDAP and OIDC administration.
- System configuration get/update (`/configurations`, `/internalconfig`) because they expose and write instance secrets.
- Replication registries, policies, and executions (remote credentials).
- Scanner registration and per-project scanner assignment.
- P2P preheat instances and policies.
- Immutable tag rules, webhook writes/executions, user groups, RBAC role catalog.
- Raw icon binaries and certificate download.
- Jobservice worker/queue admin, audit log listing, CVE export, security hub, scan-all schedules.
- Quota writes. Retention policy writes and executions.
- Copy-artifact, scan-stop, report logs, and generic artifact additions.

There is no arbitrary HTTP method/path passthrough.

## Source provenance

Official latest stable release checked 12 Nov 2026: **v2.16.0** (released 10 Nov 2026), Apache-2.0. Inventory from `api/v2.0/swagger.yaml` at tag `v2.16.0`.

Pinned inventory hashes:

| File                    | sha256                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `api/v2.0/swagger.yaml` | `31b2704922bafe8eb95b840d2828661454ed1e3aa3cf7b4779249a18b6a54821` |
| route tree              | `45aaa41355037890bc647b2932f80f6bfa7abd1511798a8a3fd4d07bb3cb6afb` |

A copy of the swagger file and Harbor `LICENSE` is stored under `/workspace/tools/harbor/upstream` for `--source-root` checks. Public CI runs offline from `spec/api-inventory.json`.

## Other MCP servers

Read 12 Nov 2026 from GitHub API and raw files. Evidence: `/workspace/tools/harbor/rivals/EVIDENCE.md`.

| Server                                                                                                                                    | Writes                                                | Confirmation                                                                                                                                                              | Notes                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [nomagicln/mcp-harbor](https://github.com/nomagicln/mcp-harbor) (11 tools, MIT, TS, archived 1 Apr 2025, 7 stars)                         | 5: create/delete project, delete repository/tag/chart | **None.** Delete schemas have no `confirm` (`src/definitions/tool.definitions.ts` 42–50). Dispatcher calls Harbor immediately (`src/services/harbor.service.ts` 443–448). | Sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (`src/app.ts` 19–20). Auth is `HARBOR_URL` / `HARBOR_USERNAME` / `HARBOR_PASSWORD` via `@hapic/harbor`. No redaction. `delete_tag` deletes the artifact by digest.                                                |
| [bupd/harbor-mcp-server](https://github.com/bupd/harbor-mcp-server) (12 tools on `main`, MIT, TS, last `main` commit 7 Jul 2025, 6 stars) | 1: `update-configurations`                            | Tool argument `confirm: true` only (`src/tools/configurations.ts` 9–20, 59–81). No env write gate.                                                                        | HTTP Basic via `HARBOR_API_BASE`, `HARBOR_AUTH_USER`, `HARBOR_AUTH_PASS` (`src/lib/api.ts` 5–12, 32–35). `get-configurations` dumps every config key with no redact (`src/tools/configurations.ts` 28–51). No create/delete project/repo/tag on `main`. |

Honest differences that still hold after those reads:

- Every mutation, including scan, GC schedule, robot create/refresh, tag create/delete, and project delete, needs boolean `confirm: true` **and** `HARBOR_ALLOW_WRITES=true`.
- Omitted or false `confirm` always returns a method/path/query/body preview with zero HTTP writes. Robot secrets in that preview are `[redacted]`.
- nomagicln has unconfirmed deletes and disables TLS verification. This connector does not disable TLS and does not send deletes without the two-key gate.
- bupd confirms only system configuration update, and that tool is excluded here because it writes instance secrets. bupd has no project/repo/tag deletes.
- Request-scoped redaction includes robot `secret`, passwords, registry credentials, percent-encoded any-case forms, and JSON-escaped forms. Nothing accumulates across requests.
- Route coverage is checked by the generator against a committed independent inventory. Public CI is offline.
- Six action-field toolsets instead of one tool per route.
- No automatic retries. Redirects are refused.

If a later rival adds the same two-key gate and dry-run preview on every write, that would no longer be unique.

## Limitations

- User, LDAP, OIDC, system config, replication, scanner, and P2P admin stay out of the tool list. Use Harbor's own UI if you need those.
- Isolated live stack runs Harbor **core, Postgres, Redis, distribution registry, and registryctl** on loopback. Portal and jobservice are not started. Scan trigger and GC execution stay unverified. See `LIVE-CHECK.md`.
- Robot secrets appear once in the create/refresh tool result. Store them immediately. They are never logged.
- Live bad passwords from v2.16.0 are recorded in `LIVE-CHECK.md`. Unit tests still simulate 401, 403, 404, 422, and 429 with one fetch. Live-check does not force HTTP 429.
- The connector never starts or stops the user's Harbor. Isolated live scripts under `/workspace/tools/harbor` are throwaway only.
- A short credential (under 8 characters) that is spelled the same as an object key or a word in this connector's own preview envelope still appears there as that key or word. Values that contain it are redacted, and upstream free text is replaced. Use credentials of 8 or more characters.

## Live check

See `LIVE-CHECK.md` for the checks that actually ran, including the first core-only run and the later registry run. `npm run live-check` is not part of `npm run ci`. Set `HARBOR_TOOLS_DIR` to the directory that contains `bin/crane` (or set `HARBOR_CRANE` to the binary) so the live script can push one OCI image.

`npm run ci` typechecks, lints, tests, and builds. `node scripts/gen-operations.mjs --check` reports 62 mapped routes, 146 excluded, 62 tool actions, and 208 spec routes.

Run `unset DATABASE_URL`, set `HARBOR_URL`, `HARBOR_USERNAME`, and `HARBOR_PASSWORD` or `HARBOR_PASSWORD_FILE`. Then run `npm run live-check`. The script never prints the password.

## License

MIT. Harbor itself is Apache-2.0. This connector only talks to the published REST API.
