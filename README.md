# HCML Monitoring Portal

A bespoke, **service-centric** monitoring portal for HCML built on the **Zabbix API**.

Zabbix stays the collection and configuration engine. Keep its native UI for host, item and trigger
admin. This portal is the layer Zabbix's UI cannot be: site-structured, role-aware, plain-language,
and organised around services rather than devices. It covers both server/infrastructure and network
monitoring (SNMP/ICMP), reading everything the same way, through the API.

```
 Browser (React)  ──HTTPS+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

**The browser never sees a Zabbix or model credential.** Every call goes through the BFF.

The portal is **read-only except acknowledge/close**, and that one write runs on a separate,
write-scoped token. Blank that token and the portal is strictly read-only.

Nine flows are written out in that same one-line form: a page load, the live dashboard, the request
pipeline, the cache, auth, where a number comes from, both AI paths and the one write: in
[`docs/flow/README.md`](docs/flow/README.md#the-nine-flows-one-line-each).

---

## Tech stack

**21 direct dependencies** in total, 11 in the BFF, 10 in the web app. The two heaviest categories
of dependency a project like this usually carries are deliberately absent: there is **no ORM or
database driver** (the portal owns no data: everything comes from Zabbix over the API) and **no
component library** (the UI is plain CSS, so the app runs with zero extra setup).

### BFF: `server/`

| Piece | Version | What it does here |
|---|---|---|
| **Node** | 20 (`node:20-alpine`) | Picked for native `fetch` and `AbortSignal.timeout`. The Zabbix client is 174 lines and the model client a few hundred, both written straight onto them, so there is no HTTP-client dependency at all |
| **TypeScript** | ^5.5 | ESM throughout: `"type": "module"`, `NodeNext` resolution, ES2022 target, `strict: true`. Tests live under `src/` (same imports as the code) but are excluded from the shipped `dist/` and typechecked by a second config |
| **Fastify** | ^4.28 | Plugin-scoped hooks are the reason the RBAC guard is a single `onRequest` at the root rather than a check repeated in every handler. 17 route modules register onto it → 38 endpoints, plus health, login and `/api/auth/me` |
| `@fastify/helmet` | ^11.1 | Security headers. CSP is off: nginx serves the SPA, Fastify only serves JSON |
| `@fastify/cors` | ^9.0 | Exactly one allowed origin, from `WEB_ORIGIN` |
| `@fastify/jwt` | ^8.0 | Signs the 12-hour login token. `?token=` is accepted alongside `Authorization`, because `EventSource` cannot set a header |
| `@fastify/rate-limit` | ^9.1 | Per-IP cap, with `/api/stream` and `/api/health` exempt: a NOC wall that polls must not throttle itself |
| `dotenv` | ^16.4 | `.env` in dev. In Docker, Compose passes the environment directly |
| `@anthropic-ai/sdk` | ^0.124 | The `anthropic` backend of the AI layer, and nothing else. The OpenAI-compatible backend is hand-rolled on `fetch`: one response shape to maintain instead of a second SDK to keep current |
| **Vitest** | ^2.1 | 336 tests in 19 files. Zabbix is mocked at `src/zabbix.ts` (the single module all API traffic funnels through) so the suite needs no live instance |
| **tsx** | ^4.16 | `npm run dev` watch mode only. Production runs plain `node dist/index.js` |

### Web: `web/`

| Piece | Version | What it does here |
|---|---|---|
| **React** | ^18.3 | — |
| **Vite** | ^5.4 | Dev server proxies `/bff` → `:4000`, so dev and prod hit the same paths. The production build is static files |
| `react-router-dom` | ^6.26 | All 18 pages are `lazy()`. The initial bundle is **182 kB JS + 26 kB CSS**; a page after that costs between 1 and 16 kB |
| **ECharts** + `echarts-for-react` | ^5.5 / ^3.0 | Registered selectively (line chart, grid, tooltip, legend, data zoom, canvas renderer) instead of the barrel, which pulls in roughly a megabyte of chart types nothing draws. Imported only by `TimeSeriesChart`, so its 539 kB chunk loads on **Graphs** and **Network** and nowhere else |
| **Custom CSS** | — | One `styles.css`, HCML palette `#0067B1`, Inter plus IBM Plex Mono. Light and dark come from one set of CSS variables, per [`DESIGN.md`](DESIGN.md). `web/scripts/tokens.check.mjs` computes the contrast of every pair in both themes and fails on a raw value used where a token exists |
| **Hand-rolled, on purpose** | — | `hooks/useSSE.ts` over native `EventSource`; `hooks/useAsync.ts` for server state, in place of a query library; `lib/markdown.ts` in 141 lines, because the assistant's answers are the only markdown in the app and a full renderer is a large attack surface for a small job |

### Around it

| Piece | Version | What it does here |
|---|---|---|
| **Zabbix** | 7.0 | The only data source, read over **JSON-RPC 2.0**, never its database. Two tokens: read everywhere, write only for acknowledge/close |
| **Docker Compose** | — | Two services, neither of them a datastore: `portal-bff` (Node) and `portal-web` (nginx). Both images are multi-stage and install with `npm ci` against a committed lockfile, so one commit builds the same twice |
| **nginx** | alpine | Serves the build and reverse-proxies `/bff`, with `proxy_buffering off` (SSE never arrives without it), a one-year immutable cache on `/assets/`, and SPA fallback to `index.html` |
| **The model** | — | One switch, `AI_PROVIDER`, over two backends that get the same prompt and the same JSON Schemas. See *Plain-language layer* below |

**This copy runs the hosted backend:** `AI_PROVIDER=anthropic` with `claude-sonnet-4-6`. The sibling
repo `hcml-portal-ollama` is the *same source tree* running `AI_PROVIDER=openai-compatible` against
`qwen3:8b` on the host. Everything in the three tables above is identical in both: `diff -r` over
`server/src`, `web/src` and both `scripts/` prints nothing.

**What does differ is 21 files**, all of them configuration or per-repo perspective, never code:
the two `.env` files and both `.env.example` templates · `docker-compose.yml` (the published port) ·
`setup.md` (three port lines) · the eight perspective documents, all now under `docs/`, `README.md`,
`AUDIT_REPORT.md` (the two audits cover different tiers), `docs/schema/{CDM,ERD,PDM}.mmd` + their
PDFs, `docs/schema/README.md`, `docs/flow/DataFlow.mmd` + `.pdf` and `docs/flow/README.md` · and
three added on 22 Sep with the rest of `docs/`: `docs/api/openapi.yaml` (the published port),
`docs/architecture/adr/0005-*` (the AI-layer perspective) and `docs/index.md`. `diff -rq` is the
check, and it prints exactly these 21.

Deliberately **not** used: no ORM or database driver (the portal owns no data), no state-management
library (server state is two small hooks), no component library, and no second HTTP client: the
Zabbix client (174 lines) and model client (`ai.ts`, 665) are both hand-rolled around native `fetch`.

---

## Layout

```
hcml-portal/
├── server/                  # BFF: Fastify + TypeScript
│   └── src/
│       ├── index.ts         # app, plugins, route registration
│       ├── config.ts        # env config + startup validation
│       ├── errors.ts        # typed failure → HTTP mapping
│       ├── zabbix.ts        # JSON-RPC client; read/write token split, timeouts
│       ├── ai.ts            # LLM client (plain-language layer): Claude or a local model
│       ├── chat.ts          # the assistant: estate snapshot + streamed answers
│       ├── cache.ts         # TTL cache, in-flight coalescing, invalidate(prefix)
│       ├── auth.ts          # JWT login + 3-tier RBAC guard
│       ├── queries.ts       # shared Zabbix queries
│       ├── routes/          # 17 modules → 38 endpoints (41 with health, login, auth/me)
│       └── __tests__/       # vitest suite (336 tests)
├── web/                     # React + TypeScript + Vite
│   ├── src/
│   │   ├── pages/           # 18, all lazy-loaded
│   │   ├── components/      # Layout, Sidebar, ExplainPanel, AckDialog, …
│   │   ├── hooks/           # useAsync, useSSE, useAuth, useUiPrefs, useUrlState, …
│   │   └── api.ts, types.ts, theme.ts, styles.css
│   ├── scripts/             # css.check.mjs, tokens.check.mjs, markdown.check.ts, units.check.ts
│   ├── public/              # logo.png · logo-mark.png · logo-icon.png (served at /)
│   └── brand/               # the supplied original, kept for provenance, not served
├── docs/                    # everything documentary lives here
│   ├── index.md             # what is documented, and in what order to read it
│   ├── getting-started.md   # clone → running portal
│   ├── contributing.md      # the house rules, and why each one exists
│   ├── api/openapi.yaml     # all 41 endpoints; checked by scripts/openapi.check.ts
│   ├── architecture/adr/    # 8 Architecture Decision Records (MADR)
│   ├── schema/              # the data model on three pages: CDM · ERD · PDM (start here)
│   ├── flow/                # how it runs: WebFlow · ServerFlow · DataFlow, and nine one-line flows
│   ├── ux/                  # who uses this: roles, the acknowledge journey (derived, not interviewed)
│   └── erd/                 # the exhaustive reference set behind it
├── .github/workflows/       # docs.yml: typechecks, tests and the seven checkers
├── DESIGN.md                # the design direction: identity, palette, typography, mood
├── erd.md                   # the data model in full, and the three-levels index
├── setup.md                 # how each subsystem works and why, 29 sections
├── AUDIT_REPORT.md          # security + documentation audits
├── docker-compose.yml       # portal-web (nginx) + portal-bff
└── web/nginx.conf           # serves the build, reverse-proxies /bff
```

**18 pages**: Dashboard · Problems · Sites · Hosts · Graphs · Latest data · Maps · Network ·
Links & WAN · Services · SLA · Availability · Capacity · Alert noise · Top 100 triggers ·
Inventory scorecard · Ask the assistant · Login

---

## Quick start (local dev)

### 0. Zabbix prep

Create a **read-only role + user** in Zabbix and an **API token** for it. If you want
acknowledge/close, create a **second, write-capable token**: deliberately not the same one, so no
read path can ever write. Smoke-test:

```bash
curl -s http://localhost:8080/api_jsonrpc.php \
  -H 'Content-Type: application/json-rpc' \
  -H 'Authorization: Bearer <TOKEN>' \
  -d '{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid","name"],"limit":3},"id":1}'
```

### 1. Backend (BFF)

```bash
cd server
cp .env.example .env          # set ZBX_URL + ZABBIX_API_TOKEN
npm install
npm run dev                   # http://localhost:4000
npm test                      # 336 tests, no live Zabbix needed

curl localhost:4000/api/health
```

### 2. Frontend

```bash
cd web
npm install
npm run dev                   # http://localhost:5173 (proxies /bff → :4000)
```

### 3. Data

Point `ZBX_URL` at a Zabbix that already has hosts. An empty one makes for an empty portal.

> **The demo-estate seed scripts have been removed** (21 Sep 2026). They wrote to whatever `ZBX_URL`
> pointed at, and since 15 September that is HCML's restored **production** data: where their
> deliberately HCML-shaped host names could collide with real ones. The demo estate itself is parked
> in the `proto1_pgdata` volume.
>
> **The scripts are gone for good.** An earlier version of this note said they were recoverable from
> commit `b4a4059`; that was checked on 21 Sep and is false. `tools/` was created on 8 September, one
> day *after* that commit, and was never `git add`ed: its tree holds 88 paths and not one of them is
> under `tools/`. A genuinely empty dev Zabbix would need them written again.

---

## Deploy (Docker, next to Zabbix)

```bash
cp .env.example .env          # ZBX_URL, ZABBIX_API_TOKEN, and a real JWT_SECRET
docker compose up -d --build
# http://localhost:8081
```

`JWT_SECRET` has **no default**. Compose refuses to start without it, and the BFF exits if it is
still the placeholder: an authenticated portal signing tokens with a value published in this repo
looks perfectly healthy while anyone can forge an admin token.

**Reaching Zabbix.** The Zabbix stack runs in its own compose project, so there is no shared network
and no DNS between them. `ZBX_URL` defaults to `http://host.docker.internal:8080/api_jsonrpc.php`,
which works on Docker Desktop. On Linux add `extra_hosts: ["host.docker.internal:host-gateway"]`, or
point `ZBX_URL` at the Zabbix host directly.

The portal runs independently of Zabbix: Zabbix upgrades don't affect it, since it only uses the
stable API.

---

## Usage

Everything above gets the portal running. This section is what it is *for*. The step-by-step first
run (Zabbix token, smoke test, first login) is in
[`docs/getting-started.md`](docs/getting-started.md) and is not repeated here.

### Signing in

There is no user table. Users come from the environment: `PORTAL_USERS` as comma-separated
`name:password:role` triples, or `PORTAL_USER`/`PORTAL_PASS` as the single-admin shorthand. A
successful login returns a JWT valid for **12 hours**, and the browser keeps it in memory only: a
refresh signs you out.

With `AUTH_ENABLED=false`, which is the `server/.env` default for local work, there is no login at
all and every caller is treated as `admin`.

Three roles, and the BFF is what enforces them:

| Role | Can reach |
|---|---|
| `viewer` | Everything not listed below. Unmatched routes require viewer, so a new route is protected by default |
| `operator` | …plus `/api/links`, `/api/net/*` and the acknowledge write |
| `admin` | …plus `/api/reports/inventory` |

The sidebar hides what your role cannot reach, but that is **cosmetic**: the guard is server-side and
returns 403 whatever the browser shows. Passwords are compared in plain text and the rules live in
`server/src/auth.ts:34-40`. See [Known gaps](#known-gaps), audit items BE-13 – BE-17.

### The 18 pages

Grouped by the question each one answers, not by the order they appear in the sidebar.

| Page | Route | What it answers |
|---|---|---|
| Dashboard | `/` | Is anything wrong right now? The only page that streams |
| Problems · Alert noise · Top 100 triggers | `/problems` · `/reports/noise` · `/reports/top-triggers` | What is firing, and what fires so often that nobody reads it any more |
| Sites · Hosts · Latest data · Graphs · Maps | `/sites` · `/hosts` · `/latest` · `/graphs` · `/maps` | Where a device is, what it is reporting, and what it looked like an hour ago |
| Network · Links & WAN | `/network` · `/links` | **operator**: the WAN view: which links are up, and what they cost in latency and loss |
| Services · SLA · Availability | `/services` · `/sla` · `/reports/availability` | The monthly figure. Derived in the portal, validated against HCML's own published reports |
| Capacity | `/reports/capacity` | What is filling up, and roughly when it runs out |
| Inventory scorecard | `/reports/inventory` | **admin**, how complete the inventory data actually is |
| Ask the assistant | `/assistant` | Plain-language questions over the estate |
| Login | `/login` | Only reachable when `AUTH_ENABLED=true` |

Sites, links, incidents, host availability and the SLA are the portal's own work: Zabbix has no
table for any of them. That is the whole reason the portal exists
([ADR-0001](docs/architecture/adr/0001-bff-over-zabbix-api.md)).

### Calling the API

Log in, then send the JWT as a bearer token:

```bash
BFF=http://localhost:8081/bff        # dev: http://localhost:4000

TOKEN=$(curl -s "$BFF/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s "$BFF/api/sites" -H "Authorization: Bearer $TOKEN"
```

There is a **second accepted scheme**: `?token=<jwt>` on the query string. It exists because
`EventSource` cannot set an `Authorization` header, but the guard accepts it on *every* `/api/*`
route, not only the SSE ones (`server/src/auth.ts:129-132`). `logging.ts` redacts it from the request
log; treat a URL carrying one as a credential.

`GET /api/health` and `/api/auth/*` need no token. Every error, at every status, has the same body:
`{ "error": "…", "message": "…" }`.

The full contract is [`docs/api/openapi.yaml`](docs/api/openapi.yaml): 41 endpoints, both security
schemes, every status code, and [`docs/api/README.md`](docs/api/README.md) shows how to read it with
nothing installed. It is checked against the code by `npx tsx server/scripts/openapi.check.ts`, so it
cannot quietly drift.

### The assistant

Optional, off unless configured, and **never called on page load**. Two paths:

- **Explain**: the button on a problem or an SLA figure. Sends that one item, returns a buffered
  answer, cached an hour.
- **Ask the assistant**: the chat page. Sends a rollup of the whole estate and streams the answer
  back token by token over SSE (`POST /api/chat`, events `context`, `token`, `done`, `error`).

In this copy the model is **hosted Claude over the Anthropic API**, so what is sent: host names,
trigger names, problem text, **leaves this machine**. The sibling repo `hcml-portal-ollama` is the
same code pointed at a local `qwen3:8b`, where it does not. Which one answers is one line of `.env`
([ADR-0005](docs/architecture/adr/0005-provider-neutral-ai-layer.md)), and exactly what crosses on
each path is itemised in [`docs/flow/README.md`](docs/flow/README.md).

---

## Configuration

All of these are read by the BFF. `.env.example` is committed and must never contain a real
credential; `.env` and `server/.env` are gitignored.

### Connection

| Var | Default | Purpose |
|---|---|---|
| `ZBX_URL` | `http://localhost:8080/api_jsonrpc.php` | Zabbix API endpoint |
| `ZABBIX_API_TOKEN` | — | **Read-only** token. `ZBX_TOKEN` is a deprecated alias that warns at startup |
| `ZABBIX_WRITE_TOKEN` | — | Separate **write** token for acknowledge/close. Blank ⇒ portal is strictly read-only and those routes return 503 |
| `ZABBIX_TIMEOUT_MS` | `10000` | Ceiling on one Zabbix call. Prevents a hung Zabbix hanging every page |
| `PORT` | `4000` | BFF listen port |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. **On** behind nginx, off otherwise, trusting it with nothing in front lets a client forge its own IP |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-IP request cap. `/api/stream` and `/api/health` are exempt |

### Access control

| Var | Default | Purpose |
|---|---|---|
| `AUTH_ENABLED` | **`true`** | Secure by default. Set `false` only for local dev |
| `JWT_SECRET` | — | Token signing secret. The server **refuses to start** on the placeholder when auth is on |
| `PORTAL_USER` / `PORTAL_PASS` | `admin` / `admin` | Single-user fallback |
| `PORTAL_USERS` | — | `name:password:role` triples, comma-separated. Roles: `viewer`, `operator`, `admin` |

### Grouping and scoring

| Var | Default | Purpose |
|---|---|---|
| `NET_GROUP_IDS` | — | Zabbix host **group ids** holding network devices. Empty = all hosts |
| `SITE_TAG` | `site` | Host tag naming the site: the most explicit signal for the Sites view |
| `SITE_GROUP_PREFIX` | — | Only host groups with this prefix name sites. Empty = use the first group |
| `OWNER_TAG` / `CRITICALITY_TAG` | `owner` / `criticality` | Tags the inventory scorecard looks for |
| `HOST_NAME_PATTERN` | — | Regex a compliant host name must match. Empty = naming not scored |

### Report thresholds

| Var | Default | Purpose |
|---|---|---|
| `AVAILABILITY_MIN_SEVERITY` | `2` | Severity floor for the availability report. **2, not 3**: HCML's estate alarms at Warning, and a floor of 3 makes the page open empty |
| `LINK_LOSS_WARN` / `LINK_LOSS_CRIT` | `2` / `10` | Packet-loss thresholds, percent |
| `NOISE_SHORT_SECONDS` | `300` | Below this, a cleared incident counts as flapping |
| `NOISE_MIN_COUNT` | `5` | Firings before "flapping" means anything |

### Derived SLA

HCML's Zabbix has no services, so the SLA and Services pages measure availability in the portal
from the ICMP triggers every device already carries. See setup.md, *Derived SLA and services*.

| Var | Default | Purpose |
|---|---|---|
| `SLO_TARGET` | `99` | Availability target, percent: every row of HCML's reports uses 99 |
| `SLA_TIMEZONE` | `Asia/Jakarta` | Calendar months are cut at midnight in this zone |
| `SLI_PROFILE` | `availability` | Default method: `availability` (strict, unreachable or high loss is down, hours with no data left out) or `hcml-report` (reproduces HCML's published reports) |
| `SLI_REPORT_TRIGGERS` | `High ICMP ping loss` | Trigger names behind HCML's published figures |
| `SLI_AVAILABILITY_TRIGGERS` | `Unavailable by ICMP ping,High ICMP ping loss` | Trigger names that mean "down" for the strict method |
| `SLI_MIN_COVERAGE` | `0.5` | Below this share of collected time a device shows "no data" |
| `SLI_ZBX_PARALLEL` | `4` | Concurrent Zabbix calls while computing one report |

### Plain-language layer (optional)

Two backends sit behind one switch. Both get the same prompt and the same JSON Schemas, so they
are directly comparable on the same problem.

| Var | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `anthropic` | `anthropic` (hosted Claude) or `openai-compatible` (a local model, Ollama, vLLM, llama.cpp) |
| `ANTHROPIC_API_KEY` | — | The `anthropic` backend. Blank ⇒ `/api/explain/*` returns 503 and the UI hides the buttons. Everything else still works |
| `AI_BASE_URL` | — | The `openai-compatible` backend, e.g. `http://localhost:11434/v1`. Blank ⇒ same 503 rule |
| `AI_API_KEY` | — | Optional, and only for a hosted OpenAI-compatible gateway. A local Ollama wants none |
| `AI_MODEL` | `claude-sonnet-4-6` / `qwen3:8b` | Per backend |
| `AI_TIMEOUT_MS` | `30000` / `120000` | Per backend. The SDK's 10-minute default is far too long for a request a human is waiting on; a local model generates more slowly and loads from disk when cold, so it gets more headroom |
| `AI_MAX_RETRIES` | `1` | **Anthropic only**: the SDK implements it. The local backend does not retry |
| `AI_KEEP_ALIVE` | `30m` | Local model only: how long Ollama keeps it loaded after its last use (~5 GB for `qwen3:8b`) |
| `AI_OLLAMA_NATIVE` | `auto` | `auto` asks `AI_BASE_URL` without `/v1` for `/api/version` and, if Ollama answers, uses its native `/api/chat` for chat, explain, warm-up and prefill: the only API that takes a context size and honours `AI_KEEP_ALIVE` (each `/v1` call resets the expiry to 5 min). `true` / `false` skip the check; any other server keeps `/v1` |
| `AI_NUM_CTX` | `8192` | Native Ollama only. Context window in tokens, sent with **every** request: Ollama restarts the model, and drops its prompt cache, whenever a request asks for a different size. The cache for 8192 tokens takes ~0.6 GB, twice that of Ollama's default of 4096 |
| `AI_TEMPERATURE` | `0.7` | Native Ollama only. Sampling temperature, stated explicitly, since `/v1` sampled at 1.0. 0.7 / 0.8 is Qwen3's recommendation for answers without thinking |
| `AI_TOP_P` | `0.8` | Native Ollama only. Nucleus sampling, as above |

> **The governance question depends on which backend you pick.** With `AI_PROVIDER=anthropic` the
> portal sends host names, trigger names and problem descriptions to an external API, and every HCML
> source document is stamped *Private and Confidential*: a policy decision, not a technical one.
> With `AI_PROVIDER=openai-compatible` pointed at a model on the same host, none of it leaves the
> machine and the question does not arise.

#### Running the model locally

```bash
brew install ollama
brew services start ollama
ollama pull qwen3:8b          # ~5 GB
```

Then in `server/.env`:

```
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3:8b
AI_TIMEOUT_MS=120000
```

Run Ollama **natively, not in a container**: Docker Desktop on macOS cannot pass through the Metal
GPU, so a containerised Ollama falls back to CPU and is far slower. From the `portal-bff` container,
reach it at `http://host.docker.internal:11434/v1`, the same way `ZBX_URL` reaches Zabbix.

#### The assistant

The **Assistant** page in the sidebar (`/assistant`) answers free-form questions: *"what needs
attention right now?"*, *"are we meeting the SLA?"*, from a read-only **snapshot** of the estate:
open problems, sites, unreachable hosts, SLA standing and degraded services, all from the same
caches the pages already use. The model has no tools and can neither query nor change Zabbix; the
worst it can do is be wrong, and the page says so. Answers stream in as they are generated
(`POST /api/chat`, server-sent events). Same `AI_PROVIDER` switch, same backends, `viewer` role.

The snapshot is **reused for up to five minutes** so the model can answer from its prompt cache
instead of re-reading ~2,400 tokens per question (first word in under a second instead of 6–8 s).
It is rebuilt at once when a problem opens, closes, is acknowledged or re-graded, and when a host's
state change has held for a minute (links that flap every few seconds do not force a rebuild).
Opening the Assistant page pre-reads the current snapshot. Questions naming a site get a short
per-host **focus** block after it. The model answers one request at a time; a request that waits
more than 20 s gets `503 ai_busy` with `Retry-After`.

The limit is the model's context window. Against Ollama the BFF asks for `AI_NUM_CTX` (8 192
tokens) on every request, so nothing needs setting in Ollama's own environment; through `/v1`
(`AI_OLLAMA_NATIVE=false`, or another server) the server's default applies: 4 096 tokens for
Ollama. Either way the snapshot is capped (20 problems, a budget per section) and the page shows
*partial view* when a list was cut.

---

## Testing

```bash
cd server
npm test          # 336 tests
npm run typecheck # app and tests
```

Zabbix is mocked at `src/zabbix.ts` (the single point all API traffic funnels through) so the
suite needs no live instance and runs in CI. Coverage is weighted toward the code that would produce
*confidently wrong numbers* rather than visible errors: interval merging in the availability report,
the RBAC route table, cache coalescing, and the naming-convention regex.

---

## Milestones

- [x] **M1–M8**, BFF, Overview, history graphs, SSE, theme + login, Docker, network views
- [x] **M9**, service-centric views: Sites, Services tree, SLA
- [x] **M10**, reporting: availability, capacity, action aging, alert noise, inventory scorecard
- [x] **M11**, auth + 3-tier RBAC, acknowledge/close write-back
- [x] **M12**, production image built and verified through nginx; test suite
- [ ] **M13**, real HCML devices onboarded in Zabbix → the views populate live
- [ ] **M14**, cross-trigger correlation

---

## Notes

- UI is lightweight custom CSS (HCML palette `#0067B1`, Inter) rather than a component kit, so the
  app runs with zero extra setup.
- Charts use **ECharts**, registered selectively (line chart + grid/tooltip/legend + canvas
  renderer) rather than the full barrel, and loaded only by the two pages that draw graphs.
- Every page is code-split. The initial bundle is 182 kB of JS plus 26 kB of CSS.
- Related docs: **[`docs/index.md`](docs/index.md), start here** · [`docs/api/openapi.yaml`](docs/api/openapi.yaml)
 (the API contract, 41 endpoints · [`docs/architecture/adr/`](docs/architecture/adr/)) why it is
  shaped this way, 8 decisions · [`setup.md`](setup.md), how each subsystem works and **why**, 29
  sections · [`docs/schema/`](docs/schema/) (the data model on three pages · [`docs/flow/`](docs/flow/)) the same
  system in motion, on three more · [`docs/contributing.md`](docs/contributing.md): the house rules
  before you change anything · [`erd.md`](erd.md): the data model in full ·
  [`AUDIT_REPORT.md`](AUDIT_REPORT.md): the security and documentation audits.

---

## Known gaps

Kept short and honest; the full list is [`setup.md` §27](setup.md#27-limitations-and-known-gaps).

- **The dataset is frozen** at 17 Sep 2026 16:59:37. Local polling was stopped deliberately: a
  laptop should not poll production equipment. Every figure here is a snapshot of that moment.
- **Security items BE-13 – BE-17 are open**: passwords are compared in plain text, users come from
  environment variables, and `server/.env` still holds the placeholder `JWT_SECRET` the BFF is
  designed to refuse. The Anthropic key flagged on 10 Sep has still not been rotated.
- **Nothing persists.** No audit trail of who acknowledged what, no saved views, no user table, and
  a closed month's SLA is recomputed from scratch after every restart.
- **Every performance figure is single-user and single-shot.** No p95, no concurrency data, and the
  cache hit rate has never been measured.
