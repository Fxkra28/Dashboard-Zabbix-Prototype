# setup.md: How the HCML Monitoring Portal Works

A deep-dive into the architecture, data flow, and the Zabbix-native features this portal
re-implements. Read [README.md](README.md) first for installation and configuration; this document
explains *how it all fits together* and *why*.

It is the reference you grep, not the one you read front to back: 31 sections, one per subsystem.
Sections 14 to 26 are the only written record of why the derived figures are calculated the way they
are, so they matter most when a number has to be defended.

**§§27 to 29 were reconstructed on 22 September 2026**, not restored. They cover the limitations, the
glossary and HCML's six goals: the three things lost when `DOCUMENTATION.md` was deleted on 21
September without ever having been committed. Each says what it was rebuilt from.

For the API contract go to [`docs/api/openapi.yaml`](docs/api/openapi.yaml), which is checked against
the code; for *why* the system is shaped this way go to
[`docs/architecture/adr/`](docs/architecture/adr/).

> On the section citations in the code. Comments across `server/src` and `web/src` cite sections
> of this file: `setup.md §9`, `§20`, `§18` and so on. Until 21 Sep 2026 they cited `instruct.md`,
> the original build brief, which lives outside both repos at `myown/plan/instruct.md` and so
> could not be followed from a clone. The rules themselves did not change; the citations now point at
> the in-repo document that carries them.


---

## 1. The big picture

The portal is a read-only, branded front-end for Zabbix. Zabbix keeps doing what it's good at:
collecting metrics (agents, SNMP, ICMP), evaluating triggers, storing history. The portal is a
separate app that reads that data through the Zabbix JSON-RPC API and presents it as an
HCML-branded NOC dashboard.

```
 ┌─────────────────────────┐   HTTP + SSE       ┌──────────────────────────┐   JSON-RPC 2.0    ┌───────────────┐
 │  Browser (React SPA)     │ ─────────────────► │  BFF  (Fastify + TS)      │ ────────────────► │  Zabbix API    │
 │  http://localhost:5173   │ ◄───────────────── │  http://localhost:4000    │ ◄──────────────── │  :8080         │
 │  • no token              │   /bff/api/*       │  • holds the token        │  host.get, ...    │  → PostgreSQL  │
 │  • never talks to Zabbix │                    │  • caches, aggregates     │                   └───────────────┘
 └─────────────────────────┘                    └──────────────────────────┘
```

The first arrow is plain HTTP on this computer's loopback address: nginx listens on port 8080 inside
its container and Docker publishes it on `127.0.0.1` only. Nothing in this repository terminates
TLS, so before the portal is reached from another machine, put TLS in front of it:
[`docs/operations/tls.md`](docs/operations/tls.md).

Three hard rules drive the whole design (from the original build brief, `myown/plan/instruct.md`
§0, outside both repos, so quoted rather than linked):

1. The browser never calls Zabbix. Only the BFF has the API token.
2. Read-only, least privilege. The portal reads with a dedicated read-only token. The single
   exception is acknowledge/close, which uses a separate write token and is off unless
   configured. See [§20](#20-acknowledge--close-write-back).
3. Cache everything. Every Zabbix call hits its server + DB, so responses are cached with short TTLs.

### Why a BFF (Backend-for-Frontend)?
- Security: the long-lived Zabbix token stays server-side. If it were in the browser, anyone
  could read it from dev-tools and hit Zabbix directly.
- Shaping: Zabbix's API is raw and chatty (e.g. `problem.get` doesn't include host names). The
  BFF *enriches* and *aggregates* so the UI gets exactly the shape it needs in one call.
- Caching: the BFF absorbs repeated/polled requests so a busy dashboard doesn't hammer Zabbix.
- Decoupling: Zabbix upgrades don't break the portal; it only depends on the stable API.

---

## 2. Request lifecycle (a concrete example)

What happens when the Problems page loads:

1. React calls `api.problems()` → `fetch('/bff/api/problems')`. No token in the browser.
2. Dev: Vite's proxy rewrites `/bff/api/problems` → `http://localhost:4000/api/problems`.
   Prod: nginx reverse-proxies `/bff/` → the `portal-bff` container.
3. The BFF route checks its TTL cache (`problems`, 5 s). On a hit it returns instantly.
4. On a miss it calls `getProblems()` which:
   - calls Zabbix `problem.get` (raw problems, no host names),
   - collects the trigger ids, calls `trigger.get` with `selectHosts` once,
   - stitches `hostid` + host `name` onto every problem.
5. The enriched JSON is cached and returned to the browser.
6. React renders the table; a timer re-polls every 30 s.

This "call Zabbix, enrich, cache, serve a clean shape" pattern is the same for every endpoint.

---

## 3. Zabbix-native feature mapping

The sidebar and pages intentionally mirror Zabbix's own Monitoring and Reports menus. Each
portal view maps to Zabbix concepts and API methods:

| Portal page (sidebar)      | Zabbix native equivalent        | BFF endpoint                      | Zabbix API methods used                     |
|----------------------------|---------------------------------|-----------------------------------|---------------------------------------------|
| Dashboard              | Monitoring → Dashboard          | `/api/stats`, `/api/reports/problems-by-group`, `/api/problems` | `host/item/trigger/hostgroup.get` (counts), `problem.get`, `trigger.get` |
| Problems               | Monitoring → Problems           | `/api/problems`                   | `problem.get`, `trigger.get` (host names)   |
| Sites                  | *(none: see [§14](#14-site-view))* | `/api/sites`                  | `host.get` (+ tags, inventory, groups), `problem.get` |
| Hosts                  | Monitoring → Hosts              | `/api/hosts/overview`             | `host.get` (+ interface availability), `problem.get` |
| Latest data            | Monitoring → Latest data        | `/api/latest`                     | `item.get` (lastvalue/lastclock/prevvalue)  |
| Graphs                 | Monitoring → Hosts → Graphs     | `/api/graph`, `/api/items`        | `item.get`, `history.get`, `trend.get`      |
| Maps                   | Monitoring → Maps               | `/api/maps`, `/api/maps/detail`   | `map.get` (selements + links)               |
| Network                | (SNMP/ICMP hosts, §13)          | `/api/net/*`                      | `host.get`, `item.get` (icmp*, net.if.*)    |
| Links & WAN health     | *(none: see [§17](#17-link--wan-health))* | `/api/links`           | `item.get` (icmpping / icmppingloss / icmppingsec) |
| Services               | Services                        | `/api/services`                   | `service.get` (+ children, problem events), `sla.get`, `sla.getsli` |
| SLA                    | Services → SLA                  | `/api/sla`, `/api/sla/sli`        | `sla.get`, `sla.getsli`, `service.get` |
| Availability & response | *(none: see [§18](#18-automated-reporting))* | `/api/reports/availability`, `/api/reports/aging` | `event.get` (problem/recovery pairs) |
| Capacity trends        | Reports → Top 100 (adjacent)    | `/api/reports/capacity`           | `item.get`, `trend.get` → `history.get` fallback |
| Alert noise            | *(none: see [§21](#21-alert-noise--flapping))* | `/api/reports/noise`  | `event.get` (problem/recovery pairs, per trigger) |
| Top 100 triggers       | Reports → Top 100 triggers      | `/api/reports/top-triggers`       | `event.get` (aggregated by trigger)         |
| Inventory & ownership scorecard | *(none: see [§16](#16-inventory--ownership-scorecard))* | `/api/reports/inventory` | `host.get` (+ tags, inventory, groups) |

> Config is deliberately *not* re-implemented. Creating hosts/items/triggers/users stays in
> Zabbix's native UI (the "hybrid" approach). The portal is the read-only NOC view.

Six things have no Zabbix equivalent, and they're the point of the portal:

| View | Why Zabbix can't do it | HCML goal |
|---|---|---|
| "Explain" on Problems and SLA ([§13](#13-plain-language-layer-ai)) | Zabbix speaks to engineers; this speaks to everyone else | Goal 4 |
| Sites board ([§14](#14-site-view)) | Zabbix has no site object: it's derived | Goal 5 |
| Inventory & ownership scorecard ([§16](#16-inventory--ownership-scorecard)) | Zabbix stores the fields but never scores them | Goal 1 |
| Links & WAN health ([§17](#17-link--wan-health)) | Zabbix has items, not *links* with a main/standby relationship | Goal 3 |
| Availability & aging ([§18](#18-automated-reporting)) | Zabbix stores events; turning them into uptime is arithmetic it doesn't do | Goal 6 |
| Alert noise ([§21](#21-alert-noise--flapping)) | Zabbix shows you every alarm; it never tells you which ones weren't worth sending | Goal 4 |

---

## 4. The "logics" that match Zabbix

Beyond layout, the portal reproduces Zabbix's *semantics* so the numbers mean the same thing:

- Severity (`0..5`), Not classified → Disaster, using Zabbix's exact color palette
  ([`web/src/theme.ts`](web/src/theme.ts) `SEVERITIES`). Used everywhere as badges and count chips.
- Host availability: Zabbix 7.0 tracks availability per interface (`available`: 0 unknown,
  1 available, 2 unavailable). The portal rolls interfaces up to a host state (*worst wins*) in
  [`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.
- Problem status & duration: `r_eventid !== '0'` ⇒ *Resolved*, else *Problem*. Duration is
  `recovery_time − onset` (or *now* if still open), matching Zabbix's "Duration" column.
- Acknowledgement: `acknowledged` flag surfaced as a pill and a filter.
- Item value types: `0` float, `1` char, `2` log, `3` uint, `4` text. Only numeric items
  (0/3) are offered for graphing; `history.get` is called with the matching `history` param.
- Interface types: `1` Agent, `2` SNMP, `3` IPMI, `4` JMX (shown on the Hosts page).
- Maintenance: `maintenance_status = 1` renders a "Maintenance" pill.
- Top-100 aggregation: mirrors Zabbix's report by counting `PROBLEM` events per trigger over a
  time window via `event.get`.

---

## 5. Backend (BFF): file by file

Location: [`server/src/`](server/src/). Stack: Node 24 + Fastify 5 + TypeScript (ESM).

| File | Responsibility |
|------|----------------|
| [`config.ts`](server/src/config.ts) | Typed env (ZBX_URL/TOKEN, timeouts, port, CORS origin, proxy trust, rate limit, network group ids, report thresholds, auth, AI). Warns on incomplete config; throws on an authenticated server whose `JWT_SECRET` is a value published in this repo or shorter than 32 bytes. |
| [`zabbix.ts`](server/src/zabbix.ts) | The only place Zabbix tokens are used. `zbx()` reads with `ZABBIX_API_TOKEN`; `zbxWrite()` writes with the separate `ZABBIX_WRITE_TOKEN` (§20). Raises `ZabbixAuthError` when a token is rejected and `ZabbixTimeoutError` when Zabbix does not answer within `ZABBIX_TIMEOUT_MS`: `fetch` has no default timeout, so without that ceiling one hung Zabbix holds every page open. |
| [`ai.ts`](server/src/ai.ts) | The only place a model credential is used: the LLM analog of `zabbix.ts`. `humanize(kind, payload)` returns schema-validated JSON. Two backends behind `AI_PROVIDER`: hosted Claude, or any OpenAI-compatible server (a local Ollama). |
| [`cache.ts`](server/src/cache.ts) | TTL `Map` cache + in-flight coalescing (concurrent misses for the same key await one fetch, so polling can't stampede Zabbix), plus `invalidate(prefix)` used after a write-back. Bounded to 500 entries and about 64 MB, and closed SLA months can be pinned (§26). |
| [`queries.ts`](server/src/queries.ts) | Shared `getProblems()` (host-enriched) and `getHostsWithMeta()` (tags + inventory + groups). Reused by REST, SSE, Sites and the scorecard. |
| [`auth.ts`](server/src/auth.ts) | JWT login (10 attempts a minute per account) + RBAC (viewer / operator / admin) + `onRequest` guard, and `assertUsers()`, which stops an authenticated server starting with an empty or `admin` password. See [§19](#19-authentication--rbac). |
| [`routes/hosts.ts`](server/src/routes/hosts.ts) | `/api/hosts`, `/api/hosts/overview`, `/api/hostgroups`, `/api/items`, `/api/latest`. |
| [`routes/problems.ts`](server/src/routes/problems.ts) | `/api/problems` (cached 5 s). |
| [`routes/history.ts`](server/src/routes/history.ts) | `/api/graph`: chart-ready series for 1 to 4 items, from raw history up to a day and from hourly trends above it. `/api/history` and `/api/trend` were removed on 12 October 2026 (BK-11): the web app never called them. |
| [`routes/net.ts`](server/src/routes/net.ts) | `/api/net/devices` (+ ICMP) and `/api/net/interfaces`. `/api/net/ports`, `/api/net/status` and `/api/net/map` were removed on 12 October 2026 (BK-11). |
| [`routes/reports.ts`](server/src/routes/reports.ts) | `/api/reports/top-triggers`, `/api/stats`, `/api/reports/problems-by-group`. |
| [`routes/maps.ts`](server/src/routes/maps.ts) | `/api/maps` (list), `/api/maps/detail` (topology). |
| [`routes/stream.ts`](server/src/routes/stream.ts) | `/api/stream`, SSE, pushes live problems when they change (a list identical to the last is never resent) + a `ping` keep-alive that carries the list's age. Capped per screen count (`STREAM_MAX_CLIENTS`, `STREAM_MAX_PER_USER`) and ended when the token expires. Shares the `problems` cache key, so N screens cost one poll. |
| [`routes/sites.ts`](server/src/routes/sites.ts) | `/api/sites`, rolls every host up to a site, plus site-mapping coverage. |
| [`routes/services.ts`](server/src/routes/services.ts) | `/api/services`: the service hierarchy with roll-up status, root causes and SLA. |
| [`routes/sla.ts`](server/src/routes/sla.ts) | `/api/sla`, `/api/sla/sli`, Zabbix Services → SLA, read-only. |
| [`routes/inventory.ts`](server/src/routes/inventory.ts) | `/api/reports/inventory`: the standardisation scorecard (admin only). |
| [`routes/links.ts`](server/src/routes/links.ts) | `/api/links`, SD-WAN / radio / Starlink link health from ICMP items. |
| [`routes/analytics.ts`](server/src/routes/analytics.ts) | `/api/reports/availability`, `/api/reports/aging`, `/api/reports/capacity`, `/api/reports/noise`. Shared `fetchIncidents()` backs availability + noise. |
| [`routes/actions.ts`](server/src/routes/actions.ts) | `/api/problems/acknowledge`: the portal's only write (§20). |
| [`routes/explain.ts`](server/src/routes/explain.ts) | `/api/explain/problem`, `/api/explain/sla`: the plain-language layer. On-demand + cached. |
| [`chat.ts`](server/src/chat.ts) | The assistant: `buildSnapshot()` renders the estate as capped plain text from the pages' own caches; `streamAnswer()` streams the model's reply for either backend. No tools, no writes. See [§24](#24-assistant-chat). |
| [`routes/chat.ts`](server/src/routes/chat.ts) | `POST /api/chat`, validates the conversation, then streams `context` → `token`… → `done` as SSE. A POST that performs no write. `GET /api/chat/warm` asks the model to load now, so the first question does not wait for it. |
| [`routes/sli.ts`](server/src/routes/sli.ts) | `/api/sli`: the derived monthly SLA, computed in the portal from ICMP triggers (§25). |
| `routes/sliExport.ts` | `GET /api/sli/export`: the monthly SLA report as a PDF or an Excel file, built from the same cached figures as `/api/sli`, and reused for ten seconds (§18). |
| `export/` | The report files (§18): `types.ts` is the document model, `slaReport.ts` builds it from the two derived reports, and `pdf.ts` and `xlsx.ts` write it, with `pdfFonts.ts`, `logo.ts`, `zip.ts` and `theme.ts` beneath them. No library. |
| [`errors.ts`](server/src/errors.ts) | Typed failure → HTTP mapping, in one place: `ZabbixAuthError`/`ZabbixTimeoutError`/write-disabled → 503, AI upstream → 502, anything else → 500. Separate from `index.ts` so tests can mount it without starting a server. |
| `health.ts` | `GET /api/health`: liveness, version, build, and `ready`, the cached answer to whether Zabbix (and a local model) respond. Public, and 200 even when Zabbix is down. |
| `shutdown.ts` | Closes the BFF on `SIGTERM` and `SIGINT`: live streams end first, the process exits when `app.close()` finishes, and after 8 s at most, inside Docker's 10 s stop timeout. A second signal exits at once. |
| `staleness.ts` | Adds `X-Data-Stale` and `X-Data-Age-Seconds` to an answer that is an old copy kept because Zabbix failed (§26). |
| [`index.ts`](server/src/index.ts) | Builds the Fastify app and registers, in this order: helmet → CORS → rate limit → compression → stale headers → health → auth → the eighteen route plugins. Validates config before listening and exits rather than booting unsafely, and installs the `SIGTERM` handler once it listens. |
| [`server/src/__tests__/`](server/src/__tests__/) | 1508 vitest tests. Zabbix is mocked at `zabbix.ts`, the one point all API traffic funnels through. See [§22](#22-testing). |

### Endpoint reference (+ cache TTLs)

| Method + path | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{ ok, ts, ai, writeBack, defaults, version, startedAt, build, ready, streams }`: capability flags (the UI hides actions that aren't configured), the build, whether Zabbix answers, and the screens streaming. Public; 200 even when Zabbix is down | `ready` 15 s |
| `GET /api/hosts` | hosts + interfaces (ip/type/available) | 30 s |
| `GET /api/hosts/overview` | hosts + per-host problem severity counts | 15 s |
| `GET /api/hostgroups` | host groups (real hosts only) | 60 s |
| `GET /api/items?hostid=&search=` | items of a host | 30 s |
| `GET /api/latest?hostid=\|groupid=&search=` | items + last value/time/prev | 15 s |
| `GET /api/problems` | enriched current problems | 5 s |
| `GET /api/net/devices` | network hosts + ICMP up/loss/latency | 30 s |
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
| `POST /api/chat` | SSE assistant answer: `context` → `token`… → `done` / `error`. See [§24](#24-assistant-chat) | snapshot reads share the page caches |
| `GET /api/stream` | SSE live problems | live |
| `POST /api/auth/login` | `{ user, expiresIn }`; the token goes into the httpOnly session cookie, never the body (§8) | none |
| `GET /api/auth/me` | `{ authEnabled, user: { name, role }, expiresIn }`, drives the sidebar's role filter and times renewal | none |
| `POST /api/auth/refresh` | a fresh cookie and `{ user, expiresIn }` for a still-valid session, so an open portal stays signed in (§8) | none |
| `POST /api/auth/logout` | clears the session cookie; public, so an expired session can still sign out | none |
| `GET /api/graph` | chart-ready series for 1 to 4 numeric items over a pinned window | 15 s |
| `GET /api/net/interfaces?hostid=` | SNMP interfaces with oper/admin status, speed, utilisation | 15 s |
| `GET /api/sli?month=&profile=` | the derived monthly SLA (§25) | 24 h for a closed month, 5 min for the current one |
| `GET /api/sli/export?month=&format=` | the monthly SLA report as a PDF or Excel file, not JSON (§18) | none of its own beyond ten seconds of reuse: it reads the cached reports `/api/sli` fills |
| `GET /api/sla/source` | which SLA backing is in use: Zabbix services, or derived | 60 s |
| `GET /api/services/derived?month=&profile=` | the service tree derived from the estate | 30 s |
| `GET /api/chat/warm` | 202; asks the model to load now so the first question does not wait | none |

The two `/api/explain/*` routes are the only ones that cost money, so they have by far the longest
TTLs: a problem's meaning doesn't change while it's open.

> **This table is a reading aid, not the contract.** The contract is
> [`docs/api/openapi.yaml`](docs/api/openapi.yaml): every parameter, every status code, both
> security schemes and every response schema. It is checked against the code by
> `npx tsx scripts/openapi.check.ts`, which fails if a route is registered and undocumented or
> documented and unregistered. This table has no such check, which is how it once said "16 modules,
> 35 endpoints" while listing all of them, and how it carried a duplicate `GET /api/auth/me` row
> until 22 Sep 2026.

---

## 6. Frontend: structure

Location: [`web/src/`](web/src/). Stack: React + TS + Vite, ECharts, React Router. HCML theme is
plain CSS (primary `#2B5584`, Inter and IBM Plex Mono, one set of CSS variables for light and dark; see
[`DESIGN.md`](DESIGN.md)).

```
web/src/
├── api.ts            # typed fetch client → /bff/api/*, token handling, streamUrl()
├── types.ts          # shared Zabbix-shaped TypeScript types
├── theme.ts          # HCML palette + Zabbix SEVERITIES
├── styles.css        # the whole theme (sidebar, cards, tables, chips, map svg)
├── lib/severity.ts   # the "logics": severity, duration, availability, value formatting
├── hooks/
│   ├── useAsync.ts   # fetch + loading/error + optional polling
│   ├── useSSE.ts     # subscribe to one SSE event
│   ├── useAi.ts      # one shared /api/health probe: which capabilities exist?
│   └── useAuth.ts    # one shared /api/auth/me probe: who am I, what may I see?
├── components/
│   ├── Layout.tsx, Sidebar.tsx      # shell (grouped, collapsible menu)
│   ├── KpiCard.tsx, StatusBadge.tsx # KPI tiles, severity/availability pills, count chips
│   ├── ProblemsTable.tsx            # reused problem table
│   ├── TimeSeriesChart.tsx          # ECharts line chart wrapper
│   ├── ExplainPanel.tsx             # the plain-language slide-over (problem + SLA)
│   ├── AckDialog.tsx                # acknowledge / close confirmation (the only write)
│   ├── ReportDownload.tsx           # the PDF report and Excel report buttons (SLA and Availability pages)
│   ├── states.tsx, icons.tsx        # loading/error/empty; inline SVG icons
└── pages/
    ├── Overview.tsx      (/)                    # Dashboard
    ├── Problems.tsx      (/problems)            # + per-row "Explain"
    ├── Sites.tsx         (/sites)               # per-site health board
    ├── Hosts.tsx         (/hosts)
    ├── HostDetail.tsx    (/graphs?hostid=)      # Graphs
    ├── LatestData.tsx    (/latest)
    ├── Maps.tsx          (/maps)
    ├── Network.tsx       (/network)
    ├── Links.tsx         (/links)               # SD-WAN / radio link health  [operator]
    ├── Services.tsx      (/services)            # service tree, roll-up + root causes
    ├── Sla.tsx           (/sla)                 # Services → SLA + "Plain language"
    ├── Availability.tsx  (/reports/availability)# uptime + unacknowledged aging
    ├── Capacity.tsx      (/reports/capacity)    # CPU / memory / disk trends
    ├── AlertNoise.tsx    (/reports/noise)       # flapping / never-acked triggers
    ├── Inventory.tsx     (/reports/inventory)   # standardisation scorecard  [admin]
    ├── TopTriggers.tsx   (/reports/top-triggers)
    └── Login.tsx         (/login)
```

### Sidebar
[`Sidebar.tsx`](web/src/components/Sidebar.tsx) defines three collapsible sections. Monitoring and
Reports mirror Zabbix's menu; Assistant ([§24](#24-assistant-chat)) has no Zabbix
equivalent. Each section header toggles open/closed; the active route is
highlighted. Add a page by dropping an entry in the `SECTIONS` array and a `<Route>` in
[`App.tsx`](web/src/App.tsx).

### Data flow in the UI
- `useAsync(fn, deps, intervalMs?)`: most pages fetch with this; pass an interval to poll
  (Problems 30 s, Hosts 30 s, Latest 20 s). It exposes `{ data, loading, error, reload }`, rendered
  through the `<Async>` helper so every page gets consistent loading/error/empty states.
- `useSSE(url, event)`: the Dashboard subscribes to `/bff/api/stream` for live problems and
  falls back to polling if the stream drops.
- Cross-page links: Hosts → `/graphs?hostid=…`, Latest data → `/graphs?hostid=…`. `HostDetail`
  reads the `hostid` query param to preselect.

---

## 7. Live updates (SSE)

Server-Sent Events are the simplest live-push transport (chosen over WebSocket in the build brief,
`myown/plan/instruct.md` §2; recorded as [ADR-0002](docs/architecture/adr/0002-react-typescript-fastify.md)).

- BFF: [`routes/stream.ts`](server/src/routes/stream.ts) opens an `text/event-stream`, pushes an
  `event: problems` frame when something shown changed, from one shared 5 s ticker. A list identical
  to the last one sent is never sent again, and one where only a name or host changed goes after at
  most 30 s. A frame carries only the fields the Dashboard reads (`eventid`, `objectid`, `object`, `name`, `severity`, `clock`,
  `r_eventid`, `acknowledged`, `suppressed`, `host`, `hostid`): no tags, no `opdata`, and none of the other fields Zabbix
  returns, which is about half the size of the full list (tracker IN-11). After 15 s of
  silence it sends an `event: ping` whose data is `{ "ageMs": n }`, the age of the last good read of
  the list, so the page's "Data as of" keeps moving on a quiet estate. It drops the client on
  disconnect. `X-Accel-Buffering: no` tells nginx to stream, not buffer.
- Limits. At most `STREAM_MAX_CLIENTS` screens in all (default 100) and `STREAM_MAX_PER_USER` for
  one signed-in user (default 5; one client address when auth is off). A screen past either limit
  gets `429 too_many_streams` with `Retry-After: 30`. The browser cannot read that body, so it falls
  back to the 60 s poll and retries. A stream is also ended when the token it was opened with
  expires, so the browser reconnects with the renewed cookie, and when the BFF shuts down.
- Browser: [`useSSE`](web/src/hooks/useSSE.ts) wraps `EventSource`. `EventSource` can't set headers,
  but it sends the session cookie on a same-origin request like any other, so the stream is
  authenticated by cookie. No route accepts a token in the query string.

---

## 8. Authentication (mechanics)

`AUTH_ENABLED=true` turns on a JWT flow: `POST /api/auth/login` sets a JWT (12 h unless `SESSION_HOURS` says otherwise) carrying the
user's role in a session cookie; an `onRequest` guard then rejects unauthenticated `/api/*` calls
(`/api/health`, `/api/auth/login`, `/api/auth/me` and `/api/auth/logout` excepted) and checks the role
against the route. The Zabbix token is never exposed regardless: portal auth gates the portal's
own routes only.

No script on the page can read the token. The cookie is named by `SESSION_COOKIE` (default
`hcml_session`; hcml-portal-ollama's compose sets `hcml_session_ollama`, because cookies ignore ports)
and is `HttpOnly`, `SameSite=Strict`, `Path=/`, with a `Max-Age` of the session length (12 h by default), and `Secure` when the request
came over HTTPS. The browser sends it with every same-origin request, the SSE stream included.
[`api.ts`](web/src/api.ts) keeps only when the session ends, from the `expiresIn` that sign-in,
renewal and `/api/auth/me` return, and redirects to `/login` on a 401, keeping the page to return to
after sign-in.

Every POST from the page carries `X-HCML-CSRF: 1`. The BFF refuses a POST that authenticates with the
cookie, and any sign-in or sign-out, without that header or with an `Origin` from another host:
403 `csrf`. A script can send `Authorization: Bearer <jwt>` instead; the header wins over the cookie
and needs no CSRF header, except to sign in or out. `POST /api/auth/logout` clears the cookie, and the tabs tell each other
over a `BroadcastChannel`, so signing out in one sends the others to `/login`.
[ADR-0010](docs/architecture/adr/0010-session-cookie.md) has the trade-off.

An open page renews its token an hour before it runs out with `POST /api/auth/refresh`
([`useSessionRenewal.ts`](web/src/hooks/useSessionRenewal.ts)), so a wall screen stays signed in while
it is open. The BFF looks the user up again on each renewal: a user no longer in `PORTAL_USERS`, or a
name listed there twice, is refused, and the new token carries the role configured now.
[ADR-0009](docs/architecture/adr/0009-renew-an-open-portals-sign-in.md) has the trade-off.

> Roles, route rules, and the user model are in [§19](#19-authentication--rbac). That section is
> the authority; this one is just the transport.

---

## 9. Caching strategy

- Each endpoint wraps its Zabbix call in `cached(key, ttlMs, fn)`.
- TTLs are tuned to how fast the data moves: problems 5 s, availability/latest 15 s, hosts 30 s,
  static-ish lists (groups, maps) 60 s.
- In-flight coalescing: if 10 browser tabs poll `/api/problems` at once during a cache miss, only
  one `problem.get` hits Zabbix; the rest await the same promise.
- The cache holds at most 500 entries and about 64 MB of values, least recently used first (§26).
- Scaling path: swap the in-memory `Map` for Redis (shared cache + SSE fan-out) without touching
  route code: the `cached()` signature stays the same.

---

## 10. Network monitoring (SNMP / ICMP)

The portal reads network gear exactly like any other host: it never speaks SNMP itself
(build brief `myown/plan/instruct.md` §13). Zabbix's server/proxy polls devices; the portal reads
the resulting items:

- Availability: ICMP items `icmpping` (up/down), `icmppingloss` (%), `icmppingsec` (latency),
  merged per device in `/api/net/devices`.
- Ports/interfaces: SNMP LLD creates `net.if.in[...]`/`net.if.out[...]`, `ifOperStatus`, etc.;
  `/api/net/interfaces` reads them, and interface traffic graphs go through `/api/graph`.
- Onboarding is a later phase (the "network plug", §13.4): set `NET_GROUP_IDS` on the BFF and add
  devices in Zabbix. The network views populate automatically, no portal code change.

---

## 11. Running & deploying

Dev (two processes):
```bash
cd server && cp .env.example .env   # set ZBX_URL + ZABBIX_API_TOKEN; auth needs JWT_SECRET + PORTAL_PASS
npm install && npm run dev          # BFF on :4000  (tsx watch, auto-reloads)
cd ../web && npm install && npm run dev   # Vite on :5173, proxies /bff -> :4000
```

`tsx watch` does not watch `.env`: after editing it, restart the BFF.

Prod (Docker, next to Zabbix):
```bash
cp .env.example .env                # ZBX_URL, ZABBIX_API_TOKEN, a real JWT_SECRET and PORTAL_PASS
docker compose up -d --build        # nginx serves web + reverse-proxies /bff -> BFF, on :8081
```

To have `/api/health` say which build is running, pass the commit and time as build arguments:
`BUILD_COMMIT=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build`.
They are not BFF settings and not read from `.env` by the running container, and they read `unknown`
when left out. `portal-bff` has a healthcheck on `/api/health` (it passes while the process answers,
whether or not Zabbix does, so a Zabbix outage never restarts the BFF) and `init: true`, and
`portal-web` starts once the BFF is healthy. Read the body, not the status, to see Zabbix: `ready.ok`.

Three things about the Docker path that are easy to get wrong, and were:

1. `JWT_SECRET` has no default. Compose refuses to interpolate without it, and the BFF exits if
   it is one of the two values published in this repo or shorter than 32 bytes. An authenticated
   portal signing tokens with a value published in this repo looks perfectly healthy while anyone
   can forge an admin token, so this fails loudly rather than warning. `PORTAL_PASS` has no default
   either (it was `admin`), and the BFF also exits while any user's password is empty or `admin`.
2. The two compose projects share no network. Zabbix runs in project `proto1`, the portal in
   `hcml-portal`, so `portal-bff` cannot resolve `zabbix-web` by DNS. `ZBX_URL` therefore defaults
   to `host.docker.internal:8080`. `localhost` inside the container means *the container*, which is
   why `server/.env`'s dev value must not be reused verbatim.
3. `.dockerignore` is load-bearing. `web/Dockerfile` does `COPY . .` after `npm ci`; without it
   the host's platform-specific `node_modules` lands on top of the linux one and `vite build` fails
   on Rolldown's (and lightningcss's) platform binaries; before Vite 8 it was esbuild's. That is why the image could not be built at all before 2026-09-08.

Upgrading from a build before the session cookie (Batch 5, ADR-0010). Reload every open portal
tab right after the deploy, and sign in again, wall screens included. A page loaded before it keeps
its token in `localStorage`, which the new build deletes: its live stream stops (it still sends
`?token=`), its renewals come back without a token and look failed, and when its token ends it lands
on the sign-in form. Those renewals also set the new session cookie, which the old page's Sign out
cannot clear, so a browser left like that can stay signed in behind the sign-in form. A reloaded tab
runs the new build, whose Sign out clears the cookie.

Upgrading from a build before issuer and audience (7 October 2026, SC-14). Reload every open portal tab and sign in again: tokens issued before the deploy carry no issuer or audience and are refused (§19).

Verify the chain any time:
```bash
curl localhost:4000/api/health                  # BFF alive (dev)
curl localhost:8081/bff/api/health              # browser → nginx → BFF (prod)
curl -sI localhost:8081/reports/availability    # 200 = SPA fallback works on deep links
```

Beyond localhost, and backups. The Docker path speaks plain HTTP and publishes only on
`127.0.0.1`. To reach the portal from another machine, put TLS in front of it and set `WEB_ORIGIN`
to the `https://` address and `TRUST_PROXY=2`:
[`docs/operations/tls.md`](docs/operations/tls.md) has an nginx, a Caddy and a Traefik recipe, with
HSTS. The portal's only state is its `.env` files:
[`docs/operations/backup-and-restore.md`](docs/operations/backup-and-restore.md) says how to keep an
encrypted copy and how to restore from it, and `deploy/settings.example` lists every non-secret
setting with its default.

---

## 12. Extending the portal (recipe)

To add a new Zabbix-backed view:

1. BFF: add a route that calls `zbx('<method>', {...})` wrapped in `cached()`; enrich/aggregate
   as needed. Register it in `index.ts`.
2. Types: add the response shape to `web/src/types.ts`.
3. API client: add a method to `web/src/api.ts`.
4. Page: build it with `useAsync` + `<Async>`; reuse `SeverityBadge`, `SeverityCounts`,
   `TimeSeriesChart`, tables.
5. Wire: add a `<Route>` in `App.tsx`, a link in `Sidebar.tsx`, and a title in `Layout.tsx`.

That's the whole pattern: every existing page is an instance of it.

---

## 13. Plain-language layer (AI)

Implements `plan_1.1.md` (in `myown/plan/`, outside this repo). HCML's own overview names the gap: *"the main issue is
not the number of alarms, but the quality of information needed to act."* Tags like `class: os`,
`scope: availability` and wording like *"Zabbix agent is not available (for 3m)"* are precise for an
engineer and opaque to everyone else. This layer translates them.

Scope is deliberately narrow: tags, SLA figures, and notification wording. The assistant
([§24](#24-assistant-chat)) is a separate feature built on the same client; neither ever touches
Zabbix config.

### How it flows

```
Browser ──/bff/api/explain/* ──► BFF ──► getProblems() / sla.get   (Zabbix, read-only)
                                  ├────► the model (server-side only: hosted Claude,
                                  │       or a local Ollama on this host)
                                  └────► cached()  (repeat clicks are free)
```

[`ai.ts`](server/src/ai.ts) is the exact mirror of [`zabbix.ts`](server/src/zabbix.ts): the
credential is read from `config` and never reaches the browser, and the transport matches too:
both hand-roll one `fetch` rather than taking a dependency for a single POST.

`humanize()` is the only export. It picks a backend from `AI_PROVIDER`, hands both the *same* system
prompt, instructions and JSON Schemas, and returns the parsed result:

| Backend | Transport | "obey this schema" is spelled |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | `output_config.format.json_schema` |
| `openai-compatible` | raw `fetch` | `response_format.json_schema` |

Both are *enforced*, not requested: Anthropic by structured outputs, Ollama by constraining the
sampler to the schema's grammar, so the response is guaranteed to match the shape the UI renders,
with no parsing guesswork and no validation dependency.

What a schema cannot enforce is that the model actually filled it in: a small local model will
occasionally satisfy the shape with empty strings. `assertComplete()` catches that and raises
`AiUpstreamError` rather than rendering a blank panel that looks like a portal bug.

### The two translations

| Endpoint | Input from Zabbix | Output |
|---|---|---|
| `/api/explain/problem?eventid=` | trigger name + `opdata` (this is the notification text), severity, host, age, ack state, and every tag | `summary`, `tagsExplained[]` (a glossary, one row per tag), `businessImpact`, `recommendation` |
| `/api/explain/sla?slaid=&serviceid=` | SLO target, period, and per-service SLI / uptime / downtime / error budget | `status`, `plain`, `meetingTarget`, `recommendation` |

One problem endpoint covers both tags and notification wording, because the trigger name plus
`opdata` *is* the notification as the team receives it.

### Design rules

- On-demand only. Nothing calls the model on page load. The user clicks "Explain"; that is the
  only trigger. No bulk or background runs.
- Cached hard. A problem explanation lives 1 h, an SLA explanation 5 min. Five clicks on the same
  problem = one model call (measured), and every NOC screen shares the same cache.
- Never invents. The system prompt forbids adding facts not present in the input: the model
  rephrases what Zabbix returned. The panel footer says so to the reader.
- Optional. Unconfigured, no `ANTHROPIC_API_KEY` on the hosted backend, no `AI_BASE_URL` on
  the local one: the portal is fully functional; `/api/health` reports `ai: false` and the UI hides
  the buttons rather than offering one that can only fail. Note that "configured" means something
  different per backend, which is why `config.ai.enabled` branches on the provider.
- Fails alone. A model outage (including nothing listening on `AI_BASE_URL`) returns
  `502 {error:'ai_error'}` on the explain routes only; every monitoring endpoint keeps serving 200.
  The message is one fixed sentence for the cause (could not be reached, took too long, returned an
  error, stopped early, or gave an unusable answer). The model's address and what it sent back go to
  the BFF log only, never to the viewer; the Assistant's `error` frame follows the same rule.

### Configuration

```bash
# server/.env: hosted
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-6

# server/.env: local, nothing leaves this host
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1   # host.docker.internal from the container
AI_MODEL=qwen3:8b
AI_TIMEOUT_MS=120000
```

Swapping provider as well as model is now a config change, not a code change. Set up the local
side with `brew install ollama && brew services start ollama && ollama pull qwen3:8b`, natively, not
in a container: Docker Desktop on macOS cannot reach the Metal GPU.

One model-specific wrinkle lives in `ai.ts`: reasoning models such as Qwen3 think before they
answer by default, which fights grammar-constrained decoding, eats the output budget, and, measured
on Ollama 0.33, turns a 3-second explanation into a 15-second one, with about a thousand characters
of hidden reasoning per call. Two plausible levers do not work on Ollama's OpenAI-compatible
endpoint: Qwen's `/no_think` prompt token (the chat template opens a think block regardless) and
`think: false` (not accepted on `/v1`). `reasoning_effort: "none"` does, so `thinkingControl()`
sends it for known reasoning families only. See [§24](#24-assistant-chat) for the measurements.

### Trying it

```bash
curl "localhost:4000/api/explain/problem?eventid=23"   # 503 until a backend is configured
curl "localhost:4000/api/sla"                          # [] until Services → SLA exist in Zabbix
```

---

## 14. Site view

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 1, serving HCML Goal 5 (*"dashboards are not
tailored for NOC, engineers, and management"*). HCML's estate is organised by site: JKT HQ, SBY,
SSB, FPSO KAS3, BD-WHP, MOPU/MAC, MBH, MDA, MDK, Sapudi, Sumenep, ORF Porong, TWSB, GMS Pasuruan,
but every view before this one was a flat host list. Management reads sites, not hostnames.

### Zabbix has no "site"

There is no site object in the Zabbix API, so the BFF derives one. HCML's Goal 1 says site
mapping *isn't standardised yet*, so [`routes/sites.ts`](server/src/routes/sites.ts) refuses to
assume a convention and instead tries the most deliberate signal first:

| # | Signal | Zabbix source | Why this order |
|---|---|---|---|
| 1 | Host tag `site` | `selectTags` | Deliberate and unambiguous. Tag name is `SITE_TAG`. |
| 2 | Site code in the host name | [`naming.ts`](server/src/naming.ts) `siteFromHostName()` | HCML's own convention: `4.3.3 FPSO ARUBA 3` is site 4, `INET : SAMPANG WAN 1` is site 3. No HCML host carries a site tag, and its host groups (`ARUBA`, `FIREWALL DEVICES HCML`) name device types, not places. The name signal places 134 of 142 hosts. |
| 3 | Host inventory | `selectInventory` → `site_city`, then `location` | Zabbix's own field for this. |
| 4 | Host group | `selectHostGroups` | Every host has one, so this always resolves. |

> **Gotcha:** Zabbix has no `site_name` inventory field: the real ones are `site_city` and
> `location`. Asking for a field that doesn't exist is silently ignored, not an error.
>
> Set `SITE_GROUP_PREFIX` (e.g. `Site/`) when site groups are named `Site/JKT HQ`; the prefix is
> stripped. Left empty, step 4 uses the host's first host group: a guess, and reported as one.

### Coverage is the Goal 1 metric

The response carries `coverage: { hosts, tag, name, inventory, group }`, and the page turns it into one
sentence: *"86% of hosts carry an explicit site; the rest are grouped by host group, which is a
guess."* The portal is read-only so it can't enforce standards, but it measures them, which is
what makes Goal 1 actionable. As HCML tags hosts, the number goes up.

### What the board shows

Sites sort worst-first (highest live severity, then most unreachable hosts, then name) so a NOC
wall leads with what needs attention. Each card carries the site's worst-severity colour stripe,
problem and unacknowledged counts, Zabbix severity chips, and down/unknown/maintenance tallies.
Selecting a card lists that site's hosts with availability, status, and per-host severity chips.

Availability is rolled up per Zabbix 7.0 semantics: availability lives on the *interface*, and the
host state is worst wins (any interface unavailable ⇒ host unavailable), matching
[`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.

### Trying it

```bash
curl localhost:4000/api/sites | jq '.coverage, [.sites[] | {name, worst, problems}]'
```

---

## 15. Services tree

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 2, serving HCML Goal 2: the review's
*stated core problem*:

> Monitoring is still device-centric and reactive; the target is service-centric and proactive.

Every other page in this portal answers *"which host is broken?"*. This one answers *"which
service is degraded, and why?"*, so a failure reads as "BD FPSO, Voice path is degraded,
because the agent on FGR-60F-FPSO-01 stopped reporting" rather than a bare host alert.

### Zabbix does the roll-up; the portal makes it legible

Zabbix already computes service status and attributes the causing problems. `service.get` gives:

| Field | Meaning |
|---|---|
| `status` | `-1` = OK, otherwise the severity that propagated up from below |
| `problem_events` | the problems Zabbix blames for that status (snake_case in the response) |
| `algorithm` | `0` set to OK · `1` most critical if all children have problems · `2` most critical of children |
| `parents` / `children` | the hierarchy |

[`routes/services.ts`](server/src/routes/services.ts) assembles roots (services with no parents),
recurses, and attaches each service's SLA, `sla.get` + `sla.getsli`, so target and achieved sit on
the same row as the status.

### Services are a DAG, not a tree

A shared dependency legitimately sits under two parents (in the demo data, *Shared SD-WAN core*
hangs off both Offshore and Onshore). Two consequences the code handles explicitly:

- Recursion is path-guarded and depth-capped (`MAX_DEPTH`), so a malformed hierarchy can't hang
  the request.
- `descendants` counts distinct service ids, not tree positions. Summing `1 + child.descendants`
  double-counts a shared node: the root reported *6 services below* when only 5 existed.

That shared node is also the clearest demonstration of the whole feature: when it degrades, *both*
branches degrade with it. That is a dependency, which is exactly what device-centric monitoring
cannot show.

### On the page

Degraded branches are expanded by default and healthy ones folded away: a NOC wall should open
on what's broken. Each row carries a status dot in the Zabbix severity colour, an OK/severity badge,
the distinct count below it, and (when measured) an SLA chip reading `achieved% / target%`, green
when meeting. Leaves list their root causes beneath them, prefixed *"because …"*; parents don't
repeat what their children already say. Where a service has an SLA, the
[plain-language layer](#13-plain-language-layer-ai) is one click away: scoped to that service, so
the explanation talks about *that* path and no other.

### Trying it

```bash
curl localhost:4000/api/services | jq '{total, degraded, worst}'
```

---

## 16. Inventory & ownership scorecard

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 4, serving HCML Goal 1:

> *"Host naming, site mapping, owner, criticality and dependency are not standardised → alarms are
> hard to route to the right PIC."*

The portal is read-only, so it cannot enforce a standard. What it can do is measure one:
turning an invisible governance problem into a number that goes up as hosts get tagged. That is the
entire point of this page.

### The four scored dimensions

| Dimension | Counts as present when | Configure with |
|---|---|---|
| Naming | host name matches a regex | `HOST_NAME_PATTERN` (empty ⇒ *not scored*) |
| Site | an explicit marker exists: tag or inventory | `SITE_TAG` |
| Owner / PIC | inventory `poc_1_name` / `poc_1_email`, or a tag | `OWNER_TAG` |
| Criticality | a criticality tag | `CRITICALITY_TAG` |

Site is deliberately strict. [`resolveSite()`](server/src/routes/sites.ts) always returns
*something* (falling back to a host group), but the scorecard counts only `tag` and `inventory` as
present. Falling back to a group is exactly the ambiguity Goal 1 names, so it scores as a gap: the
scorecard and the Sites board agree on the same 86% figure for that reason.

### HCML's naming convention

Read off HCML's own Availability Reports (2026-06, -07, -08), not inferred. Two forms coexist:

```
devices    <site>.<class>[.<seq>] NAME     1.2.1 IDX02CORESWITCH    11.3.5 MOPU ARUBA 5
services   <TYPE> : NAME                   INET : SAMPANG WAN 1     SERVER : CUCM JAKARTA
```

Shipped as the default `HOST_NAME_PATTERN`:

```
^(\d{1,2}\.\d{1,2}(\.\d{1,2})?\.?\s|(INET|WEB|SERVER)\s:\s).+$
```

The leading digit is the site:

| # | Site | # | Site | # | Site |
|---|---|---|---|---|---|
| 1 | Jakarta (IDX) | 6 | Sumenep (SUP/STP) | 11 | MOPU / MAC |
| 2 | Surabaya (SBY) | 7 | Sapudi | 12 | Porong (POR) |
| 3 | SSB / Sampang (SAM) | 8 | MDA | 13 | Tanjung Wangi (TJWB) |
| 4 | FPSO KAS3 & BD-WHP | 9 | MBH | 14 | TWSB |
| 5 | Pasuruan / GMS | 10 | FPU | | |

The pattern is deliberately tolerant, and that is the point. HCML does not apply its own
convention consistently: site 1 numbers Cisco switches `1.2.x` while site 9 uses `9.1.1`; site 12
has both `12.1` (FortiGate) and `12.1.1` (Cisco), separated only by depth; `1.2.2.` and `2.1.`
carry stray trailing dots. The scorecard measures whether a host carries *a* recognisable
identifier, enforcing a stricter rule than HCML actually operates would score its estate against
a convention that does not exist. The inconsistency is itself the Goal 1 finding, and belongs in
the report rather than in the regex.

One real host, `INTERNET`, carries no prefix at all and correctly fails. That is a genuine gap,
not a false negative.

Site-group naming is `Site/<CODE>` via `SITE_GROUP_PREFIX`; it only applies when a host has no
`site` tag and no inventory location, since those are checked first (§14).

The fifth dimension HCML lists, dependency, is answered by the
[Services tree](#15-services-tree) rather than a per-host field: a host is in a dependency map when
the service hierarchy covers it. Scoring it per host would be a worse answer than the real one.

### Design notes

- A broken `HOST_NAME_PATTERN` doesn't take the endpoint down. An invalid regex is caught and the
  dimension reports `scored: false`, so a config typo degrades to "not measured", never a 500.
- Groups are sorted worst-first: that's where the standardisation work is.
- The gap list downloads as CSV, so the work can be handed to whoever owns those hosts.
- Admin-only: this is governance, not monitoring ([§19](#19-authentication--rbac)).

```bash
curl localhost:4000/api/reports/inventory | jq '.overall, [.dimensions[] | {label, pct, scored}]'
```

---

## 17. Link & WAN health

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 5, serving HCML Goal 3 (telecom deep
visibility). HCML runs 12 main + 10 redundant SD-WAN links, 10 P2P radio links, 18 internet
accesses and Starlink offshore. Their own topology slide flags
*"SD-WAN (to_mda_via_sapudi)(internal4): High packet loss"*. That class of fault deserves a
first-class view, not a row buried in Latest data.

### What a "link" is

Zabbix has items, not links. A link here is one (host, ping target) pair, stitched back together
from the three items Zabbix collects per target:

| Item key | Gives |
|---|---|
| `icmpping[<target>]` | up / down |
| `icmppingloss[<target>]` | packet loss %, and usually the most descriptive item *name* |
| `icmppingsec[<target>,,,,,<mode>]` | RTT; `min`/`max` modes let jitter be derived |

Two details that are easy to get wrong:

- `monitored: true` is mandatory. Without it `item.get` also returns template items, and the
  page fills with hundreds of identical unassigned prototypes. (Measured: 100+ phantom ICMP keys.)
- Zabbix stores RTT in seconds; the page reports milliseconds. Jitter is `max − min`, and is
  simply absent unless the min/max mode items exist: it is never faked.

### Redundancy is the point

A main + standby pair is only *truly* down when every leg is: that distinction is why the
redundancy is paid for. Pairing comes from the item tag `link_group` (with `link_role` naming the
leg), and a path rolls up as: any leg up ⇒ `up`, all legs up ⇒ `up`, mixed ⇒ `degraded`,
none up ⇒ `down`.

State per link is from `LINK_LOSS_WARN` (default 2%) and `LINK_LOSS_CRIT` (default 10%):
down if the ping fails or loss ≥ crit, degraded at ≥ warn, otherwise up. Operator role
([§19](#19-authentication--rbac)).

---

## 18. Automated reporting

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 6, serving HCML Goal 6: *"hard to see SLA,
capacity trends, and recurring issues."* Recurring issues were already covered by Top 100 triggers;
these add the other two, plus response time.

### Availability: `/api/reports/availability`

Zabbix stores events; turning them into uptime is arithmetic it doesn't do. The BFF replays history:

1. `event.get` for PROBLEM events in the window (severity-filtered).
2. Each carries `r_eventid`; those recovery events are fetched in one batch for their clocks.
3. Each problem becomes an interval, clipped to the window; still-open ones run to *now*.
4. Overlapping intervals are merged per host: two simultaneous problems are one outage, not
   two. Without this, availability can go *negative*, which is the trap here.

Availability is then *"share of the period with no open problem at or above the chosen severity"*,
and the page says exactly that, because it isn't the same thing as ICMP uptime.

> The read is bounded (`EVENT_LIMIT`, 10 000) and sets `truncated: true` when the window filled a
> page, and the UI then labels the figures a floor. Silently understating downtime while looking
> authoritative would be worse than saying so.

### Action aging: `/api/reports/aging`

How long problems sit unacknowledged, in buckets (<1h, 1–4h, 4–24h, >24h) plus the longest-waiting
list. This is the *"the team repeats manual checks"* half of Goal 4, measured.

### Capacity: `/api/reports/capacity`

Reads `trend.get` (hourly aggregates), falling back to `history.get` on an instance too young to
have trends: otherwise a fresh deployment shows an empty report and looks broken. Verified key
matchers:

| Metric | Matches | Trap |
|---|---|---|
| CPU | `system.cpu.util` exactly | `system.cpu.util[,idle]` is the *idle* share: the opposite |
| Memory | `vm.memory.util` | `vm.memory.size[available]` is bytes, not a percentage |
| Filesystem | keys ending `,pused]` | none |

Rows carry `source: 'trend' | 'history' | 'none'`, and the page states when a zero means *no data*
rather than *idle*.

### The SLA report as a file: `/api/sli/export`

The monthly SLA report downloads as a PDF, to print or attach to an email, or as an Excel workbook,
to sort and total. Goal 6 is *Automated reporting*, and this is its on-demand part: someone asks,
and the file is made. A scheduled or emailed report is not built (§27).

On the page. The SLA page (its *Derived monthly SLA* view) and the Availability page each show
two buttons in the controls row, *PDF report* and *Excel report*. The Availability page shows them
only when the period is one calendar month and the basis is Availability (ICMP): a rolling window
and the legacy basis have no SLA month to report. Its buttons download the same report as the SLA
page's, not that page's own table. Both pages keep the buttons off until the figures on screen have
loaded. A press calls `GET /api/sli/export` and saves the answer under the name the BFF sends, such
as `HCML_SLA_Report_2026-08.pdf`. While a file is being prepared the button reads *Preparing PDF…*
and a second press does nothing. A failure appears next to the buttons and names the format that
failed. The code is `web/src/components/ReportDownload.tsx` and `api.sliExport` in `web/src/api.ts`.

What is in the file. Both formats are made from one document, so they say the same thing.

| | PDF | Excel |
|---|---|---|
| Key figures | Four cards: overall SLA by each method, devices measured, sites below target | The same four as a table on the *Summary* sheet, below the report's title, month, period and time of generation |
| Chart | SLA by site against the target line, worst site first | None. The figures are in the tables |
| Tables | By category, By site, By device, WAN paths, Web checks, Devices never measured, each column sized to its longest value before any name is cut | One sheet each, in that order, each column sized to its longest value (up to 45 characters). The sheet for *Devices never measured* is named *Never measured* |
| Notes | *How to read this report* and *How it was computed* | The same two, under the key figures on the *Summary* sheet |
| Print | A4 landscape. A header band with the logo on page 1, a footer with the report name and *Page x of y*, and a bookmark for the chart, each table and each note | A4 landscape, one page wide. The header row repeats on every printed page, and the footer carries the page numbers |

The figures are the page's. The route asks for both methods, `availability` (strict) and
`hcml-report`, through `getMonthlySli`, the cache `/api/sli` fills (§25), so a month the SLA page
has already loaded costs no further Zabbix call. Every table puts the strict figure first and HCML's
beside it, and the *Status* columns judge the strict one. They say Met, Missed or No data in words,
so a verdict never rests on colour. A device with no data reads No data, never 0%. A figure that
would round up to the target while falling short prints more digits (98.996%, not 99.00%), so it
never sits beside the word Missed looking like a pass. The wording is the SLA page's. The period
line says whether the month has closed; for a month still running it says how far the figures run
and that they are not final.

How it is built. `server/src/export/` builds the report once as a document model (`types.ts`):
key figures, an optional bar chart, tables and notes, each figure already formatted and carrying the
tone it takes. `slaReport.ts` fills the model from the two derived reports. It is pure, with no
Zabbix, no config and no clock but the one it is handed. Two writers turn the same model into a
file, and neither knows anything about SLAs, targets or Zabbix. They use no library. Both are
written on Node's `zlib` and `crypto` modules and no package was added (ADR-0011,
`docs/architecture/adr/0011-build-the-sla-report-files-in-the-bff.md`).

The PDF writer is `pdf.ts`, with `pdfFonts.ts` and `logo.ts`. It writes A4 landscape by hand with
the standard Helvetica fonts, which no viewer needs embedded, so the file stays small and opens the
same everywhere. It lays out every page before it draws one, so *Page x of y* is right. It sizes a
table's columns to their content first, and cuts a name that is still too long with an ellipsis. The
logo is a copy of `web/public/logo-mark.png` in `logo.ts`, beside a small PNG reader, because the
BFF image holds `server/` only. A test compares the copy with the original byte for byte.

The workbook writer is `xlsx.ts`, with `zip.ts`. It writes SpreadsheetML by hand and packs it with a
small zip writer. The header row is blue and frozen, rows are banded, each table sheet has a filter
over its rows, and Met and Missed show in words and colour. Percentages are stored as numbers in
percent points (98.9812, not 0.989812) and shown with four decimals and a % sign. Durations are
stored as times formatted `[h]:mm:ss`, and counts as numbers, so all of them sort and total. A
missing figure is the text *No data*, never an empty cell. Every text is stored as text and is never
evaluated as a formula, so a device named `=HYPERLINK(...)` stays a name. The elements in each part
follow the schema's order, because Excel offers to repair a file that breaks it.

Colours. Reports always use the light theme, because they are printed and attached to email,
whatever theme the viewer's screen uses. The colours are copied from the light tokens at the top of
`web/src/styles.css` into `theme.ts`, and `export-theme.test.ts` fails if one drifts.

The route. `GET /api/sli/export?month=YYYY-MM&format=pdf|xlsx`, viewer role like the pages it
serves ([§19](#19-authentication--rbac)), by session cookie or bearer token:

```bash
# -f makes curl fail on an HTTP error, so an error message is not saved as the file
curl -fsS "$BFF/api/sli/export?month=2026-08&format=xlsx" -H "Authorization: Bearer $TOKEN" -o report.xlsx
```

`month` defaults to the current month in `SLA_TIMEZONE`. `format` is required. A bad month or format
is a 400, refused before Zabbix is asked, so it costs nothing. So is any other parameter, so a misspelt
`month` is not quietly read as the current month. The engine adds a 400 for a month
that has not started or is more than about 400 days back, and a Zabbix failure is the usual 502 or
503. The file name is made from the validated month alone, so no request text can reach a header.
The answer carries `Cache-Control: private, no-store` and is never compressed. Nothing is kept for
long: a built file is reused for ten seconds, so a burst of requests for one month and format shares
one build (about 10 ms of CPU), and after that it is built again from the cached figures.

Stale figures. The route reads the same cache as `/api/sli`, which serves its last good run
while Zabbix is failing (`staleIfError`, §26). The file is then a 200 built from older figures, and
the response says so with `X-Data-Stale: true` and `X-Data-Age-Seconds`. For
a month still running, its period line shows how far the figures run, for each method when the two
end more than a minute apart.

Size and speed. The test report has 138 devices across 14 sites. Its PDF is about 10 pages and
69 KB, and its workbook is about 23 KB. In a fresh process the first PDF took about 60 ms and later
ones about 10 ms, and the workbook took about 14 ms, then 9 ms. These are single builds on the
development laptop, measured on 2 Oct 2026. Both writers compress with synchronous `zlib` calls, so
the BFF answers nothing else while one runs, and the time grows with the number of rows.

How it was checked. `server/src/__tests__/export-*.test.ts` build both files from a report
shaped like the real one and read them back. For the PDF that means its cross-reference table, page
tree and bookmarks, and that every text sits inside its margin and its column. For the workbook it
means the parts, the relationships, the style ids and the element order. The tests give the writers
hostile names (a leading `=`, `+`, `-` or `@`, a literal `_x0041_`, characters XML forbids, a name
too long for its column) and check that the same document and time give the same bytes.
`ReportDownload.test.tsx` and `reportApi.test.ts` cover the buttons and the download request. By
hand, the PDF was checked with `pdfinfo`, `pypdf`'s strict reader and a visual review, and the
workbook with `openpyxl`'s strict reader, macOS Quick Look and a check of element order against the
schema. **Not checked: Microsoft Excel itself, and HCML's own data.** Every name in the test report
is made up. Docker, and the Zabbix stack in it, was down when the checks were made, so no report
could be built from HCML's data.

What the files leave out.

- The PDF embeds no font. Text outside Western European letters prints as `?`, so a device named in
  Cyrillic or Chinese would show as a row of question marks. Accents and curly quotes print as
  written. The PDF is not PDF/A and is not tagged for screen readers.
- The workbook has no chart. The same figures are in its tables.
- There is no CSV, and no scheduled or emailed report.
- A group row's downtime adds up the downtime of all the group's devices, including devices with too
  little data to score. Those devices are left out of the group's average but not out of its
  downtime. `aggregate()` in `server/src/sli/engine.ts` does this and the SLA page shows the same
  sum, so a group's downtime and its SLA do not always describe the same devices. The report's notes
  say that a group row adds up all its devices.

---

## 19. Authentication & RBAC

Implements `plan_1.2.md` (in `myown/plan/`, outside this repo) Phase 7 and closes its defect #5. Every source slide in
HCML's review is stamped Private and Confidential, so an open portal is not deployable.

`AUTH_ENABLED=true` turns on JWT login; the `onRequest` guard then rejects unauthenticated `/api/*`
calls. Exactly four routes are excepted, `/api/health`, `/api/auth/login`, `/api/auth/me` and
`/api/auth/logout`, and the guard judges the route the router matched rather than the URL text, so
an encoded path such as `/%61pi/hosts` is guarded like `/api/hosts`. The Zabbix token is never
exposed either way: RBAC decides who sees which portal view, not what the BFF may ask Zabbix.
`/api/health` is public, so it carries the version, build and `ready` state, and nothing sensitive:
no address, token or error text. `GET /api/auth/me` also returns `pages`, the role each menu page
needs, worked out from the same rules (`pageAccess.ts`), so the sidebar keeps no copy of them.

### Three roles

The portal is read-only today, so roles divide by sensitivity and cost, not write access:

| Role | Gets | Rationale |
|---|---|---|
| viewer | all monitoring, Sites, Services, SLA, reports, and "Explain" | The plain-language layer exists *precisely* for non-engineers. Gating it higher would defeat its purpose. |
| operator | + Network, Links & WAN health | Engineering surfaces; also where acknowledge/close write-back will land. |
| admin | + Inventory & ownership scorecard | Governance, not monitoring. |

Enforcement lives in [`auth.ts`](server/src/auth.ts) `ROUTE_RULES`, **first match wins, and anything
unmatched requires `viewer`**: so a newly added route is protected by default rather than
accidentally public. A 403 explains itself: *"This view needs the admin role; you are signed in as
viewer."*

The sidebar hides what a role can't reach, but that is only courtesy: the BFF enforces it
regardless, and the UI never holds a permission decision the server doesn't also make.

### Users

There's no database yet (that phase was deferred), so users come from the environment:

```bash
AUTH_ENABLED=true
JWT_SECRET=<openssl rand -hex 32>       # required; a published value or under 32 bytes stops the boot
PORTAL_USERS=ana:secret:viewer,budi:secret:operator,citra:secret:admin
SESSION_COOKIE=hcml_session             # optional; two portals on one host need different names
SESSION_HOURS=12                        # optional; how long one sign-in lasts, 2 to 24
SESSION_EPOCH=1                         # optional; raise it and restart to end every session at once
# or the single-admin shorthand:
PORTAL_USER=admin
PORTAL_PASS=zabbix
```

Malformed entries are warned about and skipped; an unknown role falls back to `viewer`, never to
something more privileged. The BFF refuses to start while any user's password is empty or `admin`,
and `POST /api/auth/login` takes 10 attempts a minute per account and address. With
`AUTH_ENABLED=false` the BFF reports role `admin` so the scaffold runs open with zero setup, and
none of the secret or password checks run: that is a dev convenience and `docker-compose.yml`
defaults it to true.

Next: SSO or LDAP in place of env users. The acknowledge/close write-back that once sat here too is built
(§20), through a separate `ZABBIX_WRITE_TOKEN` that is deliberately not the read-only token.


### What changed on 7 October 2026 (tracker SC-14, SC-19, SC-22, BK-03, FR-13, SC-07, SC-20, IN-09)

- Every request looks its user up again. A token is checked, then the user is found in `PORTAL_USERS` and the current role is used, not the one the token was signed with. Remove someone and restart the BFF and their tokens stop working at once; change a role and it takes effect at once. A new `JWT_SECRET` still ends everyone's.
- Tokens name their portal. Each carries an issuer and an audience built from the session cookie name (`hcml-portal:hcml_session`, `hcml-portal:hcml_session_ollama`), so a token from :8081 is refused on :8082 even when both share a `JWT_SECRET`. No `.env` change is needed.
- Names ignore case, and a password may hold a colon. `Ana` and `ana` are one account for sign-in and for the lockout counter. The name is what comes before the first `:` and the role what comes after the last, so the password between them can contain `:`. Two entries that differ only by case are warned about at start.
- Hashed passwords are optional. A password in `PORTAL_USERS` or `PORTAL_PASS` is plain text, as before, or an scrypt hash of the form `scrypt.N.r.p.salt.hash` (Node's own `crypto`, no new package). Make one with `printf '%s' 'the password' | npx tsx scripts/hash-password.ts` from `server/`, or run the script alone to be asked twice with nothing shown, and paste the line where the password was. The password is read from standard input, never from an argument, so it stays out of the shell history. A hash of `admin` or of nothing is refused at start, like the plain text. A check costs about 100 ms and 32 MiB, and an unknown name costs one too, so a wrong name is not quicker to refuse.
- Sign-ins are logged. Every attempt writes a line with the name as typed (control characters removed, 64 characters at most), the outcome (`success`, `failure`, `locked` or `rate_limited`) and the address, never the password. Five failures in a row for one name, from any address, raise a warning, and again at every fifth. A password typed into the username box is logged as a name.
- `AUTH_ENABLED` is read strictly. Unset or empty is on; empty used to mean off. `true`, `1` and `yes` are on, `false`, `0` and `no` are off, in any case. Anything else, such as a typo, stops the server at start and names the accepted values.
- With sign-in off the server answers only to this machine. Every caller is admin then, so a `Host` that is not `localhost`, `127.0.0.1`, `::1` or the host of `WEB_ORIGIN` gets `421`, which stops a page on another site reaching the dev server by DNS rebinding. Write-back is refused as well unless `ALLOW_WRITE_WITHOUT_AUTH=true`: a dev `server/.env` with sign-in off and a write token now needs that line to acknowledge anything. The setting is not passed to the containers.
- Interface data is for operators. A viewer does not get items whose key starts with `net.if` from `/api/items` or `/api/latest`, and `/api/graph` answers `403` when asked for one by id (`/api/history` and `/api/trend` did too, until BK-11 removed them). On `/api/maps/detail` a viewer does not get the network hosts, the network host groups or the links that end at them, **but only when `NET_GROUP_IDS` names the network host groups**: with it empty nothing says which hosts are network devices, so nothing is cut. Operators and admins see everything, and an unknown role counts as a viewer.
- A public `/api/health` is short. Anyone gets `ok`, `ts`, `ai`, `aiProvider`, `aiExternal`, `writeBack` and `defaults`. The version, start time, build, `ready` (including `token_rejected`) and the screen count are for a signed-in caller only.

Upgrading from a build before issuer and audience (7 October 2026, SC-14). Tokens issued before the deploy carry neither claim and are refused. Reload every open portal tab right after the deploy and sign in again, wall screens included: a tab left open lands on the sign-in page at its next request.

---

## 20. Acknowledge / close write-back

The portal's only write. Everything else in this BFF is read-only by design
(build brief `myown/plan/instruct.md` §0 rule 2; recorded as
[ADR-0006](docs/architecture/adr/0006-read-only-with-one-write.md)), so this route is fenced
deliberately rather than bolted on.

### Three independent fences

| # | Fence | Effect |
|---|---|---|
| 1 | A separate `ZABBIX_WRITE_TOKEN` | The read token never gains write power. If it did, *every* read path in the BFF would silently be able to modify Zabbix: one bug away from a write. |
| 2 | `operator` role or above | Enforced in [`auth.ts`](server/src/auth.ts) `ROUTE_RULES`; a viewer gets a 403 that names the role it needs. |
| 3 | Blank token ⇒ 503 | With no write token the portal is *strictly* read-only, and the UI hides the button rather than offering one that fails. |

[`zabbix.ts`](server/src/zabbix.ts) keeps this honest at the transport layer: `zbx()` and
`zbxWrite()` are separate exports over one private `call()`, each bound to its own token. There is
no code path that writes with the read credential.

### One Zabbix method, a bitmask

Both actions go through `event.acknowledge`. The bits used:

| Bit | Meaning |
|---|---|
| `1` | close problem |
| `2` | acknowledge |
| `4` | add message |

So an acknowledgement with a note sends `action: 6`, and a close sends `1`. Verified against live
Zabbix: the event came back `acknowledged = 1` carrying the note.

### Closing needs the trigger's permission

Zabbix only allows a manual close when the trigger sets `manual_close`. Rather than offer a button
that Zabbix would reject, `getProblems()` carries a `manualClose` flag, read from the existing
`trigger.get` call so it costs no extra request, and the dialog disables the Close checkbox with
the reason shown.

### Caches must be dropped, not waited out

Problem state is cached for 5 s, and several other views derive from it. Without invalidation an
acknowledgement wouldn't appear until the TTL expired and the click would look like it did nothing.
After a successful write the route calls `invalidate()` on `problems`, `stats`, `probsByGroup`,
`sites`, `aging` and `services`. Measured: the very next `GET /api/problems` already showed
`acknowledged = 1`.

### On the page

Problems grows an Ack button (open problems only, and only when both fences 1 and 2 pass). It
opens a confirmation dialog: optional message, an Acknowledge checkbox, and a Close checkbox that
is disabled with an explanation when the trigger forbids it. The footer says *"This writes to
Zabbix"*, because a single click changing upstream state should never be a surprise. Errors from
Zabbix are surfaced verbatim rather than flattened into "something went wrong".

```bash
curl -X POST localhost:4000/api/problems/acknowledge \
  -H 'Content-Type: application/json' \
  -d '{"eventids":["26"],"message":"On it","acknowledge":true}'
# 503 until ZABBIX_WRITE_TOKEN is set; 403 for a viewer
```

Not yet: bulk acknowledge across a selection, and severity change (`action` bit `8`). Both are
small extensions of the same route.


### What changed on 7 October 2026 (SC-07, SC-08, IN-06)

- The portal user goes into the message. The text Zabbix receives always starts with `[portal:<user>]`, also when the caller wrote nothing, because Zabbix files every write under the write token's owner. Brackets and control characters in the name are dropped, the tag comes first, and the cut at 2,048 characters keeps it.
- At most 50 event ids per request. A slip or a script cannot close a whole estate; the page sends one.
- Every attempt is on record. Each acknowledge or close writes a line with the user, the address, the event ids and the action, before any check can turn it away. A refusal or a failure writes a second line with the status.
- With sign-in off write-back is refused unless `ALLOW_WRITE_WITHOUT_AUTH=true` (§19), and `/api/health` then reports `writeBack: false`, so the buttons are not offered.
- The dialog warns when Zabbix is not collecting. If the freshness signal says Zabbix has collected nothing for over ten minutes, for example because no `zabbix-server` is running, the dialog says so before a change is sent: a close would be accepted and not applied.
- A close that does not apply says so. If the list still shows the problem open a minute after a close, the row reads "Close requested, not yet applied by Zabbix" and keeps reading it until the problem shows resolved. An acknowledgement that does not show is dropped from the row, as before.

---

## 21. Alert noise / flapping

Implements HCML Goal 4's other half. The review's headline is the whole reason this page exists:

> "The main issue is not the number of alarms, but the quality of information needed to act."

[§13](#13-plain-language-layer-ai) answers *context*: what an alarm means. This answers the
question underneath it: which alarms weren't worth sending?

### Why Top 100 triggers isn't enough

Top 100 counts *how often* a trigger fired. That single number can't tell noise from signal.
Measured on the dev instance:

| Trigger | Fired | Median duration | Acknowledged | Reality |
|---|---|---|---|---|
| SD-WAN link flapping | 6 | 4 s | 0% | Pure noise, cleared itself before anyone could look |
| Zabbix agent unavailable | 2 | 153 638 s | 100% | A real fault, open for two days |

Ranked by count, Top 100 puts the noise first. Duration and acknowledgement are what separate
them, so this report adds both.

### The three flags

A trigger carries *flags*, not one category: it can genuinely be both flapping and ignored:

| Flag | Condition | What it tells you |
|---|---|---|
| `flapping` | ≥ `NOISE_MIN_COUNT` firings and median < `NOISE_SHORT_SECONDS` | The threshold is too tight. Retune it. |
| `unactioned` | ≥ `NOISE_MIN_COUNT` firings and ack rate 0 | The team has learned to ignore it: the strongest retune signal there is. |
| `chronic` | still open and longest > 24 h | *Not* noise. One condition nobody has cleared. |

Defaults: `NOISE_SHORT_SECONDS=300`, `NOISE_MIN_COUNT=5`.

Median, not mean. One six-hour outlier would otherwise hide forty ninety-second firings: the
exact pattern the report exists to surface.

### The Pareto line

The headline for management, computed from the same data:

> 5 triggers produced 80% of all alerts in this period.

That is HCML's own sentence turned into a number, and it points at the shortest path to a quieter
NOC: retune the few at the top rather than triage the rest.

### Implementation note: one fetch, two reports

Availability (§18) and this report ask different questions of the same history. Rather than
duplicate the trickiest code in the codebase, `fetchIncidents(days, minSeverity)` does the shared
work once: fetch PROBLEM events, batch-resolve their recoveries via `r_eventid`, clip to the window.
Each report then groups the result its own way: availability by host (merging overlaps), noise by
trigger. `EVENT_LIMIT` and the `truncated` flag apply to both, so neither ever presents a
truncated count as authoritative.

### Trying it

```bash
curl "localhost:4000/api/reports/noise?days=7" | jq '.concentration, .counts'
```

---

## 22. Testing

`cd server && npm test`, 1508 tests in 66 files, no live Zabbix required.

The mock point. Every Zabbix call in the server funnels through one `fetch` in
[`zabbix.ts`](server/src/zabbix.ts), exposed as `zbx()` and `zbxWrite()`. Mocking that single module
covers all eighteen route modules, so route tests drive the real handlers, the real cache and the
real error mapping, only the network is fake.

```ts
vi.mock('../zabbix.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zabbix.js')>();
  return { ...actual, zbx: zbxMock, zbxWrite: zbxWriteMock };
});
```

The spread of `actual` matters: `errors.ts` branches on `instanceof ZabbixAuthError`, so a stubbed
error class would make every failure-mode assertion pass for the wrong reason.

Route modules all have the plugin signature `(app: FastifyInstance) => Promise<void>`, so each
mounts on a bare Fastify instance and is driven with `app.inject()`: no listening socket.

What is tested, and why those things. The suite is weighted toward code that fails *silently*
with a plausible wrong answer, not code that throws:

| Area | The failure it guards against |
|---|---|
| `mergedSeconds()` | Two triggers on one host counted as two outages, availability could compute as negative |
| `requiredRole()` table | A regex typo silently downgrading an admin route to `viewer`. No error, no log line |
| `cache.ts` | Losing in-flight coalescing: ten NOC screens become ten times the Zabbix load |
| `HOST_NAME_PATTERN` | The invented pattern that matched zero real HCML hosts and would have scored their estate at 0% |
| `severitiesAtLeast()` | An empty `severities` array, which makes Zabbix return nothing: a bad parameter becoming an empty report |
| API surface snapshot | A route added or renamed without a matching RBAC rule |
| The report files (`export-*.test.ts`) | A PDF or workbook a reader refuses, a device named `=HYPERLINK(...)` that Excel would evaluate, and a copied colour, logo or sentence drifting from the web app's |
| Failure modes | A typed 503 swallowing a genuine 500, or vice versa |

Layout. Tests live in `server/src/__tests__/` so they resolve modules exactly as the app does.
`tsconfig.json` excludes that directory (tests must not ship in `dist/`); `tsconfig.test.json` puts
it back for typechecking, and `npm run typecheck` runs both: vitest transpiles without
typechecking, so without the second pass the tests would drift out of sync unnoticed.

---

## 23. Hardening: timeouts, rate limiting, headers

Three plugins and one timeout, all in [`index.ts`](server/src/index.ts), registered in an order that
matters.

Timeouts. `fetch` has no default timeout. Before this, one unresponsive Zabbix held the request
open forever, and every page waiting on it was held up too. `zabbix.ts` now passes
`AbortSignal.timeout(config.zbxTimeoutMs)` and maps the abort to a typed `ZabbixTimeoutError` → 503,
alongside the existing `ZabbixAuthError`. Same reasoning as that one: *"Zabbix is not responding"*
and *"the portal is broken"* need different responses from whoever is reading the screen.

The hosted model client had the mirror-image problem: the SDK defaults to a 10-minute timeout
and two retries, which is sane for a batch job and absurd for a request a human is waiting on behind
a button. Both are now configured. The local backend re-uses `zabbix.ts`'s pattern directly
(`AbortSignal.timeout` → typed error), with a larger ceiling: a local model generates more slowly and
loads from disk when cold. It does not retry: a local model that failed once is usually down rather
than flaky.

Order of registration. helmet → cors → rate-limit → auth → routes.

Rate limiting sits *before* the auth guard so a flood is rejected before the server spends work
verifying JWTs on it, and a request the guard refuses still counts. It is a root `onRequest` hook
(`rateLimit.ts`): the plugin's own hooks go on each route and run after the guard. The endpoint that
actually needs it is `POST /api/auth/login`, which is otherwise an unthrottled password oracle, so
it also has a limit of its own, checked on top of the global one: 10 attempts a minute per account
and address (`LOGIN_ATTEMPTS_PER_MINUTE` in `auth.ts`). After 10 failed sign-ins in a row for one
account from one address, sign-in is locked for a minute, doubling with each further failure up to
5 minutes, and a success clears it (`LOGIN_LOCK_*`). The cap is short on purpose: behind Docker
every browser shares one address, so a long lock would lock the account out for everyone. Three exemptions: `/api/stream` holds
one long-lived connection per NOC screen rather than making repeated requests, and is capped
by its own count instead (`STREAM_MAX_CLIENTS`, `STREAM_MAX_PER_USER`, §7), `/api/health` is
polled deliberately by every page, and sign-out must never be refused, or the cookie would stay
working behind a page showing the sign-in form. They are matched against the route, so no spelling
of those paths is counted.

**`trustProxy` is a prerequisite, not a detail.** Behind nginx every request carries the proxy's IP,
so without it all users share one rate-limit bucket and the limiter is worthless. But turning it on
with *nothing* in front is worse: a client can then forge `X-Forwarded-For` and rotate past the
limit. Hence `TRUST_PROXY`, off by default and set true only in `docker-compose.yml`. `true` means
one hop, the nginx in front, and a positive integer N means N hops; anything else trusts none.
Fastify 5.12 reads a bare hop count as "trust nobody", so `config.ts` hands it Fastify 4's hop rule
as a function (`trustProxyOption`) instead.
Until 24 September `true` trusted every hop, so the left-most `X-Forwarded-For` entry, which the
client writes, picked the rate-limit key. With one hop the BFF reads the right-most entry, the one
nginx appended, and ignores anything the client put in front. With a TLS proxy in front of nginx,
set `TRUST_PROXY=2` in `.env` (compose passes it through). That proxy must also keep the browser's
`Host` header (nginx `proxy_set_header Host $http_host;`, Apache `ProxyPreserveHost On`; Caddy,
Traefik and HAProxy keep it by default). The sign-in and every cookie `POST` are refused with 403
`csrf` when the browser's `Origin` does not name the `Host` the BFF receives. The BFF never reads
`X-Forwarded-Host` for that check, because a client can set it. Behind Docker's port publishing every
browser reaches nginx from the same gateway address, so the sign-in limit is keyed on the username
as well as the address.

Shutdown. `shutdown.ts` handles `SIGTERM` and `SIGINT`: it ends every live stream (`app.close()`
would otherwise wait on them until Docker kills the container), closes, and exits 0, or exits 1 after
8 s, under Docker's 10 s stop timeout. A second signal exits at once. Compose also sets `init: true`
on `portal-bff`, and the Dockerfile's `CMD` stays in exec form with no `npm start` or shell in front,
since either would swallow the signal.

One header caveat. `stream.ts` writes its SSE headers through `reply.raw.writeHead`, bypassing
Fastify's reply object. helmet's headers still arrive, since helmet 13 sets them on the raw response
at `onRequest`, but the CORS headers do not. That is harmless: the stream is same-origin.

The app's own headers come from nginx. helmet covers the BFF's replies only. `web/nginx.conf`
adds `Content-Security-Policy-Report-Only`, `X-Frame-Options: SAMEORIGIN`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` to the pages and files it
serves, and hides its version. The CSP only reports for now: violations show in the browser console
and nothing is blocked.


### Request ids and `/api/ready` (7 October 2026, tracker IN-09)

- One id per request. nginx makes it (`$request_id`, in `web/bff-proxy.inc`), replacing anything the client sent, and writes it in its access log as `rid=`. The BFF uses it as Fastify's request id: it is `reqId` on every BFF log line of the request, the `X-Request-Id` header of the reply (the live stream's too), and `requestId` in the body of every error. To follow a failure, ask for the `requestId` shown in the error and search both logs for it. A request that reaches the BFF some other way keeps a sent id only if it is 8 to 64 letters, digits, `.`, `_` or `-`, and gets a new one otherwise, so a caller cannot choose what is written to the log.
- `GET /api/ready` answers `503` while the portal cannot read Zabbix and `200` otherwise, with the same body either way: the check's fields (`ok`, `zabbix`, `zabbixMs`, `model`, `checkedAt`) and the version, start time, build and screen count. It is for a monitor that holds a session or Bearer token, so it is guarded like any route (viewer). `/api/health` stays public and always 200, which is what the container healthcheck reads. Both read one cached check, so polling either costs Zabbix at most one call in 15 s. The model never changes the status.
- Not built: metrics in a collector's format. Nothing here scrapes them, and `/api/ready` carries the counts a person would look at.

### Containers (7 October 2026, SC-21)

Both images run as an unprivileged user and both compose files harden the containers. The BFF runs as `USER node`. The web image is `nginxinc/nginx-unprivileged`, which cannot bind port 80, so nginx listens on 8080 inside the container; the host side of the mapping is unchanged (`127.0.0.1:8081` or `:8082`). Each service has `read_only: true` with a small `tmpfs` for `/tmp` (nginx keeps its pid file and temporary files there, and a proxied report download is buffered there), `cap_drop: ALL`, `no-new-privileges`, a memory and CPU limit (the BFF 2 GiB and 2 CPUs, the web 256 MiB and 1 CPU) and a healthcheck: the BFF fetches `/api/health` and reads the status, the web fetches `/` with `wget`. The base images carry an explicit minor tag and, since 12 October 2026, the digest it pointed at (`node:24.11-alpine@sha256:...`, `nginxinc/nginx-unprivileged:1.28-alpine@sha256:...`); raise one on purpose, tag and digest together, on every Dockerfile line that names the image (§30 shows how to read the digest).

First run, 7 October 2026. Both portals were rebuilt that day, hosted first and then ollama. Checked from outside, with no sign-in: all four containers `healthy` with no restart; the BFFs run as `node` and the web containers as uid 101, each with a read-only root, `cap_drop: ALL` and `no-new-privileges`; the BFF is healthy before the web container starts; both pages load; `/api/health` answers through nginx, which finds the BFF by name; the web log shows requests and no `permission denied`; the BFFs log no warning. **Not checked** because it needs a sign-in: a report download (the buffered path), the live stream staying connected, and the Problems page. Sign in once after any rebuild and open the Dashboard, download one report and open Problems.

Second run, 12 October 2026. Both portals were rebuilt again, the first build on the digest-pinned base images, and the recreate and stop checks that the first run could not make were made: see §30, "Putting it live".

Steps for a rebuild. Save the current image IDs first, for a rollback (`docker tag <id> <name>:rollback-2oct`); build with `BUILD_COMMIT` and `BUILD_TIME` set; then check that both containers are `healthy`, that the page loads on :8081 and :8082, that a report downloads (the buffered path), that the live stream stays connected, and that the web container's log shows requests and no `permission denied`. Every open tab needs a reload and a new sign-in.

Rolling back. The BFF image can go back through compose: `docker tag <name>:rollback-2oct <name>:latest`, then `docker compose up -d --no-build portal-bff`. The web image cannot, because the 7 October compose maps container port 8080 and drops every capability, while the old image runs root nginx on port 80. Start the old image with `docker run` on the compose network instead (`-p 127.0.0.1:8081:80`, with the compose service stopped), or keep a copy of the old compose file beside the old images. The images from before the 12 October rebuild are tagged `rollback-7oct`; they were built for the current compose file, so both services should go back through compose with the same two commands (not tried).

---

## 24. Assistant (chat)

The sidebar's Assistant page answers free-form questions about the estate: *"what needs
attention right now?"*, *"which site is in the worst shape?"*, *"are we meeting the SLA?"*. It is
the one feature with no Zabbix equivalent, and it is deliberately not an agent.

### What the model is given

For every message the BFF builds a snapshot, [`chat.ts`](server/src/chat.ts)
`buildSnapshot()`, from the same cached queries the pages use, under the same cache keys
(`problems`, `sites`, `sla`, `sli:*`, `services:tree`), so a busy conversation costs Zabbix nothing
the pages were not already paying:

- open problems, worst first, with host, age, acknowledgement state and tags;
- sites with reachable / unreachable / unknown counts and worst severity;
- every host by site on a small estate, or only the hosts that are not fine on a large one;
- SLA standing per service (achieved vs target, error budget left or exceeded);
- degraded services with the problems Zabbix blames for them.

The snapshot is plain text, not JSON: roughly half the tokens for the same facts, and a small
model reads *"3 hosts, 1 unreachable"* more reliably than nested braces. It is also capped.
Ollama serves `qwen3:8b` with a 4 096-token window by default, and a prompt that overflows it is
truncated from the *front*, which silently drops the system prompt and its rules. So lists are cut
(40 problems, 30 sites, 10 SLAs, 20 services, about 5 500 characters overall), `meta.truncated`
says so, and the page shows *partial view*. `OLLAMA_CONTEXT_LENGTH` raises the window. SLA and
services are fetched with `Promise.allSettled`: a Zabbix without Services configured must not leave
the assistant unable to say what is down.

Host, site, problem, service and SLA names are text typed into devices and Zabbix, so before they
enter the prompt each one is cut to a single line (control characters and line breaks become
spaces), capped at 80 characters for a host or site and 200 for the rest, and the snapshot and the
focused-site block sit between `~~~ BEGIN` and `~~~ END` lines that the system prompt calls data,
never instructions (`promptText()` in `chat.ts`).

### What the model may do

Nothing. The system prompt confines it to the snapshot, forbids inventing hosts, numbers or causes,
asks for plain text (no markdown: the panel renders text, not HTML), and tells it that
acknowledging is done on the Problems page by operators. It has no tools. A wrong answer is the
worst case, which is why the page footer says to confirm on the relevant page before acting.

### How it flows

```
Browser ──POST /bff/api/chat {messages} ──► BFF ──► buildSnapshot()     (cached Zabbix reads)
        ◄── text/event-stream ──────────────────├──► streamAnswer()     (the model, streaming)
            event: context   what it was shown  └──► frames written as tokens arrive
            event: token …
            event: done | error
```

[`routes/chat.ts`](server/src/routes/chat.ts) validates the body (the last 12 turns, each at most
2 000 characters, ending with a user turn), then hijacks the reply and writes SSE frames as
`streamAnswer()` yields text. `EventSource` cannot POST, so the browser reads the stream with `fetch`
+ `ReadableStream` in [`api.ts`](web/src/api.ts) `chatStream()`. A reader who navigates away closes
the socket; the route aborts the upstream request so the model stops generating for nobody.

Nothing is kept server-side between messages: the page holds the conversation and sends it back
each time, which is also why *Clear* is nothing more than emptying the page's state.

### Reasoning models: the measurement that changed `ai.ts`

Qwen3 thinks before it answers by default. Measured on Ollama 0.33 with `qwen3:8b`, one short
question:

| Lever on `/v1/chat/completions` | Wall time | Hidden reasoning |
|---|---|---|
| `/no_think` in the system prompt | 14.3 s | 945 characters |
| `think: false` | 12.9 s | 789 characters (parameter ignored) |
| `reasoning_effort: "none"` | 2.0 s | none |
| native `/api/chat` + `think: false` | 1.9 s | none |

The same held with a JSON schema attached, i.e. the explain layer had been paying ~1 000 characters
of reasoning on every call. Ollama files that reasoning into a separate `reasoning` field rather
than `content`, which is why it went unnoticed: nothing leaked into the answer, it just took five
times as long. `thinkingControl()` in [`ai.ts`](server/src/ai.ts) now sends `reasoning_effort:
"none"` for known reasoning families, for the assistant *and* the explain layer, and
`readOpenAiStream()` drops any `reasoning` deltas so the reader never sees the model think.

### RBAC and rate limiting

`viewer`. The snapshot contains only what a viewer can already open: Problems, Sites, SLA,
Services; the operator-only Links and Network views are not in it. The route is a POST, but not a
write: the surface test pins both non-GET routes and states which one touches Zabbix. It is
rate-limited like any other request.


### Limits and the notice on AI answers (7 October 2026, SC-01, SC-09)

- The notice. When the hosted Anthropic backend is configured (`AI_PROVIDER=anthropic`) the Assistant and Explain say, under every answer, what left the machine: "Each question, and a summary of the estate, is sent to Anthropic, an external AI service" and "To write this, the details shown here were sent to Anthropic, an external AI service". It follows `aiExternal` in `GET /api/health`. With a local model, as in hcml-portal-ollama, nothing is shown.
- Per-user limits. Each signed-in user, or each client address when sign-in is off, may make `AI_CHAT_PER_MINUTE` Assistant questions and `AI_EXPLAIN_PER_MINUTE` explanations a minute (10 each). Over it is `429 rate_limited` with `Retry-After`. The count is kept in memory, so a restart gives everyone a fresh allowance.
- Concurrency. `AI_MAX_CONCURRENT` (4) hosted calls run at once; the next waits its turn and is told the assistant is busy after about 20 seconds. A local model still takes one at a time. That slot belongs to one BFF process: a second BFF pointed at the same Ollama does not see it, so its question would run while another is answering and wait inside Ollama, with no word to the reader. Run one BFF per Ollama server. Setting `OLLAMA_NUM_PARALLEL` in Ollama's own environment lets Ollama take several questions at once, which only matters with more than one BFF, and needs memory for each (tracker IN-21).
- Daily token budget, hosted only. `AI_DAILY_TOKENS_PER_USER` (500,000) and `AI_DAILY_TOKENS_TOTAL` (2,000,000), counted from the tokens the API says it billed and reset at midnight in `SLA_TIMEZONE`. Used up is `429 ai_budget` with the time to midnight. `0` switches a budget off. A local model has no bill and no budget.

---

## 25. Derived SLA and services

HCML's Zabbix has no services and one SLA (`SLA:1`, weekly) with nothing attached, so Zabbix's own
SLA engine has nothing to measure and the Services and SLA pages were empty. HCML still publishes a
monthly *Availability Report* per device, built from Zabbix trigger history. The portal now does
that measurement itself, read-only: [`sli/engine.ts`](server/src/sli/engine.ts). Nothing is created
in Zabbix.

### Two methods, because HCML's figure and the truth differ

| Method (`profile`) | Counts as down | Hours with no collected data | Aug 2026 overall |
|---|---|---|---|
| `hcml-report` | only High ICMP ping loss | counted as up; silent devices count 100% | 99.2313 %: HCML's published figure, exactly |
| `availability` *(default)* | Unavailable by ICMP ping or high loss | left out of the measurement; too little data ⇒ "no data" | 89.46 % across the 93 devices with data |

"High ICMP ping loss" is defined as loss below 100%, and depends on "Unavailable by ICMP ping",
so a device that is completely down never fires it. In HCML's own August report `4.3.4 FPSO ARUBA 4`
counts as 100% available while it was unreachable all month. The strict method is the headline;
the report method is shown beside it so the published figure can still be checked.

### How a figure is computed

1. Window. A calendar month cut at midnight `SLA_TIMEZONE` ([`sli/time.ts`](server/src/sli/time.ts)),
   or a rolling window for the availability report.
2. Triggers. `trigger.get` by name (`SLI_REPORT_TRIGGERS` / `SLI_AVAILABILITY_TRIGGERS`), not
   filtered to monitored hosts: HCML's report lists disabled hosts too. The report category is the
   host's device template (`Cisco IOS by SNMP`, `Generic by SNMP`, `FortiGate by SNMP`, else `ICMP Ping`).
3. Events. Every PROBLEM/OK event in the window, fetched in slices
   ([`sli/events.ts`](server/src/sli/events.ts)): a full page is split in half rather than accepted,
   so the result is never silently truncated.
4. Replay. Each trigger's events are replayed from the state it was in when the window opened:
   the same approach as Zabbix's own `calculateAvailability`. A trigger with no events in the window
   is in its current state, unless it only changed afterwards, in which case the first later event
   says what it was. A problem still open at month end is clipped to the last second (HCML's rule).
5. Per device. Intervals of all its triggers are merged, so overlapping loss and unavailability
   count once.
6. Coverage (strict only). An hour counts as collected when its `icmpping` trend row holds at
   least half the expected samples; the hour or two not yet in trends come from raw history.
   Downtime is only counted inside collected time, and the figure is `downtime / collected`. Hours in
   which fewer than 10% of devices collected anything are reported as estate gaps (e.g. the
   stack being stopped) rather than blamed on any device.
7. Totals. Every group (overall, category, site, device class) is the plain mean of the
   devices that have a figure, HCML's rule.

WAN legs are paired by name (`INET : SAMPANG WAN 1/2` → path `SAMPANG`); a path is down only while
all legs are down. Web scenarios on the *Web Monitoring* host are measured from `web.test.fail`.

### Checked against HCML's own reports

[`scripts/validate-sli.ts`](server/scripts/validate-sli.ts) reads the Jun/Jul/Aug 2026 report
workbooks and compares them with `GET /api/sli?profile=hcml-report`:

| Month | Overall (portal = report) | Devices | Within 60 s of downtime | Incidents |
|---|---|---|---|---|
| 2026-06 | 99.3796 % | 138 | 138 / 138 | 739 / 739 |
| 2026-07 | 99.7167 % | 138 | 138 / 138 | 1,165 / 1,165 |
| 2026-08 | 99.2313 % | 138 | 138 / 138 | 1,417 / 1,417 |

Category counts (51 / 42 / 31 / 14) and category figures match within 0.005 pp. Run it with the BFF
up: `cd server && npx tsx scripts/validate-sli.ts`. The workbooks hold real host names and event
ids, so they are read in memory and nothing from them is stored.

### Endpoints

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/sli?month=&profile=` | per device, category, site, class; WAN paths; web checks; gaps | closed month 24 h, current month 5 min |
| `GET /api/sli/export?month=&format=` | both methods for the month, side by side, as a PDF or an Excel file (§18) | none of its own beyond ten seconds of reuse |
| `GET /api/services/derived?month=&profile=` | a service tree in `/api/services`' shape: estate → business services / sites → device classes → devices, with live status from open problems | 30 s |
| `GET /api/sla/source` | `{ real, slas, services }`, whether Zabbix's own SLAs have anything to show | 60 s |
| `GET /api/explain/sla?source=derived&month=&profile=&scope=` | plain language for `overall`, `site:N` or `category:NAME`; a deterministic "no data" answer without a model call when nothing was measured | 5 min |
| `GET /api/reports/availability?basis=availability` | the availability report, now on this engine (default); `basis=all-problems` keeps the original any-problem report, no longer truncated | 2 min |

A closed month of the strict method costs about 20 Zabbix calls and 0.6 s cold; the report method
about 6 calls and 0.2 s.


## 26. Reachability, caching and operations (second pass, 17 Sep 2026)

### One host state, ping first

`server/src/reachability.ts` decides one state per host for Sites, Hosts, Network and the assistant:
`up`, `down`, `degraded`, `nodata` or `disabled`, with a `reason`.

| Situation | State | Reason |
|---|---|---|
| Host disabled in Zabbix | `disabled` | `disabled` |
| Fresh ping answered, but the SNMP / agent interface is failing | `degraded` | `snmp-silent` / `agent-silent` |
| Fresh ping answered | `up` | `ping` |
| Fresh ping failed | `down` | `ping` |
| No fresh ping: the interface flags decide | `up` / `down` | `interface` |
| Nothing to go on | `nodata` | `stale`, `no-interface` or `unsupported` |

A ping value is fresh when the item is supported, has collected, and is no older than
`max(3 × delay, 10 min)`. Before, availability came from interface flags alone: 16 of the 23 hosts
shown "unavailable" were answering ping (FortiGates whose SNMP went silent), and 43 hosts with no
interface were "unknown". `/api/sites` and `/api/hosts/overview` add `state` and `reason` (the old
`availability` field stays); sites add `up` / `down` / `degraded` / `nodata` counts and are ordered
by open severity, then hosts down. The Links page applies the same freshness rule.

### Is Zabbix still collecting?

A stopped `zabbix-server` leaves every API call working and every value in place, so a frozen
estate looks live. `GET /api/freshness` rolls up the newest `lastclock` of any supported ICMP item,
from the same `item.get` the host states read (so it costs Zabbix no extra call), and says `stale`
once nothing has been collected for ten minutes, the same floor a ping stays fresh for. The
Dashboard polls it every minute: when stale it shows "Zabbix has collected nothing since …" and
turns the Live badge to the late style. No ICMP item means an unknown age, never a stale one.

### Never-measured hosts

`/api/sli` marks a host `measured: false` when none of its ICMP items has ever collected: 45 hosts
in August (42 with no interface in Zabbix, so the ping check cannot run; 3 disabled). HCML's report
method counts each as 100 %; the SLA page lists them and the figures are unchanged
(`scripts/validate-sli.ts` still matches Jun to Aug exactly).

### Reports

- `trend.get` is read in slices of at most ~26,000 rows (items × hours), so 365-day availability
  and capacity reports answer (they returned 502 when Zabbix's frontend ran out of memory).
- `basis=all-problems` honours `month` (a bad, future or >400-day-old month is a 400).
- `/api/reports/noise?top=N` (default 100, max 1,000) returns the top rows and `total`.

### Caching

`cached(key, ttl, fn, { staleMs, staleIfError, pin })` in `cache.ts`:
- at most 500 entries and about 64 MB of values (estimated by `approxBytes`), least recently used
  evicted first. A value bigger than the whole budget is answered but not stored, with a warning;
- `pin`: evicted only after every unpinned entry, so a run of graph keys cannot push out a closed
  month's SLA report (`routes/sli.ts` pins closed months). Pins share at most 32 MB;
- `staleMs`: serve the previous value while one background refresh runs, only for the slow reports
  (`derived-sli:*`, `avail:*`, `noise:*`, `capacity:*`), never for anything carrying problem state;
- `staleIfError`: if Zabbix fails, answer from the last good run rather than a 502. The request is
  told: `staleness.ts` adds `X-Data-Stale: true` and `X-Data-Age-Seconds` to that answer, from a
  note `cache.ts` leaves in a request-scoped store, and to no other. The web app shows "Zabbix did
  not answer, so this is the last copy the portal kept, from …" on the SLA, Availability, Capacity
  and Alert noise pages;
- `invalidate(prefix, { holdMs })` also cancels fetches already in flight, so data from before an
  acknowledge is never stored again; after a write, matching keys are held at a ≤ 2 s TTL for 15 s.

### Bandwidth

- JSON over 1 KB is compressed (`compress.ts`): brotli quality 4 or gzip level 6:
  `/api/problems` 459 KB → 25 KB in ~3 ms.
- The live stream (`/api/stream`) runs one shared ticker, sends the problem list when something shown
  changes, never resends an identical one, and respects back-pressure.
- The web app polls one request at a time, aborts requests nobody needs any more, pauses in hidden
  tabs, dims stale data while new parameters load, and keeps the page when a refresh fails.
- nginx gzips the app's own files over 1 KB; `/bff` is left to `compress.ts`.

### Logs and ports

- No URL carries a token since the session cookie (ADR-0010). A page loaded before that change still
  puts `?token=` on its stream URL until it reloads, so the BFF log still redacts it from request
  URLs, and nginx's access log writes `token=redacted` in its place. nginx's error log records the
  full request line, such a token included, for example while the BFF is down.
- nginx appends the address it sees to `X-Forwarded-For`, and the BFF trusts that one hop, so a
  client cannot choose its own rate-limit key. The sign-in limit is keyed on username and address,
  because behind Docker's port publishing every browser arrives from the same gateway address.
- The live stream has its own nginx location whose error log is set to `crit`, so an unreachable BFF
  does not write an old page's stream token into the error log.
- Docker publishes the Zabbix UI (8080) and the portals (8081, and 8082 for the Ollama variant) on
  `127.0.0.1` only; the trapper port 10051 is no longer published.

### Guards against drift

- `web/scripts/css.check.mjs` fails on an unclosed block, a stray `}` or a declaration outside a rule
  (a lost brace once left ~50 rules silently unapplied; Vite does not catch it).
- `web/scripts/diagrams.check.mjs` fails when a diagram source was edited after its stamp, the
  `%% source-hash:` line that ends each `.mmd`. A file date cannot say whether a render is old, because a
  git checkout resets it; `web/scripts/diagrams.stamp.mjs` sets the stamp, after the re-render.
- The two portals no longer drift by construction: since 18 September they hold the same source tree,
  so `diff -r` over `server/src`, `server/scripts`, `web/src` and `web/scripts` must print nothing.
  That replaced `scripts/check-sync.mjs` and its list of allowed differences, which had nothing left
  to allow.
- `server/src/export/` keeps three copies of things the web app owns, because the BFF cannot import
  the browser bundle or `web/public`: the light-theme colours (`theme.ts`), the HCML logo (`logo.ts`)
  and the SLA page's method note and banner, word for word, with a handful of its other phrases
  (`slaReport.ts`). `export-theme.test.ts`, `export-pdf.test.ts` and `export-sla-report.test.ts` read
  the originals and fail when a copy drifts.

### Assistant speed (local model)

- Reused snapshot. The snapshot is kept for up to 5 minutes and rebuilt at once when a problem
  opens, closes, is acknowledged or re-graded, or when a host's state change has held for a minute.
  The system text stays byte-identical, so Ollama answers from its prompt cache: first word in
  ~0.5 to 2 s instead of 6 to 8 s.
- Native Ollama API. Chat, explain, warm-up and prefill all call `/api/chat` with the same options
  (`AI_NUM_CTX` 8 192, `AI_TEMPERATURE` 0.7, `AI_TOP_P` 0.8, `keep_alive`), so the model is never
  reloaded with a different context size and really stays loaded for `AI_KEEP_ALIVE`.
- Prefill when the Assistant page opens; site focus block for questions that name a site.
- One request at a time: chat, explain and prefill share one slot; a request that waits more
  than 20 s gets `503 ai_busy` with `Retry-After`.

### Zabbix stack settings (`Proto1/docker-compose.yml`)

| Setting | Why | Measured |
|---|---|---|
| `--innodb-redo-log-capacity=2G`, `--innodb-flush-log-at-trx-commit=2` | the 100 MiB redo log made MySQL checkpoint constantly | writes 1.50 → 0.39 MB/s in a 60 s sample |
| json-file logs, 50 MB × 5 | zabbix-server wrote ~200 MB in 48 h | not measured |
| `stop_grace_period` 60 s (server), 120 s (mysql) | let the server flush trends on shutdown | "syncing trend data done" on restart |
| `ZBX_STARTPINGERS=3` | one pinger was 100 % busy, fping hit its 600 s limit | pinger busy 100 % → 74 % |
| `ZBX_LOGSLOWQUERIES=3000` | slow queries were never logged | not measured |
| `ZBX_MEMORYLIMIT=512M` (web) | `trend.get` exhausted PHP's 128 M | 0 memory errors after a 365-day report |

---

## 27. Limitations and known gaps

*Reconstructed 22 September 2026. A section like this existed in `DOCUMENTATION.md`, which was
deleted on 21 September and was never under version control, so this is rebuilt from the surviving
audit findings, plan documents and logs rather than restored. Where the original said something this
does not, that is lost.*

Be suspicious of a system that documents no limitations. Everything below is known and accepted,
not discovered by a reader.

### What the portal cannot do, by design

| | |
|---|---|
| **It cannot collect anything** | Zabbix polls; the portal reads items. If Zabbix does not collect it, no portal feature can invent it |
| **It cannot change monitoring** | One write exists, `event.acknowledge`. No host, item, trigger or template can be created, edited or deleted. See [ADR-0006](docs/architecture/adr/0006-read-only-with-one-write.md) |
| **It remembers nothing** | Every derived value dies on restart. There is no audit trail of who acknowledged what, no saved views, no user table: [ADR-0003](docs/architecture/adr/0003-no-database.md) |
| **It cannot see past Zabbix's retention** | 31 days of raw history, 365 days of trends and events. A two-year question has no answer through this API |

### Goals only partly met

- Goal 3, telecom deep visibility: the WAN and radio-link half is built (§17). SIP trunk and
  UHF/VHF radio monitoring is not, and cannot be: HCML's Zabbix does not collect that data. This is
  a Zabbix-side prerequisite for the engineering team, decided out of scope on 2026-09-07.
- Goal 5, role-based dashboards: the site view and RBAC are built. Role-scoped landing pages
  are not, because they need HCML to define what each role should see first.
- Goal 4: the alert-noise report and the plain-language layer are built. Cross-trigger
  correlation is not.
- Goal 6: availability, capacity, aging and top-triggers are built, and so is an on-demand PDF
  and Excel download of the monthly SLA report (§18). A scheduled or emailed report is not.

### Security, still open

- A password can still be plain text in `.env` (an scrypt hash is accepted since 7 October 2026, SC-22)
  and users come from environment variables, so adding one needs a restart. The audit items on this,
  BE-12 to BE-17, are closed.
- `server/.env` has held a random `JWT_SECRET` of its own since 13 October 2026 (DOC-11, SC-04), where
  it held the placeholder the BFF is designed to refuse. It still runs with `AUTH_ENABLED=false` for local
  development. The sign-in path itself has been exercised against a local BFF started with a test secret
  (ADR-0009, ADR-0010).
- Each running portal has a `JWT_SECRET` of its own since 13 October 2026 (SC-14). A token also names its
  portal (the issuer and audience come from the cookie name), so one minted by :8081 is refused on :8082
  either way; a secret for each copy means a leak of one cannot forge a session on the other.
- `hcml-portal-ollama` is not under version control at all. Everything in it exists in one place
  on one disk. B1.
- The Anthropic API key has been flagged for rotation since 10 September and has not been
  rotated. FE-02.

### Measurement and performance

- The assistant's snapshot is always truncated. It is capped at 20 problems and a per-section
  character budget against roughly 660 open problems, so `truncated` is effectively always true.
  BE-22.
- Heavy reports are slow, and the reason is now measured. A 365-day capacity report costs ~112
  Zabbix calls and 10,771 SQL statements upstream, because each JSON-RPC call carries about 20
  statements of fixed frontend overhead. [ADR-0007](docs/architecture/adr/0007-keep-the-zabbix-api.md).
- `stats.zabbixCalls` under-reports. Sliced `event.get` recursion is counted once, so the true
  figure is higher whenever a window exceeds 5,000 events.
- Nobody has measured the cache hit rate. The 24-hour SLA TTL is a ceiling, not a floor: with a
  500-entry LRU and parameterised keys, ordinary browsing can evict a fresh report in minutes. How
  often the expensive path actually runs is unknown, and it is the number that decides whether any of
  the performance work matters.
- Every performance figure in this project is single-user and single-shot. There is no p95 and no
  concurrency data anywhere.
- The SLA report files were checked on test data only. The Excel file has not been opened in
  Microsoft Excel itself, and neither file has been run on HCML's own data (Docker was down when they
  were checked). §18 lists what each was checked with.

### Data and correctness

- The dataset is frozen at 17 September 2026 16:59:37. [ADR-0008](docs/architecture/adr/0008-stop-local-polling.md).
- 42 of the 135 monitored ICMP items have no trend data at all: they are address-less
  placeholders. Availability figures cover the 93 that do.
- Hourly averages are integer-truncated for unsigned items by Zabbix itself, in `trends_uint`.
  Nothing downstream can recover the precision.
- `web/src/types.ts` is a hand-maintained mirror of the server's types, and in six places it is
  looser than the server. Nothing checks it. The server is authoritative.

### Documentation

- The diagrams cannot be regenerated from anything. A conceptual model is a judgement, so nothing
  will ever flag it as stale. `erd/conceptual/ERD-Conceptual.md` ends with the list of code changes
  that oblige a change to it; that list is the only guard.
- The glossary and this section were lost and rebuilt, not restored. See §28.

---

## 28. Glossary

*Reconstructed 22 September 2026. `DOCUMENTATION.md` carried a glossary; no copy survives and no
other document quotes it, so this is written from scratch against the code and the data model rather
than recovered. Terms are the ones this project uses in a specific way.*

### Zabbix's vocabulary, as this portal consumes it

| Term | What it means here |
|---|---|
| Host | A monitored thing. Note Zabbix keeps hosts *and templates* in one table discriminated by `status`, so any count must filter: 139 monitored plain hosts, 313 templates, 40 prototypes |
| Item | One metric on one host, identified by a `key_` such as `icmpping`. ~51,800 in HCML's estate |
| Trigger | An expression over items that turns a measurement into a problem |
| Event | A trigger changing state. A PROBLEM event and its later OK event bracket one outage |
| Problem | An event that is currently unresolved. ~660 open at HCML |
| History | Raw collected values. Kept 31 days by HCML's policy |
| Trend | Hourly min/avg/max per item. Kept 365 days, and the only source for anything older than a month |
| Host group | Zabbix's grouping. 23 of them; the portal uses them as the weakest of four site signals |
| Service / SLA | Zabbix 7.0's native service tree and SLA engine. Both are empty at HCML: 0 services, 1 placeholder SLA |
| Maintenance | A window in which a host's problems are suppressed |

### The portal's own vocabulary: none of these is a Zabbix entity

| Term | What it means here |
|---|---|
| Site | One of 14 HCML locations. Zabbix has no site entity, and no HCML host carries a site tag, so a site is resolved from four ranked signals: tag, host name, inventory, group |
| Site source | Which of those four signals actually resolved a given host. Reported per host, because the mix is the standardisation metric |
| Link | A WAN path, synthesised from a host's `icmpping` / `icmppingloss` / `icmppingsec` item triplet. Paired with its standby by the `link_group` item tag |
| Incident | A problem event paired with its recovery, clipped to the reporting window and merged with overlapping ones so two simultaneous problems are not double-counted |
| Host state | The portal's own reachability judgement: up, down, degraded, nodata, disabled. Ping first, interface flags only as a fallback, because on 17 Sep 16 of 23 hosts Zabbix called unavailable answered ping |
| State reason | Which signal decided the host state. Provenance, so a wrong call can be traced rather than argued about |
| Derived SLA / SLI | Monthly availability computed by replaying trigger events, because Zabbix's own engine has nothing configured |
| Profile | Which method the SLA used. `hcml-report` reproduces HCML's published figures; `availability` is the stricter one that also requires evidence data was collected |
| Coverage | The fraction of an interval in which an item actually collected data. Distinguishes "up" from "we were not looking" |
| Basis | The declared rules behind a figure, which triggers count, how gaps and no-data are treated. Present in every SLI response so two numbers can be compared honestly |
| Data status | Whether a figure rests on real measurement, partial measurement, or none |

### Project vocabulary

| Term | What it means here |
|---|---|
| BFF | Backend-for-frontend. The Fastify service; holds the Zabbix token, caches, derives, and never lets the browser talk to Zabbix |
| The derived layer | Everything the portal computes that Zabbix stores no row for. Green in every diagram |
| The two portals | `hcml-portal` (hosted model) and `hcml-portal-ollama` (local model). Byte-identical source; 21 files differ |
| Explain | The per-problem plain-language summary. One problem, cached an hour |
| The Assistant | The conversational page. Sends the whole estate snapshot, streamed, never cached |
| Stale-while-revalidate | Serving an expired cached value instantly while refreshing behind it. Allowed on four report families, never on problem or acknowledgement state |
| Write-back | The single acknowledge/close path. Off unless `ZABBIX_WRITE_TOKEN` is set |

---

## 29. HCML's six optimisation goals, indexed

*Reconstructed 22 September 2026. `DOCUMENTATION.md` opened with this framing. The mapping itself was
never lost (it is spread across `setup.md` §3 and the openers of §§14 to 21) but there was no single
index, and that absence is what made it feel gone.*

> *"From basic monitoring toward a consistent, measurable system that supports operational
> decisions."* Target outcome: faster detection · more relevant alarms · shorter troubleshooting ·
> more credible reporting.

| Goal | HCML's stated gap | Where the portal answers it | State |
|---|---|---|---|
| 1 · Standardization | Naming, site, owner and criticality are not standardized, so alarms are hard to route to the right person | Inventory & ownership scorecard, §16. Site coverage in §14 is the measure of progress | met |
| 2 · Service-based monitoring | Device-centric, not service-centric, *HCML's stated core problem* | Services tree, §15, plus the derived SLA in §25 at the real 99 % target | met |
| 3 · Telecom deep visibility | Voice, radio and SIP path monitoring incomplete | Link & WAN health, §17 | partial, SIP and UHF/VHF are blocked on Zabbix-side collection, out of scope since 2026-09-07 |
| 4 · Smart alerting | Notifications lack context, correlation and escalation | Alert-noise and flapping, §21; the plain-language layer, §13 | partial, cross-trigger correlation not built |
| 5 · Role-based dashboard | Dashboards not tailored to NOC, engineers, management | Site view §14, RBAC §19 | partial, role-scoped landing pages need HCML to define what each role sees |
| 6 · Automated reporting | Hard to see SLA, capacity trends and recurring issues | Availability, capacity, aging and top-triggers, §18; derived SLA §25; the monthly SLA report as a PDF or Excel download, §18 | partial, on-demand export built, scheduled or emailed export not |

Two met, four partial. Two of the partial goals wait on someone outside the portal: Goal 3 needs
Zabbix to collect SIP and UHF/VHF data it does not collect today, and Goal 5 needs HCML to say what
each role should see. The other two wait on code that is not written: cross-trigger correlation
(Goal 4) and scheduled or emailed report export (Goal 6).

§3's table *"Six things have no Zabbix equivalent"* carries the same mapping per feature, and is the
better place to start if you are asking "why does this page exist?" rather than "is this goal done?".

---

## 30. What changed on 12 October 2026

*The "numbers 5 to 19" round of [`tracker.md`](tracker.md): SC-17, SC-21, IN-19, IN-04, BK-04, SC-14,
IN-25, BK-11, IN-22, IN-23, IN-01, FR-16 and the template note of IN-06. Each is built and tested in both
copies. Both portals were rebuilt from this code on the afternoon of 12 October and are running it (the steps
and what was checked are at the end of this section). What needs a secret or a decision from you was left alone, and the last subsection
lists it.*

### Session length and an epoch (SC-14; §8, §19)

A sign-in lasted 12 hours, fixed in the code, and the only way to end every session at once was a new
`JWT_SECRET`. Two settings now cover both. `docker-compose.yml` passes them with the defaults below, and
`deploy/settings.example` lists them.

| Setting | Default | Effect |
|---|---|---|
| `SESSION_HOURS` | `12` | How long one sign-in lasts, a number from 2 to 24. An open portal still renews its token an hour before the end, so this limits how long a copied or forgotten session works, not how long a wall screen stays signed in. The floor is 2 because a shorter session could not be renewed in time |
| `SESSION_EPOCH` | `1` | A label of 1 to 32 letters, digits, `.`, `_` or `-`, stamped into every token as the claim `ep`. A token is refused under any other label, so raising the label and restarting the BFF ends every session without a new secret |

A value the BFF cannot use stops the start with a message that names the setting. Falling back to 12 hours
quietly would hide the mistake: someone who wrote `SESSION_HOURS=1` to shorten sessions would get twelve and
never be told. A token with no `ep` counts as epoch `1`, so a rebuild signs nobody out, and raising the epoch
later does.

To end every session, put `SESSION_EPOCH=2` in the `.env` next to `docker-compose.yml`, run
`docker compose up -d portal-bff`, and each open page reaches the sign-in form at its next request. To end one
person's access, take them out of `PORTAL_USERS` and restart the BFF: every request looks the user up again, so
that takes effect at once.

The two copies already refuse each other's tokens, because the issuer and audience come from the cookie name
(§19). A separate `JWT_SECRET` for each is still the safer setup, and it is a `.env` change that is yours to
make. Tests: `auth-sessions.test.ts` and `startup-guards.test.ts`.

### CI: pinned actions, a secret scan, Dependabot (SC-17)

`.github/workflows/docs.yml` now sets `permissions: contents: read`, and every `uses:` line names a full commit
SHA with the tag it came from in a comment after it. A tag can be moved to other code; a SHA cannot. A new job,
`secrets`, runs gitleaks over the commits of each push and pull request. It does not read the history already in
the repository, so the token in commit `cb97069` does not fail every run: revoking that token is the fix, and the
scan guards what comes next. It posts no pull request comments and uploads no findings file, because on a public
repository either would repeat what it found. Manual runs skip it, as they have no commit range. A repository
owned by an organisation needs a `GITLEAKS_LICENSE` secret.

`.github/dependabot.yml` asks for one pull request a week for the actions, for the npm packages of `server/`
and `web/` (minor and patch releases together, a major alone) and for the base image of each Dockerfile, which
the digests below would otherwise freeze. Nothing is merged for you.

`ci-workflow.test.ts` fails on a `uses:` line pinned any other way, on a job that asks for more than read
access, and on a Dependabot file that leaves an ecosystem out. The workflow has never run on GitHub, so the three
SHAs, the gitleaks job and the Dependabot file are untested until the first push.

### Base images pinned by digest (SC-21; §23)

Both Dockerfiles name each base image by tag and by digest: `node:24.11-alpine@sha256:6823...` (twice in
`server/Dockerfile`, once in `web/Dockerfile`) and `nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377...`
(`web/Dockerfile`). Docker builds from the digest, so a rebuild cannot move to other bytes unannounced. The tag
stays for people to read.

To raise one on purpose, ask the registry what the tag points at today, then change the tag and the digest
together on every line that names that image:

```sh
docker buildx imagetools inspect node:24.11-alpine --format '{{.Manifest.Digest}}'
```

The Node tag has to match in the two Dockerfiles. `container-hardening.test.ts` fails on a base image with no
digest, and Dependabot proposes the new pair each week. Both portals were built on these digests on 12 October
(see the last subsections).

### Reaching Zabbix on a Linux server (IN-25; §11)

On Docker Desktop the portals reach Zabbix as `host.docker.internal:8080`, which is the Mac. On a Linux server
that name is the Docker bridge, where a Zabbix published only on `127.0.0.1` does not answer, and the
`extra_hosts` line both compose files carry does not change that. `docker-compose.zabbix-network.yml` is an
optional second compose file that joins the BFF to the Zabbix project's own network and addresses Zabbix by its
service name:

```sh
docker compose -f docker-compose.yml -f docker-compose.zabbix-network.yml up -d
```

It costs reach. The BFF can then also see the `mysql` and `zabbix-server` containers on that network. The
database still wants a password the BFF never holds, but that is more than the single API port the default gives
it, so use the file where the default cannot work. The Zabbix stack has to be running first, because its network
must already exist. The file expects that network to be called `proto1_default` (`ZABBIX_NETWORK` changes it) and
reaches `http://zabbix-web:8080/api_jsonrpc.php` (`ZBX_NETWORK_URL` changes it).

It sets `ZBX_URL` through its own variable because a running portal's `.env` already sets `ZBX_URL`, and a default
written inside the file would have lost to it. Merging the two files with `docker compose config` showed that;
reading them did not. `compose-zabbix-network.test.ts` reads the file. Nothing here has run on Linux, so it is
untested where it matters.

### Typefaces served from this site (IN-22; §6)

Every page load used to fetch Inter and IBM Plex Mono from Google: a third party contacted on each visit to a
confidential portal, which contradicts the local-model copy's promise that nothing leaves the machine. Both
faces are now files in `web/public/fonts`: Inter as a variable font (weights 400 to 700) and IBM Plex Mono in 400,
500 and 600, each in the `latin` and `latin-ext` subsets, 8 files and 191 KB in all. They are the files Google
served for the old stylesheet, fetched on 12 October over HTTPS with the WOFF2 signature checked, so the
typefaces look the same. Both SIL Open Font Licences sit beside them, with a README that says where each file
came from.

`src/styles.css` declares them with `@font-face` and `font-display: swap`. `index.html` preloads the main face
and no longer links to Google, the CSP in `web/nginx.conf` names no host but the site's own, and nginx serves
`/fonts/` for 30 days. Text in Cyrillic, Greek or Vietnamese falls back to the system font. To change a face,
replace the file under the same name and update its `@font-face` rule if the weights changed; the 30-day cache
means a replaced file reaches browsers within a month.

Checked in headless Chrome against the built app: Inter loaded and its text widened with the weight from 400 to
700, so the file really is variable; the three Plex weights loaded; and the page asked for no host but its own.
`self-hosted-fonts.test.ts` and `nginx-conf.test.ts` keep it that way.

### The build in the sidebar footer (IN-01)

Once someone is signed in, the sidebar footer shows a line such as `Build abc1234, 07/10/2026, 16.19.57 WIB`,
read from the `build` field of `/api/health`, which only a signed-in caller receives. It appears under the
footer text, in the report's time zone like every other time in the portal, and it is absent in the collapsed
rail and for a build that was never stamped. The commit reads `uncommitted` until the repository has a commit,
which waits on SC-06. `buildLabel.test.ts` and `Sidebar.test.tsx` cover it.

### Outages that began before the look-back (BK-04; §18, §21)

The "all problems" availability basis and the Alert noise report read the PROBLEM events of the window and of
the 31 days before it, plus every problem still open now, whatever its age. That missed an outage that began
more than 31 days before the window and ended inside it. They now find it from the other end. The window's
recovery events are read, and for each trigger whose first recovery no known problem explains, the trigger's last
problem before the look-back is asked for and kept when it names that recovery.

Zabbix gives a recovery event severity 0 whatever the trigger's priority, so a severity floor on that read
returns nothing at all. The first version did that, and only the real Zabbix showed it. The floor is applied to
the triggers afterwards, with one `trigger.get` per 2,000 ids.

At most 200 triggers are looked up (`LONG_OUTAGE_LOOKUPS`). Past that, the report sets `truncated`, which now
means its figures are a floor. Still missed: a problem that began before the look-back and was resolved after the
window ended, which takes an outage longer than a month that spans the whole window.

Measured on HCML's restored data on 12 October, read-only, from inside the BFF container. September 2026 read
15,891 recoveries in 148 ms and found 11 older outages the report had missed (14 lookups, 21 ms), on top of
964 ms for the reads it already made. The widest Alert noise window, 90 days, found 15 for 531 ms on top of
1,774 ms, and August found 6 for 206 ms on top of 891 ms. `incidents-before-window.test.ts` holds a fake Zabbix
that copies this behaviour, severity-0 recoveries included.

### Five endpoints removed (BK-11; §5)

The web app never called `/api/history`, `/api/trend`, `/api/net/ports`, `/api/net/status` or `/api/net/map`.
They are gone, with the helper and the constant only they used, their tests, their OpenAPI entries and their rows
in §5. The BFF has 41 endpoints: 35 in route modules, plus health, ready and the four sign-in routes.
`/api/graph` is the one route that reads an item's history, and it keeps the operator rule for interface items
(`viewer-network-ids.test.ts`).

To bring them back, apply the patch in reverse from the folder of either copy, checking first:

```sh
patch -p1 -R --dry-run < ../patches/bk-11-removed-endpoints.patch
patch -p1 -R < ../patches/bk-11-removed-endpoints.patch
```

The patch covers the ten files that held code, tests and OpenAPI entries. It does not restore the prose of the
README and this file, where the endpoint count would go back to 46.

### The Zabbix stack's passwords out of its compose file (IN-23)

The five password lines of `Proto1/docker-compose.yml`, the Zabbix stack outside both repos, now read
`MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` from an untracked `.env` beside it, mode 600. The `.env` was written from
the values the file held, and nothing printed them. `docker compose config` gave the same hash before and after,
so compose sees no change and recreated nothing: the Zabbix containers ran on through it. Without the `.env`,
compose stops with a message that names the missing variable instead of starting a database with an empty
password.

To undo, copy `docker-compose.yml.bak` back over `docker-compose.yml` in that folder. The `.bak` holds the old
literals, so delete it when you are satisfied, together with `.backup-22sep/docker-compose.yml.orig` and the parked
PostgreSQL file, which also hold literals. The passwords still reach the containers as environment variables, so
`docker inspect` shows them to anyone who can run it. The steps and the reasoning are in
`myown/patches/in-23-README.md`.

### The `.env.example` templates (IN-04, IN-19, IN-06)

The two root templates now name every variable `docker-compose.yml` reads (the SLA block, the local-model tuning,
the stream caps, the AI limits, the session settings and `WEB_PORT`), each at compose's own default, and the two
`server/.env.example` files gained the ones they lacked. `env-templates.test.ts` fails when compose reads a
variable the root template does not name, when a template value differs from compose's default for a reason
nobody wrote down, and when a key is assigned twice.

It exposed two traps. The root templates said `TRUST_PROXY=false`, hidden until now by compose's default of
`true`: copying the template to `.env` would have turned the proxy handling off behind nginx. The running
containers were not affected, as they read `true`. The hosted templates also held an active `AI_TIMEOUT_MS=30000`
beside a commented `120000` example, and the last assignment in a file wins. They now leave `AI_TIMEOUT_MS` unset:
empty means 30 seconds for the hosted API and 120 for a local model (`config.ts`), and the template says so.

The write-token line in all four templates now says to leave `ZABBIX_WRITE_TOKEN` empty where Zabbix has no
server process: a close is accepted there, queued, and never applied.

### Run-time checks of every data answer (FR-16)

`web/src/lib/guards.ts` checks, as it arrives, every data answer a page reads: the six of 7 October (the problem
list, each stream frame, the host overview, stats, problems by group, freshness and `/api/auth/me`) and 23 more
(hosts, host groups, items, latest data, graphs, network devices and interfaces, top triggers, maps, sites, the
inventory scorecard, link health, the availability report in all its forms, problem ageing, capacity, alert noise,
both service trees, the SLA report and the Zabbix SLA lists). A mismatch becomes the page's ordinary error
message. The explain answers, which a model writes, are not checked.

`guardsData.test.ts` checks each guard three ways (a complete answer passes, every field is checked, and what the
type requires is required) and fails when a data call in `api.ts` has no guard. All 29 saved real answers of both
portals passed on 12 October, which is also how a mistake in the first service-tree guard was found. The helpers
copied from the server (the site table, the site reading, the sort order and the month boundaries) are compared
with their originals by what they answer, in `copiedHelpers.test.ts`.

### Checked signed in, before the rebuild (SC-21)

Earlier on 12 October both running portals, still the 7 October build, were signed in to through nginx, and each passed
all seven checks. The sign-in set an httpOnly cookie, and `/api/health` and `/api/ready` answered, with the build
the image was stamped with. A report PDF (69,966 bytes, 11 pages) and a workbook (21,925 bytes, 7 sheets) came
through the buffered `/bff/api/sli/export` path, each with a `Content-Length` equal to the bytes received. The
live stream stayed connected for 80 seconds with 4 pings and one `problems` frame (3,452 bytes), and the problems
list answered (456,644 bytes). The BFF logs held no warning. The script took the credentials from its environment
and never prints or writes them.

### Putting it live (done on 12 October)

Both portals were rebuilt from this code on the afternoon of 12 October, at your word, hosted first (09:16 UTC) and
then ollama (09:17), the way §23 says:
`BUILD_COMMIT=uncommitted BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build`. The previous
images are tagged `<name>:rollback-7oct`, for example `hcml-portal-portal-bff:rollback-7oct`. To go back, point
`latest` at one and recreate without building (`docker tag <name>:rollback-7oct <name>:latest`, then
`docker compose up -d --no-build`). That has not been tried. These images were built for this compose file, so both
the BFF and the web container should return through compose, which the 2 October web image could not.

Checked without signing in: all four containers `healthy` with no restart; the BFFs run as `node` and the web
containers as uid 101, each with a read-only root, `ALL` capabilities dropped and `no-new-privileges`; each BFF
carries its build stamp (`BUILD_TIME` 2026-10-12T09:16:20Z hosted, 2026-10-12T09:17:47Z ollama); both pages serve the
new bundle `index-kqH0_rY-.js`; `/fonts/inter-latin.woff2` comes back 200 as `font/woff2` with
`Cache-Control: public, max-age=2592000`; the CSP header names no host but the site's own; `/api/health` answers
through nginx and `/api/problems` is refused with 401 until someone signs in; the web logs hold no
`permission denied` and the BFFs no warning.

The two checks that needed a restart were made on both portals. Recreating only the BFF
(`docker compose up -d --force-recreate --no-deps portal-bff`) gave it the same address back, which proves nothing,
so a second run stopped the BFF, let a throwaway container hold its address, and started it again at a different
one. nginx answered 200 again 0.36 s after the start on both portals, and the web container was never touched.
Stopping each container the way Docker does: the BFF ended with exit code 0 in 0.1 s, its log reading
"SIGTERM received: closing the BFF" and "BFF closed", and nginx ended with exit code 0 in 0.3 s. Each was healthy
again about 5 s after `docker start`.

Not checked, because it needs a sign-in on this build: the footer line (it should read
`Build uncommitted, 12/10/2026, 16.16.20 WIB` on :8081 and `16.17.47 WIB` on :8082), a report download through the
nginx buffer, the live stream and the Problems page. Nobody should have been signed out, because a token with no
`ep` claim counts as epoch `1`; the tests show that, and the running build has not been asked. Every open tab needs a
reload to get the new page. The Zabbix stack was not part of this rebuild.

### Left alone, and why

* SC-04 and the separate `JWT_SECRET` per copy (SC-14). Both are values in `.env` files, which stay unopened.
  The templates say what to set.
* SC-20, `NET_GROUP_IDS`. It names the host groups that hold network gear, which only you can say, and
  setting it also narrows the operator's Network page to those groups. `GET /api/hostgroups` lists them with their
  ids. It is empty in both running portals, so the map cut does nothing yet.
* IN-06, the write token. Both running portals have one set, so Acknowledge and Close are offered while no
  `zabbix-server` runs, and a close would never take effect. Whether to remove the token from these frozen-data
  deployments is your call; an empty `ZABBIX_WRITE_TOKEN` turns write-back off.
* SC-01 and SC-06. Rotating the Anthropic key, making the GitHub repository private and revoking the token in
  `cb97069` are yours. The repository was public when last checked.


## 31. What changed on 13 October 2026

*The "priorities 1 to 4" round of [`tracker.md`](tracker.md), done at your word, "everything except SC-06, IN-08 and SC-01": UX-14, UX-17, UX-18, UX-21, IN-21, IN-18, IN-01, the decision to keep SC-15 as it is, and the four items that live in `.env` files, IN-06, SC-14, SC-04 and SC-20, for which you allowed those lines to be opened. You had not chosen between the options, so each item took the smallest choice, named below. Each is built and tested in both copies, and both portals were rebuilt from this code the same morning and are running it (the last subsections give the steps and what was checked).*

### Narrow screens and wide tables (UX-14; §6)

The look in headless Chrome on 8 October found the Dashboard wider than the window at 390 px, and the Problems table wider than its card at 1440 px.

The first came from one rule. `.two-col`, the two-column grid of the Dashboard and the Inventory report, used bare `1fr` columns, and a `1fr` column cannot shrink below its widest content, so the host-group table, which sat in no scrolling box, set the width of the whole grid. The columns are now `minmax(0, 1.4fr) minmax(0, 1fr)` (a single `minmax(0, 1fr)` below 1100 px), the table sits in a `table-wrap`, and the Inventory gap-list controls wrap and shrink. `markup.test.tsx` fails on a table outside a `table-wrap` and on a `.two-col` track that cannot shrink.

Before the fix, 4 of the 85 combinations of page and width (17 pages at 1440, 1024, 720, 390 and 320 px) ran past the window: the Dashboard at 390 px (189 px) and 320 px (259 px), and the Inventory report at 390 px (55 px) and 320 px (125 px). After it: all 85 combinations fit, with no page wider than its window. A browser zoom of 200 percent on a 1440 px window is the 720 px column. The sweep is `myown/checks/layout-sweep.mjs`, which reads a dev portal and clicks nothing. It emulates a phone in headless Chrome; no real phone was used.

The second was the Problems table: 1,283 px wide in a card 1,094 px wide, so Explain and Ack sat past the right edge until the card was scrolled. The widest column was Tags, 288 px, set by one tag of 43 characters among the 666 problems of the restored data. Capping the chips at 10rem left the table 85 px too wide, and letting them wrap squeezed the column to 79 px, so the Actions column now stays in view instead: `position: sticky; right: 0` with an opaque fill (`.sticky-end`), on the Problems, Hosts and Sites, Latest data, Capacity and SLA tables. At 1440, 1024 and 390 px the Problems Actions header sits at the card's right edge while the table scrolls 189, 605 and 1,027 px, and the Hosts and Latest data tables do the same at 1024 px (124 and 204 px). The content and the type are as they were.

### Charts: Show data (UX-17; §6)

A "Show data" button under each chart's summary opens the plotted values as plain tables, one per series, and "Hide data" closes them. It is a real button with `aria-expanded` and `aria-controls`. Each table has a caption naming the series and the columns Time and Value, or Time, Average, Min and Max for a series from hourly trends, the ones whose tooltip shows a range. It is a table per series, not one merged table, because the items of different hosts are sampled at different moments. A long series scrolls in its own box, 320 px tall, which takes focus so the keyboard can scroll it, and its header row stays in view. The tables are built only while open: a series holds up to 1,500 points, the BFF's default. Checked in headless Chrome on a September item: 325 rows and the four columns. `TimeSeriesChart.test.tsx` has six new tests.

### Network ports and device cards (UX-18; §6)

A port row was a focusable `<tr>` with a tooltip as its only name. The interface name is now a button (`Gi1/0/2`, with the tooltip as its description and `aria-pressed` for the port that is open). The row has no tab stop and no title, and a click anywhere else on it still opens the graph, for a mouse. A port with nothing to graph is plain text.

A selected device card is drawn with a 2 px shadow ring instead of an outline, because the keyboard focus ring is an outline, and the old `.device.sel` outline replaced it: a focused card looked the same as a selected one. A card that is both now shows both, the focus ring 4 px outside the selection ring (measured in Chrome: a `0 0 0 2px` shadow, and a solid 2 px outline at offset 4 px).

Four facts that lived only in tooltips are now also text for a screen reader, and the tooltip stays for the mouse: why a refresh failed, that a figure rests on partial data (the asterisk is hidden from a reader and the words replace it), what the devices-with-data count on the SLA page counts, and what "degraded" means on a site. The other tooltips repeat visible text, describe a button, or give an item's key, and a button's tooltip is already its description. Tests: `networkPorts.test.tsx` (9) and `tooltipFacts.test.tsx` (4).

### Explain and the Assistant say when the model is not answering (IN-21; §24)

`/api/health` has carried `ready.model` since 7 October, from one cached `GET {AI_BASE_URL}/models`: `ok`, `down`, `off`, or `not_checked` for the hosted Anthropic model, which a probe would bill. The web app now reads it. When the Explain panel or the Assistant opens it asks `/api/health` once, and when `model` is `down` a note says "The AI model is not answering right now, so a request may fail. The rest of the portal is not affected." It is the `refresh-failed` note, at the top of the Explain dialog's body and above the Assistant's question box.

The buttons stay enabled. The check is cached for 15 seconds, and an older answer is served for up to a minute while a new check runs, so it can lag a model that has just come back, and a button that is disabled by a stale answer is worse than one that fails. The note never shows on the hosted copy, whose state is `not_checked`, and a failed health call shows nothing. `modelNotice.test.tsx` has 12 tests, and a mutant that stops reading `down` fails four of them.

### The type scale (UX-21)

Both inline `fontSize: 12.5` (the average value in the Capacity table, the device summary on Network) are `12`, the `--t-sm` step the other inline sizes use. `tokens.check.mjs` lists no exceptions now, and still fails when a listed one stops occurring.

### Diagram freshness (IN-18)

Each of the ten `.mmd` sources ends with `%% source-hash: <12 hex>`, the SHA-256 of the source without that line. `web/scripts/diagrams.check.mjs` fails when a source differs from its stamp, when a source has no PDF beside it, and when a PDF or PNG sits in a folder of sources with no source of its own. It is read-only, and CI runs it after the link check.

`web/scripts/diagrams.stamp.mjs` writes the stamp, and is the step run after a re-render. It refuses a source whose PDF is older than the source, the one mistake it can see, and `--force` stamps anyway for an edit that cannot change the picture, such as a comment. A stamp does not prove that the render was redone; it is the person's word, which is why stamping is a separate step from checking.

Mermaid ignores the comment: ServerFlow, CDM and the database ERD (the ELK layout) rendered identically with and without it, the SVG compared after the ids were normalised and the rough.js jitter removed for the ERD. `diagrams-check.test.ts` has 12 tests. Both copies were stamped after the re-render of 12 October.

### The build stamp and the changelog (IN-01)

`CHANGELOG.md` lists what changed in each build, newest first, and names the commit. Both portals were built as `748136c-dirty`: the hash of `HEAD`, and `-dirty` because the working tree holds changes that are not committed. To stamp a build the same way:

```sh
BUILD_COMMIT=$(git rev-parse --short HEAD)$([ -n "$(git status --porcelain)" ] && echo -dirty) \
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build
```

The `hcml-portal-ollama` copy has no git of its own, so it takes the hash of `hcml-portal`. Nothing is tagged: a tag names a commit, and the work is not committed.

### The four `.env` changes (IN-06, SC-14, SC-04, SC-20; §8, §10, §19)

You allowed those lines to be opened, and nothing was printed: a script changed the named keys and reported only whether each was set and how long it was. The four files were copied to a private folder first. Your encrypted copies of these files ([`docs/operations/backup-and-restore.md`](docs/operations/backup-and-restore.md)) hold the old values now, so make new ones: that page asks for a new copy after every change to a token, `JWT_SECRET` or a setting.

| Item | File | Before | Now |
|---|---|---|---|
| IN-06 | the `.env` beside `docker-compose.yml`, both copies | `ZABBIX_WRITE_TOKEN` set | empty |
| SC-14 | the same two files | one `JWT_SECRET`, the same in both | a different random 64-character `JWT_SECRET` in each |
| SC-04 | `server/.env`, both copies | the 29-character placeholder, the same in both | a random 64-character secret, different in each |
| SC-20 | the root `.env`, both copies | no `NET_GROUP_IDS` | `NET_GROUP_IDS=7,19,20,22,23,24` |

IN-06. Acknowledge and Close are off in both portals. The buttons are gone, the Problems page says "Acknowledge is off on this portal. Ask the portal admin to turn it on.", and each BFF logs one warning at its start. Zabbix here is a restored database with no server process, so a close would be accepted, queued and never applied. To turn it on again, make an API token in Zabbix for a user who may update problems, put it in `.env` as `ZABBIX_WRITE_TOKEN=`, and run `docker compose up -d portal-bff`.

SC-14. Each portal has a secret of its own, so a leak of one cannot forge a session on the other. Every session ended when the BFFs were recreated: each open page reaches the sign-in form at its next request.

SC-04. The dev secrets are real now, which means a dev BFF started with `AUTH_ENABLED=true` no longer refuses on the placeholder. Dev still runs with sign-in off.

SC-20. Zabbix has nine host groups. The six that name network gear are in: ARUBA (7), IP INTERNET PUBLIC (19), REPEATER (20), HCML Network (22), FIREWALL DEVICES HCML (23) and SWITCH DEVICE HCML (24). Left out are Zabbix servers (4), Virtual machines (6) and Web Monitoring (25). Each choice was measured before it was written, by starting extra dev BFFs on other ports with `NET_GROUP_IDS` in their environment and comparing what `/api/net/devices` and `/api/links` returned:

| Groups | Devices on the Network page | Links |
|---|---|---|
| none set (before) | 142 | 135 |
| 7, 19, 20, 22, 23, 24 (now) | 139 | 135 |
| 22, 23, 24 only | 133 | 130 |

The three hosts that went are the ones in none of the six groups. The last row shows why the three HCML groups alone were not enough: nine devices and five links of Aruba, repeaters and the internet probes sit in the other three.

It also does what SC-20 is for: a viewer's maps lose the network hosts and their links. HCML has four maps, with 38 elements and 36 links, and 31 of those elements and all 36 links are network hosts, so a viewer's maps are close to empty. An operator sees them whole. If that is not what you want, blank the line and run `docker compose up -d portal-bff`: the map is cut only while the variable is set, and the operator's pages go back to every host.

### Putting it live (done on 13 October)

Both portals were rebuilt from this code on the morning of 13 October, at your word, hosted first (04:48:36 UTC) and then ollama (04:48:55). The images of the 12 October build are tagged `<name>:rollback-13oct` (for example `hcml-portal-portal-bff:rollback-13oct`). The command, in each folder:

```sh
BUILD_COMMIT=748136c-dirty BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose up -d --build
```

Checked without signing in: all four containers `healthy` with no restart, and the Zabbix stack untouched; both pages serve the new bundle `index-DIeBCwKH.js`, and the lazy chunks hold "Show data", the model note and the `sticky-end` class; each BFF reports `NET_GROUP_IDS=7,19,20,22,23,24`, an empty write token, its own 64-character `JWT_SECRET` (the two differ) and its build stamp; `/api/health` answers `writeBack: false` on both; `/api/problems` is refused with 401; the BFFs log one warning each, that the write token is not set, and the web logs hold nothing.

Not checked, because it needs a sign-in on this build: the footer line (`Build 748136c-dirty, 13/10/2026, 11.48.36 WIB` on :8081 and `11.48.55 WIB` on :8082), a report download through nginx's buffer, the live stream, the Problems page without its buttons, and a viewer's maps. `myown/checks/signedin_check.py` runs the first four against a portal; it reads the sign-in from `PORTAL_USER` and `PORTAL_PASSWORD` and prints neither.

To go back: `docker tag <name>:rollback-13oct <name>:latest` for the four images, then `docker compose up -d --no-build` in each folder. The settings are a separate matter. The `.env` values from before the change are in the private folder the work used, which goes when the macOS temp folder is cleaned; a write token can be made again in Zabbix.

### Left alone, and why

* SC-06, SC-01 and IN-08. Making the GitHub repository private and revoking the token in `cb97069`, rotating the Anthropic key, and putting `hcml-portal-ollama` under git are yours, and you said to leave them.
* SC-15. The caps stay: 100 screens in all (`STREAM_MAX_CLIENTS`) and 5 per user (`STREAM_MAX_PER_USER`). A wall of more than five screens on one shared login needs the second raised in `.env`.
* BK-14. Query and response schemas change how every query string is read, and generating the OpenAPI file adds `@fastify/swagger`, a dependency.
* FR-16. What is left is generating the web types from the OpenAPI file with `openapi-typescript`, a dev dependency.
* IN-11. A smaller stream frame risks delaying frames past the 45 second watchdog that the Dashboard uses to notice a dead stream.
* BK-13. Rounding explicit graph ranges to the minute gains nothing: the range picker already sends minute-aligned times.
* IN-13 and IN-25. One repository with two deployment profiles is a structure decision, and the Linux compose file needs a Linux server to try it on.
