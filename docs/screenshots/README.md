# Screenshots

The main pages of the portal, as images. They were taken on 13 October 2026 from a running portal that
reads HCML's restored Zabbix data, with the code of commit `cef91b3`.
Each is one screen, 1440 px wide, in the light theme unless it says otherwise.

## What is real and what is replaced

The portal shows names from HCML's own network, and this repository is public. So every host name,
address and interface description is replaced on the page before the picture is taken, and the capture
stops, writing nothing, if a real one is still there.

| Replaced | By |
|---|---|
| Host names | the site number at the start is kept, then a kind and a number: `1.4 SW-04`, `INET : JAKARTA WAN-114` |
| IP addresses | an address in 198.18.0.0/15, a range reserved for testing, so it cannot be a real one |
| Interface descriptions, link and tunnel names, the values of free-text problem tags | `link-` and three digits |

Not replaced, because the pages need them or this repository already says them: counts, severities, times,
site names, host group names, interface names such as `Gi1/0/8`, and the text of triggers that name no
host. The figures are real, so the images show the size and shape of the estate, though not what its
devices are called.

The Zabbix server in the restored copy is off, so devices read "No data" and nothing is being polled. That
is how the portal looks on this data, and it is left as it is.

## The images

### Dashboard

![The Dashboard: counts for the estate, the live list of open problems and problems by host group](dashboard.png)

Counts for the estate, the live list of open problems (worst first, kept current by a stream) and the
problems of each host group.

### Problems

![Problems: one row per open problem, with host, severity, duration, tags and an Explain button](problems.png)

One row per open problem, with its host, severity, duration and tags. Acknowledge is off here, which the
page says, so the one button on a row is Explain: it asks the model to put the problem in plain words.
The Actions column stays at the right edge while the table scrolls.

### Sites

![Sites: one card per site, with its problems by severity and how many devices are down](sites.png)

One card per site, with its problems by severity and how many devices are down. A site is read from the
number at the start of a host name; hosts that name none are grouped by host group, which the note at
the top says is a guess.

### Graphs

![Graphs: one item over a calendar month, with its minimum, average, maximum and last values and a Show data button](graphs.png)

One item over a calendar month, read from hourly trends. Under the chart are its minimum, average,
maximum and last values, and Show data opens every plotted point as a table, which the tooltip otherwise
gives one point at a time.

### Network

![Network: devices grouped by site, all reading No data](network.png)

Devices grouped by site. They read "No data" because the Zabbix server of this restored copy is off. A
card opens that device's interfaces.

### Dark theme

![The Dashboard in the dark theme](dashboard-dark.png)

The theme follows the system setting, or the picker in the top bar.

### Narrow screen

<img src="dashboard-narrow.png" width="300" alt="The Dashboard on a screen 390 px wide: the menu is a rail of icons and the tables scroll inside their cards">

On a screen 390 px wide the menu becomes a rail of icons, the cards stack, and a wide table scrolls
inside its card instead of widening the page.

## Adding or replacing one

A screenshot goes into this folder only if its names were replaced, and every image here was looked at
after it was taken, because the automatic check reads text and cannot read a chart. The pages left out
are the ones that print figures a reader could take for HCML's own: the SLA report shows each site's
availability for the month. [`../contributing.md`](../contributing.md) says never to commit estate data;
this folder is the one exception, for that reason.

The images were made with a private capture script that drives Chrome, rewrites the names in the page and
refuses to write an image while a real one is left. It is kept beside the repository, not in it, because
it reads the real host list. The unreplaced screenshots kept for the monthly documents are in `pic/`, which git
ignores.
