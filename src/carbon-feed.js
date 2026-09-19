/**
 * The National Energy System Operator's Carbon Intensity feeds: the current
 * Great Britain intensity, a whole day of half-hourly intensity readings (with
 * the forecast for the hours still to come), the current generation mix, two
 * days of half-hourly generation mix, and the regional intensity.
 *
 * Nothing here knows about the grid. It produces plain rows and hands them to
 * whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The API is public, needs no key, and answers with open cross-origin headers,
 * so the browser reads it directly. Intensity is published every half hour and
 * forecast up to two days ahead; the page polls every half hour for the latest
 * reading.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `CarbonIntensity`, a
 * plain object on the global, and the next script reads it from there. The
 * snapshot tool runs this same file under Node, which is why it looks for
 * `globalThis` rather than `window`.
 */
(function (root) {
  'use strict';

  const BASE = 'https://api.carbonintensity.org.uk';

  /** How often the page asks for fresh readings. The API updates every 30 min. */
  const POLL_MS = 30 * 60 * 1000;

  /**
   * The fuel families the generation mix is grouped into, and which fuels
   * count as low-carbon. Biomass is counted low-carbon alongside nuclear; it is
   * a judgement call the API does not make, so it is stated here rather than
   * hidden.
   */
  const FUEL_FAMILY = {
    biomass: 'Low carbon',
    coal: 'Fossil',
    imports: 'Imports',
    gas: 'Fossil',
    nuclear: 'Low carbon',
    other: 'Fossil',
    hydro: 'Renewable',
    solar: 'Renewable',
    wind: 'Renewable',
  };
  const LOW_CARBON_FUELS = ['wind', 'solar', 'hydro', 'nuclear', 'biomass'];

  /** The order the snapshot stores an intensity row in. */
  const INTENSITY_COLUMNS = ['id', 'time', 'actual', 'forecast', 'value', 'band', 'phase', 'isForecast'];

  /** The order the snapshot stores a generation-mix row in. */
  const MIX_COLUMNS = ['fuel', 'perc', 'family', 'lowCarbon'];

  /** The order the snapshot stores a regional row in. */
  const REGIONAL_COLUMNS = ['region', 'dno', 'regionId', 'value', 'band'];

  /** The order the snapshot stores a mix-over-time row in. */
  const HISTORY_COLUMNS = ['time', 'fuel', 'perc'];

  /** A date formatted for London, which is the timezone the API's days follow. */
  const LONDON_FORMATTER = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function londonDate(offsetDays) {
    const parts = LONDON_FORMATTER.formatToParts(new Date(Date.now() + offsetDays * 86400000));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function londonDateOf(ms) {
    const parts = LONDON_FORMATTER.formatToParts(new Date(ms));
    const get = (type) => (parts.find((p) => p.type === type) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /** A number, or null when the API left the field absent. */
  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** The average of a list of numbers, or 0 when the list is empty. */
  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  /**
   * Fetch JSON from the API. The service is a beta with occasional wobbles,
   * so a short pause and retry beats giving up.
   */
  async function requestJson(url, describe, opts = {}) {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { signal: opts.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`The ${describe} answered ${response.status}.`);
    }
  }

  /** The current GB carbon intensity, as one reading. */
  async function fetchCurrent(opts = {}) {
    const body = await requestJson(`${BASE}/intensity`, 'current intensity', opts);
    const item = (body.data && body.data[0]) || {};
    const intensity = item.intensity || {};
    const actual = numberOrNull(intensity.actual);
    const forecast = numberOrNull(intensity.forecast);
    const value = actual != null ? actual : forecast;
    return {
      time: Date.parse(item.from) || Date.now(),
      from: item.from || null,
      to: item.to || null,
      actual,
      forecast,
      value,
      index: intensity.index || '',
    };
  }

  /** Turn one half-hourly intensity record into a flat row. */
  function toIntensityRow(item) {
    const intensity = item.intensity || {};
    const actual = numberOrNull(intensity.actual);
    const forecast = numberOrNull(intensity.forecast);
    const value = actual != null ? actual : forecast;
    const isForecast = actual == null;
    return {
      kind: 'intensity',
      id: item.from,
      time: Date.parse(item.from),
      actual,
      forecast: isForecast ? forecast : null,
      value,
      band: intensity.index || '',
      phase: isForecast ? 'forecast' : 'actual',
      isForecast,
    };
  }

  /** A whole day of half-hourly intensity, for one London date. */
  async function fetchIntensityDay(dateStr, opts = {}) {
    const body = await requestJson(`${BASE}/intensity/date/${dateStr}`, `intensity for ${dateStr}`, opts);
    return (body.data || []).map(toIntensityRow);
  }

  /** Turn one fuel in the current generation mix into a flat row. */
  function toMixRow(item) {
    const fuel = item.fuel;
    if (!fuel) return null;
    return {
      kind: 'mix',
      id: fuel,
      fuel,
      perc: numberOrNull(item.perc),
      family: FUEL_FAMILY[fuel] || 'Other',
      lowCarbon: LOW_CARBON_FUELS.indexOf(fuel) >= 0,
    };
  }

  /** The current GB generation mix, one row per fuel. */
  async function fetchGenerationNow(opts = {}) {
    const body = await requestJson(`${BASE}/generation`, 'current generation mix', opts);
    const data = body.data || {};
    return (data.generationmix || []).map(toMixRow).filter(Boolean);
  }

  /** Two days of half-hourly generation mix, one row per fuel per half hour. */
  async function fetchGenerationHistory(from, to, opts = {}) {
    const body = await requestJson(`${BASE}/generation/${from}/${to}`, `generation mix from ${from} to ${to}`, opts);
    const rows = [];
    for (const item of body.data || []) {
      const time = Date.parse(item.from);
      for (const part of item.generationmix || []) {
        if (!part.fuel) continue;
        rows.push({ id: `${item.from}@${part.fuel}`, time, fuel: part.fuel, perc: numberOrNull(part.perc) });
      }
    }
    return rows;
  }

  /** Turn one region into a flat row. */
  function toRegionalRow(region) {
    const intensity = region.intensity || {};
    const value = numberOrNull(intensity.forecast);
    return {
      kind: 'regional',
      id: region.shortname || String(region.regionid),
      region: region.shortname || '',
      dno: region.dnoregion || '',
      regionId: region.regionid,
      value,
      band: intensity.index || '',
    };
  }

  /** The current regional intensity, one row per region. */
  async function fetchRegional(opts = {}) {
    const body = await requestJson(`${BASE}/regional`, 'regional intensity', opts);
    const item = (body.data && body.data[0]) || {};
    return (item.regions || []).map(toRegionalRow).filter((row) => row.region);
  }

  /** The largest intensity across a day, used to scale the in-cell bars. */
  function dayMaxOf(rows) {
    let max = 0;
    for (const row of rows) if (row.value != null && row.value > max) max = row.value;
    return max;
  }

  /** The largest regional intensity, rounded up to a tidy dial, at least 400. */
  function regionalMaxOf(rows) {
    let max = 0;
    for (const row of rows) if (row.value != null && row.value > max) max = row.value;
    return Math.max(400, Math.ceil(max / 100) * 100);
  }

  /** The share of a set of mix rows that is low-carbon, as a percentage. */
  function lowCarbonShare(rows) {
    let total = 0;
    let low = 0;
    for (const row of rows) {
      const perc = row.perc || 0;
      total += perc;
      if (row.lowCarbon) low += perc;
    }
    return total ? (low / total) * 100 : 0;
  }

  /** The average low-carbon share over one London day of mix-over-time rows. */
  function averageLowCarbonShare(history, dateStr) {
    const bySlot = new Map();
    for (const row of history) {
      if (londonDateOf(row.time) !== dateStr) continue;
      let slot = bySlot.get(row.time);
      if (!slot) { slot = { total: 0, low: 0 }; bySlot.set(row.time, slot); }
      slot.total += row.perc || 0;
      if (LOW_CARBON_FUELS.indexOf(row.fuel) >= 0) slot.low += row.perc || 0;
    }
    const shares = [];
    for (const slot of bySlot.values()) if (slot.total) shares.push((slot.low / slot.total) * 100);
    return mean(shares);
  }

  /**
   * Read everything the page starts from: the current reading, today's
   * half-hourly intensity, yesterday's (for the baseline), the current mix,
   * two days of mix history, and the regional intensity.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<object>}
   */
  async function fetchInitial(opts = {}) {
    const report = opts.onProgress || (() => {});
    const today = londonDate(0);
    const yesterday = londonDate(-1);
    const tomorrow = londonDate(1);

    report('Reading the current intensity...', 0.1);
    const now = await fetchCurrent(opts);
    report('Reading today\u2019s intensity...', 0.3);
    const intensity = await fetchIntensityDay(today, opts);
    report('Reading yesterday for the baseline...', 0.45);
    const yesterdayRows = await fetchIntensityDay(yesterday, opts);
    report('Reading the generation mix...', 0.6);
    const mix = await fetchGenerationNow(opts);
    report('Reading two days of generation...', 0.75);
    const history = await fetchGenerationHistory(yesterday, tomorrow, opts);
    report('Reading the regional intensity...', 0.9);
    const regional = await fetchRegional(opts);

    report('Building the dashboard...', 1);
    return {
      now,
      intensity,
      mix,
      regional,
      history,
      today,
      yesterday,
      tomorrow,
      dayMax: dayMaxOf(intensity),
      regionalMax: regionalMaxOf(regional),
      yesterdayAverage: mean(yesterdayRows.map((row) => row.value).filter((v) => v != null)),
      todayLowCarbon: lowCarbonShare(mix),
      yesterdayLowCarbon: averageLowCarbonShare(history, yesterday),
    };
  }

  /**
   * Poll for the feeds that move within the day: the current reading, today's
   * intensity (as the forecast firms up into actuals), the current mix, the
   * regional intensity and the mix history. Yesterday's baseline is not
   * re-read; it is fixed for the day.
   */
  async function fetchPoll(opts = {}, fixed = {}) {
    const today = londonDate(0);
    const yesterday = fixed.yesterday || londonDate(-1);
    const tomorrow = londonDate(1);

    const now = await fetchCurrent(opts);
    const intensity = await fetchIntensityDay(today, opts);
    const mix = await fetchGenerationNow(opts);
    const regional = await fetchRegional(opts);
    const history = await fetchGenerationHistory(yesterday, tomorrow, opts);

    return {
      now,
      intensity,
      mix,
      regional,
      history,
      dayMax: dayMaxOf(intensity),
      regionalMax: regionalMaxOf(regional),
      todayLowCarbon: lowCarbonShare(mix),
      yesterdayLowCarbon: averageLowCarbonShare(history, yesterday),
    };
  }

  /**
   * Poll for fresh readings and report each result.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ onPoll, onError, intervalMs = POLL_MS, fixed = {} }) {
    let stopped = false;
    let timer = null;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      try {
        const result = await fetchPoll({ signal: controller.signal }, fixed);
        if (!stopped) onPoll({ ...result, fetchedAt: Date.now() });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /* ---------------- the snapshot ---------------- */

  function encodeIntensity(row) { return INTENSITY_COLUMNS.map((col) => row[col]); }
  function encodeMix(row) { return MIX_COLUMNS.map((col) => row[col]); }
  function encodeRegional(row) { return REGIONAL_COLUMNS.map((col) => row[col]); }
  function encodeHistory(row) { return HISTORY_COLUMNS.map((col) => row[col]); }

  function decodeIntensity(values) {
    const row = {};
    INTENSITY_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'intensity';
    return row;
  }

  function decodeMix(values) {
    const row = {};
    MIX_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'mix';
    row.id = row.fuel;
    return row;
  }

  function decodeRegional(values) {
    const row = {};
    REGIONAL_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.kind = 'regional';
    row.id = row.region;
    return row;
  }

  function decodeHistory(values) {
    const row = {};
    HISTORY_COLUMNS.forEach((col, index) => { row[col] = values[index]; });
    row.id = `${row.time}@${row.fuel}`;
    return row;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [intensity, mix, regional, history, meta] = await Promise.all(
      ['intensity', 'mix', 'regional', 'history', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    return {
      now: meta.now,
      intensity: intensity.map(decodeIntensity),
      mix: mix.map(decodeMix),
      regional: regional.map(decodeRegional),
      history: history.map(decodeHistory),
      dayMax: meta.dayMax,
      regionalMax: meta.regionalMax,
      yesterdayAverage: meta.yesterdayAverage,
      yesterdayLowCarbon: meta.yesterdayLowCarbon,
      meta: { ...meta, live: false },
    };
  }

  root.CarbonIntensity = Object.assign(root.CarbonIntensity || {}, {
    BASE,
    POLL_MS,
    FUEL_FAMILY,
    LOW_CARBON_FUELS,
    INTENSITY_COLUMNS,
    MIX_COLUMNS,
    REGIONAL_COLUMNS,
    HISTORY_COLUMNS,
    londonDate,
    fetchCurrent,
    fetchIntensityDay,
    fetchGenerationNow,
    fetchGenerationHistory,
    fetchRegional,
    fetchInitial,
    fetchPoll,
    startPolling,
    toIntensityRow,
    toMixRow,
    toRegionalRow,
    encodeIntensity,
    encodeMix,
    encodeRegional,
    encodeHistory,
    decodeIntensity,
    decodeMix,
    decodeRegional,
    decodeHistory,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
