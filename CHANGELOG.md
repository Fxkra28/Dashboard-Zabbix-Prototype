# Changelog

What changed in the portal, newest first. `hcml-portal` and `hcml-portal-ollama` hold the same code
and share this file; the files that differ by design are listed in
[`tools/check/parity.check.mjs`](tools/check/parity.check.mjs). Item ids such as UX-14 are the rows of
[`tracker.md`](tracker.md).

A build is named by the commit it was made from. The sidebar footer shows it once someone is signed in,
and so does a signed-in `/api/health`. A `-dirty` suffix means the build was made from a working tree
with changes that were not committed. Nothing is tagged: the commit is the version.

## 19 October 2026, last: a server linter, a CSV of Show data and three splits (not committed, not yet in the running portals)

At your word ("tolong lakukan ini, untuk MT02 dan MT06, tolong konfirmasi ke saya"), the five things left out on purpose on 16 October. I asked about MT-02 and MT-06, and you answered: MT-02 yes, as I proposed; MT-06 "Tunda lagi". Nothing was committed or rebuilt, so none of this is live.

- ST-06: the server has a linter. `server/eslint.config.js` (flat config: ESLint's and typescript-eslint's recommended rules, no warning allowed), `npm run lint` in `server/` and at the root, and a step in the `server` job of `ci.yml`. The first run found 22 findings (unused imports and types, patterns with control characters or runs of spaces, generators that never yield, and a few others); all are fixed, and eight `eslint-disable` lines are left, each with its reason. Four dev dependencies, none shipped: `eslint`, `@eslint/js`, `typescript-eslint`, `globals`. A trial build of the server image passed and its shipped layer holds no ESLint; the trial image was removed.
- MT-02: Show data has a Download CSV button, there also while the table is closed. One file for all the selected items, joined on time as the table joins them; raw numbers with the unit in the column heading; the time in the SLA zone; `hcml-graph-2026-10-19.csv` for a day, `hcml-graph-2026-10-18-to-2026-10-19.csv` for a longer window. It is written by the one CSV writer, which moved from `features/reports/` to `shared/lib/` and keeps its guard against spreadsheet formulas. Driven in headless Chrome: the file arrives with the rows of the table. `tools/live/download-check.mjs --graph` checks it on a running portal.
- ST-07: `services/analytics.ts` is `incidents`, `availability`, `noise`, `aging`, `capacity` and `reportPolicy`; `services/assistant.ts` is six `assistant*.ts` pieces behind `assistant.ts`, which stays the one entry that the route, `chat.ts` and the tests import and mock. Made by the compiler's API; each declaration was compared token for token with the original, and the comparison was shown to fail on a one-token change.
- ST-08: the web's `api.ts`, `types.ts` and `guards.ts` are the folders `api/`, `types/` and `guards/`, a file for each feature behind an `index.ts` that re-exports the same names, so no page and no test changed an import. The same comparison holds for them.
- Two layering rules on each side: no import cycle among the files of `services/` and none among the web's shipped files (a type-only import not counting), and no piece of the assistant imports its entry file. Each was broken once to see it fail; the first version of the web rule let a cycle through `api/index` pass, which that breakage showed.
- MT-06: not done, by your word. The write token is empty in both portals.
- `myown/patches/bk-11-removed-endpoints.patch` was made again: the linter had removed `type Params` from `api-hygiene.test.ts`, which the restored code uses, so the restored tree did not typecheck. A copy of the restored tree now typechecks, lints and passes (1,702 server tests, 1,173 web tests after `npm run gen:api`, which a restore needs now because the generated types follow the OpenAPI file; `openapi.check` finds 50 endpoints).
- Documents: ADR-0013 (the splits, the two rules, the linter, the numbers), setup §5, §6, §12, §24, the README, `docs/contributing.md`, `docs/getting-started.md` and the flow diagram (`WebFlow.pdf` made again and stamped), and the line citations of the ERDs, which were moved by the text of the line. The README said 35 direct dependencies; it is 40 (17 in the BFF, 23 in the web, 13 shipped), because `openapi-typescript` had not been counted.
- Server 1,687 tests in 78 files and web 1,173 in 81: 2 more on the server (layering), 1 more for the cycle rule and 20 for the CSV on the web.
- The old files are kept in `myown/refactor-backup-19oct/`; delete it when you are satisfied.

## 19 October 2026, later: six rows applied (not committed, not yet in the running portals)

At your word ("tolong apply IN 28, FR-13, IN-11, BK-13, FR-16", then "sama UX 20 ya"), with three answers from you: the four `.env.example` templates may be opened, `openapi-typescript` may be added to `web/`, and the 12 old rollback tags and the volume `proto1_pgdata` may go. Nothing was committed or rebuilt, so none of this is live.

- IN-28: setup §23 now has the rule for the rollback images and the Docker disk (keep the newest two tags of each image, remove the rest once the build after them has run for a day), and says when `proto1_pgdata` can go. At your word the 12 old tags (`2oct`, `7oct`, `13oct` of the four images) and the volume `proto1_pgdata` were removed; the demo estate it held is gone. Docker's images went from 33 entries to 21 and from 12.53 GB to 12.38 GB, volumes from 22 to 21 and from 21.07 GB to 20.87 GB: little came back, because the layers of an old tag are shared with a newer one.
- IN-11: the live stream is compressed for a screen that accepts gzip, by the BFF, with a sync flush after every frame and keep-alive. Through the nginx of the web image, on HCML's real list, the first frame went from 166,845 to 18,693 bytes on the wire (89 percent fewer) and arrived as fast as before; headless Chrome decoded it. The Problems page now opens the same stream and reads its list at once when a frame says it changed (it still polls every 30 s). The stream hook moved to `shared/hooks/useSSE.ts`.
- BK-13: an explicit `from` and `to` of `/api/graph` are widened to whole minutes (`from` down, `to` up), so requests seconds apart share one cached read. The range is checked as it was asked, and the response echoes the widened one.
- UX-20: the six sentences the server sent with "Details are in the BFF log" or a setting in them now say the same plain thing to everyone ("Tell an administrator", with a reference for an unexpected error); the setting goes to the log.
- FR-16: the explain answers, which a model writes, are checked at run time like every other answer. The web types are held to `docs/api/openapi.yaml`: `openapi-typescript` (a dev dependency of `web/`, never shipped) makes `web/src/generated/openapi.ts` from it with `npm run gen:api`, and `web/src/__tests__/openapiTypes.test.ts` makes `npm run typecheck` fail where the file promises less than the app's type needs (a field absent, optional or null in the file, or of another kind), naming the place, for each of the 36 answers `api.ts` reads and the one POST. The first run found 20 of the 36 disagreeing with the file, never because of the app (no existing web type was changed). In 7 the file contradicted what the server sends: a site code typed as text, the derived SLA's hosts and groups described as the availability rows, an interface row nobody sends, the graph's `coverage` as a number. In 13 it was less exact: fields not listed or not marked required, an AI provider that could be null, three fields missing from the aging report, a map described as a list of its elements. The file as committed in `0044efe` was not valid YAML either (two descriptions, lines 2147 and 2182: a strict parser such as Swagger Editor's rejects the whole file, and the web test now fails on such a file). The file is corrected against the server's own types. `Health` and `AcknowledgeResult` are named types in `types.ts` now. 19 descriptions in the file that YAML had silently cut at their first comma are quoted, and `openapi.check.ts` refuses a new one. The corrected file was also tried on 40 real answers of HCML's restored data (34 paths with their variants, through a throwaway validator and a read-only BFF that was stopped afterwards): all 40 fit, where the old file failed 11. The web image builds with the new lockfile (`docker build`, then `nginx -t`; the trial image was removed).
- FR-13: all four `.env.example` templates already say `PORTAL_USER=admin` (only those lines were read), so there was nothing to change.
- `docs/api/README.md` and `docs/architecture/README.md` said 41 endpoints; they say 45, as the OpenAPI check has said since 7 October.
- Server 1,685 tests in 78 files and web 1,153 in 80, with the type comparison on top, which the typecheck runs; 17 deliberate breakages (12 of IN-11, BK-13, UX-20 and the explain guards, 5 of the type check) were each caught.

## 19 October 2026: the list of what was not checked, read again, and four findings fixed (committed as `0044efe`, not yet in the running portals)

At your word ("please check this, and after check, please update md files accordingly"), the [Not checked](tracker.md#not-checked) list of `tracker.md` was checked line by line against the running portals, GitHub, the BFF logs and a throwaway portal. The check itself changed no code; its four findings were then fixed at your word ("tolong perbaiki"). You committed and pushed it all on 19 October (`0044efe`, 10:36 WIB, with the work of 15 and 16 October); nothing was rebuilt, and the running portals are still the builds of 14 October, so none of the fixes is live.

- One line of the list was wrong: "Nobody signed in". The BFF log of :8081 shows sign-ins on 15 October (08:39) and 16 October (14:43 WIB), the Internet traffic view, the SLA page, a report download and one Assistant question. The question failed: Anthropic refused the API key the container holds (401, `invalid x-api-key`), which had answered an Explain on 15 October at 11:34. Explain and the Assistant of :8081 need a valid key in `.env` and a recreated BFF (SC-01); the sentence the person saw, "Try again in a moment", is CK-03.
- Closed without a password: the dependency audits (0 vulnerabilities in all four packages), both images and `nginx -t` as `ci.yml` builds them on the 16 October layout, `npm run verify` in both copies (server 1,663 tests, web 1,122), the repo's visibility (still public, `cb97069` still opens), the `.env` modes (600), the hardening of the running containers, and axe 4.13.0 on 151 page runs: every page for the administrator, the operator and the viewer, in both themes, at 1440 px and at 390 px, and the sign-in screen. The secret scan did not run.
- Found and fixed (rows CK-01 to CK-04). CK-01: at 390 px six pages had a sideways-scrolling table that axe says the keyboard cannot reach (Chrome 155 does reach it, other browsers may not); the 19 table boxes are now one component, `TableWrap`, which gives a box that scrolls a tab stop, `role="region"` and a name, and removes them when it stops scrolling. CK-02: the sign-in screen is a `<main>`. CK-03: a refused AI key (401 or 403) has its own sentence, "The AI service did not accept the portal's key. Trying again will not help; tell an administrator.", where it read "Try again in a moment". CK-04: `/devices` is in the default lists of `page-audit.mjs` and `layout-sweep.mjs`, and `live-tools.test.ts` fails when a page of the app is missing from them. Seven server tests and ten web tests were added (1,670 in 77 files and 1,132 in 78); each fix was broken on purpose and caught; axe on the same 151 page runs found nothing after the fixes.
- The old Zabbix token of `cb97069`, tried once with your word: the Zabbix at :8080 refused it ("Not authorized"). It says nothing about another Zabbix; revoke it wherever it exists (SC-06).
- The first run of `ci.yml` on GitHub, for that push: the file is accepted (its five jobs are listed) and none of them started, because of the billing lock. Three Dependabot pull requests ran it with the same result.
- Documents corrected to match: `tracker.md` (Not checked, SC-01, SC-06, IN-30, Numbers that changed, Needs your decision), both READMEs (Known gaps, Testing, Related docs, test counts), `docs/setup/13` and `27`, `docs/api/openapi.yaml`, ADR-0005 and ADR-0011, `tools/README.md` and the test counts of the guide.

## 16 October 2026: folders, checks and the guide, rearranged (committed as `0044efe`, not yet in the running portals)

Points 2 to 5 of a review of the folder structure of both portals, done in both copies, which stay separate (rows ST-01 to ST-04 of
[`tracker.md`](tracker.md); the decision and its costs are [ADR-0013](docs/architecture/adr/0013-layers-features-and-tools.md)). Nothing
changes what the portal does: the 45 endpoints, the API contract and every earlier test are as they were, and the built stylesheet is
byte for byte the same. Committed on 19 October as `0044efe`; nothing was rebuilt.

- Server: the logic of each route moved to `server/src/services/`, and a route is now a registrar that checks the request, calls
  its service and replies. The 25 files that sat flat beside `index.ts` are in five folders by kind: `core/`, `clients/`, `domain/`,
  `security/` and `http/`, and `index.ts` is the only file at the top. `routes/` is 685 lines (it was 4,728) and `services/` holds 5,639. No route imports another. A test
  (`layering.test.ts`) fails when a file other than `index.ts` imports a route, when a service imports a route, or when a route exports more than
  its registrar, and it keeps the folders in their order (`core/` imports nothing outside itself, only `index.ts` imports `http/`).
- Web: `pages/`, `components/`, `hooks/` and `lib/` became 11 feature folders (`features/assistant`, `auth`, `dashboard`, `graphs`,
  `hosts`, `meters`, `network`, `problems`, `reports`, `shell`, `sla`) and `shared/`, and 55 tests moved to sit beside the code
  they test. A test (`layering.test.ts`) holds the table of which feature may import which. Three files that differed from a
  neighbour only by letter case were renamed: `parseMarkdown.ts`, `hostsFigures.ts` and `gaugeDial.ts`.
- The stylesheet is 18 numbered parts in `web/src/styles/`, imported in order by `index.css`. `setup.md` is the index of 35 parts in
  `docs/setup/`, each the text of one section. Only parts 11 and 19 differ between the copies, where the whole `setup.md` did, so
  `setup.md` left the list of files that may differ and those two joined it (18 files, 22 with the four `.env` files).
- The checkers moved to `tools/check/` and the scripts that read a running portal to `tools/live/` (they were in `myown/checks/`, outside
  the repository). A root `package.json` with no dependencies runs them: `npm run check`, and `npm run verify` for typecheck, lint,
  tests, build and check. `docs.yml` became `ci.yml`, with five jobs: server, web, checks, secrets and images. It has not run on GitHub
  (IN-30).
- `LICENSE` ("all rights reserved", until you choose a licence) and `SECURITY.md` (a report through GitHub's private vulnerability
  reporting, which has to be switched on in the repository's settings) are in the root: SC-30 is partly done.
- `links.check` now fails on a line citation that names a file of the repository that is gone, and skips the dated parts of the setup guide.
  It found one citation of the old `server/src/chat.ts`. The line citations of the ERDs, the flow notes and the UX notes were
  moved to the new files, and the table of Zabbix calls in the database ERD was made again from the code.
- Two server tests that read the web app's sources would have skipped without a word after the move (the report wording against the SLA
  page); they point at the new files now, and skip only where there is no web folder at all.
- Tests: server 1,663 in 76 files, web 1,122 in 77.

Where things went. The older entries below, `tracker.md` and `AUDIT_REPORT.md` name the tree as it was.

| Before | After |
|---|---|
| `server/src/routes/<area>.ts`, the logic of it | `server/src/services/<area>.ts`; the route stays in `routes/` |
| `server/src/chat.ts` | `server/src/services/assistant.ts` (the route's helpers are in `services/chat.ts`) |
| `server/src/meters.ts` | `server/src/services/meters.ts` |
| `server/src/{config,cache,staleness,gate,validate,schemas}.ts` | `server/src/core/` |
| `server/src/{zabbix,ai,limits}.ts` | `server/src/clients/` |
| `server/src/{naming,reachability,queries}.ts` | `server/src/domain/` |
| `server/src/{auth,passwords,pageAccess,viewerPolicy}.ts` | `server/src/security/` |
| `server/src/{rateLimit,requestId,compress,hostCheck,noStore,logging,shutdown,health,errors}.ts` | `server/src/http/` |
| `web/src/pages/*.tsx` | `web/src/features/<feature>/` |
| `web/src/components/*` | `web/src/shared/components/`, or the folder of its feature |
| `web/src/hooks/*` | `web/src/shared/hooks/`, or the folder of its feature |
| `web/src/lib/*` | `web/src/shared/lib/`, or the folder of its feature |
| `web/src/__tests__/<name>.test.tsx` | beside the file it tests; the ones that cross features stay |
| `web/src/styles.css` | `web/src/styles/NN-*.css`, in the order of `index.css` |
| `web/scripts/{links,diagrams,parity}.check.mjs`, `web/scripts/diagrams.stamp.mjs`, `server/scripts/{openapi,erd}.check.ts` | `tools/check/` |
| `myown/checks/*` | `tools/live/` |
| `.github/workflows/docs.yml` | `.github/workflows/ci.yml` |
| `setup.md`, section N | `docs/setup/NN-*.md`; `setup.md` lists them |

## 15 October 2026: an audit, and the Hosts view (committed as `0044efe`, not yet in the running portals)

The re-audit and MT-08 of [`tracker.md`](tracker.md). The running portals have the build of 14 October, so
none of this is live until they are rebuilt, and that needs your word.

- The audit. 112 of the 116 rows marked done hold as written. Four were partly true: BK-08 (its note was
  stale), IN-09, UX-20 and FR-13. UX-20 and FR-13 are marked partly now, so the 104 first items read 92 done,
  10 partly and 2 not done. None of the 16 rows that were open has closed.
- The assistant's stream, `POST /api/chat`, now carries `X-Request-Id` like every other reply (IN-09). It
  was the one that did not.
- The README no longer says the CSP is report-only. It has been enforced since SC-24.
- The Dashboard has a third view, Hosts, for everyone (MT-08): how many hosts are up, degraded, down or
  without data, the devices of each kind, the web scenarios that pass, fail or have no current result (the
  failed ones listed), and the ten busiest hosts by CPU and by memory. A viewer's wall turns between the
  Overview and the Hosts, an operator's between three views. A wall lists the first eight hosts of each list and
  the first three failed scenarios, because it cannot scroll. `GET /api/reports/top-hosts` and
  `GET /api/reports/web-monitoring`, both for viewers. A figure that is old is never listed, and an old
  result is never OK.
- Tests for what had none: the sign-in retry, the data stamp and the 90-second warning, the dialog focus
  trap, the skip link and the "12 of N" line. The API surface test now mounts every route module.
- Tests: 1,651 in 75 files on the server and 1,113 in 75 on the web.

## 14 October 2026, later still: the follow-ups to the meters (committed as `4b773af`, not yet in the running portals)

MT-04 to MT-07 of [`tracker.md`](tracker.md). The running portals have the build below this entry, so none
of this is live until they are rebuilt, and that needs your word.

- A link that is down says so (MT-04). Each meter reads the status item of its own interface. A link that
  is `down` or `lowerLayerDown` shows the word Down in place of the value, with no needle and a line that
  says it is not an idle link, and the sentence over the grid counts it first. A status that is old, or
  neither working nor dead, claims nothing.
- The other direction, when it matters (MT-05). Each meter also reads the item of the opposite direction
  on the same interface, on its own scale. It is written under the dial only when it is High or Critical,
  and counted in the summary, and the tile gets a red edge for Critical and an amber one for High. It assumes a link that is the same size both ways.
- A wall that turns and fits (MT-06). For an operator or an admin the wall shows the Overview and then the
  meters, 30 seconds each (`rotate=` changes the seconds, `rotate=0` stops it, `view=` holds a view), with
  a Pause button, and a click on a tab stops it. The whole wall is drawn at the scale that fits the screen,
  smaller on a shorter one and larger on a taller one (720 px to 4K), and past 35 meters they go on more
  slides. The Overview itself was taller than 1080p on HCML's real problem names, and now fits.
- A card and a link (MT-07). The Overview has a card for the internet links: how many need a look, and
  which way. The title of a meter opens the Graphs page with both directions chosen.
- Two small changes. The title of a meter wraps to a second line before it is cut, as "SITE TWO INTER…"
  cannot tell the first link from the second. The sentence over the grid starts "None high or critical"
  with a capital.
- Tests: 1,622 in 73 files on the server and 1,037 in 70 on the web.

## 14 October 2026, later: the mentor's three requests (committed as `4b773af`)

MT-01 to MT-03 of [`tracker.md`](tracker.md). Both portals were rebuilt from this work at your word
("rebuild kedua portal"), hosted at 07:11 UTC and ollama at 07:12, so all of it is live. The build is
named `ce3634d-dirty` again, as the one below this entry is, because `HEAD` has not moved: the two are
told apart by the time in the sidebar footer. The images from before are tagged `rollback-14oct-2`.

- Devices (MT-01). A page `/devices`, after Hosts in the menu: a tile for each kind of device (switches,
  firewalls, access points, radio repeaters, servers, WAN links, web services, other) with its count, how
  many have problems and how many are down, and the list of the kind chosen with the site and the template.
  The kind is the one the SLA report uses. `GET /api/devices`. Operators and admins get a Ports link to the
  Network page. Read-only.
- Show data (MT-02). One table for all the chosen items, a column group each, with the time kept in view,
  and it stays open when the selection or the range changes. It used to close itself each time, and to
  stack one table under another.
- Internet traffic (MT-03). The Dashboard has a second view, for operators and admins: a gauge for each
  gauge widget of HCML's Zabbix dashboard "Global view", with the capacity and the colour zones the widget
  gives, the value, the zone as a word and the share of the capacity, and an old reading dimmed with its
  age. `GET /api/net/meters`, which reads the dashboard with `dashboard.get`, a thirteenth read method.
  A new setting, `INTERNET_METERS_DASHBOARD` (default `Global view`).
  [ADR-0012](docs/architecture/adr/0012-internet-meters-from-the-zabbix-dashboard.md).
- Tests: 1,590 in 73 files on the server and 944 in 67 on the web.

## 14 October 2026 (committed as `4b773af`)

The batches A, B and C of the second audit, 15 of its 21 rows. Both portals were rebuilt from this work
at your word, as `ce3634d-dirty` (hosted built 05:24 UTC, ollama 05:25), so all of it is live. The images
from before are tagged `rollback-14oct`. It was committed afterwards, with the mentor round, as `4b773af`.

- Content-Security-Policy (SC-24). nginx enforces it. The header is `Content-Security-Policy` in all five
  locations that send headers, where it was `Content-Security-Policy-Report-Only`. Chrome loaded all 18
  pages under the enforced policy with no violation, and the four downloads (two CSV files, the SLA PDF
  and the Excel file) still arrived.
- Dot-files (SC-28). A path with a dot-file segment (`/.env`, `/.git/config`, `/x/.hidden`) answers 404
  and not the home page. `/bff` is left to the BFF. Tried in a throwaway nginx, `%2e` spellings too.
- Cache and HSTS (SC-27). Every `/api` reply except the public health check carries
  `Cache-Control: no-store`, unless the route chose its own. The BFF no longer sends
  `Strict-Transport-Security` over plain HTTP, so the TLS guide now says the proxy sends it.
- Errors (SC-29). When Zabbix cannot be read, a reader is told "The data source is not answering." with
  the request id, on the pages, the live stream and the Assistant. The method name, the setting and
  Zabbix's own words are in the BFF log, on a line with the same id. The `error` codes did not change.
- Heavy reports (BK-15). At most two of the noise, availability and capacity reports read Zabbix at once.
  The others wait their turn, and a cached answer never waits. No status code or field changed.
- Graphs and Latest data (FR-19). When the host list cannot load they say so, and Graphs says when the
  list is empty. They kept "Loading hosts…" for good, or showed empty menus and no message.
- Small things. A readable placeholder in the dark theme (UX-25). The Month label is tied to its menu, the
  Method heading is plain text, and every field has an `id` or a `name` (UX-26). Controls reach 24 px
  (UX-27: port buttons, sort headers, the Services arrows, the SLA list, the chart chips). "1 host" and
  not "1 hosts" in twelve places (UX-28). Three unused exports gone (BK-16). `.nvmrc` and `engines`
  (IN-29). A line citation that ran past its file, and a check in `links.check.mjs` so none can (IN-32).
- Dependencies (SC-26). `npm audit fix` in both folders moved `fast-jwt` to 6.3.4 and `source-map-js` to
  1.2.2. Only the lockfiles changed, and `npm audit` reports 0.
- Files (SC-25). The four `.env` files are mode 600, and the backup guide says to check it.
- Tests: 1,537 in 70 files on the server and 844 in 59 on the web.

## 13 October 2026 (cef91b3, ce3634d)

The running portals were built from this work a few hours before it was committed, so they report
`748136c-dirty` until they are rebuilt. The screenshots came in the second commit.

- Narrow screens (UX-14). The Dashboard and the Inventory report no longer run past the window at 390
  and 320 px: the two-column grid lets its columns shrink, the host-group table scrolls inside its card,
  and the Inventory controls wrap. The Actions column of the Problems, Hosts and Sites, Latest data,
  Capacity and SLA tables stays in view while the rest of the table scrolls, so Explain, Ack and the
  graph links are no longer past the card's edge.
- Charts (UX-17). A "Show data" button under each chart opens the plotted values as one table per
  series, for a keyboard or a screen reader.
- Network (UX-18). A port is opened with a button named by the interface, not with a focusable row. A
  selected device card keeps its selection and its keyboard focus ring apart. Four facts that lived only
  in tooltips are also text for a screen reader: why a refresh failed, that a figure rests on partial
  data, the devices-with-data count on the SLA page, and what "degraded" means on a site.
- Explain and the Assistant (IN-21). A note says when the AI model is not answering, from the `model`
  field of the readiness check. The buttons stay, because that check is cached.
- Type scale (UX-21). The two inline `12.5px` sizes are `12px`, and `tokens.check.mjs` lists no
  exceptions.
- Diagrams (IN-18). Each `.mmd` ends with a `%% source-hash:` stamp, and the new
  `web/scripts/diagrams.check.mjs` fails, in CI too, when a source was edited after its stamp.
  `web/scripts/diagrams.stamp.mjs` sets the stamp after a re-render.
- Screenshots. `docs/screenshots/` holds seven images of the main pages, and the README and the
  getting-started guide show some of them. Every host name, address and interface description in them
  is a stand-in, and each image was looked at before it was added.
- Tests: 1,508 in 66 files on the server and 822 in 57 on the web.
- Documents: the wording and code-comment passes of 12 and 13 October, `ayoyo_1.1.md` renamed
  `tracker.md`, and this file.

## 12 October 2026 (748136c)

Hardens sign-in and the containers, adds the SLA report export, and refreshes the docs. Since 24 September:

- 2 October. The monthly SLA report downloads as a PDF and as an Excel file.
- 7 October. Sign-in uses a session cookie with a CSRF header and scrypt password hashes. The containers
  run with a read-only root, no capabilities and no new privileges. Every reply carries a request id,
  `/api/ready` answers 503 while Zabbix cannot be read, the live stream carries only what the Dashboard
  reads, and a viewer no longer sees network interface data. Below 720 px the sidebar is a rail.
- 12 October. Every CI action is pinned by commit SHA, Dependabot and a secret scan were added, and the
  base images are pinned by digest. `BUILD_COMMIT` and `BUILD_TIME` reach the sidebar footer. Five unused
  endpoints were removed, every data answer is checked at run time, the fonts are served from this site,
  and outages that ended inside a report window are counted.

## 24 September 2026 (a7fdbd1)

The README explains every term and has a glossary.

## 23 September 2026 (8aa65d5, 2b14b90)

The SLA engine, a provider-neutral AI layer (the hosted API or a local Ollama model), a test suite, and
the documentation layer.

## 7 September 2026 (b4a4059, cb97069)

First commit, then the service-centric views, reporting, role-based access and the AI explain layer.
