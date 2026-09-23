# Contributing

One rule governs all the others: **this is one source tree living in two folders.**

`hcml-portal` and `hcml-portal-ollama` hold the same `server/src`, the same `web/src` and the same
`scripts/`: byte for byte. The only difference between them is which model answers, and that is set
in an untracked `.env`, not in code ([ADR-0005](architecture/adr/0005-provider-neutral-ai-layer.md)).
Every change to shared code lands in **both** folders, in the same commit-shaped unit of work.

```bash
diff -rq -x node_modules -x dist ../hcml-portal ../hcml-portal-ollama
```

That must print exactly **21** files, all of them configuration or per-repo perspective. If it prints
22, you changed something in one folder and not the other. The full list of the 21 is in both
`README.md` files.

---

## Code of Conduct

Be plain with each other, and precise about the machine. Beyond that, this project's conduct rules
are about the data, because the data is real:

- **The Zabbix instance is production.** HCML's 139 monitored hosts across 14 sites. Read-only API
  calls only, no create, no update, no delete, no acknowledge, no writes of any kind while
  developing. Alerting is disabled on that instance on purpose; leave it disabled.
- **Never commit estate data.** No per-host output, no Availability Report spreadsheets, no database
  dump, no screenshots with real host names in them.
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
npm install && npm run dev           # Vite on :5173, proxying /api to :4000
```

You need Node 20+, npm, and a reachable Zabbix 7.0. You do **not** need a database: there isn't one
([ADR-0003](architecture/adr/0003-no-database.md)), and you do not need a model endpoint unless you
are working on the plain-language layer.

---

## The checks

Six committed checkers, each one written because something specific broke. Run the ones your change
can affect; run all of them before you call a change finished.

| Check | Run it | What it exists to prevent |
|---|---|---|
| Tests | `npm test` in `server/` | 336 tests, 19 files. The status-code semantics are pinned here: a rejected token is 503, never 502 or 504 |
| Types | `npm run typecheck` in `server/` and in `web/` | `server/` checks its test config too |
| API contract | `npx tsx scripts/openapi.check.ts` in `server/` | The endpoint table drifted twice: it claimed 35 endpoints while listing all of them, and 23 of 35 line citations pointed at unrelated lines after the route files grew. A third hand-written list would drift the same way |
| Database ERD | `npx tsx scripts/erd.check.ts` in `server/` | The database ERD exists twice, as `ERD-Database.mmd` and as `ERD-Database.erd`. Two hand-maintained copies of one model is the shape that has drifted every previous time here |
| Stylesheet | `node scripts/css.check.mjs` in `web/` | A lost `}` once left about 50 rules silently unapplied in one portal while the other looked fine. Vite's build fails on none of this |
| Parsers | `npx tsx scripts/markdown.check.ts` and `units.check.ts` in `web/` | The assistant's markdown renderer and the unit/duration formatters, neither of which has a test runner |

`server/scripts/validate-sli.ts` is a seventh, but it is **not** part of the routine set: it needs
HCML's real Availability Report spreadsheets in `~/Downloads` and a running BFF. It compares the
derived SLA against HCML's own published figures, and it never runs in CI.

`.github/workflows/docs.yml` runs everything in the table above on push and pull request.

### Writing a new checker

Follow the six that exist. The house pattern, in order of how often it has mattered:

1. **A self-test over fixtures, before it touches a real file.** `openapi.check.ts` and
   `css.check.mjs` both do this. A checker that has never failed has never been tested.
2. **A header comment naming the regression it prevents**: the specific one, with what it cost.
3. **Zero npm dependencies.** See below.
4. **`console.error` per problem, then a count**, then an explicit `process.exit(1)`.
5. **Read-only.** A check that can write is a migration.

---

## Zero new dependencies

7 runtime + 4 dev on the server, 5 + 5 on the web. Adding to either list needs a real argument, not
a convenience one.

This is not minimalism for its own sake. Two precedents set the bar: `validate-sli.ts` hand-wrote a
zip reader rather than add an xlsx parser, and `openapi.check.ts` hand-wrote a YAML path extractor
rather than add a YAML parser. Both are about twenty lines. Both are still correct.

Deliberately absent, and worth knowing before you reach for one: no ORM or database driver (the
portal owns no data), no state-management library (server state is two small hooks), no component
library, and no second HTTP client: the Zabbix client and the model client are both hand-rolled
around native `fetch`.

---

## Diagrams

The Mermaid sources in [`schema/`](schema/), [`flow/`](flow/) and [`erd/`](erd/) each have a committed
render beside them. After editing a `.mmd`, **re-render and check the picture, not the source.** The
tested `mermaid-cli` invocation is in each folder's README, along with the rules that were learned by
breaking them: an unfilled subgraph frame, no bare `%%`, no numeric HTML entities in labels.

Count that each lane still reads in order and that no box has lost an edge. A Mermaid diagram that
parses is not a Mermaid diagram that is readable.

---

## Decisions

A decision that shapes the system gets an [ADR](architecture/adr/): MADR format, the next number in
sequence, from the template the existing eight follow. Record what was considered and rejected, and
record at least one **negative** consequence: an ADR with only upsides is a press release.

Write one for: a technology choice, an architectural pattern, anything with a real trade-off,
anything the team needs to agree on. Do not write one for: naming, formatting, a config tweak, or
anything you could reverse in an afternoon.

---

## Numbers in documents

The recurring failure in this project has not been missing documentation. It has been **confident
documentation that nobody checked**. A sentence claiming some deleted scripts were recoverable from
a particular commit was repeated into four documents until it read as established fact; the scripts
had never been tracked. An endpoint count was wrong in a summary for a week while the table beneath
it was right.

So, when you write a figure down:

- **Date it and name where it came from.** "139 monitored hosts" is a measurement, and measurements
  have a timestamp.
- **Say "reconstructed" when it is.** `setup.md` §§27–29 are marked that way because they were
  rebuilt from other sources, not restored from the original.
- **Prefer a check to a promise.** If a number can be compared with the code by a script, write the
  script. That is why `openapi.check.ts` exists.
- **`ls` and `test -e` lie on APFS**, which is case-insensitive. Only `os.listdir()` gives you the
  true case of a filename. A link that resolves on this laptop can 404 on a Linux CI runner.
