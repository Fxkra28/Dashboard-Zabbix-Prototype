# Architecture Decision Records

One file per decision, in [MADR](https://adr.github.io/madr/) format. Numbered sequentially and never
renumbered. A superseded ADR is **kept and marked**, not deleted: the reasoning is the point, and a
decision you cannot see being reversed is a decision nobody can learn from.

These replace `Proto1/DECISION.md`, a single large document that accumulated every decision, drifted,
and was deleted on 22 September 2026. One file per decision does not rot as a unit.

## Index

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-bff-over-zabbix-api.md) | Build a read-only BFF over the Zabbix API rather than modifying Zabbix | accepted | 2026-09-07 |
| [0002](0002-react-typescript-fastify.md) | React + TypeScript + Vite on the front, Fastify + TypeScript on the back | accepted | 2026-09-04 |
| [0003](0003-no-database.md) | The portal owns no database: derive per request, cache in memory | accepted | 2026-09-07 |
| [0004](0004-derive-the-sla-in-the-portal.md) | Compute the monthly SLA in the portal instead of using Zabbix Services and SLA | accepted | 2026-09-15 |
| [0005](0005-provider-neutral-ai-layer.md) | A provider-neutral plain-language layer, and two repositories over one source tree | accepted | 2026-09-18 |
| [0006](0006-read-only-with-one-write.md) | Read-only by default, with exactly one write behind a separate token | accepted | 2026-09-10 |
| [0007](0007-keep-the-zabbix-api.md) | Keep the Zabbix API as the source of truth; do not mirror its telemetry | accepted | 2026-09-22 |
| [0008](0008-stop-local-polling.md) | Stop local polling, and put `zabbix-server` behind a compose profile | accepted | 2026-09-17 |

## How they relate

```
0001  BFF over the API
 ├── 0002  the stack
 ├── 0003  no database ──────────── confirmed for telemetry by 0007
 │    └── 0004  derive the SLA
 ├── 0006  read-only, one write
 └── 0005  provider-neutral AI

0008  stop polling ──── freezes the dataset 0007 measures against
```

## Writing a new one

Copy the [MADR template](https://github.com/adr/madr/blob/main/template/adr-template.md), take the
next number, and add a row above.

**Write one for:** a technology choice, an architecture pattern, anything with a real trade-off,
anything where the next maintainer would otherwise ask "why on earth is it like this?".

**Do not write one for:** naming, formatting, anything reversible in an afternoon, or an
implementation detail that belongs in a code comment.

Two house rules, both learned here:

- **Every ADR needs real negative consequences.** One with only upsides is a press release, and every
  decision in this project cost something. If you cannot name the cost, you have not finished thinking.
- **Cite the measurement, not the intuition.** [ADR-0007](0007-keep-the-zabbix-api.md) exists because a
  I wrote the prediction down, and a five-minute measurement refuted it. Predictions that are
  never checked become facts by repetition.
