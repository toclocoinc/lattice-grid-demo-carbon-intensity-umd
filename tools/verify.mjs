/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the Carbon Intensity API being reachable. It does depend on jsDelivr,
 * because that is where the page gets the grid from.
 *
 * It asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag (no type="module", pinned
 *     release, integrity hashes, each file left its global);
 *   - the intensity table, the mix table and the regional table hold rows, the
 *     three charts drew marks, and no watermark shows on localhost;
 *   - the headline figures agree with the saved data, recomputed here;
 *   - the two main tables are side by side rather than in tabs;
 *   - the fuel-family summary derives from the mix table and sums to ~100%;
 *   - a pushed record lands in the table its kind routes it to, and nowhere
 *     else;
 *   - grouping the regional table by band produces group rows;
 *   - filtering to actual readings only moves the forecast line off the chart.
 *
 * It then blocks the API in the browser and opens the live page, to prove a
 * visitor gets the saved copy, and is told so, when the API cannot be reached.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

const GRID_VERSION = '1.66.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`);
  }
}

function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'carbon-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__carbonIntensity)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__carbonIntensity.ready, error: window.__carbonIntensity.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__carbonIntensity.intensityGrid && window.__carbonIntensity.intensityGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy.                                                  */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    const globals = {};
    for (const name of ['LatticeGrid', 'LatticeGridDataRouter', 'LatticeGridKPI', 'LatticeGridTabs']) {
      const value = window[name];
      globals[name] = value ? Object.keys(value).filter((k) => typeof value[k] === 'function').length : 0;
    }
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      globals,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createHeadlessGrid: typeof (window.LatticeGrid || {}).createHeadlessGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createStat: typeof (window.LatticeGrid || {}).createStat,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_TAGS.length, `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`, `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');
  check(delivery.members.createHeadlessGrid === 'function', 'delivery: createHeadlessGrid is on the core global');
  check(delivery.members.createStat === 'function', 'delivery: createStat is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__carbonIntensity;
    const side = document.querySelector('.side');
    const sideCols = side ? getComputedStyle(side).gridTemplateColumns.split(' ').length : 0;
    return {
      intensity: d.intensityGrid.rows.count(),
      mix: d.mixGrid.rows.count(),
      regional: d.regionalGrid.rows.count(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.intensityGrid.licence.watermark(),
      licenceState: d.intensityGrid.licence.state(),
      nowTile: d.tiles.now.value(),
      lowCarbonTile: d.tiles.lowCarbon.value(),
      kpiTiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      sideCols,
      tabsHost: !!document.querySelector('.tabs-host'),
      freshness: document.querySelector('.freshness').textContent,
    };
  })()`);
  console.log(`  ${snap.intensity} half-hours, ${snap.mix} fuels, ${snap.regional} regions; ${snap.painted} painted; ${snap.charts} charts`);
  console.log(`  tiles: now ${snap.nowTile}, low-carbon ${snap.lowCarbonTile}, kpi ${JSON.stringify(snap.kpiTiles)}`);

  check(snap.intensity > 0, 'saved copy: the intensity table holds rows', `${snap.intensity}`);
  check(snap.mix > 0, 'saved copy: the mix table holds rows', `${snap.mix}`);
  check(snap.regional > 0, 'saved copy: the regional table holds rows', `${snap.regional}`);
  check(snap.painted > 0, 'saved copy: the tables painted rows', `${snap.painted}`);
  check(snap.charts === 3, 'saved copy: all three charts were built', `${snap.charts}`);
  check(snap.sideCols === 2, 'saved copy: the two main tables sit side by side in two columns', `${snap.sideCols} columns`);
  check(!snap.tabsHost, 'saved copy: the main tables are not inside a tab host');

  const drawn = await evaluate(`(() => window.__carbonIntensity.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('path, circle').length : 0;
    return { i, series: series.length, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.series} series, ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.marks > 0, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(drawn[1] && drawn[1].series >= 2, 'saved copy: the forecast chart splits into actual and forecast series', `${drawn[1] && drawn[1].series} series`);
  check(drawn[1] && drawn[1].withValue > 0, 'saved copy: the forecast chart plotted values', `${drawn[1] && drawn[1].withValue}`);
  check(drawn[2] && drawn[2].withValue > 0, 'saved copy: the stacked mix chart plotted values', `${drawn[2] && drawn[2].withValue}`);
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-snapshot');

  /* Independent recomputation from the saved data. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const mixValues = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'mix.json'), 'utf8'));
  // mix.json rows are [fuel, perc, family, lowCarbon]
  const mixRows = mixValues.map((v) => ({ fuel: v[0], perc: v[1], family: v[2], lowCarbon: v[3] }));
  const mixTotal = mixRows.reduce((s, r) => s + (r.perc || 0), 0);
  const mixLow = mixRows.reduce((s, r) => s + (r.lowCarbon ? (r.perc || 0) : 0), 0);
  const expectedLowCarbon = mixTotal ? (mixLow / mixTotal) * 100 : 0;
  const expectedNow = meta.now.value;

  check(snap.nowTile === expectedNow, 'saved copy: the "now" tile matches the saved current reading', `tile ${snap.nowTile}, expected ${expectedNow}`);
  check(Math.abs(snap.lowCarbonTile - expectedLowCarbon) < 0.5, 'saved copy: the low-carbon share matches the saved mix', `tile ${snap.lowCarbonTile}, expected ${expectedLowCarbon.toFixed(1)}`);
  check(snap.kpiTiles.fuels === mixRows.length, 'saved copy: the KPI fuel count matches the saved mix', `${snap.kpiTiles.fuels} of ${mixRows.length}`);
  check(typeof snap.kpiTiles.renewable === 'number', 'saved copy: the renewable share tile is a number', `${snap.kpiTiles.renewable}`);

  /* ---- the derived fuel-family summary ---- */

  const derived = await evaluate(`(() => {
    const d = window.__carbonIntensity;
    let total = 0, rows = 0;
    d.derivedGrid.rows.forEach((r) => { if (r && r.data && typeof r.data.share === 'number') { total += r.data.share; rows += 1; } });
    return { rows, total };
  })()`);
  console.log(`  derived grid: ${derived.rows} families, ${derived.total.toFixed(1)}% total`);
  check(derived.rows >= 3, 'derived grid: the mix summarises into several fuel families', `${derived.rows} families`);
  check(Math.abs(derived.total - 100) < 2, 'derived grid: the family shares sum to about 100%', `${derived.total.toFixed(1)}%`);

  /* ---- routing a pushed record ---- */

  const injected = await evaluate(`(async () => {
    const d = window.__carbonIntensity;
    const intensityBefore = d.intensityGrid.rows.count();
    const mixBefore = d.mixGrid.rows.count();
    d.ingest([{ kind: 'mix', id: 'geothermal', fuel: 'geothermal', perc: 3.5, family: 'Renewable', lowCarbon: true }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.mixGrid.rows.forEach((r) => { if (r && r.data && r.data.id === 'geothermal') found = r.data; });
    return { mix: d.mixGrid.rows.count(), intensity: d.intensityGrid.rows.count(), intensityBefore, mixBefore, family: found ? found.family : null };
  })()`);
  console.log(`  injected mix row: mix ${injected.mixBefore} -> ${injected.mix}, intensity ${injected.intensityBefore} -> ${injected.intensity}`);
  check(injected.mix === injected.mixBefore + 1, 'a pushed mix row lands in the mix table', `${injected.mix}`);
  check(injected.intensity === injected.intensityBefore, 'the mix row did not leak into the intensity table', `${injected.intensity}`);
  check(injected.family === 'Renewable', 'the pushed mix row carries its family', injected.family);

  const pushedIntensity = await evaluate(`(async () => {
    const d = window.__carbonIntensity;
    const before = d.intensityGrid.rows.count();
    d.ingest([{ kind: 'intensity', id: 'verify-half-hour', time: Date.now(), actual: 42, forecast: null, value: 42, band: 'very low', phase: 'actual', isForecast: false }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.intensityGrid.rows.forEach((r) => { if (r && r.data && r.data.id === 'verify-half-hour') found = r.data; });
    return { after: d.intensityGrid.rows.count(), before, band: found ? found.band : null };
  })()`);
  check(pushedIntensity.after === pushedIntensity.before + 1, 'a pushed intensity row lands in the intensity table', `${pushedIntensity.after}`);
  check(pushedIntensity.band === 'very low', 'the pushed intensity row carries its band', pushedIntensity.band);

  /* ---- grouping the regional table by band ---- */

  await evaluate("window.__carbonIntensity.regionalGrid.columns.group(['band'])");
  await sleep(600);
  const grouped = await evaluate(`(() => {
    const d = window.__carbonIntensity;
    let groups = 0;
    d.regionalGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups };
  })()`);
  check(grouped.groups > 0, 'grouping the regional table by band produces group rows', `${grouped.groups} groups`);
  await shoot('02-regional-grouped');
  await evaluate('window.__carbonIntensity.regionalGrid.columns.group([])');
  await sleep(400);

  /* ---- filtering to actual readings moves the forecast line off the chart ---- */

  const seriesBefore = await evaluate('window.__carbonIntensity.charts[1].data().series.length');
  await evaluate("window.__carbonIntensity.actualButton.click()");
  await sleep(700);
  const seriesAfter = await evaluate('window.__carbonIntensity.charts[1].data().series.length');
  const filterRows = await evaluate('window.__carbonIntensity.intensityGrid.rows.count()');
  console.log(`  actual-only filter: chart series ${seriesBefore} -> ${seriesAfter}, ${filterRows} rows`);
  check(seriesBefore >= 2, 'the forecast chart starts with both actual and forecast series', `${seriesBefore}`);
  check(seriesAfter < seriesBefore, 'filtering to actual readings drops the forecast series from the chart', `${seriesBefore} -> ${seriesAfter}`);
  check(filterRows > 0, 'the actual-only filter still leaves readings on screen', `${filterRows}`);
  await shoot('03-actual-only');
  await evaluate("window.__carbonIntensity.actualButton.click()");
  await sleep(500);
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the API cannot be reached.              */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*api.carbonintensity.org.uk*'] });
  await open(`${origin}/index.html`, 'live page, with the API unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__carbonIntensity;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    return {
      intensity: d.intensityGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  intensity ${fallback.intensity}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.intensity > 0, 'fallback: the saved copy is on screen', `${fallback.intensity} rows`);
  check(fallback.painted > 0, 'fallback: the tables painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallback.notice && /could not be reached/i.test(fallback.notice), 'fallback: the page says the API was unreachable', fallback.notice);
  check(!fallback.polling, 'fallback: no poll is started against an API that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('04-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__carbonIntensity;
      return {
        intensity: d.intensityGrid.rows.count(),
        mix: d.mixGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.intensityGrid.licence.watermark(),
        nowTile: d.tiles.now.value(),
      };
    })()`);
    console.log(`  ${live.intensity} half-hours and ${live.mix} fuels from the live API; now ${live.nowTile}`);
    check(live.fellBack === false, 'live: the rows came from the API, not the saved copy');
    check(live.intensity > 0, 'live: the intensity table holds rows from the API', `${live.intensity}`);
    check(live.mix > 0, 'live: the mix table holds rows from the API', `${live.mix}`);
    check(live.charts === 3, 'live: all three charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    noErrors('live');
    await shoot('05-live');
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
