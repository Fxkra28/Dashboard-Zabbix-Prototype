# Documentation

A branded, read-only operations portal over HCML's Zabbix 7.0: 139 monitored hosts across 14 sites.
The portal presents things Zabbix has no table for: sites, WAN links, incidents, host reachability and
a monthly availability figure validated against HCML's own published reports.

**This copy is `hcml-portal`.** Its plain-language layer is hosted Claude over the Anthropic API, so
estate data crosses the network when someone clicks *Explain*. The sibling `hcml-portal-ollama` runs
the same code against a local model and nothing leaves the machine.

```text
Browser (React)  ──HTTPS+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

Nine flows are written out in that form: a page load, the live dashboard, the request pipeline, the
cache, auth, where a number comes from, both AI paths and the one write: in
[`flow/README.md`](flow/README.md#the-nine-flows-one-line-each).

## Start here

| If you want to… | Read |
|---|---|
| **Run it** | [`getting-started.md`](getting-started.md) |
| **Call it** | [`api/openapi.yaml`](api/openapi.yaml), 41 endpoints · [how to view it](api/README.md) |
| **Understand why it is shaped this way** | [`architecture/adr/`](architecture/adr/): eight decisions |
| **See how it works** | [`architecture/`](architecture/): diagrams and the subsystem index |
| **Change something** | [`../setup.md`](../setup.md), 29 sections, one per subsystem |
| **Change it safely** | [`contributing.md`](contributing.md): the house rules, and why each one exists |
| **Know what is wrong with it** | [`../AUDIT_REPORT.md`](../AUDIT_REPORT.md) and `setup.md` §27 |

## The shape of it in one table

| | |
|---|---|
| Front end | React 18 + TypeScript + Vite, ECharts. 18 pages |
| Back end | Fastify 4 + TypeScript. 17 route modules, **41 endpoints**, 336 tests |
| Data source | The Zabbix JSON-RPC API. **Nothing else**, no database, no files, no volumes |
| Writes | Exactly one: acknowledge/close, behind a separate token and the operator role |
| State | One in-process `Map`, 500 entries, TTLs from 5 s to 24 h. Lost on restart |

## Two things worth knowing before you read anything else

**The portal owns no data.** Every site, link, incident and SLA figure is computed per request and
gone when the process restarts. There is nothing to back up and nothing to migrate, and equally,
nothing survives a deploy. [ADR-0003](architecture/adr/0003-no-database.md).

**The dataset is frozen.** Local polling was stopped on 17 September 2026 at 16:59:37, deliberately,
because a development laptop should not be polling production equipment. Every figure the portal
shows is a snapshot of that moment. [ADR-0008](architecture/adr/0008-stop-local-polling.md).

## Where everything lives

```
README.md                  install, configure, run
setup.md                   29 sections, one per subsystem: the deep reference
erd.md                     the data model in prose
AUDIT_REPORT.md            what two audits found, and what is still open
docs/
  index.md                 this file
  getting-started.md
  contributing.md          the house rules, and why each one exists
  api/openapi.yaml         the contract: 41 endpoints
  architecture/adr/        why it is the way it is: 8 decisions
  schema/  flow/  erd/     the diagrams
.github/workflows/
  docs.yml                 typechecks, tests and the six checkers
```

## A note on trusting these documents

Two audits and a benchmark have gone through this project, and the recurring failure was not missing
documentation: it was **confident documentation that nobody checked**. A sentence about a git commit
was repeated into four documents until it read as fact, and was false. An endpoint count was wrong in
a summary for a week while the table beneath it was right.

So: numbers here are dated and sourced where they matter, the API contract has an automated check
behind it, and where something is reconstructed rather than known, it says so.
