# Tools

Small scripts that check this repository or read a running portal. None needs a package of its own:
the checkers use Node's standard library (the two `.ts` ones run with the `tsx` of `server/node_modules`),
the live tools drive Chrome over the DevTools protocol or use `curl` and Node's `fetch`.

Run everything the checkers cover with `npm run check` at the root (see the root `package.json`).
The web app's types are held to the response schemas of `docs/api/openapi.yaml` by a test in `web/`, not here:
`web/src/__tests__/openapiTypes.test.ts` (see `docs/api/README.md`).
The checks that belong to one package stay in it: `web/scripts/` (stylesheet, tokens, units, the
assistant's markdown parser) and `server/scripts/` (`validate-sli.ts`, which needs HCML's own report
files, and `hash-password.ts`).

## `check/`: the repository against itself

Read-only, run by CI. Each fails with a message that names the file and the line.

| Tool | What it checks | Run (from the repository root) |
|---|---|---|
| `openapi.check.ts` | `docs/api/openapi.yaml` lists exactly the routes `server/src/routes/` registers, their methods, path parameters, guard and 400/401/403 answers, and that no description is one YAML cuts at a comma | `./server/node_modules/.bin/tsx tools/check/openapi.check.ts` |
| `erd.check.ts` | the database ERD exists twice (`.mmd` and `.erd`) and the two say the same | `./server/node_modules/.bin/tsx tools/check/erd.check.ts` |
| `links.check.mjs` | every relative link in the Markdown resolves, spelled exactly; a line citation in backticks does not run past the end of its file | `node tools/check/links.check.mjs` |
| `facts.check.mjs` | the counts the documents state are the ones the code has: endpoints, route modules, Zabbix methods, parts of the guide, ADRs, pages, dependencies, test files, ERD entities and tables; every endpoint has a row in the endpoint table of `docs/setup/05`; the table of Zabbix calls in `ERD-Database.md` lists exactly the lines that name each method | `node tools/check/facts.check.mjs` |
| `diagrams.check.mjs` | each diagram source still matches the stamp of its render, and the PDF exists | `node tools/check/diagrams.check.mjs` |
| `diagrams.stamp.mjs` | writes that stamp, after a re-render | `node tools/check/diagrams.stamp.mjs [--force]` |
| `parity.check.mjs` | the two copies (`hcml-portal`, `hcml-portal-ollama`) hold the same files apart from the ones meant to differ. With no sibling, as in CI, it runs only its own self-test | `node tools/check/parity.check.mjs` |

## `live/`: a running portal

Read a running portal and change nothing.

| Tool | What it does | Run |
|---|---|---|
| `signedin_check.py` | Signs in through nginx and checks health, ready, both report downloads, the stream and the problems list. The password comes from `PORTAL_USER` and `PORTAL_PASSWORD`, and is never printed | `PORTAL_USER=... PORTAL_PASSWORD=... python3 -I tools/live/signedin_check.py http://localhost:8081` |
| `layout-sweep.mjs` | Every page at five widths, and how far each runs past the window | `node tools/live/layout-sweep.mjs --base http://localhost:5173` (a dev portal, sign-in off) |
| `page-audit.mjs` | Every page of the app (the sign-in screen with `--routes /login` against a portal that has sign-in on): console errors, failed requests, Content-Security-Policy violations, text contrast worked out in the page, unnamed controls, unlabelled fields, targets under 24 px, load time and bytes | `node tools/live/page-audit.mjs --base http://127.0.0.1:5199 [--theme dark] [--view 390x844] [--out file.json]` |
| `download-check.mjs` | Clicks the two CSV buttons (and, given `--graph`, the one under a graph's Show data) and the SLA PDF and Excel buttons, and says whether each file arrived, how many rows and columns a CSV has, and whether the page logged a Content-Security-Policy violation | `node tools/live/download-check.mjs --base http://127.0.0.1:5199 [--month 2026-09] [--graph '/graphs?hostid=10084&itemid=23296']` |
| `keyboard-walk.mjs` | Presses Tab through a page and reports stops with no focus ring and elements the keyboard cannot reach | `node tools/live/keyboard-walk.mjs http://127.0.0.1:5199 /,/problems` |
| `enforcing-csp-server.mjs` | Serves `web/dist` with the production Content-Security-Policy and proxies `/bff` to a dev BFF, so a change to the policy can be tried before a rebuild. `STYLE_SRC="'self'"` drops inline styles too | `node tools/live/enforcing-csp-server.mjs` (port 5199; `PORT`, `BFF_PORT` and `DIST` change it) |
| `load-test.mjs` | Closed-loop load on the cached read endpoints: requests per second and latency percentiles | `node tools/live/load-test.mjs http://127.0.0.1:4002 60 15` (start that BFF with `RATE_LIMIT_PER_MINUTE=10000000`) |
| `api-timing.py` | Every read endpoint, cold and warm, with its size raw and gzipped | `python3 -I tools/live/api-timing.py` (a dev BFF on :4000) |

`page-audit.mjs` and `layout-sweep.mjs` default to every page of the app, and `server/src/__tests__/live-tools.test.ts` fails when a page is added and left out of either list.

Set `CHROME` to the browser's path where it is not Chrome in `/Applications`. `api-timing.py` writes
`api-timing.json` to the folder it is run from; that file is ignored by git.
