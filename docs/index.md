# Documentation

A branded, read-only operations portal over HCML's Zabbix 7.0: 139 monitored hosts across 14 sites.
The portal presents things Zabbix has no table for: sites, WAN links, incidents, host reachability and
a monthly availability figure validated against HCML's own published reports.

**This copy is `hcml-portal`.** Its plain-language layer is hosted Claude over the Anthropic API, so
estate data crosses the network when someone clicks *Explain*. The sibling `hcml-portal-ollama` runs
the same code against a local model and nothing leaves the machine.

```text
Browser (React)  ──HTTP+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

The first arrow is plain HTTP on this computer's loopback address: nginx listens on port 8080 inside
its container and Docker publishes it on `127.0.0.1` only. Nothing in this repository terminates
TLS, so before the portal is reached from another machine, put TLS in front of it:
[`operations/tls.md`](operations/tls.md).

Nine flows are written out in that form (a page load, the live dashboard, the request pipeline, the
cache, auth, where a number comes from, both AI paths and the one write) in
[`flow/README.md`](flow/README.md#the-nine-flows-one-line-each).

## Start here

| If you want to… | Read |
|---|---|
| Run it | [`getting-started.md`](getting-started.md) |
| Back it up, or restore it | [`operations/backup-and-restore.md`](operations/backup-and-restore.md) |
| Reach it from another machine | [`operations/tls.md`](operations/tls.md): TLS in front, with HSTS |
| Call it | [`api/openapi.yaml`](api/openapi.yaml), 41 endpoints · [how to view it](api/README.md) |
| Download the monthly SLA report | [`../README.md`](../README.md#download-the-sla-report) for the buttons and the endpoint, [`../setup.md`](../setup.md) §18 for how the files are built |
| Understand why it is shaped this way | [`architecture/adr/`](architecture/adr/): eleven decisions |
| See how it works | [`architecture/`](architecture/): diagrams and the subsystem index |
| See who uses it | [`ux/README.md`](ux/README.md): the three roles and the acknowledge journey, derived from the code |
| Change something | [`../setup.md`](../setup.md), 31 sections, one per subsystem |
| Change it safely | [`contributing.md`](contributing.md): the house rules, and why each one exists |
| Know what is wrong with it | [`../AUDIT_REPORT.md`](../AUDIT_REPORT.md) and `setup.md` §27 |

## The shape of it in one table

| | |
|---|---|
| Front end | React 18 + TypeScript + Vite, ECharts. 18 pages, 822 tests, linted with eslint |
| Back end | Fastify 5 + TypeScript on Node 24. 18 route modules, 41 endpoints, 1508 tests |
| Data source | The Zabbix JSON-RPC API. Nothing else: no database, no volumes, no data files |
| Writes | Exactly one: acknowledge/close, behind a separate token and the operator role |
| Downloads | The monthly SLA report as a PDF or an Excel file, built when asked from the cached figures and never stored |
| State | One in-process `Map`, 500 entries or about 64 MB, TTLs from 5 s to 24 h. Lost on restart |
| Settings | Untracked `.env` files: users, roles, tokens, the signing secret and the SLA settings. **The one thing to back up**: [`operations/backup-and-restore.md`](operations/backup-and-restore.md) |

## Two facts to know first

**The portal owns no estate data, only its own settings.** Every site, link, incident and SLA figure
is computed per request and gone when the process restarts. So there is no database to back up or
migrate, and equally nothing survives a deploy. [ADR-0003](architecture/adr/0003-no-database.md).
What it does keep is its configuration. The users and their roles, the Zabbix and model tokens,
`JWT_SECRET` and the SLA settings live in untracked `.env` files that git ignores. Lose them and the
portal cannot start until someone writes them again, so keep an encrypted copy of each:
[`operations/backup-and-restore.md`](operations/backup-and-restore.md).

**The dataset is frozen.** Local polling was stopped on 17 September 2026 at 16:59:37, deliberately,
because a development laptop should not be polling production equipment. Every figure the portal
shows is a snapshot of that moment. [ADR-0008](architecture/adr/0008-stop-local-polling.md).

## Where everything lives

```
README.md                  install, configure, run
setup.md                   31 sections, one per subsystem: the deep reference
AUDIT_REPORT.md            what two audits found, and what is still open
docs/
  index.md                 this file
  getting-started.md
  contributing.md          the house rules, and why each one exists
  api/openapi.yaml         the contract: 41 endpoints
  architecture/adr/        why it is the way it is: 11 decisions
  schema/  flow/  erd/     the diagrams; erd/erd.md is the data model in prose
  ux/                      who uses it: the three roles and the acknowledge journey (derived, not interviewed)
  operations/              backing up and restoring the .env files; TLS beyond localhost
deploy/
  settings.example         every non-secret setting and its default, versioned
.github/
  workflows/docs.yml       typechecks, web lint, both test suites, the web build, the nine checkers, npm audit, a secret scan, both Docker builds
  dependabot.yml           weekly pull requests for the actions, the npm packages and the base images
```

## A note on trusting these documents

Two audits and a benchmark have gone through this project, and what they kept finding was confident
documentation that nobody had checked. A sentence about a git commit was repeated into four documents
until it read as fact, and was false. An endpoint count was wrong in a summary for a week while the
table beneath it was right.

So: numbers here are dated and sourced where they matter, the API contract has an automated check
behind it, and where something is reconstructed rather than known, it says so.
