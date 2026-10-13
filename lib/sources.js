// Fetchers + parsers for every external source. Each returns plain data or throws;
// the API handler wraps each call so one failing source never breaks the page.
import * as XLSX from 'xlsx';

const UA = `ECHO-inflation-model/2.0 (${process.env.CONTACT_EMAIL || 'contact: set CONTACT_EMAIL env var'})`;
const TIMEOUT_MS = 15000;

async function get(url, as = 'text') {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
    if (as === 'json') return await r.json();
    if (as === 'buffer') return new Uint8Array(await r.arrayBuffer());
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- FRED (St. Louis Fed) ---------------- */
// With FRED_API_KEY: official JSON API. Without: the public fredgraph CSV (no key needed).
export const FRED_URL = id => `https://fred.stlouisfed.org/series/${id}`;

export async function fred(id, start = '2015-01-01') {
  const key = process.env.FRED_API_KEY;
  let obs;
  if (key) {
    const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${start}`;
    const j = await get(u, 'json');
    obs = j.observations.map(o => [o.date, o.value === '.' || o.value === '' ? null : +o.value]);
  } else {
    const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`);
    obs = csv.trim().split(/\r?\n/).slice(1).map(l => {
      const [d, v] = l.split(',');
      return [d, v === '.' || v === '' || v === undefined ? null : +v];
    });
  }
  obs = obs.filter(([d, v]) => d && (v === null || Number.isFinite(v)));
  if (!obs.some(o => o[1] !== null)) throw new Error(`FRED ${id}: no data`);
  return obs;
}

// ALFRED: every published vintage of a series. Needs FRED_API_KEY.
// Returns rows [obsDate, realtimeStart, realtimeEnd, value].
export async function alfred(id, observationStart = '2011-01-01') {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY is required for the backtest (ALFRED vintages)');
  const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${observationStart}&realtime_start=2012-01-01&realtime_end=9999-12-31&output_type=1&limit=100000`;
  const j = await get(u, 'json');
  return j.observations.map(o => [o.date, o.realtime_start, o.realtime_end, o.value === '.' || o.value === '' ? null : +o.value]);
}

// Series as it looked on isoDate: [[obsDate, value]].
export function asOf(rows, isoDate) {
  const out = new Map();
  for (const [d, rs, re, v] of rows) if (rs <= isoDate && isoDate <= re) out.set(d, v);
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/* ---------------- BLS relative importance (weights) ---------------- */
// December relative importance, published each February at a stable URL per year.
const RI_ITEMS = {
  food: 'Food',
  ecom: 'Energy commodities',
  eserv: 'Energy services',
  goods: 'Commodities less food and energy commodities',
  sle: 'Services less energy services',
  shelter: 'Shelter',
};
// Exact copy of the BLS December 2025 table (CPI-U), used only if bls.gov is unreachable.
export const RI_FALLBACK = {
  year: 2025, food: 13.698, ecom: 3.12, eserv: 3.262, goods: 19.176, sle: 60.744, shelter: 35.625,
};
export const RI_URL = y => `https://www.bls.gov/cpi/tables/relative-importance/${y}.htm`;

export function parseRelativeImportance(html) {
  const text = html
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = {};
  for (const [k, label] of Object.entries(RI_ITEMS)) {
    const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*\\(\\d+\\))?\\s+(\\d+\\.\\d+)', 'i');
    const line = lines.find(l => re.test(l));
    if (!line) throw new Error(`relative importance: row "${label}" not found`);
    out[k] = +line.match(re)[2];
  }
  const sum = out.food + out.ecom + out.eserv + out.goods + out.sle;
  if (Math.abs(sum - 100) > 0.5) throw new Error(`relative importance rows sum to ${sum.toFixed(2)}, expected 100`);
  return out;
}

export async function relativeImportanceYear(y) {
  return { year: y, ...parseRelativeImportance(await get(RI_URL(y))), url: RI_URL(y), fallback: false };
}

export async function relativeImportance(now = new Date()) {
  const errs = [];
  for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear() - 2]) {
    try {
      const w = parseRelativeImportance(await get(RI_URL(y)));
      return { year: y, ...w, url: RI_URL(y), fallback: false };
    } catch (e) { errs.push(`${y}: ${e.message}`); }
  }
  return { ...RI_FALLBACK, url: RI_URL(RI_FALLBACK.year), fallback: true, warning: errs.join('; ') };
}

/* ---------------- Zillow Observed Rent Index (new-lease rents) ---------------- */
export const ZORI_URL = 'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv';

export function parseZori(csv) {
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',');
  const us = lines.find(l => /,"?United States"?,/.test(l));
  if (!us) throw new Error('ZORI: United States row not found');
  const cells = us.split(',');
  const series = [];
  head.forEach((h, i) => { if (/^\d{4}-\d{2}-\d{2}$/.test(h) && cells[i] !== '') series.push([h.slice(0, 7), +cells[i]]); });
  if (series.length < 13) throw new Error('ZORI: series too short');
  const last = series[series.length - 1], prev = series[series.length - 13];
  return { month: last[0], level: last[1], yoy: (last[1] / prev[1] - 1) * 100, series: series.slice(-37), full: series };
}

export const zori = async () => parseZori(await get(ZORI_URL));

/* ---------------- EIA Short-Term Energy Outlook (WTI forecast) ---------------- */
export const STEO_PAGE = 'https://www.eia.gov/outlooks/steo/';

export async function steoWti() {
  const key = process.env.EIA_API_KEY;
  if (!key) throw new Error('EIA_API_KEY not set (oil dial will default to today\'s spot price)');
  const y = new Date().getUTCFullYear();
  const u = `https://api.eia.gov/v2/steo/data/?api_key=${key}&frequency=monthly&data[0]=value&facets[seriesId][]=WTIPUUS&start=${y - 1}-01&sort[0][column]=period&sort[0][direction]=asc&length=60`;
  const j = await get(u, 'json');
  const rows = (j.response?.data || []).map(d => [d.period, +d.value]).filter(r => Number.isFinite(r[1]));
  if (!rows.length) throw new Error('EIA STEO: no WTI rows');
  return rows;
}

/* ---------------- Cleveland Fed inflation nowcast ---------------- */
// The nowcasting page charts read these JSON files. The format is undocumented, so the
// parser is defensive and keeps the file's own labels.
export const NOWCAST_PAGE = 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting';
const NOWCAST_FILES = {
  month: 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_month.json',
  year: 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function labelToMonth(s) {
  if (!s) return null;
  let m = String(s).match(/(\d{4})[:\-\/ ](\d{1,2})\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = String(s).toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})/);
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
  return null;
}

// Chart labels are "MM/DD" with no year: pick the year that puts the date nearest the target month.
function mdToDate(md, month) {
  const m = String(md || '').match(/^(\d{1,2})\/(\d{1,2})/);
  if (!m || !month) return null;
  const [ty, tm] = month.split('-').map(Number);
  let best = null, bestGap = Infinity;
  for (const y of [ty - 1, ty, ty + 1]) {
    const gap = Math.abs((y * 12 + +m[1]) - (ty * 12 + tm));
    if (gap < bestGap) { bestGap = gap; best = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  }
  return best;
}

// Value of a nowcast block as it stood on a given date (latest daily value on or before it).
export function nowcastAsOf(block, isoDate) {
  if (!block?.daily) return null;
  let v = null;
  block.daily.dates.forEach((d, i) => { if (d && d <= isoDate && Number.isFinite(block.daily.values[i])) v = block.daily.values[i]; });
  return v;
}

export function parseNowcast(json) {
  const blocks = Array.isArray(json) ? json : [json];
  const out = [];
  for (const b of blocks) {
    const chart = b.chart || {};
    const label = [chart.caption, chart.subcaption, chart.title, b.title].filter(Boolean).join(' · ');
    const ds = (b.dataset || []).find(d => /^\s*CPI( Inflation)?\s*$/i.test(d.seriesname || '')) ||
      (b.dataset || []).find(d => /\bCPI\b/i.test(d.seriesname || '') && !/core|pce|actual/i.test(d.seriesname || ''));
    if (!ds || !Array.isArray(ds.data)) continue;
    const vals = ds.data.map(d => (d && d.value !== '' && d.value != null ? +d.value : null));
    let idx = -1; vals.forEach((v, i) => { if (Number.isFinite(v)) idx = i; });
    if (idx < 0) continue;
    const cats = b.categories?.[0]?.category || [];
    const month = labelToMonth(label);
    out.push({ label, month, value: vals[idx], updated: cats[idx]?.label || null,
      daily: { dates: cats.map(c => mdToDate(c?.label, month)), values: vals } });
  }
  if (!out.length) throw new Error('nowcast: no CPI series found in file (format may have changed)');
  return out;
}

export async function nowcast() {
  const [m, y] = await Promise.allSettled([get(NOWCAST_FILES.month, 'json'), get(NOWCAST_FILES.year, 'json')]);
  const res = {};
  if (m.status === 'fulfilled') { try { res.mom = parseNowcast(m.value); } catch (e) { res.momError = e.message; } }
  if (y.status === 'fulfilled') { try { res.yoy = parseNowcast(y.value); } catch (e) { res.yoyError = e.message; } }
  if (!res.mom && !res.yoy) throw new Error(res.momError || res.yoyError || (m.reason?.message ?? 'nowcast unreachable'));
  return res;
}

/* ---------------- Philadelphia Fed Survey of Professional Forecasters ---------------- */
export const SPF_URL = 'https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/data-files/files/Median_CPI_Level.xlsx';
export const SPF_PAGE = 'https://www.philadelphiafed.org/surveys-and-data/cpi-spf';

export function parseSpf(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const hi = rows.findIndex(r => r && r.some(c => String(c).toUpperCase() === 'CPI3'));
  if (hi < 0) throw new Error('SPF: header with CPI3 not found');
  const H = rows[hi].map(c => String(c).toUpperCase());
  const col = n => H.indexOf(n);
  const data = rows.slice(hi + 1).filter(r => r && Number.isFinite(+r[col('CPI3')]) && r[col('CPI3')] !== '' && r[col('CPI3')] != null);
  const last = data[data.length - 1];
  const q = ['CPI3', 'CPI4', 'CPI5', 'CPI6'].map(n => +last[col(n)]);
  if (q.some(v => !Number.isFinite(v))) throw new Error('SPF: missing CPI3..CPI6 in latest survey');
  // CPI3..CPI6 = next four quarters, q/q annualized. Compound into a 4-quarter rate.
  const fourQ = (q.reduce((a, v) => a * Math.pow(1 + v / 100, 0.25), 1) - 1) * 100;
  const four = r => { const v = ['CPI3', 'CPI4', 'CPI5', 'CPI6'].map(n => +r[col(n)]); return v.every(Number.isFinite) ? (v.reduce((a, x) => a * Math.pow(1 + x / 100, 0.25), 1) - 1) * 100 : null; };
  const history = data.map(r => ({ year: +r[col('YEAR')], quarter: +r[col('QUARTER')], fourQ: four(r) })).filter(r => r.fourQ != null);
  return { survey: `${last[col('YEAR')]}:Q${last[col('QUARTER')]}`, quarters: q, fourQ, history };
}

export const spf = async () => parseSpf(await get(SPF_URL, 'buffer'));
