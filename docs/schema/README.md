# Schema: HCML Monitoring Portal

Three models of the same system at three levels of abstraction, each on one page, each meant to be read.
**Use the PDFs**; the `.mmd` files beside them are the source.

| File | Level | Answers | Size |
|---|---|---|---|
| [`CDM.pdf`](CDM.pdf) | **Conceptual** (Merise MCD) | What does the business talk about? | 14 entities, 16 associations |
| [`ERD.pdf`](ERD.pdf) | **Logical** | What does the portal actually work with? | 19 entities, attributes and identifiers |
| [`PDM.pdf`](PDM.pdf) | **Physical** (MySQL 8.0) | What does the database actually store? | 26 tables, real types and keys |

Read them in that order. Each one is the previous one made more concrete: a **Device** in the CDM becomes
`HOST` + `HOST_INTERFACE` + `HOST_INVENTORY` + `HOST_TAG` in the ERD, and those become the six tables in the
PDM's *Hosts & inventory* frame.

---

## What this copy's perspective is

This is **`hcml-portal`**: the plain-language layer is written by **hosted Claude** through the Anthropic API.
So the estate data a problem carries (its host name, trigger name and tags) **leaves this machine** when
someone clicks *Explain*. That is why `AI EXPLANATION` is drawn in **red** in the CDM and the ERD.

The sibling repo `hcml-portal-ollama` has the same three models drawn from its own perspective: there the
model is `qwen3:8b` running on the host, the same entity is **green**, and nothing crosses the network. The
two sets are not copies of each other. Compare `schema/CDM.pdf` in both to see the difference stated in one
box.

The **PDM is the same in both**, and honestly so: both portals read one Zabbix database. Only the note about
where the rows go afterwards differs.

---

## How to read each one

**CDM: Merise notation.** A rectangle is an entity and the properties a manager would name. A diamond is a
**named association**, read in the verb's direction: *SITE, stations, DEVICE*. The `(min,max)` beside each
leg says how many times one occurrence of that entity takes part, so `(1,1)` beside Device on *stations*
means **every device is at exactly one site**. There are no keys, no foreign keys and no data types: by
definition; a conceptual model has none.

**ERD: crow's foot.** `||` exactly one · `o|` zero or one · `o{` zero or many · `|{` one or many. Attributes
carry a type and `PK` where they identify the entity. A blue entity's header names the MySQL table it comes
from, after the `·`. Green entities have **no table anywhere**: they are built per request and never stored.

**PDM: crow's foot, real schema.** A **solid** line is a genuine `FOREIGN KEY`, labelled with its column and
with *cascade* where deleting the parent deletes the children. A **dashed** line is a relationship that
exists only in the data, which MySQL does not check: `history` and `trends` have no foreign key **on
purpose**, because the cost of one per inserted row is too high. Purple is the single table the portal
writes to.

### Colours, in all three

| | |
|---|---|
| 🟦 Blue | Zabbix stores it; the portal reads it over JSON-RPC |
| 🟩 Green | The portal derives it. No table exists: built per request, cached briefly, gone on restart |
| 🟧 Amber | Local to the portal (the sign-in user, from an environment variable) |
| 🟥 Red | It leaves this machine |
| ⬜ Grey | An association diamond (CDM), or a table Zabbix reads internally and never returns (PDM) |

---

## One thing worth noticing across the three

The portal **owns no database**. There is no `pg`, `prisma` or SQL anywhere in the codebase, and
`docker-compose.yml` defines exactly two services, neither of them a datastore. So every green entity in the
CDM and the ERD, `SITE`, `LINK`, `INCIDENT`, `HOST_AVAILABILITY`, simply has nothing under it in the PDM.
That gap between the ERD and the PDM *is* the project: those are the things Zabbix cannot tell you, computed
per request so a NOC can read them.

---

## Regenerating

From inside this folder, after editing a `.mmd`:

```bash
npx @mermaid-js/mermaid-cli -i CDM.mmd -o CDM.pdf -w 2600 -b white --pdfFit
npx @mermaid-js/mermaid-cli -i ERD.mmd -o ERD.pdf -w 2600 -b white --pdfFit
npx @mermaid-js/mermaid-cli -i PDM.mmd -o PDM.pdf -w 2600 -b white --pdfFit
```

`--pdfFit` sizes the page to the chart; without it the diagram is squeezed onto A4 and unreadable. For a
raster copy to paste into slides, swap the output for `.png` and add `-s 2`.

Two rules the sources must keep, both learned the hard way:

- Every `subgraph` needs a `style <NAME> fill:none,stroke:#94a3b8` line. Mermaid paints cluster rectangles
  *after* the relationship lines, so a filled frame hides every edge beneath it: that once made 33 of 46
  edges invisible while the source still held all of them.
- In an `erDiagram`, a bare `%%` line with no text is a parse error. In a `flowchart` it is worse: it
  silently becomes a **node labelled `%%`**. Leave comment paragraphs separated by a genuinely empty line.

---

## If you need more than one page

This folder is the readable set. The exhaustive reference is [`../erd/`](../erd/) and
[`../../erd.md`](../../erd.md): the full logical model (43 entities across nine domains), all 45 MySQL tables the
portal touches, the entity-to-table map, and a conceptual model at full scope. Those are reference sheets:
they do not fit on a page, and are not meant to.
