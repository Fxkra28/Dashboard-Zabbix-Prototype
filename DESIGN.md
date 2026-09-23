# Design direction

The brief below is the portal owner's, given 23 September 2026. It is the source of direction.
`antislop.md` is the filter that checks work against it; this file is what the filter checks
against. The two are not interchangeable: a filter rejects slop, it does not supply taste.

Sections 1 to 6 are the owner's words. Section 7 is measurement, added by verification, and every
figure in it is reproducible from the hex values in section 3.

Em dashes in the original have been converted to periods, commas or colons, following the decision
of 22 September 2026 that portal prose carries none. No wording was otherwise changed.

---

## 1. Identity

A shift-length instrument panel that shows its work when asked. Not a device inventory browser, and
not a chatbot with a dashboard bolted on. It exists specifically because Zabbix's own UI can't be
this: site-structured, role-aware, organised by service instead of device. That's the thing to
protect visually: every screen should read as "translated Zabbix", never as "Zabbix, but shinier".

## 2. Personality

Composed, exact, plain-spoken. Should never feel like a chatbot product. The Assistant page answers
from a read-only snapshot in the same measured voice as every other page, not a friendly mascot with
exclamation points. (The portal is read-only except one write, acknowledge and close, so restraint is
functionally true of it, not just a style choice.)

## 3. Palette

Confirmed already in place: `#0067B1`, with light and dark served by one set of CSS variables. Extend
it as a ramp in both modes rather than inventing a second hue: the blue schema, not one fixed value.

| Role | Light | Dark | Use |
|---|---|---|---|
| Chrome / ink | `#0A2540` | `#0D1B2A` | Sidebar, header |
| Primary | `#0067B1` | `#3E93D6` (lightened for AA contrast on dark) | Active nav, links, primary actions |
| Mid | `#4A90C2` | `#5FA8DE` | Secondary interactive, borders, icons |
| Tint / hover | `#EAF2F8` | `#16324A` | Hover, selected rows |
| Surface | `#FFFFFF` | `#0D1B2A` | Page and card background |

> **Superseded in part, 23 September 2026.** The logo file measured `#2B5584`, and the owner chose to
> adopt it as the primary. The ramp's structure and every rule in this section still hold; only the
> chromatic values moved. Section 8 has the measurements and the replacement table. The brief is left
> as written, because it was right about the shape of the problem before the file existed.

**Note on dark mode specifically.** `#0067B1` at full saturation under-contrasts as foreground (text
or icon) on a dark surface. Fine as a background or large block, but interactive elements need the
lightened `#3E93D6` step, not the raw brand hex, to stay AA-legible.

**Severity collision.** With 18 pages and 38 endpoints worth of tabular data, blue links and blue
chrome are already everywhere. The six fixed Zabbix severity colours are the only thing allowed to be
loud. That matters most on Problems, Alert noise, Top 100 triggers, and the streaming Dashboard,
where severity is the entire point of the page.

## 4. Typography

Confirmed: Inter, already in place. Keep it.

Add a monospace face specifically for the data this portal is full of: host names, trigger names, IPs
on Links and WAN, packet-loss thresholds (2% and 10%), the 99% SLA target, timestamps. Anywhere a
number or identifier is meant to be scanned or compared row-to-row, not read as prose.

## 5. Mood dials

**ENERGY 2/5 · RHYTHM 2/5 · MOTION 1/5**, with a concrete exception for the one page that differs.

The Dashboard streams over SSE and doubles as a NOC-wall display: the rate limiter explicitly exempts
`/api/stream` so a wall poller doesn't throttle itself. Motion there is signal, not decoration. A
problem appearing or clearing should be visible at a glance from across a room. The same logic covers
the Assistant's token-by-token streaming text.

Everywhere else MOTION stays close to zero. This is a tool people watch for a full shift, and
anything animated that isn't a real state change trains operators to ignore motion, which is the one
thing you can't afford in a room that exists to notice things.

## 6. Sidebar behaviour

Collapsible, not just hideable outright. Default expanded (icons and labels), toggles to a slim
icon-only rail on click, never fully vanishing, since losing all nav context on a page someone's
watching for hours is worse than the width it saves. A chevron at the sidebar's edge is the toggle.
The width transition should be quick and snappy, sitting inside the MOTION 1/5 budget as one of the
few motions that's earned: it's a direct response to a click, not ambient decoration.

Worth remembering across page loads via `localStorage` (`collapsed: true/false`). That's a small UI
preference, not portal data, so it doesn't fight the "nothing persists" line in Known gaps (that's
about audit trails and saved views, not chrome state) and it doesn't need a backend change or a state
library, consistent with the hand-rolled, no-extra-dependencies approach already in place.

Default-collapsed specifically for the Dashboard route, since that's the one page meant to run on a
NOC wall: every extra pixel goes to the live problem feed rather than nav labels nobody's clicking on
a wall display. Everywhere else, default expanded.

---

## 7. Verification, and four things the brief left open

Contrast figures are WCAG 2.1 ratios computed from the hex values above. AA is 4.5:1 for body text,
3:1 for large text and for the boundary of a user interface component (1.4.11).

### What the brief got right, confirmed by measurement

| Claim | Measured | Verdict |
|---|---|---|
| Raw `#0067B1` under-contrasts on dark | **2.96:1** on `#0D1B2A` | Correct, fails AA |
| `#3E93D6` is the legible step | **5.26:1** on `#0D1B2A` | Correct, passes AA |
| White on chrome `#0A2540` | **15.54:1** | Passes with room to spare |
| `#0067B1` on white, and on tint `#EAF2F8` | **5.87:1** and **5.19:1** | Both pass AA |
| `#5FA8DE` on `#0D1B2A` | **6.74:1** | Passes AA |

### R-1. Dark chrome and dark surface were the same colour

The table gives `#0D1B2A` for both Chrome and Surface, so the sidebar would have been invisible
against the page. Contrast between them is **1.00:1**.

This cannot be fixed by spacing the two values further apart. The WCAG formula adds `0.05` to both
luminances, and at near-black that constant dominates, so any two colours in this navy family land
between **1.05 and 1.14** however far apart they look. Chasing a luminance gap in dark mode is the
wrong tool.

Resolved the way dark interfaces actually do it, with a hairline border instead of a luminance step:

| Plane | Value | Note |
|---|---|---|
| Chrome (sidebar, header) | `#081320` | darkest, the frame |
| Surface (cards, tables) | `#0D1B2A` | the brief's value, unchanged |
| Page behind the cards | `#0A1622` | between the two |
| Border that separates them | `#44698A` | **3.01:1** on surface, clears 1.4.11 |

### R-2. The dark tint would have been nearly invisible

`#16324A` against surface `#0D1B2A` is **1.32:1**. On a 139-host table that is not a selected row,
it is a rounding error. Kept as specified for *hover*, where faint is correct, but a *selected* row
additionally carries a 3px `#3E93D6` left bar so the selection is identifiable without relying on the
fill. A link inside a tinted row uses `#5FA8DE` (**5.12:1**) rather than `#3E93D6` (**4.00:1**).

### R-3. Mid is a border and icon colour, never text

`#4A90C2` on white is **3.47:1**. That clears the 3:1 bar for a border or an icon and misses the
4.5:1 bar for text. The brief lists it under "secondary interactive", which could be read either way,
so it is constrained here to the non-text half: borders, icon strokes, chart gridlines. Secondary
*text* links use the primary.

### R-4. Severity becomes a filled chip, never coloured text

This is the mechanism that lets section 3's "only thing allowed to be loud" survive contact with
accessibility. Zabbix's six hues are unchanged; only their application changes.

| | As coloured text on white | As `#08182A` ink on a filled chip |
|---|---|---|
| 0 Not classified `#97AAB3` | 2.41 fail | **8.10 pass** |
| 1 Information `#7499FF` | 2.71 fail | **7.19 pass** |
| 2 Warning `#FFC859` | **1.54 fail** | **12.69 pass** |
| 3 Average `#FFA059` | 2.01 fail | **9.68 pass** |
| 4 High `#E97659` | 2.92 fail | **6.69 pass** |
| 5 Disaster `#E45959` | 3.58 fail | **5.00 pass** |

All six fail as text. All six pass as a chip.

The ink is `#08182A`, not the `#0A2540` chrome value this started as. Chrome measured **4.34:1** on
severity 5, and the first draft of this file excused it as large text. That was wrong: WCAG's
large-text threshold is 18.66px bold or 24px regular, and a severity chip is neither. Darkening the
ink by one step clears 4.5:1 on all six hues, with severity 5 the tightest at 5.00:1, so no chip
depends on a size exemption. `scripts/tokens.check.mjs` asserts 4.5 for all six.

### Three existing values that had to move

| Token | Was | Measured | Now | Now measures |
|---|---|---|---|---|
| Muted text | `#64748B` | 4.43:1 on page, **short of 4.5** | `#566577` | 5.55:1 |
| Focus ring | `#3B8FCB` | 3.27:1, passing by 0.27 | `#0067B1` | 5.47:1 |
| Border, interactive | `#E2E8F0` | 1.23:1, **fails 1.4.11** | see note | 3:1 or better |

`#E2E8F0` stays for decorative rules and table dividers, where no component identity depends on it.
Input, select and button boundaries move to a stronger step that clears 3:1.

### A correction that went the other way

Section 3's "38 endpoints" was challenged during verification as stale, on the grounds that
`openapi.yaml` holds 41 paths. The challenge was wrong and the brief was right.

`openapi.check.ts` reports **41 endpoints (38 GET + 3 POST)**, and `README.md` states the same split
twice: "17 route modules register onto it, 38 endpoints, plus health, login and `/api/auth/me`". The
three that make up the difference are health, login and `auth/me`, none of which returns a row of
anything. For a sentence about how much of this interface is tabular data competing with severity for
attention, 38 is the more accurate figure, so it stands.

Recorded because the useful lesson is the near miss: two numbers that disagree are not automatically
one number that is wrong, and the check that would have settled it in one step was reading the line
around the figure rather than the figure.

### One exception to "never a second hue"

Section 3 says the ramp is one hue and severity owns the loud colours. A line chart cannot obey that:
four shades of the same blue on one set of axes cannot be told apart, which defeats the point of
plotting them separately.

So `--series-1` to `--series-4` exist, and they are the only colours in the system outside the blue
ramp and Zabbix's six. All four sit outside severity's warm range, so a plotted line is never
mistaken for an alarm, and all four clear 3:1 against the surface in both themes because a plotted
line is a graphical object under WCAG 1.4.11.

| | Light | Dark |
|---|---|---|
| `--series-1` | `#0067B1` | `#58A6E0` |
| `--series-2` | `#0F766E` | `#4BB8A8` |
| `--series-3` | `#6D4AA8` | `#A98AE0` |
| `--series-4` | `#4A5D75` | `#93A8BF` |

The purple these replaced, `#7C4DFF`, was also used as a KPI card stripe on the Dashboard alongside
three other colours. A stripe that varies for variety is decoration, so those four came off. The
same stripe stays wherever it carries state: Capacity, Availability, Inventory and Alert noise all
set it from a threshold.

### The monospace face

Section 4 offered JetBrains Mono or IBM Plex Mono. **IBM Plex Mono** is used, for three reasons:
it ships a slashed zero, which matters on a page full of IPs and host IDs; its tabular figures align
in the SLA and packet-loss columns that exist to be compared down a row; and JetBrains Mono sits on
the short list of faces an AI reaches for by default, which is the one quality this portal's
typography should not have. It loads from the same Google Fonts request that already serves Inter,
so it adds no package to either lockfile.


---

## 8. The logo, and what measuring it changed

Added 23 September 2026, after the owner supplied `HCML.jpeg`.

### What the file turned out to be

| | |
|---|---|
| Actual format | **WebP**, despite the `.jpeg` extension. nginx serves by extension, so it would have gone out as `image/jpeg` carrying WebP bytes |
| Canvas | 1080 x 1080, fully transparent background |
| Ink | 758 x 433, so **71.9% of the canvas was empty** |
| Ink colour | **`#2B5584`** |
| Distinct colours | 970, in a two-colour logo: lossy WebP ringing around the letterforms |

Kept as `web/brand/HCML-original.webp`, which is outside `public/` and therefore not served.

### The palette moved to the logo

`#0067B1` was recorded as HCML's blue but nothing measured it against the actual artwork. The two are
**64.8 apart in RGB**, which is the worst possible distance: near enough to read as a mistake, far
enough that nobody could call them the same. The logo is the real brand artifact, so it won.

It is also simply better. `#2B5584` is **7.68:1** on white where `#0067B1` was 5.87:1.

Only the chromatic tokens moved. Chrome, the dark planes and the borders were already hue ~210,
which is the logo's own hue; `#0067B1` at hue 203 and full saturation was the one thing out of family.

| Token | Light was | Light now | Dark was | Dark now |
|---|---|---|---|---|
| `--primary` | `#0067B1` | **`#2B5584`** | `#3E93D6` | **`#6D9BCF`** |
| `--primary-strong` | `#004A80` | `#1E3B5C` | `#5FA8DE` | `#84ABD7` |
| `--mid` | `#4A90C2` | `#4681C3` | `#5FA8DE` | `#84ABD7` |
| `--tint` | `#EAF2F8` | `#E8EFF7` | `#16324A` | `#19324D` |
| `--tint-line` | `#CFE3F5` | `#C1D5EB` | `#2A4A66` | `#23456C` |
| `--focus` | `#0067B1` | `#2B5584` | `#5FA8DE` | `#84ABD7` |
| `--series-1` | `#0067B1` | `#2B5584` | `#58A6E0` | `#6D9BCF` |

The dark `--primary` step is set by one constraint: a link inside a selected row is `--primary` on
`--tint`, and that pair needs 4.5:1. `#6D9BCF` on `#19324D` is **4.51:1**, chosen from a grid so the
selected row keeps the most visible tint that still clears it.

### The plate is a measurement, not a preference

R-4 in section 7 guessed that the logo would need a white plate in the sidebar. The file settles it:

| `#2B5584` against | Ratio | |
|---|---|---|
| white | 7.68:1 | passes |
| `--bg` | 7.15:1 | passes |
| `--chrome` light `#0A2540` | **2.02:1** | fails |
| `--surface` dark | **2.27:1** | fails |
| `--chrome` dark | **2.43:1** | fails |

So the plate is the only thing that makes the logo readable in the chrome at all, in either theme.
`--logo-plate` is a fixed white rather than a surface token, because the artwork is drawn for white
and stays that way whatever the page does.

### Two crops, because a stacked lockup does not shrink

The three bands are 200px, 103px and 76px tall. Rendered, that gives:

| Slot | HCML at | "Madura Limited" at |
|---|---|---|
| Sidebar expanded, 216px plate | 47px | 18px |
| Login card, 208px plate | 45px | 17px |
| Rail, 44px plate | 11px | **4px** |
| Favicon, 16px | 8.4px | **3.2px** |

| Asset | Size | Used by |
|---|---|---|
| `logo.png` | 810 x 485 | Sidebar expanded, login card |
| `logo-mark.png` | 782 x 224 | The rail: the HCML band alone |
| `logo-icon.png` | 201 x 201 | Favicon and touch icon: the H glyph, flattened onto white |

All three are crops of the supplied file. Nothing is redrawn and nothing is recoloured. The favicon
is the real "H" from the wordmark rather than a monogram set in Inter, because at 16px no wordmark
is legible and a letter from the actual artwork is closer to the brand than type that is not.
It is flattened onto white on purpose: a transparent favicon disappears into dark browser chrome.

### Known, not fixed

`logo.png` is 127 KB, which is heavy for a two-colour logo. The cause is the lossy WebP source: 970
colours where there should be one. Flattening every pixel to `#2B5584` and letting the alpha channel
carry the anti-aliasing would remove the ringing and take it under 10 KB, but it rewrites pixels in a
trademark, so it is not done without a decision. A vector original would make the question moot.
