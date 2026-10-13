// GET /api/backtest — real-time track record of the model.
// Every forecast origin is rebuilt from the CPI data exactly as published on that CPI
// release date (ALFRED vintages), with dials set by the same data rule the page uses.
// Cached for a day: the result only changes when a new CPI print arrives.
import * as S from '../lib/sources.js';
import { buildPanel, oilMonthly } from '../lib/derive.js';
import { simulate, dataDefaults, addM, quantile, NF } from '../public/model.js';

const CPI_IDS = ['CPIAUCSL', 'CPIAUCNS', 'CPIUFDSL', 'CUSR0000SACE', 'CUSR0000SEHF', 'CUSR0000SACL1E', 'CUSR0000SAH1'];
const FIRST_ORIGIN = '2016-06';
const PANDEMIC = ['2020-03', '2022-12']; // origins excluded in the "ex-pandemic" sample
const HORIZONS = Array.from({ length: NF }, (_, i) => i + 1);

const yoyOf = (map, m) => {
  const a = map.get(m), b = map.get(addM(m, -12));
  return a != null && b != null ? (a / b - 1) * 100 : null;
};

export async function runBacktest(now = new Date()) {
  const thisYear = now.getUTCFullYear();
  const riYears = []; for (let y = 2015; y <= thisYear - 1; y++) riYears.push(y);
  const [vint, oilDaily, zori, nowcast, spf, ...ri] = await Promise.all([
    Promise.all(CPI_IDS.map(id => S.alfred(id))),
    S.fred('DCOILWTICO', '2011-01-01'),
    S.zori().catch(() => null),
    S.nowcast().catch(() => null),
    S.spf().catch(() => null),
    ...riYears.map(y => S.relativeImportanceYear(y).catch(() => null)),
  ]);
  const V = Object.fromEntries(CPI_IDS.map((id, i) => [id, vint[i]]));
  const weightsByYear = {}; ri.forEach(r => { if (r) weightsByYear[r.year] = r; });
  weightsByYear[S.RI_FALLBACK.year] ||= { ...S.RI_FALLBACK };
  const riFor = isoDate => {
    // The December Y table is published in mid-February of Y+1.
    const y = +isoDate.slice(0, 4), afterFeb = isoDate.slice(5) >= '02-15';
    const want = afterFeb ? y - 1 : y - 2;
    const yrs = Object.keys(weightsByYear).map(Number).sort((a, b) => a - b);
    const ok = yrs.filter(v => v <= want);
    return weightsByYear[ok.length ? ok[ok.length - 1] : yrs[0]];
  };

  // Release date of each month's CPI = first time it appears in ALFRED.
  const release = new Map();
  for (const [d, rs] of V.CPIAUCSL) { const m = d.slice(0, 7); if (!release.has(m) || rs < release.get(m)) release.set(m, rs); }
  // Realized official YoY: NSA headline, latest vintage (NSA is not revised).
  const nsaLatest = new Map(S.asOf(V.CPIAUCNS, '9999-12-30').filter(o => o[1] != null).map(([d, v]) => [d.slice(0, 7), v]));
  const lastActual = [...nsaLatest.keys()].sort().pop();

  const ncMom = new Map((nowcast?.mom || []).map(b => [b.month, b]));
  const ncYoy = new Map((nowcast?.yoy || []).map(b => [b.month, b]));
  const spfAt = isoDate => {
    if (!spf?.history) return null;
    let best = null;
    for (const r of spf.history) { const rel = `${r.year}-${String(3 * (r.quarter - 1) + 2).padStart(2, '0')}-15`; if (rel <= isoDate) best = r; }
    return best;
  };
  const zoriAt = month => {
    if (!zori?.full) return null;
    const idx = new Map(zori.full);
    const a = idx.get(month), b = idx.get(addM(month, -12));
    return a != null && b != null ? (a / b - 1) * 100 : null;
  };

  const origins = [...release.keys()].filter(m => m >= FIRST_ORIGIN && m < lastActual).sort();
  const records = [];
  for (const L of origins) {
    const d = release.get(L);
    let panel;
    try {
      const series = Object.fromEntries(CPI_IDS.map(id => [id, S.asOf(V[id], d)]));
      panel = buildPanel({ series, ri: riFor(d) });
    } catch { continue; }
    if (panel.last !== L) continue;
    const oilObs = oilDaily.filter(o => o[0] <= d);
    const oil = oilMonthly(oilObs);
    const P = dataDefaults(panel, { rentYoY: zoriAt(addM(L, -1)), oilTarget: oil.spot.value });
    const oilOpts = { asOfMonth: d.slice(0, 7), monthly: oil.monthly, spot: oil.spot.value };
    const anchor = {};
    for (const f of [1, 2]) { const m = addM(L, f), v = S.nowcastAsOf(ncMom.get(m), d); if (v != null) anchor[m] = v; }
    const base = simulate(panel, P, { oil: oilOpts });
    const nc = simulate(panel, P, { oil: oilOpts, anchor });
    const n = base.n, now0 = base.yoy(n);
    const sp = spfAt(d);
    const fc = {};
    for (const h of HORIZONS) {
      const target = addM(L, h), actual = yoyOf(nsaLatest, target);
      if (actual == null) continue;
      const ncY = h <= 2 ? S.nowcastAsOf(ncYoy.get(target), d) : null;
      fc[h] = {
        target, actual,
        model: base.yoy(n + h), modelNC: nc.yoy(n + h), naive: now0,
        nowcast: ncY, spf: h === 12 && sp ? sp.fourQ : null,
      };
    }
    records.push({ origin: L, released: d, anchored: Object.keys(anchor).length, fc });
  }
  if (!records.length) throw new Error('No backtest origins could be built');

  const VARS = ['model', 'modelNC', 'naive', 'nowcast', 'spf'];
  const inPandemic = o => o >= PANDEMIC[0] && o <= PANDEMIC[1];
  const recentFrom = addM(records[records.length - 1].origin, -36);
  const SAMPLES = { all: () => true, exPandemic: r => !inPandemic(r.origin), last3y: r => r.origin > recentFrom };
  const stats = {};
  for (const [sname, keep] of Object.entries(SAMPLES)) {
    stats[sname] = {};
    for (const h of HORIZONS) {
      stats[sname][h] = {};
      for (const v of VARS) {
        const e = records.filter(keep).map(r => r.fc[h]).filter(x => x && x[v] != null).map(x => x.actual - x[v]);
        if (!e.length) continue;
        const rmse = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length);
        const mae = e.reduce((s, x) => s + Math.abs(x), 0) / e.length;
        const bias = e.reduce((s, x) => s + x, 0) / e.length;
        const r = x => +x.toFixed(3);
        stats[sname][h][v] = { n: e.length, rmse: r(rmse), mae: r(mae), bias: r(bias), q10: r(quantile(e, 0.1)), q90: r(quantile(e, 0.9)) };
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    firstOrigin: records[0].origin, lastOrigin: records[records.length - 1].origin, origins: records.length,
    pandemic: PANDEMIC, recentFrom,
    stats,
    path12: records.filter(r => r.fc[12]).map(r => ({ origin: r.origin, target: r.fc[12].target, ...Object.fromEntries(['actual', 'model', 'modelNC', 'naive', 'spf'].map(k => [k, r.fc[12][k] == null ? null : +r.fc[12][k].toFixed(3)])) })),
    notes: {
      oil: 'Oil dial held flat at the spot price on each release date (EIA forecast vintages are not available).',
      rent: zori ? 'Zillow rent index uses today\'s history (Zillow does not publish vintages), lagged one month.' : 'Zillow unavailable; shelter defaulted to its own 12-month pace.',
      nowcast: nowcast ? 'Cleveland Fed nowcast taken as it stood on each release date.' : 'Cleveland Fed nowcast unavailable; anchored variant equals the plain model.',
      spf: spf ? 'SPF: latest survey released before each date; its next-4-quarters CPI forecast is compared with the 12-month rate a year later.' : 'SPF unavailable.',
      weights: `BLS relative importance tables used: ${Object.keys(weightsByYear).sort().join(', ')}.`,
    },
  };
}

export default async function handler(req, res) {
  try {
    const body = await runBacktest();
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=172800');
    res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
}
