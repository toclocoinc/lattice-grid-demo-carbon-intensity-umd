/**
 * Save a real run of the Carbon Intensity API to `data/snapshot/`, so the
 * dashboard can also be opened with no network.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.CarbonIntensity` and
 * they are read from there. One copy of the feed code, used by both.
 *
 * It saves today's half-hourly intensity, the current generation mix, the
 * regional intensity, two days of generation-mix history, and the derived
 * headline figures (the current reading, yesterday's average, the low-carbon
 * share) into `meta.json`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'carbon-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchInitial, encodeIntensity, encodeMix, encodeRegional, encodeHistory } = globalThis.CarbonIntensity;

const started = Date.now();
const result = await fetchInitial({
  onProgress: (message) => console.log(`  ${message}`),
});

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  source: 'Carbon Intensity API (National Energy System Operator)',
  sourceUrl: 'https://api.carbonintensity.org.uk/',
  licence: 'CC BY 4.0',
  today: result.today,
  yesterday: result.yesterday,
  now: result.now,
  dayMax: result.dayMax,
  regionalMax: result.regionalMax,
  yesterdayAverage: Number(result.yesterdayAverage.toFixed(2)),
  yesterdayLowCarbon: Number(result.yesterdayLowCarbon.toFixed(2)),
  counts: {
    intensity: result.intensity.length,
    mix: result.mix.length,
    regional: result.regional.length,
    history: result.history.length,
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'intensity.json'), JSON.stringify(result.intensity.map(encodeIntensity)));
await writeFile(join(outDir, 'mix.json'), JSON.stringify(result.mix.map(encodeMix)));
await writeFile(join(outDir, 'regional.json'), JSON.stringify(result.regional.map(encodeRegional)));
await writeFile(join(outDir, 'history.json'), JSON.stringify(result.history.map(encodeHistory)));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nSaved ${result.intensity.length} half-hours, ${result.mix.length} fuels, ${result.regional.length} regions and ${result.history.length} mix readings in ${seconds}s.`);
console.log(`  Current intensity: ${result.now.value ?? 'n/a'} gCO2/kWh (${result.now.index}).`);
console.log(`  Yesterday's average: ${meta.yesterdayAverage} gCO2/kWh.`);
console.log(`  Low-carbon share: ${result.todayLowCarbon.toFixed(1)}% now, ${meta.yesterdayLowCarbon}% yesterday.`);
