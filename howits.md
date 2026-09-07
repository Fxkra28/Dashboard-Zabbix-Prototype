# howits.md — How the HCML Monitoring Portal Works

A deep-dive into the architecture, data flow, and the Zabbix-native features this portal
re-implements. Read [README.md](README.md) first for setup; this doc explains *how it all fits
together* and *why*.

---

## 1. The big picture

The portal is a **read-only, branded front-end for Zabbix**. Zabbix keeps doing what it's good at —
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

Three hard rules drive the whole design (from `instruct.md` §0):

1. **The browser never calls Zabbix.** Only the BFF has the API token.
2. **Read-only, least privilege.** The portal reads with a dedicated read-only token. The single
   exception is acknowledge/close, which uses a **separate** write token and is off unless
   configured — see [§20](#20-acknowledge--close-write-back).
3. **Cache everything.** Every Zabbix call hits its server + DB, so responses are cached with short TTLs.

### Why a BFF (Backend-for-Frontend)?
- **Security** — the long-lived Zabbix token stays server-side. If it were in the browser, anyone
  could read it from dev-tools and hit Zabbix directly.
- **Shaping** — Zabbix's API is raw and chatty (e.g. `problem.get` doesn't include host names). The
  BFF *enriches* and *aggregates* so the UI gets exactly the shape it needs in one call.
- **Caching** — the BFF absorbs repeated/polled requests so a busy dashboard doesn't hammer Zabbix.
- **Decoupling** — Zabbix upgrades don't break the portal; it only depends on the stable API.

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
6. React renders the table; a timer re-polls every 5 s (cheap — mostly cache hits).

This "call Zabbix, enrich, cache, serve a clean shape" pattern is the same for every endpoint.

---

## 3. Zabbix-native feature mapping

The sidebar and pages intentionally mirror Zabbix's own **Monitoring** and **Reports** menus. Each
portal view maps to Zabbix concepts and API methods:

| Portal page (sidebar)      | Zabbix native equivalent        | BFF endpoint                      | Zabbix API methods used                     |
|----------------------------|---------------------------------|-----------------------------------|---------------------------------------------|
| **Dashboard**              | Monitoring → Dashboard          | `/api/stats`, `/api/reports/problems-by-group`, `/api/problems` | `host/item/trigger/hostgroup.get` (counts), `problem.get`, `trigger.get` |
| **Problems**               | Monitoring → Problems           | `/api/problems`                   | `problem.get`, `trigger.get` (host names)   |
| **Sites**                  | *(none — see [§14](#14-site-view))* | `/api/sites`                  | `host.get` (+ tags, inventory, groups), `problem.get` |
| **Hosts**                  | Monitoring → Hosts              | `/api/hosts/overview`             | `host.get` (+ interface availability), `problem.get` |
| **Latest data**            | Monitoring → Latest data        | `/api/latest`                     | `item.get` (lastvalue/lastclock/prevvalue)  |
| **Graphs**                 | Monitoring → Hosts → Graphs     | `/api/history`, `/api/items`      | `item.get`, `history.get`, `trend.get`      |
| **Maps**                   | Monitoring → Maps               | `/api/maps`, `/api/maps/detail`   | `map.get` (selements + links)               |
| **Network**                | (SNMP/ICMP hosts, §13)          | `/api/net/*`                      | `host.get`, `item.get` (icmp*, net.if.*)    |
| **Links & WAN**            | *(none — see [§17](#17-link--wan-health))* | `/api/links`           | `item.get` (icmpping / icmppingloss / icmppingsec) |
| **Services**               | Services                        | `/api/services`                   | `service.get` (+ children, problem events), `sla.get`, `sla.getsli` |
| **SLA**                    | Services → SLA                  | `/api/sla`, `/api/sla/sli`        | `sla.get`, `sla.getsli`, `service.get` |
| **Availability**           | *(none — see [§18](#18-automated-reporting))* | `/api/reports/availability`, `/api/reports/aging` | `event.get` (problem/recovery pairs) |
| **Capacity**               | Reports → Top 100 (adjacent)    | `/api/reports/capacity`           | `item.get`, `trend.get` → `history.get` fallback |
| **Alert noise**            | *(none — see [§21](#21-alert-noise--flapping))* | `/api/reports/noise`  | `event.get` (problem/recovery pairs, per trigger) |
| **Top 100 triggers**       | Reports → Top 100 triggers      | `/api/reports/top-triggers`       | `event.get` (aggregated by trigger)         |
| **Inventory scorecard**    | *(none — see [§16](#16-inventory--ownership-scorecard))* | `/api/reports/inventory` | `host.get` (+ tags, inventory, groups) |

> **Config is deliberately *not* re-implemented.** Creating hosts/items/triggers/users stays in
> Zabbix's native UI (the "hybrid" approach). The portal is the read-only NOC view.

Five things have **no** Zabbix equivalent, and they're the point of the portal:

| View | Why Zabbix can't do it | HCML goal |
|---|---|---|
| **"Explain"** on Problems and SLA ([§13](#13-plain-language-layer-ai)) | Zabbix speaks to engineers; this speaks to everyone else | Goal 4 |
| **Sites** board ([§14](#14-site-view)) | Zabbix has no site object — it's derived | Goal 5 |
| **Inventory scorecard** ([§16](#16-inventory--ownership-scorecard)) | Zabbix stores the fields but never scores them | Goal 1 |
| **Links & WAN** ([§17](#17-link--wan-health)) | Zabbix has items, not *links* with a main/standby relationship | Goal 3 |
| **Availability & aging** ([§18](#18-automated-reporting)) | Zabbix stores events; turning them into uptime is arithmetic it doesn't do | Goal 6 |
| **Alert noise** ([§21](#21-alert-noise--flapping)) | Zabbix shows you every alarm; it never tells you which ones weren't worth sending | Goal 4 |

---

## 4. The "logics" that match Zabbix

Beyond layout, the portal reproduces Zabbix's *semantics* so the numbers mean the same thing:

- **Severity** (`0..5`) — Not classified → Disaster, using Zabbix's exact color palette
  ([`web/src/theme.ts`](web/src/theme.ts) `SEVERITIES`). Used everywhere as badges and count chips.
- **Host availability** — Zabbix 7.0 tracks availability **per interface** (`available`: 0 unknown,
  1 available, 2 unavailable). The portal rolls interfaces up to a host state (*worst wins*) in
  [`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.
- **Problem status & duration** — `r_eventid !== '0'` ⇒ *Resolved*, else *Problem*. Duration is
  `recovery_time − onset` (or *now* if still open), matching Zabbix's "Duration" column.
- **Acknowledgement** — `acknowledged` flag surfaced as a pill and a filter.
- **Item value types** — `0` float, `1` char, `2` log, `3` uint, `4` text. Only numeric items
  (0/3) are offered for graphing; `history.get` is called with the matching `history` param.
- **Interface types** — `1` Agent, `2` SNMP, `3` IPMI, `4` JMX (shown on the Hosts page).
- **Maintenance** — `maintenance_status = 1` renders a "Maintenance" pill.
- **Top-100 aggregation** — mirrors Zabbix's report by counting `PROBLEM` events per trigger over a
  time window via `event.get`.

---

## 5. Backend (BFF) — file by file

Location: [`server/src/`](server/src/). Stack: Node 20 + Fastify + TypeScript (ESM).

| File | Responsibility |
|------|----------------|
| [`config.ts`](server/src/config.ts) | Typed env (ZBX_URL/TOKEN, port, CORS origin, network group ids, auth, AI). Warns (doesn't crash) on missing token. |
| [`zabbix.ts`](server/src/zabbix.ts) | The **only** place Zabbix tokens are used. `zbx()` reads with `ZABBIX_API_TOKEN`; `zbxWrite()` writes with the separate `ZABBIX_WRITE_TOKEN` (§20). Raises `ZabbixAuthError` when a token is rejected. |
| [`claude.ts`](server/src/claude.ts) | The **only** place the Anthropic key is used — the Claude analog of `zabbix.ts`. `humanize(kind, payload)` returns schema-validated JSON via structured outputs. |
| [`cache.ts`](server/src/cache.ts) | TTL `Map` cache **+ in-flight coalescing** (concurrent misses for the same key await one fetch, so polling can't stampede Zabbix), plus `invalidate(prefix)` used after a write-back. |
| [`queries.ts`](server/src/queries.ts) | Shared `getProblems()` (host-enriched) and `getHostsWithMeta()` (tags + inventory + groups). Reused by REST, SSE, Sites and the scorecard. |
| [`auth.ts`](server/src/auth.ts) | JWT login + **RBAC** (viewer / operator / admin) + `onRequest` guard. See [§19](#19-authentication--rbac). |
| [`routes/hosts.ts`](server/src/routes/hosts.ts) | `/api/hosts`, `/api/hosts/overview`, `/api/hostgroups`, `/api/items`, `/api/latest`. |
| [`routes/problems.ts`](server/src/routes/problems.ts) | `/api/problems` (cached 5 s). |
| [`routes/history.ts`](server/src/routes/history.ts) | `/api/history` (raw) + `/api/trend` (long ranges = hourly aggregates). |
| [`routes/net.ts`](server/src/routes/net.ts) | `/api/net/devices` (+ ICMP), `/api/net/ports`, `/api/net/status`, `/api/net/map`. |
| [`routes/reports.ts`](server/src/routes/reports.ts) | `/api/reports/top-triggers`, `/api/stats`, `/api/reports/problems-by-group`. |
| [`routes/maps.ts`](server/src/routes/maps.ts) | `/api/maps` (list), `/api/maps/detail` (topology). |
| [`routes/stream.ts`](server/src/routes/stream.ts) | `/api/stream` — SSE, pushes live problems every 5 s + keep-alive. Shares the `problems` cache key, so N screens cost one poll. |
| [`routes/sites.ts`](server/src/routes/sites.ts) | `/api/sites` — rolls every host up to a site, plus site-mapping coverage. |
| [`routes/services.ts`](server/src/routes/services.ts) | `/api/services` — the service hierarchy with roll-up status, root causes and SLA. |
| [`routes/sla.ts`](server/src/routes/sla.ts) | `/api/sla`, `/api/sla/sli` — Zabbix Services → SLA, read-only. |
| [`routes/inventory.ts`](server/src/routes/inventory.ts) | `/api/reports/inventory` — the standardisation scorecard (admin only). |
| [`routes/links.ts`](server/src/routes/links.ts) | `/api/links` — SD-WAN / radio / Starlink link health from ICMP items. |
| [`routes/analytics.ts`](server/src/routes/analytics.ts) | `/api/reports/availability`, `/api/reports/aging`, `/api/reports/capacity`, `/api/reports/noise`. Shared `fetchIncidents()` backs availability + noise. |
| [`routes/actions.ts`](server/src/routes/actions.ts) | `/api/problems/acknowledge` — the portal's **only** write (§20). |
| [`routes/explain.ts`](server/src/routes/explain.ts) | `/api/explain/problem`, `/api/explain/sla` — the plain-language layer. On-demand + cached. |
| [`index.ts`](server/src/index.ts) | Builds the Fastify app, registers CORS, auth, and all route plugins; maps `ZabbixAuthError` → 503, AI failures → 503/502. |

### Endpoint reference (+ cache TTLs)

| Method + path | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{ ok, ts, ai, writeBack }` — capability flags; the UI hides actions that aren't configured | — |
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
| `GET /api/auth/me` | `{ authEnabled, user: { name, role } }` | — |
| `POST /api/problems/acknowledge` | acknowledge and/or close **(operator)** | writes |
| `GET /api/explain/problem?eventid=` | plain-language summary + tag glossary | **1 h** |
| `GET /api/explain/sla?slaid=&serviceid=` | plain-language SLA standing | **5 min** |
| `GET /api/stream` | **SSE** live problems | live |
| `POST /api/auth/login` | `{ token, user }` (when auth on) | — |

The two `/api/explain/*` routes are the only ones that cost money, so they have by far the longest
TTLs — a problem's meaning doesn't change while it's open.

---

## 6. Frontend — structure

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
    ├── Overview.tsx      (/)                    — Dashboard
    ├── Problems.tsx      (/problems)            — + per-row "Explain"
    ├── Sites.tsx         (/sites)               — per-site health board
    ├── Hosts.tsx         (/hosts)
    ├── HostDetail.tsx    (/graphs?hostid=)      — Graphs
    ├── LatestData.tsx    (/latest)
    ├── Maps.tsx          (/maps)
    ├── Network.tsx       (/network)
    ├── Links.tsx         (/links)               — SD-WAN / radio link health  [operator]
    ├── Services.tsx      (/services)            — service tree, roll-up + root causes
    ├── Sla.tsx           (/sla)                 — Services → SLA + "Plain language"
    ├── Availability.tsx  (/reports/availability)— uptime + unacknowledged aging
    ├── Capacity.tsx      (/reports/capacity)    — CPU / memory / disk trends
    ├── AlertNoise.tsx    (/reports/noise)       — flapping / never-acked triggers
    ├── Inventory.tsx     (/reports/inventory)   — standardisation scorecard  [admin]
    ├── TopTriggers.tsx   (/reports/top-triggers)
    └── Login.tsx         (/login)
```

### Sidebar
[`Sidebar.tsx`](web/src/components/Sidebar.tsx) defines two collapsible sections — **Monitoring** and
**Reports** — mirroring Zabbix's menu. Each section header toggles open/closed; the active route is
highlighted. Add a page by dropping an entry in the `SECTIONS` array and a `<Route>` in
[`App.tsx`](web/src/App.tsx).

### Data flow in the UI
- **`useAsync(fn, deps, intervalMs?)`** — most pages fetch with this; pass an interval to poll
  (Problems 5 s, Hosts 30 s, Latest 20 s). It exposes `{ data, loading, error, reload }`, rendered
  through the `<Async>` helper so every page gets consistent loading/error/empty states.
- **`useSSE(url, event)`** — the Dashboard subscribes to `/bff/api/stream` for **live** problems and
  falls back to polling if the stream drops.
- **Cross-page links** — Hosts → `/graphs?hostid=…`, Latest data → `/graphs?hostid=…`. `HostDetail`
  reads the `hostid` query param to preselect.

---

## 7. Live updates (SSE)

Server-Sent Events are the simplest live-push transport (chosen over WebSocket per `instruct.md` §2).

- BFF: [`routes/stream.ts`](server/src/routes/stream.ts) opens an `text/event-stream`, pushes an
  `event: problems` frame every 5 s and a `: keep-alive` comment every 15 s. It cleans up its timers
  on client disconnect. `X-Accel-Buffering: no` tells nginx to stream, not buffer.
- Browser: [`useSSE`](web/src/hooks/useSSE.ts) wraps `EventSource`. Because `EventSource` can't set
  headers, when auth is enabled the token is passed as `?token=` and verified server-side.

---

## 8. Authentication (mechanics)

`AUTH_ENABLED=true` turns on a JWT flow: `POST /api/auth/login` returns a 12 h JWT carrying the
user's **role**; an `onRequest` guard then rejects unauthenticated `/api/*` calls (health and auth
excepted) and checks the role against the route. The Zabbix token is **never** exposed regardless —
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
  route code — the `cached()` signature stays the same.

---

## 10. Network monitoring (SNMP / ICMP)

The portal reads network gear exactly like any other host — it **never speaks SNMP itself**
(`instruct.md` §13). Zabbix's server/proxy polls devices; the portal reads the resulting items:

- **Availability** — ICMP items `icmpping` (up/down), `icmppingloss` (%), `icmppingsec` (latency),
  merged per device in `/api/net/devices`.
- **Ports/interfaces** — SNMP LLD creates `net.if.in[...]`/`net.if.out[...]`, `ifOperStatus`, etc.;
  `/api/net/ports` reads them, and interface traffic graphs reuse `/api/history`.
- **Onboarding is a later phase** (the "network plug", §13.4): set `NET_GROUP_IDS` on the BFF and add
  devices in Zabbix. The network **views populate automatically** — no portal code change.

---

## 11. Running & deploying

**Dev** (two processes):
```bash
cd server && cp .env.example .env   # set ZBX_URL + ZBX_TOKEN
npm install && npm run dev          # BFF on :4000  (tsx watch — auto-reloads)
cd ../web && npm install && npm run dev   # Vite on :5173, proxies /bff -> :4000
```

**Prod** (Docker, next to Zabbix):
```bash
cp .env.example .env                # ZBX_URL, ZBX_TOKEN, etc.
docker compose up -d --build        # nginx serves web + reverse-proxies /bff -> BFF, on :8081
```

Verify the chain any time:
```bash
curl localhost:4000/api/health                 # BFF alive
curl localhost:5173/bff/api/stats               # browser → proxy → BFF → Zabbix
```

---

## 12. Extending the portal (recipe)

To add a new Zabbix-backed view:

1. **BFF** — add a route that calls `zbx('<method>', {...})` wrapped in `cached()`; enrich/aggregate
   as needed. Register it in `index.ts`.
2. **Types** — add the response shape to `web/src/types.ts`.
3. **API client** — add a method to `web/src/api.ts`.
4. **Page** — build it with `useAsync` + `<Async>`; reuse `SeverityBadge`, `SeverityCounts`,
   `TimeSeriesChart`, tables.
5. **Wire** — add a `<Route>` in `App.tsx`, a link in `Sidebar.tsx`, and a title in `Layout.tsx`.

That's the whole pattern — every existing page is an instance of it.

---

## 13. Plain-language layer (AI)

Implements [`../plan_1.1.md`](../plan_1.1.md). HCML's own overview names the gap: *"the main issue is
not the number of alarms, but the quality of information needed to act."* Tags like `class: os`,
`scope: availability` and wording like *"Zabbix agent is not available (for 3m)"* are precise for an
engineer and opaque to everyone else. This layer translates them.

**Scope is deliberately narrow** — tags, SLA figures, and notification wording. It is not a chatbot,
and it never touches Zabbix config.

### How it flows

```
Browser ──/bff/api/explain/* ──► BFF ──► getProblems() / sla.get   (Zabbix, read-only)
                                  ├────► Claude  (ANTHROPIC_API_KEY, server-side only)
                                  └────► cached()  (repeat clicks are free)
```

[`claude.ts`](server/src/claude.ts) is the exact mirror of [`zabbix.ts`](server/src/zabbix.ts): the
key is read from `config` and **never** reaches the browser. `humanize()` uses **structured outputs**
(`output_config.format` with a JSON schema), so the response is guaranteed to match the shape the UI
renders — no parsing guesswork, no validation dependency.

### The two translations

| Endpoint | Input from Zabbix | Output |
|---|---|---|
| `/api/explain/problem?eventid=` | trigger name + `opdata` (**this is the notification text**), severity, host, age, ack state, and every tag | `summary`, `tagsExplained[]` (a glossary, one row per tag), `businessImpact`, `recommendation` |
| `/api/explain/sla?slaid=&serviceid=` | SLO target, period, and per-service SLI / uptime / downtime / error budget | `status`, `plain`, `meetingTarget`, `recommendation` |

One problem endpoint covers **both** tags and notification wording, because the trigger name plus
`opdata` *is* the notification as the team receives it.

### Design rules

- **On-demand only.** Nothing calls Claude on page load. The user clicks "Explain"; that is the
  only trigger. No bulk or background runs.
- **Cached hard.** A problem explanation lives 1 h, an SLA explanation 5 min. Five clicks on the same
  problem = **one** Claude call (measured), and every NOC screen shares the same cache.
- **Never invents.** The system prompt forbids adding facts not present in the input — the model
  rephrases what Zabbix returned. The panel footer says so to the reader.
- **Optional.** With no `ANTHROPIC_API_KEY` the portal is fully functional; `/api/health` reports
  `ai: false` and the UI hides the buttons rather than offering one that can only fail.
- **Fails alone.** A Claude outage returns `502 {error:'ai_error'}` on the explain routes only —
  every monitoring endpoint keeps serving 200.

### Configuration

```bash
# server/.env — both optional
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-6   # swap models without a code change
```

### Trying it

```bash
curl "localhost:4000/api/explain/problem?eventid=23"   # 503 until a key is set
curl "localhost:4000/api/sla"                          # [] until Services → SLA exist in Zabbix
```

---

## 14. Site view

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 1, serving HCML **Goal 5** (*"dashboards are not
tailored for NOC, engineers, and management"*). HCML's estate is organised by site — JKT HQ, SBY,
SSB, FPSO KAS3, BD-WHP, MOPU/MAC, MBH, MDA, MDK, Sapudi, Sumenep, ORF Porong, TWSB, GMS Pasuruan —
but every view before this one was a flat host list. Management reads sites, not hostnames.

### Zabbix has no "site"

There is no site object in the Zabbix API, so the BFF derives one. HCML's **Goal 1** says site
mapping *isn't standardised yet*, so [`routes/sites.ts`](server/src/routes/sites.ts) refuses to
assume a convention and instead tries the most deliberate signal first:

| # | Signal | Zabbix source | Why this order |
|---|---|---|---|
| 1 | Host **tag** `site` | `selectTags` | Deliberate and unambiguous. Tag name is `SITE_TAG`. |
| 2 | Host **inventory** | `selectInventory` → `site_city`, then `location` | Zabbix's own field for this. |
| 3 | Host **group** | `selectHostGroups` | Every host has one, so this always resolves. |

> **Gotcha:** Zabbix has **no `site_name` inventory field** — the real ones are `site_city` and
> `location`. Asking for a field that doesn't exist is silently ignored, not an error.
>
> Set `SITE_GROUP_PREFIX` (e.g. `Site/`) when site groups are named `Site/JKT HQ`; the prefix is
> stripped. Left empty, step 3 uses the host's first host group — a guess, and reported as one.

### Coverage is the Goal 1 metric

The response carries `coverage: { hosts, tag, inventory, group }`, and the page turns it into one
sentence: *"86% of hosts carry an explicit site; the rest are grouped by host group, which is a
guess."* The portal is read-only so it can't enforce standards — but it **measures** them, which is
what makes Goal 1 actionable. As HCML tags hosts, the number goes up.

### What the board shows

Sites sort **worst-first** (highest live severity, then most unreachable hosts, then name) so a NOC
wall leads with what needs attention. Each card carries the site's worst-severity colour stripe,
problem and unacknowledged counts, Zabbix severity chips, and down/unknown/maintenance tallies.
Selecting a card lists that site's hosts with availability, status, and per-host severity chips.

Availability is rolled up per Zabbix 7.0 semantics — availability lives on the *interface*, and the
host state is **worst wins** (any interface unavailable ⇒ host unavailable), matching
[`lib/severity.ts`](web/src/lib/severity.ts) `hostAvailability()`.

### Trying it

```bash
curl localhost:4000/api/sites | jq '.coverage, [.sites[] | {name, worst, problems}]'
```

---

## 15. Services tree

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 2, serving HCML **Goal 2** — the review's
*stated core problem*:

> **Monitoring is still device-centric and reactive; the target is service-centric and proactive.**

Every other page in this portal answers *"which host is broken?"*. This one answers *"which
**service** is degraded, and why?"* — so a failure reads as **"BD FPSO — Voice path is degraded,
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
recurses, and attaches each service's SLA — `sla.get` + `sla.getsli` — so target and achieved sit on
the same row as the status.

### Services are a DAG, not a tree

A shared dependency legitimately sits under **two** parents (in the demo data, *Shared SD-WAN core*
hangs off both Offshore and Onshore). Two consequences the code handles explicitly:

- **Recursion is path-guarded** and depth-capped (`MAX_DEPTH`), so a malformed hierarchy can't hang
  the request.
- **`descendants` counts distinct service ids, not tree positions.** Summing `1 + child.descendants`
  double-counts a shared node — the root reported *6 services below* when only **5** existed.

That shared node is also the clearest demonstration of the whole feature: when it degrades, *both*
branches degrade with it. That is a dependency, which is exactly what device-centric monitoring
cannot show.

### On the page

Degraded branches are **expanded by default** and healthy ones folded away — a NOC wall should open
on what's broken. Each row carries a status dot in the Zabbix severity colour, an OK/severity badge,
the distinct count below it, and (when measured) an SLA chip reading `achieved% / target%`, green
when meeting. Leaves list their root causes beneath them, prefixed *"because …"*; parents don't
repeat what their children already say. Where a service has an SLA, the
[plain-language layer](#13-plain-language-layer-ai) is one click away — scoped to that service, so
the explanation talks about *that* path and no other.

### Trying it

```bash
curl localhost:4000/api/services | jq '{total, degraded, worst}'
```

---

## 16. Inventory & ownership scorecard

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 4, serving HCML **Goal 1**:

> *"Host naming, site mapping, owner, criticality and dependency are not standardised → alarms are
> hard to route to the right PIC."*

The portal is read-only, so it **cannot enforce** a standard. What it can do is **measure** one —
turning an invisible governance problem into a number that goes up as hosts get tagged. That is the
entire point of this page.

### The four scored dimensions

| Dimension | Counts as present when | Configure with |
|---|---|---|
| **Naming** | host name matches a regex | `HOST_NAME_PATTERN` (empty ⇒ *not scored*) |
| **Site** | an **explicit** marker exists — tag or inventory | `SITE_TAG` |
| **Owner / PIC** | inventory `poc_1_name` / `poc_1_email`, or a tag | `OWNER_TAG` |
| **Criticality** | a criticality tag | `CRITICALITY_TAG` |

**Site is deliberately strict.** [`resolveSite()`](server/src/routes/sites.ts) always returns
*something* (falling back to a host group), but the scorecard counts only `tag` and `inventory` as
present. Falling back to a group is exactly the ambiguity Goal 1 names, so it scores as a gap — the
scorecard and the Sites board agree on the same 86% figure for that reason.

### HCML's naming convention

Host names follow **`SITE-DEVTYPE-SEQ`** (e.g. `SPG-RTR-01`), shipped as the default
`HOST_NAME_PATTERN`:

```
^(SPG|GMS|MPR|SMN|TRJ|ORF|TWG)-[A-Z]{2,6}-[0-9]{2,3}$
```

| Code | Site | Code | Site |
|---|---|---|---|
| `SPG` | Sampang | `TRJ` | Trunojoyo |
| `GMS` | GMS Pasuruan | `ORF` | ORF Porong |
| `MPR` | MOPU Prameswari | `TWG` | Tanjung Wangi |
| `SMN` | Sumenep | | |

> **Confirm the codes before relying on the score.** The site *list* came from the project brief;
> the three-letter *codes* are a derivation, not a quoted standard. If HCML already has canonical
> abbreviations, change the alternation in `HOST_NAME_PATTERN` and the `site` tag values to match —
> nothing else needs touching.

Site-group naming is `Site/<CODE>` via `SITE_GROUP_PREFIX`; it only applies when a host has no
`site` tag and no inventory location, since those are checked first (§14).

The fifth dimension HCML lists — **dependency** — is answered by the
[Services tree](#15-services-tree) rather than a per-host field: a host is in a dependency map when
the service hierarchy covers it. Scoring it per host would be a worse answer than the real one.

### Design notes

- A **broken `HOST_NAME_PATTERN` doesn't take the endpoint down.** An invalid regex is caught and the
  dimension reports `scored: false`, so a config typo degrades to "not measured", never a 500.
- Groups are sorted **worst-first** — that's where the standardisation work is.
- The gap list downloads as **CSV**, so the work can be handed to whoever owns those hosts.
- Admin-only: this is governance, not monitoring ([§19](#19-authentication--rbac)).

```bash
curl localhost:4000/api/reports/inventory | jq '.overall, [.dimensions[] | {label, pct, scored}]'
```

---

## 17. Link & WAN health

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 5, serving HCML **Goal 3** (telecom deep
visibility). HCML runs **12 main + 10 redundant SD-WAN links**, 10 P2P radio links, 18 internet
accesses and Starlink offshore. Their own topology slide flags
*"SD-WAN (to_mda_via_sapudi)(internal4): High packet loss"* — that class of fault deserves a
first-class view, not a row buried in Latest data.

### What a "link" is

Zabbix has items, not links. A link here is one **(host, ping target)** pair, stitched back together
from the three items Zabbix collects per target:

| Item key | Gives |
|---|---|
| `icmpping[<target>]` | up / down |
| `icmppingloss[<target>]` | packet loss % — and usually the most descriptive item *name* |
| `icmppingsec[<target>,,,,,<mode>]` | RTT; `min`/`max` modes let jitter be derived |

Two details that are easy to get wrong:

- **`monitored: true` is mandatory.** Without it `item.get` also returns **template** items, and the
  page fills with hundreds of identical unassigned prototypes. (Measured: 100+ phantom ICMP keys.)
- **Zabbix stores RTT in seconds**; the page reports milliseconds. Jitter is `max − min`, and is
  simply absent unless the min/max mode items exist — it is never faked.

### Redundancy is the point

A main + standby pair is only *truly* down when **every** leg is — that distinction is why the
redundancy is paid for. Pairing comes from the item tag `link_group` (with `link_role` naming the
leg), and a path rolls up as: any leg up ⇒ `up`, all legs up ⇒ `up`, mixed ⇒ `degraded`,
none up ⇒ `down`.

State per link is from `LINK_LOSS_WARN` (default 2%) and `LINK_LOSS_CRIT` (default 10%):
down if the ping fails or loss ≥ crit, degraded at ≥ warn, otherwise up. Operator role
([§19](#19-authentication--rbac)).

---

## 18. Automated reporting

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 6, serving HCML **Goal 6** — *"hard to see SLA,
capacity trends, and recurring issues."* Recurring issues were already covered by Top 100 triggers;
these add the other two, plus response time.

### Availability — `/api/reports/availability`

Zabbix stores events; turning them into uptime is arithmetic it doesn't do. The BFF replays history:

1. `event.get` for PROBLEM events in the window (severity-filtered).
2. Each carries `r_eventid`; those recovery events are fetched **in one batch** for their clocks.
3. Each problem becomes an interval, clipped to the window; still-open ones run to *now*.
4. **Overlapping intervals are merged per host** — two simultaneous problems are one outage, not
   two. Without this, availability can go *negative*, which is the trap here.

Availability is then *"share of the period with no open problem at or above the chosen severity"* —
and the page says exactly that, because it isn't the same thing as ICMP uptime.

> The read is bounded (`EVENT_LIMIT`, 10 000) and sets `truncated: true` when the window filled a
> page, and the UI then labels the figures a **floor**. Silently understating downtime while looking
> authoritative would be worse than saying so.

### Action aging — `/api/reports/aging`

How long problems sit unacknowledged, in buckets (<1h, 1–4h, 4–24h, >24h) plus the longest-waiting
list. This is the *"the team repeats manual checks"* half of Goal 4, measured.

### Capacity — `/api/reports/capacity`

Reads `trend.get` (hourly aggregates), **falling back to `history.get`** on an instance too young to
have trends — otherwise a fresh deployment shows an empty report and looks broken. Verified key
matchers:

| Metric | Matches | Trap |
|---|---|---|
| CPU | `system.cpu.util` **exactly** | `system.cpu.util[,idle]` is the *idle* share — the opposite |
| Memory | `vm.memory.util` | `vm.memory.size[available]` is bytes, not a percentage |
| Filesystem | keys ending `,pused]` | — |

Rows carry `source: 'trend' | 'history' | 'none'`, and the page states when a zero means *no data*
rather than *idle*.

---

## 19. Authentication & RBAC

Implements [`../plan_1.2.md`](../plan_1.2.md) Phase 7 and closes its defect #5. Every source slide in
HCML's review is stamped **Private and Confidential**, so an open portal is not deployable.

`AUTH_ENABLED=true` turns on JWT login; the `onRequest` guard then rejects unauthenticated `/api/*`
calls (health and the auth routes excepted). The Zabbix token is never exposed either way — **RBAC
decides who sees which portal view, not what the BFF may ask Zabbix.**

### Three roles

The portal is read-only today, so roles divide by **sensitivity and cost**, not write access:

| Role | Gets | Rationale |
|---|---|---|
| **viewer** | all monitoring, Sites, Services, SLA, reports — **and "Explain"** | The plain-language layer exists *precisely* for non-engineers. Gating it higher would defeat its purpose. |
| **operator** | + Network, Links & WAN | Engineering surfaces; also where acknowledge/close write-back will land. |
| **admin** | + Inventory scorecard | Governance, not monitoring. |

Enforcement lives in [`auth.ts`](server/src/auth.ts) `ROUTE_RULES`, **first match wins, and anything
unmatched requires `viewer`** — so a newly added route is protected by default rather than
accidentally public. A 403 explains itself: *"This view needs the admin role; you are signed in as
viewer."*

The sidebar hides what a role can't reach, but that is only courtesy — **the BFF enforces it
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
runs open with zero setup — that is a dev convenience and `docker-compose.yml` defaults it to
**true**.

Next: SSO/LDAP in place of env users, and the acknowledge/close write-back through a separate
`ZBX_WRITE_TOKEN` (deliberately not the read-only token).

---

## 20. Acknowledge / close write-back

The portal's **only** write. Everything else in this BFF is read-only by design
(`instruct.md` §0 rule 2), so this route is fenced deliberately rather than bolted on.

### Three independent fences

| # | Fence | Effect |
|---|---|---|
| 1 | **A separate `ZABBIX_WRITE_TOKEN`** | The read token never gains write power. If it did, *every* read path in the BFF would silently be able to modify Zabbix — one bug away from a write. |
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
Zabbix — the event came back `acknowledged = 1` carrying the note.

### Closing needs the trigger's permission

Zabbix only allows a manual close when the trigger sets `manual_close`. Rather than offer a button
that Zabbix would reject, `getProblems()` carries a `manualClose` flag — read from the **existing**
`trigger.get` call, so it costs no extra request — and the dialog disables the Close checkbox with
the reason shown.

### Caches must be dropped, not waited out

Problem state is cached for 5 s, and several other views derive from it. Without invalidation an
acknowledgement wouldn't appear until the TTL expired and the click would look like it did nothing.
After a successful write the route calls `invalidate()` on `problems`, `stats`, `probsByGroup`,
`sites`, `aging` and `services`. Measured: the very next `GET /api/problems` already showed
`acknowledged = 1`.

### On the page

Problems grows an **Ack** button (open problems only, and only when both fences 1 and 2 pass). It
opens a confirmation dialog — optional message, an Acknowledge checkbox, and a Close checkbox that
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

[§13](#13-plain-language-layer-ai) answers *context* — what an alarm means. This answers the
question underneath it: **which alarms weren't worth sending?**

### Why Top 100 triggers isn't enough

Top 100 counts *how often* a trigger fired. That single number can't tell noise from signal.
Measured on the dev instance:

| Trigger | Fired | Median duration | Acknowledged | Reality |
|---|---|---|---|---|
| SD-WAN link flapping | **6** | **4 s** | 0% | Pure noise — cleared itself before anyone could look |
| Zabbix agent unavailable | 2 | 153 638 s | 100% | A real fault, open for two days |

Ranked by count, Top 100 puts the **noise first**. Duration and acknowledgement are what separate
them, so this report adds both.

### The three flags

A trigger carries *flags*, not one category — it can genuinely be both flapping and ignored:

| Flag | Condition | What it tells you |
|---|---|---|
| `flapping` | ≥ `NOISE_MIN_COUNT` firings **and** median < `NOISE_SHORT_SECONDS` | The threshold is too tight. Retune it. |
| `unactioned` | ≥ `NOISE_MIN_COUNT` firings **and** ack rate 0 | The team has learned to ignore it — the strongest retune signal there is. |
| `chronic` | still open **and** longest > 24 h | *Not* noise. One condition nobody has cleared. |

Defaults: `NOISE_SHORT_SECONDS=300`, `NOISE_MIN_COUNT=5`.

**Median, not mean.** One six-hour outlier would otherwise hide forty ninety-second firings — the
exact pattern the report exists to surface.

### The Pareto line

The headline for management, computed from the same data:

> **5 triggers produced 80% of all alerts in this period.**

That is HCML's own sentence turned into a number, and it points at the shortest path to a quieter
NOC: retune the few at the top rather than triage the rest.

### Implementation note — one fetch, two reports

Availability (§18) and this report ask different questions of the same history. Rather than
duplicate the trickiest code in the codebase, `fetchIncidents(days, minSeverity)` does the shared
work once — fetch PROBLEM events, batch-resolve their recoveries via `r_eventid`, clip to the window
— and each report groups the result its own way: availability by **host** (merging overlaps), noise
by **trigger**. `EVENT_LIMIT` and the `truncated` flag apply to both, so neither ever presents a
truncated count as authoritative.

### Trying it

```bash
curl "localhost:4000/api/reports/noise?days=7" | jq '.concentration, .counts'
```
