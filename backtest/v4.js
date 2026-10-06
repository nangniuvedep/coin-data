/* backtest/v4.js — deep check of the one promising idea from v3: a daily close above the N-day high on
   heavy volume ("breakout + volume"; v3: +1.92 % over the market per 10-day hold, 5/5 folds, but only
   64 periods, t 1.1). Here, EVENT by event, on more coins and ~5 years of daily candles:
   - each breakout = coin closes above the highest close of the previous N days with volume >= X times
     its 20-day average; result = its return over H days MINUS the equal-weight market over the same
     days, minus 0.1 % fees; one event per coin until it has been H days out of a breakout.
   - grid: N 20 / 55 · X 1.5 / 2 / 3 · H 5 / 10 / 20. Mean AND median (a few pumps must not carry it),
     share won, t with events grouped by day (events on the same day are not independent).
   - the setting is chosen on folds 1-3 of time and simulated on folds 4-5.
   Output: backtest/out/v4.md (+ .json). Survivorship: only coins liquid today. */
"use strict";
const fs = require("fs"), path = require("path");
const HOST = "https://data-api.binance.vision";
const COINS = +process.env.COINS || 200, DAYS = 1800, FEE = 0.001, FOLDS = 5, TRAIN = 3;
const SKIP = new Set("USDC FDUSD TUSD USDP DAI BUSD USDE USDS USD1 U EUR EURI AEUR XUSD BFUSD PYUSD RLUSD GUSD SUSD FRAX LUSD PAX WBTC WBETH BETH STETH WSTETH CBBTC BTCB PAXG XAUT".split(" "));
const OUT = path.join(__dirname, "out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(HOST + p, { signal: AbortSignal.timeout(20e3) });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status === 418) { await sleep(1e3 * (+r.headers.get("retry-after") || 30)); continue; }
      if (t >= 2) throw new Error("HTTP " + r.status);
    } catch (e) {
      if (t >= 2) throw e;
    }
    await sleep(1500 * (t + 1));
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all([...Array(n)].map(async () => { while (i < items.length) { const k = items[i++]; await fn(k).catch(() => {}); } }));
}
const pct = (x, d = 2) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tick = await get("/api/v3/ticker/24hr?type=MINI");
  const coins = tick
    .filter((x) => x.symbol.endsWith("USDT") && +x.quoteVolume >= 3e6 && Date.now() - x.closeTime < 2 * 864e5 && !(+x.highPrice <= 1.01 && +x.lowPrice >= 0.99))
    .map((x) => ({ pair: x.symbol, sym: x.symbol.slice(0, -4), qv: +x.quoteVolume }))
    .filter((x) => x.sym && !SKIP.has(x.sym))
    .sort((a, b) => b.qv - a.qv)
    .slice(0, COINS);
  const day = 864e5, today = Math.floor(Date.now() / day) * day, start = today - DAYS * day;
  const C = [], V = [];
  await pool(coins, 8, async (c) => {
    let rows = [], end = today - 1;
    while (rows.length < DAYS) {
      const p = await get(`/api/v3/klines?symbol=${c.pair}&interval=1d&limit=1000&endTime=${end}`);
      if (!p.length) break;
      rows = p.concat(rows);
      end = p[0][0] - 1;
      if (p.length < 1000) break;
    }
    const c1 = new Array(DAYS).fill(NaN), v1 = new Array(DAYS).fill(NaN);
    for (const x of rows) { const d = Math.round((x[0] - start) / day); d >= 0 && d < DAYS && ((c1[d] = +x[4]), (v1[d] = +x[7])); }
    for (let d = 1; d < DAYS; d++) if (!Number.isFinite(c1[d]) && Number.isFinite(c1[d - 1])) (c1[d] = c1[d - 1]), (v1[d] = 0);
    C.push(c1); V.push(v1);
  });
  /* equal-weight market return from day a to day b (coins with data on both days) */
  const mk = new Map();
  const market = (a, b) => {
    const key = a * 1e4 + b;
    if (mk.has(key)) return mk.get(key);
    let s = 0, n = 0;
    for (let k = 0; k < C.length; k++) if (Number.isFinite(C[k][a]) && Number.isFinite(C[k][b])) (s += C[k][b] / C[k][a] - 1), n++;
    const r = n >= 20 ? s / n : NaN;
    mk.set(key, r);
    return r;
  };
  const first = C.map((c) => c.findIndex(Number.isFinite));
  const firstDay = Math.min(...first.filter((x) => x >= 0));
  const span = DAYS - firstDay;
  const foldOf = (d) => Math.min(FOLDS - 1, Math.floor(((d - firstDay) / span) * FOLDS));

  function events(N, X, H) {
    const out = [];
    for (let k = 0; k < C.length; k++) {
      const c = C[k], v = V[k];
      let quiet = 0;
      for (let d = Math.max(first[k], 0) + Math.max(N, 20) + 1; d + H < DAYS; d++) {
        if (!Number.isFinite(c[d + H])) continue;
        let hi = -Infinity, va = 0;
        for (let j = d - N; j < d; j++) hi = Math.max(hi, c[j]);
        for (let j = d - 20; j < d; j++) va += v[j];
        va /= 20;
        const hit = c[d] > hi && va > 0 && v[d] >= X * va;
        if (hit && d >= quiet) {
          const m = market(d, d + H);
          if (Number.isFinite(m)) out.push({ d, k, x: c[d + H] / c[d] - 1 - m - FEE });
          quiet = d + H;
        }
      }
    }
    return out;
  }
  /* stats with events grouped by day: t on the daily means */
  function stat(ev) {
    const xs = ev.map((e) => e.x), byDay = new Map();
    ev.forEach((e) => byDay.set(e.d, (byDay.get(e.d) || []).concat(e.x)));
    const dm = [...byDay.values()].map((a) => a.reduce((s, x) => s + x, 0) / a.length);
    const m = dm.reduce((s, x) => s + x, 0) / (dm.length || 1), sd = Math.sqrt(dm.reduce((s, x) => s + (x - m) ** 2, 0) / (dm.length || 1)) || 1e-9;
    return { n: xs.length, days: dm.length, mean: xs.reduce((s, x) => s + x, 0) / (xs.length || 1), med: median(xs), win: xs.filter((x) => x > 0).length / (xs.length || 1), t: dm.length >= 10 ? (m / sd) * Math.sqrt(dm.length) : NaN };
  }
  const md = [`# Technical Signal — backtest v4: breakout + volume, event by event\n`,
    `${C.length} coins (24h volume ≥ 3 M USD today) · daily candles ${new Date(start + firstDay * day).toISOString().slice(0, 10)} → ${new Date(today).toISOString().slice(0, 10)} · result = coin return − equal-weight market over the same days − 0.1 % fees · t uses events grouped by day.\n`,
    `| N-day high | volume × | hold | events | mean | median | won | t | folds won | mean per fold | train mean | test mean | test median | test t |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`];
  const res = [];
  for (const N of [20, 55]) for (const X of [1.5, 2, 3]) for (const H of [5, 10, 20]) {
    const ev = events(N, X, H), s = stat(ev), per = [...Array(FOLDS)].map((_, f) => stat(ev.filter((e) => foldOf(e.d) === f)));
    const tr = stat(ev.filter((e) => foldOf(e.d) < TRAIN)), te = stat(ev.filter((e) => foldOf(e.d) >= TRAIN));
    const won = per.filter((p) => p.n >= 10 && p.mean > 0).length, used = per.filter((p) => p.n >= 10).length;
    md.push(`| ${N} | ${X} | ${H} | ${s.n} | ${pct(s.mean)} | ${pct(s.med)} | ${pct(s.win, 0)} | ${Number.isFinite(s.t) ? s.t.toFixed(1) : "—"} | ${won}/${used} | ${per.map((p) => (p.n >= 10 ? pct(p.mean, 1) : "—")).join(" · ")} | ${pct(tr.mean)} | ${pct(te.mean)} | ${pct(te.med)} | ${Number.isFinite(te.t) ? te.t.toFixed(1) : "—"} |`);
    res.push({ N, X, H, all: s, train: tr, test: te, won, used, per: per.map((p) => p.mean) });
  }
  /* choose on train: best train MEDIAN among settings with >= 100 train events (median: robust to pumps) */
  const pick = res.filter((r) => r.train.n >= 100).sort((a, b) => b.train.med - a.train.med)[0];
  md.push(`\n## Verdict\n`);
  if (pick) {
    md.push(`- Chosen on folds 1-${TRAIN} (best train median): **${pick.N}-day high, volume ×${pick.X}, hold ${pick.H} days** — train median ${pct(pick.train.med)}, mean ${pct(pick.train.mean)}.`);
    md.push(`- Simulation on folds ${TRAIN + 1}-${FOLDS} (never seen): ${pick.test.n} events, mean ${pct(pick.test.mean)}, median ${pct(pick.test.med)}, won ${pct(pick.test.win, 0)}, t ${Number.isFinite(pick.test.t) ? pick.test.t.toFixed(1) : "—"}.`);
    md.push(pick.test.med > 0 && pick.test.t >= 2 ? `- **Holds up out of sample** (median > 0 and t ≥ 2).` : `- **Does not hold up out of sample** (needs median > 0 and t ≥ 2 on the test folds).`);
  }
  const text = md.join("\n");
  fs.writeFileSync(path.join(OUT, "v4.md"), text);
  fs.writeFileSync(path.join(OUT, "v4.json"), JSON.stringify({ at: Date.now(), coins: C.length, res, pick }, null, 1));
  process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  console.log(text);
})().catch((e) => { console.error("failed:", e); process.exit(1); });
