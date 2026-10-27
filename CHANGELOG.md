# Changelog

What changed in the portal, newest first. `hcml-portal` and `hcml-portal-ollama` hold the same code
and share this file; the files that differ by design are listed in
[`tools/check/parity.check.mjs`](tools/check/parity.check.mjs). Item ids such as UX-14 are the rows of
[`tracker.md`](tracker.md).

A build is named by the commit it was made from. The sidebar footer shows it once someone is signed in,
and so does a signed-in `/api/health`. A `-dirty` suffix means the build was made from a working tree
with changes that were not committed. The commit is the version; since 22 October the commit that went live is also tagged `live-<date>`.

## 27 October 2026, morning: the fix list of 26 October applied (IN-39, BK-20, UX-36, UX-37, BK-14, SC-30); live as `0aa74d2-dirty`, not committed

At your word, "please aplied fully and fix all of these list", with your answers: count the hours off HCML's network as no data, keep `/api`, keep the OpenAPI file written by hand, and keep the licence as all rights reserved. Both copies' `tracker.md` and `CHANGELOG.md` were backed up first in `myown/backup-27oct-fix-list/`; the code before is commit `0aa74d2`.

- IN-39, the false hours. A new setting, `SLA_NO_DATA_WINDOWS`, names spans the SLA figures treat as hours with no data: the strict method leaves them out, HCML's method counts them as up, and the legacy basis counts no downtime in them (`core/config.ts`, `sli/engine.ts`, `services/availability.ts`). The SLA pages, the Services tree and the workbook say which spans were declared. Both root `.env` files declare 26 October 16:10 to 21:03 WIB. Nothing in Zabbix changed, and a value the BFF cannot read stops it at start-up with an example.
- IN-39, the indicator. `/api/freshness` also says how many devices answered their last ping. When at least 10 were pinged and a fifth or fewer answered, the Dashboard, the wall screen and the Problems page say that Zabbix cannot reach the network and that its down hosts and new problems are most likely not real (`shared/components/CollectorNotice.tsx`). The Problems page now also says when Zabbix has stopped collecting.
- IN-39, the pause. `myown/checks/zabbix-source/collector-guard.sh` pings eight of HCML's core devices. It stops the local Zabbix server after two rounds with at most one answering, starts it again only if it was the one that stopped it, once three answer, and logs each change with the span to declare. Tested on a throwaway container. Not installed: Claude Code's permission check refused the launchd install, so it waits for your command (`collector-guard.sh --install`). One round run by hand resumed the collector at 09:03 WIB, with 8 of 8 probes answering.
- BK-20. The Assistant's snapshot states counts over every open problem: hosts with none, the busiest hosts, the oldest problems still open. The problem list's title says how many it holds, its last line says its counts are of the problems not listed, and a question naming a host gets that host's count. On the local model: 8 of 8 questions right on the local copy's 755 problems, where 26 October had 3 of 7.
- UX-36 and UX-37. Under a finger, dropdowns are drawn without the native look, with an arrow in their text colour, so WebKit makes them 44 px tall; short port buttons are 44 px wide. On emulated phones no control is under 44 px.
- BK-14. Each GET route that reads a query declares its names: a name sent twice is a 400 that says so. `openapi.check.ts` holds those names to the file and its 400s (three reports gained theirs), and a new test asks for every operation on a made-up estate and checks status and body against the file (`openapi-contract.test.ts`), read from a JSON copy that `npm run gen:api` now writes. Decided: no `/api/v1` prefix, and no generated spec.
- SC-30. The licence stays "all rights reserved". Not done: GitHub's private vulnerability reporting (no `gh` here; Settings, Code security, Private vulnerability reporting, Enable). A draft request to HCML is in `myown/documents/notes/hcml-permission-request-2026-10-27.md`.
- Counts: server 1,787 tests in 80 files, web 1,209 in 83.
- Live since 08:44 WIB: `deploy/rebuild.sh --allow-dirty` rebuilt both portals as `0aa74d2-dirty` after `npm run verify` passed in both copies, and both `.env` files were checked to parse first. The images it replaced are tagged `rollback-27oct`; to go back, `docker tag <image>:rollback-27oct <image>:latest`, then `docker compose up -d --no-build` in that copy.
- Checked signed in on both portals: `tools/live/signedin_check.py` 7 of 7, 38 of 38 page loads clean in Chrome, the footer naming the build, the new notices on the live pages. Not checked: Firefox (refused outside the sandbox), the meters on live data (the site firewalls do not answer SNMP from this Mac), and the workbook in Excel, which held your own workbook and answered no script.

## 26 October 2026, late at night: the rest of the not-checked list checked, and option C paused off HCML's network (documents only)

At your word, the items of the not-checked list again. No code changed. Rows BK-20, UX-36, UX-37 and IN-39 of [`tracker.md`](tracker.md) are new, and its Not checked section has the details.

- The schema PDFs of both copies match their sources: all six show every entity, attribute, comment, relationship and cardinality of their `.mmd`, and no other word.
- Zabbix 7.0.30 accepts a repeat acknowledge without an error and files it as a message, so a second operator sees success and the problem stays acknowledged. Tried on a problem the local copy had opened, which was unacknowledged again afterwards.
- BE-22: the Assistant answers what its data states outright and answers questions that need the whole list from its 40 problems, as if they were all (BK-20, open).
- Emulated phones (an iPhone 15 in WebKit, a Pixel 7 in Chrome) loaded the 19 pages with no error and no sideways scroll; WebKit keeps the dropdowns at 20 to 22 px (UX-36) and short port buttons are narrow (UX-37). The accessibility tree gives every page one heading 1, one main and the navigation, and names every control. Firefox could not start in the sandbox these checks run in.
- This Mac left HCML's network at about 16:10 WIB, after which the local copy recorded every device as down. At your word, "Pause it now", its Zabbix server was stopped at 21:03 WIB (IN-39); start it again with `docker start proto1-zabbix-server-1` once back on HCML's network.
- Still yours: the live portals signed in (your password), what Excel showed on your own download of the SLA report, and whether operators want Indonesian (HCML).

## 26 October 2026, at night: the `.env` fixed and both portals rebuilt from `0aa74d2` (live, tagged `live-2026-10-26`)

At your word, "fix the env and rebuild", after you committed the day's work as `0aa74d2` ("fix: feature audit findings, theme before first paint, SLA workbook and trigger count") and pushed it.

- `hcml-portal/.env`: line 9, a 5-character fragment Docker could not read, removed. In both copies' `.env`, `ZABBIX_WRITE_TOKEN` emptied again: it held a Super admin token of HCML's Zabbix, which would have turned writing on. Nothing else in either file changed, and no value was printed.
- `deploy/rebuild.sh` at 20:42 WIB, from the clean tree: its gates passed (parity, and `npm run verify`: server 1,704 tests, web 1,196), the images it replaced are tagged `rollback-26oct-3` (hosted) and `rollback-26oct-2` (ollama copy), and both copies came up healthy as `0aa74d2` (`BUILD_TIME=2026-10-26T13:42:24Z`). The local tag `live-2026-10-26` marks the commit; `git push origin live-2026-10-26` makes it public.
- What an anonymous caller sees on :8081 and :8082: health 200 with `writeBack: false`, the meters 401, `/.env` and `/.git/config` 404, a Content-Security-Policy, the bundle `index-DIo-wnM3.js`, and `/theme.js` served as JavaScript.
- To go back to the build of 11:59: `docker tag <image>:rollback-26oct-3 <image>:latest` (hosted) or `:rollback-26oct-2` (ollama copy), then `docker compose up -d --no-build` in that copy.
- Not checked: the pages behind the sign-in on this build, which needs your password (`tools/live/signedin_check.py`).

## 26 October 2026, later in the evening: the Dashboard counts the triggers of monitored hosts (committed as `0aa74d2`; live since 26 October, 20:42)

At your word, "please choose A", for row BK-19 of [`tracker.md`](tracker.md). The two files were backed up first in `myown/backup-26oct-bk19/`.

- The Triggers card counts the triggers of monitored hosts, as the Hosts and Items cards count monitored ones (`services/reports.ts`, `trigger.get` with `monitored: true`). On the local copy it reads 15,111 instead of 18,104: the 2,709 triggers of templates watch no host, and the other 284 are disabled or sit on a host or item that is not monitored. A read-only Zabbix account now gives the same figure.
- A test in `routes.test.ts` asks for all three counts to be of monitored ones. Counts: server 1,704 tests in 79 files, web 1,196 in 83.
- Live since 20:42, once the `.env` was fixed (the entry at the top).

## 26 October 2026, evening: the SLA workbook's two issues fixed, and the not-checked list checked (committed as `0aa74d2`; live since 26 October, 20:42)

At your word: the items of the not-checked list, and "fix: SLA workbook". Rows BK-18 and BK-19 of [`tracker.md`](tracker.md), and its Not checked section. The two source files were backed up first in `myown/backup-26oct-sla-workbook/`.

- The workbook formats durations `[h]\:mm\:ss`, so an Excel whose time separator is a dot (Indonesian) shows 3737:32:19, not 3737.32.19, and its Summary prints on one page (`export/xlsx.ts`). Checked in Excel: 211 durations with colons; 11 pages instead of 12 for August, September and October; on screen it opens on the Summary, with the headers frozen and no cell showing `###`.
- The page audit ran as the viewer, the operator and the admin, in both themes: nothing but the expected refusals above each role, and two flags that are not faults (the coloured dots of the Maps legend; 16 px checkboxes inside 36 px labels).
- A read-only Zabbix role was tried on the local copy and deleted after: none of the 14 read methods is refused, and writes are. `apiinfo.version` cannot be in its allow list.
- HCML's Zabbix runs in English for all its users, and Zabbix 7.0 hides its Indonesian translation. The meters cannot be checked on live data while the site firewalls do not answer SNMP from this Mac.
- New open row: BK-19, the Dashboard's Triggers card counts the 2,709 triggers that belong to templates.
- Not done: the live portals signed in, which needs your password.
- Counts: server 1,703 tests in 79 files, web 1,196 in 83.
- Live since 20:42, once the `.env` was fixed (the entry at the top).

## 26 October 2026, late afternoon: the count waits for the list, and the chosen theme is there from the first paint (committed as `0aa74d2`; live since 26 October, 20:42)

At your word, "please fix the first point and the third point": the first and third of the three rows found while testing, UX-34 and UX-35 of [`tracker.md`](tracker.md). IN-38 stays open. Both copies were backed up first in `myown/backup-26oct-ux34-ux35/`.

- The Problems count is drawn once the list is in, so it no longer reads "0 matching" while the list loads, or beside the error when it cannot load (`features/problems/Problems.tsx`).
- `web/public/theme.js`, a plain script in the `<head>` of `index.html`, puts the theme picked in the portal on `<html>` before the first paint, so a page opens in it instead of fading over from the computer's colours. A file rather than inline code, so the CSP stays `script-src 'self'`. A switch in the picker still fades.
- Counts: web 1,196 tests in 83 files (a test file for the script, two tests for the count); server 1,701 in 79.
- Live since 20:42; until then the rebuild waited on line 9 of `hcml-portal/.env`.

## 26 October 2026, afternoon: the feature audit's nine findings, fixed (committed as `0aa74d2`; live since 26 October, 20:42)

At your word, "please all ofthem getting fixed", for the nine findings of that day's feature audit. Rows IN-33 to IN-37, BK-17, UX-32, UX-33 and SC-31 of [`tracker.md`](tracker.md), and three new open rows, UX-34, IN-38 and UX-35. Both copies were backed up first in `myown/backup-26oct-audit-fixes/`.

- The Assistant's site data starts with the two rankings people ask for, "Most open problems" and "Most unreachable hosts", so a small model no longer takes the severity order for a ranking (`services/assistantSnapshot.ts`).
- The Problems count says how many are still open, for example "666 matching: 663 open, 3 just resolved" (`features/problems/Problems.tsx`).
- A page above the signed-in role says whom it is for, as a status, instead of "Couldn't load data" (`shared/components/states.tsx`).
- Sign-out ends the session it carried: the BFF refuses a signed-out token until it expires, as a cookie or a header, and each sign-in has its own `jti` (`security/auth.ts`). The list is kept in memory, so a restart of the BFF forgets it.
- The local Zabbix copy that option C polls from this Mac was adjusted where polling from here raised false problems: the ping threshold, the SNMP timeout, more unreachable pollers and pingers, the Zabbix machine's own agent, the Intranet check, and a restart policy. HCML's Zabbix was not touched; each value the copy had before is in `myown/documents/notes/zabbix-local-copy-changes-2026-10-26.json`. The 13 site firewalls still do not answer SNMP from here, so their interface data and the Internet traffic meters stay empty under option C (IN-34).
- Counts: server 1,701 tests in 79 files, web 1,186 in 82. `npm run verify` passes in both copies.
- Not live at first: `deploy/rebuild.sh --allow-dirty` started at 15:06 WIB, passed its gates, tagged the hosted copy's images `rollback-26oct-2` and stopped at `docker compose up`, which cannot read line 9 of `hcml-portal/.env` (IN-38). The live portals kept the build of 11:59, and nothing on them changed. All of it went live at 20:42 (`0aa74d2`), once the `.env` was fixed.

## 26 October 2026, at noon: both portals rebuilt with the day's changes (live as `7bc48db-dirty`, committed afterwards as `dd58bf5`)

At your word, "please applied the changes", with HCML's answer on the two open points: the IT team sees the new look at once, and the white sidebar logo, "they accept it".

- `deploy/rebuild.sh --allow-dirty` rebuilt both copies from the working tree at 11:59 WIB (`BUILD_TIME=2026-10-26T04:59:51Z`), so the build is labelled `7bc48db-dirty` and gets no `live-` tag. Its gates passed: parity, and `npm run verify` (server 1,697 tests, web 1,182).
- The four images it replaced are tagged `rollback-26oct`. To go back: `docker tag <image>:rollback-26oct <image>:latest`, then `docker compose up -d --no-build` in that copy ([setup 23](docs/setup/23-hardening-timeouts-rate-limiting-headers.md)).
- Both copies came up healthy, and an anonymous caller sees on each: health 200, the meters 401, `/.env` and `/.git/config` 404, a Content-Security-Policy, the bundle `index-CrZqQU6d.js` and the stylesheet `index-Bf1gdQ8y.css` (the new tokens, the touch part and the danger button are in it). The sign-in page shows the new look, with fields and button 36 px.
- Not checked yet: the pages behind the sign-in, which need your password (`tools/live/signedin_check.py`). On a visit before signing in, the browser logs 401s for the question of who is signed in and, at times, for the Dashboard's first requests, which leave before that answer; that code is older than this change.

## 26 October 2026, later still: the design system's twelve gaps, fixed (committed as `dd58bf5`; live since 26 October as `7bc48db-dirty`)

At your word, "Audit: which audit numbers to fix. all of it". Row UX-31 of [`tracker.md`](tracker.md), and [DESIGN.md section 11](DESIGN.md) for each fix and the measurements. Both copies were backed up first in `myown/ui-backup-26oct-2/`.

- New tokens in `01-tokens.css`: half steps of 2, 6 and 10 px and a 48 px step for spacing; weights, line heights and uppercase tracking; two control heights (28 and 36 px), the 24 px target and the 44 px one for a finger; a disabled opacity; seven layers; four breakpoints; and durations for the spinner, the streaming cursor and the wall's highlight. Every raw value in the stylesheet moved onto them, the ones between steps to the nearest step.
- The KPI stripe shows only where a state sets it. Buttons, fields and segmented options take the two heights. A new part, `19-touch.css`, makes every control at least 44 px where the pointer is coarse; desktops and the wall keep their density. One disabled look for every control. A danger button, which Confirm in the Acknowledge dialog becomes while Close problem is ticked. The media queries close a gap at 1100 to 1101 px.
- `tokens.check.mjs` fails a value between steps on each new scale, in the stylesheet and in inline styles, a raw z-index and a media query off the breakpoints, with fixtures that prove each rule fails; `tokens:export` writes the new families. Comments new in this change were held to one or two lines (antislop-code).
- Counts: web 1,182 tests in 82 files (the danger button, the breakpoint token, the highlight's duration and the touch targets); server 1,697 in 79. The stylesheet has 20 numbered parts.

## 26 October 2026, later: soft depth, motion and a white sidebar logo (committed as `dd58bf5`; live since 26 October as `7bc48db-dirty`)

At your word, "A with edges for the real portal" and "logo 1", with your answers to the four questions recorded in [DESIGN.md section 10](DESIGN.md). Row UX-30 of [`tracker.md`](tracker.md). Both copies were backed up first, outside the repositories, in `myown/ui-backup-26oct/`.

- The page and its cards are one soft plane (`#E3E9F1` light, `#14263A` dark), separated by depth: what stands above the page is raised, a field, a segmented track and a chosen option are pressed in. Tokens in `web/src/styles/01-tokens.css`, rules in the new part `18-soft-depth.css`. The navy chrome, the blue, the severity and chart colours and the light, dark and system picker are unchanged.
- Controls keep a 1px edge at 3:1 (`#748496`, `#517492`), because a shadow alone measured 1.20 to 1.59:1. Three text colours moved a step to keep 4.5:1 on the soft plane: the selected-row tint (`#D8E2EE`), the green status text (`#217548`) and the red one (`#BA372E`).
- Motion 2: a page's content rises in once, a Dashboard view fades in when its tab is chosen, controls lift under the pointer and press in when used, and a theme switch fades the colours. Nothing loops, reduced motion stops all of it, and the wall keeps only its highlight of a problem that appears or clears.
- The expanded sidebar shows the logo in white with no plate (`web/public/logo-white.png`, 504 x 289, made from the logo's own transparency, 15.54:1 on the chrome); the sign-in card, the rail and the favicon keep the original. It recolours HCML's trademark; HCML accepted it the same day ("they accept it").
- The SLA report files keep white paper, light rows and solid lines, since paper cannot show depth and an Excel cell cannot take a translucent line; their ink follows the two darker status colours (`server/src/export/theme.ts`, whose test now says which colours are the paper and which are copies of a token).
- Counts: server 1,697 tests in 79 files (the report-palette test compares four colours fewer and checks the paper); web 1,177 in 82 (a test file for the logo component and a sidebar test). The images in `docs/screenshots` and `pic/10` still show the look before this change.

## 26 October 2026: the Mac restarted and the Zabbix containers came back with Docker, and what was never checked was checked as far as it can be (committed as `dd58bf5`)

At your word ("please inspect and check" the list of what was never checked, and "please do the housekeeping left", with one item kept: the two `refactor-backup-*` folders stay). No code changed. Rows IN-27, SC-23, SC-06 and IN-30 of [`tracker.md`](tracker.md) and its list of what was not checked carry the details.

- IN-27, the first real restart: the Mac had restarted at about 06:57 and Docker Desktop did not start by itself, so `docker ps` could not reach the daemon and :8080, :8081 and :8082 answered nothing. Docker Desktop was opened at 07:16, and within 11 seconds of the engine coming up `proto1-mysql-1`, `proto1-zabbix-web-1` and the four portal containers were running and healthy by themselves; `proto1-zabbix-server-1` stayed exited. What is still unread is Docker Desktop's "Start Docker Desktop when you sign in": it looks off.
- After that the live portals answer as on 22 October (health 200, 401 on the meters, devices and Hosts-view routes, 404 on `/.env` and `/.git/config`, a Content-Security-Policy, `index-D5dlTC9A.js`, `BUILD_COMMIT=1b15d95`) and their logs hold only information lines.
- Housekeeping: the four `rollback-14oct` image tags are removed, so each image keeps `rollback-14oct-2` and `rollback-22oct` (the rule of IN-28); the tag `live-2026-10-22` is pushed to GitHub; the two `refactor-backup-*` folders stay.
- Signed-in checks: `tools/live/signedin_check.py` passed 7 of 7 on a throwaway portal built from the same `server/` and `web/` (only a test file differs from `1b15d95`), with an account of my own and the write token blank. Later that day you gave me the password, and the same script ran on the live portals: 7 of 7 on :8081 and 7 of 7 on :8082 (build stamp `1b15d95`, a PDF and a workbook through the front, a stream held for 80 seconds). In Chrome, signed in as the admin, all 19 routes loaded at 1440 and 390 px on each portal with no console error, no failed request and no sideways overflow, the Dashboard's three views (Overview, Hosts, Internet traffic) each opened, and the sidebar footer reads `Build 1b15d95, 22/10/2026, 09.35.44 WIB` on both. No question was put to Explain or the Assistant.
- Excel: the August workbook, built from the restored data by that throwaway portal, opened in Microsoft Excel with no repair prompt; Excel's own PDF render of its seven sheets was read page by page and nothing is cut or hidden.
- Browsers: Lighthouse 13.5.0 (desktop) gives accessibility 100 and best practices 100 on nine pages, performance 96 to 100. WebKit, the engine of Safari, loaded 19 routes and the sign-in screen at 1440 and 390 px with no console error, failed request or sideways overflow. Firefox 157 would not start on this Mac. A screen reader, a real phone and the wall on a real screen stay unchecked.
- Secrets: gitleaks 8.30.1 found the token in `cb97069` (both `.env.example`, nowhere in `HEAD`) and one made-up JWT in a test, a false positive. The repo is still public.
- GitHub Actions: the pushes of 22 October (`e7d6a5c`, `7bc48db`) started five jobs each and none ran: the billing lock stands (IN-30).
- Zabbix, read calls only: version 7.0.30; "Display OK triggers for" is 5 minutes; history is kept 31 days, so a poller switched on today would delete the restored history (ADR-0008); 5 of 666 open problems are acknowledged; there are five API tokens, all owned by Super admin users, three of them never used (SC-23).

## 22 October 2026: both portals rebuilt and live, the Zabbix containers restart with Docker, a rebuild script, the Internet traffic screenshot dropped (the script and the documents are committed as `e7d6a5c`; the portals run `1b15d95`, which that commit does not change)

At your word ("please applied IN-01 and IN-27"), after you answered the open questions of the documents round and I argued with several of the answers. The account is [§39 of the guide](docs/setup/39-what-changed-on-22-october-2026-the-answers-the-restart-policies-and-the-rebuild.md). Rows IN-01, IN-27 and DC-02 of [`tracker.md`](tracker.md).

- IN-01: both portals were rebuilt from the clean commit `1b15d95` at 09:36 WIB (no `-dirty`: the first build named by a clean commit, the earlier ones read `uncommitted` or `-dirty`), so everything written since the build of 14 October is live: the Hosts view, the follow-ups to the meters, the audit fixes of 15 to 19 October, the folders, the CSV of Show data and the narrow header. The images they replaced are tagged `rollback-22oct`. It was done by the new `deploy/rebuild.sh`: a gate (parity and `npm run verify`), the rollback tags, hosted and then local-model, the wait for health, what an anonymous caller sees, and the annotated tag `live-2026-10-22`, which it never pushes. `--dry-run` prints what it would do, and `rebuild-script.test.ts` (12 tests) runs it as a dry run; eleven deliberate breakages were each caught, and the first run found a real fault, an endless search for a free rollback tag, now bounded. Nothing that needs a sign-in has been looked at: `tools/live/signedin_check.py`, with the password in your own shell.
- IN-27: `proto1-mysql-1` and `proto1-zabbix-web-1` are `unless-stopped`, set on the running containers with `docker update` (no restart) and in `Proto1/docker-compose.yml`, which is outside both repositories. `proto1-zabbix-server-1` stays off. [`docs/operations/after-a-restart.md`](docs/operations/after-a-restart.md) has the order and a check. An actual restart was not tried.
- DC-02: `docs/screenshots/internet-traffic.png` is removed, with the sentences that said the Dashboard's Internet traffic view is shown there, so `docs/screenshots` has ten images. The image is still in the commit of 20 October (`1b15d95`), which is pushed, so it stays public in history until the repository is made private (SC-06) or the history is rewritten. `pic/` is not in git and keeps its own shot of the view.
- Your answers: MT-05 (the links are the same size both ways) agreed, and ADR-0012 says so; MT-01 (ports) yes to all three uses, not built; MT-03 and IN-13 avoided for now; MT-04, MT-06 and MT-08 recorded. The evidence behind them names HCML's links and is kept outside the repository.
- Counts: server 1,700 tests in 79 files (12 for the script), web 1,173 in 81; the guide has 39 parts.

## 20 October 2026: the documents and the screenshots brought up to date, and a check for the numbers (committed as `1b15d95`, live since 22 October 2026)

At your word ("update dokumentasi untuk sekiranya mengikuti update terbaru", for `pic/` and `docs/` of both copies), and then "tolong update dan maksimalkan juga", after I had listed what my first pass had only searched and not read. No behaviour changed: one line of the Dashboard's header and one checker were added. Rows DC-01 to DC-03 and UX-29 of [`tracker.md`](tracker.md); the account is [§38 of the guide](docs/setup/38-what-changed-on-19-and-20-october-2026-the-splits-the-linter-and-the-screenshots.md).

- Screenshots, `pic/10` in both copies: 36 images each, with the real names, numbered as in `pic/09` (which was left as it was) with six more: the Devices page, the Dashboard's Hosts and Internet traffic views, Show data with its CSV button, and the wall on the two views. Taken from portals started for the purpose from the working tree (the write token empty, no request but a GET after sign-in), not from the running containers. The Acknowledge dialog came from a second one with a made-up write token that Zabbix would refuse, opened and closed and never confirmed. `pic/README.md` says what each number is and how to take them again. `pic/` is not committed.
- Screenshots, `docs/screenshots`: the seven images of 13 October taken again (they showed the build before the Hosts and Internet traffic views and the CSV button) and four added, `dashboard-hosts`, `internet-traffic`, `devices` and `graphs-show-data`, 11 in all and the same in both copies. The title of each Internet traffic meter is replaced too (`link-` and three digits); that image shows the real capacity and last reading of each link, which `docs/screenshots/README.md` says. Every image was looked at after the scan found no real name.
- The capture tool and its name rewriter (outside the repository) gained the six shots and the meter titles; the rewriter's self-test has nine more checks, and six deliberate breakages of the new code were each caught.
- Documents corrected against the code: the Zabbix methods (the portal calls 15, 14 that read and one that writes; five documents said 13 and one or 14, and the database ERD's table of calls lacked `dashboard.get` and had two numbers moved); the line citations of the UX note and the flow note that no longer landed; the logical model (46 entities and 54 relationships, from 43 and 49: `METER`, `WEB_SCENARIO`, `TOP_HOST`) and the conceptual model (27 entities and 34 associations: the Internet Meter, with *reads*), both rendered again and stamped; the assistant snapshot's budgets (the old per-list counts of 40 problems and 30 sites were gone from the code); the availability and alert-noise parts (BK-04 replaced the single page of 10,000 events); the roles table; PostgreSQL in the big-picture diagram (MySQL); the demo estate said to be parked in a volume that was removed on 19 October; the notes that said nothing checks the type mirror (since FR-16 something does); "no CSV" sentences, which are about the SLA report only; the number of pages (19, in three places) and the bundle sizes (222 kB JavaScript and 47 kB CSS to start, a page 1 to 28 kB); `getting-started.md`, which ran the root's checkers from `server/` and `web/`; the glossary (the meter, the wall, the device kind, the guard, the generated types, the layers); the dependency count (40, 13 shipped; the README said 35).
- The guide has three parts more: §36 (16 October, the folders), §37 (19 October, the check and six rows) and §38 (19 and 20 October). Its count is 38 parts in `setup.md` and every document that states it.
- The second pass (DC-03). Everything the first had only searched was read in full, with both READMEs: the ADRs, §8, §13, §16, the operations notes, the ERD documents and the dated parts. It found what a search for numbers had not. ADR-0006 said the acting user is forgotten and that Zabbix has nowhere to hold it, which SC-08 had made untrue on 7 October (every acknowledgement text starts with `[portal:<user>]`). "The read token cannot write" was in ADR-0001, ADR-0006, getting-started, the flow note and §1, although both tokens belong to a Super admin (SC-23): each now has a dated amendment or a condition, and both READMEs name it under known gaps. §20 listed 6 of the 9 keys a write drops. The glossary of both READMEs said 11 decision records (13), the Fastify row 18 route modules and 40 endpoints (22 and 39), and the two clients 174 and 664 lines (171 and 754); the chart chunk was 608 kB in one row and 612 in another; the hosted README lacked the `HOST` setting; the ollama README listed five checkers with a path that stopped existing on 16 October, called itself "the reference copy" and said the checkers were seven. The endpoint table of §5 had no row for `/api/ready`. The overview diagram of `erd.md` lacked the meter entities, two citations of `reachability.ts` in the conceptual model had never matched the file, and two of its counts had not followed the model. ADR-0012 gave 14 September for the day local polling stopped (ADR-0008: 17 September). Dated parts are history and were left as written, except a "Since then" at the end of §32.
- A check for the numbers (DC-03): `tools/check/facts.check.mjs`, in `npm run check`, in `verify` and in the `checks` job of CI. It reads the code for the endpoints (and how many are GET), the route modules, the Zabbix methods, the parts of the guide, the ADRs, the pages, the dependencies, the test files, the stylesheet's parts, the CI jobs, the checkers and the entities of the three ERDs, and the documents for the sentences that state them, and says where they differ. Also: every endpoint of the spec has a row in the endpoint table of §5; the table of Zabbix calls in the database ERD lists exactly the lines of `server/src` that name each method; the README's Configuration section names every environment variable the BFF reads. A sentence that tells of the past is left alone (8 today). Eleven deliberate breakages of the real documents were each caught, and it found a stale count in the ollama copy's index at once. It reads no meaning, and it does not count tests.
- Counts: server 1,688 tests in 78 files (one more: the row of `ci-workflow.test.ts` for the new checker), web 1,173 in 81. `links.check`, `facts.check`, `diagrams.check`, `erd.check` and `parity.check` pass in both copies.
- Seen while shooting (UX-29): at 390 px and below the Dashboard's "Live problems" heading and its "Updated" time touched each other (0 px apart; both wrapped at 360 and 320 px). That header now uses the `.panel-head` class that seven other panels use, so under about 430 px the time sits 12 px below the heading and nothing wraps (`Overview.tsx`, one line; yours to keep or revert). An earlier version of this entry also said the Problems table hid Explain and Ack past the right edge at 1440 px. That was wrong: the Actions column is sticky (UX-14) and Explain stays at the box's right edge at every width I measured.

## 19 October 2026, last: a server linter, a CSV of Show data and three splits (committed as `5cf5268`, live since 22 October 2026)

At your word ("tolong lakukan ini, untuk MT02 dan MT06, tolong konfirmasi ke saya"), the five things left out on purpose on 16 October. I asked about MT-02 and MT-06, and you answered: MT-02 yes, as I proposed; MT-06 "Tunda lagi". Nothing was rebuilt, so none of this is live; you committed it that evening as `5cf5268`, with the round below.

- ST-06: the server has a linter. `server/eslint.config.js` (flat config: ESLint's and typescript-eslint's recommended rules, no warning allowed), `npm run lint` in `server/` and at the root, and a step in the `server` job of `ci.yml`. The first run found 22 findings (unused imports and types, patterns with control characters or runs of spaces, generators that never yield, and a few others); all are fixed, and eight `eslint-disable` lines are left, each with its reason. Four dev dependencies, none shipped: `eslint`, `@eslint/js`, `typescript-eslint`, `globals`. A trial build of the server image passed and its shipped layer holds no ESLint; the trial image was removed.
- MT-02: Show data has a Download CSV button, there also while the table is closed. One file for all the selected items, joined on time as the table joins them; raw numbers with the unit in the column heading; the time in the SLA zone; `hcml-graph-2026-10-19.csv` for a day, `hcml-graph-2026-10-18-to-2026-10-19.csv` for a longer window. It is written by the one CSV writer, which moved from `features/reports/` to `shared/lib/` and keeps its guard against spreadsheet formulas. Driven in headless Chrome: the file arrives with the rows of the table. `tools/live/download-check.mjs --graph` checks it on a running portal.
- ST-07: `services/analytics.ts` is `incidents`, `availability`, `noise`, `aging`, `capacity` and `reportPolicy`; `services/assistant.ts` is six `assistant*.ts` pieces behind `assistant.ts`, which stays the one entry that the route, `chat.ts` and the tests import and mock. Made by the compiler's API; each declaration was compared token for token with the original, and the comparison was shown to fail on a one-token change.
- ST-08: the web's `api.ts`, `types.ts` and `guards.ts` are the folders `api/`, `types/` and `guards/`, a file for each feature behind an `index.ts` that re-exports the same names, so no page and no test changed an import. The same comparison holds for them.
- Two layering rules on each side: no import cycle among the files of `services/` and none among the web's shipped files (a type-only import not counting), and no piece of the assistant imports its entry file. Each was broken once to see it fail; the first version of the web rule let a cycle through `api/index` pass, which that breakage showed.
- MT-06: not done, by your word. The write token is empty in both portals.
- `myown/documents/patches/bk-11-removed-endpoints.patch` was made again: the linter had removed `type Params` from `api-hygiene.test.ts`, which the restored code uses, so the restored tree did not typecheck. A copy of the restored tree now typechecks, lints and passes (1,702 server tests, 1,173 web tests after `npm run gen:api`, which a restore needs now because the generated types follow the OpenAPI file; `openapi.check` finds 50 endpoints).
- Documents: ADR-0013 (the splits, the two rules, the linter, the numbers), setup §5, §6, §12, §24, the README, `docs/contributing.md`, `docs/getting-started.md` and the flow diagram (`WebFlow.pdf` made again and stamped), and the line citations of the ERDs, which were moved by the text of the line. The README said 35 direct dependencies; it is 40 (17 in the BFF, 23 in the web, 13 shipped), because `openapi-typescript` had not been counted.
- Server 1,687 tests in 78 files and web 1,173 in 81: 2 more on the server (layering), 1 more for the cycle rule and 20 for the CSV on the web.
- The old files are kept in `myown/refactor-backup-19oct/`; delete it when you are satisfied.

## 19 October 2026, later: six rows applied (committed as `5cf5268`, live since 22 October 2026)

At your word ("tolong apply IN 28, FR-13, IN-11, BK-13, FR-16", then "sama UX 20 ya"), with three answers from you: the four `.env.example` templates may be opened, `openapi-typescript` may be added to `web/`, and the 12 old rollback tags and the volume `proto1_pgdata` may go. Nothing was rebuilt, so none of this is live; it is in `5cf5268`.

- IN-28: setup §23 now has the rule for the rollback images and the Docker disk (keep the newest two tags of each image, remove the rest once the build after them has run for a day), and says when `proto1_pgdata` can go. At your word the 12 old tags (`2oct`, `7oct`, `13oct` of the four images) and the volume `proto1_pgdata` were removed; the demo estate it held is gone. Docker's images went from 33 entries to 21 and from 12.53 GB to 12.38 GB, volumes from 22 to 21 and from 21.07 GB to 20.87 GB: little came back, because the layers of an old tag are shared with a newer one.
- IN-11: the live stream is compressed for a screen that accepts gzip, by the BFF, with a sync flush after every frame and keep-alive. Through the nginx of the web image, on HCML's real list, the first frame went from 166,845 to 18,693 bytes on the wire (89 percent fewer) and arrived as fast as before; headless Chrome decoded it. The Problems page now opens the same stream and reads its list at once when a frame says it changed (it still polls every 30 s). The stream hook moved to `shared/hooks/useSSE.ts`.
- BK-13: an explicit `from` and `to` of `/api/graph` are widened to whole minutes (`from` down, `to` up), so requests seconds apart share one cached read. The range is checked as it was asked, and the response echoes the widened one.
- UX-20: the six sentences the server sent with "Details are in the BFF log" or a setting in them now say the same plain thing to everyone ("Tell an administrator", with a reference for an unexpected error); the setting goes to the log.
- FR-16: the explain answers, which a model writes, are checked at run time like every other answer. The web types are held to `docs/api/openapi.yaml`: `openapi-typescript` (a dev dependency of `web/`, never shipped) makes `web/src/generated/openapi.ts` from it with `npm run gen:api`, and `web/src/__tests__/openapiTypes.test.ts` makes `npm run typecheck` fail where the file promises less than the app's type needs (a field absent, optional or null in the file, or of another kind), naming the place, for each of the 36 answers `api.ts` reads and the one POST. The first run found 20 of the 36 disagreeing with the file, never because of the app (no existing web type was changed). In 7 the file contradicted what the server sends: a site code typed as text, the derived SLA's hosts and groups described as the availability rows, an interface row nobody sends, the graph's `coverage` as a number. In 13 it was less exact: fields not listed or not marked required, an AI provider that could be null, three fields missing from the aging report, a map described as a list of its elements. The file as committed in `0044efe` was not valid YAML either (two descriptions, lines 2147 and 2182: a strict parser such as Swagger Editor's rejects the whole file, and the web test now fails on such a file). The file is corrected against the server's own types. `Health` and `AcknowledgeResult` are named types in `types.ts` now. 19 descriptions in the file that YAML had silently cut at their first comma are quoted, and `openapi.check.ts` refuses a new one. The corrected file was also tried on 40 real answers of HCML's restored data (34 paths with their variants, through a throwaway validator and a read-only BFF that was stopped afterwards): all 40 fit, where the old file failed 11. The web image builds with the new lockfile (`docker build`, then `nginx -t`; the trial image was removed).
- FR-13: all four `.env.example` templates already say `PORTAL_USER=admin` (only those lines were read), so there was nothing to change.
- `docs/api/README.md` and `docs/architecture/README.md` said 41 endpoints; they say 45, as the OpenAPI check has said since 7 October.
- Server 1,685 tests in 78 files and web 1,153 in 80, with the type comparison on top, which the typecheck runs; 17 deliberate breakages (12 of IN-11, BK-13, UX-20 and the explain guards, 5 of the type check) were each caught.

## 19 October 2026: the list of what was not checked, read again, and four findings fixed (committed as `0044efe`, live since 22 October 2026)

At your word ("please check this, and after check, please update md files accordingly"), the [Not checked](tracker.md#not-checked) list of `tracker.md` was checked line by line against the running portals, GitHub, the BFF logs and a throwaway portal. The check itself changed no code; its four findings were then fixed at your word ("tolong perbaiki"). You committed and pushed it all on 19 October (`0044efe`, 10:36 WIB, with the work of 15 and 16 October); nothing was rebuilt, and the running portals are still the builds of 14 October, so none of the fixes is live.

- One line of the list was wrong: "Nobody signed in". The BFF log of :8081 shows sign-ins on 15 October (08:39) and 16 October (14:43 WIB), the Internet traffic view, the SLA page, a report download and one Assistant question. The question failed: Anthropic refused the API key the container holds (401, `invalid x-api-key`), which had answered an Explain on 15 October at 11:34. Explain and the Assistant of :8081 need a valid key in `.env` and a recreated BFF (SC-01); the sentence the person saw, "Try again in a moment", is CK-03.
- Closed without a password: the dependency audits (0 vulnerabilities in all four packages), both images and `nginx -t` as `ci.yml` builds them on the 16 October layout, `npm run verify` in both copies (server 1,663 tests, web 1,122), the repo's visibility (still public, `cb97069` still opens), the `.env` modes (600), the hardening of the running containers, and axe 4.13.0 on 151 page runs: every page for the administrator, the operator and the viewer, in both themes, at 1440 px and at 390 px, and the sign-in screen. The secret scan did not run.
- Found and fixed (rows CK-01 to CK-04). CK-01: at 390 px six pages had a sideways-scrolling table that axe says the keyboard cannot reach (Chrome 155 does reach it, other browsers may not); the 19 table boxes are now one component, `TableWrap`, which gives a box that scrolls a tab stop, `role="region"` and a name, and removes them when it stops scrolling. CK-02: the sign-in screen is a `<main>`. CK-03: a refused AI key (401 or 403) has its own sentence, "The AI service did not accept the portal's key. Trying again will not help; tell an administrator.", where it read "Try again in a moment". CK-04: `/devices` is in the default lists of `page-audit.mjs` and `layout-sweep.mjs`, and `live-tools.test.ts` fails when a page of the app is missing from them. Seven server tests and ten web tests were added (1,670 in 77 files and 1,132 in 78); each fix was broken on purpose and caught; axe on the same 151 page runs found nothing after the fixes.
- The old Zabbix token of `cb97069`, tried once with your word: the Zabbix at :8080 refused it ("Not authorized"). It says nothing about another Zabbix; revoke it wherever it exists (SC-06).
- The first run of `ci.yml` on GitHub, for that push: the file is accepted (its five jobs are listed) and none of them started, because of the billing lock. Three Dependabot pull requests ran it with the same result.
- Documents corrected to match: `tracker.md` (Not checked, SC-01, SC-06, IN-30, Numbers that changed, Needs your decision), both READMEs (Known gaps, Testing, Related docs, test counts), `docs/setup/13` and `27`, `docs/api/openapi.yaml`, ADR-0005 and ADR-0011, `tools/README.md` and the test counts of the guide.

## 16 October 2026: folders, checks and the guide, rearranged (committed as `0044efe`, live since 22 October 2026)

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

## 15 October 2026: an audit, and the Hosts view (committed as `0044efe`, live since 22 October 2026)

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

## 14 October 2026, later still: the follow-ups to the meters (committed as `4b773af`, live since 22 October 2026)

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
