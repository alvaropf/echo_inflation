// The forecast engine. Shared by the page (browser) and the backtest (server),
// so the track record measures exactly the code users see.
export const COMPS = ['shelter', 'sxs', 'goods', 'food', 'ecom', 'eserv'];
export const NF = 12;

export const a2m = a => (Math.pow(1 + a / 100, 1 / 12) - 1) * 100;
export const addM = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + mo - 1 + k;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
};
export const monthsBetween = (a, b) => {
  const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};

// Monthly average oil for each forecast month: actual averages for months already
// observed, today's spot for the current month, then a smooth move to the 12-month target.
export function oilPath({ last, asOfMonth, monthly = {}, spot, target }) {
  spot = spot ?? target;
  const out = [monthly[last] ?? spot];
  const kNow = Math.max(0, monthsBetween(last, asOfMonth));
  for (let f = 1; f <= NF; f++) {
    const m = addM(last, f);
    if (f < kNow && monthly[m] != null) out.push(monthly[m]);
    else if (f <= kNow) out.push(spot);
    else out.push(spot * Math.pow(target / spot, Math.min(f - kNow, 12) / 12));
  }
  return out;
}

// Default dial settings from data alone. The backtest uses this same rule.
export function dataDefaults(panel, { rentYoY, oilTarget }) {
  const t = panel.trailing;
  return {
    oil: oilTarget, rent: rentYoY ?? t.shelter12, sxs: t.sxs6, goods: t.goods6,
    food: t.food12, eserv: t.eserv12, hl: 12, beta: 0.5,
  };
}

// P: dials. opts.oil: oilPath inputs. opts.anchor: {YYYY-MM: headline SA m/m %} — forecast
// months whose headline change is pinned to the Cleveland Fed nowcast (the gap is spread
// evenly across components so the parts still add up). opts.mode 'trend' holds last year's pace.
export function simulate(panel, P, opts = {}) {
  const p = panel, n = p.months.length - 1;
  const lv = {}; COMPS.forEach(c => (lv[c] = p.levels[c].slice()));
  const H = p.levels.headline.slice(), N = p.nsa.slice();
  const w = { ...p.weights };
  const oil = oilPath({ last: p.last, target: P.oil, ...(opts.oil || {}) });
  const curSh = a2m(p.trailing.shelter3), termSh = a2m(P.rent), k = Math.log(2) / P.hl;
  const trendM = a2m(p.trailing.headline12);
  const months = p.months.slice();
  const anchored = [];
  for (let f = 1; f <= NF; f++) {
    const m = addM(p.last, f); months.push(m);
    let mm;
    if (opts.mode === 'trend') mm = Object.fromEntries(COMPS.map(c => [c, trendM]));
    else mm = {
      shelter: termSh + (curSh - termSh) * Math.exp(-k * f),
      sxs: a2m(P.sxs), goods: a2m(P.goods), food: a2m(P.food), eserv: a2m(P.eserv),
      ecom: P.beta * ((oil[f] / oil[f - 1] - 1) * 100),
    };
    let mH = COMPS.reduce((s, c) => s + w[c] * mm[c], 0);
    const a = opts.mode !== 'trend' && opts.anchor ? opts.anchor[m] : null;
    if (a != null && Number.isFinite(a)) {
      const delta = a - mH;
      COMPS.forEach(c => (mm[c] += delta));
      mH = a; anchored.push(m);
    }
    COMPS.forEach(c => { lv[c].push(lv[c][lv[c].length - 1] * (1 + mm[c] / 100)); w[c] = (w[c] * (1 + mm[c] / 100)) / (1 + mH / 100); });
    H.push(H[H.length - 1] * (1 + mH / 100));
    N.push(H[H.length - 1] * p.seasonal[m.slice(5)]);
  }
  const yoy = t => (N[t] / N[t - 12] - 1) * 100;
  return { months, lv, H, N, yoy, oil, n, anchored };
}

// Empirical quantile (linear interpolation)
export function quantile(arr, q) {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
