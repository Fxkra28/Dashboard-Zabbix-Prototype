# 25. Derived SLA and services

[setup.md](../../setup.md) · previous: [§24](24-assistant.md) · next: [§26](26-reachability-caching-and-operations.md)

HCML's Zabbix has no services and one SLA (`SLA:1`, weekly) with nothing attached, so Zabbix's own
SLA engine has nothing to measure and the Services and SLA pages were empty. HCML still publishes a
monthly *Availability Report* per device, built from Zabbix trigger history. The portal now does
that measurement itself, read-only: [`sli/engine.ts`](../../server/src/sli/engine.ts). Nothing is created
in Zabbix.

## Two methods, because HCML's figure and the truth differ

| Method (`profile`) | Counts as down | Hours with no collected data | Aug 2026 overall |
|---|---|---|---|
| `hcml-report` | only High ICMP ping loss | counted as up; silent devices count 100% | 99.2313 %: HCML's published figure, exactly |
| `availability` *(default)* | Unavailable by ICMP ping or high loss | left out of the measurement; too little data ⇒ "no data" | 89.46 % across the 93 devices with data |

"High ICMP ping loss" is defined as loss below 100%, and depends on "Unavailable by ICMP ping",
so a device that is completely down never fires it. In HCML's own August report `4.3.4 FPSO ARUBA 4`
counts as 100% available while it was unreachable all month. The strict method is the headline;
the report method is shown beside it so the published figure can still be checked.

## How a figure is computed

1. Window. A calendar month cut at midnight `SLA_TIMEZONE` ([`sli/time.ts`](../../server/src/sli/time.ts)),
   or a rolling window for the availability report.
2. Triggers. `trigger.get` by name (`SLI_REPORT_TRIGGERS` / `SLI_AVAILABILITY_TRIGGERS`), not
   filtered to monitored hosts: HCML's report lists disabled hosts too. The report category is the
   host's device template (`Cisco IOS by SNMP`, `Generic by SNMP`, `FortiGate by SNMP`, else `ICMP Ping`).
3. Events. Every PROBLEM/OK event in the window, fetched in slices
   ([`sli/events.ts`](../../server/src/sli/events.ts)): a full page is split in half rather than accepted,
   so the result is never silently truncated.
4. Replay. Each trigger's events are replayed from the state it was in when the window opened:
   the same approach as Zabbix's own `calculateAvailability`. A trigger with no events in the window
   is in its current state, unless it only changed afterwards, in which case the first later event
   says what it was. A problem still open at month end is clipped to the last second (HCML's rule).
5. Per device. Intervals of all its triggers are merged, so overlapping loss and unavailability
   count once.
6. Coverage (strict only). An hour counts as collected when its `icmpping` trend row holds at
   least half the expected samples; the hour or two not yet in trends come from raw history.
   Downtime is only counted inside collected time, and the figure is `downtime / collected`. Hours in
   which fewer than 10% of devices collected anything are reported as estate gaps (e.g. the
   stack being stopped) rather than blamed on any device.
7. Totals. Every group (overall, category, site, device class) is the plain mean of the
   devices that have a figure, HCML's rule.

WAN legs are paired by name (`INET : SAMPANG WAN 1/2` → path `SAMPANG`); a path is down only while
all legs are down. Web scenarios on the *Web Monitoring* host are measured from `web.test.fail`.

## Hours declared not measured

A collector cut off from the network keeps collecting: every ping it sends fails, so Zabbix records
a real-looking outage for every device. Those hours cannot be told apart in the data, so they are
named in a setting instead. `SLA_NO_DATA_WINDOWS` lists them as start/end in ISO time with the zone,
comma-separated:

```bash
SLA_NO_DATA_WINDOWS=2026-10-26T16:10+07:00/2026-10-26T21:03+07:00
```

Both methods then treat those hours as hours with no data: the strict method leaves them out, the
report method counts them as up, and the legacy all-problems basis counts no downtime in them. The
SLA pages, the Services tree and the workbook say which spans were declared. Nothing in Zabbix
changes, and removing the setting brings the old figures back. A value the BFF cannot read stops it
at start-up with an example, rather than being ignored.

The Dashboard and the Problems page say when it is happening: when at least 10 devices were pinged
and at most a fifth answered, `GET /api/freshness` returns `reachLost: true` and both pages show a
notice that the down hosts and new problems are most likely not real.

## Checked against HCML's own reports

[`scripts/validate-sli.ts`](../../server/scripts/validate-sli.ts) reads the Jun/Jul/Aug 2026 report
workbooks and compares them with `GET /api/sli?profile=hcml-report`:

| Month | Overall (portal = report) | Devices | Within 60 s of downtime | Incidents |
|---|---|---|---|---|
| 2026-06 | 99.3796 % | 138 | 138 / 138 | 739 / 739 |
| 2026-07 | 99.7167 % | 138 | 138 / 138 | 1,165 / 1,165 |
| 2026-08 | 99.2313 % | 138 | 138 / 138 | 1,417 / 1,417 |

Category counts (51 / 42 / 31 / 14) and category figures match within 0.005 pp. Run it with the BFF
up: `cd server && npx tsx scripts/validate-sli.ts`. The workbooks hold real host names and event
ids, so they are read in memory and nothing from them is stored.

## Endpoints

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/sli?month=&profile=` | per device, category, site, class; WAN paths; web checks; gaps | closed month 24 h, current month 5 min |
| `GET /api/sli/export?month=&format=` | both methods for the month, side by side, as a PDF or an Excel file (§18) | none of its own beyond ten seconds of reuse |
| `GET /api/services/derived?month=&profile=` | a service tree in `/api/services`' shape: estate → business services / sites → device classes → devices, with live status from open problems | 30 s |
| `GET /api/sla/source` | `{ real, slas, services }`, whether Zabbix's own SLAs have anything to show | 60 s |
| `GET /api/explain/sla?source=derived&month=&profile=&scope=` | plain language for `overall`, `site:N` or `category:NAME`; a deterministic "no data" answer without a model call when nothing was measured | 5 min |
| `GET /api/reports/availability?basis=availability` | the availability report, now on this engine (default); `basis=all-problems` keeps the original any-problem report, no longer truncated | 2 min |

A closed month of the strict method costs about 20 Zabbix calls and 0.6 s cold; the report method
about 6 calls and 0.2 s.
