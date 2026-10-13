import { COMPS, NF, a2m, addM, simulate, dataDefaults } from './model.js';

const NAMES = { shelter: 'Shelter', sxs: 'Services ex-energy, ex-shelter', goods: 'Core goods', food: 'Food', ecom: 'Energy goods (gasoline etc.)', eserv: 'Energy services (electricity, gas)' };
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const lab = m => MN[+m.slice(5) - 1] + '-' + m.slice(2, 4);
const long = m => MN[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
const pct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + '%');
const pts = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
const fmtDate = d => { if (!d) return ''; const x = new Date(d + (d.length === 10 ? 'T00:00:00Z' : '')); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nowMonth = () => new Date().toISOString().slice(0, 7);

let D, BT = null, BTerr = null, P0, oilSrc = '', anchorTouched = false;
const charts = {};

/* ---------- inputs ---------- */
const readP = () => ({ oil: +$('sOil').value, rent: +$('sRent').value, sxs: +$('sSxs').value, goods: +$('sGoods').value, food: +$('sFood').value, eserv: +$('sEserv').value, hl: +$('sHl').value, beta: +$('sBeta').value });
const setP = P => { $('sOil').value = P.oil; $('sRent').value = P.rent; $('sSxs').value = P.sxs; $('sGoods').value = P.goods; $('sFood').value = P.food; $('sEserv').value = P.eserv; $('sHl').value = P.hl; $('sBeta').value = P.beta; };

function anchorMap() {
  const out = {};
  (D.refs.nowcast?.mom || []).forEach(r => { if (r.month && Number.isFinite(r.value)) out[r.month] = r.value; });
  return out;
}
const oilOpts = () => ({ asOfMonth: nowMonth(), monthly: D.oil?.monthly || {}, spot: D.oil?.spot?.value });
const variant = () => ($('anchorT').checked && Object.keys(anchorMap()).length ? 'modelNC' : 'model');
const stat = (h, v = variant()) => BT?.stats?.[$('sampleS').value]?.[h]?.[v] || null;

/* ---------- main render ---------- */
function refresh() {
  const P = readP(), p = D.panel;
  $('oOil').textContent = '$' + P.oil; $('oRent').textContent = P.rent.toFixed(1) + '%'; $('oSxs').textContent = P.sxs.toFixed(1) + '%';
  $('oGoods').textContent = P.goods.toFixed(1) + '%'; $('oFood').textContent = P.food.toFixed(1) + '%'; $('oEserv').textContent = P.eserv.toFixed(1) + '%';
  $('oHl').textContent = P.hl + ' mo'; $('oBeta').textContent = P.beta.toFixed(2);

  const anchor = variant() === 'modelNC' ? anchorMap() : null;
  const B = simulate(p, P, { oil: oilOpts(), anchor });
  const T = simulate(p, P, { mode: 'trend', oil: oilOpts() });
  const n = B.n, E = n + NF, endM = B.months[E];
  const now = B.yoy(n), end = B.yoy(E);

  // Error band from the real track record
  const band = t => { const h = t - n, s = h >= 1 ? stat(h) : null; return s ? [B.yoy(t) + s.q10, B.yoy(t) + s.q90] : null; };
  const bE = band(E), s12 = stat(12);
  $('chipNow').textContent = pct(now); $('chipNowL').textContent = 'CPI inflation, ' + long(p.last);
  $('chipMed').textContent = pct(end); $('chipMedL').textContent = 'model, ' + long(endM);
  $('chipRange').textContent = bE ? `${bE[0].toFixed(1)}–${bE[1].toFixed(1)}%` : BTerr ? 'n/a' : '…';
  $('chipDir').textContent = !bE ? (BTerr ? 'n/a' : '…') : bE[0] > now ? 'Higher ↑' : bE[1] < now ? 'Lower ↓' : 'No clear direction';
  $('thEnd').textContent = 'In 12 months (' + lab(endM) + ')';

  const cy = (S, c, t) => (S.lv[c][t] / S.lv[c][t - 12] - 1) * 100;
  const we = p.weights.ecom, ws = p.weights.eserv, eW = we + ws;
  const enY = (S, t) => (we * cy(S, 'ecom', t) + ws * cy(S, 'eserv', t)) / eW;
  const eNow = enY(B, n), eEnd = enY(B, E), eDrag = eW * (eEnd - eNow);
  const shNow = cy(B, 'shelter', n), shEnd = cy(B, 'shelter', E);

  const tr = []; for (let f = 1; f <= 6; f++) tr.push({ m: B.months[n + f], v: T.yoy(n + f) });
  const tMin = tr.reduce((a, b) => (b.v < a.v ? b : a)), tMax = tr.reduce((a, b) => (b.v > a.v ? b : a));
  const hm = []; for (let t = n - 11; t <= n; t++) hm.push({ m: p.months[t], v: p.mom.headline[t] });
  const avg = hm.reduce((s, h) => s + h.v, 0) / 12;
  const out6 = hm.slice(0, 6), hot6 = out6.filter(h => h.v > avg + 0.05), cold6 = out6.filter(h => h.v < avg - 0.05);

  const R = D.refs, refs = [];
  if (R.expinf1y) refs.push(['Cleveland Fed 1-year expected', R.expinf1y.value]);
  if (R.spf) refs.push(['SPF next 4 quarters', R.spf.fourQ]);

  const ins = [];
  const swing = Math.max(Math.abs(tMax.v - now), Math.abs(tMin.v - now));
  ins.push(`<li class="amber"><b>Base effects over the next six months: ${swing < 0.15 ? 'small' : 'about ' + swing.toFixed(1) + ' points'}.</b> If prices kept rising at last year's average pace (${pct(p.trailing.headline12)} a year), reported inflation would still move between <b>${pct(tMin.v)}</b> (${lab(tMin.m)}) and <b>${pct(tMax.v)}</b> (${lab(tMax.m)}), purely because of which months drop out. ${hot6.length ? `Hotter-than-average months leaving soon: <b>${hot6.map(h => lab(h.m)).join(', ')}</b>.` : ''} ${cold6.length ? `Cooler months leaving, which push the rate up: <b>${cold6.map(h => lab(h.m)).join(', ')}</b>.` : ''}</li>`);
  if (B.anchored.length) ins.push(`<li class="ref"><b>The next ${B.anchored.length === 1 ? 'print starts' : B.anchored.length + ' prints start'} from the Cleveland Fed nowcast</b> (${B.anchored.map(long).join(', ')}): <b>${B.anchored.map(m => pct(B.yoy(B.months.indexOf(m)), 2)).join(', ')}</b> on the official measure.</li>`);
  ins.push(`<li class="hot"><b>Energy: ${pct(eNow)} now → ${pct(eEnd)} by ${lab(endM)}.</b> With WTI at $${D.oil?.spot?.value?.toFixed(0) ?? '—'} today moving to $${P.oil} in a year, energy ${eDrag < 0 ? 'takes' : 'adds'} about <b>${Math.abs(eDrag).toFixed(2)} points</b> ${eDrag < 0 ? 'off' : 'to'} headline. Energy is only ${(eW * 100).toFixed(1)}% of the basket, but it's the part that swings most.</li>`);
  ins.push(`<li><b>Shelter is looking in the rearview mirror.</b> New leases are rising <b>${pct(P.rent)}</b> a year (Zillow, ${D.rent ? long(D.rent.month) : 'n/a'}), while CPI shelter shows <b>${pct(shNow)}</b> because it averages over existing leases. At a ${P.hl}-month half-life it reaches <b>${pct(shEnd)}</b> by ${lab(endM)}. Shelter is ${(p.weights.shelter * 100).toFixed(0)}% of CPI, so this is the slowest but most reliable force.</li>`);
  ins.push(`<li><b>Services ex-shelter is the sticky part.</b> It has run at <b>${pct(p.trailing.sxs6)}</b> annualized over 6 months and <b>${pct(p.trailing.sxs12)}</b> over 12. The dial is at ${pct(P.sxs)}, and every 0.5-point change there moves the 12-month answer by about ${(0.5 * p.weights.sxs).toFixed(2)} points.</li>`);
  if (refs.length) {
    const mean = refs.reduce((s, r) => s + r[1], 0) / refs.length, gap = end - mean;
    const judge = s12 ? (Math.abs(gap) > s12.rmse
      ? `That is larger than the model's typical 12-month miss (${pts(s12.rmse)} points), so it's worth checking which dial drives it.`
      : `That is smaller than the model's typical 12-month miss (${pts(s12.rmse)} points), so the two views are not really in conflict.`) : '';
    ins.push(`<li class="ref"><b>Against outside views:</b> ${refs.map(([k, v]) => `${k} <b>${pct(v)}</b>`).join(', ')}. The model's ${pct(end)} sits <b>${Math.abs(gap).toFixed(1)} points ${gap > 0 ? 'above' : 'below'}</b> their average. ${judge}</li>`);
  }
  ins.push(`<li><b>Bottom line:</b> from <b>${pct(now)}</b> (${long(p.last)}) to about <b>${pct(end)}</b> by ${long(endM)}. ${bE ? `Judged by the model's past misses, 8 times out of 10 the outcome would land between <b>${bE[0].toFixed(1)}%</b> and <b>${bE[1].toFixed(1)}%</b>. Direction: <b>${$('chipDir').textContent.replace(/ [↑↓]/, '').toLowerCase()}</b>${$('chipDir').textContent.startsWith('No') ? ' — today\'s rate sits inside that range' : ''}.` : BTerr ? 'The track record is unavailable, so there is no measured error band today.' : 'The error band appears once the track record has loaded.'}</li>`);
  $('insights').innerHTML = ins.join('');

  // contributions table
  let rows = '', cN = 0, cE = 0;
  const W0 = p.weightsAt[n - 12], W1 = p.weights;
  for (const c of COMPS) {
    const yN = cy(B, c, n), yE = cy(B, c, E), kN = W0[c] * yN, kE = W1[c] * yE; cN += kN; cE += kE;
    rows += `<tr><td>${NAMES[c]}</td><td class="num">${(p.weights[c] * 100).toFixed(1)}%</td><td class="num">${pct(yN)}</td><td class="num">${pct(yE)}</td><td class="num">${kN.toFixed(2)} pp</td><td class="num">${kE.toFixed(2)} pp</td></tr>`;
  }
  const saN = (B.H[n] / B.H[n - 12] - 1) * 100, saE = (B.H[E] / B.H[E - 12] - 1) * 100;
  rows += `<tr class="total"><td>Sum = headline, seasonally adjusted</td><td class="num">100%</td><td class="num">${pct(saN, 2)}</td><td class="num">${pct(saE, 2)}</td><td class="num">${cN.toFixed(2)} pp</td><td class="num">${cE.toFixed(2)} pp</td></tr>`;
  rows += `<tr><td>Official headline (not seasonally adjusted)</td><td></td><td class="num">${pct(now, 2)}</td><td class="num">${pct(end, 2)}</td><td></td><td></td></tr>`;
  $('compRows').innerHTML = rows;

  drawCharts(B, T, band, hm, avg);
  renderTrack();
}

function drawCharts(B, T, band, hm, avg) {
  const n = B.n, E = n + NF, first = n - 23;
  const idx = []; for (let t = first; t <= E; t++) idx.push(t);
  const labels = idx.map(t => lab(B.months[t]));
  const fwd = S => idx.map(t => (t >= n ? S.yoy(t) : null));
  const hist = idx.map(t => (t <= n ? B.yoy(t) : null));
  const bands = idx.map(t => (t === n ? [B.yoy(n), B.yoy(n)] : t > n ? band(t) : null));
  const point = (t, v) => idx.map(x => (x === t ? v : null));
  const R = D.refs, ext = [];
  (R.nowcast?.yoy || []).forEach(r => { if (!r.month) return; const t = B.months.indexOf(r.month); if (t > n && t <= E) ext.push({ label: 'Cleveland Fed nowcast ' + lab(r.month), data: point(t, r.value), style: 'circle' }); });
  if (R.expinf1y) ext.push({ label: 'Cleveland Fed 1-yr expected', data: point(E, R.expinf1y.value), style: 'triangle' });
  if (R.spf) ext.push({ label: 'SPF next 4 quarters', data: point(E, R.spf.fourQ), style: 'rectRot' });
  if (R.mich1y) ext.push({ label: 'Michigan households 1-yr', data: point(E, R.mich1y.value), style: 'crossRot' });

  ['fan', 'roll'].forEach(k => charts[k]?.destroy());
  Chart.defaults.font.family = 'Archivo';
  const grid = css('--line'), muted = css('--muted'), refC = css('--ref');
  charts.fan = new Chart($('fanChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'band high', data: bands.map(b => (b ? b[1] : null)), borderWidth: 0, pointRadius: 0, fill: false },
      { label: 'band low', data: bands.map(b => (b ? b[0] : null)), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: css('--lo') },
      { label: 'model path', data: fwd(B), borderColor: css('--base'), borderWidth: 2.5, pointRadius: 0, tension: 0.25 },
      { label: "last year's pace held", data: fwd(T), borderColor: css('--ghost'), borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: 0.25 },
      { label: 'official CPI', data: hist, borderColor: css('--hist'), borderWidth: 2.5, pointRadius: 0, tension: 0.25 },
      ...ext.map(e => ({ label: e.label, data: e.data, showLine: false, pointStyle: e.style, pointRadius: 6, pointHoverRadius: 8, borderColor: refC, backgroundColor: refC, borderWidth: 2 })),
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { filter: i => i.parsed.y != null && !(i.datasetIndex <= 1 && i.dataIndex <= 23), callbacks: { label: c => (c.datasetIndex <= 1 ? (c.datasetIndex ? '80% band low' : '80% band high') : c.dataset.label) + ': ' + c.parsed.y.toFixed(2) + '%' } } },
      scales: { x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 9, font: { size: 11 } } },
        y: { grid: { color: grid }, ticks: { color: muted, callback: v => v.toFixed(1) + '%', font: { size: 11 } } } } },
  });

  charts.roll = new Chart($('rollChart'), {
    type: 'bar',
    data: { labels: hm.map(h => lab(h.m)), datasets: [{ data: hm.map(h => h.v), backgroundColor: hm.map(h => (h.v > avg + 0.05 ? css('--hot') : muted + '77')), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => (c.parsed.y >= 0 ? '+' : '') + c.parsed.y.toFixed(2) + '% that month (avg ' + avg.toFixed(2) + '%)' } } },
      scales: { x: { grid: { display: false }, ticks: { color: muted, font: { size: 11 } } },
        y: { grid: { color: grid }, ticks: { color: muted, callback: v => v.toFixed(1) + '%', font: { size: 11 } } } } },
  });
}

/* ---------- track record ---------- */
function renderTrack() {
  if (!BT) {
    $('trackIntro').textContent = BTerr ? `The track record couldn't be computed: ${BTerr}` : 'Computing the track record from archived data…';
    return;
  }
  const smp = $('sampleS').value, S = BT.stats[smp];
  const sampleTxt = { all: `all ${BT.origins} monthly forecasts made from ${long(BT.firstOrigin)} to ${long(BT.lastOrigin)}`, exPandemic: 'the same forecasts, excluding those made from March 2020 to December 2022', last3y: `forecasts made since ${long(BT.recentFrom)}` }[smp];
  const m12 = S[12]?.[variant()], nv12 = S[12]?.naive, sp12 = S[12]?.spf;
  $('trackIntro').innerHTML = `Each month, the model was re-run using only the data published by that day's CPI release, with the dials set by the same data rule the page uses, and then compared with what actually happened. The table shows the typical miss in percentage points (root-mean-square error) for ${sampleTxt}. Lower is better, and the best in each row is highlighted.` +
    (m12 && nv12 ? ` <b>At 12 months the model misses by ${pts(m12.rmse, 2)} points on average, against ${pts(nv12.rmse, 2)} for assuming no change${sp12 ? ` and ${pts(sp12.rmse, 2)} for the SPF` : ''}.</b>` : '');
  const cols = ['modelNC', 'model', 'naive', 'nowcast', 'spf'];
  $('trackRows').innerHTML = [1, 2, 3, 6, 12].map(h => {
    const vals = cols.map(c => S[h]?.[c]?.rmse ?? null), best = Math.min(...vals.filter(v => v != null));
    return `<tr><td>${h} month${h > 1 ? 's' : ''} ahead</td>${vals.map((v, i) => `<td class="num${v === best ? ' best' : ''}" title="${S[h]?.[cols[i]] ? `MAE ${S[h][cols[i]].mae} · bias ${S[h][cols[i]].bias} · n=${S[h][cols[i]].n}` : ''}">${v == null ? '—' : v.toFixed(2)}</td>`).join('')}</tr>`;
  }).join('');
  $('trackTbl').style.display = ''; $('trackBox').style.display = ''; $('trackLegend').style.display = '';
  $('trackNotes').innerHTML = Object.values(BT.notes).map(t => `<li>${esc(t)}</li>`).join('') + '<li>"No change" assumes the latest official rate simply persists. The SPF forecasts quarterly averages, so its comparison with the monthly rate is approximate.</li>';

  const v = variant(), rows = BT.path12;
  charts.track?.destroy();
  const muted = css('--muted');
  charts.track = new Chart($('trackChart'), {
    type: 'line',
    data: { labels: rows.map(r => lab(r.target)), datasets: [
      { label: 'actual', data: rows.map(r => r.actual), borderColor: css('--hist'), borderWidth: 2.5, pointRadius: 0, tension: 0.2 },
      { label: 'model, 12 months earlier', data: rows.map(r => r[v]), borderColor: css('--base'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
      { label: 'no change', data: rows.map(r => r.naive), borderColor: css('--ghost'), borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0.2 },
      { label: 'SPF', data: rows.map(r => r.spf), showLine: false, pointRadius: 2.5, borderColor: css('--ref'), backgroundColor: css('--ref') },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { filter: i => i.parsed.y != null, callbacks: { label: c => c.dataset.label + ': ' + c.parsed.y.toFixed(2) + '%' } } },
      scales: { x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 8, font: { size: 11 } } },
        y: { grid: { color: css('--line') }, ticks: { color: muted, callback: x => x.toFixed(0) + '%', font: { size: 11 } } } } },
  });
}

// Use the nowcast start by default only if it actually reduced errors over the first two months.
function decideAnchor() {
  const have = Object.keys(anchorMap()).length > 0;
  $('anchorWrap').style.display = have ? '' : 'none';
  $('anchorMonths').textContent = Object.keys(anchorMap()).map(long).join(' and ');
  if (!have) { $('anchorNote').textContent = ''; return; }
  if (anchorTouched) return;
  if (BT) {
    const a = BT.stats.all, m = (a[1].model.rmse + a[2].model.rmse) / 2, nc = (a[1].modelNC.rmse + a[2].modelNC.rmse) / 2;
    $('anchorT').checked = nc <= m;
    $('anchorNote').textContent = nc <= m
      ? `On by default: in the track record, starting from the nowcast cut the typical 1–2 month miss from ${m.toFixed(2)} to ${nc.toFixed(2)} points.`
      : `Off by default: in the track record, starting from the nowcast did not help (typical 1–2 month miss ${nc.toFixed(2)} vs ${m.toFixed(2)} points without it).`;
  } else {
    $('anchorT').checked = true;
    $('anchorNote').textContent = BTerr ? 'On by default; the track record that would test this choice is unavailable.' : '';
  }
}

/* ---------- static panels ---------- */
function renderRefs() {
  const R = D.refs, link = (u, t) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
  const card = (t, v, d, na) => `<div class="ref${na ? ' na' : ''}"><div class="t">${t}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const fred = id => 'https://fred.stlouisfed.org/series/' + id;
  const c = [], nc = R.nowcast;
  if (nc && (nc.yoy?.length || nc.mom?.length)) {
    const nm = r => (r.month ? long(r.month) : esc(r.label));
    const y = (nc.yoy || []).map(r => `${nm(r)}: <b>${pct(r.value, 2)}</b> y/y`).join('<br>');
    const m = (nc.mom || []).map(r => `${nm(r)}: ${pct(r.value, 2)} m/m`).join('<br>');
    c.push(card('Cleveland Fed inflation nowcast', nc.yoy?.length ? pct(nc.yoy[nc.yoy.length - 1].value, 2) : pct(nc.mom[nc.mom.length - 1].value, 2), `${y}${y && m ? '<br>' : ''}${m}<br>Daily model of the next CPI prints. ${link('https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting', 'Source')}`));
  } else c.push(card('Cleveland Fed inflation nowcast', 'unavailable', `Couldn't read the data file today. ${link('https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting', 'See the page')}`, true));
  c.push(R.expinf1y ? card('Cleveland Fed 1-year expected inflation', pct(R.expinf1y.value, 2), `Average CPI inflation over the next 12 months, from swaps, Treasury yields and surveys. ${fmtDate(R.expinf1y.date)} · ${link(fred('EXPINF1YR'), 'FRED')}`) : card('Cleveland Fed 1-year expected inflation', 'unavailable', '', true));
  c.push(R.spf ? card('Survey of Professional Forecasters', pct(R.spf.fourQ, 2), `Median headline CPI forecast, next 4 quarters (quarterly path ${R.spf.quarters.map(v => v.toFixed(1)).join(' → ')}). Survey ${R.spf.survey} · ${link('https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/survey-of-professional-forecasters', 'Philadelphia Fed')}`) : card('Survey of Professional Forecasters', 'unavailable', '', true));
  c.push(R.be5y ? card('5-year breakeven inflation', pct(R.be5y.value, 2), `Average CPI inflation over 5 years priced in Treasury vs TIPS yields. Daily. 5y5y forward: ${R.fwd5y5y ? pct(R.fwd5y5y.value, 2) : '—'}. ${fmtDate(R.be5y.date)} · ${link(fred('T5YIE'), 'FRED')}`) : card('5-year breakeven inflation', 'unavailable', '', true));
  c.push(R.mich1y ? card('Michigan survey, households 1-year', pct(R.mich1y.value, 1), `Median household expectation. Usually runs above actual CPI. ${fmtDate(R.mich1y.date)} · ${link(fred('MICH'), 'FRED')}`) : card('Michigan survey, households 1-year', 'unavailable', '', true));
  if (R.fomcPce?.length) {
    const yrs = R.fomcPce.slice(0, 3).map(r => `${r.year}: ${pct(r.value, 1)}`).join(' · ');
    c.push(card('FOMC projections (PCE, not CPI)', pct(R.fomcPce[0].value, 1), `Median Fed official, Q4-to-Q4 PCE inflation. ${yrs}. PCE usually runs a few tenths below CPI. ${link(fred('PCECTPIMD'), 'FRED')}`));
  } else c.push(card('FOMC projections (PCE)', 'unavailable', '', true));
  $('refs').innerHTML = c.join('');
}

const srcTable = list => list.map(s => `<tr><td><a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a>${s.id ? ` <span class="err">${s.id}</span>` : ''}${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}</td><td><span class="st ${s.ok ? 'ok' : 'bad'}">${s.ok ? (s.error ? 'fallback' : 'live') : 'failed'}</span></td><td>${esc(s.asOf || '—')}</td></tr>`).join('');

function defaults() {
  let oil = D.oil?.spot?.value ?? 75; oilSrc = "today's spot (no EIA forecast loaded)";
  const steo = D.oil?.steo;
  if (steo?.length) { const tgt = addM(nowMonth(), 12); let best = steo[steo.length - 1]; for (const r of steo) if (r[0] <= tgt) best = r; oil = best[1]; oilSrc = `EIA forecast for ${long(best[0])}`; }
  const P = dataDefaults(D.panel, { rentYoY: D.rent?.yoy, oilTarget: oil });
  return { oil: Math.round(P.oil), rent: +P.rent.toFixed(1), sxs: +P.sxs.toFixed(1), goods: +P.goods.toFixed(1), food: +P.food.toFixed(1), eserv: +P.eserv.toFixed(1), hl: P.hl, beta: P.beta };
}

async function boot() {
  const btPromise = fetch('/api/backtest')
    .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return { j }; })
    .catch(e => ({ e }));
  try {
    const r = await fetch('/api/data'); const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { sources: j.sources });
    D = j;
  } catch (e) {
    $('loading').style.display = 'none'; $('fatal').style.display = 'block';
    $('fatalMsg').textContent = e.message + '. The page shows no numbers rather than stale or invented ones.';
    if (e.sources) $('fatalRows').innerHTML = srcTable(e.sources);
    return;
  }
  const p = D.panel; P0 = defaults();
  $('asof').innerHTML = `Latest CPI: <b>${long(p.last)}</b> · market data to ${fmtDate(D.oil?.spot?.date)} · refreshed ${new Date(D.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}${p.gaps.length ? ` · missing BLS months filled by interpolation: ${p.gaps.map(long).join(', ')}` : ''}`;
  $('hOil').textContent = `Default: ${oilSrc}. WTI spot $${D.oil?.spot?.value?.toFixed(1) ?? '—'} on ${fmtDate(D.oil?.spot?.date)}.`;
  $('hRent').textContent = D.rent ? `Default: Zillow new-lease rents, ${pct(D.rent.yoy)} y/y in ${long(D.rent.month)}. CPI shelter is ${pct(p.trailing.shelter12)} y/y.` : "Zillow unavailable; defaulting to CPI shelter's own pace.";
  $('hSxs').textContent = `Default: last 6 months annualized (${pct(p.trailing.sxs6)}); 12 months: ${pct(p.trailing.sxs12)}. The stickiest part of inflation.`;
  $('hGoods').textContent = `Default: last 6 months annualized. 12 months: ${pct(p.trailing.goods12)}.`;
  $('hFood').textContent = 'Default: last 12 months.';
  $('hEserv').textContent = 'Default: last 12 months. Driven by utility rates and natural gas, not crude oil.';
  setP(P0);
  $('srcRows').innerHTML = srcTable(D.sources);
  $('srcNote').innerHTML = `Fetched server-side and cached for an hour; the track record is cached for a day. Weights: BLS relative importance, December ${D.weights.year}${D.weights.fallback ? ' (bls.gov unreachable, so an embedded copy of the official table is used)' : ''}.`;
  renderRefs();
  decideAnchor();
  $('loading').style.display = 'none'; $('app').style.display = 'block';
  document.querySelectorAll('input[type=range]').forEach(el => el.addEventListener('input', refresh));
  $('reset').addEventListener('click', () => { setP(P0); refresh(); });
  $('anchorT').addEventListener('change', () => { anchorTouched = true; refresh(); });
  $('sampleS').addEventListener('change', refresh);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  refresh();
  const bt = await btPromise; if (bt.j) BT = bt.j; else BTerr = bt.e.message;
  decideAnchor();
  refresh();
}
boot();
