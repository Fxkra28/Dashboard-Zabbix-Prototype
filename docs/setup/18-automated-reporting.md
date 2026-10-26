# 18. Automated reporting

[setup.md](../../setup.md) · previous: [§17](17-link-wan-health.md) · next: [§19](19-authentication-rbac.md)

Implements `plan_1.2.md` (in `myown/documents/plan/`, outside this repo) Phase 6, serving HCML Goal 6: *"hard to see SLA,
capacity trends, and recurring issues."* Recurring issues were already covered by Top 100 triggers;
these add the other two, plus response time.

## Availability: `/api/reports/availability`

Zabbix stores events; turning them into uptime is arithmetic it doesn't do. The BFF replays history:

1. `event.get` for PROBLEM events in the window (severity-filtered), read in slices that halve until
   none holds a full page, so a busy month is never a silently cut list. The same for the 31 days
   before it, and `problem.get` for every problem still open now, whatever its age.
2. Each carries `r_eventid`; the window's recovery events are read once, and any other recovery is
   fetched by id in batches of 2,000 for its clock.
3. An outage that began before that look-back and ended inside the window is found from the other
   end (BK-04). A recovery event carries no link to its problem, so the first recovery of each trigger
   that no known problem explains is followed back: the trigger's last problem before the look-back
   is asked for, and kept when it names that recovery. Zabbix gives a recovery severity 0 whatever the
   trigger's priority, so the severity floor is applied to the triggers, not to the recoveries.
4. Each problem becomes an interval, clipped to the window; still-open ones run to *now*.
5. Overlapping intervals are merged per host: two simultaneous problems are one outage, not
   two. Without this, availability can go *negative*, which is the trap here.

All of it is `fetchIncidents()` in [`services/incidents.ts`](../../server/src/services/incidents.ts).

Availability is then *"share of the period with no open problem at or above the chosen severity"*,
and the page says exactly that, because it isn't the same thing as ICMP uptime.

> The look for older outages is bounded: at most 200 triggers (`LONG_OUTAGE_LOOKUPS`). Past that the
> report sets `truncated: true`, and the UI labels the figures a floor. Silently understating downtime
> while looking authoritative would be worse than saying so. (A window so dense that one second holds
> a full page of events is refused with an error rather than reported on.) Still missed: a problem
> that began before the look-back and was resolved after the window ended.

## Action aging: `/api/reports/aging`

How long problems sit unacknowledged, in buckets (<1h, 1–4h, 4–24h, >24h) plus the longest-waiting
list. This is the *"the team repeats manual checks"* half of Goal 4, measured.

## Capacity: `/api/reports/capacity`

Reads `trend.get` (hourly aggregates), falling back to `history.get` on an instance too young to
have trends: otherwise a fresh deployment shows an empty report and looks broken. Verified key
matchers:

| Metric | Matches | Trap |
|---|---|---|
| CPU | `system.cpu.util` exactly | `system.cpu.util[,idle]` is the *idle* share: the opposite |
| Memory | `vm.memory.util` | `vm.memory.size[available]` is bytes, not a percentage |
| Filesystem | keys ending `,pused]` | none |

Rows carry `source: 'trend' | 'history' | 'none'`, and the page states when a zero means *no data*
rather than *idle*.

## The SLA report as a file: `/api/sli/export`

The monthly SLA report downloads as a PDF, to print or attach to an email, or as an Excel workbook,
to sort and total. Goal 6 is *Automated reporting*, and this is its on-demand part: someone asks,
and the file is made. A scheduled or emailed report is not built (§27).

On the page. The SLA page (its *Derived monthly SLA* view) and the Availability page each show
two buttons in the controls row, *PDF report* and *Excel report*. The Availability page shows them
only when the period is one calendar month and the basis is Availability (ICMP): a rolling window
and the legacy basis have no SLA month to report. Its buttons download the same report as the SLA
page's, not that page's own table. Both pages keep the buttons off until the figures on screen have
loaded. A press calls `GET /api/sli/export` and saves the answer under the name the BFF sends, such
as `HCML_SLA_Report_2026-08.pdf`. While a file is being prepared the button reads *Preparing PDF…*
and a second press does nothing. A failure appears next to the buttons and names the format that
failed. The code is `web/src/features/sla/ReportDownload.tsx` and `api.sliExport` in `web/src/api/sla.ts`.

What is in the file. Both formats are made from one document, so they say the same thing.

| | PDF | Excel |
|---|---|---|
| Key figures | Four cards: overall SLA by each method, devices measured, sites below target | The same four as a table on the *Summary* sheet, below the report's title, month, period and time of generation |
| Chart | SLA by site against the target line, worst site first | None. The figures are in the tables |
| Tables | By category, By site, By device, WAN paths, Web checks, Devices never measured, each column sized to its longest value before any name is cut | One sheet each, in that order, each column sized to its longest value (up to 45 characters). The sheet for *Devices never measured* is named *Never measured* |
| Notes | *How to read this report* and *How it was computed* | The same two, under the key figures on the *Summary* sheet |
| Print | A4 landscape. A header band with the logo on page 1, a footer with the report name and *Page x of y*, and a bookmark for the chart, each table and each note | A4 landscape, one page wide. The header row repeats on every printed page, and the footer carries the page numbers |

The figures are the page's. The route asks for both methods, `availability` (strict) and
`hcml-report`, through `getMonthlySli`, the cache `/api/sli` fills (§25), so a month the SLA page
has already loaded costs no further Zabbix call. Every table puts the strict figure first and HCML's
beside it, and the *Status* columns judge the strict one. They say Met, Missed or No data in words,
so a verdict never rests on colour. A device with no data reads No data, never 0%. A figure that
would round up to the target while falling short prints more digits (98.996%, not 99.00%), so it
never sits beside the word Missed looking like a pass. The wording is the SLA page's. The period
line says whether the month has closed; for a month still running it says how far the figures run
and that they are not final.

How it is built. `server/src/export/` builds the report once as a document model (`types.ts`):
key figures, an optional bar chart, tables and notes, each figure already formatted and carrying the
tone it takes. `slaReport.ts` fills the model from the two derived reports. It is pure, with no
Zabbix, no config and no clock but the one it is handed. Two writers turn the same model into a
file, and neither knows anything about SLAs, targets or Zabbix. They use no library. Both are
written on Node's `zlib` and `crypto` modules and no package was added (ADR-0011,
`docs/architecture/adr/0011-build-the-sla-report-files-in-the-bff.md`).

The PDF writer is `pdf.ts`, with `pdfFonts.ts` and `logo.ts`. It writes A4 landscape by hand with
the standard Helvetica fonts, which no viewer needs embedded, so the file stays small and opens the
same everywhere. It lays out every page before it draws one, so *Page x of y* is right. It sizes a
table's columns to their content first, and cuts a name that is still too long with an ellipsis. The
logo is a copy of `web/public/logo-mark.png` in `logo.ts`, beside a small PNG reader, because the
BFF image holds `server/` only. A test compares the copy with the original byte for byte.

The workbook writer is `xlsx.ts`, with `zip.ts`. It writes SpreadsheetML by hand and packs it with a
small zip writer. The header row is blue and frozen, rows are banded, each table sheet has a filter
over its rows, and Met and Missed show in words and colour. Percentages are stored as numbers in
percent points (98.9812, not 0.989812) and shown with four decimals and a % sign. Durations are
stored as times formatted `[h]\:mm\:ss`, the colons escaped so that an Excel whose time separator is
a dot (Indonesian) still shows 4:19:35, and counts as numbers, so all of them sort and total. The
Summary prints on one page; each table sheet prints one page wide and as many long as it needs. A
missing figure is the text *No data*, never an empty cell. Every text is stored as text and is never
evaluated as a formula, so a device named `=HYPERLINK(...)` stays a name. The elements in each part
follow the schema's order, because Excel offers to repair a file that breaks it.

Colours. Reports always use the light theme, because they are printed and attached to email,
whatever theme the viewer's screen uses. The colours are copied from the light tokens in
`web/src/styles/01-tokens.css` into `theme.ts`, and `export-theme.test.ts` fails if one drifts.

The route. `GET /api/sli/export?month=YYYY-MM&format=pdf|xlsx`, viewer role like the pages it
serves ([§19](19-authentication-rbac.md#19-authentication--rbac)), by session cookie or bearer token:

```bash
# -f makes curl fail on an HTTP error, so an error message is not saved as the file
curl -fsS "$BFF/api/sli/export?month=2026-08&format=xlsx" -H "Authorization: Bearer $TOKEN" -o report.xlsx
```

`month` defaults to the current month in `SLA_TIMEZONE`. `format` is required. A bad month or format
is a 400, refused before Zabbix is asked, so it costs nothing. So is any other parameter, so a misspelt
`month` is not quietly read as the current month. The engine adds a 400 for a month
that has not started or is more than about 400 days back, and a Zabbix failure is the usual 502 or
503. The file name is made from the validated month alone, so no request text can reach a header.
The answer carries `Cache-Control: private, no-store` and is never compressed. Nothing is kept for
long: a built file is reused for ten seconds, so a burst of requests for one month and format shares
one build (about 10 ms of CPU), and after that it is built again from the cached figures.

Stale figures. The route reads the same cache as `/api/sli`, which serves its last good run
while Zabbix is failing (`staleIfError`, §26). The file is then a 200 built from older figures, and
the response says so with `X-Data-Stale: true` and `X-Data-Age-Seconds`. For
a month still running, its period line shows how far the figures run, for each method when the two
end more than a minute apart.

Size and speed. The test report has 138 devices across 14 sites. Its PDF is about 10 pages and
69 KB, and its workbook is about 23 KB. In a fresh process the first PDF took about 60 ms and later
ones about 10 ms, and the workbook took about 14 ms, then 9 ms. These are single builds on the
development laptop, measured on 2 Oct 2026. Both writers compress with synchronous `zlib` calls, so
the BFF answers nothing else while one runs, and the time grows with the number of rows.

How it was checked. `server/src/__tests__/export-*.test.ts` build both files from a report
shaped like the real one and read them back. For the PDF that means its cross-reference table, page
tree and bookmarks, and that every text sits inside its margin and its column. For the workbook it
means the parts, the relationships, the style ids and the element order. The tests give the writers
hostile names (a leading `=`, `+`, `-` or `@`, a literal `_x0041_`, characters XML forbids, a name
too long for its column) and check that the same document and time give the same bytes.
`ReportDownload.test.tsx` and `reportApi.test.ts` cover the buttons and the download request. By
hand, the PDF was checked with `pdfinfo`, `pypdf`'s strict reader and a visual review, and the
workbook with `openpyxl`'s strict reader, macOS Quick Look and a check of element order against the
schema. **Not checked: Microsoft Excel itself, and HCML's own data.** Every name in the test report
is made up. Docker, and the Zabbix stack in it, was down when the checks were made, so no report
could be built from HCML's data.

What the files leave out.

- The PDF embeds no font. Text outside Western European letters prints as `?`, so a device named in
  Cyrillic or Chinese would show as a row of question marks. Accents and curly quotes print as
  written. The PDF is not PDF/A and is not tagged for screen readers.
- The workbook has no chart. The same figures are in its tables.
- There is no CSV of this report (the Alert noise page, the Inventory scorecard and the Graphs page's Show data have one each), and no scheduled or emailed report.
- A group row's downtime adds up the downtime of all the group's devices, including devices with too
  little data to score. Those devices are left out of the group's average but not out of its
  downtime. `aggregate()` in `server/src/sli/engine.ts` does this and the SLA page shows the same
  sum, so a group's downtime and its SLA do not always describe the same devices. The report's notes
  say that a group row adds up all its devices.
