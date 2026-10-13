// Turns raw series into the monthly panel the page simulates forward.
// Components (they partition All items, matching BLS relative-importance rows):
//   food, ecom (energy commodities), eserv (energy services), goods (core goods),
//   shelter, sxs (services less energy services less shelter = "supercore", derived)

export const COMPS = ['shelter', 'sxs', 'goods', 'food', 'ecom', 'eserv'];
const KNOWN = ['shelter', 'goods', 'food', 'ecom', 'eserv'];

const ym = d => d.slice(0, 7);
const addMonths = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

// Monthly series -> {YYYY-MM: value} with internal gaps filled geometrically.
function toMonthly(obs) {
  const map = {};
  for (const [d, v] of obs) if (v !== null) map[ym(d)] = v;
  return map;
}

function fillGaps(map, months) {
  const filled = [];
  const out = {};
  months.forEach((m, i) => {
    if (map[m] != null) { out[m] = map[m]; return; }
    let a = i - 1, b = i + 1;
    while (a >= 0 && map[months[a]] == null) a--;
    while (b < months.length && map[months[b]] == null) b++;
    if (a < 0 || b >= months.length) { out[m] = null; return; }
    const va = map[months[a]], vb = map[months[b]];
    out[m] = va * Math.pow(vb / va, (i - a) / (b - a));
    filled.push(m);
  });
  return { out, filled };
}

const annualize = monthlyPct => (Math.pow(1 + monthlyPct / 100, 12) - 1) * 100;
const avgPace = arr => annualize((Math.pow(arr.reduce((a, v) => a * (1 + v / 100), 1), 1 / arr.length) - 1) * 100);

export function buildPanel({ series, ri, nMonths = 48 }) {
  const sa = {
    headline: toMonthly(series.CPIAUCSL), food: toMonthly(series.CPIUFDSL), ecom: toMonthly(series.CUSR0000SACE),
    eserv: toMonthly(series.CUSR0000SEHF), goods: toMonthly(series.CUSR0000SACL1E), shelter: toMonthly(series.CUSR0000SAH1),
  };
  const nsa = toMonthly(series.CPIAUCNS);

  // Last month where headline and every component have a print.
  const all = Object.keys(sa.headline).sort();
  let last = all[all.length - 1];
  while (last && !(KNOWN.every(c => sa[c][last] != null) && nsa[last] != null)) last = addMonths(last, -1);
  if (!last) throw new Error('No month with a complete CPI print');
  const months = [];
  for (let k = nMonths; k >= 0; k--) months.push(addMonths(last, -k));

  const gaps = new Set();
  const L = {};
  for (const c of ['headline', ...KNOWN]) {
    const { out, filled } = fillGaps(sa[c], months);
    filled.forEach(m => gaps.add(m));
    if (months.some(m => out[m] == null)) throw new Error(`Series ${c} incomplete in the window`);
    L[c] = months.map(m => out[m]);
  }
  const nsaF = fillGaps(nsa, months); nsaF.filled.forEach(m => gaps.add(m));
  const NSA = months.map(m => nsaF.out[m]);

  // Monthly % changes for t = 1..n
  const mom = {};
  for (const c of ['headline', ...KNOWN]) mom[c] = L[c].map((v, t) => (t ? (v / L[c][t - 1] - 1) * 100 : null));

  // Shares at the December the BLS weights refer to, then roll forward/back by relative price change.
  const decM = `${ri.year}-12`;
  let d0 = months.indexOf(decM);
  const base = { food: ri.food, ecom: ri.ecom, eserv: ri.eserv, goods: ri.goods, shelter: ri.shelter, sxs: ri.sle - ri.shelter };
  const tot = Object.values(base).reduce((a, b) => a + b, 0);
  const W = months.map(() => ({}));
  if (d0 < 0) d0 = 0; // weights older than the window: anchor at the window start (approximation)
  COMPS.forEach(c => (W[d0][c] = base[c] / tot));
  const momRes = Array(months.length).fill(null);

  // forward from d0
  for (let t = d0 + 1; t < months.length; t++) {
    const w = W[t - 1], mH = mom.headline[t];
    const known = KNOWN.reduce((s, c) => s + w[c] * mom[c][t], 0);
    momRes[t] = (mH - known) / w.sxs;
    const all = { ...Object.fromEntries(KNOWN.map(c => [c, mom[c][t]])), sxs: momRes[t] };
    COMPS.forEach(c => (W[t][c] = (w[c] * (1 + all[c] / 100)) / (1 + mH / 100)));
  }
  // backward from d0
  for (let t = d0; t >= 1; t--) {
    const w = W[t], mH = mom.headline[t];
    KNOWN.forEach(c => (W[t - 1][c] = (w[c] * (1 + mH / 100)) / (1 + mom[c][t] / 100)));
    W[t - 1].sxs = 1 - KNOWN.reduce((s, c) => s + W[t - 1][c], 0);
    momRes[t] = (mH - KNOWN.reduce((s, c) => s + W[t - 1][c] * mom[c][t], 0)) / W[t - 1].sxs;
  }
  mom.sxs = momRes;
  const lvl = { ...L };
  lvl.sxs = momRes.map(() => 100);
  for (let t = 1; t < months.length; t++) lvl.sxs[t] = lvl.sxs[t - 1] * (1 + momRes[t] / 100);

  // Seasonal factor (NSA / SA) by calendar month, from the latest year in the window.
  const sf = {};
  months.forEach((m, t) => (sf[m.slice(5)] = NSA[t] / L.headline[t]));

  const n = months.length - 1;
  const trail = (c, k) => avgPace(mom[c].slice(n - k + 1));
  const shelterRecent = mom.shelter.slice(n - 2);

  return {
    months, last, gaps: [...gaps].sort(),
    levels: Object.fromEntries(['headline', ...COMPS].map(c => [c, lvl[c].map(v => +v.toFixed(4))])),
    nsa: NSA.map(v => +v.toFixed(4)),
    mom: Object.fromEntries(['headline', ...COMPS].map(c => [c, mom[c].map(v => (v == null ? null : +v.toFixed(4)))])),
    weights: Object.fromEntries(COMPS.map(c => [c, +W[n][c].toFixed(5)])),
    weightsAt: W.map(w => Object.fromEntries(COMPS.map(c => [c, +w[c].toFixed(5)]))),
    seasonal: sf,
    trailing: {
      sxs6: trail('sxs', 6), sxs12: trail('sxs', 12), goods6: trail('goods', 6), goods12: trail('goods', 12),
      food12: trail('food', 12), eserv12: trail('eserv', 12), shelter3: avgPace(shelterRecent), shelter12: trail('shelter', 12),
      headline3: trail('headline', 3), headline12: trail('headline', 12),
    },
  };
}

// Daily WTI -> monthly averages, plus latest spot.
export function oilMonthly(obs) {
  const acc = {};
  for (const [d, v] of obs) if (v !== null && v > 0) { const m = ym(d); (acc[m] ||= []).push(v); }
  const months = Object.keys(acc).sort();
  const valid = obs.filter(o => o[1] !== null && o[1] > 0);
  const spot = valid[valid.length - 1];
  return {
    monthly: Object.fromEntries(months.map(m => [m, +(acc[m].reduce((a, b) => a + b, 0) / acc[m].length).toFixed(2)])),
    spot: { date: spot[0], value: spot[1] },
  };
}

export const latest = obs => {
  const v = obs.filter(o => o[1] !== null);
  const l = v[v.length - 1];
  return l ? { date: l[0], value: l[1] } : null;
};
export { addMonths };
