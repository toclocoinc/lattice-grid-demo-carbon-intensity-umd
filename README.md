# Carbon intensity across Great Britain, live

A live dashboard of the National Energy System Operator's carbon intensity and
generation-mix feeds, with a gauge for the current reading, today's intensity
split into actual and forecast, a stacked chart of the generation mix, and a
regional table, built on Lattice Grid loaded by `<script>` tag: no npm install,
no bundler, no build step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-carbon-intensity-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

It is three feeds fanned through one data router: the half-hourly intensity feed,
the current generation mix, and the regional intensity. The router partitions
them by `kind`, so the three tables never mix. The intensity table and the
generation-mix table are small and sit side by side rather than in tabs; the
regional table and a fuel-family summary sit below in the same side-by-side
pattern.

The point of the demo is a keyless, open data feed that moves every half hour.
The API needs no key and answers with open cross-origin headers, so the browser
reads it directly; the page polls every half hour and each new reading firms the
forecast up into an actual.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.66.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createHeadlessGrid`, `setLicence`, `createStat` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | (loaded, but the tables sit side by side rather than in tabs) |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything.

Every address names the exact release, `1.66.0`, and every tag carries the
`integrity` hash of the file it expects. The hashes are the SHA-384 of the
published files.

The demo's own code is four classic scripts, loaded in order: `src/licence.js`,
`src/carbon-feed.js`, `src/dashboard.js`, `main.js`. Each file wraps itself in a
function and puts what it offers on one plain object, `CarbonIntensity`, for the
next file to read. `src/dashboard.js` is handed the grid's factories as
arguments and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the page
fetches its data with `fetch()` and browsers will not do that from `file://`:

```
node tools/serve.mjs
```

| Address | What you get |
| --- | --- |
| `/` | live, reading the Carbon Intensity API and polling every half hour |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no API needed |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**A gauge for the reading now.** The current carbon intensity is drawn as a dial
against a 0–400 gCO₂/kWh range, with a target at 100, and the reading written
beneath it alongside its band.

**Today, actual against forecast.** The half-hourly intensity table shows every
half hour of the day, with the measured value, the forecast, and a band pill.
The line chart above it draws the same data as two series — actuals for the
hours past, the forecast for the hours to come — so the moment the forecast
turns into a reading is visible. The band is also drawn as a pill, coloured
from green (very low) through to red (very high).

**The generation mix, now and over time.** The mix table shows one row per fuel
with its share of this half hour as a data bar, and the fuel's family on a
second line. The stacked area chart shows the same mix over the last two days.
A small summary beside the mix table derives the mix by fuel family.

**Figures that follow the table.** The strip of tiles reads the grids: the
carbon intensity now, with its change against yesterday's average; the share of
generation that is low-carbon, with its change against yesterday; and a small
panel of generation-mix figures. Filter the mix table to renewable sources and
every figure and the derived summary follow.

**A regional table of dials.** Each of the 18 regions is a row, with the region
over its distribution-network operator on a second line, its intensity as a
small dial, and its band as a pill. Group it by band to see where the high
intensity is.

**A feed that can fail.** If the API cannot be reached when the page first
opens, it shows the saved copy instead and says so under the title.

## The data

Everything comes from the Carbon Intensity API, run by the National Energy
System Operator:

- <https://api.carbonintensity.org.uk/>

The page reads the current intensity, a whole day of half-hourly intensity
(including the forecast for the hours still to come), yesterday's intensity for
the baseline, the current generation mix, two days of generation-mix history,
and the regional intensity:

- `GET /intensity` — the current GB intensity and its band
- `GET /intensity/date/{date}` — half-hourly intensity for a day, forecast and actual
- `GET /generation` — the current generation mix, one share per fuel
- `GET /generation/{from}/{to}` — half-hourly generation mix over a window
- `GET /regional` — half-hourly intensity for each of the 18 regions

The API is public, needs no key, and answers with
`Access-Control-Allow-Origin: *`, so the browser reads it directly. The data
are published under CC BY 4.0 and are free to use.

A few things worth knowing about the data:

- Intensity is **grams of CO₂ per kilowatt-hour** (gCO₂/kWh). The band labels
  (very low to very high) come from the API's own classification of each
  reading, which is what the pills show.
- The API's days follow **London time**, so the date sent to the half-hourly
  endpoints is computed in `Europe/London`, not in the viewer's zone.
- The generation mix reports **percentage shares** that sum to about 100.
  Interconnector imports are their own fuel; whether an import is low-carbon
  depends on the country it comes from, which the API does not say, so imports
  are left out of the low-carbon share.
- The **low-carbon share** counts wind, solar, hydro, nuclear and biomass
  together. Biomass is a judgement call the API does not make; it is counted
  low-carbon here and stated so in the footer.
- A half hour with no `actual` reading is the future: only the forecast exists
  for it, which is what distinguishes the forecast series from the actuals on
  the chart.
- The regional endpoint reports only a `forecast` value per region, so the
  regional dials are forecasts.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/carbon-feed.js        the API: intensity, mix, regional, polling, snapshot
src/dashboard.js          the views: router, tables, tiles, charts, derived grid
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the API
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It reads the current intensity, today's and yesterday's half-hourly intensity,
the current mix, two days of generation-mix history and the regional intensity,
then writes compact arrays to `data/snapshot/`. Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs        # open the page in a real browser and assert
node tools/verify.mjs --all  # also open the live API
```

`tools/verify.mjs` first insists on how the library arrived: no `type="module"`
script anywhere on the page, five script tags pointing at the pinned release on
the CDN, each with an integrity hash, and each leaving the global it documents.
It then checks the two main tables sit side by side rather than in tabs,
recomputes the headline figures from the saved data and compares them with what
the page is showing, confirms the three charts drew marks and the forecast
chart splits into actual and forecast series, derives the fuel-family summary
and checks it sums to about 100%, pushes a record through the router to prove
it lands in the right table, groups the regional table by band, filters to
actual readings and sees the forecast series leave the chart, and finally
blocks the API in the browser and insists the saved copy appears with a notice
saying why. The GitHub Pages workflow runs it before every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The carbon intensity and generation-mix data is from the National Energy System
Operator, published under CC BY 4.0.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

---
Built with [Lattice Grid](https://www.latticegrid.dev), a JavaScript data grid with a Data Router: one live feed keeps grids, charts, boards, Gantt and KPI tiles in step. [Documentation](https://www.latticegrid.dev/docs/) · [Demos](https://www.latticegrid.dev/demos/) · [Licence](https://www.latticegrid.dev/licence/)
