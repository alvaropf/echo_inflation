// Offline test. Replaces fetch with synthetic responses in each source's real wire format
// (FRED/ALFRED JSON, BLS HTML, Zillow CSV, EIA JSON, Cleveland Fed JSON, Philadelphia Fed xlsx),
// then runs both API pipelines. Test-only — never deployed (.vercelignore).
// Usage: node test/run.mjs [--dump]   (--dump writes payloads for a browser render check)
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const pad = n => String(n).padStart(2, '0');
const months = [];
for (let y = 2011; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 8) break; months.push(`${y}-${pad(m)}`); }
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
// Common inflation factor with a 2021-22 surge, so the backtest has something to miss.
const factor = months.map(m => (m >= '2021-03' && m <= '2022-06' ? 0.45 : m >= '2022-07' && m <= '2023-06' ? 0.05 : 0) + 0.04 * rnd());
function path(start, pace, beta, noise) { let v = start; return months.map((m, i) => (i ? (v *= 1 + (pace + beta * factor[i] + noise * rnd()) / 100) : v)); }
const comp = {
  CUSR0000SAH1: path(240, 0.28, 0.6, 0.04), CPIUFDSL: path(230, 0.2, 1, 0.12), CUSR0000SACE: path(200, 0.1, 6, 2.5),
  CUSR0000SEHF: path(210, 0.2, 2, 0.8), CUSR0000SACL1E: path(140, 0.05, 1.2, 0.12),
};
const sxs = path(380, 0.25, 0.8, 0.08);
const RI = { CUSR0000SAH1: 35.625, CPIUFDSL: 13.698, CUSR0000SACE: 3.12, CUSR0000SEHF: 3.262, CUSR0000SACL1E: 19.176 }; const RIs = 60.744 - 35.625;
const dI = months.indexOf('2025-12');
const head = months.map((_, i) => 100 * (Object.entries(RI).reduce((s, [k, w]) => s + w / 100 * comp[k][i] / comp[k][dI], 0) + RIs / 100 * sxs[i] / sxs[dI]));
const seas = [0.997, 1.0, 1.002, 1.003, 1.003, 1.002, 1.0, 1.0, 1.001, 0.999, 0.997, 0.995];
const series = { ...comp, CPIAUCSL: head, CPIAUCNS: head.map((v, i) => v * seas[i % 12]) };
const MISSING = '2025-10'; // never published (shutdown)
const releaseOf = m => { const [y, mo] = m.split('-').map(Number); const t = y * 12 + mo; return m === '2025-09' ? '2025-10-24' : m === '2025-11' ? '2025-12-18' : `${Math.floor(t / 12)}-${pad(t % 12 + 1)}-13`; };

// ALFRED vintages: SA series revised every February for the previous 5 years; NSA never revised.
function alfredRows(id, mutate) {
  const vals = series[id], rows = [];
  months.forEach((m, i) => {
    if (m === MISSING) return;
    const rel = releaseOf(m), obs = `${m}-01`;
    if (rel < '2012-01-01' && id !== 'CPIAUCNS') { rows.push([obs, '2012-01-01', '9999-12-31', vals[i]]); return; }
    const isSA = id !== 'CPIAUCNS';
    const revs = isSA ? [1, 2, 3, 4, 5].map(k => `${+m.slice(0, 4) + k}-02-12`).filter(d => d > rel && d < '2026-10-13') : [];
    const starts = [rel < '2012-01-01' ? '2012-01-01' : rel, ...revs];
    starts.forEach((st, j) => {
      const end = j + 1 < starts.length ? prevDay(starts[j + 1]) : '9999-12-31';
      let v = vals[i] * (1 + (j + 1 < starts.length ? 0.0002 * Math.sin(i + j) : 0)); // early vintages differ slightly
      if (mutate) v = mutate(m, st, v);
      rows.push([obs, st, end, +v.toFixed(3)]);
    });
  });
  return rows;
}
function prevDay(d) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }
let MUTATE = null;

const days = []; for (let d = new Date('2011-01-03'); d <= new Date('2026-10-12'); d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
let oil = 90; const oilObs = days.map(d => [d, +(oil *= 1 + 0.0001 + 0.02 * rnd()).toFixed(2)]);
const fredJson = obs => JSON.stringify({ observations: obs.map(([d, v]) => ({ date: d, value: v == null ? '.' : String(v) })) });
const dailyObs = base => days.filter(d => d >= '2021-01-01').map(d => [d, +(base + 0.1 * rnd()).toFixed(2)]);
const monthlyObs = base => months.filter(m => m >= '2021-01').map(m => [`${m}-01`, +(base + 0.2 * rnd()).toFixed(2)]);

const riHtml = `<table><tr><th>Item and group</th><th>CPI-U</th><th>CPI-W</th></tr>
<tr><th>All items</th><td>100.000</td><td>100.000</td></tr><tr><th><p class="sub1">Food</p></th><td>13.698</td><td>14.889</td></tr>
<tr><th>Energy</th><td>6.383</td><td>8.052</td></tr><tr><th>Energy commodities</th><td>3.120</td><td>4.198</td></tr>
<tr><th>Energy services</th><td>3.262</td><td>3.855</td></tr><tr><th>Commodities less food and energy commodities</th><td>19.176</td><td>19.966</td></tr>
<tr><th>Services less energy services</th><td>60.744</td><td>57.093</td></tr><tr><th>Shelter</th><td>35.625</td><td>33.594</td></tr></table>`;
const zoriPath = path(1100, 0.3, 0.8, 0.05).slice(months.indexOf('2015-01'));
const zoriCsv = `RegionID,SizeRank,RegionName,RegionType,StateName,${months.slice(months.indexOf('2015-01')).map(m => `${m}-28`).join(',')}\n102001,0,United States,country,,${zoriPath.map(v => v.toFixed(1)).join(',')}`;
const steo = { response: { data: ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-06', '2027-10', '2027-12'].map((p, i) => ({ period: p, seriesId: 'WTIPUUS', value: String(80 - i) })) } };

// Cleveland nowcast: one block per target month with a daily path that converges on the truth.
const allNc = [...months, '2026-09', '2026-10'].filter(m => m >= '2013-08');
function ncBlock(m, kind) {
  const i = months.indexOf(m);
  const truth = i < 0 ? (kind === 'mom' ? 0.3 : 3.0)
    : kind === 'mom' ? (head[i] / head[i - 1] - 1) * 100 : (series.CPIAUCNS[i] / series.CPIAUCNS[i - 12] - 1) * 100;
  const [y, mo] = m.split('-').map(Number), cats = [], data = [];
  for (let k = -20; k <= 40; k += 2) {
    const d = new Date(Date.UTC(y, mo - 1, 1 + k));
    cats.push({ label: `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}` });
    data.push({ value: +(truth + (0.25 * (40 - k)) / 60 * Math.sin(i + k)).toFixed(2) });
  }
  return { chart: { caption: 'Inflation Nowcasting', subcaption: `${y}-${mo}` }, categories: [{ category: cats }], dataset: [{ seriesname: 'CPI Inflation', data }, { seriesname: 'Core CPI Inflation', data }] };
}
const spfRows = [['YEAR', 'QUARTER', 'CPI1', 'CPI2', 'CPI3', 'CPI4', 'CPI5', 'CPI6', 'CPIA', 'CPIB', 'CPIC']];
for (let y = 2014; y <= 2026; y++) for (let q = 1; q <= 4; q++) { if (y === 2026 && q > 3) break; spfRows.push([y, q, 2, 2, 2.3 + 0.3 * Math.sin(y + q), 2.3, 2.3, 2.3, 2, 2, 2]); }
const spfWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(spfWb, XLSX.utils.aoa_to_sheet(spfRows), 'MEDIAN');
const spfBuf = XLSX.write(spfWb, { type: 'buffer', bookType: 'xlsx' });

const latestObs = id => months.map((m, i) => [`${m}-01`, m === MISSING ? null : series[id][i]]);
const routes = [
  [/series_id=(\w+).*output_type=1/, m => JSON.stringify({ observations: alfredRows(m[1], MUTATE).map(([date, rs, re, v]) => ({ date, realtime_start: rs, realtime_end: re, value: String(v) })) })],
  [/api\.stlouisfed\.org.*series_id=(\w+)/, m => {
    const id = m[1];
    if (series[id]) return fredJson(latestObs(id));
    if (id === 'DCOILWTICO') return fredJson(oilObs);
    if (id === 'T5YIE') return fredJson(dailyObs(2.45)); if (id === 'T5YIFR') return fredJson(dailyObs(2.3));
    if (id === 'EXPINF1YR') return fredJson(monthlyObs(2.9)); if (id === 'MICH') return fredJson(monthlyObs(3.8));
    if (id === 'PCECTPIMD') return fredJson([['2026-01-01', 2.9], ['2027-01-01', 2.4], ['2028-01-01', 2.1]]);
  }],
  [/relative-importance\/2025/, () => riHtml],
  [/relative-importance/, () => null],
  [/zori/, () => zoriCsv],
  [/api\.eia\.gov/, () => JSON.stringify(steo)],
  [/nowcast_month/, () => JSON.stringify(allNc.map(m => ncBlock(m, 'mom')))],
  [/nowcast_year/, () => JSON.stringify(allNc.map(m => ncBlock(m, 'yoy')))],
  [/Median_CPI_Level/, () => spfBuf],
];
globalThis.fetch = async url => {
  for (const [re, fn] of routes) { const m = String(url).match(re); if (m) { const b = fn(m); if (b == null) break; return new Response(b, { status: 200 }); } }
  return new Response('not found', { status: 404 });
};
process.env.EIA_API_KEY = 'test'; process.env.FRED_API_KEY = 'test';

/* ---------- /api/data ---------- */
const { collect } = await import('../api/data.js');
const out = await collect(new Date('2026-10-13T10:00:00Z'));
const p = out.panel;
const n = months.length - 1, trueSxs12 = (sxs[n] / sxs[n - 12] - 1) * 100;
const lv = p.levels.sxs, derived = (lv[lv.length - 1] / lv[lv.length - 13] - 1) * 100;
console.log('data: last', p.last, 'gaps', p.gaps, '| sxs 12m true', trueSxs12.toFixed(3), 'derived', derived.toFixed(3));
assert.equal(p.last, '2026-08'); assert.deepEqual(p.gaps, ['2025-10']);
assert.ok(Math.abs(trueSxs12 - derived) < 0.05, 'derived services ex-shelter should match');
assert.deepEqual(out.refs.nowcast.mom.map(r => r.month), ['2026-09', '2026-10']);
assert.ok(!('daily' in out.refs.nowcast.mom[0]), 'daily nowcast history must not be sent to the page');
console.log('sources:', out.sources.filter(s => !s.ok || s.error).map(s => s.name + ': ' + s.error).join('; ') || 'all live');

/* ---------- /api/backtest ---------- */
const { runBacktest } = await import('../api/backtest.js');
const t0 = Date.now();
const bt = await runBacktest(new Date('2026-10-13T10:00:00Z'));
console.log(`backtest: ${bt.origins} origins ${bt.firstOrigin}..${bt.lastOrigin} in ${Date.now() - t0} ms`);
for (const h of [1, 2, 3, 6, 12]) {
  const s = bt.stats.all[h], x = bt.stats.exPandemic[h];
  console.log(`h=${String(h).padStart(2)} RMSE all: model ${s.model.rmse} | +nowcast ${s.modelNC.rmse} | naive ${s.naive.rmse}` +
    (s.nowcast ? ` | nowcast ${s.nowcast.rmse}` : '') + (s.spf ? ` | SPF ${s.spf.rmse}` : '') + `   ex-pandemic +nowcast ${x.modelNC.rmse} band [${x.modelNC.q10}, ${x.modelNC.q90}]`);
}
// Anchoring correctness: with a perfect nowcast, the 1-month-ahead official rate should be (almost) exact.
{
  const S = await import('../lib/sources.js'), { buildPanel } = await import('../lib/derive.js'), M = await import('../public/model.js');
  const ids = ['CPIAUCSL', 'CPIAUCNS', 'CPIUFDSL', 'CUSR0000SACE', 'CUSR0000SEHF', 'CUSR0000SACL1E', 'CUSR0000SAH1'];
  const ser = {}; for (const id of ids) ser[id] = S.asOf(await S.alfred(id), '2019-06-13');
  const panel = buildPanel({ series: ser, ri: S.RI_FALLBACK }), i = months.indexOf('2019-06');
  const trueMom = (head[i] / head[i - 1] - 1) * 100, trueYoy = (series.CPIAUCNS[i] / series.CPIAUCNS[i - 12] - 1) * 100;
  const sim = M.simulate(panel, M.dataDefaults(panel, { rentYoY: 3, oilTarget: 60 }), { anchor: { '2019-06': trueMom }, oil: { asOfMonth: '2019-06', spot: 60 } });
  const err = Math.abs(sim.yoy(sim.n + 1) - trueYoy);
  assert.ok(err < 0.05, `perfect anchor should reproduce the official rate (error ${err.toFixed(3)})`);
  console.log(`perfect-nowcast check passed (1-month error ${err.toFixed(3)} pts)`);
}
assert.ok(!bt.path12.some(r => r.target === '2025-10' || r.target === '2026-10'), 'targets without a published base must be skipped');

// No look-ahead: change every number published after 2021-01-01 and rerun.
// Forecasts made before that date must not move by a single digit.
const snap = JSON.stringify(bt.path12.filter(r => r.origin <= '2020-10').map(({ actual, ...r }) => r));
MUTATE = (m, start, v) => (start >= '2021-01-01' ? v * 1.5 : v);
const bt2 = await runBacktest(new Date('2026-10-13T10:00:00Z'));
const snap2 = JSON.stringify(bt2.path12.filter(r => r.origin <= '2020-10').map(({ actual, ...r }) => r));
assert.equal(snap, snap2, 'look-ahead detected: early forecasts changed when later vintages changed');
console.log('look-ahead check passed (forecasts before 2021 unchanged when later vintages altered)');
MUTATE = null;

if (process.argv.includes('--dump')) {
  writeFileSync(new URL('./fixture-payload.json', import.meta.url), JSON.stringify(out));
  writeFileSync(new URL('./fixture-backtest.json', import.meta.url), JSON.stringify(bt));
}
console.log('all checks passed');
