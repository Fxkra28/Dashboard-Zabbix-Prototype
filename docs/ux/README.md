# Who uses this, and how

> **Derived, not interviewed. Confidence: low.**
>
> Nobody has been interviewed, no session has been recorded, and there is no analytics in the
> portal. Everything below is read out of the code, the Zabbix estate and `DESIGN.md`, and every
> claim cites where it came from. Treat it as a description of what the software permits and expects,
> which is a weaker thing than a description of what people do.
>
> The honest version of a persona needs 20+ users and two data sources. This has neither. It is
> written down because a wrong model that is visible can be corrected, and an unwritten one cannot.
> The first real interview should replace, not supplement, this page.

## What is actually known

| Fact | Source |
|---|---|
| Three roles, ranked: viewer, operator, admin | `server/src/auth.ts` `ROUTE_RULES` |
| An unmatched route needs `viewer`, so a new route is private by default | `auth.ts:43` |
| Only `/api/reports/inventory` needs admin | `auth.ts:36` |
| Only `/api/links`, `/api/net` and the two write routes need operator | `auth.ts:37,39` |
| 18 pages, 17 of them behind the shell | `web/src/App.tsx` |
| 139 monitored hosts across 14 sites | Zabbix, measured 15 September 2026 |
| Exactly one write exists: acknowledge and close | `server/src/routes/actions.ts` |
| That write is off unless `ZABBIX_WRITE_TOKEN` is set, and returns 503 otherwise | `actions.ts:69-74` |
| The Dashboard holds one long-lived SSE connection, exempt from the rate limiter | `server/src/index.ts:62-71` |
| Nothing the portal derives is stored anywhere | ADR-0003, ADR-0004 |

Everything after this point is inference from those facts.

## Three roles, three different relationships with the screen

The roles are not seniority levels. They are three different reasons to open the portal, and the
route rules draw the lines in a way that says what each one is for.

### Viewer

**Has:** every page except Network, Links and WAN, and the Inventory scorecard.

**Cannot:** reach anything that writes, because the two write routes require operator.

What the permission set implies: a viewer is trusted with the whole estate's state and with none of
its actions, including the read-only WAN topology. That is an unusual line to draw, and it is
informative. Network and Links expose which physical links exist between sites, which is closer to
infrastructure documentation than to monitoring. A viewer is someone who needs to know whether
things are working, not how they are wired.

**The screens this implies matter most:** Dashboard, Problems, SLA, Availability. Three of the four
answer a question someone else asked them.

### Operator

**Has:** everything a viewer has, plus Network, Links and WAN, plus acknowledge and close.

This is the only role that can change anything, and what it can change is one thing. The portal is
read-only except for a single write (ADR-0006), and that write is what an operator is for.

**The one job the software is shaped around:** see a problem, understand it, acknowledge it. The
journey map below is this, and it is the only flow that can be traced end to end in code, because it
is the only one that ends in an action rather than in a reader's head.

**A constraint worth designing around:** `WRITE_HOLD_MS` is 15 seconds (`actions.ts`). Zabbix applies
a close a few seconds after `event.acknowledge` returns, so the first refetch can still show the
problem as open. The interface has to be honest about that window rather than pretend the write was
instant.

### Admin

**Has:** everything, plus the Inventory and ownership scorecard.

One page, and it is not about the estate's health. It is about whether the estate's *records* are
complete: which hosts are missing an owner, a site, an inventory field. That is a management view,
not an operations one, and it is the only page whose subject is the monitoring system rather than
the network.

## The NOC wall is a fourth context, not a fourth role

`DESIGN.md` section 5 names it: the Dashboard doubles as a wall display, and `/api/stream` is exempt
from the rate limiter specifically so a wall poller does not throttle itself
(`server/src/index.ts:62-71`).

This is a real, code-backed usage context with no user attached. Nobody is signed in as "the wall".
It reads as a viewer, it never clicks, and it is looked at from several metres away by people doing
something else. Three consequences, all of which are now in the interface:

- The sidebar starts collapsed on `/` only, because nav labels are not what anyone reads from across
  a room (`useUiPrefs.ts`).
- Motion on that page is signal. A problem appearing or clearing must be visible peripherally, which
  is the one place `MOTION 1/5` is relaxed.
- Severity is the only loud colour anywhere, which is what makes a red chip readable at distance
  when everything else is one blue.

## Journey: a problem gets acknowledged

The only journey traceable end to end in code. Every step names the file that performs it.

| Stage | What happens | Where | What can go wrong |
|---|---|---|---|
| **Notice** | The Dashboard's SSE connection pushes a `problems` event; the count and the list change without a reload | `routes/stream.ts`, `hooks/useSSE.ts` | The connection drops silently. The page keeps showing the last good state with no indication it has stopped being live |
| **Orient** | Operator reads severity, host, duration. Severity is a filled chip, which is the only loud colour on the page | `ProblemsTable.tsx`, `lib/severity.ts` | Host names are Zabbix's, which are not always the names people use for the same box |
| **Understand** | Optional: open Explain, which sends the problem to the model and returns plain language, cached an hour | `routes/explain.ts` | Off by default. When off, the operator is reading a trigger expression |
| **Decide** | Operator decides this is known or being handled | none | Nothing records that a decision was made, only that an acknowledgement was sent |
| **Act** | Acknowledge, with a message, optionally closing | `AckDialog.tsx` → `POST /api/problems/acknowledge` | Returns **503** if `ZABBIX_WRITE_TOKEN` is unset. The UI hides the control in that case, so the operator's route to acting is simply absent rather than explained |
| **Confirm** | Affected cache keys drop to a 15 s TTL, then the SSE push carries the new state | `actions.ts` `WRITE_HOLD_MS` | For up to 15 seconds the problem can still read as open. Acting twice is the obvious failure |

**Where the friction is, in order of how much it costs:**

1. **A dropped SSE connection looks exactly like a quiet network.** On a page whose entire purpose is
   noticing, the worst failure is one that looks like good news. This is the highest-value thing on
   this page and it is not solved by tokens or contrast.
2. **The 15-second write window is invisible.** The operator has no way to tell "already
   acknowledged, waiting for Zabbix" from "the click did nothing".
3. **Write-back being off removes the control rather than explaining it.** Correct for a viewer, and
   confusing for an operator who has acknowledged from this screen before.

None of the three is a visual problem, which is worth saying plainly: the pass this document was
written alongside fixed contrast, tokens, focus and dark mode, and fixed none of these.

## What would actually settle this

In the order that would tell you the most per hour spent:

1. **Watch one operator for one shift.** Not a usability test, just presence. The list above predicts
   what is hard; an afternoon would confirm or destroy it.
2. **Ask three people to name the page they open first and why.** The answer distinguishes a portal
   used for triage from one used for reporting, and the two want different Dashboards.
3. **Count how often acknowledge is used.** If it is rare, the write is not what the operator role is
   for, and this whole document has the wrong centre.
