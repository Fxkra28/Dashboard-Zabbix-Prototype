# Changelog

What changed in the portal, newest first. `hcml-portal` and `hcml-portal-ollama` hold the same code
and share this file; the files that differ by design are listed in
[`web/scripts/parity.check.mjs`](web/scripts/parity.check.mjs). Item ids such as UX-14 are the rows of
[`tracker.md`](tracker.md).

A build is named by the commit it was made from. The sidebar footer shows it once someone is signed in,
and so does a signed-in `/api/health`. A `-dirty` suffix means the build was made from a working tree
with changes that were not committed. Nothing is tagged: the commit is the version.

## Not yet committed (13 October 2026)

- Screenshots. `docs/screenshots/` holds seven images of the main pages, and the README and the
  getting-started guide show some of them. Every host name, address and interface description in them
  is a stand-in, and each image was looked at before it was added.

## 13 October 2026 (cef91b3)

The running portals were built from this work a few hours before it was committed, so they report
`748136c-dirty` until they are rebuilt.

- Narrow screens (UX-14). The Dashboard and the Inventory report no longer run past the window at 390
  and 320 px: the two-column grid lets its columns shrink, the host-group table scrolls inside its card,
  and the Inventory controls wrap. The Actions column of the Problems, Hosts and Sites, Latest data,
  Capacity and SLA tables stays in view while the rest of the table scrolls, so Explain, Ack and the
  graph links are no longer past the card's edge.
- Charts (UX-17). A "Show data" button under each chart opens the plotted values as one table per
  series, for a keyboard or a screen reader.
- Network (UX-18). A port is opened with a button named by the interface, not with a focusable row. A
  selected device card keeps its selection and its keyboard focus ring apart. Four facts that lived only
  in tooltips are also text for a screen reader: why a refresh failed, that a figure rests on partial
  data, the devices-with-data count on the SLA page, and what "degraded" means on a site.
- Explain and the Assistant (IN-21). A note says when the AI model is not answering, from the `model`
  field of the readiness check. The buttons stay, because that check is cached.
- Type scale (UX-21). The two inline `12.5px` sizes are `12px`, and `tokens.check.mjs` lists no
  exceptions.
- Diagrams (IN-18). Each `.mmd` ends with a `%% source-hash:` stamp, and the new
  `web/scripts/diagrams.check.mjs` fails, in CI too, when a source was edited after its stamp.
  `web/scripts/diagrams.stamp.mjs` sets the stamp after a re-render.
- Tests: 1,508 in 66 files on the server and 822 in 57 on the web.
- Documents: the wording and code-comment passes of 12 and 13 October, `ayoyo_1.1.md` renamed
  `tracker.md`, and this file.

## 12 October 2026 (748136c)

Hardens sign-in and the containers, adds the SLA report export, and refreshes the docs. Since 24 September:

- 2 October. The monthly SLA report downloads as a PDF and as an Excel file.
- 7 October. Sign-in uses a session cookie with a CSRF header and scrypt password hashes. The containers
  run with a read-only root, no capabilities and no new privileges. Every reply carries a request id,
  `/api/ready` answers 503 while Zabbix cannot be read, the live stream carries only what the Dashboard
  reads, and a viewer no longer sees network interface data. Below 720 px the sidebar is a rail.
- 12 October. Every CI action is pinned by commit SHA, Dependabot and a secret scan were added, and the
  base images are pinned by digest. `BUILD_COMMIT` and `BUILD_TIME` reach the sidebar footer. Five unused
  endpoints were removed, every data answer is checked at run time, the fonts are served from this site,
  and outages that ended inside a report window are counted.

## 24 September 2026 (a7fdbd1)

The README explains every term and has a glossary.

## 23 September 2026 (8aa65d5, 2b14b90)

The SLA engine, a provider-neutral AI layer (the hosted API or a local Ollama model), a test suite, and
the documentation layer.

## 7 September 2026 (b4a4059, cb97069)

First commit, then the service-centric views, reporting, role-based access and the AI explain layer.
