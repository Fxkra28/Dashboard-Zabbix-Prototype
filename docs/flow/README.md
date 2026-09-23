# Flow: HCML Monitoring Portal

Three views of the same system in motion. `schema/` answers *what the data is*; this folder answers
*what happens*. **Use the PDFs**; the `.mmd` files beside them are the source.

| File | Question it answers | Shape |
|---|---|---|
| [`WebFlow.pdf`](WebFlow.pdf) | What happens in the **browser**, from the first byte to data on screen? | 6 stages, 26 boxes |
| [`ServerFlow.pdf`](ServerFlow.pdf) | What happens to **one request** inside the BFF, in the order it runs? | sequence, 5 participants |
| [`DataFlow.pdf`](DataFlow.pdf) | Where does a number **come from**, and where does it **go**? | 5 lanes, end to end |

Read them in that order if you are new: the browser is what you can see, the server is what it talks
to, and the data flow is the whole journey with the trust boundary marked.

---

## The nine flows, one line each

The PDFs are the detail. These are the same flows in a form you can read in a terminal, paste into a
message, and see change in a diff. Every line comes from the source file cited beneath it, not
from the prose further down this page: that prose is what drifted last time.

### 0 · The whole system

```text
Browser (React)  ──HTTPS+SSE──►  BFF (Fastify, holds tokens, caches)  ──JSON-RPC──►  Zabbix API
```

Behind that third box is Zabbix's own MySQL. **The portal never reaches it**: no driver, no
connection string, no network route. Everything the portal adds is computed between boxes two and
three and thrown away. [ADR-0003](../architecture/adr/0003-no-database.md),
[ADR-0007](../architecture/adr/0007-keep-the-zabbix-api.md).

### 1 · Web: a page load

```text
index.html ──► main.tsx ──► <App/> ──► GET /api/auth/me ──► route match ──lazy chunk──► useAsync ──► fetch /api/… ──► table / ECharts
```

Every page is code-split. `useAsync` lets **only its newest run write state**, so picking host A and
then host B cannot leave A's slower answer on screen. A 401 from anywhere sends `api.ts` to `/login`:
that is the *only* automatic path to it, because nothing guards routes by role in the browser. The
sidebar's role filter is cosmetic; the BFF returns 403 regardless. `web/src/App.tsx:42-71`.

### 2 · Web: the live dashboard

```text
Dashboard ──EventSource /api/stream?token=──► BFF ──tick 5 s──► Zabbix ──event: problems──► setState
```

`useSSE` has exactly one call site, `Overview.tsx`; navigating away closes the connection, and the
Problems page polls instead. The server ticks every 5 s but only writes when the fingerprint changed
or 30 s have passed, with a `: keep-alive` comment every 15 s. The token rides in the query string
because `EventSource` cannot set an `Authorization` header, which is the whole reason `logging.ts`
exists, to keep it out of the request log. `server/src/routes/stream.ts:21-24,218`.

### 3 · Server: one request

```text
request ──► helmet ──► CORS ──► rate limit ──► compression ──► error handler ──► auth guard ──► route ──► cached() ──► zabbix.ts ──► JSON
```

That is `index.ts` registration order, and **the order is the design**: a Fastify hook only covers the
routes registered after it. The rate limit sits ahead of the auth guard deliberately: a flood should
be rejected before the server spends work verifying JWTs, and `POST /api/auth/login` would otherwise
be an unthrottled password oracle. `server/src/index.ts:53-121`.

### 4 · Server: the cache

```text
cached(key, ttl, fn) ──► fresh hit │ join in-flight │ stale-while-revalidate │ miss ──► Zabbix
```

Four *outcomes*, not four checks: "already fetching" and "miss" are the same line of code,
`inflight.get(key) ?? begin(key, fn)`. 500 entries, TTLs from 5 s to 24 h, all of it gone on restart.
This is why twenty NOC screens cost one upstream read. Stale serving is never permitted for anything
showing problem or acknowledgement state. `server/src/cache.ts:64-144`.

### 5 · Auth

```text
POST /api/auth/login ──► JWT, 12 h ──Authorization: Bearer │ ?token=──► onRequest guard ──ROUTE_RULES──► 200 │ 401 │ 403
```

Users come from the environment, not a table: `PORTAL_USERS` as `name:password:role` triples, or
`PORTAL_USER`/`PORTAL_PASS` as the single-admin shorthand. Three rules gate three route families:
**admin** for `/api/reports/inventory`, **operator** for `/api/links`, `/api/net` and the acknowledge
write, and anything unmatched needs **viewer**, so a new route is protected by default rather than
accidentally public. `/api/health` and `/api/auth/*` are the only exemptions.
`server/src/auth.ts:34-40,89,126-132`.

### 6 · Data: where a number comes from

```text
device ──ICMP/SNMP──► Zabbix poller ──► MySQL history + trends ──JSON-RPC──► BFF derives site · link · incident · SLA ──► browser
```

Follow any number backwards from the screen and you arrive at Zabbix's MySQL, **except** the derived
ones, which stop at the BFF. Sites, links, incidents, host availability and the monthly SLA have no
table anywhere ([ADR-0004](../architecture/adr/0004-derive-the-sla-in-the-portal.md)). Note also that
box two has been switched off since **17 September 2026, 16:59:37**: local polling was stopped
deliberately, so every figure downstream is a snapshot of that moment
([ADR-0008](../architecture/adr/0008-stop-local-polling.md)).

### 7 · AI: Explain

```text
ExplainPanel ──GET /api/explain/problem──► ai.ts ──HTTPS──► api.anthropic.com (claude-sonnet-4-6) ──► buffered JSON, cached 1 h
                                                     ⚠ LEAVES THIS MACHINE
```

Reached **on demand only**, never on page load, and only if the layer is configured at all. One
problem crosses: host, trigger name, opdata, severity, start time, the acknowledged/resolved flags
and that problem's tags. `/api/explain/sla` is the second route on this path and is cached 5 minutes,
not an hour. `server/src/routes/explain.ts:64,82,103`.

### 8 · AI: the Assistant

```text
Assistant ──POST /api/chat──► estate snapshot + ≤3,000 chars of history ──► model ──SSE: context → token… → done──► markdown.ts
```

The Assistant is the larger of the two AI paths by a wide margin: Explain sends one problem, this
sends a rollup of the whole estate: all 139 hosts by site, the open problems, unreachable-host lists
and derived SLA figures. Streamed token by token and **never cached**, where Explain is buffered and
cached. `HISTORY_CHAR_BUDGET` is the one hard cap in the prompt, at 3,000 characters.
`server/src/routes/chat.ts:31,119`.

### 9 · The one write

```text
Acknowledge ──POST /api/problems/acknowledge──► operator role + ZABBIX_WRITE_TOKEN ──► event.acknowledge ──► cache invalidate ──► SSE push
```

The portal's only write, behind a token separate from the read token. Leave `ZABBIX_WRITE_TOKEN`
unset and the portal is provably read-only: `/api/health` reports `writeBack: false` and the UI hides
the control. The invalidate and the push are drawn as a parallel fork in `DataFlow` but run in
**sequence**: `event.acknowledge` is awaited first.
[ADR-0006](../architecture/adr/0006-read-only-with-one-write.md), `server/src/routes/actions.ts:68`.

---

## What this copy's perspective is

This is **`hcml-portal`**: the plain-language layer is **hosted Claude** over the Anthropic API. That
is why `DataFlow` carries a **red** box and a second red box next to it reading *LEAVES THIS MACHINE*:
when someone clicks *Explain*, a problem's host name, trigger name, tags and severity cross the
network to a third party.

Be precise about *how much* crosses, because the two AI paths differ and the Explain path is the
smaller one. **Explain** sends one problem: host, trigger name, opdata, severity, start time, the
acknowledged/resolved flags and that problem's tags. **The Assistant** sends the *entire estate
snapshot*: up to 5,500 characters covering all 139 hosts rolled up by site, up to 20 open problems
with host and trigger text, unreachable-host lists and derived SLA figures, plus an optional
800-character site focus block and up to 3,000 characters of prior conversation. The `LEAVES` box's
own wording ("host names, trigger names and problem text") is the honest summary of both.

The sibling repo `hcml-portal-ollama` has the same three diagrams drawn from its own perspective:
there the model is `qwen3:8b` on the host, the same box is **green**, and there is no boundary box at
all because nothing crosses one.

`WebFlow.mmd` and `ServerFlow.mmd` are **byte-identical in both repos**. Verify with `diff`, not by
eye, and honestly so: the browser and the request pipeline do not know or care which model answers.
Inside this folder only `DataFlow.mmd`, `DataFlow.pdf` and this README differ, and `DataFlow` differs
in exactly **three rendered lines**: the `MODEL` box, the `LEAVES` box, and the `class MODEL,LEAVES`
line that colours them. (Outside this folder the repos also differ in `README.md`,
`AUDIT_REPORT.md`, `docker-compose.yml`, the `.env` files and the
`schema/` diagrams, so "the repos differ only in DataFlow" is true of *this folder*, not of the
whole tree.)

---

## How to read each one

**WebFlow: a flowchart, six numbered stages.** Boot → who is this → a page asks for data → the live
stream → the on-demand extras → what happens when it fails. Amber is code running in the browser;
the single green box is the BFF, where this diagram hands over to `ServerFlow`; grey boxes are
decisions and guards rather than components.

Three things on it are easy to miss and cost real bugs if you forget them:

- `useAsync` lets **only its newest run write state.** Pick host A, then host B, and A's slower answer
  must not land last and stay on screen.
- Polls are **sequential**, not on a fixed timer: the next is scheduled once the last settles, so a
  slow BFF is never asked twice at once.
- The SSE token rides in the **query string**, because `EventSource` cannot set an `Authorization`
  header. That is also why `logging.ts` exists: to keep it out of the request log.
- **Only the Dashboard streams.** `useSSE` has exactly one call site (`Overview.tsx`), and navigating
  away closes the connection. The Problems page does not stream: it polls every 30 s.
- **`ExplainPanel` does not render markdown.** It writes its fields as plain `<p>` paragraphs; the
  Assistant is the only consumer of `lib/markdown.ts`.
- **Stage 2's "signed in?" diamond is not a route guard.** Nothing reads the role and redirects: the
  only automatic path to `/login` is `api.ts` reacting to a 401, so an unauthenticated visitor sees
  the chrome painted for one round trip before the redirect lands. The sidebar's role filter is
  cosmetic; the BFF enforces with a 403 regardless.

**ServerFlow: a sequence diagram.** Read strictly top to bottom: **that order is the design.** A
Fastify hook only covers the routes registered after it, so `index.ts` registers helmet, CORS, the
rate limit, compression, the error handler and the auth guard *before* any route module. The rate
limit sits ahead of the auth guard deliberately: a flood should be rejected before the server spends
work verifying JWTs, and `POST /api/auth/login` is otherwise an unthrottled password oracle.

The `alt` blocks are the four cache outcomes, and they are the reason twenty NOC screens cost one
upstream read: fresh, coalesced, stale-while-revalidate, or a genuine miss. Read them as four
*outcomes*, not four checks: "already fetching" and "miss" are the same line of code
(`inflight.get(key) ?? begin(key, fn)`), drawn apart because the cost differs so much. Note too that
the stale-while-revalidate lane **cannot fire on the `/api/sites` request being traced**: `staleMs`
is 0 there, and stale serving is never permitted for anything showing problem or acknowledgement
state. It applies to the slow reports only.

Two numbers in the red band are deliberate and easy to "fix" wrongly: a rejected token and an
unresponsive Zabbix both return **503**, not 502/504, because they are *configuration* states rather
than upstream faults, and **nothing in the server ever returns 504**. Both are pinned by tests. Only
`zabbix_error` is a 502.

**DataFlow: five lanes, top to bottom, each read left to right.** Lane 1 is Zabbix doing the work we
do not do. Lane 2 is the BFF. Lane 3 is the plain-language layer, reached **on demand only**, never
on page load. Lane 4 is the browser. Lane 5 is the single write.

Lane 5 ends in its own terminal box rather than an arrow looping back to lane 1. It is the same
Zabbix API; the arrow is omitted because one cycle is enough to make the layout engine scramble the
reading order of every other lane. Lane 5's two leaves are drawn as a parallel fork but run in
**sequence**: `event.acknowledge` is awaited first, and only then does the invalidate + push run.

Two things lane 3 is easy to misread. The **answer** box describes two different features and neither
has both properties: *Explain* is cached 1 h per problem-and-state and returns one buffered JSON
reply, while the *Assistant* is streamed token by token and is never cached. And the arrow into the
snapshot carries **no tags**: the chat snapshot emits severity, host, trigger name, opdata, age and
ack state; tags cross on the per-problem Explain path alone. When editing the source, note the
subgraph IDs do not match the lane numbers: lane 3 is `D4` and lane 4 is `D3`. Go by the titles.

### Colours, in all three

| | |
|---|---|
| 🟦 Blue | Zabbix owns it and stores it |
| 🟩 Green | The portal derives it. No table exists: built per request, cached for seconds, gone on restart |
| 🟨 Amber | Runs in the browser |
| 🟪 Purple | The portal's single write back to Zabbix |
| 🟥 Red | It leaves this machine |
| ⬜ Grey | A decision, a guard, or a boundary |

The same palette as [`../schema/`](../schema/), so a box means the same thing in both folders.

**One exception, worth knowing before you present:** `ServerFlow`'s five `rect` bands are *phase*
bands, and two of them reuse a colour from this table with a different meaning. Its **amber** band is
the `onRequest` auth guard running **inside the BFF**, not browser code. Its **red** band is
"when Zabbix does not cooperate": an upstream failure, and nothing leaves the machine there. Grey
(guard), green (derived) and purple (the one write) do match the table. Only `DataFlow`'s red means
"it leaves this machine".

---

## One thing worth noticing across the three

Follow any number backwards from the screen and you arrive at Zabbix's MySQL, **except** for the
green boxes, which stop at the BFF. Sites, links, incidents, host state and the monthly SLA have no
table anywhere: they are computed per request, cached for seconds, and gone when the container
restarts.

That is the portal's whole reason to exist, and it is also its whole risk profile. There is nothing
to back up, no migration to run and no schema to version, and equally, nothing survives a restart,
so every figure must be cheap enough to recompute on demand. The TTLs in `DataFlow` lane 2 are where
that trade-off is actually set.

---

## Regenerating

From inside this folder, after editing a `.mmd`:

```bash
npx @mermaid-js/mermaid-cli -i WebFlow.mmd    -o WebFlow.pdf    -w 2600 -b white --pdfFit
npx @mermaid-js/mermaid-cli -i ServerFlow.mmd -o ServerFlow.pdf -w 2600 -b white --pdfFit
npx @mermaid-js/mermaid-cli -i DataFlow.mmd   -o DataFlow.pdf   -w 2600 -b white --pdfFit
```

`--pdfFit` sizes the page to the chart; without it the diagram is squeezed onto A4 and unreadable.
For a raster copy to paste into slides, swap the output for `.png` and add `-s 2`.

Four rules these sources must keep, all learned by breaking them:

- Every `subgraph` needs a `style <NAME> fill:none,stroke:#94a3b8` line. Mermaid paints cluster
  rectangles *after* the relationship lines, so a filled frame hides every edge beneath it.
- A comment line must start with `%%`. A bare `%%` with no text is a parse error in `erDiagram` and,
  worse, a silent **node labelled `%%`** in a `flowchart`. Separate comment paragraphs with a
  genuinely empty line.
- **`DataFlow` deliberately does not use `layout: elk`.** Its lanes need per-subgraph `direction`,
  and elk ignores that: with elk the whole chart flattens into a 6:1 strip. `WebFlow` has no inner
  directions and keeps elk.
- **Avoid numeric HTML entities** such as `&#9888;` in node labels; they render with a stray `&`
  in front. Named entities (`&middot;` `&mdash;` `&hellip;` `&rArr;`) are fine.

After any edit, check the render rather than the source: count that each lane still reads in order,
and that no box has lost an edge.

---

## If you want more than these three

[`../../setup.md`](../../setup.md) walks every subsystem in prose, §1 is the big picture and §2 traces a
request end to end, which is the same ground as `ServerFlow` in words. [`../schema/`](../schema/) is
the same system at rest, CDM, ERD, PDM, and [`../../erd.md`](../../erd.md) is the exhaustive version of
that.
