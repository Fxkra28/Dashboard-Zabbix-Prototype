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
2. **Read-only, least privilege.** The portal uses a dedicated read-only Zabbix token.
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
| **Hosts**                  | Monitoring → Hosts              | `/api/hosts/overview`             | `host.get` (+ interface availability), `problem.get` |
| **Latest data**            | Monitoring → Latest data        | `/api/latest`                     | `item.get` (lastvalue/lastclock/prevvalue)  |
| **Graphs**                 | Monitoring → Hosts → Graphs     | `/api/history`, `/api/items`      | `item.get`, `history.get`, `trend.get`      |
| **Maps**                   | Monitoring → Maps               | `/api/maps`, `/api/maps/detail`   | `map.get` (selements + links)               |
| **Network**                | (SNMP/ICMP hosts, §13)          | `/api/net/*`                      | `host.get`, `item.get` (icmp*, net.if.*)    |
| **Top 100 triggers**       | Reports → Top 100 triggers      | `/api/reports/top-triggers`       | `event.get` (aggregated by trigger)         |

> **Config is deliberately *not* re-implemented.** Creating hosts/items/triggers/users stays in
> Zabbix's native UI (the "hybrid" approach). The portal is the read-only NOC view.

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
| [`config.ts`](server/src/config.ts) | Typed env (ZBX_URL/TOKEN, port, CORS origin, network group ids, auth). Warns (doesn't crash) on missing token. |
| [`zabbix.ts`](server/src/zabbix.ts) | The **only** place the token is used. One `zbx(method, params)` JSON-RPC helper; throws on Zabbix errors. |
| [`cache.ts`](server/src/cache.ts) | TTL `Map` cache **+ in-flight coalescing** (concurrent misses for the same key await one fetch, so polling can't stampede Zabbix). |
| [`queries.ts`](server/src/queries.ts) | Shared `getProblems()` — enriches problems with host id/name. Reused by REST + SSE. |
| [`auth.ts`](server/src/auth.ts) | Optional JWT login + `onRequest` guard. Off by default (`AUTH_ENABLED=false`). |
| [`routes/hosts.ts`](server/src/routes/hosts.ts) | `/api/hosts`, `/api/hosts/overview`, `/api/hostgroups`, `/api/items`, `/api/latest`. |
| [`routes/problems.ts`](server/src/routes/problems.ts) | `/api/problems` (cached 5 s). |
| [`routes/history.ts`](server/src/routes/history.ts) | `/api/history` (raw) + `/api/trend` (long ranges = hourly aggregates). |
| [`routes/net.ts`](server/src/routes/net.ts) | `/api/net/devices` (+ ICMP), `/api/net/ports`, `/api/net/status`, `/api/net/map`. |
| [`routes/reports.ts`](server/src/routes/reports.ts) | `/api/reports/top-triggers`, `/api/stats`, `/api/reports/problems-by-group`. |
| [`routes/maps.ts`](server/src/routes/maps.ts) | `/api/maps` (list), `/api/maps/detail` (topology). |
| [`routes/stream.ts`](server/src/routes/stream.ts) | `/api/stream` — SSE, pushes live problems every 5 s + keep-alive. |
| [`index.ts`](server/src/index.ts) | Builds the Fastify app, registers CORS, auth, and all route plugins. |

### Endpoint reference (+ cache TTLs)

| Method + path | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{ ok, ts }` | — |
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
| `GET /api/stream` | **SSE** live problems | live |
| `POST /api/auth/login` | `{ token, user }` (when auth on) | — |

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
│   └── useSSE.ts     # subscribe to one SSE event
├── components/
│   ├── Layout.tsx, Sidebar.tsx      # shell (grouped, collapsible menu)
│   ├── KpiCard.tsx, StatusBadge.tsx # KPI tiles, severity/availability pills, count chips
│   ├── ProblemsTable.tsx            # reused problem table
│   ├── TimeSeriesChart.tsx          # ECharts line chart wrapper
│   ├── states.tsx, icons.tsx        # loading/error/empty; inline SVG icons
└── pages/
    ├── Overview.tsx      (/)                    — Dashboard
    ├── Problems.tsx      (/problems)
    ├── Hosts.tsx         (/hosts)
    ├── HostDetail.tsx    (/graphs?hostid=)      — Graphs
    ├── LatestData.tsx    (/latest)
    ├── Maps.tsx          (/maps)
    ├── Network.tsx       (/network)
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

## 8. Authentication

Optional and **off by default** so the scaffold runs with zero setup.

- `AUTH_ENABLED=true` turns on a JWT flow: `POST /api/auth/login` checks `PORTAL_USER`/`PORTAL_PASS`
  and returns a 12 h JWT; an `onRequest` guard then rejects unauthenticated `/api/*` calls (except
  health + auth). The Zabbix token is **never** exposed regardless — portal auth only gates the
  portal's own routes.
- Browser stores the JWT in `localStorage`; [`api.ts`](web/src/api.ts) attaches it and redirects to
  `/login` on a 401.
- For production, wire SSO/LDAP and map users to a read-only role (`instruct.md` §8).

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
