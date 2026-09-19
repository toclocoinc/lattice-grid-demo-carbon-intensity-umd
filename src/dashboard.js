/**
 * The dashboard: three feeds from the National Energy System Operator, fanned
 * through one data router into an intensity table, a generation-mix table and
 * a regional table, with a gauge, a forecast-vs-actual line chart and a
 * stacked generation-mix chart drawn from a handful of small headless grids.
 *
 * Nothing here fetches anything and nothing here reaches for the grid's
 * globals: every factory is handed in, so this file is the same whether the
 * library arrived by script tag, as it does here, or by import.
 *
 * How the pieces fit together:
 *
 *   the API  ->  the router  ->  the intensity grid  ->  the forecast chart
 *                             ->  the mix grid       ->  the tiles, the derived grid
 *                             ->  the regional grid
 *
 * The half-hourly intensity table and the generation-mix table are small and
 * sit side by side; the regional table and the fuel-family summary sit below
 * in the same side-by-side pattern. Charts and headline tiles go above them.
 *
 * A classic script: it reads the constants from `CarbonIntensity`, put there
 * by `carbon-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { LOW_CARBON_FUELS, FUEL_FAMILY } = root.CarbonIntensity;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One number, written the way a reader expects to see it. */
  function commas(value) {
    return Number(value || 0).toLocaleString('en-GB');
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** The share of a mix grid's rows that is low-carbon, as a percentage. */
  function lowCarbonShareFromGrid(grid) {
    let total = 0;
    let low = 0;
    grid.rows.forEach((row) => {
      const data = row && row.data;
      const perc = data && typeof data.perc === 'number' ? data.perc : 0;
      total += perc;
      if (data && data.lowCarbon) low += perc;
    });
    return total ? (low / total) * 100 : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /** The intensity band as a semantic colour: very low is good, very high bad. */
  function bandVariant() {
    return {
      when: [
        { op: 'eq', value: 'very low', use: 'success' },
        { op: 'eq', value: 'low', use: 'info' },
        { op: 'eq', value: 'moderate', use: 'neutral' },
        { op: 'eq', value: 'high', use: 'warning' },
        { op: 'eq', value: 'very high', use: 'danger' },
      ],
      default: 'neutral',
    };
  }

  function intensityColumns(dayMax) {
    const barMax = Math.max(dayMax, 1);
    return [
      { id: 'time', field: 'time', title: 'Half hour', type: 'datetime', filter: { type: 'date' }, sort: { direction: 'asc' }, layout: { width: 150 } },
      {
        id: 'value', field: 'value', title: 'Intensity (gCO\u2082/kWh)', type: 'number', format: { decimals: 0 },
        filter: { type: 'number' }, cell: { decoration: 'bar', min: 0, max: barMax }, layout: { width: 150 },
      },
      { id: 'actual', field: 'actual', title: 'Actual', type: 'number', format: { decimals: 0 }, filter: { type: 'none' }, layout: { width: 90 } },
      { id: 'forecast', field: 'forecast', title: 'Forecast', type: 'number', format: { decimals: 0 }, filter: { type: 'none' }, layout: { width: 90 } },
      { id: 'band', field: 'band', title: 'Band', filter: { type: 'set' }, cell: { decoration: 'pill', variant: bandVariant() }, layout: { width: 120 } },
      { id: 'phase', field: 'phase', title: 'Phase', filter: { type: 'set' }, layout: { width: 90, hidden: true } },
    ];
  }

  function mixColumns() {
    return [
      { id: 'fuel', field: 'fuel', title: 'Source', filter: { type: 'set' }, cell: { render: 'twoline', props: { secondary: 'family' } }, layout: { width: 180 } },
      { id: 'perc', field: 'perc', title: 'Share', type: 'number', format: { decimals: 1, suffix: '%' }, filter: { type: 'number' }, cell: { decoration: 'bar', min: 0, max: 100 }, layout: { width: 150 } },
      { id: 'family', field: 'family', title: 'Family', filter: { type: 'set' }, layout: { width: 110, hidden: true } },
      { id: 'lowCarbon', field: 'lowCarbon', title: 'Low carbon', type: 'boolean', filter: { type: 'set' }, layout: { width: 100, hidden: true } },
    ];
  }

  function regionalColumns(regionalMax) {
    return [
      { id: 'region', field: 'region', title: 'Region', filter: { type: 'text' }, cell: { render: 'twoline', props: { secondary: 'dno' } }, layout: { width: 250 } },
      { id: 'value', field: 'value', title: 'Intensity (gCO\u2082/kWh)', type: 'number', format: { decimals: 0 }, filter: { type: 'number' }, cell: { render: 'gauge', props: { min: 0, max: regionalMax } }, layout: { width: 170 } },
      { id: 'band', field: 'band', title: 'Band', filter: { type: 'set' }, cell: { decoration: 'pill', variant: bandVariant() }, layout: { width: 120 } },
    ];
  }

  function baseGridConfig(density) {
    return {
      rowKey: 'id',
      theme: 'light',
      density: density || 'compact',
      stripedRows: true,
      columnMenu: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      selection: 'multiple',
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  function buildDashboard({
    root: host,
    createGrid,
    createHeadlessGrid,
    createChart,
    createKPI,
    createStat,
    createDataRouter,
    now,
    intensity,
    mix,
    regional,
    history,
    dayMax,
    regionalMax,
    yesterdayAverage,
    yesterdayLowCarbon,
    meta,
  }) {
    host.textContent = '';

    const built = {
      intensityGrid: null,
      mixGrid: null,
      regionalGrid: null,
      derivedGrid: null,
      router: null,
      kpi: null,
      tiles: {},
      charts: [],
      nowGrid: null,
      mixHistoryGrid: null,
      store: new Map(),
      status: { lastPoll: null, lastError: null, polls: 0, arrivals: 0, revisions: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'Carbon intensity across Great Britain, live'));
    heading.append(
      el(
        'p',
        'lede',
        'Live carbon intensity and generation mix from the National Energy System Operator, updated every half hour. ' +
          'A gauge shows the current reading, a line chart separates today\u2019s actuals from the forecast, and a stacked chart ' +
          'shows how the mix of fuels has shifted over the last two days.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The Carbon Intensity API could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the headline figures ---------------- */

    const headline = el('section', 'headline');
    headline.setAttribute('aria-label', 'Headline figures');

    const nowTile = el('div', 'stat-tile');
    const lowTile = el('div', 'stat-tile');
    const kpiHost = el('div', 'kpi-panel');
    headline.append(nowTile, lowTile, kpiHost);
    host.append(headline);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');

    const gaugeBox = el('div', 'chart-box');
    gaugeBox.append(el('h2', 'chart-title', 'Carbon intensity now'));
    const gaugeBody = el('div', 'chart-body');
    const gaugeNote = el('div', 'chart-note', '');
    gaugeBox.append(gaugeBody, gaugeNote);

    const lineBox = el('div', 'chart-box');
    lineBox.append(el('h2', 'chart-title', 'Today\u2019s intensity, actual and forecast'));
    const lineBody = el('div', 'chart-body');
    lineBox.append(lineBody);

    const mixBox = el('div', 'chart-box');
    mixBox.append(el('h2', 'chart-title', 'Generation mix, last two days'));
    const mixBody = el('div', 'chart-body');
    mixBox.append(mixBody);

    chartHost.append(gaugeBox, lineBox, mixBox);
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables, side by side ---------------- */

    const side = el('section', 'side');
    side.setAttribute('aria-label', 'Intensity and generation mix');

    const intensityPane = el('div', 'grid-pane');
    const intensityHead = el('div', 'pane-head');
    intensityHead.append(el('h2', null, 'Today\u2019s half-hourly intensity'));
    intensityHead.append(el('p', 'pane-sub', 'Actual readings for the hours past, the forecast for the hours to come.'));
    intensityPane.append(intensityHead);

    const mixPane = el('div', 'grid-pane');
    const mixHead = el('div', 'pane-head');
    mixHead.append(el('h2', null, 'The generation mix now'));
    mixHead.append(el('p', 'pane-sub', 'Where the electricity is coming from this half hour.'));
    mixPane.append(mixHead);

    side.append(intensityPane, mixPane);
    host.append(side);

    /* ---------------- the lower tables ---------------- */

    const lower = el('section', 'side lower');
    lower.setAttribute('aria-label', 'Regional intensity and fuel families');

    const regionalPane = el('div', 'grid-pane');
    const regionalHead = el('div', 'pane-head');
    regionalHead.append(el('h2', null, 'Regional intensity'));
    regionalHead.append(el('p', 'pane-sub', 'One reading per region, each drawn as a small dial.'));
    regionalPane.append(regionalHead);

    const derivedPane = el('div', 'grid-pane');
    const derivedHead = el('div', 'pane-head');
    derivedHead.append(el('h2', null, 'The mix by fuel family'));
    derivedHead.append(el('p', 'pane-sub', 'The generation mix summarised, derived from the table beside it.'));
    derivedPane.append(derivedHead);

    lower.append(regionalPane, derivedPane);
    host.append(lower);

    /* ---------------- the grids ---------------- */

    const intensityGrid = createGrid(intensityPane, {
      ...baseGridConfig('compact'),
      columns: intensityColumns(dayMax),
    });
    built.intensityGrid = intensityGrid;

    const mixGrid = createGrid(mixPane, {
      ...baseGridConfig('comfortable'),
      columns: mixColumns(),
    });
    built.mixGrid = mixGrid;

    const regionalGrid = createGrid(regionalPane, {
      ...baseGridConfig('comfortable'),
      columns: regionalColumns(regionalMax),
    });
    built.regionalGrid = regionalGrid;

    const derivedGrid = createGrid(derivedPane, {
      ...baseGridConfig('compact'),
      columns: [
        { id: 'family', field: 'family', title: 'Family', layout: { width: 140 } },
        { id: 'share', field: 'share', title: 'Share of generation', type: 'number', format: { decimals: 1, suffix: '%' }, layout: { width: 150 } },
        { id: 'sources', field: 'sources', title: 'Sources', type: 'number', layout: { width: 100 } },
      ],
      source: {
        mode: 'derived',
        from: mixGrid,
        groupBy: 'family',
        select: {
          share: { of: 'perc', fn: 'sum' },
          sources: { fn: 'count' },
        },
        sort: [{ col: 'share', dir: 'desc' }],
      },
    });
    built.derivedGrid = derivedGrid;

    /* ---------------- the router ---------------- */

    /*
     * One stream in, three tables out, split on `kind`. An intensity row, a
     * mix row and a regional row never share an identity, so the three tables
     * never claim the same record. `overlap: true` lets one row reach both its
     * table and the counting subscriber below.
     */
    const router = createDataRouter({
      key: (row) => row.kind,
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(intensityGrid, 'intensity');
    router.attach(mixGrid, 'mix');
    router.attach(regionalGrid, 'regional');
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(`${row.kind}:${row.id}`, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      return incoming.length;
    };
    built.ingest = ingest;

    for (const row of [...intensity, ...mix, ...regional]) built.store.set(`${row.kind}:${row.id}`, row);
    router.load([...built.store.values()]);

    /* ---------------- the headline figures ---------------- */

    const nowGrid = createHeadlessGrid({
      rowKey: 'id',
      columns: [
        { id: 'value', field: 'value', type: 'number', title: 'gCO\u2082/kWh' },
      ],
    });
    built.nowGrid = nowGrid;
    nowGrid.rows.load([{ id: 'gb', value: now.value != null ? now.value : null }]);

    built.tiles.now = createStat({
      grid: nowGrid,
      container: nowTile,
      title: 'Carbon intensity now',
      value: { of: 'value', fn: 'max' },
      baseline: yesterdayAverage,
      goodWhen: 'down',
      bands: { good: 100, warn: 300, direction: 'down' },
      format: (v) => (v == null ? '\u2014' : `${Math.round(v)} gCO\u2082/kWh`),
      footer: 'vs yesterday\u2019s average',
    });

    built.tiles.lowCarbon = createStat({
      grid: mixGrid,
      container: lowTile,
      title: 'Low-carbon share',
      value: (grid) => lowCarbonShareFromGrid(grid),
      baseline: yesterdayLowCarbon,
      goodWhen: 'up',
      bands: { good: 60, warn: 40, direction: 'up' },
      format: (v) => `${v.toFixed(1)}%`,
      footer: 'wind, solar, hydro, nuclear, biomass',
    });

    const kpi = createKPI(kpiHost, {
      grid: mixGrid,
      rowKey: 'id',
      fields: ['fuel', 'perc', 'family', 'lowCarbon'],
      columns: 3,
      ariaLabel: 'Generation mix figures',
      tiles: [
        { id: 'fuels', label: 'Fuels in the mix', aggregation: 'count', format: 'number' },
        {
          id: 'renewable', label: 'Renewable share', aggregation: 'custom', format: 'percent',
          compute: (rows) => {
            let total = 0;
            let renewable = 0;
            for (const row of rows) {
              const perc = row.perc || 0;
              total += perc;
              if (row.fuel === 'wind' || row.fuel === 'solar' || row.fuel === 'hydro') renewable += perc;
            }
            return total ? renewable / total : 0;
          },
        },
        {
          id: 'largest', label: 'Largest source', aggregation: 'custom', format: 'percent',
          compute: (rows) => {
            let total = 0;
            let best = 0;
            for (const row of rows) {
              const perc = row.perc || 0;
              total += perc;
              if (perc > best) best = perc;
            }
            return total ? best / total : 0;
          },
        },
      ],
    });
    built.kpi = kpi;

    /* ---------------- the charts ---------------- */

    const charts = [];

    const gauge = createChart({
      grid: nowGrid,
      container: gaugeBody,
      type: 'gauge',
      y: 'value',
      min: 0,
      max: 400,
      target: 100,
    });
    charts.push(gauge);

    const lineChart = createChart({
      grid: intensityGrid,
      container: lineBody,
      type: 'line',
      x: 'time',
      y: 'value',
      series: 'phase',
      axis: { y: 'gCO\u2082/kWh', x: { labels: true } },
      legend: true,
    });
    charts.push(lineChart);

    const mixHistoryGrid = createHeadlessGrid({
      rowKey: 'id',
      columns: [
        { id: 'time', field: 'time', type: 'datetime' },
        { id: 'fuel', field: 'fuel' },
        { id: 'perc', field: 'perc', type: 'number' },
      ],
    });
    built.mixHistoryGrid = mixHistoryGrid;
    mixHistoryGrid.rows.load(history);

    const stacked = createChart({
      grid: mixHistoryGrid,
      container: mixBody,
      type: 'area',
      x: 'time',
      y: 'perc',
      series: 'fuel',
      stack: true,
      axis: { y: '% of generation', x: { labels: true } },
      legend: true,
    });
    charts.push(stacked);

    built.charts = charts;

    const setGaugeNote = () => {
      const band = now.index || now.band || '';
      const reading = now.value != null ? `${Math.round(now.value)} gCO\u2082/kWh` : 'no reading';
      gaugeNote.textContent = band ? `${reading} \u2014 ${band}` : reading;
    };
    setGaugeNote();

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    const groupRegional = (bands) => () => built.regionalGrid && built.regionalGrid.columns.group(bands ? ['band'] : []);

    actions.append(el('span', 'actions-label', 'Intensity table'));
    const actualButton = button('Only actual readings', () => {
      const on = actualButton.getAttribute('aria-pressed') === 'true';
      built.intensityGrid.filters.where('onlyActual', on ? null : (row) => row.isForecast !== true);
      actualButton.setAttribute('aria-pressed', String(!on));
      actualButton.classList.toggle('on', !on);
    }, 'action toggle');
    actualButton.setAttribute('aria-pressed', 'false');
    actions.append(actualButton);

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Generation mix'));
    const renewableButton = button('Only renewable', () => {
      const on = renewableButton.getAttribute('aria-pressed') === 'true';
      built.mixGrid.filters.where('renewable', on ? null : (row) => {
        return row.fuel === 'wind' || row.fuel === 'solar' || row.fuel === 'hydro';
      });
      renewableButton.setAttribute('aria-pressed', String(!on));
      renewableButton.classList.toggle('on', !on);
    }, 'action toggle');
    renewableButton.setAttribute('aria-pressed', 'false');
    actions.append(renewableButton);

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Regional table'));
    actions.append(button('Group by band', groupRegional(true)));
    actions.append(button('No grouping', groupRegional(false)));

    built.actualButton = actualButton;
    built.renewableButton = renewableButton;

    /* ---------------- the live readout ---------------- */

    const setFreshness = () => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the carbon intensity data, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the API. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the API.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent = `Updated ${clockText(built.status.lastPoll)}.`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;
    setFreshness();

    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);

      nowGrid.rows.load([{ id: 'gb', value: result.now.value != null ? result.now.value : null }]);
      now.value = result.now.value;
      now.index = result.now.index;
      now.band = result.now.index;
      setGaugeNote();

      built.intensityGrid.columns.decorate('value', { type: 'bar', min: 0, max: Math.max(result.dayMax, 1) });
      mixHistoryGrid.rows.load(result.history);

      ingest([...result.intensity, ...result.mix, ...result.regional]);
      setFreshness();
    };

    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[carbon demo] a poll failed:', built.status.lastError);
    };

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const credit = el('p', null, 'Carbon intensity and generation mix data from the ');
    const link = el('a', null, 'National Energy System Operator Carbon Intensity API');
    link.href = 'https://api.carbonintensity.org.uk/';
    link.rel = 'noopener';
    credit.append(link);
    credit.append(
      document.createTextNode(
        '. Published under CC BY 4.0 and free to use. Intensity is grams of carbon dioxide per kilowatt-hour (gCO\u2082/kWh); ' +
          'the band labels (very low to very high) come from the API\u2019s own classification. The mix shows where each half hour\u2019s ' +
          'electricity comes from, and the low-carbon share counts wind, solar, hydro, nuclear and biomass together.',
      ),
    );
    footer.append(credit);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      for (const stat of Object.values(built.tiles)) stat.destroy();
      kpi.destroy();
      router.destroy();
    };

    return built;
  }

  root.CarbonIntensity.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
