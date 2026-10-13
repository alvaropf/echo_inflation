// GET /api/data — every input the page needs, fetched live from official sources.
// Cached at Vercel's edge for 1 hour (stale copy served up to a day while refreshing).
import * as S from '../lib/sources.js';
import { buildPanel, oilMonthly, latest } from '../lib/derive.js';

const CPI_SERIES = {
  CPIAUCSL: 'CPI All items (SA)', CPIAUCNS: 'CPI All items (NSA, official YoY)', CPIUFDSL: 'CPI Food',
  CUSR0000SACE: 'CPI Energy commodities', CUSR0000SEHF: 'CPI Energy services',
  CUSR0000SACL1E: 'CPI Core goods', CUSR0000SAH1: 'CPI Shelter',
};
const MARKET_SERIES = {
  DCOILWTICO: 'WTI crude oil, daily', EXPINF1YR: 'Cleveland Fed 1-year expected inflation',
  T5YIE: '5-year breakeven inflation', T5YIFR: '5y5y forward inflation expectation',
  MICH: 'U. Michigan 1-year inflation expectations', PCECTPIMD: 'FOMC projections, PCE inflation (median)',
};

async function attempt(name, url, fn) {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { name, url, ok: true, ms: Date.now() - t0, data };
  } catch (e) {
    return { name, url, ok: false, ms: Date.now() - t0, error: String(e.message || e) };
  }
}

export async function collect(now = new Date()) {
  const cpiJobs = Object.entries(CPI_SERIES).map(([id, nm]) => attempt(nm, S.FRED_URL(id), () => S.fred(id, '2018-01-01')).then(r => ({ id, ...r })));
  const mktJobs = Object.entries(MARKET_SERIES).map(([id, nm]) => {
    const start = id === 'DCOILWTICO' ? addDays(now, -900) : id === 'PCECTPIMD' ? '2024-01-01' : '2021-01-01';
    return attempt(nm, S.FRED_URL(id), () => S.fred(id, start)).then(r => ({ id, ...r }));
  });
  const [cpi, mkt, ri, zori, steo, nowcast, spf] = await Promise.all([
    Promise.all(cpiJobs), Promise.all(mktJobs),
    attempt('BLS relative importance (weights)', S.RI_URL(now.getUTCFullYear() - 1), () => S.relativeImportance(now)),
    attempt('Zillow Observed Rent Index (new leases)', S.ZORI_URL, S.zori),
    attempt('EIA STEO WTI forecast', S.STEO_PAGE, S.steoWti),
    attempt('Cleveland Fed inflation nowcast', S.NOWCAST_PAGE, S.nowcast),
    attempt('Philadelphia Fed SPF (median CPI)', S.SPF_PAGE, S.spf),
  ]);

  const failedCpi = cpi.filter(r => !r.ok);
  if (failedCpi.length) {
    const err = new Error('Core CPI data unavailable: ' + failedCpi.map(r => `${r.id} (${r.error})`).join('; '));
    err.sources = summarize([...cpi, ...mkt, ri, zori, steo, nowcast, spf]);
    throw err;
  }
  const series = Object.fromEntries(cpi.map(r => [r.id, r.data]));
  const weights = ri.data; // relativeImportance() always returns data (live or embedded fallback)
  const panel = buildPanel({ series, ri: weights });
  const M = Object.fromEntries(mkt.map(r => [r.id, r]));

  const oil = M.DCOILWTICO.ok ? oilMonthly(M.DCOILWTICO.data) : null;
  const pce = M.PCECTPIMD.ok ? M.PCECTPIMD.data.filter(o => o[1] !== null).map(([d, v]) => ({ year: +d.slice(0, 4), value: v })) : null;

  return {
    generatedAt: now.toISOString(),
    panel,
    weights: { year: weights.year, fallback: !!weights.fallback, url: weights.url, raw: weights, warning: weights.warning || null },
    oil: oil && { ...oil, steo: steo.ok ? steo.data : null },
    rent: zori.ok ? zori.data : null,
    refs: {
      expinf1y: M.EXPINF1YR.ok ? latest(M.EXPINF1YR.data) : null,
      be5y: M.T5YIE.ok ? latest(M.T5YIE.data) : null,
      fwd5y5y: M.T5YIFR.ok ? latest(M.T5YIFR.data) : null,
      mich1y: M.MICH.ok ? latest(M.MICH.data) : null,
      fomcPce: pce,
      spf: spf.ok ? spf.data : null,
      nowcast: nowcast.ok ? nowcast.data : null,
    },
    sources: summarize([...cpi, ...mkt, ri, zori, steo, nowcast, spf]),
  };
}

function summarize(list) {
  return list.map(r => {
    let asOf = null;
    const d = r.data;
    if (r.id === 'PCECTPIMD' && Array.isArray(d)) asOf = 'latest SEP, projections ' + d.filter(o => o[1] !== null).map(o => o[0].slice(0, 4)).join(', ');
    else if (Array.isArray(d) && d.length) { const v = d.filter(o => o[1] !== null); asOf = v.length ? v[v.length - 1][0] : null; }
    else if (d?.month) asOf = d.month;
    else if (d?.survey) asOf = 'survey ' + d.survey;
    else if (d?.year) asOf = `Dec ${d.year} weights${d.fallback ? ' (embedded copy)' : ''}`;
    else if (d?.yoy || d?.mom) asOf = (d.yoy || d.mom)[0]?.updated || 'latest';
    return { name: r.name, id: r.id || null, url: r.url, ok: r.ok, asOf, error: r.error || (d?.warning ? 'live fetch failed, using embedded copy: ' + d.warning : null) };
  });
}

function addDays(d, k) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    const body = await collect();
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e), sources: e.sources || null });
  }
}
