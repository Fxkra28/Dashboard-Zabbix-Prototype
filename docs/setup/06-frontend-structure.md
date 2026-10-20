# 6. Frontend: structure

[setup.md](../../setup.md) · previous: [§5](05-backend-file-by-file.md) · next: [§7](07-live-updates.md)

Location: [`web/src/`](../../web/src/). Stack: React + TS + Vite, ECharts, React Router. HCML theme is
plain CSS (primary `#2B5584`, Inter and IBM Plex Mono, one set of CSS variables for light and dark; see
[`DESIGN.md`](../../DESIGN.md)).

```
web/src/
├── main.tsx, App.tsx    # the entry, and the router: 19 pages, each loaded on demand (lazy)
├── api/                 # the typed fetch client → /bff/api/*, one file per feature (sla.ts, problems.ts, ...), client.ts (request, the 401 and the failure message), session.ts (when the session ends, renewal, sign-in), index.ts (the one `api` object)
├── types/               # the Zabbix-shaped TypeScript types, one file per feature behind index.ts (held to docs/api/openapi.yaml by a test)
├── guards/              # the checks that read a reply defensively, one file per feature behind index.ts, shape.ts holding the shared checks and misfit.ts what a page says when one fails
├── theme.ts             # HCML palette + Zabbix SEVERITIES
├── generated/           # openapi.ts, made from docs/api/openapi.yaml by `npm run gen:api` (openapi-typescript); never edited by hand
├── styles/              # the whole theme (sidebar, cards, tables, chips, map svg): 18 numbered parts and index.css
├── features/            # one folder per part of the portal: its pages, components, hooks, logic and their tests
│   ├── dashboard/       # Overview.tsx (/), the Hosts view (HostsView.tsx, Tabs.tsx), the wall's rotation and fit
│   ├── problems/        # Problems.tsx (/problems) + per-row "Explain", ProblemsTable.tsx, AckDialog.tsx (the only write), liveChange.ts (when a frame of the stream says to read the list again)
│   ├── hosts/           # Hosts.tsx (/hosts), Devices.tsx (/devices), LatestData.tsx (/latest)
│   ├── graphs/          # HostDetail.tsx (/graphs?hostid=), the item and range pickers, TimeSeriesChart.tsx (ECharts), chartTable.ts and chartCsv.ts (Show data, and the CSV file of the same table)
│   ├── network/         # Sites.tsx (/sites), Maps.tsx (/maps), Network.tsx (/network), Links.tsx (/links)  [operator]
│   ├── meters/          # InternetMeters.tsx, Gauge.tsx, useMeters.ts: the internet traffic meters
│   ├── sla/             # Services.tsx (/services), Sla.tsx (/sla), Availability.tsx (/reports/availability), Sli.tsx, ReportDownload.tsx
│   ├── reports/         # Capacity.tsx, AlertNoise.tsx, TopTriggers.tsx, Inventory.tsx [admin], under /reports/
│   ├── assistant/       # Assistant.tsx (/assistant), ExplainPanel.tsx (the plain-language slide-over), parseMarkdown.ts, useAi.ts
│   ├── auth/            # Login.tsx (/login)
│   └── shell/           # Layout.tsx, Sidebar.tsx (grouped, collapsible menu), ErrorBoundary.tsx, session renewal, UI prefs
├── shared/              # what two or more features use
│   ├── components/      # KpiCard.tsx, StatusBadge.tsx, Pager.tsx, Field.tsx, states.tsx (loading/error/empty), TableWrap.tsx (a table box that scrolls gets a tab stop and a name), icons.tsx (inline SVG)
│   ├── hooks/           # useAsync.ts (fetch + loading/error + optional polling), useAuth.ts (one shared /api/auth/me probe), useSSE.ts (the live stream, for the Dashboard and the Problems page), useUrlState.ts, ...
│   └── lib/             # the "logics": severity.ts, time.ts, units.ts, plural.ts, freshness.ts, sites.ts, wall.ts, chatStore.ts, csv.ts (the one CSV writer, with its guard against spreadsheet formulas)
└── __tests__/           # the tests that cut across features (routes, back/forward, narrow screens, markup) and the layering and stylesheet tests
```

A test sits beside the file it tests (`Sidebar.tsx`, `Sidebar.test.tsx`).

`api/`, `types/` and `guards/` are folders of one file per feature, and each has an `index.ts` that re-exports its public names, so a page still
writes `import { api } from '../../api'` and `import type { Host } from '../../types'`. A test mocks `'../../api'` and still replaces the one module
the page imports. They stayed at the root, not inside the features, because the root may import no feature and a page of any feature may call any of them.

The direction is one way. Files at the root (but `App.tsx` and `main.tsx`) and files in `shared/` import no
feature, and a feature imports another only where a table in
[`__tests__/layering.test.ts`](../../web/src/__tests__/layering.test.ts) says so (the dashboard may use the
hosts, meters, problems and shell, for example), so a feature can be read, changed or deleted knowing who else is touched.
Adding a line to that table is the decision to couple two features. The reasons are in
[ADR-0013](../architecture/adr/0013-layers-features-and-tools.md). The stylesheet's parts are
[`styles/`](../../web/src/styles/), in the order the cascade needs: [`index.css`](../../web/src/styles/index.css) lists them,
and a new rule goes into the part it belongs to.

## Sidebar
[`Sidebar.tsx`](../../web/src/features/shell/Sidebar.tsx) defines three collapsible sections. Monitoring and
Reports mirror Zabbix's menu; Assistant ([§24](24-assistant.md#24-assistant-chat)) has no Zabbix
equivalent. Each section header toggles open/closed; the active route is
highlighted. Add a page by dropping an entry in the `SECTIONS` array and a `<Route>` in
[`App.tsx`](../../web/src/App.tsx), with the page itself in the feature folder it belongs to ([§12](12-extending-the-portal.md#12-extending-the-portal)).

## Data flow in the UI
- `useAsync(fn, deps, intervalMs?)`: most pages fetch with this; pass an interval to poll
  (Problems 30 s, Hosts 30 s, Latest 20 s). It exposes `{ data, loading, error, reload }`, rendered
  through the `<Async>` helper so every page gets consistent loading/error/empty states.
- `useSSE(url, event)`: the Dashboard subscribes to `/bff/api/stream` for live problems and
  falls back to polling if the stream drops.
- Cross-page links: Hosts → `/graphs?hostid=…`, Latest data → `/graphs?hostid=…`. `HostDetail`
  reads the `hostid` query param to preselect.
