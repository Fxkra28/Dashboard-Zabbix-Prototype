# 5. Backend (BFF): file by file

[setup.md](../../setup.md) · previous: [§4](04-the-logics-that-match-zabbix.md) · next: [§6](06-frontend-structure.md)

Location: [`server/src/`](../../server/src/). Stack: Node 24 + Fastify 5 + TypeScript (ESM).

## Three layers

[`index.ts`](../../server/src/index.ts) builds the app and mounts the route plugins. A file in
[`routes/`](../../server/src/routes/) is the HTTP side of one area: it names the paths, checks the query or the
body, calls that area's function in [`services/`](../../server/src/services/), and sends the answer or the status.
A file in `services/` holds what the area knows: the Zabbix reads, the roll-ups, the cache keys, the prompts. It
takes plain arguments and returns plain values, so a test calls it without starting a server. What the services
share is in five folders of `server/src/` (below) and in `sli/` and `export/`. `index.ts` is the only file at the top.

The dependencies run one way: `index.ts`, then `routes/`, then `services/`, then the shared files.
[`layering.test.ts`](../../server/src/__tests__/layering.test.ts) fails when a file other than `index.ts`
imports a route, when a service imports a route, or when a route file exports anything but its registrar. A route
therefore never reaches into another route, and what two routes both need has to live in a service. The same test
keeps `core/` free of every other folder, keeps routes and services out of the shared folders (but for the stream
count that the health check reads), lets only `index.ts` import `http/` (but for the one sentence two services show
when Zabbix cannot be read), and fails on a new file at the top of `server/src/`. The reasons are in
[ADR-0013](../architecture/adr/0013-layers-features-and-tools.md).

## The shared files

Five folders, each holding one kind of file. A folder says what its files are for, so a file is found by asking
what it does, not by scanning a list of twenty-six.

### `core/`: what the rest stands on

It imports nothing from the other folders.

| File | Responsibility |
|------|----------------|
| [`config.ts`](../../server/src/core/config.ts) | Typed env (ZBX_URL/TOKEN, timeouts, port, CORS origin, proxy trust, rate limit, network group ids, report thresholds, auth, AI). Warns on incomplete config; throws on an authenticated server whose `JWT_SECRET` is a value published in this repo or shorter than 32 bytes. |
| [`cache.ts`](../../server/src/core/cache.ts), [`staleness.ts`](../../server/src/core/staleness.ts) | TTL `Map` cache + in-flight coalescing (concurrent misses for the same key await one fetch, so polling can't stampede Zabbix), plus `invalidate(prefix)` used after a write-back. Bounded to 500 entries and about 64 MB, and closed SLA months can be pinned (§26). `staleness.ts` adds `X-Data-Stale` and `X-Data-Age-Seconds` to an answer that is an old copy kept because Zabbix failed (§26). |
| [`gate.ts`](../../server/src/core/gate.ts) | `createGate(n)`, which lets n jobs run at once and queues the rest (the heavy reports). |
| [`validate.ts`](../../server/src/core/validate.ts), [`schemas.ts`](../../server/src/core/schemas.ts) | Query-string parsing for the routes (`intParam`, `requireId`, `optionalId`: a missing id or a non-numeric window is a 400, not an opaque Zabbix 500), and the JSON Schema of every POST body. [`acceptEncoding.ts`](../../server/src/core/acceptEncoding.ts) weighs a client's `Accept-Encoding`, for the JSON compression and the live stream. |

### `clients/`: what the portal calls out to

| File | Responsibility |
|------|----------------|
| [`zabbix.ts`](../../server/src/clients/zabbix.ts) | The only place Zabbix tokens are used. `zbx()` reads with `ZABBIX_API_TOKEN`; `zbxWrite()` writes with the separate `ZABBIX_WRITE_TOKEN` (§20). Raises `ZabbixAuthError` when a token is rejected and `ZabbixTimeoutError` when Zabbix does not answer within `ZABBIX_TIMEOUT_MS`: `fetch` has no default timeout, so without that ceiling one hung Zabbix holds every page open. |
| [`ai.ts`](../../server/src/clients/ai.ts) | The only place a model credential is used: the LLM analog of `zabbix.ts`. `humanize(kind, payload)` returns schema-validated JSON. Two backends behind `AI_PROVIDER`: hosted Claude, or any OpenAI-compatible server (a local Ollama). |
| [`limits.ts`](../../server/src/clients/limits.ts) | Per-user caps on the model's use: calls a minute, and for the hosted model the tokens a day. |

### `domain/`: what a host, a site and a problem are

| File | Responsibility |
|------|----------------|
| [`naming.ts`](../../server/src/domain/naming.ts) | What a host's name says about it: its site and its class, by HCML's `<site>.<class>.<seq>` convention. |
| [`reachability.ts`](../../server/src/domain/reachability.ts) | One reachability state per host, ping first. |
| [`queries.ts`](../../server/src/domain/queries.ts) | Shared `getProblems()` (host-enriched) and `getHostsWithMeta()` (tags + inventory + groups). Reused by REST, SSE, Sites and the scorecard. |

### `security/`: who may do and see what

| File | Responsibility |
|------|----------------|
| [`auth.ts`](../../server/src/security/auth.ts) | JWT login (10 attempts a minute per account) + RBAC (viewer / operator / admin) + `onRequest` guard, and `assertUsers()`, which stops an authenticated server starting with an empty or `admin` password. See [§19](19-authentication-rbac.md#19-authentication--rbac). |
| [`passwords.ts`](../../server/src/security/passwords.ts), [`pageAccess.ts`](../../server/src/security/pageAccess.ts), [`viewerPolicy.ts`](../../server/src/security/viewerPolicy.ts) | How a portal password is stored (plain, or a scrypt hash); every page of the menu with the API route that fills it, so the sidebar and the guard cannot disagree; what a viewer may not read through the generic routes. |

### `http/`: what `index.ts` wires in around the routes

| File | Responsibility |
|------|----------------|
| [`errors.ts`](../../server/src/http/errors.ts) | Typed failure → HTTP mapping, in one place: `ZabbixAuthError`/`ZabbixTimeoutError`/write-disabled → 503, AI upstream → 502, anything else → 500. Separate from `index.ts` so tests can mount it without starting a server. It also holds the one sentence a screen shows when Zabbix cannot be read, which two services use. |
| [`health.ts`](../../server/src/http/health.ts) | `GET /api/health`: liveness, version, build, and `ready`, the cached answer to whether Zabbix (and a local model) respond. Public, and 200 even when Zabbix is down. `GET /api/ready`, for a monitor that signs in: the same check, answered 503 while Zabbix cannot be read. |
| [`shutdown.ts`](../../server/src/http/shutdown.ts) | Closes the BFF on `SIGTERM` and `SIGINT`: live streams end first, the process exits when `app.close()` finishes, and after 8 s at most, inside Docker's 10 s stop timeout. A second signal exits at once. |
| [`rateLimit.ts`](../../server/src/http/rateLimit.ts), [`requestId.ts`](../../server/src/http/requestId.ts), [`compress.ts`](../../server/src/http/compress.ts), [`hostCheck.ts`](../../server/src/http/hostCheck.ts), [`logging.ts`](../../server/src/http/logging.ts), [`noStore.ts`](../../server/src/http/noStore.ts) | The hooks `index.ts` registers ahead of the routes (§23): the global rate limit, with the stream, the health check and sign-out exempt; one request id from nginx to the log line to the error body; Brotli or gzip for the JSON without a dependency; the Host check that only applies with sign-in off; the redaction of a `?token=` from the logged URL; and `Cache-Control: no-store` on every `/api` reply but the health check. |

### The rest of `server/src/`

| File | Responsibility |
|------|----------------|
| [`sli/`](../../server/src/sli/) | The derived monthly SLA (§25): `engine.ts` computes it, `events.ts` reads event history without silent truncation, `intervals.ts` and `time.ts` do the arithmetic, `maintenance.ts` turns Zabbix maintenance into windows, `tree.ts` and `summary.ts` build the service tree and the summary on top. |
| [`export/`](../../server/src/export/) | The report files (§18): `types.ts` is the document model, `slaReport.ts` builds it from the two derived reports, and `pdf.ts` and `xlsx.ts` write it, with `pdfFonts.ts`, `logo.ts`, `zip.ts` and `theme.ts` beneath them. No library. |
| [`index.ts`](../../server/src/index.ts) | Builds the Fastify app and registers, in this order: helmet → CORS → rate limit → compression → no-store → stale headers → health → auth → the 22 route plugins (they hold 39 of the 45 endpoints; sign-in is in `security/auth.ts`, the health check and `/api/ready` in `http/health.ts`). Validates config before listening and exits rather than booting unsafely, and installs the `SIGTERM` handler once it listens. |
| [`server/src/__tests__/`](../../server/src/__tests__/) | 1688 vitest tests. Zabbix is mocked at `clients/zabbix.ts`, the one point all API traffic funnels through. See [§22](22-testing.md#22-testing). |

## The routes and their services

Each row is one area: its route file, which is the HTTP side, and its service file, which holds the logic. A row with
only a route has no logic of its own to hold.

| Route · service | Responsibility |
|-----------------|----------------|
| [`routes/hosts.ts`](../../server/src/routes/hosts.ts) · [`services/hosts.ts`](../../server/src/services/hosts.ts) | `/api/hosts`, `/api/hosts/overview`, `/api/hostgroups`, `/api/items`, `/api/latest`. The route checks the ids and the paging and cuts the interface items from a viewer's answer; the service reads Zabbix. `getHostOverview()` is shared with the Devices service. |
| [`routes/devices.ts`](../../server/src/routes/devices.ts) · [`services/devices.ts`](../../server/src/services/devices.ts) | `/api/devices`: every host as a device of one kind, from the overview and the templates (MT-01). |
| [`routes/topHosts.ts`](../../server/src/routes/topHosts.ts) · [`services/topHosts.ts`](../../server/src/services/topHosts.ts), [`routes/webMonitoring.ts`](../../server/src/routes/webMonitoring.ts) · [`services/webMonitoring.ts`](../../server/src/services/webMonitoring.ts) | `/api/reports/top-hosts`: the busiest hosts by CPU and by memory. `/api/reports/web-monitoring`: the web scenarios that pass, fail or have no current result, and the failed ones. Current figures only (MT-08). |
| [`routes/meters.ts`](../../server/src/routes/meters.ts) · [`services/meters.ts`](../../server/src/services/meters.ts) | `/api/net/meters`: the gauge widgets of a Zabbix dashboard as internet traffic meters. The route is the cache around `getMeters()`; the service reads the widgets, the scale and the zones, and decides what a reading is (MT-03, ADR-0012). |
| [`routes/problems.ts`](../../server/src/routes/problems.ts) | `/api/problems` (cached 5 s). The read is `getProblems()` in `queries.ts`, so this area has no service of its own. |
| [`routes/history.ts`](../../server/src/routes/history.ts) · [`services/history.ts`](../../server/src/services/history.ts) | `/api/graph`: chart-ready series for 1 to 4 items, from raw history up to a day and from hourly trends above it. `/api/history` and `/api/trend` were removed on 12 October 2026 (BK-11): the web app never called them. |
| [`routes/net.ts`](../../server/src/routes/net.ts) · [`services/net.ts`](../../server/src/services/net.ts) | `/api/net/devices` (+ ICMP) and `/api/net/interfaces`. `/api/net/ports`, `/api/net/status` and `/api/net/map` were removed on 12 October 2026 (BK-11). |
| [`routes/reports.ts`](../../server/src/routes/reports.ts) · [`services/reports.ts`](../../server/src/services/reports.ts) | `/api/reports/top-triggers`, `/api/stats`, `/api/freshness`, `/api/reports/problems-by-group`. |
| [`routes/maps.ts`](../../server/src/routes/maps.ts) · [`services/maps.ts`](../../server/src/services/maps.ts) | `/api/maps` (list), `/api/maps/detail` (topology). |
| [`routes/stream.ts`](../../server/src/routes/stream.ts) · [`services/stream.ts`](../../server/src/services/stream.ts) | `/api/stream`, SSE, pushes live problems when they change (a list identical to the last is never resent) + a `ping` keep-alive that carries the list's age. The route opens the stream; the service holds the shared 5 s ticker, the frames, and the caps per screen count (`STREAM_MAX_CLIENTS`, `STREAM_MAX_PER_USER`). A stream ends when the token expires. A screen that accepts gzip gets the frames compressed, flushed after each one. Shares the `problems` cache key, so N screens cost one poll. |
| [`routes/sites.ts`](../../server/src/routes/sites.ts) · [`services/sites.ts`](../../server/src/services/sites.ts) | `/api/sites`, rolls every host up to a site, plus site-mapping coverage. |
| [`routes/services.ts`](../../server/src/routes/services.ts) · [`services/services.ts`](../../server/src/services/services.ts) | `/api/services`: the service hierarchy with roll-up status, root causes and SLA. `/api/services/derived`: the tree derived from the estate (§25). |
| [`routes/sla.ts`](../../server/src/routes/sla.ts) · [`services/sla.ts`](../../server/src/services/sla.ts) | `/api/sla`, `/api/sla/sli`, `/api/sla/source`, Zabbix Services → SLA, read-only. |
| [`routes/inventory.ts`](../../server/src/routes/inventory.ts) · [`services/inventory.ts`](../../server/src/services/inventory.ts) | `/api/reports/inventory`: the standardisation scorecard (admin only). |
| [`routes/links.ts`](../../server/src/routes/links.ts) · [`services/links.ts`](../../server/src/services/links.ts) | `/api/links`, SD-WAN / radio / Starlink link health from ICMP items. |
| [`routes/analytics.ts`](../../server/src/routes/analytics.ts) · [`services/availability.ts`](../../server/src/services/availability.ts), [`noise.ts`](../../server/src/services/noise.ts), [`aging.ts`](../../server/src/services/aging.ts), [`capacity.ts`](../../server/src/services/capacity.ts), [`incidents.ts`](../../server/src/services/incidents.ts), [`reportPolicy.ts`](../../server/src/services/reportPolicy.ts) | `/api/reports/availability`, `/api/reports/aging`, `/api/reports/capacity`, `/api/reports/noise`, one service per report. `incidents.ts` holds the shared `fetchIncidents()` that backs availability and noise, and the report windows; `reportPolicy.ts` the cache lifetimes and the cap on heavy reports at once. One file until 19 October (ST-07). |
| [`routes/actions.ts`](../../server/src/routes/actions.ts) · [`services/actions.ts`](../../server/src/services/actions.ts) | `/api/problems/acknowledge`: the portal's only write (§20). The handler stays in the route, because it is request and reply from top to bottom and holds the one `zbxWrite()` call; the service has the action bits, the log trail and the cache keys a write drops. |
| [`routes/explain.ts`](../../server/src/routes/explain.ts) · [`services/explain.ts`](../../server/src/services/explain.ts) | `/api/explain/problem`, `/api/explain/sla`: the plain-language layer. On-demand + cached. A service answers `{ notFound }` and the route turns it into a 404. |
| [`routes/chat.ts`](../../server/src/routes/chat.ts) · [`services/chat.ts`](../../server/src/services/chat.ts), [`services/assistant.ts`](../../server/src/services/assistant.ts) | `POST /api/chat`, validates the conversation, then streams `context` → `token`… → `done` as SSE. A POST that performs no write. `GET /api/chat/warm` asks the model to load now, so the first question does not wait for it. `services/chat.ts` is what the route needs (reading the turns, the warm-up, the message a user may see); `assistant.ts` is the one entry to the assistant itself, and re-exports from six files beside it: `assistantSnapshot.ts` (`buildSnapshot()` renders the estate as capped plain text from the pages' own caches, and `getSnapshot()` freezes it), `assistantAnswer.ts` (`streamAnswer()` streams the model's reply for either backend), `assistantPrompt.ts` (the rules and the language), `assistantLines.ts`, `assistantFacts.ts` and `assistantFocus.ts` (the block for a site the question names). No tools, no writes. See [§24](24-assistant.md#24-assistant-chat). |
| [`routes/sli.ts`](../../server/src/routes/sli.ts) · [`services/sli.ts`](../../server/src/services/sli.ts) | `/api/sli`: the derived monthly SLA, computed in the portal from ICMP triggers (§25). |
| [`routes/sliExport.ts`](../../server/src/routes/sliExport.ts) · [`services/sliExport.ts`](../../server/src/services/sliExport.ts) | `GET /api/sli/export`: the monthly SLA report as a PDF or an Excel file, built from the same cached figures as `/api/sli`, and reused for ten seconds (§18). |

## Endpoint reference (+ cache TTLs)

| Method + path | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{ ok, ts, ai, writeBack, defaults, version, startedAt, build, ready, streams }`: capability flags (the UI hides actions that aren't configured), the build, whether Zabbix answers, and the screens streaming. Public; 200 even when Zabbix is down | `ready` 15 s |
| `GET /api/ready` | the same facts as a signed-in `/api/health`, plus `ok`; answers 503 while the portal cannot read Zabbix, so a monitor that holds a token needs only the status code. Guarded like any route | `ready` 15 s |
| `GET /api/hosts` | hosts + interfaces (ip/type/available) | 30 s |
| `GET /api/hosts/overview` | hosts + per-host problem severity counts | 15 s |
| `GET /api/hostgroups` | host groups (real hosts only) | 60 s |
| `GET /api/items?hostid=&search=` | items of a host | 30 s |
| `GET /api/latest?hostid=\|groupid=&search=` | items + last value/time/prev | 15 s |
| `GET /api/problems` | enriched current problems | 5 s |
| `GET /api/net/devices` | network hosts + ICMP up/loss/latency | 30 s |
| `GET /api/net/meters` | the gauge widgets of a Zabbix dashboard as meters: item, capacity, colour zones, last value (operator) | 30 s, the dashboard 2 min |
| `GET /api/devices` | every host with its kind of device and template, as the Hosts page lists it | 30 s |
| `GET /api/reports/top-hosts?limit=` | the hosts with the highest CPU and memory use now, 10 each unless asked (up to 20) | 30 s |
| `GET /api/reports/web-monitoring?limit=` | web scenarios that pass, fail or have no current result, and the failed ones (10 unless asked, up to 50) | 30 s |
| `GET /api/reports/top-triggers?days=` | top 100 triggers by event count | 60 s |
| `GET /api/stats` | monitored host, item, trigger and group counts + problem counts | 30 s |
| `GET /api/freshness` | when Zabbix last collected a value: `{ lastCollectedAt, ageSeconds, stale, staleAfterSeconds }` | 30 s |
| `GET /api/reports/problems-by-group` | severity breakdown per host group | 15 s |
| `GET /api/maps` | map list | 60 s |
| `GET /api/maps/detail?mapid=` | one map's elements + links | 30 s |
| `GET /api/sites` | sites + rolled-up health + hosts, worst first | 15 s |
| `GET /api/sla` | configured SLAs (name, SLO, period) | 60 s |
| `GET /api/sla/sli?slaid=&serviceid=` | current-period SLI per service | 60 s |
| `GET /api/services` | service tree + roll-up status, root causes, SLA | 30 s |
| `GET /api/links` | ICMP link health, loss/latency/jitter, redundant paths | 20 s |
| `GET /api/reports/inventory` | standardisation scorecard + gap list *(admin)* | 60 s |
| `GET /api/reports/availability?days=&severity=` | per-host uptime over a window | 120 s |
| `GET /api/reports/aging` | unacknowledged problems by age | 15 s |
| `GET /api/reports/capacity?days=&top=` | CPU / memory / filesystem trends | 300 s |
| `GET /api/reports/noise?days=&severity=` | flapping / unactioned / chronic triggers | 120 s |
| `POST /api/problems/acknowledge` | acknowledge and/or close (operator) | writes |
| `GET /api/explain/problem?eventid=` | plain-language summary + tag glossary | 1 h |
| `GET /api/explain/sla?slaid=&serviceid=` | plain-language SLA standing | 5 min |
| `POST /api/chat` | SSE assistant answer: `context` → `token`… → `done` / `error`. See [§24](24-assistant.md#24-assistant-chat) | snapshot reads share the page caches |
| `GET /api/stream` | SSE live problems | live |
| `POST /api/auth/login` | `{ user, expiresIn }`; the token goes into the httpOnly session cookie, never the body (§8) | none |
| `GET /api/auth/me` | `{ authEnabled, user: { name, role }, expiresIn }`, drives the sidebar's role filter and times renewal | none |
| `POST /api/auth/refresh` | a fresh cookie and `{ user, expiresIn }` for a still-valid session, so an open portal stays signed in (§8) | none |
| `POST /api/auth/logout` | clears the session cookie; public, so an expired session can still sign out | none |
| `GET /api/graph` | chart-ready series for 1 to 4 numeric items over a pinned window | 15 s for a window that ends now, 10 min for one that does not |
| `GET /api/net/interfaces?hostid=` | SNMP interfaces with oper/admin status, speed, utilisation | 15 s |
| `GET /api/sli?month=&profile=` | the derived monthly SLA (§25) | 24 h for a closed month, 5 min for the current one |
| `GET /api/sli/export?month=&format=` | the monthly SLA report as a PDF or Excel file, not JSON (§18) | none of its own beyond ten seconds of reuse: it reads the cached reports `/api/sli` fills |
| `GET /api/sla/source` | which SLA backing is in use: Zabbix services, or derived | 60 s |
| `GET /api/services/derived?month=&profile=` | the service tree derived from the estate | 30 s |
| `GET /api/chat/warm` | 202; asks the model to load now so the first question does not wait | none |

The two `/api/explain/*` routes are the only ones that cost money, so they have by far the longest
TTLs: a problem's meaning doesn't change while it's open.

> **This table is a reading aid, not the contract.** The contract is
> [`docs/api/openapi.yaml`](../api/openapi.yaml): every parameter, every status code, both
> security schemes and every response schema. It is checked against the code by
> `npx tsx tools/check/openapi.check.ts`, which fails if a route is registered and undocumented or
> documented and unregistered. The table had no check of its own, which is how it once said "16 modules,
> 35 endpoints" while listing all of them, and how it carried a duplicate `GET /api/auth/me` row
> until 22 Sep 2026. Since 20 October 2026 `tools/check/facts.check.mjs` compares its rows with the spec, one for one
> (the cache column and the descriptions are still read by a person).
