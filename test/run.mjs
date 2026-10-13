// Offline test: replaces fetch with synthetic responses in each source's real wire format,
// then runs the full API pipeline. Test-only — never deployed (.vercelignore).
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';

const months = [];
for (let y = 2018; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 8) break; months.push(`${y}-${String(m).padStart(2, '0')}`); }
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
function path(start, monthlyPct, noise) {
  let v = start; return months.map((m, i) => (i ? (v *= 1 + (monthlyPct + noise * rnd()) / 100) : v));
}
const comp = {
  CUSR0000SAH1: path(300, 0.33, 0.05), CPIUFDSL: path(250, 0.25, 0.15), CUSR0000SACE: path(220, 0.2, 3),
  CUSR0000SEHF: path(260, 0.35, 1), CUSR0000SACL1E: path(150, 0.1, 0.15),
};
const sxs = path(400, 0.3, 0.1);
const W = { CUSR0000SAH1: 0.356, CPIUFDSL: 0.137, CUSR0000SACE: 0.031, CUSR0000SEHF: 0.033, CUSR0000SACL1E: 0.192 }; const wS = 0.251;
const RI = { CUSR0000SAH1: 35.625, CPIUFDSL: 13.698, CUSR0000SACE: 3.12, CUSR0000SEHF: 3.262, CUSR0000SACL1E: 19.176 }; const RIs = 60.744 - 35.625;
const dI = months.indexOf('2025-12');
// Laspeyres with Dec-2025 base, the same structure BLS uses within a weight year
const head = months.map((_, i) => 100 * (Object.entries(RI).reduce((s, [k, w]) => s + w / 100 * comp[k][i] / comp[k][dI], 0) + RIs / 100 * sxs[i] / sxs[dI]));
const seas = [0.997, 1.0, 1.002, 1.003, 1.003, 1.002, 1.0, 1.0, 1.001, 0.999, 0.997, 0.995];
const series = { ...comp, CPIAUCSL: head, CPIAUCNS: head.map((v, i) => v * seas[i % 12]) };

function csv(id, vals, ms = months) {
  return 'observation_date,' + id + '\n' + ms.map((m, i) => `${m}-01,${m === '2025-10' ? '' : vals[i].toFixed(3)}`).join('\n');
}
const days = []; for (let d = new Date('2024-01-01'); d <= new Date('2026-10-12'); d.setDate(d.getDate() + 1)) if (d.getDay() % 6) days.push(d.toISOString().slice(0, 10));
let oil = 72; const oilCsv = 'observation_date,DCOILWTICO\n' + days.map(d => `${d},${(oil *= 1 + 0.0004 + 0.02 * rnd()).toFixed(2)}`).join('\n');
const daily = (id, base) => 'observation_date,' + id + '\n' + days.map(d => `${d},${(base + 0.1 * rnd()).toFixed(2)}`).join('\n');
const monthly = (id, base) => 'observation_date,' + id + '\n' + months.map(m => `${m}-01,${(base + 0.2 * rnd()).toFixed(2)}`).join('\n');

const riHtml = `<table><tr><th>Item and group</th><th>CPI-U</th><th>CPI-W</th></tr>
<tr><th>All items</th><td>100.000</td><td>100.000</td></tr><tr><th><p class="sub1">Food</p></th><td>13.698</td><td>14.889</td></tr>
<tr><th>Energy</th><td>6.383</td><td>8.052</td></tr><tr><th>Energy commodities</th><td>3.120</td><td>4.198</td></tr>
<tr><th>Energy services</th><td>3.262</td><td>3.855</td></tr><tr><th>Commodities less food and energy commodities</th><td>19.176</td><td>19.966</td></tr>
<tr><th>Services less energy services</th><td>60.744</td><td>57.093</td></tr><tr><th>Shelter</th><td>35.625</td><td>33.594</td></tr></table>`;
const zoriCols = months.map(m => `${m}-28`);
const zoriCsv = `RegionID,SizeRank,RegionName,RegionType,StateName,${zoriCols.join(',')}\n102001,0,United States,country,,${path(1500, 0.24, 0.05).map(v => v.toFixed(1)).join(',')}\n394913,1,"New York, NY",msa,NY,${months.map(() => 3000).join(',')}`;
const steo = { response: { data: ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-06', '2027-10', '2027-12'].map((p, i) => ({ period: p, seriesId: 'WTIPUUS', value: String(80 - i) })) } };
const nowcastBlock = (cap, v) => ({ chart: { caption: cap }, categories: [{ category: [{ label: '10/08' }, { label: '10/09' }] }], dataset: [{ seriesname: 'CPI Inflation', data: [{ value: v - 0.01 }, { value: v }] }, { seriesname: 'Core CPI Inflation', data: [{ value: 0.3 }, { value: 0.3 }] }] });
const spfWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(spfWb, XLSX.utils.aoa_to_sheet([['YEAR', 'QUARTER', 'CPI1', 'CPI2', 'CPI3', 'CPI4', 'CPI5', 'CPI6', 'CPIA', 'CPIB', 'CPIC'], [2026, 2, 3, 3.1, 2.9, 2.8, 2.6, 2.5, 3, 2.7, 2.5], [2026, 3, 3.2, 3.3, 3.0, 2.8, 2.7, 2.6, 3.1, 2.7, 2.5]]), 'MEDIAN');
const spfBuf = XLSX.write(spfWb, { type: 'buffer', bookType: 'xlsx' });

const routes = [
  [/fredgraph\.csv\?id=(\w+)/, m => {
    const id = m[1];
    if (series[id]) return csv(id, series[id]);
    if (id === 'DCOILWTICO') return oilCsv;
    if (id === 'T5YIE') return daily(id, 2.45); if (id === 'T5YIFR') return daily(id, 2.3);
    if (id === 'EXPINF1YR') return monthly(id, 2.9); if (id === 'MICH') return monthly(id, 3.8);
    if (id === 'PCECTPIMD') return 'observation_date,PCECTPIMD\n2026-01-01,2.9\n2027-01-01,2.4\n2028-01-01,2.1';
  }],
  [/relative-importance\/2025/, () => riHtml],
  [/relative-importance/, () => null],
  [/zori/, () => zoriCsv],
  [/api\.eia\.gov/, () => JSON.stringify(steo)],
  [/nowcast_month/, () => JSON.stringify([nowcastBlock('September 2026', 0.53), nowcastBlock('October 2026', 0.27)])],
  [/nowcast_year/, () => JSON.stringify([nowcastBlock('September 2026', 3.6), nowcastBlock('October 2026', 3.63)])],
  [/Median_CPI_Level/, () => spfBuf],
];
globalThis.fetch = async url => {
  for (const [re, fn] of routes) { const m = String(url).match(re); if (m) { const b = fn(m); if (b == null) break; return new Response(b, { status: 200 }); } }
  return new Response('not found', { status: 404 });
};

process.env.EIA_API_KEY = 'test';
const { collect } = await import('../api/data.js');
const out = await collect(new Date('2026-10-13T10:00:00Z'));
const p = out.panel;
console.log('last CPI month', p.last, 'gaps filled', p.gaps);
console.log('weights', p.weights, 'sum', Object.values(p.weights).reduce((a, b) => a + b, 0).toFixed(4));
console.log('trailing', Object.fromEntries(Object.entries(p.trailing).map(([k, v]) => [k, v.toFixed(2)])));
const n = months.length - 1, trueSxs12 = (sxs[n] / sxs[n - 12] - 1) * 100;
const lv = p.levels.sxs, derived = (lv[lv.length - 1] / lv[lv.length - 13] - 1) * 100;
console.log('sxs true 12m', trueSxs12.toFixed(4), 'derived', derived.toFixed(4));
console.log('rent', out.rent.month, out.rent.yoy.toFixed(2), 'oil spot', out.oil.spot, 'steo rows', out.oil.steo.length);
console.log('refs', JSON.stringify(out.refs));
console.log('sources', out.sources.map(s => `${s.ok ? 'OK ' : 'ERR'} ${s.name} ${s.asOf || ''} ${s.error || ''}`).join('\n'));
if (process.argv.includes('--dump')) writeFileSync(new URL('./fixture-payload.json', import.meta.url), JSON.stringify(out));
