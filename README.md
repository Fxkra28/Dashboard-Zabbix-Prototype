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

New to the abbreviations? The [Glossary](#glossary) at the end explains the ten this file leans on and points to the full lists.

### What it looks like

![The Dashboard: counts for the estate, the live list of open problems and problems by host group](docs/screenshots/dashboard.png)

![Problems: one row per open problem, with host, severity, duration, tags and an Explain button](docs/screenshots/problems.png)

![Sites: one card per site, with its problems by severity and how many devices are down](docs/screenshots/sites.png)

![Graphs: one item over a calendar month, with its minimum, average, maximum and last values and the Show data and Download CSV buttons](docs/screenshots/graphs.png)

Host names, addresses and interface descriptions in these images are stand-ins; the counts,
severities, times and site names are real. The Dashboard's Hosts view, the Devices page,
Show data with its CSV download, the dark theme, the narrow-screen layout and the Network page (all taken from
HCML's own Zabbix on 11 November, with the names replaced) are in
[`docs/screenshots/`](docs/screenshots/README.md), with how the names were replaced.

### How the parts connect

```
 Browser (React)  ──HTTP+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

The first arrow is plain HTTP on this computer's loopback address: nginx listens on port 8080 inside
its container and Docker publishes it on `127.0.0.1` only. Nothing in this repository terminates
TLS, so before the portal is reached from another machine, put TLS in front of it:
[`docs/operations/tls.md`](docs/operations/tls.md).

Read it left to right. Your browser only ever talks to the portal's own server, the BFF. The BFF
holds the Zabbix and model credentials, so the browser never sees them. It asks Zabbix for data in
Zabbix's JSON-RPC format, keeps recent answers for a short time so it does not ask twice, and sends
the result on. The live Dashboard keeps one connection open (SSE) so updates arrive without a reload.

Nine flows are drawn in that same one-line style (a page load, the live Dashboard, the request
pipeline, the cache, sign-in, where a number comes from, both AI paths and the one write) in
[`docs/flow/README.md`](docs/flow/README.md#the-nine-flows-one-line-each).

### Contents

- [What it looks like](#what-it-looks-like): the main pages, as images
- [Tech stack](#tech-stack): what it is built with, and why
- [Layout](#layout): the folders, and where the handbook describes every file
- [Quick start (local dev)](#quick-start-local-dev): run it on your own machine
- [Deploy (Docker, next to Zabbix)](#deploy-docker-next-to-zabbix): run it in containers
- [Usage](#usage): signing in, the 19 pages, and where the rest is described
- [Configuration](#configuration): every setting the BFF reads
- [Testing](#testing)
- [Milestones](#milestones)
- [Related docs](#related-docs)
- [Known gaps](#known-gaps)
- [Glossary](#glossary)

---

## Tech stack

41 direct dependencies in total, 18 in the BFF and 23 in the web app, of which 14 ship: the
rest are build, test and lint tools. The two heaviest categories
of dependency a project like this usually carries are deliberately absent: there is no ORM or
database driver (the portal owns no data: everything comes from Zabbix over the API) and no
component library (the UI is plain CSS, so the app runs with zero extra setup).

### BFF: `server/`

| Piece | Version | What it does here |
|---|---|---|
| Node | 24 LTS (`node:24.22-alpine`, pinned by digest) | Picked for native `fetch` and `AbortSignal.timeout`. The Zabbix client is under 200 lines and the model client about 750, both written straight onto them, so there is no HTTP-client dependency at all |
| TypeScript | ^5.9 | ESM throughout: `"type": "module"`, `NodeNext` resolution, ES2022 target, `strict: true`. Tests live under `src/` (same imports as the code) but are excluded from the shipped `dist/` and typechecked by a second config |
| Fastify | ^5.12 | Plugin-scoped hooks are the reason the RBAC guard is a single `onRequest` at the root rather than a check repeated in every handler. 24 route modules register onto it → 45 endpoints, and `security/auth.ts` and `http/health.ts` add the other six: sign-in, `/api/auth/me`, `/api/auth/refresh`, `/api/auth/logout`, health and ready |
| `@fastify/helmet` | ^13.1 | Security headers. CSP is off: nginx serves the SPA, and Fastify serves data, not pages: JSON, the event streams and the report files, which download as attachments |
| `@fastify/cors` | ^11.4 | Exactly one allowed origin, from `WEB_ORIGIN` |
| `@fastify/jwt` | ^10.2 | Signs the login token (12 hours unless `SESSION_HOURS` says otherwise) and reads it from the session cookie, or from an `Authorization: Bearer` header for scripts. No route takes it in the query string |
| `@fastify/cookie` | ^11.1 | Sets the httpOnly, `SameSite=Strict` session cookie the token travels in, so no script on the page can read it ([ADR-0010](docs/architecture/adr/0010-session-cookie.md)) |
| `@fastify/rate-limit` | ^11.2 | Per-IP cap, with `/api/stream` and `/api/health` exempt, so a NOC wall that polls does not throttle itself, and sign-out, so a spent allowance never leaves the cookie working. The stream is capped instead: `STREAM_MAX_CLIENTS` screens in all and `STREAM_MAX_PER_USER` for one user, past which it answers 429. `POST /api/auth/login` has a tighter limit of its own: 10 attempts a minute, and a lock after 10 failures in a row that grows from 1 to 5 minutes |
| `nodemailer` | ^10.3 | Sends the emailed SLA report through the SMTP server the `MAIL_` settings name, over TLS or STARTTLS. The first library added for a feature, and it has none of its own ([ADR-0014](docs/architecture/adr/0014-email-the-sla-report-through-smtp.md)) |
| `dotenv` | ^16.4 | `.env` in dev. In Docker, Compose passes the environment directly |
| `@anthropic-ai/sdk` | ^0.124 | The `anthropic` backend of the AI layer, and nothing else. The OpenAI-compatible backend is hand-rolled on `fetch`: one response shape to maintain instead of a second SDK to keep current |
| Report writers | not a package | `src/export/` writes the monthly SLA report as a PDF and as an Excel workbook, on request, with Node's built-in `zlib` and `crypto` modules and no PDF or spreadsheet library. ADR-0011 (`docs/architecture/adr/0011-build-the-sla-report-files-in-the-bff.md`) has the trade-off |
| Vitest | ^5.0 | 3097 tests in 122 files. Zabbix is mocked at `src/clients/zabbix.ts` (the single module all API traffic funnels through) so the suite needs no live instance |
| tsx | ^4.16 | `npm run dev` watch mode only. Production runs plain `node dist/index.js` |
| ESLint (with `@eslint/js`, `typescript-eslint` and `globals`) | ^10.13 | Dev only, never shipped. `npm run lint` in `server/`: the recommended rules of ESLint and of typescript-eslint, and no warning allowed. The first run, on 19 October 2026, found 22 findings; the eight `eslint-disable` lines left each say why |

### Web: `web/`

| Piece | Version | What it does here |
|---|---|---|
| React | ^18.3 | The library every screen of the web app is written in |
| Vite | ^8.3 | Dev server proxies `/bff` → `:4000`, so dev and prod hit the same paths. The production build is static files |
| `react-router-dom` | ^7.18 | All 19 pages are `lazy()`. The initial bundle is 222 kB JS + 58 kB CSS (73 kB of the JS gzipped); a page after that costs between 1 and 28 kB, the Dashboard being the largest, and the chart library (612 kB, 206 kB gzipped) loads only with a chart. Raw sizes of the 20 October build |
| ECharts + `echarts-for-react` | ^6.1 / ^3.0 | Registered selectively (line chart, grid, tooltip, legend, data zoom, canvas renderer) instead of the barrel, which pulls in roughly a megabyte of chart types nothing draws. Drawn with the `v5` theme ECharts 6 ships, so the parts the portal does not colour itself look as they did on 5.x. Imported only by `TimeSeriesChart`, so its 612 kB chunk loads on Graphs and Network and nowhere else |
| Custom CSS | not a package | One stylesheet in 20 numbered parts (`web/src/styles/`). HCML blue `#2B5584`, measured from the company logo, with Inter for text and IBM Plex Mono for IDs and figures. Light and dark come from one set of CSS variables, per [`DESIGN.md`](DESIGN.md). `web/scripts/tokens.check.mjs` computes the contrast of every pair in both themes and fails on a raw value used where a token exists |
| Hand-rolled, on purpose | not a package | `shared/hooks/useSSE.ts` over native `EventSource`; `shared/hooks/useAsync.ts` for server state, in place of a query library; `features/assistant/parseMarkdown.ts` in about 150 lines, because the assistant's answers are the only markdown in the app and a full renderer is a large attack surface for a small job |
| Vitest + Testing Library | ^5.0 / ^16.3 | 1844 tests in 119 files, run in jsdom: the sign-in return path, the CSRF header and 401 handling in `api/`, `useAsync`, `useSSE`, `useUrlState`, the wall highlight, the live list, `lib/time`, the report download buttons, the data-age and stale-copy notices, the CSV writer and the Assistant's chat storage. `npm test` in `web/` |
| ESLint | ^9.39 | `npm run lint` in `web/`: typescript-eslint, the two classic react-hooks rules and jsx-a11y's recommended set. On 9 because jsx-a11y does not support ESLint 10 yet |
| `openapi-typescript` | ^7.13 | Dev only, never shipped. `npm run gen:api` in `web/` turns `docs/api/openapi.yaml` into `web/src/generated/openapi.ts`. A test holds the app's hand-written types (`types/`) to those: a response schema that promises less than a page needs, or a kind the page cannot hold, fails `npm run typecheck` and names the place, such as `/api/hosts[].status` |

### Around it

| Piece | Version | What it does here |
|---|---|---|
| Zabbix | 7.0 | The only data source, read over JSON-RPC 2.0, never its database. Two tokens: read everywhere, write only for acknowledge/close |
| Docker Compose | not pinned | Two services, neither of them a datastore: `portal-bff` (Node, with a healthcheck on `/api/health` and `init: true`) and `portal-web` (nginx, which starts once the BFF is healthy). Both images are multi-stage and install with `npm ci` against a committed lockfile, so one commit builds the same twice |
| nginx | alpine | Serves the build and reverse-proxies `/bff`, with buffering off on the live stream and the assistant (SSE never arrives without it) and a 360 s read timeout elsewhere (480 s for explanations and for the monthly SLA and its download, an hour for the two live streams), a resolver so recreating the BFF alone does not leave `/bff` on 502, a one-year immutable cache on `/assets/`, and SPA fallback to `index.html`. It runs as an unprivileged user and listens on 8080 inside the container, with a read-only root filesystem (setup.md, section 23). It also adds security headers to the app's pages and files (the CSP, enforced since 14 October), gzips them, hides its version and writes `token=redacted` in its access log, for pages opened before the session cookie |
| The model | set in `.env` | One switch, `AI_PROVIDER`, over two backends that get the same prompt and the same JSON Schemas. See *Plain-language layer* below |

Deliberately not used: no ORM or database driver (the portal owns no database; the hosted copy keeps one small file of its own, ADR-0015), no state-management
library (server state is two small hooks), no component library, no PDF or spreadsheet library (the
report writers are hand-rolled on `zlib` and `crypto`), and no second HTTP client: the Zabbix client
(under 200 lines) and model client (`ai.ts`, about 750) are both hand-rolled around native `fetch`.

### The two copies of this portal

This copy runs the hosted model: `AI_PROVIDER=anthropic` with `claude-sonnet-4-6`. Its sibling,
`hcml-portal-ollama`, is the *same source code* set to `AI_PROVIDER=openai-compatible` and pointed at
`qwen3:8b` running on the local computer. Everything in the three tables above is identical in both:
`server/src`, `web/src`, `tools/` and both `scripts/` folders match file for file.

Exactly 22 files differ between the two. All of them are settings, or documents written from
each copy's point of view. None of them is code:

- the two `.env` files and the two `.env.example` templates
- `docker-compose.yml` and `docs/api/openapi.yaml`, which name each copy's web port
- `docs/setup/11-running-deploying.md` and `19-authentication-rbac.md`, where three lines name the port and one the session cookie
- `README.md`, `docs/index.md`, and `AUDIT_REPORT.md` (each copy holds a different audit)
- `docs/architecture/adr/0005-*`, the decision record about the AI layer
- `docs/schema/CDM.mmd`, `ERD.mmd` and `PDM.mmd`, their three PDFs, and `docs/schema/README.md`
- `docs/flow/DataFlow.mmd`, its PDF, and `docs/flow/README.md`

The command that proves it, with the exclusions it needs, is in
[`docs/contributing.md`](docs/contributing.md), and `node tools/check/parity.check.mjs` runs the same
comparison with the 18 files that may differ (22 with the four `.env` files) named one by one.

---

## Layout

The code is in `server/` (the BFF) and `web/` (the browser app), each with its own `package.json`, lockfile and
Dockerfile. `tools/` holds the checkers that run against the repository, the writer of the handbook's generated
parts and the tools that read a running portal. `docs/` holds every document, `deploy/` the list of settings and
the rebuild and watcher scripts, and the root holds `docker-compose.yml`, `package.json` (`npm run verify` runs every
check from here), `CHANGELOG.md`, `tracker.md` and `setup.md`.

Every folder and file is described, from the code, in the handover handbook: [the repository
map](docs/handover/1-folders/repository-map.md) says what each one is for, and
[`docs/handover/README.md`](docs/handover/README.md) says where to start reading.

19 pages: Dashboard · Problems · Sites · Hosts · Devices · Graphs · Latest data · Maps · Network ·
Links & WAN health · Services · SLA · Availability & response · Capacity trends · Alert noise ·
Top 100 triggers · Inventory & ownership scorecard · Assistant · Login

---

## Quick start (local dev)

[`docs/getting-started.md`](docs/getting-started.md) takes this step by step, from the Zabbix token to the first
sign-in, and [Run it](docs/handover/4-working/run-it.md) says what a development machine needs. The short form:

### 0. Zabbix prep

Create a read-only role and user in Zabbix, with an API token for it. For acknowledge and close, make a second,
write-capable token, on purpose not the same one, so that no read path can ever write. The smoke test of a token,
and the `--resolve` form of it for HCML's office network, are in [`docs/getting-started.md`](docs/getting-started.md).

### 1. Backend (BFF)

```bash
cd server
cp .env.example .env          # set ZBX_URL + ZABBIX_API_TOKEN; auth needs JWT_SECRET + PORTAL_PASS
npm install
npm run dev                   # http://localhost:4000
npm test                      # 3097 tests, no live Zabbix needed

curl localhost:4000/api/health   # { ok, ts, ai, aiProvider, aiExternal, writeBack, defaults, ready: true|false } and, signed in, version, startedAt, build, streams, ready as an object
```

`/api/health` answers 200 even while Zabbix is down: `ok` means the process is up, and `ready` says whether it can read Zabbix (one `host.get` with a 2 s limit, cached 15 s). An anonymous caller gets `ready` as a plain `true` or `false`, so that a monitor needs no account (IN-47); a signed-in caller gets it as an object (`ready.ok` and, when that is false, `ready.zabbix` with the reason) together with `version`, `startedAt`, `build` and `streams` (every caller when sign-in is off). Outside Docker `build` reads `unknown`, since the commit and time come from Docker build arguments.

### 2. Frontend

```bash
cd web
npm install
npm run dev                   # http://localhost:5173 (proxies /bff → :4000)
```

### 3. Data

Point `ZBX_URL` at a Zabbix that already has hosts. An empty one makes for an empty portal. The demo-estate seed
scripts were removed on 21 September 2026: they wrote to whatever `ZBX_URL` pointed at, and their host names copied
HCML's real naming convention, so a collision would have hit a real host. An earlier note said they were recoverable
from commit `b4a4059`; they are not (checked on 21 September). A genuinely empty dev Zabbix would need them written
again.

---

## Deploy (Docker, next to Zabbix)

```bash
cp .env.example .env && chmod 600 .env   # ZBX_URL, ZABBIX_API_TOKEN, a real JWT_SECRET and PORTAL_PASS
docker compose up -d --build
# http://localhost:8081
```

`JWT_SECRET` and `PORTAL_PASS` have no default: Compose refuses to start without `JWT_SECRET`, and the BFF refuses to
start on a published or short secret or an empty or `admin` password. The rules are under
[Access control](#access-control). To have `/api/health` show which build is running, build with `BUILD_COMMIT` and
`BUILD_TIME` as Docker build arguments; they read `unknown` when left out.
`deploy/rebuild.sh` does the whole rebuild: the rollback tags, those arguments, the wait for both containers of each copy to be
healthy, the checks an anonymous caller can make, and the tag that says what is live. `--dry-run` shows what it would do,
and before it tags anything it checks that Docker can read each copy's `.env`. `deploy/watch.sh --install` makes this Mac
check both portals every minute and show a notification when one stops answering, comes back, or has a container that
restarts in a loop; on a server, run `--once` from a timer.
[Deploy, rebuild and roll back](docs/handover/4-working/deploy-rebuild-rollback.md) has the steps, and
[Operations](docs/handover/3-integrations/operations.md) says what the containers do on a stop.

Reaching Zabbix. The portals read HCML's Zabbix: `ZBX_URL` defaults to
`https://zabbix.hcml.co.id/zabbix/api_jsonrpc.php`. From HCML's office network that name leads to a
Zero Trust gateway that refuses the portal, so `docker-compose.override.yml`, which stays on the
machine and out of git, maps the name to Zabbix's LAN address; the certificate is still checked
against the name. HCML's Zabbix takes 20 to 100 s on most pages and 256 s on the Capacity report, so
one read may take 300 s (`ZABBIX_TIMEOUT_MS`) and a page 330 s. The steps are in
[docs/operations/after-a-restart.md](docs/operations/after-a-restart.md).

---

## Usage

Everything above gets the portal running. This section is what it is *for*. The handbook's part for everyone explains
every page in plain words, with screenshots: [The pages](docs/handover/0-everyone/the-pages.md). The step-by-step first
run (Zabbix token, smoke test, first login) is in [`docs/getting-started.md`](docs/getting-started.md).

### Signing in

There is no user table. Users come from the environment: `PORTAL_USERS` as comma-separated
`name:password:role` triples, or `PORTAL_USER`/`PORTAL_PASS` as the single-admin shorthand. A
successful login gives the browser a JWT valid for 12 hours by default (`SESSION_HOURS`), in a cookie named `hcml_session` (`SESSION_COOKIE`). The
cookie is httpOnly, so no script on the page can read it, and `SameSite=Strict`, so other sites cannot make the browser
send it. An open portal renews its own token an hour before it runs out, so a wall screen stays signed in, and every
request looks the user up again, so removing a user or changing a role takes effect at once.
[Sign-in](docs/handover/3-integrations/sign-in.md) follows one sign-in from end to end, and
[ADR-0010](docs/architecture/adr/0010-session-cookie.md) and
[ADR-0009](docs/architecture/adr/0009-renew-an-open-portals-sign-in.md) have the trade-offs.

Cookies ignore ports, so the two portals on one machine need different cookie names, or signing in
to one signs you out of the other. `docker-compose.yml` passes `SESSION_COOKIE`, and hcml-portal-ollama
defaults it to `hcml_session_ollama`.

With `AUTH_ENABLED=false`, an opt-in for local work (the default is `true`), there is no login at
all and every caller is treated as `admin`.

Four roles, and the BFF is what enforces them:

| Role | Can reach |
|---|---|
| `viewer` | Everything not listed below. Unmatched routes require viewer, so a new route is protected by default |
| `wall` | …plus `/api/links` and `/api/net/*`, to read only: the account of a NOC wall screen, which shows the internet traffic meters and never acknowledges |
| `operator` | …plus the acknowledge write |
| `admin` | …plus `/api/reports/inventory`, emailing the SLA report (`/api/sli/email`) and the monthly send (`/api/sli/schedule`) |

The sidebar hides what your role cannot reach, but that is cosmetic: the guard is server-side and
returns 403 whatever the browser shows. The rules are `ROUTE_RULES` in `server/src/security/auth.ts`, and
[`docs/setup/19-authentication-rbac.md`](docs/setup/19-authentication-rbac.md) explains them.

### The 19 pages

Grouped by the question each one answers, not by the order they appear in the sidebar.

| Page | Route | What it answers |
|---|---|---|
| Dashboard | `/` | Is anything wrong right now? It holds the live stream (the Problems page opens one too, as a signal to read its list again). Everyone gets a second view, the Hosts: how many hosts are up, degraded, down or without data, the devices of each kind, the web scenarios that pass or fail, and the ten busiest hosts by CPU and by memory. Wall screens, operators and admins get a third, the internet traffic meters: a gauge for each link, read from HCML's Zabbix dashboard, with a link that is down said to be down, the other direction shown when it is high, and a card for the links on the first view. A wall screen turns between the views by itself (`/?wall=1`, `rotate=` for the seconds, `view=` to hold one) |
| Problems · Alert noise · Top 100 triggers | `/problems` · `/reports/noise` · `/reports/top-triggers` | What is firing, and what fires so often that nobody reads it any more |
| Sites · Hosts · Devices · Latest data · Graphs · Maps | `/sites` · `/hosts` · `/devices` · `/latest` · `/graphs` · `/maps` | Where a device is, what kind it is, what it is reporting, and what it looked like an hour ago. Graphs can show the points of a chart as a table (Show data) and download them as a CSV file |
| Network · Links & WAN health | `/network` · `/links` | Wall role and above (wall screens, operators and admins). The WAN view: which links are up, and what they cost in latency and loss |
| Services · SLA · Availability & response | `/services` · `/sla` · `/reports/availability` | The monthly figure. Derived in the portal, validated against HCML's own published reports, and downloadable as a PDF or an Excel file |
| Capacity trends | `/reports/capacity` | What is filling up, and roughly when it runs out |
| Inventory & ownership scorecard | `/reports/inventory` | Admin role. How complete the inventory data actually is |
| Assistant | `/assistant` | Plain-language questions over the estate |
| Login | `/login` | Only reachable when `AUTH_ENABLED=true` |

Sites, links, incidents, host availability and the SLA are the portal's own work: Zabbix has no
table for any of them. That is the whole reason the portal exists
([ADR-0001](docs/architecture/adr/0001-bff-over-zabbix-api.md)).

### Where the rest is described

| Topic | Where |
|---|---|
| When a page's data is old: the "Zabbix has collected nothing" notice, the stale-copy notice, and the `X-Data-Stale` and `X-Data-Refreshing` headers behind them | [Can I trust what it shows?](docs/handover/0-everyone/can-i-trust-it.md) and [`docs/setup/26-reachability-caching-and-operations.md`](docs/setup/26-reachability-caching-and-operations.md) |
| The SLA report as a PDF, an Excel file or a zip of CSV files, built by the BFF on request from `GET /api/sli/export`, emailed to people an administrator chooses through `POST /api/sli/email`, and sent by itself each month through `PUT /api/sli/schedule` | [`docs/setup/18-automated-reporting.md`](docs/setup/18-automated-reporting.md), [ADR-0011](docs/architecture/adr/0011-build-the-sla-report-files-in-the-bff.md) and [Reports and exports](docs/handover/3-integrations/reports-exports.md) |
| Calling the API from a script: sign in, take the JWT from the `Set-Cookie` header, send it as a bearer token | [`docs/api/README.md`](docs/api/README.md) and [`docs/getting-started.md`](docs/getting-started.md). The contract is [`docs/api/openapi.yaml`](docs/api/openapi.yaml): 51 endpoints, checked against the code |
| The assistant: Explain, and the chat page | [The plain-language layer](#plain-language-layer-optional) below, and [`docs/flow/README.md`](docs/flow/README.md), which itemises what crosses on each path |

In this copy the model is hosted Claude over the Anthropic API, so what is sent (host names, trigger names,
problem text) **leaves this machine**. The sibling repo `hcml-portal-ollama` is the same code pointed at a local
`qwen3:8b`, where it does not. Which one answers is one line of `.env`
([ADR-0005](docs/architecture/adr/0005-provider-neutral-ai-layer.md)).

---

## Configuration

All of these are read by the BFF. `.env.example` is committed and must never contain a real
credential; `.env` and `server/.env` are gitignored.

Those two files hold the portal's secrets and settings: the users, the tokens and `JWT_SECRET` are in them, and
nothing else holds a copy. The hosted copy also keeps one small state file on the Docker volume `portal-state` (the backup page named below covers it). Keep an encrypted copy of each, off this computer, and see
[`docs/operations/backup-and-restore.md`](docs/operations/backup-and-restore.md) for the restore
checklist. [`deploy/settings.example`](deploy/settings.example) lists every non-secret setting with
its default, versioned.

### Connection

| Var | Default | Purpose |
|---|---|---|
| `ZBX_URL` | `https://zabbix.hcml.co.id/zabbix/api_jsonrpc.php` in Docker, `http://localhost:8080/api_jsonrpc.php` in a bare run | Zabbix API endpoint |
| `ZABBIX_API_TOKEN` | none, required | Read-only token. `ZBX_TOKEN` is a deprecated alias that warns at startup |
| `ZABBIX_WRITE_TOKEN` | none | Separate write token for acknowledge/close. Blank ⇒ portal is strictly read-only and those routes return 503 |
| `ZABBIX_TIMEOUT_MS` | `300000` in Docker, `10000` in a bare run | Ceiling on one Zabbix call. Prevents a hung Zabbix hanging every page; several of HCML's item searches at once took up to 256 s. A whole number of milliseconds from 1000 to 2147483647: the server refuses to start on any other value, 0 and `30s` included |
| `ZBX_TLS_PIN_SHA256` / `ZBX_TLS_PIN_UNTIL` | none | Only while Zabbix's certificate has expired: that one certificate is accepted until the end of the given day, WIB. Both are needed, and the BFF warns at every start while they are set. See `docs/operations/tls.md` |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | BFF listen port and interface. `server/.env.example` sets `127.0.0.1` for dev; Docker needs the default |
| `WEB_ORIGIN` | `http://localhost:5173` | The one origin CORS allows, with credentials |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For`. `true` trusts one proxy hop (the nginx in front), a positive integer N trusts N hops, anything else none. On behind nginx, off otherwise, trusting it with nothing in front lets a client forge its own IP |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-IP request cap. `/api/stream`, `/api/health` and `POST /api/auth/logout` are exempt, and the stream is capped by the two settings below |
| `STREAM_MAX_CLIENTS` | `100` | Live screens (`/api/stream`) allowed at once. One more gets `429 too_many_streams` and quietly falls back to polling |
| `STREAM_MAX_PER_USER` | `5` | Live screens for one signed-in user, or for one client address when auth is off. A NOC wall of more than five screens on one shared login needs this raised |

### Access control

| Var | Default | Purpose |
|---|---|---|
| `AUTH_ENABLED` | `true` | Secure by default: unset or empty is on, `true`, `1` and `yes` are on, `false`, `0` and `no` are off, and anything else stops the server at start. Set it off only for local dev: the server then answers only to a localhost `Host`, and refuses write-back unless `ALLOW_WRITE_WITHOUT_AUTH=true` |
| `JWT_SECRET` | none, required when login is on | Token signing secret. With auth on, the server refuses to start on either value published in this repo or one shorter than 32 bytes |
| `PORTAL_USER` / `PORTAL_PASS` | `admin` / none | Single-user fallback. With auth on, the server refuses to start while any user's password, here or in `PORTAL_USERS`, is empty or `admin` |
| `PORTAL_USERS` | none | `name:password:role` triples, comma-separated. Roles: `viewer`, `wall`, `operator`, `admin`. A password is plain text or an scrypt hash (`scrypt.N.r.p.salt.hash`, made with `server/scripts/hash-password.ts`) and may contain `:`. Names ignore case |
| `ALLOW_WRITE_WITHOUT_AUTH` | none | Dev only. With `AUTH_ENABLED=false` acknowledge and close are refused unless this is `true`. Not passed to the containers |
| `ALLOW_EMAIL_WITHOUT_AUTH` | none | Dev only. With `AUTH_ENABLED=false` report email, the monthly schedule and the saved list of recipients are refused unless this is `true`, since every caller would count as an administrator and could send the report to any address. Not passed to the containers |
| `SESSION_HOURS` | `12` | How long one sign-in lasts, a number from 2 to 24. An open portal renews its token an hour before the end, so this limits how long a forgotten session works, not how long a wall screen stays signed in. Signing out ends the whole chain of renewals of that sign-in and closes its live streams. A copy that someone keeps renewing after the owner only closed the tab, without signing out, works until the user is removed from `PORTAL_USERS`, `SESSION_EPOCH` is raised or `JWT_SECRET` is changed. The server refuses to start on a value outside that range or one that is not a number |
| `SESSION_EPOCH` | `1` | A label of 1 to 32 letters, digits, `.`, `_` or `-`, stamped into every token. A token is refused under any other label, so raising it and recreating the BFF's container (`docker compose up -d`; a plain restart keeps the old settings) signs everyone out without a new `JWT_SECRET`. The server refuses to start on a label outside that pattern |
| `SESSION_COOKIE` | `hcml_session` | Name of the httpOnly cookie that holds the sign-in token. Cookies ignore ports, so two portals on one host need different names: hcml-portal-ollama's compose sets `hcml_session_ollama`. The server refuses to start on a name a cookie cannot carry |

### Grouping and scoring

| Var | Default | Purpose |
|---|---|---|
| `NET_GROUP_IDS` | none | Zabbix host group ids holding network devices. Empty = all hosts |
| `SITE_TAG` | `site` | Host tag naming the site: the most explicit signal for the Sites view |
| `SITE_GROUP_PREFIX` | none | Only host groups with this prefix name sites. Empty = use the first group |
| `OWNER_TAG` / `CRITICALITY_TAG` | `owner` / `criticality` | Tags the inventory scorecard looks for |
| `HOST_NAME_PATTERN` | none | Regex a compliant host name must match. Empty = naming not scored |

### Report thresholds

| Var | Default | Purpose |
|---|---|---|
| `AVAILABILITY_MIN_SEVERITY` | `2` | Severity floor for the availability report. 2, not 3: HCML's estate alarms at Warning, and a floor of 3 makes the page open empty |
| `LINK_LOSS_WARN` / `LINK_LOSS_CRIT` | `2` / `10` | Packet-loss thresholds, percent |
| `INTERNET_METERS_DASHBOARD` | `Global view` | The Zabbix dashboard whose gauge widgets are the internet traffic meters on the Dashboard. Each gauge names a link and gives its capacity and colour zones |
| `NOISE_SHORT_SECONDS` | `300` | Below this, a cleared incident counts as flapping |
| `NOISE_MIN_COUNT` | `5` | Firings before "flapping" means anything |

### Derived SLA

HCML's Zabbix has no services, so the SLA and Services pages measure availability in the portal
from the ICMP triggers every device already carries. See setup.md, *Derived SLA and services*.

| Var | Default | Purpose |
|---|---|---|
| `SLO_TARGET` | `99` | Availability target, percent, from 0 to 100: every row of HCML's reports uses 99. A value outside that range, or one that is not a number, stops the server at start |
| `SLA_TIMEZONE` | `Asia/Jakarta` | Calendar months are cut at midnight in this zone, and every clock the pages print is this zone's. A name the runtime does not know, such as `Asia/Jakata`, stops the server at the start |
| `SLI_PROFILE` | `availability` | Default method: `availability` (strict, unreachable or high loss is down, hours with no data left out) or `hcml-report` (reproduces HCML's published reports) |
| `SLI_REPORT_TRIGGERS` | `High ICMP ping loss` | Trigger names behind HCML's published figures |
| `SLI_AVAILABILITY_TRIGGERS` | `Unavailable by ICMP ping,High ICMP ping loss` | Trigger names that mean "down" for the strict method |
| `SLI_MIN_COVERAGE` | `0.5` | Below this share of collected time a device shows "no data". A number from 0 to 1; a value outside that range, or one that is not a number, stops the server at start |
| `SLI_ZBX_PARALLEL` | `4` | Concurrent Zabbix calls while computing one report |
| `SLA_NO_DATA_WINDOWS` | empty | Spans the SLA figures treat as hours with no data, such as a time Zabbix was cut off from the network. Each is start/end in ISO time with its zone, comma-separated, for example `2026-10-26T16:10+07:00/2026-10-26T21:03+07:00`. Nothing in Zabbix changes |

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
| `AI_TIMEOUT_MS` | `30000` / `120000` | Per backend. The SDK's 10-minute default is far too long for a request a human is waiting on; a local model generates more slowly and loads from disk when cold, so it gets more headroom. A whole number of milliseconds from 1000 to 2147483647 when set; the server refuses to start on any other value |
| `AI_MAX_RETRIES` | `1` | Anthropic only: the SDK implements it. The local backend does not retry |
| `AI_CHAT_PER_MINUTE` / `AI_EXPLAIN_PER_MINUTE` | `10` / `10` | Assistant questions and explanations a minute for each signed-in user (or client address with sign-in off). Over it is `429 rate_limited` |
| `AI_MAX_CONCURRENT` | `4` | Hosted calls in flight at once. A local model takes one at a time |
| `AI_DAILY_TOKENS_PER_USER` / `AI_DAILY_TOKENS_TOTAL` | `500000` / `2000000` | Daily token budget for the hosted API only, reset at midnight in `SLA_TIMEZONE`. Used up is `429 ai_budget`. `0` switches a budget off |
| `AI_KEEP_ALIVE` | `30m` | Local model only: how long Ollama keeps it loaded after its last use (~5 GB for `qwen3:8b`) |
| `AI_OLLAMA_NATIVE` | `auto` | `auto` asks `AI_BASE_URL` without `/v1` for `/api/version` and, if Ollama answers, uses its native `/api/chat` for chat, explain, warm-up and prefill: the only API that takes a context size and honours `AI_KEEP_ALIVE` (each `/v1` call resets the expiry to 5 min). `true` / `false` skip the check; any other server keeps `/v1` |
| `AI_NUM_CTX` | `8192` | Native Ollama only. Context window in tokens, sent with every request: Ollama restarts the model, and drops its prompt cache, whenever a request asks for a different size. The cache for 8192 tokens takes ~0.6 GB, twice that of Ollama's default of 4096 |
| `AI_TEMPERATURE` | `0.7` | Native Ollama only. Sampling temperature, stated explicitly, since `/v1` sampled at 1.0. 0.7 / 0.8 is Qwen3's recommendation for answers without thinking |
| `AI_TOP_P` | `0.8` | Native Ollama only. Nucleus sampling, as above |
| `MAIL_PROVIDER` | none | Emailing the SLA report, off while this is blank: `gmail`, `yahoo`, `zoho`, `icloud`, or `smtp` for a server of your own. See [`docs/setup/18-automated-reporting.md`](docs/setup/18-automated-reporting.md) |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_SECURITY` | none | Only for `smtp`, or to name another server for a provider. Security is `tls` (port 465), `starttls` (587) or `none`; blank follows the port. `none` is refused alongside a password |
| `MAIL_USER` / `MAIL_PASS` | none | The login. An app password for Gmail, Yahoo, Zoho and iCloud, never the usual one. A secret: it belongs in `.env` |
| `MAIL_FROM_NAME` | `HCML Monitoring Portal` | The name shown beside the sender's address, up to 64 characters, with no `<`, `>`, `"`, `\` or `@` and no invisible character. A name of your own, such as the one people know the reports by, helps a mail program place the message; the sending account stays your choice |
| `MAIL_FROM` / `MAIL_TO` | none | The sender (blank means `MAIL_USER`) and the list the portal starts with, at most 10 addresses separated by commas. It may be blank: the people who get a report are chosen in the portal by an administrator, and once the portal has a saved list, that one is used |
| `MAIL_ALLOWED_DOMAINS` | none | The only domains a report may go to, such as `hcml.co.id`, at most 20. Blank means any address, and the start-up log warns of it. Set it: it keeps a stolen administrator sign-in from sending the report anywhere |
| `MAIL_SCHEDULE` | on | `off` keeps the monthly send from running on this machine (the one for a second copy that must not send) |
| `PORTAL_STATE_DIR` | none | The folder for the portal's small file of its own: the saved recipients, the monthly schedule and a record of the last 24 sends ([ADR-0015](docs/architecture/adr/0015-keep-a-small-state-file-for-recipients-and-the-schedule.md)). The compose file sets it to `/data`, the volume `portal-state`. Blank: nothing is kept across a restart and the schedule cannot be used |

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
reach it at `http://host.docker.internal:11434/v1`, the name of the computer the containers run on.

#### The assistant

The Assistant page in the sidebar (`/assistant`) answers free-form questions: *"what needs
attention right now?"*, *"are we meeting the SLA?"*, from a read-only snapshot of the estate:
open problems, sites, unreachable hosts, SLA standing and degraded services, all from the same
caches the pages already use. The model has no tools and can neither query nor change Zabbix; the
worst it can do is be wrong, and the page says so. Answers stream in as they are generated
(`POST /api/chat`, server-sent events). Same `AI_PROVIDER` switch, same backends, `viewer` role.

The snapshot is reused for up to five minutes so the model can answer from its prompt cache
instead of re-reading ~2,400 tokens per question (first word in under a second instead of 6 to 8 s).
It is rebuilt at once when a problem opens, closes, is acknowledged or re-graded, and when a host's
state change has held for a minute (links that flap every few seconds do not force a rebuild).
Opening the Assistant page pre-reads the current snapshot. Questions naming a site get a short
per-host focus block after it, and questions naming a host get its open problems and their count.
Hosted Claude takes `AI_MAX_CONCURRENT` (4) requests at once and a local model takes one; a request
that waits more than 20 s gets `503 ai_busy` with `Retry-After`.

The limit is the model's context window. Against Ollama the BFF asks for `AI_NUM_CTX` (8 192
tokens) on every request, so nothing needs setting in Ollama's own environment; through `/v1`
(`AI_OLLAMA_NATIVE=false`, or another server) the server's default applies: 4 096 tokens for
Ollama. Either way the snapshot is capped (20 problems, a budget per section) and the page shows
*partial view* when a list was cut.

---

## Testing

```bash
cd server
npm test          # 3097 tests
npm run lint      # eslint
npm run typecheck # app and tests

cd ../web
npm test          # 1844 tests, in jsdom
npm run lint      # eslint
npm run typecheck # app and tests
```

`npm run verify` at the repository root runs all of this, then the builds and the checkers. CI runs the same steps and three more that `verify` does not: the dependency audit, the secret scan and the two image builds.

Zabbix is mocked at `src/clients/zabbix.ts` (the single point all API traffic funnels through) so the
suite needs no live instance and runs in CI. Coverage is weighted toward the code that would produce
*confidently wrong numbers* rather than visible errors: interval merging in the availability report,
the RBAC route table, cache coalescing, and the naming-convention regex. The report files get the
same care: the tests read each PDF and workbook back, and fail when a colour, the logo or a sentence
copied from the web app drifts from its original.

---

## Milestones

- [x] M1 to M8: BFF, Overview, history graphs, SSE, theme + login, Docker, network views
- [x] M9: service-centric views (Sites, Services tree, SLA)
- [x] M10: reporting (availability, capacity, action aging, alert noise, inventory scorecard)
- [x] M11: auth + role-based access (four roles since 29 October), acknowledge/close write-back
- [x] M12: production image built and verified through nginx; test suite
- [x] M13: real HCML devices onboarded in Zabbix → the views populate live (since 29 October 2026 both portals read HCML's Zabbix)
- [ ] M14: cross-trigger correlation

---

## Related docs

| Document | What it covers |
|---|---|
| [`docs/index.md`](docs/index.md) | Start here. What is documented, and in what order to read it |
| [`docs/getting-started.md`](docs/getting-started.md) | From a fresh clone to a running portal, step by step |
| [`docs/handover/README.md`](docs/handover/README.md) | The handover handbook: the folders, the code function by function, the integrations, and a part for people who do not read code |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | The API contract: all 51 endpoints, checked against the code |
| [`docs/architecture/adr/`](docs/architecture/adr/) | Why the system is shaped this way: 15 decision records |
| [`setup.md`](setup.md) | How each part works and why, in 40 parts (the index of `docs/setup/`) |
| [`docs/schema/`](docs/schema/) | The data model on three pages |
| [`docs/flow/`](docs/flow/) | The same system in motion, on three more pages |
| [`docs/contributing.md`](docs/contributing.md) | The house rules before you change anything |
| [`DESIGN.md`](DESIGN.md) | The design direction: colours, type and mood |
| [`docs/erd/erd.md`](docs/erd/erd.md) | The data model in full |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | This copy's two audits: the web app (FE items) and the documentation (DOC items) |

---

## Known gaps

Kept short and honest; the full list is [`docs/setup/27-limitations-and-known-gaps.md`](docs/setup/27-limitations-and-known-gaps.md).

- Since 29 October 2026 both portals read HCML's own Zabbix, so the figures are current. Before that they read a copy
  restored on a laptop and frozen at 17 Sep 2026 16:59:37, because a laptop should not poll production equipment
  ([ADR-0008](docs/architecture/adr/0008-stop-local-polling.md)). HCML's Zabbix answers its biggest reads slowly, so the
  first visit to a page after a restart can take a minute or more: [what waits](docs/operations/after-a-restart.md).
- Security: a password in `.env` can still be plain text (an scrypt hash is accepted since 7 October 2026), and users come from
  environment variables. One thing is still the owner's to change: the Anthropic key flagged on 10 Sep. The key the running hosted
  portal holds was refused by Anthropic on 16 Oct, so Explain and the Assistant of that portal answer nothing
  until a valid one is in `.env`. The dev `server/.env` files hold a secret of their own since 13 October 2026. The audit items BE-12 to
  BE-17 are closed. Both Zabbix tokens belong to a Super admin user (SC-23, checked 13 October), so "the read
  token cannot write" holds for the portal's code and not yet for the credential.
- Almost nothing persists. The portal keeps no audit trail of its own (who acknowledged what is in the text
  Zabbix stores, `[portal:<user>]`, and in the BFF's log, which also has a line for each use of the AI, `ai_call`, each report
  downloaded, `report_download`, and each report emailed, `report_email`, naming the person and never the question, the answer, the addresses or the file; `deploy/rebuild.sh` saves a
  compressed copy of the logs before it replaces the containers), no saved views, no user table, and
  a closed month's SLA is recomputed from scratch after every restart. The one exception is the hosted copy's small state file on the
  Docker volume `portal-state`: the saved report recipients, the monthly schedule and a record of the last 24 sends (ADR-0015).
- The SLA report files are new. The August workbook was opened in Microsoft Excel on 26 October 2026 with no repair
  prompt, and its render was read page by page; what Excel shows for a download from the live portal itself has
  not been seen. Both files were also downloaded from the running portal, on 12 and 15 October and (October's
  workbook) on 27 October, where only their size and shape were looked at. The PDF prints text outside Western
  European letters, Cyrillic or Chinese for example, as `?`. The report also comes as a zip of CSV files, and
  an administrator can email it or set a monthly send. The email was tried against a small stand-in mail server first. On 9 November 2026 it went through a real Gmail account twice, and both messages reached the recipient's spam folder (tracker IN-62). No monthly send has run on a real first of the month yet (tracker IN-61).
- Every performance figure is single-user and single-shot. No p95, no concurrency data, and the
  cache hit rate has never been measured.

---

## Glossary

The full lists are in the handover handbook: [`glossary.md`](docs/handover/5-reference/glossary.md) for developers and
operators, and [`faq-glossary.md`](docs/handover/0-everyone/faq-glossary.md) in plain words for people who do not read
code. The terms this project uses in its own specific way (site, link, incident, coverage and others) are defined in
[`docs/setup/28-glossary.md`](docs/setup/28-glossary.md). The ten this file leans on most:

| Term | What it means |
|---|---|
| BFF | Backend-for-frontend: the portal's own server, in `server/`. It is the only part that talks to Zabbix or the model, it holds their credentials, it caches answers, and it computes the derived figures |
| Zabbix | The open-source monitoring system HCML runs, version 7.0. It collects every measurement; the portal only reads from it, apart from the one write |
| ICMP | The network protocol behind `ping`. Most availability figures here come from whether a device answers ping and how many pings are lost |
| SLA, SLI, SLO | Service level agreement, the level of service that was promised (here also the name of the page that compares each device's monthly availability with the target). The indicator is the measured share of the month a device was up. The objective is the target, 99% by default (`SLO_TARGET`) |
| SSE | Server-sent events: a connection the browser keeps open so the server can push updates the moment they happen. The Dashboard and the assistant's streamed answers use it |
| JWT | JSON Web Token: the signed login token the BFF gives you when you sign in, in the session cookie. It is valid for 12 hours unless `SESSION_HOURS` says otherwise, and an open portal renews it before then |
| Token | Four things. A Zabbix API token is the password-like key the BFF uses to read Zabbix (`ZABBIX_API_TOKEN`), with a second one for the single write (`ZABBIX_WRITE_TOKEN`). A login token is the JWT in your session cookie. A model token is a piece of a word, the unit a language model reads and writes in. A design token is a named colour or size in `web/src/styles/01-tokens.css` |
| RBAC | Role-based access control: what you can open depends on your role. The BFF enforces it; hiding a menu item in the browser is only a convenience |
| Write-back | The one action that changes Zabbix: acknowledging or closing a problem. It is off unless `ZABBIX_WRITE_TOKEN` is set |
| Model | Either a language model, the AI that writes plain-language answers (Claude or `qwen3:8b`), or a data model, a diagram of what data exists and how it connects (`docs/schema/`, `erd.md`) |
