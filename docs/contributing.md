# Contributing

One rule governs all the others: **this is one source tree living in two folders.**

`hcml-portal` and `hcml-portal-ollama` hold the same `server/src`, the same `web/src` and the same
`scripts/`: byte for byte. The only difference between them is which model answers, and that is set
in an untracked `.env`, not in code ([ADR-0005](architecture/adr/0005-provider-neutral-ai-layer.md)).
Every change to shared code lands in both folders, in the same commit-shaped unit of work.

```bash
diff -rq -x node_modules -x dist -x .DS_Store -x '*.tsbuildinfo' -x .git -x pic \
  ../hcml-portal ../hcml-portal-ollama
```

That must print exactly 21 differing files, all of them configuration or per-repo perspective,
and one more line, `Only in ../hcml-portal-ollama/docs: README_copy.md`. That file is a snapshot of
the ollama README from 23 September, kept for reference and not maintained. It sat in that folder's
root until 7 October 2026, where it made the count 22. Any other line means you changed something
in one folder and not the other. The full list of the 21 is in both `README.md` files.

`node web/scripts/parity.check.mjs` makes the same comparison with the allowed files written down
by name: 17 files, and the four `.env*` files, which it skips without opening. It prints one line
per difference outside that list and exits 1 if there is any. A file on the list that one copy
lacks is a difference too, and so is `README_copy.md` anywhere but `docs/` in the ollama copy.
No folder is on the list. `docs/flow/` and `docs/schema/` hold files that must match
(`ServerFlow`, `WebFlow`) beside files that differ, and only the ones that differ are named. In CI,
which holds one tree, it checks that every name on the list is a file in that tree, so a rename
cannot leave the list pointing at nothing, and then says it compared nothing.

The exclusions are not cosmetic. Every one of them is already in `.gitignore`, so none is a
divergence anyone can commit, but `diff` does not read `.gitignore`. Without them the number stops meaning
anything: the `.tsbuildinfo` files are written by whichever folder you last ran `npm run build` in,
so they differ whenever you have worked in one and not the other. `pic/` holds each copy's own
screenshots for the documents, one folder per month (`pic/09` for September). They differ by design,
and they show real host names, so they are never committed (the Code of Conduct below says why:
"Never commit estate data"). `parity.check.mjs` skips that one folder, at the root only.
`vite.config.js` is no longer
excluded. Builds used to write it next to `vite.config.ts`, and Vite loads the `.js` first, so a
stale one in one folder silently replaced that folder's real config. `tsconfig.node.json` now
writes it under `node_modules/.tmp`, and one that turns up beside the source shows here.

**Why not one repository with two deployment profiles?** It was considered (tracker IN-13): a
`deploy/hosted.env.example` and a `deploy/local.env.example`, with the local copy started by
`docker compose -p hcml-portal-ollama --env-file deploy/local.env up -d`, and the per-copy
documents kept as separate files. It was not done: on 7 October 2026 the owner accepted the
default of keeping two folders, because merging them changes how both live portals are built and
started. The parity script is the guard until then, and the price is unchanged: a fix is two
edits, two builds and two deployments. To revisit it, start from the 17 files the script lists:
they are what would become profile files.

---

## Code of Conduct

Be plain with each other, and precise about the machine. Beyond that, this project's conduct rules
are about the data, because the data is real:

- **The Zabbix instance is production.** HCML's 139 monitored hosts across 14 sites. Read-only API
  calls only, no create, no update, no delete, no acknowledge, no writes of any kind while
  developing. Alerting is disabled on that instance on purpose; leave it disabled. The BFF backs this
  up: with `AUTH_ENABLED=false` it refuses acknowledge and close unless `ALLOW_WRITE_WITHOUT_AUTH=true`
  is set, so leave that unset in a dev `server/.env`.
- **Never commit estate data.** No per-host output, no Availability Report spreadsheets, no database
  dump, no screenshots with real host names in them. A downloaded SLA report, PDF or Excel, is
  per-host output: it names every device. The one exception is [`screenshots/`](screenshots/README.md),
  where every name is replaced and every image is looked at before it is added.
- **Never commit a credential.** `.env` and `server/.env` are gitignored and must stay that way.
  `.env.example` is committed and must never hold a real value, not a Zabbix token, not an API key,
  not a password, not a `JWT_SECRET`.
- **If you find a credential in the history or in a file, say so immediately** rather than quietly
  removing it. It has to be rotated, not deleted.
- **Say when you do not know.** A guess written confidently is the most expensive thing anyone has
  contributed to this project so far. See *Numbers in documents*, below.

---

## Development Setup

Full instructions, including the Zabbix token and the Docker route, are in
[`getting-started.md`](getting-started.md). This section does not repeat them. The short version:

```bash
cd server && cp .env.example .env    # set ZBX_URL and ZABBIX_API_TOKEN
npm install && npm run dev           # BFF on :4000

cd ../web
npm install && npm run dev           # Vite on :5173, proxying /bff to :4000
```

You need Node 24 (22.22.2 or 24.15 at the oldest), npm, and a reachable Zabbix 7.0. You do not need a database: there isn't one
([ADR-0003](architecture/adr/0003-no-database.md)), and you do not need a model endpoint unless you
are working on the plain-language layer.

---

## The checks

Twelve committed checks, each one written because something specific broke. Run the ones your change
can affect; run all of them before you call a change finished.

| Check | Run it | What it exists to prevent |
|---|---|---|
| Tests | `npm test` in `server/` | 1508 tests, 66 files. The status-code semantics are pinned here: a rejected token is 503, never 502 or 504. The SLA report files are pinned here too: the tests read each PDF and workbook back, and compare the theme colours, the logo and the wording copied from the web app with their originals. Files that are not code are read as text too, because nothing else would notice them breaking: `docker-compose.yml` against the BFF's settings and the Dockerfile's build arguments, `nginx.conf`, and the CI workflow |
| Web tests | `npm test` in `web/` | 822 tests in jsdom. They pin bugs that were found once: a slow answer for an old selection overwriting the new one, and, caught in review, sign-in returning to `/LOGIN` (the sign-in page again) and the wall bringing back a row marked "Cleared" after it had left the screen. Also the 401 handling and the CSRF header, and the report download buttons: one request however often they are pressed, and a month change dropping the request still in flight. Also the notices that say data is old (Zabbix stopped collecting, or a report is the last copy kept), the CSV formula guard, and the Assistant's conversation being cleared at sign-out |
| Lint | `npm run lint` in `web/` | typescript-eslint, the two classic react-hooks rules and jsx-a11y. Three `eslint-disable` comments pointed at the hooks rule before anything ran it, and the first run found 14 form labels tied to no control |
| Types | `npm run typecheck` in `server/` and in `web/` | Both check their test config too |
| API contract | `npx tsx scripts/openapi.check.ts` in `server/` | The endpoint table drifted twice: it claimed 35 endpoints while listing all of them, and 23 of 35 line citations pointed at unrelated lines after the route files grew. A third hand-written list would drift the same way |
| Database ERD | `npx tsx scripts/erd.check.ts` in `server/` | The database ERD exists twice, as `ERD-Database.mmd` and as `ERD-Database.erd`. Two hand-maintained copies of one model is the shape that has drifted every previous time here |
| Stylesheet | `node scripts/css.check.mjs` in `web/` | A lost `}` once left about 50 rules silently unapplied in one portal while the other looked fine. Vite's build fails on none of this |
| Design tokens | `node scripts/tokens.check.mjs` in `web/` | The sheet held 42 padding values, 16 font sizes and 14 radii against 13 tokens, and three of its colours failed WCAG unnoticed: `--muted` sat 0.07 short of AA for as long as the file existed. Contrast is computed here, not asserted, so a token edited to an illegible colour fails instead of shipping |
| Parsers | `../server/node_modules/.bin/tsx scripts/markdown.check.ts` and `units.check.ts` in `web/` | The assistant's markdown renderer and the unit/duration formatters: standalone scripts, written before the web had a test runner |
| Links | `node scripts/links.check.mjs` in `web/` | 41 relative links per copy had broken again after the ERD folder moved, 30 of them in `docs/erd/erd.md`. macOS resolves a wrong-case path, so the check matches each segment's exact spelling, and a link out of the repo fails, because a checkout does not have it |
| Diagrams | `node scripts/diagrams.check.mjs` in `web/` | Nine renders in one copy and eight in the other were older than their sources by file date, and a file date is no use in a git checkout. Each `.mmd` now ends with a stamp holding the hash of its source, and the check fails when the source changed after it. It cannot see whether the render was redone: `node scripts/diagrams.stamp.mjs` is where that is said, run last |
| Copies | `node scripts/parity.check.mjs` in `web/` | The two folders drifting: it lists every file that differs between them, or exists in one only, outside the short list meant to differ, which names its 17 files one by one. Until it existed the recipe above was a number someone had to remember, and `README_copy.md` had already made that number wrong once |

`server/scripts/validate-sli.ts` is a thirteenth, but it is not part of the routine set: it needs
HCML's real Availability Report spreadsheets in `~/Downloads` and a running BFF. It compares the
derived SLA against HCML's own published figures, and it never runs in CI.

`.github/workflows/docs.yml` runs everything in the table above on push and pull request. It also
runs `npm audit --omit=dev --audit-level=high` in `server/` and `web/`, which fails on a high or
critical advisory in a package that ships, builds the web app (`tsc -b` also typechecks
`vite.config.ts`, which `npm run typecheck` never reaches), builds both Docker images without
pushing them, and runs `nginx -t` in the web image. CI holds one tree, so the parity check runs only
its own self-test there, and confirms that every file on its list exists: run the comparison on the machine that has both copies. The workflow has
not run on GitHub yet, so the image builds, `nginx -t` and the secret scan below are untested until it does.

Since 12 October 2026 (tracker SC-17) the workflow's token is read-only, and every action in it is pinned
to a full commit SHA, with the tag it came from in the comment after it: a tag can be moved to other code, a
SHA cannot. A third job, `secrets`, runs gitleaks over the commits of each push and pull request. It does not
read the history already in the repository, so the token in `cb97069` does not fail it; revoking that token is
the fix. It posts no comments and uploads no findings, because on a public repository either would repeat what
it found, and manual runs skip it. `.github/dependabot.yml` opens a pull request a week for the actions, the
npm packages of `server/` and `web/` (minor and patch releases together, a major alone) and the base image of
each Dockerfile, which the digests would otherwise freeze. `ci-workflow.test.ts` fails on an action pinned any
other way. The SHAs, the gitleaks job and the Dependabot file have not met GitHub yet.

### Writing a new checker

Follow the nine that exist. The house pattern, in order of how often it has mattered:

1. A self-test over fixtures, before it touches a real file. `openapi.check.ts`,
   `css.check.mjs` and `tokens.check.mjs` all do this. A checker that has never failed has never
   been tested, and this is not a formality: `tokens.check.mjs` failed its own first run because the
   expected contrast in one fixture was wrong, which is exactly the arithmetic the checker exists to
   stop anyone doing by hand.
2. A header comment naming the regression it prevents: the specific one, with what it cost.
3. Zero npm dependencies. See below.
4. `console.error` per problem, then a count, then an explicit `process.exit(1)`.
5. Read-only. A check that can write is a migration.

---

## Zero new dependencies

8 runtime + 5 dev on the server, 5 + 17 on the web: 35 in all, 13 of them shipped. Adding to either
list needs a real argument, not a convenience one.

Two precedents set the bar: `validate-sli.ts` hand-wrote a
zip reader rather than add an xlsx parser, and `openapi.check.ts` hand-wrote a YAML path extractor
rather than add a YAML parser. Both are about twenty lines. Both are still correct.

The PDF and Excel writers are the next precedent, and a far larger one. `server/src/export/` writes
the SLA report as a PDF and as a workbook with Node's `zlib` and `crypto` modules and no library. The
PDF writer alone is roughly 800 lines.
[ADR-0011](architecture/adr/0011-build-the-sla-report-files-in-the-bff.md) records what that costs:
the project now owns two file formats, their limits and every reader's quirks. Read it before
reaching for a library, or for a third hand-written format.

Deliberately absent: no ORM or database driver (the
portal owns no data), no state-management library (server state is two small hooks), no component
library, no PDF or spreadsheet library, and no second HTTP client: the Zabbix client and the model
client are both hand-rolled around native `fetch`.

---

## Design

`DESIGN.md` at each repo root is the design direction: identity, palette, typography, mood. It is the
portal owner's, and it is the input to every visual decision. `antislop.md` is the filter that checks
work against it. The two are not interchangeable, and a filter never supplies taste.

Colours, spacing, type sizes, radii and elevation all come from the token block at the top of
`web/src/styles.css`. Reaching past it to a raw value fails `tokens.check.mjs`, which is the point:
dark mode works only because every colour resolves through a token, so one hardcoded hex is one
element that stays light on a dark page.

The exception is a canvas. ECharts cannot resolve `var()`, so `TimeSeriesChart.tsx` reads the tokens
with `getComputedStyle` at render time, and calls `useThemeChange` so a theme switch renders it again.
Anything else drawn to a canvas has to do the same.

## Diagrams

The Mermaid sources in [`schema/`](schema/), [`flow/`](flow/) and [`erd/`](erd/) each have a committed
render beside them. After editing a `.mmd`, **re-render and check the picture, not the source.** The
tested `mermaid-cli` invocation is in each folder's README, along with the rules that were learned by
breaking them: an unfilled subgraph frame, no bare `%%`, no numeric HTML entities in labels.

When the render is done, run `node web/scripts/diagrams.stamp.mjs` from the repo root. It sets the
last line of each `.mmd` you changed to `%% source-hash:` and the hash of the source, and refuses a
source whose PDF is older than it. `node web/scripts/diagrams.check.mjs` fails, in CI too, on a source
edited after its stamp. A comment-only edit that cannot change the picture takes `--force`.

Count that each lane still reads in order and that no box has lost an edge. A Mermaid diagram that
parses is not a Mermaid diagram that is readable.

---

## Decisions

A decision that shapes the system gets an [ADR](architecture/adr/): MADR format, the next number in
sequence, from the template the existing eleven follow. Record what was considered and rejected, and
record at least one negative consequence: an ADR with only upsides is a press release.

Write one for: a technology choice, an architectural pattern, anything with a real trade-off,
anything the team needs to agree on. Do not write one for: naming, formatting, a config tweak, or
anything you could reverse in an afternoon.

---

## Numbers in documents

The recurring failure in this project is confident documentation that nobody checked. A sentence
claiming some deleted scripts were recoverable from a particular commit was repeated into four
documents until it read as established fact; the scripts had never been tracked. An endpoint count was
wrong in a summary for a week while the table beneath it was right.

So, when you write a figure down:

- Date it and name where it came from. "139 monitored hosts" is a measurement, and measurements
  have a timestamp.
- Say "reconstructed" when it is. `setup.md` §§27 to 29 are marked that way because they were
  rebuilt from other sources, not restored from the original.
- Prefer a check to a promise. If a number can be compared with the code by a script, write the
  script. That is why `openapi.check.ts` exists.
- `ls` and `test -e` lie on APFS, which is case-insensitive. Only `os.listdir()` gives you the
  true case of a filename. A link that resolves on this laptop can 404 on a Linux CI runner.
