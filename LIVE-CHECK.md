# Live check

Checked 12 Nov 2026 against isolated **Harbor v2.16.0** core built from the official source tarball, plus portable Postgres 17.6 and Redis 7.4.2 compiled from source. No Docker, no apt. All listeners were loopback only after `start.sh` set Beego `httpaddr = 127.0.0.1`:

| Process     | Address           |
| ----------- | ----------------- |
| Harbor core | `127.0.0.1:18080` |
| Postgres    | `127.0.0.1:15432` |
| Redis       | `127.0.0.1:16379` |

Throwaway data dir and secrets live under `/tmp/harbor-mcp` (chmod 700/600, outside this repo). Admin password is `/tmp/harbor-mcp/secrets/admin.password` mode 0600. `scripts/live-check.mjs` speaks to `dist/index.js` over stdio. The script unsets `DATABASE_URL`. It redacts the admin password and any robot secret from every printed line.

Portal, jobservice, registry, and registryctl were **not** started in this first run. Health JSON reports those components unhealthy (`dial tcp 127.0.0.1:18081` for jobservice). Artifact push, tag-on-digest, scan trigger, and GC run were not live-verified.

A later run the same day started the registry and registryctl and repeated the live check. That section is below. This first-run record is unchanged.

## How to rerun

```bash
unset DATABASE_URL
/workspace/tools/harbor/start.sh
cd /workspace/connectors/harbor
export HARBOR_URL=http://127.0.0.1:18080
export HARBOR_USERNAME=admin
export HARBOR_PASSWORD_FILE=/tmp/harbor-mcp/secrets/admin.password
export HARBOR_TOOLS_DIR=/workspace/tools/harbor
unset HARBOR_PASSWORD
npm run live-check
/workspace/tools/harbor/stop.sh
```

`HARBOR_PASSWORD` may replace the file. A missing password exits 1. The script prints pass and fail lines. It does not print the password or a robot secret. Local budget is `HARBOR_PER_MINUTE=600`. `HARBOR_CACHE_TTL_SEC=0`.

## First-start notes

- Admin Basic auth failed when the password file kept a trailing newline (`Login failed, locking admin` / `Invalid credentials` in core.log). `$(cat file)` in `start.sh` already strips the newline for Harbor; probes must `trim()`. `start.sh` now strips secret files.
- `GET /api/v2.0/projects` returns 200 for anonymous public list. `GET /users/current` and `POST /projects` need valid Basic auth.
- Harbor hashed the admin password on first boot (`User id: 1 updated its encrypted password successfully`).
- Label create returns HTTP 201 with an empty body. The live-check lists labels by name to recover the id. First live-check run failed `label create` / `label delete` for that reason; the follow-up GET-by-name path passed.
- Robot create returned a 32-character secret in the tool result. Stderr did not contain it (`logs_clean=true`).
- `GET` artifacts on `mcpchk/scratch` returned real HTTP 404 (`repository mcpchk/scratch not found`) because no registry/distribution process is running and no image was pushed.

## Results (stable rerun)

`live-check 21 passed, 0 failed` twice: after the label-id fix, and again after `stop.sh` / `start.sh`.

| Check                    | Result                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| tool list                | six tools                                                                     |
| ping                     | `"Pong"`                                                                      |
| health                   | core/database/redis healthy; jobservice/portal/registry/registryctl unhealthy |
| systeminfo               | `auth_mode=db_auth`, `external_url=http://127.0.0.1:18080`                    |
| current_user             | `username=admin`, `sysadmin_flag=true`                                        |
| statistics               | counts only                                                                   |
| search                   | library + live projects                                                       |
| projects list            | array wrapped as `items`                                                      |
| missing project          | MCP `[not-found]` from real HTTP 404                                          |
| create project preview   | `executed=false`, follow-up GET 404                                           |
| create project blocked   | `HARBOR_ALLOW_WRITES=false` + `confirm:true`, follow-up GET 404               |
| create project confirmed | follow-up GET 200                                                             |
| create conflict          | real HTTP 409                                                                 |
| project summary          | `repo_count=0`                                                                |
| label create / delete    | global label on throwaway name                                                |
| robot create / delete    | secret shown once, length 32, not in logs                                     |
| artifacts list           | real HTTP 404, no registry                                                    |
| delete project confirmed | follow-up GET 404                                                             |
| bad password             | MCP `[unauthorized]` from real HTTP 401                                       |

## Real vs simulated HTTP statuses

Recorded by the live script against this v2.16.0 core:

| Status | Where                                                                                                  | Real?                                    |
| ------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 200    | ping, health, systeminfo, current_user, statistics, search, list/get project after create              | real                                     |
| 201    | project create, label create, robot create (empty or JSON body)                                        | real                                     |
| 401    | wrong password on `/users/current`                                                                     | real                                     |
| 404    | missing project, create preview/blocked follow-up, missing repo `mcpchk/scratch`, project after delete | real                                     |
| 409    | second `POST /projects` with the same name                                                             | real                                     |
| 403    | not observed live                                                                                      | unit test simulated                      |
| 422    | not observed live                                                                                      | unit test simulated                      |
| 429    | **not forced live**                                                                                    | unit test simulated, one fetch, no retry |

## Failed attempts kept

1. Admin Basic with trailing newline in the password file → 401 `Invalid credentials`, Harbor lockout sleep 1.5s.
2. First live-check: `label create` executed (201 empty body) so `id` was missing; `label delete` skipped. Fixed by listing labels by name. Leftover label id 1 was deleted on the next run before recreate.

## Shutdown

`/workspace/tools/harbor/stop.sh` kills only PID files under `/workspace/tools/harbor/run` and `pg_ctl stop` on `/tmp/harbor-mcp/pgdata`. After stop, ports 18080, 15432, 16379, 15000, 18081, and 18082 were closed.

## Registry run (12 Nov 2026, about 10:27 Accra)

Same slot, same data dir. Distribution is `goharbor/distribution` tag `v2.8.3-harbor.3` (the v2.16.0 Makefile `REGISTRY_SRC_TAG`), built with `go build` into `/workspace/tools/harbor/bin/registry`. `registryctl` is the Harbor binary rebuilt to listen on `127.0.0.1` only (the upstream binary binds `:` + port). Listeners after `start.sh`:

| Process | Address | Health |
| --- | --- | --- |
| Harbor core | `127.0.0.1:18080` | healthy |
| Postgres | `127.0.0.1:15432` | healthy |
| Redis | `127.0.0.1:16379` | healthy |
| distribution registry | `127.0.0.1:15000` (debug `127.0.0.1:15001`) | healthy |
| registryctl | `127.0.0.1:18082` | healthy |
| jobservice | not started | unhealthy |
| portal | not started | unhealthy |

Registry config follows `make/photon/prepare/templates/registry/config.yml.jinja`: filesystem storage under `/tmp/harbor-mcp/registry/storage`, Redis db 1 for the layer cache, htpasswd user `harbor_registry_user`, `validation.disabled`, schema1 compatibility. Core's `/v2/` proxy sends that basic auth. Distribution allows one auth driver, so token auth is not also configured. Clients still get `Bearer realm="http://127.0.0.1:18080/service/token",service="harbor-registry"` from core. The token key is PKCS#1 (`BEGIN RSA PRIVATE KEY`) because `docker/libtrust` rejects OpenSSL 3's default PKCS#8 `BEGIN PRIVATE KEY`.

`crane append --insecure --oci-empty-base` pushes a one-file image to `127.0.0.1:18080/mcpchk/team/app:live`. The docker config is mode 0600 under `/tmp` and is deleted after the push. Core then lists repository `mcpchk/team/app` and an artifact whose digest starts with `sha256:`.

`npm run ci` is green: 45 vitest tests. `node scripts/gen-operations.mjs --check` and `--check --source-root /tmp/harbor-build/harbor-2.16.0` both report 62 mapped, 146 excluded, 208 spec routes.

`live-check 45 passed, 0 failed` twice: once on the running stack, and again after `stop.sh` / `start.sh`.

| Check | Result |
| --- | --- |
| previous project/robot/label/401/404/409 checks | still pass |
| crane push | real OCI image, repository name `team/app` |
| repositories list/get | name `mcpchk/team/app` |
| repository update preview/blocked | description unchanged |
| repository update confirmed | description `live-desc` |
| artifacts list/get | by digest and by tag `live` |
| tags list | includes `live` |
| tag create preview/blocked | tag absent afterwards; preview path contains `team%252Fapp` and `sha256%3A` |
| tag create confirmed / delete confirmed | extra tag `mcpextra` appears, then is gone; `live` remains |
| label add preview/blocked | `with_label=true` get does not include the label |
| label add/remove confirmed | label id present, then absent |
| artifact delete preview/confirmed | follow-up GET 200, then 404 |
| repository delete preview/confirmed | follow-up GET 200, then 404 |
| limited robot | project robot with pull on `mcpchk` only; GET private project `mcpdeny` is HTTP 403; secret length 32; `logs_clean=true` |
| delete throwaway projects | follow-up GET 404 |

## Real vs simulated HTTP statuses (registry run)

| Status | Where | Real? |
| --- | --- | --- |
| 200 | reads, get after create, get after delete previews, private project get | real |
| 201 | project create, label create, tag create, robot create (empty or JSON body) | real |
| 401 | wrong password on `/users/current` | real |
| 403 | project-scoped robot GET private project `mcpdeny` | real |
| 404 | missing project, create preview/blocked follow-up, artifact after delete, repository after delete, project after delete | real |
| 409 | second `POST /projects`; second `POST` of tag `mcpextra` | real |
| 422 | not observed live | unit test simulated |
| 429 | **not forced live** | unit test simulated, one fetch, no retry |

## Failed attempts kept (registry run)

1. `registry serve` panicked `multiple storage drivers specified in configuration or environment: filesystem, provider` because Harbor core's `REGISTRY_STORAGE_PROVIDER_NAME` was in the environment. The process is now started with `env -i`.
2. `GET /service/token` returned HTTP 500 `unable to get PrivateKey from PEM type: PRIVATE KEY` until the core key was rewritten with `openssl pkey -traditional`. `start.sh` now generates keys with `openssl genrsa -traditional`.
3. A notifications endpoint at `http://127.0.0.1:18080/service/notifications` (core secret bearer, as in older `reg_conf_test.yml`) returned HTTP 404. The registry retry sink logged `response status 404 Not Found` and backed off. v2.16 core records the artifact in the `/v2` manifest handler and the prepare template does not configure that sink. The endpoint was removed after the two green live checks. Pushes already succeeded without it.
4. The first extended live-check was `44 passed, 1 failed`: label add had executed, but artifact get omitted labels (Harbor's `with_label` default is false). `get` and `list` now accept `with_label`. The next two runs passed.
5. Deleting a project that still has a repository returned HTTP 412 on a manual probe. The live script deletes the repository first.

## Shutdown (registry run)

After the second green live-check, `stop.sh` stopped the owned processes. Ports 18080, 15432, 16379, 15000, 15001, 18081, and 18082 were closed.

## 2026-11-12 coordinator independent review rerun

- Source `npm run ci` green: **45 tests in 10 files**. Generator: 62 mapped, 146 excluded, 208 swagger operations.
- SIMULATED leak matrix through the real MCP SDK client (fake fetch): 130 cases. It covered robot `refresh_secret` and `create` with a supplied `secret`, project create with a nested registry `access_secret`, a deeply nested `password`, and URL userinfo in a label description. Each ran with 6 value shapes (1, 2, 5, 7, 8 and 73 characters, with quotes, `/`, `%`, `&`) and 5 paths (JSON 422, text 500, 200 echo, network error, preview). Zero leaks in MCP output or logs, and zero HTTP calls on previews.
- Live rerun on the isolated stack (core 127.0.0.1:18080, Postgres :15432, Redis :16379, distribution :15000, registryctl :18082, all loopback): `npm run live-check` **45 passed, 0 failed**. The first rerun attempt had 4 failures only because `crane` was not on PATH (`spawnSync crane ENOENT`). With `HARBOR_CRANE` set it was green.
- Live robot leak probe over MCP stdio:
  - A refresh preview with a custom secret did not echo it.
  - A system robot was created, and its issued secret came back once in the create result only. A later `get` did not include it.
  - A custom-secret refresh succeeded.
  - A 3-character secret got a real HTTP **400**, returned as the generic short-credential message.
  - A 73-character refresh succeeded. The robot was deleted.
  - 8 runtime credentials plus the probe values had zero hits in other tool results or server stderr, checked in raw, percent-encoded (both cases) and JSON-escaped forms.
- Rotation note: during this review the throwaway token-signing key and certificate under `/tmp/harbor-mcp/secrets` were exposed in a coordinator scan's console output. Both were deleted and regenerated by `start.sh` before the green rerun. They were only ever used by this loopback stack.
