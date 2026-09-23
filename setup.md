# setup.md: How the HCML Monitoring Portal Works

A deep-dive into the architecture, data flow, and the Zabbix-native features this portal
re-implements. Read [README.md](README.md) first for installation and configuration; this document
explains *how it all fits together* and *why*.

It is the reference you grep, not the one you read front to back: 29 sections, one per subsystem.
Sections 14–26 are the only written record of why the derived figures are calculated the way they
are, so they matter most when a number has to be defended.

**§§27–29 were reconstructed on 22 September 2026**, not restored. They cover the limitations, the
glossary and HCML's six goals: the three things lost when `DOCUMENTATION.md` was deleted on 21
September without ever having been committed. Each says what it was rebuilt from.

For the API contract go to [`docs/api/openapi.yaml`](docs/api/openapi.yaml), which is checked against
the code; for *why* the system is shaped this way go to
[`docs/architecture/adr/`](docs/architecture/adr/).

> **On the section citations in the code.** Comments across `server/src` and `web/src` cite sections
> of this file: `setup.md §9`, `§20`, `§18` and so on. Until 21 Sep 2026 they cited `instruct.md`,
> the original build brief, which lives **outside** both repos at `myown/plan/instruct.md` and so
> could not be followed from a clone. The rules themselves did not change; the citations now point at
> the in-repo document that carries them.


---

## 1. The big picture

The portal is a **read-only, branded front-end for Zabbix**. Zabbix keeps doing what it's good at:
collecting metrics (agents, SNMP, ICMP), evaluating triggers, storing history. The portal is a
separate app that **reads** that data through the **Zabbix JSON-RPC API** and presents it as an
HCML-branded NOC dashboard.

```
 ┌─────────────────────────┐   HTTPS + SSE      ┌──────────────────────────┐   JSON-RPC 2.0    ┌───────────────┐
 │  Browser (React SPA)     │ ─────────────────► │  BFF  (Fastify + TS)      │ ────────────────► │  Zabbix API    │
 │  http://localhost:5173   │ ◄───────────────── │  http://localhost:4000    │ ◄──────────────── │  :8080         │
 │  • no token              │   /bff/api/*       │  • holds the token        │  host.get, ...    │  → PostgreSQL  │
 │  • never talks to Zabbix │                    │  • caches, aggregates     │                   └───────────────┘
 └─────────────────────────┘                    └──────────────────────────┘
```

Three hard rules drive the whole design (from the original build brief, `myown/plan/instruct.md`
§0, outside both repos, so quoted rather than linked):

1. **The browser never calls Zabbix.** Only the BFF has the API token.
2. **Read-only, least privilege.** The portal reads with a dedicated read-only token. The single
   exception is acknowledge/close, which uses a **separate** write token and is off unless
   configured. See [§20](#20-acknowledge--close-write-back).
3. **Cache everything.** Every Zabbix call hits its server + DB, so responses are cached with short TTLs.

### Why a BFF (Backend-for-Frontend)?
- **Security**: the long-lived Zabbix token stays server-side. If it were in the browser, anyone
  could read it from dev-tools and hit Zabbix directly.
- **Shaping**: Zabbix's API is raw and chatty (e.g. `problem.get` doesn't include host names). The
  BFF *enriches* and *aggregates* so the UI gets exactly the shape it needs in one call.
- **Caching**: the BFF absorbs repeated/polled requests so a busy dashboard doesn't hammer Zabbix.
- **Decoupling**: Zabbix upgrades don't break the portal; it only depends on the stable API.

---

## 2. Request lifecycle (a concrete example)

What happens when the **Problems** page loads:

1. React calls `api.problems()` → `fetch('/bff/api/problems')`. No token in the browser.
2. **Dev:** Vite's proxy rewrites `/bff/api/problems` → `http://localhost:4000/api/problems`.
   **Prod:** nginx reverse-proxies `/bff/` → the `portal-bff` container.
3. The BFF route checks its **TTL cache** (`problems`, 5 s). On a hit it returns instantly.
4. On a miss it calls `getProblems()` which:
   - calls Zabbix `problem.get` (raw problems, no host names),
   - collects the trigger ids, calls `trigger.get` with `selectHosts` **once**,
   - stitches `hostid` + host `name` onto every problem.
5. The enriched JSON is cached and returned to the browser.
6. React renders the table; a timer re-polls every 5 s (cheap: mostly cache hits).

This "call Zabbix, enrich, cache, serve a clean shape" pattern is the same for every endpoint.

---

## 3. Zabbix-native feature mapping

The sidebar and pages intentionally mirror Zabbix's own **Monitoring** and **Reports** menus. Each
portal view maps to Zabbix concepts and API methods:

| Portal page (sidebar)      | Zabbix native equivalent        | BFF endpoint                      | Zabbix API methods used                     |
|----------------------------|---------------------------------|-----------------------------------|---------------------------------------------|
| **Dashboard**              | Monitoring → Dashboard          | `/api/stats`, `/api/reports/problems-by-group`, `/api/problems` | `host/item/trigger/hostgroup.get` (counts), `problem.get`, `trigger.get` |
| **Problems**               | Monitoring → Problems           | `/api/problems`                   | `problem.get`, `trigger.get` (host names)   |
| **Sites**                  | *(none: see [§14](#14-site-view))* | `/api/sites`                  | `host.get` (+ tags, inventory, groups), `problem.get` |
| **Hosts**                  | Monitoring → Hosts              | `/api/hosts/overview`             | `host.get` (+ interface availability), `problem.get` |
| **Latest data**            | Monitoring → Latest data        | `/api/latest`                     | `item.get` (lastvalue/lastclock/prevvalue)  |
| **Graphs**                 | Monitoring → Hosts → Graphs     | `/api/history`, `/api/items`      | `item.get`, `history.get`, `trend.get`      |
| **Maps**                   | Monitoring → Maps               | `/api/maps`, `/api/maps/detail`   | `map.get` (selements + links)               |
| **Network**                | (SNMP/ICMP hosts, §13)          | `/api/net/*`                      | `host.get`, `item.get` (icmp*, net.if.*)    |
| **Links & WAN**            | *(none: see [§17](#17-link--wan-health))* | `/api/links`           | `item.get` (icmpping / icmppingloss / icmppingsec) |
| **Services**               | Services                        | `/api/services`                   | `service.get` (+ children, problem events), `sla.get`, `sla.getsli` |
| **SLA**                    | Services → SLA                  | `/api/sla`, `/api/sla/sli`        | `sla.get`, `sla.getsli`, `service.get` |
| **Availability**           | *(none: see [§18](#18-automated-reporting))* | `/api/reports/availability`, `/api/reports/aging` | `event.get` (problem/recovery pairs) |
| **Capacity**               | Reports → Top 100 (adjacent)    | `/api/reports/capacity`           | `item.get`, `trend.get` → `history.get` fallback |
| **Alert noise**            | *(none: see [§21](#21-alert-noise--flapping))* | `/api/reports/noise`  | `event.get` (problem/recovery pairs, per trigger) |
| **Top 100 triggers**       | Reports → Top 100 triggers      | `/api/reports/top-triggers`       | `event.get` (aggregated by trigger)         |
| **Inventory scorecard**    | *(none: see [§16](#16-inventory--ownership-scorecard))* | `/api/reports/inventory` | `host.get` (+ tags, inventory, groups) |

> **Config is deliberately *not* re-implemented.** Creating hosts/items/triggers/users stays in
> Zabbix's native UI (the "hybrid" approach). The portal is the read-only NOC view.

Five things have **no** Zabbix equivalent, and they're the point of the portal:

| View | Why Zabbix can't do it | HCML goal |
|---|---|---|
| **"Explain"** on Problems and SLA ([§13](#13-plain-language-layer-ai)) | Zabbix speaks to engineers; this speaks to everyone else | Goal 4 |
| **Sites** board ([§14](#14-site-view)) | Zabbix has no site object: it's derived | Goal 5 |
| **Inventory scorecard** ([§16](#16-inventory--ownership-scorecard)) | Zabbix stores the fields but never scores them | Goal 1 |
| **Links & WAN** ([§17](#17-link--wan-health)) | Zabbix has items, not *links* with a main/standby relationship | Goal 3 |
| **Availability & aging** ([§18](#18-automated-reporting)) | Zabbix stores events; turning them into uptime is arithmetic it doesn't do | Goal 6 |
| **Alert noise** ([§21](#21-alert-noise--flapping)) | Zabbix shows you every alarm; it never tells you which ones weren't worth sending | Goal 4 |

---

## 4. The "logics" that match Zabbix

Beyond layout, the portal reproduces Zabbix's *semantics* so the numbers mean the same thing:

- **Severity** (`0..5`), Not classified → Disaster, using Zabbix's exact color palette
  ([`web/src/theme.ts`](web/src/theme.ts) `SEVERITIES`). Used everywhere as badges and count chips.
- **Host availability**: Zabbix 7.0 tracks availability **per interface** (`available`: 0 unknown,
  1 available, 2 unavailable). The portal rolls interfaces up to a host state (*worst wins*) in
  [`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.
- **Problem status & duration**: `r_eventid !== '0'` ⇒ *Resolved*, else *Problem*. Duration is
  `recovery_time − onset` (or *now* if still open), matching Zabbix's "Duration" column.
- **Acknowledgement**: `acknowledged` flag surfaced as a pill and a filter.
- **Item value types**: `0` float, `1` char, `2` log, `3` uint, `4` text. Only numeric items
  (0/3) are offered for graphing; `history.get` is called with the matching `history` param.
- **Interface types**: `1` Agent, `2` SNMP, `3` IPMI, `4` JMX (shown on the Hosts page).
- **Maintenance**: `maintenance_status = 1` renders a "Maintenance" pill.
- **Top-100 aggregation**: mirrors Zabbix's report by counting `PROBLEM` events per trigger over a
  time window via `event.get`.

---

## 5. Backend (BFF): file by file

Location: [`server/src/`](server/src/). Stack: Node 20 + Fastify + TypeScript (ESM).

| File | Responsibility |
|------|----------------|
| [`config.ts`](server/src/config.ts) | Typed env (ZBX_URL/TOKEN, timeouts, port, CORS origin, proxy trust, rate limit, network group ids, report thresholds, auth, AI). Warns on incomplete config; **throws** on an authenticated server still using the placeholder `JWT_SECRET`. |
| [`zabbix.ts`](server/src/zabbix.ts) | The **only** place Zabbix tokens are used. `zbx()` reads with `ZABBIX_API_TOKEN`; `zbxWrite()` writes with the separate `ZABBIX_WRITE_TOKEN` (§20). Raises `ZabbixAuthError` when a token is rejected and `ZabbixTimeoutError` when Zabbix does not answer within `ZABBIX_TIMEOUT_MS`: `fetch` has no default timeout, so without that ceiling one hung Zabbix holds every page open. |
| [`ai.ts`](server/src/ai.ts) | The **only** place a model credential is used: the LLM analog of `zabbix.ts`. `humanize(kind, payload)` returns schema-validated JSON. Two backends behind `AI_PROVIDER`: hosted Claude, or any OpenAI-compatible server (a local Ollama). |
| [`cache.ts`](server/src/cache.ts) | TTL `Map` cache **+ in-flight coalescing** (concurrent misses for the same key await one fetch, so polling can't stampede Zabbix), plus `invalidate(prefix)` used after a write-back. |
| [`queries.ts`](server/src/queries.ts) | Shared `getProblems()` (host-enriched) and `getHostsWithMeta()` (tags + inventory + groups). Reused by REST, SSE, Sites and the scorecard. |
| [`auth.ts`](server/src/auth.ts) | JWT login + **RBAC** (viewer / operator / admin) + `onRequest` guard. See [§19](#19-authentication--rbac). |
| [`routes/hosts.ts`](server/src/routes/hosts.ts) | `/api/hosts`, `/api/hosts/overview`, `/api/hostgroups`, `/api/items`, `/api/latest`. |
| [`routes/problems.ts`](server/src/routes/problems.ts) | `/api/problems` (cached 5 s). |
| [`routes/history.ts`](server/src/routes/history.ts) | `/api/history` (raw) + `/api/trend` (long ranges = hourly aggregates) + `/api/graph` (chart-ready series for 1–4 items). |
| [`routes/net.ts`](server/src/routes/net.ts) | `/api/net/devices` (+ ICMP), `/api/net/ports`, `/api/net/interfaces`, `/api/net/status`, `/api/net/map`. |
| [`routes/reports.ts`](server/src/routes/reports.ts) | `/api/reports/top-triggers`, `/api/stats`, `/api/reports/problems-by-group`. |
| [`routes/maps.ts`](server/src/routes/maps.ts) | `/api/maps` (list), `/api/maps/detail` (topology). |
| [`routes/stream.ts`](server/src/routes/stream.ts) | `/api/stream`, SSE, pushes live problems every 5 s + keep-alive. Shares the `problems` cache key, so N screens cost one poll. |
| [`routes/sites.ts`](server/src/routes/sites.ts) | `/api/sites`, rolls every host up to a site, plus site-mapping coverage. |
| [`routes/services.ts`](server/src/routes/services.ts) | `/api/services`: the service hierarchy with roll-up status, root causes and SLA. |
| [`routes/sla.ts`](server/src/routes/sla.ts) | `/api/sla`, `/api/sla/sli`, Zabbix Services → SLA, read-only. |
| [`routes/inventory.ts`](server/src/routes/inventory.ts) | `/api/reports/inventory`: the standardisation scorecard (admin only). |
| [`routes/links.ts`](server/src/routes/links.ts) | `/api/links`, SD-WAN / radio / Starlink link health from ICMP items. |
| [`routes/analytics.ts`](server/src/routes/analytics.ts) | `/api/reports/availability`, `/api/reports/aging`, `/api/reports/capacity`, `/api/reports/noise`. Shared `fetchIncidents()` backs availability + noise. |
| [`routes/actions.ts`](server/src/routes/actions.ts) | `/api/problems/acknowledge`: the portal's **only** write (§20). |
| [`routes/explain.ts`](server/src/routes/explain.ts) | `/api/explain/problem`, `/api/explain/sla`: the plain-language layer. On-demand + cached. |
| [`chat.ts`](server/src/chat.ts) | The assistant: `buildSnapshot()` renders the estate as capped plain text from the pages' own caches; `streamAnswer()` streams the model's reply for either backend. No tools, no writes. See [§24](#24-assistant-chat). |
| [`routes/chat.ts`](server/src/routes/chat.ts) | `POST /api/chat`, validates the conversation, then streams `context` → `token`… → `done` as SSE. A POST that performs no write. `GET /api/chat/warm` asks the model to load now, so the first question does not wait for it. |
| [`routes/sli.ts`](server/src/routes/sli.ts) | `/api/sli`: the derived monthly SLA, computed in the portal from ICMP triggers (§25). |
| [`errors.ts`](server/src/errors.ts) | Typed failure → HTTP mapping, in one place: `ZabbixAuthError`/`ZabbixTimeoutError`/write-disabled → **503**, AI upstream → **502**, anything else → 500. Separate from `index.ts` so tests can mount it without starting a server. |
| [`index.ts`](server/src/index.ts) | Builds the Fastify app and registers, in this order: helmet → CORS → rate limit → auth → the seventeen route plugins. Validates config **before** listening and exits rather than booting unsafely. |
| [`server/src/__tests__/`](server/src/__tests__/) | 336 vitest tests. Zabbix is mocked at `zabbix.ts`, the one point all API traffic funnels through. See [§22](#22-testing). |

### Endpoint reference (+ cache TTLs)

| Method + path | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{ ok, ts, ai, writeBack }`, capability flags; the UI hides actions that aren't configured | — |
| `GET /api/hosts` | hosts + interfaces (ip/type/available) | 30 s |
| `GET /api/hosts/overview` | hosts + per-host problem severity counts | 15 s |
| `GET /api/hostgroups` | host groups (real hosts only) | 60 s |
| `GET /api/items?hostid=&search=` | items of a host | 30 s |
| `GET /api/latest?hostid=\|groupid=&search=` | items + last value/time/prev | 15 s |
| `GET /api/problems` | enriched current problems | 5 s |
| `GET /api/history?itemid=&hours=&history=` | raw history points | 15 s |
| `GET /api/trend?itemid=&hours=` | hourly trend aggregates | 60 s |
| `GET /api/net/devices` | network hosts + ICMP up/loss/latency | 30 s |
| `GET /api/net/ports?hostid=` | `net.if.*` items | 15 s |
| `GET /api/reports/top-triggers?days=` | top 100 triggers by event count | 60 s |
| `GET /api/stats` | host/item/trigger/group + problem counts | 30 s |
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
| `POST /api/problems/acknowledge` | acknowledge and/or close **(operator)** | writes |
| `GET /api/explain/problem?eventid=` | plain-language summary + tag glossary | **1 h** |
| `GET /api/explain/sla?slaid=&serviceid=` | plain-language SLA standing | **5 min** |
| `POST /api/chat` | **SSE** assistant answer: `context` → `token`… → `done` / `error`. See [§24](#24-assistant-chat) | snapshot reads share the page caches |
| `GET /api/stream` | **SSE** live problems | live |
| `POST /api/auth/login` | `{ token, user }` (when auth on) | — |
| `GET /api/auth/me` | `{ authEnabled, user: { name, role } }`, drives the sidebar's role filter | — |
| `GET /api/graph` | chart-ready series for 1–4 numeric items over a pinned window | 15 s |
| `GET /api/net/interfaces?hostid=` | SNMP interfaces with oper/admin status, speed, utilisation | 15 s |
| `GET /api/net/status` | per-device reachability roll-up | 30 s |
| `GET /api/net/map` | Zabbix topology for the network view | 60 s |
| `GET /api/sli?month=&profile=` | the derived monthly SLA (§25) | 60 s |
| `GET /api/sla/source` | which SLA backing is in use: Zabbix services, or derived | 60 s |
| `GET /api/services/derived?month=&profile=` | the service tree derived from the estate | 30 s |
| `GET /api/chat/warm` | 202; asks the model to load now so the first question does not wait | — |

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
plain CSS (primary `#0067B1`, Inter, gradient sidebar, rounded cards).

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
[`Sidebar.tsx`](web/src/components/Sidebar.tsx) defines three collapsible sections, **Monitoring** and
**Reports** mirror Zabbix's menu; **Assistant** ([§24](#24-assistant-chat)) has no Zabbix
equivalent. Each section header toggles open/closed; the active route is
highlighted. Add a page by dropping an entry in the `SECTIONS` array and a `<Route>` in
[`App.tsx`](web/src/App.tsx).

### Data flow in the UI
- **`useAsync(fn, deps, intervalMs?)`**: most pages fetch with this; pass an interval to poll
  (Problems 5 s, Hosts 30 s, Latest 20 s). It exposes `{ data, loading, error, reload }`, rendered
  through the `<Async>` helper so every page gets consistent loading/error/empty states.
- **`useSSE(url, event)`**: the Dashboard subscribes to `/bff/api/stream` for **live** problems and
  falls back to polling if the stream drops.
- **Cross-page links**: Hosts → `/graphs?hostid=…`, Latest data → `/graphs?hostid=…`. `HostDetail`
  reads the `hostid` query param to preselect.

---

## 7. Live updates (SSE)

Server-Sent Events are the simplest live-push transport (chosen over WebSocket in the build brief,
`myown/plan/instruct.md` §2; recorded as [ADR-0002](docs/architecture/adr/0002-react-typescript-fastify.md)).

- BFF: [`routes/stream.ts`](server/src/routes/stream.ts) opens an `text/event-stream`, pushes an
  `event: problems` frame every 5 s and a `: keep-alive` comment every 15 s. It cleans up its timers
  on client disconnect. `X-Accel-Buffering: no` tells nginx to stream, not buffer.
- Browser: [`useSSE`](web/src/hooks/useSSE.ts) wraps `EventSource`. Because `EventSource` can't set
  headers, when auth is enabled the token is passed as `?token=` and verified server-side.

---

## 8. Authentication (mechanics)

`AUTH_ENABLED=true` turns on a JWT flow: `POST /api/auth/login` returns a 12 h JWT carrying the
user's **role**; an `onRequest` guard then rejects unauthenticated `/api/*` calls (health and auth
excepted) and checks the role against the route. The Zabbix token is **never** exposed regardless:
portal auth gates the portal's own routes only.

The browser stores the JWT in `localStorage`; [`api.ts`](web/src/api.ts) attaches it and redirects to
`/login` on a 401. `EventSource` can't set headers, so the SSE route accepts `?token=` instead.

> **Roles, route rules, and the user model are in [§19](#19-authentication--rbac).** That section is
> the authority; this one is just the transport.

---

## 9. Caching strategy

- Each endpoint wraps its Zabbix call in `cached(key, ttlMs, fn)`.
- TTLs are tuned to how fast the data moves: problems 5 s, availability/latest 15 s, hosts 30 s,
  static-ish lists (groups, maps) 60 s.
- **In-flight coalescing**: if 10 browser tabs poll `/api/problems` at once during a cache miss, only
  **one** `problem.get` hits Zabbix; the rest await the same promise.
- Scaling path: swap the in-memory `Map` for **Redis** (shared cache + SSE fan-out) without touching
  route code: the `cached()` signature stays the same.

---

## 10. Network monitoring (SNMP / ICMP)

The portal reads network gear exactly like any other host: it **never speaks SNMP itself**
(build brief `myown/plan/instruct.md` §13). Zabbix's server/proxy polls devices; the portal reads
the resulting items:

- **Availability**: ICMP items `icmpping` (up/down), `icmppingloss` (%), `icmppingsec` (latency),
  merged per device in `/api/net/devices`.
- **Ports/interfaces**: SNMP LLD creates `net.if.in[...]`/`net.if.out[...]`, `ifOperStatus`, etc.;
  `/api/net/ports` reads them, and interface traffic graphs reuse `/api/history`.
- **Onboarding is a later phase** (the "network plug", §13.4): set `NET_GROUP_IDS` on the BFF and add
  devices in Zabbix. The network **views populate automatically**, no portal code change.

---

## 11. Running & deploying

**Dev** (two processes):
```bash
cd server && cp .env.example .env   # set ZBX_URL + ZABBIX_API_TOKEN
npm install && npm run dev          # BFF on :4000  (tsx watch, auto-reloads)
cd ../web && npm install && npm run dev   # Vite on :5173, proxies /bff -> :4000
```

`tsx watch` does **not** watch `.env`: after editing it, restart the BFF.

**Prod** (Docker, next to Zabbix):
```bash
cp .env.example .env                # ZBX_URL, ZABBIX_API_TOKEN, and a real JWT_SECRET
docker compose up -d --build        # nginx serves web + reverse-proxies /bff -> BFF, on :8081
```

Three things about the Docker path that are easy to get wrong, and were:

1. **`JWT_SECRET` has no default.** Compose refuses to interpolate without it, and the BFF exits if
   it is still the placeholder. An authenticated portal signing tokens with a value published in
   this repo looks perfectly healthy while anyone can forge an admin token, so this fails loudly
   rather than warning.
2. **The two compose projects share no network.** Zabbix runs in project `proto1`, the portal in
   `hcml-portal`, so `portal-bff` cannot resolve `zabbix-web` by DNS. `ZBX_URL` therefore defaults
   to `host.docker.internal:8080`. `localhost` inside the container means *the container*, which is
   why `server/.env`'s dev value must not be reused verbatim.
3. **`.dockerignore` is load-bearing.** `web/Dockerfile` does `COPY . .` after `npm ci`; without it
   the host's platform-specific `node_modules` lands on top of the linux one and `vite build` fails
   on esbuild's binaries. That is why the image could not be built at all before 2026-09-08.

Verify the chain any time:
```bash
curl localhost:4000/api/health                  # BFF alive (dev)
curl localhost:8081/bff/api/health              # browser → nginx → BFF (prod)
curl -sI localhost:8081/reports/availability    # 200 = SPA fallback works on deep links
```

---

## 12. Extending the portal (recipe)

To add a new Zabbix-backed view:

1. **BFF**: add a route that calls `zbx('<method>', {...})` wrapped in `cached()`; enrich/aggregate
   as needed. Register it in `index.ts`.
2. **Types**: add the response shape to `web/src/types.ts`.
3. **API client**: add a method to `web/src/api.ts`.
4. **Page**: build it with `useAsync` + `<Async>`; reuse `SeverityBadge`, `SeverityCounts`,
   `TimeSeriesChart`, tables.
5. **Wire**: add a `<Route>` in `App.tsx`, a link in `Sidebar.tsx`, and a title in `Layout.tsx`.

That's the whole pattern: every existing page is an instance of it.

---

## 13. Plain-language layer (AI)

Implements [`../plan/plan_1.1.md`](../plan/plan_1.1.md). HCML's own overview names the gap: *"the main issue is
not the number of alarms, but the quality of information needed to act."* Tags like `class: os`,
`scope: availability` and wording like *"Zabbix agent is not available (for 3m)"* are precise for an
engineer and opaque to everyone else. This layer translates them.

**Scope is deliberately narrow**: tags, SLA figures, and notification wording. The assistant
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
credential is read from `config` and **never** reaches the browser, and now so is its transport, in
that both hand-roll one `fetch` rather than taking a dependency for a single POST.

`humanize()` is the only export. It picks a backend from `AI_PROVIDER`, hands both the *same* system
prompt, instructions and JSON Schemas, and returns the parsed result:

| Backend | Transport | "obey this schema" is spelled |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | `output_config.format.json_schema` |
| `openai-compatible` | raw `fetch` | `response_format.json_schema` |

Both are *enforced*, not requested: Anthropic by structured outputs, Ollama by constraining the
sampler to the schema's grammar, so the response is guaranteed to match the shape the UI renders,
with no parsing guesswork and no validation dependency.

What a schema **cannot** enforce is that the model actually filled it in: a small local model will
occasionally satisfy the shape with empty strings. `assertComplete()` catches that and raises
`AiUpstreamError` rather than rendering a blank panel that looks like a portal bug.

### The two translations

| Endpoint | Input from Zabbix | Output |
|---|---|---|
| `/api/explain/problem?eventid=` | trigger name + `opdata` (**this is the notification text**), severity, host, age, ack state, and every tag | `summary`, `tagsExplained[]` (a glossary, one row per tag), `businessImpact`, `recommendation` |
| `/api/explain/sla?slaid=&serviceid=` | SLO target, period, and per-service SLI / uptime / downtime / error budget | `status`, `plain`, `meetingTarget`, `recommendation` |

One problem endpoint covers **both** tags and notification wording, because the trigger name plus
`opdata` *is* the notification as the team receives it.

### Design rules

- **On-demand only.** Nothing calls the model on page load. The user clicks "Explain"; that is the
  only trigger. No bulk or background runs.
- **Cached hard.** A problem explanation lives 1 h, an SLA explanation 5 min. Five clicks on the same
  problem = **one** model call (measured), and every NOC screen shares the same cache.
- **Never invents.** The system prompt forbids adding facts not present in the input: the model
  rephrases what Zabbix returned. The panel footer says so to the reader.
- **Optional.** Unconfigured, no `ANTHROPIC_API_KEY` on the hosted backend, no `AI_BASE_URL` on
  the local one: the portal is fully functional; `/api/health` reports `ai: false` and the UI hides
  the buttons rather than offering one that can only fail. Note that "configured" means something
  different per backend, which is why `config.ai.enabled` branches on the provider.
- **Fails alone.** A model outage (including nothing listening on `AI_BASE_URL`) returns
  `502 {error:'ai_error'}` on the explain routes only; every monitoring endpoint keeps serving 200.

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

Swapping **provider** as well as model is now a config change, not a code change. Set up the local
side with `brew install ollama && brew services start ollama && ollama pull qwen3:8b`, natively, not
in a container: Docker Desktop on macOS cannot reach the Metal GPU.

One model-specific wrinkle lives in `ai.ts`: reasoning models such as Qwen3 think before they
answer by default, which fights grammar-constrained decoding, eats the output budget, and, measured
on Ollama 0.33, turns a 3-second explanation into a 15-second one, with about a thousand characters
of hidden reasoning per call. Two plausible levers do **not** work on Ollama's OpenAI-compatible
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

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 1, serving HCML **Goal 5** (*"dashboards are not
tailored for NOC, engineers, and management"*). HCML's estate is organised by site: JKT HQ, SBY,
SSB, FPSO KAS3, BD-WHP, MOPU/MAC, MBH, MDA, MDK, Sapudi, Sumenep, ORF Porong, TWSB, GMS Pasuruan,
but every view before this one was a flat host list. Management reads sites, not hostnames.

### Zabbix has no "site"

There is no site object in the Zabbix API, so the BFF derives one. HCML's **Goal 1** says site
mapping *isn't standardised yet*, so [`routes/sites.ts`](server/src/routes/sites.ts) refuses to
assume a convention and instead tries the most deliberate signal first:

| # | Signal | Zabbix source | Why this order |
|---|---|---|---|
| 1 | Host **tag** `site` | `selectTags` | Deliberate and unambiguous. Tag name is `SITE_TAG`. |
| 2 | Site code in the **host name** | [`naming.ts`](server/src/naming.ts) `siteFromHostName()` | HCML's own convention: `4.3.3 FPSO ARUBA 3` is site 4, `INET : SAMPANG WAN 1` is site 3. No HCML host carries a site tag, and its host groups (`ARUBA`, `FIREWALL DEVICES HCML`) name device types, not places, this places 134 of 142 hosts. |
| 3 | Host **inventory** | `selectInventory` → `site_city`, then `location` | Zabbix's own field for this. |
| 4 | Host **group** | `selectHostGroups` | Every host has one, so this always resolves. |

> **Gotcha:** Zabbix has **no `site_name` inventory field**: the real ones are `site_city` and
> `location`. Asking for a field that doesn't exist is silently ignored, not an error.
>
> Set `SITE_GROUP_PREFIX` (e.g. `Site/`) when site groups are named `Site/JKT HQ`; the prefix is
> stripped. Left empty, step 3 uses the host's first host group: a guess, and reported as one.

### Coverage is the Goal 1 metric

The response carries `coverage: { hosts, tag, name, inventory, group }`, and the page turns it into one
sentence: *"86% of hosts carry an explicit site; the rest are grouped by host group, which is a
guess."* The portal is read-only so it can't enforce standards: but it **measures** them, which is
what makes Goal 1 actionable. As HCML tags hosts, the number goes up.

### What the board shows

Sites sort **worst-first** (highest live severity, then most unreachable hosts, then name) so a NOC
wall leads with what needs attention. Each card carries the site's worst-severity colour stripe,
problem and unacknowledged counts, Zabbix severity chips, and down/unknown/maintenance tallies.
Selecting a card lists that site's hosts with availability, status, and per-host severity chips.

Availability is rolled up per Zabbix 7.0 semantics: availability lives on the *interface*, and the
host state is **worst wins** (any interface unavailable ⇒ host unavailable), matching
[`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.

### Trying it

```bash
curl localhost:4000/api/sites | jq '.coverage, [.sites[] | {name, worst, problems}]'
```

---

## 15. Services tree

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 2, serving HCML **Goal 2**: the review's
*stated core problem*:

> **Monitoring is still device-centric and reactive; the target is service-centric and proactive.**

Every other page in this portal answers *"which host is broken?"*. This one answers *"which
**service** is degraded, and why?"*, so a failure reads as **"BD FPSO, Voice path is degraded,
because the agent on FGR-60F-FPSO-01 stopped reporting"** rather than a bare host alert.

### Zabbix does the roll-up; the portal makes it legible

Zabbix already computes service status and attributes the causing problems. `service.get` gives:

| Field | Meaning |
|---|---|
| `status` | `-1` = OK, otherwise the **severity that propagated up** from below |
| `problem_events` | the problems Zabbix blames for that status (**snake_case** in the response) |
| `algorithm` | `0` set to OK · `1` most critical **if all children** have problems · `2` most critical of children |
| `parents` / `children` | the hierarchy |

[`routes/services.ts`](server/src/routes/services.ts) assembles roots (services with no parents),
recurses, and attaches each service's SLA, `sla.get` + `sla.getsli`, so target and achieved sit on
the same row as the status.

### Services are a DAG, not a tree

A shared dependency legitimately sits under **two** parents (in the demo data, *Shared SD-WAN core*
hangs off both Offshore and Onshore). Two consequences the code handles explicitly:

- **Recursion is path-guarded** and depth-capped (`MAX_DEPTH`), so a malformed hierarchy can't hang
  the request.
- **`descendants` counts distinct service ids, not tree positions.** Summing `1 + child.descendants`
  double-counts a shared node: the root reported *6 services below* when only **5** existed.

That shared node is also the clearest demonstration of the whole feature: when it degrades, *both*
branches degrade with it. That is a dependency, which is exactly what device-centric monitoring
cannot show.

### On the page

Degraded branches are **expanded by default** and healthy ones folded away: a NOC wall should open
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

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 4, serving HCML **Goal 1**:

> *"Host naming, site mapping, owner, criticality and dependency are not standardised → alarms are
> hard to route to the right PIC."*

The portal is read-only, so it **cannot enforce** a standard. What it can do is **measure** one:
turning an invisible governance problem into a number that goes up as hosts get tagged. That is the
entire point of this page.

### The four scored dimensions

| Dimension | Counts as present when | Configure with |
|---|---|---|
| **Naming** | host name matches a regex | `HOST_NAME_PATTERN` (empty ⇒ *not scored*) |
| **Site** | an **explicit** marker exists: tag or inventory | `SITE_TAG` |
| **Owner / PIC** | inventory `poc_1_name` / `poc_1_email`, or a tag | `OWNER_TAG` |
| **Criticality** | a criticality tag | `CRITICALITY_TAG` |

**Site is deliberately strict.** [`resolveSite()`](server/src/routes/sites.ts) always returns
*something* (falling back to a host group), but the scorecard counts only `tag` and `inventory` as
present. Falling back to a group is exactly the ambiguity Goal 1 names, so it scores as a gap: the
scorecard and the Sites board agree on the same 86% figure for that reason.

### HCML's naming convention

Read off HCML's own **Availability Reports (2026-06, -07, -08)**, not inferred. Two forms coexist:

```
devices    <site>.<class>[.<seq>] NAME     1.2.1 IDX02CORESWITCH    11.3.5 MOPU ARUBA 5
services   <TYPE> : NAME                   INET : SAMPANG WAN 1     SERVER : CUCM JAKARTA
```

Shipped as the default `HOST_NAME_PATTERN`:

```
^(\d{1,2}\.\d{1,2}(\.\d{1,2})?\.?\s|(INET|WEB|SERVER)\s:\s).+$
```

The **leading digit is the site**:

| # | Site | # | Site | # | Site |
|---|---|---|---|---|---|
| 1 | Jakarta (IDX) | 6 | Sumenep (SUP/STP) | 11 | MOPU / MAC |
| 2 | Surabaya (SBY) | 7 | Sapudi | 12 | Porong (POR) |
| 3 | SSB / Sampang (SAM) | 8 | MDA | 13 | Tanjung Wangi (TJWB) |
| 4 | FPSO KAS3 & BD-WHP | 9 | MBH | 14 | TWSB |
| 5 | Pasuruan / GMS | 10 | FPU | | |

**The pattern is deliberately tolerant, and that is the point.** HCML does not apply its own
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

The fifth dimension HCML lists, **dependency**, is answered by the
[Services tree](#15-services-tree) rather than a per-host field: a host is in a dependency map when
the service hierarchy covers it. Scoring it per host would be a worse answer than the real one.

### Design notes

- A **broken `HOST_NAME_PATTERN` doesn't take the endpoint down.** An invalid regex is caught and the
  dimension reports `scored: false`, so a config typo degrades to "not measured", never a 500.
- Groups are sorted **worst-first**: that's where the standardisation work is.
- The gap list downloads as **CSV**, so the work can be handed to whoever owns those hosts.
- Admin-only: this is governance, not monitoring ([§19](#19-authentication--rbac)).

```bash
curl localhost:4000/api/reports/inventory | jq '.overall, [.dimensions[] | {label, pct, scored}]'
```

---

## 17. Link & WAN health

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 5, serving HCML **Goal 3** (telecom deep
visibility). HCML runs **12 main + 10 redundant SD-WAN links**, 10 P2P radio links, 18 internet
accesses and Starlink offshore. Their own topology slide flags
*"SD-WAN (to_mda_via_sapudi)(internal4): High packet loss"*, that class of fault deserves a
first-class view, not a row buried in Latest data.

### What a "link" is

Zabbix has items, not links. A link here is one **(host, ping target)** pair, stitched back together
from the three items Zabbix collects per target:

| Item key | Gives |
|---|---|
| `icmpping[<target>]` | up / down |
| `icmppingloss[<target>]` | packet loss %, and usually the most descriptive item *name* |
| `icmppingsec[<target>,,,,,<mode>]` | RTT; `min`/`max` modes let jitter be derived |

Two details that are easy to get wrong:

- **`monitored: true` is mandatory.** Without it `item.get` also returns **template** items, and the
  page fills with hundreds of identical unassigned prototypes. (Measured: 100+ phantom ICMP keys.)
- **Zabbix stores RTT in seconds**; the page reports milliseconds. Jitter is `max − min`, and is
  simply absent unless the min/max mode items exist: it is never faked.

### Redundancy is the point

A main + standby pair is only *truly* down when **every** leg is: that distinction is why the
redundancy is paid for. Pairing comes from the item tag `link_group` (with `link_role` naming the
leg), and a path rolls up as: any leg up ⇒ `up`, all legs up ⇒ `up`, mixed ⇒ `degraded`,
none up ⇒ `down`.

State per link is from `LINK_LOSS_WARN` (default 2%) and `LINK_LOSS_CRIT` (default 10%):
down if the ping fails or loss ≥ crit, degraded at ≥ warn, otherwise up. Operator role
([§19](#19-authentication--rbac)).

---

## 18. Automated reporting

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 6, serving HCML **Goal 6**: *"hard to see SLA,
capacity trends, and recurring issues."* Recurring issues were already covered by Top 100 triggers;
these add the other two, plus response time.

### Availability: `/api/reports/availability`

Zabbix stores events; turning them into uptime is arithmetic it doesn't do. The BFF replays history:

1. `event.get` for PROBLEM events in the window (severity-filtered).
2. Each carries `r_eventid`; those recovery events are fetched **in one batch** for their clocks.
3. Each problem becomes an interval, clipped to the window; still-open ones run to *now*.
4. **Overlapping intervals are merged per host**: two simultaneous problems are one outage, not
   two. Without this, availability can go *negative*, which is the trap here.

Availability is then *"share of the period with no open problem at or above the chosen severity"*,
and the page says exactly that, because it isn't the same thing as ICMP uptime.

> The read is bounded (`EVENT_LIMIT`, 10 000) and sets `truncated: true` when the window filled a
> page, and the UI then labels the figures a **floor**. Silently understating downtime while looking
> authoritative would be worse than saying so.

### Action aging: `/api/reports/aging`

How long problems sit unacknowledged, in buckets (<1h, 1–4h, 4–24h, >24h) plus the longest-waiting
list. This is the *"the team repeats manual checks"* half of Goal 4, measured.

### Capacity: `/api/reports/capacity`

Reads `trend.get` (hourly aggregates), **falling back to `history.get`** on an instance too young to
have trends: otherwise a fresh deployment shows an empty report and looks broken. Verified key
matchers:

| Metric | Matches | Trap |
|---|---|---|
| CPU | `system.cpu.util` **exactly** | `system.cpu.util[,idle]` is the *idle* share: the opposite |
| Memory | `vm.memory.util` | `vm.memory.size[available]` is bytes, not a percentage |
| Filesystem | keys ending `,pused]` | — |

Rows carry `source: 'trend' | 'history' | 'none'`, and the page states when a zero means *no data*
rather than *idle*.

---

## 19. Authentication & RBAC

Implements [`../plan/plan_1.2.md`](../plan/plan_1.2.md) Phase 7 and closes its defect #5. Every source slide in
HCML's review is stamped **Private and Confidential**, so an open portal is not deployable.

`AUTH_ENABLED=true` turns on JWT login; the `onRequest` guard then rejects unauthenticated `/api/*`
calls (health and the auth routes excepted). The Zabbix token is never exposed either way: **RBAC
decides who sees which portal view, not what the BFF may ask Zabbix.**

### Three roles

The portal is read-only today, so roles divide by **sensitivity and cost**, not write access:

| Role | Gets | Rationale |
|---|---|---|
| **viewer** | all monitoring, Sites, Services, SLA, reports: **and "Explain"** | The plain-language layer exists *precisely* for non-engineers. Gating it higher would defeat its purpose. |
| **operator** | + Network, Links & WAN | Engineering surfaces; also where acknowledge/close write-back will land. |
| **admin** | + Inventory scorecard | Governance, not monitoring. |

Enforcement lives in [`auth.ts`](server/src/auth.ts) `ROUTE_RULES`, **first match wins, and anything
unmatched requires `viewer`**: so a newly added route is protected by default rather than
accidentally public. A 403 explains itself: *"This view needs the admin role; you are signed in as
viewer."*

The sidebar hides what a role can't reach, but that is only courtesy: **the BFF enforces it
regardless**, and the UI never holds a permission decision the server doesn't also make.

### Users

There's no database yet (that phase was deferred), so users come from the environment:

```bash
AUTH_ENABLED=true
JWT_SECRET=<long random string>          # required; the default is warned about at boot
PORTAL_USERS=ana:secret:viewer,budi:secret:operator,citra:secret:admin
# or the single-admin shorthand:
PORTAL_USER=Admin
PORTAL_PASS=zabbix
```

Malformed entries are warned about and skipped; an **unknown role falls back to `viewer`**, never to
something more privileged. With `AUTH_ENABLED=false` the BFF reports role `admin` so the scaffold
runs open with zero setup: that is a dev convenience and `docker-compose.yml` defaults it to
**true**.

Next: SSO/LDAP in place of env users, and the acknowledge/close write-back through a separate
`ZBX_WRITE_TOKEN` (deliberately not the read-only token).

---

## 20. Acknowledge / close write-back

The portal's **only** write. Everything else in this BFF is read-only by design
(build brief `myown/plan/instruct.md` §0 rule 2; recorded as
[ADR-0006](docs/architecture/adr/0006-read-only-with-one-write.md)), so this route is fenced
deliberately rather than bolted on.

### Three independent fences

| # | Fence | Effect |
|---|---|---|
| 1 | **A separate `ZABBIX_WRITE_TOKEN`** | The read token never gains write power. If it did, *every* read path in the BFF would silently be able to modify Zabbix: one bug away from a write. |
| 2 | **`operator` role or above** | Enforced in [`auth.ts`](server/src/auth.ts) `ROUTE_RULES`; a viewer gets a 403 that names the role it needs. |
| 3 | **Blank token ⇒ 503** | With no write token the portal is *strictly* read-only, and the UI hides the button rather than offering one that fails. |

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
that Zabbix would reject, `getProblems()` carries a `manualClose` flag. Read from the **existing**
`trigger.get` call, so it costs no extra request, and the dialog disables the Close checkbox with
the reason shown.

### Caches must be dropped, not waited out

Problem state is cached for 5 s, and several other views derive from it. Without invalidation an
acknowledgement wouldn't appear until the TTL expired and the click would look like it did nothing.
After a successful write the route calls `invalidate()` on `problems`, `stats`, `probsByGroup`,
`sites`, `aging` and `services`. Measured: the very next `GET /api/problems` already showed
`acknowledged = 1`.

### On the page

Problems grows an **Ack** button (open problems only, and only when both fences 1 and 2 pass). It
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

**Not yet:** bulk acknowledge across a selection, and severity change (`action` bit `8`). Both are
small extensions of the same route.

---

## 21. Alert noise / flapping

Implements HCML **Goal 4**'s other half. The review's headline is the whole reason this page exists:

> **"The main issue is not the number of alarms, but the quality of information needed to act."**

[§13](#13-plain-language-layer-ai) answers *context*: what an alarm means. This answers the
question underneath it: **which alarms weren't worth sending?**

### Why Top 100 triggers isn't enough

Top 100 counts *how often* a trigger fired. That single number can't tell noise from signal.
Measured on the dev instance:

| Trigger | Fired | Median duration | Acknowledged | Reality |
|---|---|---|---|---|
| SD-WAN link flapping | **6** | **4 s** | 0% | Pure noise, cleared itself before anyone could look |
| Zabbix agent unavailable | 2 | 153 638 s | 100% | A real fault, open for two days |

Ranked by count, Top 100 puts the **noise first**. Duration and acknowledgement are what separate
them, so this report adds both.

### The three flags

A trigger carries *flags*, not one category: it can genuinely be both flapping and ignored:

| Flag | Condition | What it tells you |
|---|---|---|
| `flapping` | ≥ `NOISE_MIN_COUNT` firings **and** median < `NOISE_SHORT_SECONDS` | The threshold is too tight. Retune it. |
| `unactioned` | ≥ `NOISE_MIN_COUNT` firings **and** ack rate 0 | The team has learned to ignore it: the strongest retune signal there is. |
| `chronic` | still open **and** longest > 24 h | *Not* noise. One condition nobody has cleared. |

Defaults: `NOISE_SHORT_SECONDS=300`, `NOISE_MIN_COUNT=5`.

**Median, not mean.** One six-hour outlier would otherwise hide forty ninety-second firings: the
exact pattern the report exists to surface.

### The Pareto line

The headline for management, computed from the same data:

> **5 triggers produced 80% of all alerts in this period.**

That is HCML's own sentence turned into a number, and it points at the shortest path to a quieter
NOC: retune the few at the top rather than triage the rest.

### Implementation note: one fetch, two reports

Availability (§18) and this report ask different questions of the same history. Rather than
duplicate the trickiest code in the codebase, `fetchIncidents(days, minSeverity)` does the shared
work once: fetch PROBLEM events, batch-resolve their recoveries via `r_eventid`, clip to the window
, and each report groups the result its own way: availability by **host** (merging overlaps), noise
by **trigger**. `EVENT_LIMIT` and the `truncated` flag apply to both, so neither ever presents a
truncated count as authoritative.

### Trying it

```bash
curl "localhost:4000/api/reports/noise?days=7" | jq '.concentration, .counts'
```

---

## 22. Testing

`cd server && npm test`, 336 tests in 19 files, no live Zabbix required.

**The mock point.** Every Zabbix call in the server funnels through one `fetch` in
[`zabbix.ts`](server/src/zabbix.ts), exposed as `zbx()` and `zbxWrite()`. Mocking that single module
covers all seventeen route modules, so route tests drive the real handlers, the real cache and the
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

**What is tested, and why those things.** The suite is weighted toward code that fails *silently*
with a plausible wrong answer, not code that throws:

| Area | The failure it guards against |
|---|---|
| `mergedSeconds()` | Two triggers on one host counted as two outages, availability could compute as negative |
| `requiredRole()` table | A regex typo silently downgrading an admin route to `viewer`. No error, no log line |
| `cache.ts` | Losing in-flight coalescing: ten NOC screens become ten times the Zabbix load |
| `HOST_NAME_PATTERN` | The invented pattern that matched **zero** real HCML hosts and would have scored their estate at 0% |
| `severitiesAtLeast()` | An empty `severities` array, which makes Zabbix return nothing: a bad parameter becoming an empty report |
| API surface snapshot | A route added or renamed without a matching RBAC rule |
| Failure modes | A typed 503 swallowing a genuine 500, or vice versa |

**Layout.** Tests live in `server/src/__tests__/` so they resolve modules exactly as the app does.
`tsconfig.json` excludes that directory (tests must not ship in `dist/`); `tsconfig.test.json` puts
it back for typechecking, and `npm run typecheck` runs both: vitest transpiles without
typechecking, so without the second pass the tests would drift out of sync unnoticed.

---

## 23. Hardening: timeouts, rate limiting, headers

Three plugins and one timeout, all in [`index.ts`](server/src/index.ts), registered in an order that
matters.

**Timeouts.** `fetch` has no default timeout. Before this, one unresponsive Zabbix held the request
open forever and every page waiting on it with it. `zabbix.ts` now passes
`AbortSignal.timeout(config.zbxTimeoutMs)` and maps the abort to a typed `ZabbixTimeoutError` → 503,
alongside the existing `ZabbixAuthError`. Same reasoning as that one: *"Zabbix is not responding"*
and *"the portal is broken"* need different responses from whoever is reading the screen.

The hosted model client had the mirror-image problem: the SDK defaults to a **10-minute** timeout
and two retries, which is sane for a batch job and absurd for a request a human is waiting on behind
a button. Both are now configured. The local backend re-uses `zabbix.ts`'s pattern directly
(`AbortSignal.timeout` → typed error), with a larger ceiling: a local model generates more slowly and
loads from disk when cold. It does not retry: a local model that failed once is usually down rather
than flaky.

**Order of registration.** helmet → cors → rate-limit → auth → routes.

Rate limiting sits *before* the auth guard so a flood is rejected before the server spends work
verifying JWTs on it. The endpoint that actually needs it is `POST /api/auth/login`, which is
otherwise an unthrottled password oracle. Two exemptions: `/api/stream` holds one long-lived
connection per NOC screen rather than making repeated requests, and `/api/health` is polled
deliberately by every page.

**`trustProxy` is a prerequisite, not a detail.** Behind nginx every request carries the proxy's IP,
so without it all users share one rate-limit bucket and the limiter is worthless. But turning it on
with *nothing* in front is worse: a client can then forge `X-Forwarded-For` and rotate past the
limit. Hence `TRUST_PROXY`, off by default and set true only in `docker-compose.yml`.

**One header caveat.** `stream.ts` writes its SSE headers through `reply.raw.writeHead`, bypassing
Fastify's reply object, so helmet's `onSend` headers do not appear on that response. Everything
else carries them.

---

## 24. Assistant (chat)

The sidebar's **Assistant** page answers free-form questions about the estate: *"what needs
attention right now?"*, *"which site is in the worst shape?"*, *"are we meeting the SLA?"*. It is
the one feature with no Zabbix equivalent, and it is deliberately **not an agent**.

### What the model is given

For every message the BFF builds a **snapshot**, [`chat.ts`](server/src/chat.ts)
`buildSnapshot()`, from the same cached queries the pages use, under the same cache keys
(`problems`, `sites`, `sla`, `sli:*`, `services:tree`), so a busy conversation costs Zabbix nothing
the pages were not already paying:

- open problems, worst first, with host, age, acknowledgement state and tags;
- sites with reachable / unreachable / unknown counts and worst severity;
- every host by site on a small estate, or only the hosts that are not fine on a large one;
- SLA standing per service (achieved vs target, error budget left or exceeded);
- degraded services with the problems Zabbix blames for them.

The snapshot is plain text, not JSON: roughly half the tokens for the same facts, and a small
model reads *"3 hosts, 1 unreachable"* more reliably than nested braces. It is also **capped**.
Ollama serves `qwen3:8b` with a 4 096-token window by default, and a prompt that overflows it is
truncated from the *front*, which silently drops the system prompt and its rules. So lists are cut
(40 problems, 30 sites, 10 SLAs, 20 services, about 5 500 characters overall), `meta.truncated`
says so, and the page shows *partial view*. `OLLAMA_CONTEXT_LENGTH` raises the window. SLA and
services are fetched with `Promise.allSettled`: a Zabbix without Services configured must not leave
the assistant unable to say what is down.

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
| **`reasoning_effort: "none"`** | **2.0 s** | **none** |
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

---

## 25. Derived SLA and services

HCML's Zabbix has **no services** and one SLA (`SLA:1`, weekly) with nothing attached, so Zabbix's own
SLA engine has nothing to measure and the Services and SLA pages were empty. HCML still publishes a
monthly *Availability Report* per device: built from Zabbix trigger history. The portal now does
that measurement itself, read-only: [`sli/engine.ts`](server/src/sli/engine.ts). Nothing is created
in Zabbix.

### Two methods, because HCML's figure and the truth differ

| Method (`profile`) | Counts as down | Hours with no collected data | Aug 2026 overall |
|---|---|---|---|
| `hcml-report` | only **High ICMP ping loss** | counted as up; silent devices count 100% | **99.2313 %**: HCML's published figure, exactly |
| `availability` *(default)* | **Unavailable by ICMP ping** or high loss | left out of the measurement; too little data ⇒ "no data" | **89.46 %** across the 93 devices with data |

"High ICMP ping loss" is defined as loss **below 100%**, and depends on "Unavailable by ICMP ping",
so a device that is **completely down never fires it**. In HCML's own August report `4.3.4 FPSO ARUBA 4`
counts as 100% available while it was unreachable all month. The strict method is the headline;
the report method is shown beside it so the published figure can still be checked.

### How a figure is computed

1. **Window.** A calendar month cut at midnight `SLA_TIMEZONE` ([`sli/time.ts`](server/src/sli/time.ts)),
   or a rolling window for the availability report.
2. **Triggers.** `trigger.get` by name (`SLI_REPORT_TRIGGERS` / `SLI_AVAILABILITY_TRIGGERS`), not
   filtered to monitored hosts, HCML's report lists disabled hosts too. The report category is the
   host's device template (`Cisco IOS by SNMP`, `Generic by SNMP`, `FortiGate by SNMP`, else `ICMP Ping`).
3. **Events.** Every PROBLEM/OK event in the window, fetched in slices
   ([`sli/events.ts`](server/src/sli/events.ts)): a full page is split in half rather than accepted,
   so the result is never silently truncated.
4. **Replay.** Each trigger's events are replayed from the state it was in when the window opened:
   the same approach as Zabbix's own `calculateAvailability`. A trigger with no events in the window
   is in its current state, unless it only changed afterwards, in which case the first later event
   says what it was. A problem still open at month end is clipped to the last second (HCML's rule).
5. **Per device.** Intervals of all its triggers are merged, so overlapping loss and unavailability
   count once.
6. **Coverage** (strict only). An hour counts as collected when its `icmpping` trend row holds at
   least half the expected samples; the hour or two not yet in trends come from raw history.
   Downtime is only counted inside collected time, and the figure is `downtime / collected`. Hours in
   which fewer than 10% of devices collected anything are reported as **estate gaps** (e.g. the
   stack being stopped) rather than blamed on any device.
7. **Totals.** Every group (overall, category, site, device class) is the **plain mean of the
   devices that have a figure**, HCML's rule.

WAN legs are paired by name (`INET : SAMPANG WAN 1/2` → path `SAMPANG`); a path is down only while
**all** legs are down. Web scenarios on the *Web Monitoring* host are measured from `web.test.fail`.

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

### Never-measured hosts

`/api/sli` marks a host `measured: false` when none of its ICMP items has ever collected: 45 hosts
in August (42 with no interface in Zabbix, so the ping check cannot run; 3 disabled). HCML's report
method counts each as 100 %; the SLA page lists them and the figures are unchanged
(`scripts/validate-sli.ts` still matches Jun–Aug exactly).

### Reports

- `trend.get` is read in slices of at most ~26,000 rows (items × hours), so 365-day availability
  and capacity reports answer (they returned 502 when Zabbix's frontend ran out of memory).
- `basis=all-problems` honours `month` (a bad, future or >400-day-old month is a 400).
- `/api/reports/noise?top=N` (default 100, max 1,000) returns the top rows and `total`.

### Caching

`cached(key, ttl, fn, { staleMs, staleIfError })` in `cache.ts`:
- at most ~500 entries, least recently used evicted first;
- `staleMs`: serve the previous value while one background refresh runs, only for the slow reports
  (`derived-sli:*`, `avail:*`, `noise:*`, `capacity:*`), never for anything carrying problem state;
- `staleIfError`: if Zabbix fails, answer from the last good run rather than a 502;
- `invalidate(prefix, { holdMs })` also cancels fetches already in flight, so data from before an
  acknowledge is never stored again; after a write, matching keys are held at a ≤ 2 s TTL for 15 s.

### Bandwidth

- JSON over 1 KB is compressed (`compress.ts`): brotli quality 4 or gzip level 6:
  `/api/problems` 459 KB → 25 KB in ~3 ms.
- The live stream (`/api/stream`) runs one shared ticker, sends the problem list when it changes and
  at least every 30 s, and respects back-pressure: ~1.4 MB a minute instead of ~7 MB.
- The web app polls one request at a time, aborts requests nobody needs any more, pauses in hidden
  tabs, dims stale data while new parameters load, and keeps the page when a refresh fails.

### Logs and ports

- The BFF log redacts `?token=` from request URLs.
- nginx forwards `X-Forwarded-For`, so the rate limit is per client.
- Docker publishes the Zabbix UI (8080) and the portals (8081, and 8082 for the Ollama variant) on
  `127.0.0.1` only; the trapper port 10051 is no longer published.

### Guards against drift

- `web/scripts/css.check.mjs` fails on an unclosed block, a stray `}` or a declaration outside a rule
  (a lost brace once left ~50 rules silently unapplied; Vite does not catch it).
- The two portals no longer drift by construction: since 18 September they hold the same source tree,
  so `diff -r` over `server/src`, `server/scripts`, `web/src` and `web/scripts` must print nothing.
  That replaced `scripts/check-sync.mjs` and its list of allowed differences, which had nothing left
  to allow.

### Assistant speed (local model)

- **Reused snapshot.** The snapshot is kept for up to 5 minutes and rebuilt at once when a problem
  opens, closes, is acknowledged or re-graded, or when a host's state change has held for a minute.
  The system text stays byte-identical, so Ollama answers from its prompt cache: first word in
  ~0.5–2 s instead of 6–8 s.
- **Native Ollama API.** Chat, explain, warm-up and prefill all call `/api/chat` with the same options
  (`AI_NUM_CTX` 8 192, `AI_TEMPERATURE` 0.7, `AI_TOP_P` 0.8, `keep_alive`), so the model is never
  reloaded with a different context size and really stays loaded for `AI_KEEP_ALIVE`.
- **Prefill** when the Assistant page opens; **site focus** block for questions that name a site.
- **One request at a time**: chat, explain and prefill share one slot; a request that waits more
  than 20 s gets `503 ai_busy` with `Retry-After`.

### Zabbix stack settings (`Proto1/docker-compose.yml`)

| Setting | Why | Measured |
|---|---|---|
| `--innodb-redo-log-capacity=2G`, `--innodb-flush-log-at-trx-commit=2` | the 100 MiB redo log made MySQL checkpoint constantly | writes 1.50 → 0.39 MB/s in a 60 s sample |
| json-file logs, 50 MB × 5 | zabbix-server wrote ~200 MB in 48 h | — |
| `stop_grace_period` 60 s (server), 120 s (mysql) | let the server flush trends on shutdown | "syncing trend data done" on restart |
| `ZBX_STARTPINGERS=3` | one pinger was 100 % busy, fping hit its 600 s limit | pinger busy 100 % → 74 % |
| `ZBX_LOGSLOWQUERIES=3000` | slow queries were never logged | — |
| `ZBX_MEMORYLIMIT=512M` (web) | `trend.get` exhausted PHP's 128 M | 0 memory errors after a 365-day report |

---

## 27. Limitations and known gaps

*Reconstructed 22 September 2026. A section like this existed in `DOCUMENTATION.md`, which was
deleted on 21 September and was never under version control, so this is rebuilt from the surviving
audit findings, plan documents and logs rather than restored. Where the original said something this
does not, that is lost.*

**Be suspicious of a system that documents no limitations.** Everything below is known and accepted,
not discovered by a reader.

### What the portal cannot do, by design

| | |
|---|---|
| **It cannot collect anything** | Zabbix polls; the portal reads items. If Zabbix does not collect it, no portal feature can invent it |
| **It cannot change monitoring** | One write exists, `event.acknowledge`. No host, item, trigger or template can be created, edited or deleted. See [ADR-0006](docs/architecture/adr/0006-read-only-with-one-write.md) |
| **It remembers nothing** | Every derived value dies on restart. There is no audit trail of who acknowledged what, no saved views, no user table: [ADR-0003](docs/architecture/adr/0003-no-database.md) |
| **It cannot see past Zabbix's retention** | 31 days of raw history, 365 days of trends and events. A two-year question has no answer through this API |

### Goals only partly met

- **Goal 3, telecom deep visibility**: the WAN and radio-link half is built (§17). **SIP trunk and
  UHF/VHF radio monitoring is not**, and cannot be: HCML's Zabbix does not collect that data. This is
  a Zabbix-side prerequisite for the engineering team, decided out of scope on 2026-09-07.
- **Goal 5, role-based dashboards**: the site view and RBAC are built. **Role-scoped landing pages
  are not**, because they need HCML to define what each role should see first.
- **Goal 4**: the alert-noise report and the plain-language layer are built. **Cross-trigger
  correlation is not.**
- **Goal 6**: availability, capacity, aging and top-triggers are built. **Scheduled PDF export is
  not.**

### Security, still open

- **Passwords are compared in plain text** (`auth.ts:93`) and users come from environment variables,
  so adding one needs a restart. Audit items BE-13 to BE-17.
- **`server/.env` holds the placeholder `JWT_SECRET`** that the BFF is designed to refuse, which is
  why `AUTH_ENABLED=false` in dev and the login path has never been exercised locally. DOC-11, held
  deliberately.
- **The JWT carries no audience claim**, so a token minted by one portal is accepted by the other
  whenever they share a secret.
- **`hcml-portal-ollama` is not under version control at all.** Everything in it exists in one place
  on one disk. B1.
- **The Anthropic API key has been flagged for rotation since 10 September** and has not been
  rotated. FE-02.

### Measurement and performance

- **The assistant's snapshot is always truncated.** It is capped at 20 problems and a per-section
  character budget against roughly 660 open problems, so `truncated` is effectively always true.
  BE-22.
- **Heavy reports are slow, and the reason is now measured.** A 365-day capacity report costs ~112
  Zabbix calls and 10,771 SQL statements upstream, because each JSON-RPC call carries about 20
  statements of fixed frontend overhead. [ADR-0007](docs/architecture/adr/0007-keep-the-zabbix-api.md).
- **`stats.zabbixCalls` under-reports.** Sliced `event.get` recursion is counted once, so the true
  figure is higher whenever a window exceeds 5,000 events.
- **Nobody has measured the cache hit rate.** The 24-hour SLA TTL is a ceiling, not a floor: with a
  500-entry LRU and parameterised keys, ordinary browsing can evict a fresh report in minutes. How
  often the expensive path actually runs is unknown, and it is the number that decides whether any of
  the performance work matters.
- **Every performance figure in this project is single-user and single-shot.** There is no p95 and no
  concurrency data anywhere.

### Data and correctness

- **The dataset is frozen** at 17 September 2026 16:59:37. [ADR-0008](docs/architecture/adr/0008-stop-local-polling.md).
- **42 of the 135 monitored ICMP items have no trend data at all**: they are address-less
  placeholders. Availability figures cover the 93 that do.
- **Hourly averages are integer-truncated for unsigned items** by Zabbix itself, in `trends_uint`.
  Nothing downstream can recover the precision.
- **`web/src/types.ts` is a hand-maintained mirror of the server's types**, and in six places it is
  looser than the server. Nothing checks it. The server is authoritative.

### Documentation

- **The diagrams cannot be regenerated from anything.** A conceptual model is a judgement, so nothing
  will ever flag it as stale. `erd/conceptual/ERD-Conceptual.md` ends with the list of code changes
  that oblige a change to it; that list is the only guard.
- **The glossary and this section were lost and rebuilt**, not restored. See §28.

---

## 28. Glossary

*Reconstructed 22 September 2026. `DOCUMENTATION.md` carried a glossary; no copy survives and no
other document quotes it, so this is written from scratch against the code and the data model rather
than recovered. Terms are the ones this project uses in a specific way.*

### Zabbix's vocabulary, as this portal consumes it

| Term | What it means here |
|---|---|
| **Host** | A monitored thing. Note Zabbix keeps hosts *and templates* in one table discriminated by `status`, so any count must filter: 139 monitored plain hosts, 313 templates, 40 prototypes |
| **Item** | One metric on one host, identified by a `key_` such as `icmpping`. ~51,800 in HCML's estate |
| **Trigger** | An expression over items that turns a measurement into a problem |
| **Event** | A trigger changing state. A PROBLEM event and its later OK event bracket one outage |
| **Problem** | An event that is currently unresolved. ~660 open at HCML |
| **History** | Raw collected values. Kept 31 days by HCML's policy |
| **Trend** | Hourly min/avg/max per item. Kept 365 days, and the only source for anything older than a month |
| **Host group** | Zabbix's grouping. 23 of them; the portal uses them as the weakest of four site signals |
| **Service / SLA** | Zabbix 7.0's native service tree and SLA engine. **Both are empty at HCML**: 0 services, 1 placeholder SLA |
| **Maintenance** | A window in which a host's problems are suppressed |

### The portal's own vocabulary: none of these is a Zabbix entity

| Term | What it means here |
|---|---|
| **Site** | One of 14 HCML locations. **Zabbix has no site entity**, and no HCML host carries a site tag, so a site is resolved from four ranked signals: tag, host name, inventory, group |
| **Site source** | Which of those four signals actually resolved a given host. Reported per host, because the mix is the standardisation metric |
| **Link** | A WAN path, synthesised from a host's `icmpping` / `icmppingloss` / `icmppingsec` item triplet. Paired with its standby by the `link_group` item tag |
| **Incident** | A problem event paired with its recovery, clipped to the reporting window and merged with overlapping ones so two simultaneous problems are not double-counted |
| **Host state** | The portal's own reachability judgement: up, down, degraded, nodata, disabled. **Ping first**, interface flags only as a fallback, because on 17 Sep 16 of 23 hosts Zabbix called unavailable answered ping |
| **State reason** | Which signal decided the host state. Provenance, so a wrong call can be traced rather than argued about |
| **Derived SLA / SLI** | Monthly availability computed by replaying trigger events, because Zabbix's own engine has nothing configured |
| **Profile** | Which method the SLA used. `hcml-report` reproduces HCML's published figures; `availability` is the stricter one that also requires evidence data was collected |
| **Coverage** | The fraction of an interval in which an item actually collected data. Distinguishes "up" from "we were not looking" |
| **Basis** | The declared rules behind a figure, which triggers count, how gaps and no-data are treated. Present in every SLI response so two numbers can be compared honestly |
| **Data status** | Whether a figure rests on real measurement, partial measurement, or none |

### Project vocabulary

| Term | What it means here |
|---|---|
| **BFF** | Backend-for-frontend. The Fastify service; holds the Zabbix token, caches, derives, and never lets the browser talk to Zabbix |
| **The derived layer** | Everything the portal computes that Zabbix stores no row for. Green in every diagram |
| **The two portals** | `hcml-portal` (hosted model) and `hcml-portal-ollama` (local model). Byte-identical source; 21 files differ |
| **Explain** | The per-problem plain-language summary. One problem, cached an hour |
| **The Assistant** | The conversational page. Sends the whole estate snapshot, streamed, never cached |
| **Stale-while-revalidate** | Serving an expired cached value instantly while refreshing behind it. Allowed on four report families, **never** on problem or acknowledgement state |
| **Write-back** | The single acknowledge/close path. Off unless `ZABBIX_WRITE_TOKEN` is set |

---

## 29. HCML's six optimisation goals, indexed

*Reconstructed 22 September 2026. `DOCUMENTATION.md` opened with this framing. The mapping itself was
never lost (it is spread across `setup.md` §3 and the openers of §§14–21) but there was no single
index, and that absence is what made it feel gone.*

> *"From basic monitoring toward a consistent, measurable system that supports operational
> decisions."* Target outcome: **faster detection · more relevant alarms · shorter troubleshooting ·
> more credible reporting.**

| Goal | HCML's stated gap | Where the portal answers it | State |
|---|---|---|---|
| **1 · Standardization** | Naming, site, owner and criticality are not standardized, so alarms are hard to route to the right person | Inventory & ownership scorecard, **§16**. Site coverage in **§14** is the measure of progress | **met** |
| **2 · Service-based monitoring** | Device-centric, not service-centric, *HCML's stated core problem* | Services tree, **§15**, plus the derived SLA in **§25** at the real 99 % target | **met** |
| **3 · Telecom deep visibility** | Voice, radio and SIP path monitoring incomplete | Link & WAN health, **§17** | **partial**, SIP and UHF/VHF are blocked on Zabbix-side collection, out of scope since 2026-09-07 |
| **4 · Smart alerting** | Notifications lack context, correlation and escalation | Alert-noise and flapping, **§21**; the plain-language layer, **§13** | **partial**, cross-trigger correlation not built |
| **5 · Role-based dashboard** | Dashboards not tailored to NOC, engineers, management | Site view **§14**, RBAC **§19** | **partial**, role-scoped landing pages need HCML to define what each role sees |
| **6 · Automated reporting** | Hard to see SLA, capacity trends and recurring issues | Availability, capacity, aging and top-triggers, **§18**; derived SLA **§25** | **partial**, scheduled PDF export not built |

**Three met, three partial: and in every partial case the remaining work is blocked on something
outside the portal**, not on unwritten code. Two need a decision from HCML; one needs Zabbix to
collect data it does not collect today.

§3's table *"Five things have no Zabbix equivalent"* carries the same mapping per feature, and is the
better place to start if you are asking "why does this page exist?" rather than "is this goal done?".
