# The portal owns no database: derive per request, cache in memory

* Status: accepted
* Deciders: HCML internship project
* Date: 2026-09-07 (recorded as an ADR 2026-09-22)

## Context and Problem Statement

The portal presents concepts Zabbix has no table for: sites, WAN links, incidents, host reachability,
a monthly SLA. Something has to produce them. Should the portal own a datastore to keep them in?

## Decision Drivers

* Two sources of truth for the same number is the classic way to ship a wrong dashboard.
* Anything stored must be backed up, migrated, and kept in step with Zabbix.
* The estate is small: 139 hosts, ~660 open problems, 23 host groups.
* Most screens need data that is seconds old, which a copy cannot be.

## Considered Options

* **No store.** Derive on every request; cache in process for seconds.
* **Redis.** A shared cache, so several BFF instances and SSE fan-out can share state.
* **An application database** (PostgreSQL) holding the derived entities.
* **A mirror of Zabbix's measurement data**, so the portal queries its own copy.

## Decision Outcome

Chosen: **no store at all.** Every derived value is computed per request and held in a single
module-level `Map` with a 500-entry LRU cap and per-key TTLs from 5 seconds to 24 hours.

The cache coalesces concurrent misses onto one upstream fetch, so twenty NOC screens cost one Zabbix
read. Four report families may serve a stale value rather than an error; problem and acknowledgement
state never may.

### Positive Consequences

* **There is one source of truth, and it is Zabbix.** The portal cannot disagree with it.
* Nothing to back up, no migration to run, no schema to version.
* Deleting the portal leaves nothing behind. The compose file declares **no volumes at all**.
* Freshness is a TTL, visible in one place per route, not an ETL schedule.

### Negative Consequences

* **Everything is lost on restart**: including a closed month's SLA report that had been cached for
  24 hours and is, by definition, never going to change again. That report costs ~20 Zabbix calls to
  rebuild and it is rebuilt after every deploy, twice, because two stacks run.
* **The 24-hour TTL is a ceiling, not a floor.** Keys are parameterised: `graph:<ids>:<from>:<to>`,
  `net:ports:<hostid>` across 139 hosts, against a 500-entry cap, so ordinary browsing can evict a
  fresh SLA report within minutes. **Nobody has measured the real hit rate.**
* **Portal-side state has nowhere to live.** `auth.ts:55` says it outright: *"Users come from env:
  there is no database yet (that phase was deferred)."* Consequences: passwords are compared in plain
  text, adding a user needs a restart, there are no saved views, and, because the single write uses
  one shared Zabbix token, **Zabbix structurally cannot record which portal operator acknowledged an
  event.** No Zabbix table could hold that.
* Horizontal scaling would need Redis, because the cache and the SSE client set are per process.

## Pros and Cons of the Options

### No store

* Good, because it makes a stale-data class of bug impossible.
* Bad, because it also makes durable portal-side state impossible.

### Redis

* Good, because it survives a restart and allows more than one instance.
* Bad, because it is a third container for an estate of 139 hosts and one instance.
* The `docker-compose.yml` service exists, **commented out**, for exactly this reason.

### An application database for derived entities

* Good, because the closed-month SLA would be computed once, ever.
* Bad, because the derived entities are cheap: the expensive one is the SLA, and that is a handful of
  immutable rows per year, not a database's worth. 139 hosts × 12 months ≈ 1,668 rows.

### A mirror of Zabbix's measurement data

* Good, because it would outlive Zabbix's own retention: 31 days of history, 365 of trends.
* Bad, because it is a third copy of HCML production data, plus an ETL to keep alive.
* Bad, because Zabbix's own tables are hostile to it: `trends_uint` (102.9 M rows) has exactly one
  index, the clustered primary key.
* **Rejected in [ADR-0007](0007-keep-the-zabbix-api.md) after measurement**, not on principle.

## Links

* Follows [ADR-0001](0001-bff-over-zabbix-api.md)
* Confirmed by [ADR-0007](0007-keep-the-zabbix-api.md)
* `setup.md` §9 *Caching strategy*; `server/src/cache.ts`
* `flow/DataFlow.pdf`: every green box is derived and has no table anywhere
