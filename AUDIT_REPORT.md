# Audit report: `hcml-portal` (web front end)

| | |
|---|---|
| **Date** | 2026-09-15 |
| **Scope** | `web/` (pages, components, hooks, the API client) and its integration with the BFF it talks to |
| **Counterpart report** | [`../hcml-portal-ollama/AUDIT_REPORT.md`](../hcml-portal-ollama/AUDIT_REPORT.md) covers the BFF, the database and the model integration |
| **Data behind it** | Zabbix 7.0.30 on MySQL, restored from HCML's production backup (139 monitored hosts, ~660 open problems) |

> **Since 2026-09-18** the two repos hold the same source tree, so every finding in this report and in
> its counterpart applies to **both** portals. Only `.env` and the published port differ.

> **A correction to the brief.** This repository is not front-end-only, and `hcml-portal-ollama` is not
> a back-end-only service. Each repo contains a full `web/` + `server/` pair, and at runtime each web
> app talks only to its own BFF. `hcml-portal-ollama` is a copy of this repo with a second AI provider
> and an Assistant page added. This report takes the front-end half as requested; the two BFFs share
> almost all their code, so the fixes applied to the Ollama variant's BFF were applied here too.

## How this was audited

Every finding below was reproduced against the running stack before it was fixed, and re-checked
after. Nothing is taken from reading code alone.

| Method | What it covered |
|---|---|
| Headless Chrome crawl (Puppeteer) of all 17 crawled routes (18 pages; /login is crawled separately) | Console errors and warnings, failed and non-2xx requests, page state. Run against dev (`:5173`, auth off) and Docker (`:8081`, signed in) |
| Live API probes | Every endpoint the client calls, plus malformed input |
| End-to-end flow traces | Sign-in → role → data; acknowledge; live stream; explain; assistant |
| Static checks | `tsc --noEmit`, `npm run build`, `npm audit` |
| Source review | Every page, component and hook, for dead handlers, missing states and client validation |

## Result at a glance

| Check | Before | After |
|---|---|---|
| Console errors + warnings across 18 pages (dev) | **40** | **0** |
| Console errors + warnings across 18 pages (Docker, signed in) | **2** | **0** |
| Failed requests during a full crawl | 1 per Graphs visit (`/api/items` → 500) | 0 |
| Buttons with a dead or missing handler | 0 of 9 flagged, all verified wired | 0 |
| Pages without a loading/error/empty state | 0 of 17 | 0 |
| `tsc` / `vite build` | pass | pass (181.17 kB main chunk) |
| BFF tests (shared with this repo's `server/`) | 94 | **98** |

---

## 1. Overview

The portal is a read-only view of Zabbix for HCML's NOC and managers: problems, sites, hosts, graphs,
maps, network and link health, services, SLAs, and six reports. It has exactly one write:
acknowledge/close a problem.

The browser never talks to Zabbix. Every request goes to `/bff/…` on the page's own origin and is
proxied to the BFF, which holds the Zabbix tokens. The dev server and nginx both do that proxying, so
the front end has no API base URL of its own and no CORS to negotiate.

## 2. Frontend architecture

| Layer | Implementation |
|---|---|
| Framework | React 18.3, TypeScript 5.5 |
| Build / dev server | Vite 5.4 (`web/vite.config.ts`) |
| Routing | React Router 6.30.6. All 18 pages are lazy-loaded (`web/src/App.tsx`) |
| Charts | ECharts 5, tree-shaken to a line chart (`web/src/components/TimeSeriesChart.tsx`) |
| Data fetching | `useAsync` (loading, error, polling) and `useSSE` (EventSource), in `web/src/hooks/` |
| Capability gating | `useCapabilities` hides Explain and Acknowledge when `/api/health` says they are off |
| Auth state | JWT in `localStorage` under `hcml_token` (`web/src/api.ts` (`TOKEN_KEY`)), role from `/api/auth/me` (`useAuth`) |
| Error display | `<Async>` renders loading, error and empty around every data block (`web/src/components/states.tsx`) |
| Production serving | nginx: the SPA plus a `/bff/` reverse proxy to `portal-bff:4000` (`web/nginx.conf`) |

### Routes

| Route | Page | Sidebar role | Data |
|---|---|---|---|
| `/login` | `Login.tsx` | public | sign-in |
| `/` | `Overview.tsx` | viewer | KPIs, live problems over SSE, problems by group |
| `/problems` | `Problems.tsx` | viewer | problem list, Explain, Acknowledge |
| `/sites` | `Sites.tsx` | viewer | hosts rolled up per site |
| `/hosts` | `Hosts.tsx` | viewer | hosts with problem counts |
| `/graphs` | `HostDetail.tsx` | viewer | item history chart |
| `/latest` | `LatestData.tsx` | viewer | latest item values |
| `/maps` | `Maps.tsx` | viewer | Zabbix topology maps, hosts coloured by severity |
| `/network` | `Network.tsx` | operator | ICMP devices, interface traffic |
| `/links` | `Links.tsx` | operator | WAN and link health |
| `/services` | `Services.tsx` | viewer | service tree, SLA per service |
| `/sla` | `Sla.tsx` | viewer | SLA and SLI tables |
| `/reports/availability` | `Availability.tsx` | viewer | availability and unacknowledged aging |
| `/reports/capacity` | `Capacity.tsx` | viewer | CPU, memory, disk trends |
| `/reports/noise` | `AlertNoise.tsx` | viewer | flapping and unactioned triggers |
| `/reports/top-triggers` | `TopTriggers.tsx` | viewer | top 100 triggers |
| `/reports/inventory` | `Inventory.tsx` | admin | governance scorecard and CSV export |
| `/assistant` | `Assistant.tsx` | viewer | free-form questions over a cached estate snapshot, streamed |

## 3. API calls made

All paths are relative to `/bff`. The shapes are the TypeScript types in `web/src/types.ts`, and each
was checked against a live response. A generated call map found **no client function that is never
called**, and **no call without a matching BFF route**.

| Method | Endpoint | Called from | Expected response |
|---|---|---|---|
| POST | `/api/auth/login` `{username, password}` | `pages/Login.tsx` via `api.ts:171` | `{ token, user: { name, role } }` |
| GET | `/api/auth/me` | `hooks/useAuth.ts`, `hooks/useSSE.ts` | `Me`, `{ authEnabled, user: { name, role } }` |
| GET | `/api/health` | `hooks/useAi.ts` | `{ ok, ts, ai, writeBack, defaults: { availabilityMinSeverity } }` |
| GET | `/api/stats` | `Overview.tsx` | `Stats` |
| GET | `/api/problems` | `Overview.tsx` (fallback poll), `Problems.tsx` | `Problem[]` (with `host`, `hostid`, `manualClose`) |
| GET | `/api/stream?token=` (SSE) | `Overview.tsx` via `streamUrl()` `api.ts:166` | `event: problems` → `Problem[]`; `event: error` → `{ message }` |
| GET | `/api/reports/problems-by-group` | `Overview.tsx` | `GroupProblems[]` |
| POST | `/api/problems/acknowledge` `{eventids, message?, acknowledge?, close?}` | `components/AckDialog.tsx` | `{ ok: true, eventids, action }` |
| GET | `/api/explain/problem?eventid=` | `components/ExplainPanel.tsx` | `ProblemExplanation` |
| GET | `/api/explain/sla?slaid=&serviceid=` | `components/ExplainPanel.tsx` | `SlaExplanation` |
| GET | `/api/sites` | `Sites.tsx` | `SitesResponse` |
| GET | `/api/hosts` | `HostDetail.tsx`, `LatestData.tsx` | `Host[]` |
| GET | `/api/hosts/overview` | `Hosts.tsx` | `HostOverview[]` |
| GET | `/api/hostgroups` | `LatestData.tsx` | `HostGroup[]` |
| GET | `/api/items?hostid=` | `HostDetail.tsx` | `Item[]` |
| GET | `/api/latest?hostid=` or `groupid=` | `LatestData.tsx` | `LatestResponse`, `{ items, truncated }` |
| GET | `/api/history?itemid=&hours=&history=` | `HostDetail.tsx`, `Network.tsx` | `HistoryPoint[]`, window ends at the item's newest value |
| GET | `/api/maps` | `Maps.tsx` | `ZMap[]` |
| GET | `/api/maps/detail?mapid=` | `Maps.tsx` | `MapDetail[]` (elements carry `labelText`, `problems`, `maxSeverity`) |
| GET | `/api/net/devices` | `Network.tsx` | `NetDevice[]` |
| GET | `/api/net/ports?hostid=` | `Network.tsx` | `NetPort[]` |
| GET | `/api/links` | `Links.tsx` | `LinksResponse` |
| GET | `/api/services` | `Services.tsx` | `ServicesResponse` |
| GET | `/api/sla` | `Sla.tsx` | `Sla[]` |
| GET | `/api/sla/sli?slaid=` | `Sla.tsx` | `SlaSli[]` |
| GET | `/api/reports/availability?days=&severity=` | `Availability.tsx` | `AvailabilityReport` |
| GET | `/api/reports/aging` | `Availability.tsx` | `AgingReport` |
| GET | `/api/reports/capacity?days=` | `Capacity.tsx` | `CapacityReport` |
| GET | `/api/reports/noise?days=&severity=` | `AlertNoise.tsx` | `NoiseReport` |
| GET | `/api/reports/top-triggers?days=` | `TopTriggers.tsx` | `TopTriggersReport` |
| GET | `/api/reports/inventory` | `Inventory.tsx` | `ScorecardResponse` |
| GET | `/api/graph?itemids=&hours=` \| `month=` \| `from=&to=` | `HostDetail.tsx`, `Network.tsx` | `GraphResponse`, downsampled series, gaps as nulls *(added 2026-09-17)* |
| GET | `/api/net/interfaces?hostid=&search=&page=` | `Network.tsx` | one row per port *(added 2026-09-17)* |
| GET | `/api/sli?month=&profile=` | `Sla.tsx`, `Availability.tsx` | `SliReport` *(added 2026-09-17)* |
| GET | `/api/services/derived?month=&profile=` | `Services.tsx` | derived `ServicesResponse` *(added 2026-09-17)* |
| GET | `/api/sla/source` | `Sla.tsx` | `{ real, slas, services }` *(added 2026-09-17)* |

### Error contract the client relies on

Every BFF error is now `{ error, message }`: `error` is a stable code, `message` is text for the
screen. `request()` and `post()` in `web/src/api.ts` show `message`, fall back to `error`, and treat
401 as signed out. Before this audit the BFF used four different error shapes. The client happened to
cope, because it already read `message ?? error`, but nothing guaranteed it.

**Three BFF routes are never called from this app:** `/api/trend`, `/api/net/status` and `/api/net/map`.
They are listed as dead code in the BFF report.

## 4. Issues found

Severity: **High**: wrong data, a broken page or data exposure · **Medium**: incorrect behaviour a user or
operator will hit · **Low**: hygiene, clarity or hardening.
*Confirm* marks items not applied because they change auth, ports in use, production data or
dependencies. They need your decision first.

| # | Severity | File:line | Issue | Status |
|---|---|---|---|---|
| FE-01 | High | `web/src/pages/HostDetail.tsx:26` | Graphs called `/api/items` before a host was selected, with no `hostid`. The BFF passed `[undefined]` to Zabbix and returned a 500, so there was a failed request and a console error on every visit. It was the only failure left in the signed-in crawl | **Fixed.** The call now waits for a host, and the BFF returns 400 for a missing id |
| FE-02 | High | `docker-compose.yml:50-51` (`AI_PROVIDER`, `ANTHROPIC_API_KEY`), root `.env` | Explain on `:8081` sends HCML production data (problem names, host names, tags) to Anthropic. Verified in the container: `AI_PROVIDER` unset (so Anthropic), a 108-character `ANTHROPIC_API_KEY` present. The Ollama variant exists precisely to keep this data local. **Widened 2026-09-18:** the Assistant ported here that day streams a whole estate snapshot (sites, hosts, open problems, SLA figures, up to ~5,500 characters) to Anthropic on every question, not just one problem per Explain click | **Confirm.** The remedy is now a one-line change rather than a different repo: this portal carries the same provider-neutral `ai.ts`, so `AI_PROVIDER=openai-compatible` with `AI_BASE_URL=http://host.docker.internal:11434/v1` moves it to the local model (the container can reach host Ollama, verified). Or remove the key |
| FE-03 | Medium | `web/src/api.ts` (`login()`), `web/src/pages/Login.tsx` | Every sign-in failure, including a 429 rate limit or a stopped BFF, was reported as "Invalid username or password". There was no client-side check for empty fields | **Fixed.** Only a 401 means bad credentials; other failures show the server's message; empty or whitespace input is refused before the request |
| FE-04 | Medium | `web/src/hooks/useSSE.ts` (`useSSE()`) | The stream reports Zabbix failures as `event: error`, and nothing listened, so the badge stayed "Live" over stale data. When the token in the stream URL expired, EventSource retried every few seconds forever and never sent the user to sign in | **Fixed.** Error frames are surfaced (`error` is returned at line 67). A dropped connection with a token calls `/api/auth/me`, and its 401 signs the user out |
| FE-05 | Medium | `web/src/pages/Overview.tsx:22-24,66` | The fallback poll switched off for good after the first SSE frame. If the stream later failed, the list froze while still labelled live | **Fixed.** The poll resumes whenever the stream is not connected; the badge reads "Polling: live stream error" and shows the error on hover |
| FE-06 | Medium | `web/src/hooks/useAsync.ts` (`useAsync()`) | Responses could land out of order. Selecting host A then host B could leave host A's items on screen if A's response arrived last | **Fixed.** Only the most recent run may set state |
| FE-07 | Medium | `web/nginx.conf:26,36` | `index.html` was served without cache headers, so browsers kept a pre-rebuild copy and ran old bundles. This is why Maps still showed "()" labels after the fix had shipped | **Fixed.** `index.html` is `no-cache`; fingerprinted `/assets/` are `immutable` |
| FE-08 | Medium | `web/vite.config.ts:9-18` | Dev port and proxy target were hardcoded. With 5173 taken, Vite quietly moved to 5174 but still proxied to `:4000`, giving a page that looked like one portal and talked to the other's BFF | **Fixed.** `VITE_PORT` and `BFF_URL` from env (defaults unchanged), plus `strictPort` |
| FE-09 | Medium | `web/src/api.ts` (`TOKEN_KEY` / `getToken`) | The JWT lives in `localStorage`, readable by any script on the origin. It compounds FE-13's ECharts XSS advisory | **Confirm.** Recommend an httpOnly `SameSite=Strict` cookie, or an in-memory token with refresh. This is an auth change |
| FE-10 | Medium | `web/src/api.ts` (`streamUrl()`) | The live stream sends the JWT in the query string, so it lands in nginx access logs. The BFF accepts `?token=` on **every** route, not just the stream (BFF report BE-12) | **Confirm.** Recommend a short-lived single-use stream ticket, or restricting `?token=` to `/api/stream` |
| FE-11 | Medium | `docker-compose.yml:87` (`WEB_PORT`) | The web container is published on all interfaces. From the LAN, `172.31.99.158:8081` answered 200. Sign-in is still required, but this puts HCML production data on the office network | **Fixed 2026-09-17:** published as `127.0.0.1:${WEB_PORT:-8081}:80` |
| FE-12 | Medium | `docker-compose.yml:70` (`PORTAL_PASS`) | `PORTAL_PASS` defaults to `admin` when unset, and auth is on by default | **Confirm.** Recommend `${PORTAL_PASS:?set PORTAL_PASS}`, the same guard `JWT_SECRET` has. The BFF now logs a warning |
| FE-13 | Medium | `web/package.json:7,13,17,24` | `npm audit`: 5 vulnerabilities. High: `vite` (dev-server path traversal). Moderate: `echarts` (XSS), `react-router-dom` / `react-router` (open redirect), `esbuild` (dev server) | **Confirm.** Every fix is a major upgrade (vite 8, echarts 6, react-router 7), not applied |
| FE-14 | Low | `web/src/App.tsx` (the `BrowserRouter` future flags) | React Router logged two future-flag warnings on every page, 34 of the 40 crawl events | **Fixed.** Opted in to `v7_startTransition` and `v7_relativeSplatPath` |
| FE-15 | Low | `web/index.html:8` | No favicon, so a 404 on every first load | **Fixed** |
| FE-16 | Low | `web/src/hooks/useAi.ts` (the capability probe) | A failed `/api/health` probe was cached for the session. One failure during a BFF restart hid Explain and Acknowledge until a full reload | **Fixed.** Failures are not cached |
| FE-17 | Low | `web/src/pages/Inventory.tsx:41-50` | The gap-list CSV export quoted cells but did not neutralise leading `= + - @`, so a host name like `=HYPERLINK(…)` would run as a formula in Excel | **Fixed.** Such cells get a leading `'` (checked on 6 sample values) |
| FE-18 | Low | `web/src/components/states.tsx:20` | The error hint named the deprecated `ZBX_TOKEN` | **Fixed.** Now `ZABBIX_API_TOKEN` |
| FE-19 | Low | `web/src/components/Sidebar.tsx:45-46,58` | Menu role gating copies the BFF's `ROUTE_RULES` by hand. If they drift, the menu shows links that 403 or hides pages a role can reach | Recommended: return the rule table from `/api/auth/me` |
| FE-20 | Low | `.env.example:91`, `server/.env.example:147`, `docker-compose.yml:69` (`PORTAL_USER`) | The examples say `PORTAL_USER=Admin`; Compose defaults to `admin`. Usernames are case-sensitive | Recommended: pick one and align all three |
| FE-21 | Low | `web/src/components/ExplainPanel.tsx` (the footer note) | ~~The footer always says "Written by Claude", whatever `AI_MODEL` is set to~~ **Already fixed in the code:** it now reads "Written by an AI model from the Zabbix data on this page", which is provider-neutral and correct for both portals | Optional: return the model name from `/api/health` so the footer can name it |
| FE-22 | Low | `web/src/pages/Maps.tsx:27` | Where HCML placed map elements ~100 px apart, labels overlap (e.g. `4.1 FG60F-FPSO-01` and `6.1 FGR-60F-SUMENEP`) | Open, cosmetic |

### Checked and found sound

- **Handlers.** The static scan flagged 9 buttons in `Inventory`, `Sites`, `Services` (×3), `Problems` (×2)
  and `Sla` (×2); every one has a working handler. No `href="#"` and no placeholder handlers anywhere.
- **Write form.** `AckDialog.tsx:34` disables Confirm when there is nothing to do, and `:85` caps the
  message at 2048 characters, matching the BFF's `MAX_MESSAGE`.
- **States.** All 18 pages render their data through `<Async>`, so loading, error and empty are
  always handled.
- **Clean source.** No `TODO`, `FIXME`, `console.*` or `debugger` anywhere in `web/src`.

## 5. Integration traces

Run against the Docker stack (`:8081`, auth on) after the fixes.

| Flow | Result |
|---|---|
| No token → `GET /api/problems` | `401 { error: "unauthorized", message: "Sign in to continue." }` |
| Wrong password → `POST /api/auth/login` | `401 { error: "invalid_credentials", … }`; the page shows it verbatim |
| Sign in → `/api/auth/me` → `/api/problems` | 200 in 2 ms → `{ authEnabled: true, user: { admin, admin } }` → 664 problems in 333 ms; every field `Problem` declares is present |
| Acknowledge with a non-numeric id / nothing to do | `400 bad_request`, shown in the dialog. **No real write was sent**, because the data is HCML's |
| Live stream with `?token=` | `200 text/event-stream`, first frame `event: problems` |
| Graphs → history for a restored item | Chart renders the last stored hour, with a "No new data since …" note |

## 6. Port and env configuration used

| Service | Port | Bound to | Configured in | Notes |
|---|---|---|---|---|
| Vite dev server | 5173 | `localhost` only | `web/vite.config.ts` (`VITE_PORT`) | `strictPort`: fails instead of moving |
| Dev proxy target | 4000 | — | `web/vite.config.ts` (`BFF_URL`) | Rewrites `/bff/*` to `/*` |
| nginx (Docker) | 80 in container → **8081** on host | 127.0.0.1 (since 2026-09-17) | `docker-compose.yml` (`WEB_PORT`) | FE-11 fixed |
| BFF behind nginx | 4000 | Docker network only (`expose`) | `web/nginx.conf` (`proxy_pass http://portal-bff:4000/`) | Never published |
| BFF CORS origin | — | — | `WEB_ORIGIN`: `http://localhost:5173` (dev), `http://localhost:8081` (Docker) | Both match the real origin. Browser traffic is same-origin through the proxy, so CORS is never actually exercised |

**Port conflict between the two variants.** Both repos' Compose files publish 8081, and both dev setups use
5173 and 4000, so the two portals cannot run at the same time with defaults. The ports are now
env-configurable, but the defaults were left alone because 8081 is in use. Recommended fixed
assignment, which needs your go-ahead to change defaults:

| Service | `hcml-portal` | `hcml-portal-ollama` |
|---|---|---|
| Web (Docker) | 8081 | **8082** |
| Web (dev) | 5173 | **5174** |
| BFF (dev) | 4000 | **4001** |
| Zabbix frontend (shared) | 8080 | 8080 |
| Ollama (shared, host only) | — | 11434 on `127.0.0.1` |

## 7. Remaining TODOs

1. **Decide FE-02.** Stop sending HCML production data to Anthropic from `:8081`, or accept it explicitly.
   Now larger in scope (the Assistant) and cheaper to fix (one `.env` line). The key flagged on the 10th is
   still not rotated.
2. **Decide the auth hardening in FE-09, FE-10 and FE-12**, together with the BFF items BE-12, BE-13 and BE-14.
3. ~~**Bind `:8081` to `127.0.0.1`** unless LAN access is intended (FE-11).~~ Done 2026-09-17.
4. **Plan the major upgrades** in FE-13, starting with ECharts for the XSS advisory.
5. **Adopt the port plan** in §6 so both variants can run side by side.
6. **FE-19, FE-20, FE-21**, then the FE-22 map-label layout.
7. **Add a front-end test runner.** `web/` has none. Every check here was a crawl or a type check, so the
   hooks fixed in FE-04 to FE-06 have no regression tests.

## Files changed by this audit

`web/src/api.ts`, `web/src/App.tsx`, `web/index.html`, `web/vite.config.ts`, `web/src/hooks/useAsync.ts`,
`web/src/hooks/useSSE.ts`, `web/src/hooks/useAi.ts`, `web/src/pages/Login.tsx`, `web/src/pages/HostDetail.tsx`,
`web/src/pages/Overview.tsx`, `web/src/pages/Inventory.tsx`, `web/src/components/states.tsx`,
`docker-compose.yml`, `server/.env.example`, `server/.env` (`HOST`). `web/nginx.conf` was changed earlier the
same day. The shared BFF files are listed in the counterpart report.

---

# Second audit: 21 September 2026 (documentation and repository integrity)

| | |
|---|---|
| **Date** | 2026-09-21 |
| **Scope** | Both repos after that day's restructuring: `tools/` deleted, `DOCUMENTATION.md` deleted, `howits.md` renamed to `setup.md`, `ERD.md` moved back to the repo root, `ERD/` `Flow/` `Schema/` recased, 46 link targets rewritten |
| **Method** | Four independent audit agents (links and references · repo parity · document-vs-code accuracy · deletion fallout and secrets), each finding then re-checked by a separate adversarial agent instructed to assume it was wrong and reproduce it from scratch |
| **Counterpart report** | [`../hcml-portal-ollama/AUDIT_REPORT.md`](../hcml-portal-ollama/AUDIT_REPORT.md) carries the same section plus the findings specific to that repo |
| **Result** | 45 findings raised, **30 confirmed**, 2 refuted, the rest informational. No credential leak. Source tree parity intact. |

> **A note on method.** This machine's filesystem is APFS and **case-insensitive**, so `ls`, `test -e`
> and `[ -e ]` resolve `Schema/` when the real directory is `schema/`. Every agent was required to use
> `python3 os.listdir()` for any claim about a filename, and the `git` CLI was unusable throughout
> (it exits 69 on an unaccepted Xcode licence), so all git facts below come from parsing
> `.git/index` and the object store directly.

## Result at a glance

| Severity | Count | Theme |
|---|---|---|
| **High** | 4 | Two deletions are unrecoverable and three documents say otherwise; `setup.md` contradicts itself on test counts |
| Medium | 14 | Stale counts, stale line citations, lowercase folder names left in prose, understated divergence |
| Low | 5 | Orphaned renders, placeholder `JWT_SECRET`, dangling `instruct.md` citations |
| Verified clean | 9 | Parity, links, anchors, casing on disk, secrets, tests, endpoints, pages, dependencies |

---

## A1 · HIGH: the deleted files were never under version control, and three documents claim they were

> ⚠ **STILL OPEN.** Nothing below has been fixed.


`tools/` and `DOCUMENTATION.md` were deleted on 21 September on the stated basis that
`hcml-portal`'s commit `b4a4059` was a backup. **It is not.** Parsing the object store directly:

- the repository has exactly **two** commits, `cb97069` (root) and `b4a4059` (HEAD = `origin/main`)
- the full recursive tree of `b4a4059` is 88 paths; **zero** contain `tools`, **zero** end in `.py`
- its root level is exactly `.env.example`, `.gitignore`, `README.md`, `docker-compose.yml`,
  `howits.md`, `server/`, `web/`, no `DOCUMENTATION.md`, no `AUDIT_REPORT.md`, no `ERD.md`
- no tree among the 124 loose objects contains either path, and `objects/pack` is empty, so
  `git fsck --lost-found` cannot recover them either
- `tools/` was created on **8 September**, one day *after* the final commit (7 Sep 15:05 +0700), so it
  could never have been in `b4a4059`
- `.gitignore` covers `__pycache__/` and `*.pyc` but **not** `tools/`: this was a missing `git add`,
  not an exclusion

A filesystem-wide search finds no surviving copy: `~/.Trash` is empty, `mdfind` returns nothing, and
there are no APFS local snapshots. **The six Python seed/reset scripts and `DOCUMENTATION.md` are
permanently gone.**

Three passages assert the opposite and must be corrected before anyone relies on them:

| File | Line | Claim |
|---|---|---|
| `Proto1/DECISION.md` | 218–220 | "recoverable from `hcml-portal`'s commit `b4a4059` … that one commit backs up both repos" |
| `hcml-portal/README.md` | 154 | "the scripts are recoverable from commit `b4a4059`" |
| `hcml-portal-ollama/README.md` | 208 | "recoverable from `hcml-portal`'s commit `b4a4059`" |

The false premise originates in `myown/log/8-9-26.md` §2.7 ("Promoted … into committed `tools/`") and
was repeated without checking. **Fix:** state plainly that the files were untracked and are gone.
Before re-asserting recoverability anywhere, `git cat-file -p b4a4059^{tree}` must actually list the path.

### What died with `DOCUMENTATION.md`

Checked section by section against the surviving corpus. **Survives:** the stack table (→ `README.md`
§ Tech stack), architecture and the page-load trace (→ `setup.md` §1, §2, §5, §6), the data model
(→ `Schema/`, `ERD.md`), the local-model experiment (→ `README.md`, `Flow/DataFlow`), *The two
portals* (→ `README.md`, `ERD.md` § The two portals).

**Recorded nowhere now:** the **six-goals framing** (HCML's goals 2–6 mapped to features), the
**Limitations / known-gaps** section, this repo's `README.md` has none at all, and the **glossary**.
These should be reconstructed into `setup.md` while they are still recent.

## A2 · HIGH: `setup.md` contradicts itself on the size of the test suite

> ✅ **RESOLVED 21 Sep 2026.** The defect below is fixed; the description is kept as the record of what was wrong. Verification is in *Fix round* at the end of this report.


`setup.md` became the primary reference when `howits.md` was renamed, and it disagrees with itself:

| Line | Says | Measured |
|---|---|---|
| 158 (§5) | "336 vitest tests" | **336 in 19 files** ✓ |
| 932 (§22) | "91 tests" | ✗ |
| 936 (§22) | "covers all fifteen route modules" | **17 modules** ✗ |
| 157 (§5) | "the sixteen route plugins" | **17** (`sliRoutes` added 17 Sep) ✗ |

`setup.md` is byte-identical between the repos apart from three port lines, so each is one fix applied
twice. Its §5 endpoint table also omits three live endpoints: `/api/graph`, `/api/net/interfaces`,
`/api/chat/warm`, all added on 17 September.

## A3 · MEDIUM: findings in this repo

> **Mixed.** Most rows below are resolved and say so inline. Only `DOC-11` (the placeholder `JWT_SECRET`, a credential change left for the author) remains open. See *Fix round*.


| Id | Finding | Fix |
|---|---|---|
| **DOC-01** | ~~`AUDIT_REPORT.md` said **17 pages** in six places (lines 26, 36, 37, 40, 62, 185); `App.tsx` has 18 `lazy()` imports and `web/src/pages` holds 18 files. The crawl skipped `/login`~~ **Fixed 21 Sep:** the crawl row now reads "17 crawled routes (18 pages; `/login` crawled separately)" and the rest say 18 | — |
| **DOC-02** | Front-end code citations have drifted **100+ lines**. `api.ts:166-169` is cited for the stream token; line 166 is a `status?:` type declaration. `Login.tsx:17`, `App.tsx:39`, `vite.config.ts:9`, `Inventory.tsx:41` still land correctly | Cite symbols (`TOKEN_KEY`, `streamUrl()`, `login()`) rather than line numbers |
| **DOC-03** | Every `docker-compose.yml` citation is off by 12–25 lines after today's edits. FE-02 cites `:39` for the Anthropic key (really `:50`/`:51`); FE-11 cites `:63` for the published port (really `:87`) | Cite the env key name, not the line |
| **DOC-04** | **Withdrawn: the premise was wrong.** This finding asserted the directories should be `Schema/` `Flow/` `ERD/` and the lowercase prose was the defect. The opposite is true: **lowercase is the intended convention**, and the auditing session had itself renamed the folders to uppercase against the author's intent. The real defect was link targets and display text drifting to uppercase. **Fixed 21 Sep:** all seven directories per repo restored to lowercase (`erd/ flow/ schema/`, and `conceptual/ database/ database-schema/ vanilla/`), `ERD.md` → `erd.md`, and 96 link targets plus 84 prose/label lines lowercased to match | — |
| **DOC-05** | Both READMEs still say the Zabbix and model clients are "about forty lines each" (lines 32 and 72). Measured: `zabbix.ts` **174**, `ai.ts` **665** | Use the sibling's wording, "the Zabbix client is 174 lines" |
| **DOC-06** | The Layout tree omits `ERD.md`, `setup.md`, `AUDIT_REPORT.md` and six `server/src` modules that the sibling's tree lists | Match the sibling |
| **DOC-07** | ~~`schema/README.md` said "41 entities" here and "43" in the sibling, about a byte-identical `erd.md`~~ **Fixed 21 Sep:** counted from `erd/vanilla/ERD-Mermaid.mmd`, **43 entities across 9 domains**; both copies now say 43 | Count once, write the same number in both |
| **DOC-08** | All three `Schema/*.mmd` were edited today at 12:11; all six `Schema/*.pdf` still carry 18 Sep mtimes. `Flow/` was re-rendered at 12:22: the omission is specific to `Schema/` | Re-render the three PDFs in both repos |
| **DOC-09** | ~~The recasing pass rewrote `](…)` link targets only; 13 lowercase paths survived in Mermaid `%%` comments and README prose~~ **Superseded by DOC-04:** the direction was backwards. **Fixed 21 Sep:** every folder reference (targets, display text, prose and `%%` comments) now matches the lowercase directories on disk. Verified: **296 links, 0 broken** under a case-sensitive resolver | — |
| **DOC-10** | This report and the README claim only `.env` and the port differ between repos. The measured divergence is **18 files** (17 at audit time; the B3 fix made `server/.env.example` differ too) | State the real list once and reference it |
| **DOC-11** | `server/.env` sets `JWT_SECRET` to the exact 29-character built-in placeholder the BFF is designed to refuse (`config.ts:7`) | Generate a real secret; this blocks `AUTH_ENABLED=true` |
| **DOC-12** | ~~Source comments cite `instruct.md`, which is in neither repo (it lives at `myown/plan/instruct.md`)~~ **Fixed 21 Sep:** all **8** citations repointed at the equivalent `setup.md` section, identically in both repos; a provenance note at the top of `setup.md` records where they came from | — |
| **DOC-13** | `ERD/Conceptual` is the only ERD leaf whose `.md` does not link its own `.mmd`/`.pdf`/`.png`: three orphaned renders per repo | Add the links |

## A4 · Verified clean

Re-derived independently, not taken on trust:

- **Source parity holds.** `server/src`, `web/src`, `server/scripts`, `web/scripts` byte-identical.
- **286 path links and 208 anchors resolve case-sensitively**, and every directory's on-disk casing
  is now correct (`os.listdir`, not `test -e`).
- **No reference to any file deleted or renamed today survives** in either repo.
- **No credential leak.** Real secrets are confined to gitignored, untracked `.env` files; the
  committed `.env.example` templates carry placeholders only.
- **The `tools/` deletion is clean**: nothing in either repo still expects those scripts.
- **Measured accurate:** 336 tests / 19 files, 17 route modules → 38 endpoints (41 with health, login
  and `auth/me`), 18 pages, 21 direct dependencies, `styles.css` 2 000 lines, `markdown.ts` 141,
  `zabbix.ts` 174, and the 182 kB + 26 kB bundle figures.
- **`Flow/WebFlow.mmd` and `Flow/ServerFlow.mmd` are byte-identical** between repos; `DataFlow`
  colour classes are correct in each.
- **Open items unchanged:** 5 FE and 6 BE, plus BE-21/BE-22 partial. None were resolved or
  invalidated by the 21 September changes.

**Refuted by the adversarial pass:** that `server/.env.example` *differing* between repos was itself a
defect. The templates were byte-**identical**, which was the real finding (B3). *Note added 21 Sep:* the
B3 fix deliberately broke that byte-identity: the ollama template now selects the local backend,
so the two `.env.example` files are now expected to differ,
and that the stale `Schema` PDFs necessarily misinform a reader (the mtime gap is real; the rendered
content difference is unverified).

## A5 · Outside both repos

Reported because they were touched on 21 September or are reachable from the decision record:

- **`Proto1/SETUP.md` does not exist in any casing**, yet **12 links** across `DECISION.md`,
  `README.md`, `CUSTOMIZE.md` and `presentation.md` point at it: one added on 21 Sep in
  `DECISION.md` §6b, which cites a rollback procedure "documented in `SETUP.md`".
- **`presentation.md` links `instruct.md` six times** as a root sibling; it is at
  `myown/plan/instruct.md`, which `DECISION.md` links correctly.
- **The `howits.md` → `setup.md` rename is a worktree change only.** git still tracks `howits.md`;
  `git checkout .` or `git reset --hard` would resurrect it beside the untracked `setup.md`.
  `.git/config` has `ignorecase = true`, so git cannot see the directory recasings either.


---

# Fix round: 21 September 2026

Applied after the audit above, then re-verified by five independent agents whose findings were each
attacked by a second agent instructed to break them. Every number below was re-derived from the
files, not copied from the audit.

## Resolved

| Finding | What changed | Verified by |
|---|---|---|
| **A2 / B5** `setup.md` self-contradiction | "91 tests" → **336 in 19 files**; "fifteen route modules" → **seventeen**; "sixteen route plugins" → **seventeen**; `routes/sli.ts` row added | `npm test` = 336/19; 17 `app.register(...Routes)` in `index.ts`; 17 files in `server/src/routes` |
| **A2 / B5-e** endpoint coverage | 9 rows added to the *Endpoint reference* table | table now lists **41 of 41** live endpoints, set-compared against `app.get`/`app.post` in source |
| **B3** local-model template | both `.env.example` files now select `openai-compatible` / `qwen3:8b`; hosted block commented with the silent-fallback warning | parsed both files: **no duplicate keys** (a duplicate `AI_TIMEOUT_MS` was introduced and removed); README walkthrough rewritten to match |
| **B4** `schema/PDM.mmd` contradiction | the stale hosted-Claude paragraph removed | no self-contradiction remains; all six schema PDFs re-rendered, 1 page each, portal red = 1 CDM / 6 ERD, ollama red = **0** |
| **DOC-01** page count | Routes table gained `/assistant`; counts say 18 | `App.tsx` has 18 `lazy()`; `web/src/pages` holds 18 files |
| **DOC-02** drifted web citations | 9 line citations → symbol citations; `FE-03` → `login()`, `FE-21` → the footer note | every cited symbol exists in its cited file |
| **DOC-03** compose citations | re-anchored and each now names the env key | all 11 checked land on the right key |
| **DOC-07** entity count | both copies now say **43 entities across 9 domains** | counted from `erd/vanilla/ERD-Mermaid.mmd`: 43 entities, 9 subgraphs |
| **DOC-08** stale renders | all six `schema/*.pdf` re-rendered from current sources | `%PDF-1.4`, 1 page each |
| **DOC-12** `instruct.md` citations | all 8 source comments repointed at `setup.md` sections, identically in both repos | `grep -rn instruct` over `server/src` + `web/src` returns only the word "instructions"; parity, 336 tests and both typechecks clean |
| **DOC-13** orphaned renders | `erd/conceptual/ERD-Conceptual.md` now links its `.mmd`, `.pdf`, `.png` | link check |
| **DOC-14** stale counts | "16 route modules" → 17; "16 modules, 35 endpoints" → 17/38; route-extraction line 35 → 41 | matches the §3 table, which was already correct |
| **DOC-15** endpoint citations | every "Defined at" line re-derived from source | **35 of 35** now land on the real registration line (was 12) |
| **DOC-16** port table | this repo's row now reads **8082 / 127.0.0.1** | `docker-compose.yml:88`, `.env` `WEB_ORIGIN` |
| **DOC-17** falsified evidence | BE-21's secret-scan sentence restored to name `howits.md` and whose history was scanned | — |
| **DOC-18** parity recipe | commands now use `cmp … && echo OK` instead of `diff` | both commands run and pass |
| **DOC-05 / DOC-06 / DOC-10** | client line counts corrected (174 / 665), layout trees completed, divergence restated as **18 files** | `wc -l`; `diff -rq` counts exactly 18 |

## Withdrawn: the audit was wrong

| Finding | Why |
|---|---|
| **DOC-04**, **DOC-09**, part of **DOC-18** | These were premised on `ERD/ Flow/ Schema/` being the correct casing. **They are not.** Lowercase is the project's convention; the auditing session had renamed the folders against the author's intent and then audited against its own change. All seven directories per repo are back to lowercase (`erd/ flow/ schema/`, `conceptual/ database/ database-schema/ vanilla/`), `ERD.md` → `erd.md`, and every reference lowercased to match. **296 links, 0 broken** under a case-sensitive resolver |
| **FE-21**'s issue statement | The footer no longer says "Written by Claude"; it is already provider-neutral |

## Still open

| Finding | Why it was not fixed |
|---|---|
| **A1 / B2** deleted files unrecoverable | Nothing to fix in code: the three "recoverable from `b4a4059`" passages need correcting, and the lost `DOCUMENTATION.md` sections (six-goals framing, Limitations, glossary) need rewriting from memory |
| **B1** no version control here | Needs `sudo xcodebuild -license`, then `git init` and a commit |
| **DOC-11** placeholder `JWT_SECRET` | Both `server/.env` hold the exact string `config.ts` refuses to boot on. Changing a credential unasked is not something this pass should do |

## Caveat on this record

The verification run was launched **before** the casing reversal, so its casing dimension judged
against the wrong premise; those results are discounted above and the casing work was re-verified
separately. Everything else it checked: counts, citations, `.env.example`, `schema/PDM.mmd`, and
collateral damage from find/replace is unaffected.
