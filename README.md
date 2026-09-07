# HCML Monitoring Portal

A bespoke, branded, **read-only** monitoring portal for HCML built on top of the **Zabbix API**.
Zabbix stays the collection + config engine (keep its native UI for host/item/trigger admin); this
portal is the NOC / dashboard view. It covers **both server/infrastructure and network monitoring**
(SNMP/ICMP), reading everything the same way — through the Zabbix API.

Built to the plan in [`../instruct.md`](../instruct.md).

```
 Browser (React)  ──HTTPS+SSE──►  BFF (Fastify, holds token, caches)  ──JSON-RPC──►  Zabbix API
```

The browser **never** sees the Zabbix token. All Zabbix calls go through the BFF.

---

## Layout

```
hcml-portal/
├── server/          # BFF — Fastify + TypeScript (holds the Zabbix token, caches, SSE)
│   └── src/
│       ├── index.ts        # app + route registration
│       ├── config.ts       # env config
│       ├── zabbix.ts        # typed JSON-RPC client
│       ├── cache.ts         # TTL cache (swap for Redis later)
│       ├── auth.ts          # optional JWT login + guard
│       ├── queries.ts       # shared Zabbix queries (enriched problems, …)
│       └── routes/          # /api/* handlers (hosts, problems, history, net, stream)
├── web/             # React + TypeScript + Vite (HCML theme, ECharts)
│   └── src/
│       ├── pages/          # Overview, Problems, HostDetail, Network, Login
│       ├── components/     # Layout, Sidebar, KpiCard, ProblemsTable, …
│       ├── hooks/          # useAsync, useSSE
│       ├── lib/            # severity map, formatters
│       ├── api.ts, types.ts, theme.ts, styles.css
├── docker-compose.yml       # portal-web (nginx) + portal-bff
├── nginx reverse proxy lives in web/nginx.conf
└── .env.example
```

---

## Quick start (local dev)

### 0. Zabbix prep (Phase 0 / M0)
1. Create a **read-only role + user** in Zabbix, then an **API token** for it.
2. Smoke-test the token:
   ```bash
   curl -s http://localhost:8080/api_jsonrpc.php \
     -H 'Content-Type: application/json-rpc' \
     -H 'Authorization: Bearer <TOKEN>' \
     -d '{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid","name"],"limit":3},"id":1}'
   ```
   You should get a JSON `result` array of hosts.

### 1. Backend (BFF)
```bash
cd server
cp .env.example .env          # then paste ZBX_URL + ZBX_TOKEN
npm install
npm run dev                   # http://localhost:4000
# verify:
curl localhost:4000/api/health
curl localhost:4000/api/problems
```

### 2. Frontend
```bash
cd web
npm install
npm run dev                   # http://localhost:5173  (proxies /bff -> :4000)
```

Open http://localhost:5173.

---

## Deploy (Docker, next to Zabbix)

```bash
cp .env.example .env          # set ZBX_URL, ZBX_TOKEN, etc.
docker compose up -d --build
# portal at http://localhost:8081  (nginx serves the web build + reverse-proxies /bff -> BFF)
```

Runs independently of Zabbix — Zabbix upgrades don't affect the portal (it only uses the stable API).

---

## Configuration (env)

| Var | Where | Purpose |
|-----|-------|---------|
| `ZBX_URL` | BFF | Zabbix API endpoint, e.g. `http://zabbix/api_jsonrpc.php` |
| `ZBX_TOKEN` | BFF | Read-only API token (kept server-side only) |
| `PORT` | BFF | BFF listen port (default 4000) |
| `WEB_ORIGIN` | BFF | Allowed CORS origin for dev (default `http://localhost:5173`) |
| `NET_GROUP_IDS` | BFF | Comma-separated Zabbix host **group ids** for network devices (§13). Empty = all hosts |
| `AUTH_ENABLED` | BFF | `true` to require portal login (JWT). Default `false` so the scaffold runs out of the box |
| `JWT_SECRET` / `PORTAL_USER` / `PORTAL_PASS` | BFF | Portal login (only used when `AUTH_ENABLED=true`) |

---

## Milestones (from instruct.md)

- [x] **M1** — BFF serves `/api/hosts` and `/api/problems` from Zabbix.
- [x] **M2** — Overview page shows problem counts + host count.
- [x] **M3** — Host detail page renders a history graph from `/api/history`.
- [x] **M4** — Live problem updates via SSE.
- [x] **M5** — HCML theme + logo + (optional) portal login.
- [x] **M6** — Dockerized; nginx serves web + reverse-proxies `/bff`.
- [x] **M7** — `/api/net/devices` returns network hosts with ICMP availability.
- [x] **M8** — Network page: device up/down grid + per-device port status + interface traffic graph.
- [ ] **M9** — *(later)* real network devices onboarded in Zabbix (SNMP/ICMP) → network views populate live.

> Network **views** are built now against the API; they light up automatically once real devices are
> onboarded in Zabbix (the "network plug", §13.4) — no portal code change needed.

## Notes / choices
- UI is built with lightweight custom CSS (HCML palette `#0067B1`, Inter) instead of shadcn/MUI, so the
  app runs with zero extra setup. Swap in a component kit later if desired.
- Charts use **ECharts** via `echarts-for-react`.
- Auth is included but **off by default** (`AUTH_ENABLED=false`) so the portal is runnable immediately;
  flip it on and set a real `JWT_SECRET` for production.
