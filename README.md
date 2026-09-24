# HCML Monitoring Portal

A web portal that shows the state of HCML's servers, network devices and WAN links, grouped by
site. HCML is Husky-CNOOC Madura Limited. The portal reads everything from HCML's Zabbix monitoring
system and has no database of its own.

Zabbix already collects every measurement, and it stays the place to set up hosts, items and
triggers. Its own screens list things device by device. This portal regroups the same data by site
and by service, answers "is anything wrong right now?", and works out the monthly availability
figure (the SLA), which HCML's Zabbix has no services configured to produce.

It changes nothing in Zabbix except one thing: an operator can acknowledge or close a problem. That
single write uses its own Zabbix token. Leave that token blank and the portal cannot write at all.

An optional assistant can explain problems in plain language. **In this copy the assistant uses
Claude, a model hosted by Anthropic, so the text of those questions leaves this machine.** The
sibling copy, `hcml-portal-ollama`, runs the same code against a model on the local computer instead.

**Look up to the glossary for the abbreviations** [Glossary](#glossary) at the end.

### How the parts connect

```
 Browser (React)  ──HTTPS+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

Read it left to right. Your browser only ever talks to the portal's own server, the **BFF**. The BFF
holds the Zabbix and model credentials, so the browser never sees them. It asks Zabbix for data in
Zabbix's JSON-RPC format, keeps recent answers for a short time so it does not ask twice, and sends
the result on. The live Dashboard keeps one connection open (SSE) so updates arrive without a reload.

Nine flows are drawn in that same one-line style (a page load, the live Dashboard, the request
pipeline, the cache, sign-in, where a number comes from, both AI paths and the one write) in
[`docs/flow/README.md`](docs/flow/README.md#the-nine-flows-one-line-each).

### Contents

- [Tech stack](#tech-stack): what it is built with, and why
- [Layout](#layout): where each file lives
- [Quick start (local dev)](#quick-start-local-dev): run it on your own machine
- [Deploy (Docker, next to Zabbix)](#deploy-docker-next-to-zabbix): run it in containers
- [Usage](#usage): signing in, the 18 pages, calling the API, the assistant
- [Configuration](#configuration): every setting the BFF reads
- [Testing](#testing)
- [Milestones](#milestones)
- [Related docs](#related-docs)
- [Known gaps](#known-gaps)
- [Glossary](#glossary)

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
| **React** | ^18.3 | The library every screen of the web app is written in |
| **Vite** | ^5.4 | Dev server proxies `/bff` → `:4000`, so dev and prod hit the same paths. The production build is static files |
| `react-router-dom` | ^6.26 | All 18 pages are `lazy()`. The initial bundle is **182 kB JS + 26 kB CSS**; a page after that costs between 1 and 16 kB |
| **ECharts** + `echarts-for-react` | ^5.5 / ^3.0 | Registered selectively (line chart, grid, tooltip, legend, data zoom, canvas renderer) instead of the barrel, which pulls in roughly a megabyte of chart types nothing draws. Imported only by `TimeSeriesChart`, so its 539 kB chunk loads on **Graphs** and **Network** and nowhere else |
| **Custom CSS** | not a package | One `styles.css`. HCML blue `#2B5584`, measured from the company logo, with Inter for text and IBM Plex Mono for IDs and figures. Light and dark come from one set of CSS variables, per [`DESIGN.md`](DESIGN.md). `web/scripts/tokens.check.mjs` computes the contrast of every pair in both themes and fails on a raw value used where a token exists |
| **Hand-rolled, on purpose** | not a package | `hooks/useSSE.ts` over native `EventSource`; `hooks/useAsync.ts` for server state, in place of a query library; `lib/markdown.ts` in 141 lines, because the assistant's answers are the only markdown in the app and a full renderer is a large attack surface for a small job |

### Around it

| Piece | Version | What it does here |
|---|---|---|
| **Zabbix** | 7.0 | The only data source, read over **JSON-RPC 2.0**, never its database. Two tokens: read everywhere, write only for acknowledge/close |
| **Docker Compose** | not pinned | Two services, neither of them a datastore: `portal-bff` (Node) and `portal-web` (nginx). Both images are multi-stage and install with `npm ci` against a committed lockfile, so one commit builds the same twice |
| **nginx** | alpine | Serves the build and reverse-proxies `/bff`, with `proxy_buffering off` (SSE never arrives without it), a one-year immutable cache on `/assets/`, and SPA fallback to `index.html` |
| **The model** | set in `.env` | One switch, `AI_PROVIDER`, over two backends that get the same prompt and the same JSON Schemas. See *Plain-language layer* below |

Deliberately **not** used: no ORM or database driver (the portal owns no data), no state-management
library (server state is two small hooks), no component library, and no second HTTP client: the
Zabbix client (174 lines) and model client (`ai.ts`, 665) are both hand-rolled around native `fetch`.

### The two copies of this portal

This copy runs the hosted model: `AI_PROVIDER=anthropic` with `claude-sonnet-4-6`. Its sibling,
`hcml-portal-ollama`, is the *same source code* set to `AI_PROVIDER=openai-compatible` and pointed at
`qwen3:8b` running on the local computer. Everything in the three tables above is identical in both:
`server/src`, `web/src` and both `scripts/` folders match file for file.

Exactly **21 files** differ between the two. All of them are settings, or documents written from
each copy's point of view. None of them is code:

- the two `.env` files and the two `.env.example` templates
- `docker-compose.yml` and `docs/api/openapi.yaml`, which name each copy's web port
- `setup.md`, where three lines name the port
- `README.md`, `docs/index.md`, and `AUDIT_REPORT.md` (each copy holds a different audit)
- `docs/architecture/adr/0005-*`, the decision record about the AI layer
- `docs/schema/CDM.mmd`, `ERD.mmd` and `PDM.mmd`, their three PDFs, and `docs/schema/README.md`
- `docs/flow/DataFlow.mmd`, its PDF, and `docs/flow/README.md`

The command that proves it, with the exclusions it needs, is in
[`docs/contributing.md`](docs/contributing.md).

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
│   └── erd/                 # the full data model (erd.md) and the reference set behind it
├── .github/workflows/       # docs.yml: typechecks, tests and the seven checkers
├── DESIGN.md                # the design direction: identity, palette, typography, mood
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
successful login returns a JWT valid for **12 hours**. The browser stores it in `localStorage` under
the key `hcml_token` (`web/src/api.ts:41-44`), so it survives a page refresh and stays until you sign
out or it expires.

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
`server/src/auth.ts:34-40`. See [Known gaps](#known-gaps): audit items BE-13 to BE-17, which are
recorded in `hcml-portal-ollama/AUDIT_REPORT.md` (this copy's report covers the web app).

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
| `ZABBIX_API_TOKEN` | none, required | **Read-only** token. `ZBX_TOKEN` is a deprecated alias that warns at startup |
| `ZABBIX_WRITE_TOKEN` | none | Separate **write** token for acknowledge/close. Blank ⇒ portal is strictly read-only and those routes return 503 |
| `ZABBIX_TIMEOUT_MS` | `10000` | Ceiling on one Zabbix call. Prevents a hung Zabbix hanging every page |
| `PORT` | `4000` | BFF listen port |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. **On** behind nginx, off otherwise, trusting it with nothing in front lets a client forge its own IP |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-IP request cap. `/api/stream` and `/api/health` are exempt |

### Access control

| Var | Default | Purpose |
|---|---|---|
| `AUTH_ENABLED` | **`true`** | Secure by default. Set `false` only for local dev |
| `JWT_SECRET` | none, required when login is on | Token signing secret. The server **refuses to start** on the placeholder when auth is on |
| `PORTAL_USER` / `PORTAL_PASS` | `admin` / `admin` | Single-user fallback |
| `PORTAL_USERS` | none | `name:password:role` triples, comma-separated. Roles: `viewer`, `operator`, `admin` |

### Grouping and scoring

| Var | Default | Purpose |
|---|---|---|
| `NET_GROUP_IDS` | none | Zabbix host **group ids** holding network devices. Empty = all hosts |
| `SITE_TAG` | `site` | Host tag naming the site: the most explicit signal for the Sites view |
| `SITE_GROUP_PREFIX` | none | Only host groups with this prefix name sites. Empty = use the first group |
| `OWNER_TAG` / `CRITICALITY_TAG` | `owner` / `criticality` | Tags the inventory scorecard looks for |
| `HOST_NAME_PATTERN` | none | Regex a compliant host name must match. Empty = naming not scored |

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
| `ANTHROPIC_API_KEY` | none | The `anthropic` backend. Blank ⇒ `/api/explain/*` returns 503 and the UI hides the buttons. Everything else still works |
| `AI_BASE_URL` | none | The `openai-compatible` backend, e.g. `http://localhost:11434/v1`. Blank ⇒ same 503 rule |
| `AI_API_KEY` | none | Optional, and only for a hosted OpenAI-compatible gateway. A local Ollama wants none |
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
instead of re-reading ~2,400 tokens per question (first word in under a second instead of 6 to 8 s).
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

- [x] **M1 to M8**, BFF, Overview, history graphs, SSE, theme + login, Docker, network views
- [x] **M9**, service-centric views: Sites, Services tree, SLA
- [x] **M10**, reporting: availability, capacity, action aging, alert noise, inventory scorecard
- [x] **M11**, auth + 3-tier RBAC, acknowledge/close write-back
- [x] **M12**, production image built and verified through nginx; test suite
- [ ] **M13**, real HCML devices onboarded in Zabbix → the views populate live
- [ ] **M14**, cross-trigger correlation

---

## Related docs

| Document | What it covers |
|---|---|
| [`docs/index.md`](docs/index.md) | **Start here.** What is documented, and in what order to read it |
| [`docs/getting-started.md`](docs/getting-started.md) | From a fresh clone to a running portal, step by step |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | The API contract: all 41 endpoints, checked against the code |
| [`docs/architecture/adr/`](docs/architecture/adr/) | Why the system is shaped this way: 8 decision records |
| [`setup.md`](setup.md) | How each part works and why, in 29 sections |
| [`docs/schema/`](docs/schema/) | The data model on three pages |
| [`docs/flow/`](docs/flow/) | The same system in motion, on three more pages |
| [`docs/contributing.md`](docs/contributing.md) | The house rules before you change anything |
| [`DESIGN.md`](DESIGN.md) | The design direction: colours, type and mood |
| [`docs/erd/erd.md`](docs/erd/erd.md) | The data model in full |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | This copy's two audits: the web app (FE items) and the documentation (DOC items) |

---

## Known gaps

Kept short and honest; the full list is [`setup.md` §27](setup.md#27-limitations-and-known-gaps).

- **The dataset is frozen** at 17 Sep 2026 16:59:37. Local polling was stopped deliberately: a
  laptop should not poll production equipment. Every figure here is a snapshot of that moment.
- **Security items BE-13 to BE-17 are open** (in `hcml-portal-ollama/AUDIT_REPORT.md`): passwords are compared in plain text, users come from
  environment variables, and `server/.env` still holds the placeholder `JWT_SECRET` the BFF is
  designed to refuse. The Anthropic key flagged on 10 Sep has still not been rotated.
- **Nothing persists.** No audit trail of who acknowledged what, no saved views, no user table, and
  a closed month's SLA is recomputed from scratch after every restart.
- **Every performance figure is single-user and single-shot.** No p95, no concurrency data, and the
  cache hit rate has never been measured.

---

## Glossary

Every abbreviation and technical term used in this file, grouped by topic and sorted A to Z inside
each group. The terms this project uses in its own specific way (site, link, incident, coverage and
others) are defined in more depth in [`setup.md` §28](setup.md#28-glossary).

### Words that mean different things in different places

| Term | What it means |
|---|---|
| **Host** | In Zabbix, one monitored device or server. In the setup instructions, "the host" is the computer the containers run on, which is why `host.docker.internal` exists. `HOST` is also a BFF setting: which network interface it listens on |
| **Model** | Either a language model, the AI that writes plain-language answers (Claude or `qwen3:8b`), or a data model, a diagram of what data exists and how it connects (`docs/schema/`, `erd.md`) |
| **Service** | Three things. Zabbix's own feature for grouping hosts into business services, which is empty at HCML. The portal's **Services** page, which builds that grouping itself. And a Docker Compose service, meaning one of the two containers, `portal-bff` or `portal-web` |
| **Token** | Four things. A **Zabbix API token** is the password-like key the BFF uses to read Zabbix (`ZABBIX_API_TOKEN`), with a second one for the single write (`ZABBIX_WRITE_TOKEN`). A **login token** is the JWT you receive when you sign in. A **model token** is a piece of a word, the unit a language model reads and writes in, so "8,192 tokens" is a length of text. A **design token** is a named colour or size in `styles.css`, checked by `tokens.check.mjs` |

### HCML and the portal

| Term | What it means |
|---|---|
| **API** | Application programming interface: a set of web addresses a program calls to read or change data. Zabbix has one, and the BFF offers its own under `/api/` |
| **Assistant** | The chat page (`/assistant`) where you ask questions about the whole estate in your own words |
| **BE-xx, FE-xx, DOC-xx** | Numbered audit findings. BE items cover the BFF and are in `hcml-portal-ollama/AUDIT_REPORT.md`. FE items cover the web app and DOC items the documentation; both are in `hcml-portal/AUDIT_REPORT.md` |
| **BFF** | Backend-for-frontend: the portal's own server, in `server/`. It is the only part that talks to Zabbix or the model, it holds their credentials, it caches answers, and it computes the derived figures |
| **Derived** | Worked out by the portal from raw Zabbix data, rather than read from a Zabbix table. Sites, links, incidents, host state and the SLA are all derived |
| **Endpoint, route** | One address the BFF answers, such as `GET /api/sites`. There are 41, all listed in `docs/api/openapi.yaml` |
| **Estate** | Everything HCML monitors, taken together: all its hosts, sites and links |
| **Explain** | The button on a problem or an SLA figure that asks the model to describe that one item in plain language. The answer is kept for an hour |
| **FPSO** | Floating Production, Storage and Offloading unit, a ship-based offshore facility. It appears in HCML's own site and host names, such as *FPSO KAS3* |
| **HCML** | Husky-CNOOC Madura Limited, the company whose network and servers this portal monitors |
| **M1 to M14** | Project milestones, listed under [Milestones](#milestones) |
| **NOC wall** | A large screen in a network operations centre that shows the Dashboard all day. The Dashboard is designed to be read from across a room |
| **Roles** | The three levels of access: a **viewer** reads; an **operator** can also acknowledge problems and open the WAN pages; an **admin** can also open the inventory scorecard. See [Signing in](#signing-in) |
| **Site** | One of HCML's 14 locations. Zabbix has no idea of a site, so the portal works out each host's site from its tag, its name, its inventory record or its host group, in that order |
| **SPA** | Single-page application: the web app loads once, then changes page inside the browser without reloading. nginx sends every unknown address back to `index.html` so this works |
| **UI** | User interface: the screens you see in the browser, built from `web/` |
| **Write-back** | The one action that changes Zabbix: acknowledging or closing a problem. It is off unless `ZABBIX_WRITE_TOKEN` is set |

### Zabbix and monitoring

| Term | What it means |
|---|---|
| **Acknowledge, close** | Acknowledging marks a problem as seen and being handled, with an optional message. Closing resolves it by hand. Together these are the portal's only write |
| **Availability** | The share of time a device could be reached |
| **Coverage** | How much of a period Zabbix actually collected data for a device. Below 50% (`SLI_MIN_COVERAGE`) the portal shows *no data* rather than a figure it cannot back up |
| **Event** | A trigger changing state. A PROBLEM event and the OK event that follows it mark the start and end of one outage |
| **Flapping** | A problem that keeps opening and clearing. The Alert noise page counts one as flapping when it clears in under 5 minutes and has fired at least 5 times |
| **Host group** | Zabbix's way of grouping hosts. The portal treats it as the weakest clue to a host's site |
| **ICMP** | The network protocol behind `ping`. Most availability figures here come from whether a device answers ping and how many pings are lost |
| **Incident** | The portal's own term: one problem from start to recovery, cut to the reporting month and merged with any overlapping problem so no outage is counted twice |
| **Item** | One measurement on one host, for example whether it answers ping |
| **Link** | The portal's own term for one WAN path, built from a host's ping, packet-loss and response-time items |
| **Packet loss, latency** | Packet loss is the share of pings that never come back; latency is how long the ones that do come back take. The Links page warns at 2% loss and marks a link critical at 10% |
| **Problem** | An event that has not been resolved yet |
| **Profile** | Which method the SLA page uses: `availability`, the strict one, or `hcml-report`, which reproduces HCML's own published reports |
| **Severity** | How serious Zabbix rates a problem, from 0 (Not classified) through Information, Warning, Average and High, to 5 (Disaster). HCML's estate raises alarms from Warning upward |
| **SLA** | Service level agreement: the level of service that was promised. In this portal it is also the name of the page that compares each device's monthly availability with the target |
| **SLI** | Service level indicator: the measured number itself, meaning the share of the month a device was up. The portal computes it from Zabbix's ping triggers |
| **SLO** | Service level objective: the target the SLI is measured against. 99% by default (`SLO_TARGET`), which is the figure HCML's own reports use |
| **SNMP** | Simple Network Management Protocol, which switches, routers and similar equipment use to report their counters to Zabbix |
| **Tag** | A `name: value` label on a Zabbix host, such as the `site`, `owner` and `criticality` tags the portal looks for |
| **Trigger** | A rule over items that decides when a measurement becomes a problem, for example *High ICMP ping loss* |
| **WAN** | Wide area network: the links that connect HCML's sites to each other and to the outside world. The Links & WAN page shows them |
| **Zabbix** | The open-source monitoring system HCML runs, version 7.0. It collects every measurement; the portal only reads from it, apart from the one write |

### Web, network and security

| Term | What it means |
|---|---|
| **Bearer token** | Sending your JWT in the `Authorization: Bearer …` header of each request, which is how the API knows who you are |
| **CORS** | Cross-origin resource sharing: the browser rule that decides which websites may call the BFF. Exactly one is allowed, set by `WEB_ORIGIN` |
| **CSP** | Content Security Policy: a header that limits what a web page may load. It is off in the BFF because the BFF only returns data; nginx serves the pages |
| **DNS** | Domain Name System: turns a name such as `host.docker.internal` into a network address |
| **`.env` file** | A text file of settings and secrets that the BFF reads when it starts. It is never committed to git. `.env.example` shows the same settings with no real values in them |
| **EventSource** | The browser's built-in way to open an SSE connection. It cannot add a login header, which is why the `?token=` form exists |
| **Gitignored** | Listed in `.gitignore`, so git never records the file |
| **HTTP, HTTPS** | The protocol browsers use to talk to servers. HTTPS is the encrypted form |
| **IP address** | The numeric address of a machine on a network |
| **JSON** | A plain-text format for structured data. Every API call here sends and receives it |
| **JSON-RPC** | The request style Zabbix's API uses, version 2.0: every call is a JSON message that names a method, such as `host.get` |
| **JWT** | JSON Web Token: the signed login token the BFF gives you when you sign in. It is valid for 12 hours |
| **Placeholder** | The dummy value a setting has in `.env.example`. With login turned on, the BFF refuses to start while `JWT_SECRET` is still the placeholder |
| **Rate limit** | A cap on requests per IP address per minute, 300 by default, so one client cannot overload the BFF |
| **RBAC** | Role-based access control: what you can open depends on your role. The BFF enforces it; hiding a menu item in the browser is only a convenience |
| **SSE** | Server-sent events: a connection the browser keeps open so the server can push updates the moment they happen. The Dashboard and the assistant's streamed answers use it |
| **Status codes 403, 503** | Three-digit answers from a server. **403** means you are signed in but your role cannot open this. **503** means the feature is not available right now, for example acknowledging with no write token set, or the model already busy |
| **URL** | A web address |

### The AI layer

| Term | What it means |
|---|---|
| **AI** | Artificial intelligence. Here it means only the optional plain-language features: Explain and the assistant |
| **Anthropic** | The company that runs Claude. `ANTHROPIC_API_KEY` is the key for its service |
| **Claude** | Anthropic's hosted language model, `claude-sonnet-4-6`, used by `hcml-portal`. Anything sent to it leaves the machine |
| **Context window** | How much text a model can read at once, counted in model tokens. The BFF asks Ollama for 8,192 |
| **GPU, CPU, Metal** | The graphics processor and the main processor. Metal is Apple's way of using the Mac's graphics processor. Docker Desktop cannot pass it into a container, so Ollama runs directly on the Mac, where it is much faster |
| **JSON Schema** | A description of the exact shape a JSON answer must have. Both model backends are told to answer in the same shape, so their answers can be compared |
| **Keep-alive** | How long Ollama keeps the model loaded in memory after its last use: 30 minutes by default (`AI_KEEP_ALIVE`) |
| **Language model, LLM** | Large language model: software that reads text and writes text. It is what answers the assistant's questions |
| **Native API** | Ollama's own `/api/chat`. The BFF uses it whenever it detects Ollama, because only that API accepts a context size and keeps the model loaded |
| **Ollama** | A program that downloads language models and runs them on your own computer. It listens on port 11434 |
| **OpenAI-compatible** | An API that accepts the same request format as OpenAI's. Ollama, vLLM and llama.cpp all offer one, so a single BFF client works with any of them |
| **Prompt** | The text sent to the model: the instructions plus the data it should answer from |
| **Prompt cache** | The model server remembers the part of a prompt it has already read, so the next question on the same data is answered faster |
| **`qwen3:8b`** | The model `hcml-portal-ollama` runs through Ollama: Qwen3 with 8 billion parameters, about 5.2 GB on disk. Nothing sent to it leaves the machine |
| **SDK** | Software development kit: a ready-made library for calling one company's API. The Anthropic SDK is the only one used |
| **Snapshot** | The summary of the estate that the assistant answers from: open problems, sites, unreachable hosts and SLA standing. It is reused for up to five minutes |
| **Temperature, top-p** | Settings that control how varied the model's wording is. Lower values give more predictable answers |
| **Warm-up, prefill** | Loading the model before anyone asks (warm-up), and having it read the snapshot ahead of the question (prefill), so the first answer arrives sooner |

### Building and running it

| Term | What it means |
|---|---|
| **Alpine** | A very small Linux system that the Docker images are built on |
| **Barrel import** | Importing a whole library in one line. ECharts is imported piece by piece instead, so the browser does not download chart types nothing uses |
| **Bundle, chunk, lazy-loading** | The browser downloads the app's code as files called chunks. The first bundle is kept small, and each page's code is only fetched when you open that page, which is lazy-loading |
| **Cache, TTL** | A cache keeps a recent answer so the same question is not sent to Zabbix again. TTL, time to live, is how long an answer is kept |
| **CI** | Continuous integration: checks that run automatically on every push. Here they are in `.github/workflows/docs.yml` |
| **CSS, CSS variables** | CSS is the styling language of web pages. CSS variables hold each colour and size in one place, which is what lets light and dark mode share one stylesheet |
| **Dependency** | An outside library the project relies on. There are 21 direct ones, and adding more is avoided on purpose |
| **`diff -r`** | A command that compares two folders file by file. It is how the two copies are proved to share one source tree |
| **Docker, image, container** | Docker packages an app with everything it needs into an image. A running copy of an image is a container. Docker Desktop is the app that runs Docker on a Mac |
| **Docker Compose** | Starts several containers together from `docker-compose.yml`. Here there are two: `portal-bff` and `portal-web` |
| **dotenv** | The library that reads `.env` into the BFF's settings during development |
| **ECharts** | The charting library that draws the graphs |
| **ESM, NodeNext, ES2022** | How the code is written and loaded: modern JavaScript modules (`import` and `export`), Node's rules for finding them, and the language version the code is compiled to |
| **Fastify** | The web-server framework the BFF is built on |
| **gzip, brotli** | Two compression formats that shrink API responses before they are sent |
| **`host.docker.internal`** | A name that, from inside a container, points back to the computer running Docker. The containers use it to reach Zabbix and Ollama |
| **In-flight coalescing** | When several people ask for the same data at the same moment, the BFF sends one request to Zabbix and gives all of them the answer |
| **Inter, IBM Plex Mono** | The two typefaces. Inter is for text; IBM Plex Mono is for host IDs, addresses and figures that are compared down a column |
| **Multi-stage build** | A Docker image built in two steps, so the final image carries the finished app but not the tools used to build it |
| **nginx** | The web server in `portal-web`. It serves the built app and passes `/bff` requests on to the BFF |
| **Node** | The program that runs JavaScript on a server. The BFF runs on Node 20 |
| **npm, lockfile, `npm ci`** | npm installs the libraries a project needs. The lockfile, `package-lock.json`, pins their exact versions, and `npm ci` installs exactly those versions |
| **ORM** | Object-relational mapper: a library for working with a database. The portal has no database, so it has no ORM |
| **p95** | The 95th percentile: the response time that 95 out of 100 requests are faster than |
| **React** | The library the web app's screens are written in |
| **Reverse proxy** | A server that receives requests and forwards them to another server behind it. nginx is the reverse proxy for the BFF |
| **Stale-while-revalidate** | Showing the last answer at once while fetching a fresh one in the background. The portal allows it for some reports and never for problem or acknowledgement state |
| **tsx** | Runs TypeScript files directly. It is used for `npm run dev` and for the check scripts |
| **Typecheck** | Running the TypeScript checker (`npm run typecheck`) to catch mistakes, without building anything |
| **TypeScript** | JavaScript with types that are checked before the code runs. Both `server/` and `web/` are written in it |
| **Vite** | The tool that serves the web app during development and builds it for production |
| **Vitest** | The test runner. `npm test` runs 336 tests with Zabbix faked, so no live system is needed |

### Documents

| Term | What it means |
|---|---|
| **ADR, MADR** | Architecture Decision Record: a short document recording one design decision, the options that were rejected, and the trade-offs. MADR is the template these follow. There are 8, in `docs/architecture/adr/` |
| **CDM, ERD, PDM** | The three views of the data model in `docs/schema/`: the conceptual data model (what the business talks about), the entity-relationship diagram at the logical level (what the portal works with), and the physical data model (what the database actually stores) |
| **`DESIGN.md`** | The design direction: identity, colours, typefaces and mood |
| **OpenAPI** | A standard file format that describes every endpoint of an API. The portal's is `docs/api/openapi.yaml`, and a script checks it against the code |
| **README** | This file: the first document to read in a code repository |
| **`setup.md`** | How each part of the portal works and why, in 29 sections |
