/* backtest/v3.js — other KINDS of signal (v1/v2 showed the current confluence alerts have no edge).
   Daily candles (~2.7 years) of the most liquid USDT coins. Each method picks coins at a rebalance
   date and holds them for a fixed time; its result each period = the picked coins' average return
   MINUS the average return of every coin (equal weight) over the same period, minus fees (0.1 %
   round trip on each rebalance). Judged on the series of period results: mean, share of periods
   won, t (mean / st.dev. x sqrt(periods)) and the 5 time folds — a real effect wins in most folds.
   Known bias: today's liquid coins only (coins that died are missing), so absolute returns flatter;
   the comparison BETWEEN coins (excess) is much less affected. Output: backtest/out/v3.md (+ .json). */
"use strict";
const fs = require("fs"), path = require("path");
const HOST = "https://data-api.binance.vision";
const COINS = +process.env.COINS || 120, DAYS = 1000, FEE = 0.001, FOLDS = 5, PICK = 0.2;
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

/* ── methods: (D, i) → picked coin indexes at day i, using data up to day i only ──
   D = { c[coin][day] close, v[coin][day] quote volume, ok[coin][day] has data, btc[day] } */
const ret = (D, k, a, b) => D.c[k][b] / D.c[k][a] - 1;
const live = (D, i, back) => D.c.map((_, k) => k).filter((k) => D.ok[k][i - back] && D.ok[k][i]);
const top = (list, score, frac = PICK, low = false) => {
  const s = list.map((k) => [k, score(k)]).filter(([, x]) => Number.isFinite(x)).sort((a, b) => (low ? a[1] - b[1] : b[1] - a[1]));
  return s.slice(0, Math.max(1, Math.round(s.length * frac))).map(([k]) => k);
};
const sma = (a, i, n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; return s / n; };
const METHODS = [
  { name: "momentum 4 weeks (top 20 %, hold 1 week)", hold: 7, back: 29, pick: (D, i) => top(live(D, i, 29), (k) => ret(D, k, i - 29, i - 1)) },
  { name: "momentum 1 week (top 20 %, hold 1 week)", hold: 7, back: 8, pick: (D, i) => top(live(D, i, 8), (k) => ret(D, k, i - 8, i - 1)) },
  { name: "momentum 12 weeks (top 20 %, hold 1 week)", hold: 7, back: 85, pick: (D, i) => top(live(D, i, 85), (k) => ret(D, k, i - 85, i - 1)) },
  { name: "reversal 3 days (bottom 20 %, hold 3 days)", hold: 3, back: 3, pick: (D, i) => top(live(D, i, 3), (k) => ret(D, k, i - 3, i), PICK, true) },
  { name: "trend: above rising MA50 (hold 1 week)", hold: 7, back: 60, pick: (D, i) => live(D, i, 60).filter((k) => D.c[k][i] > sma(D.c[k], i, 50) && sma(D.c[k], i, 50) > sma(D.c[k], i - 10, 50)) },
  { name: "20-day high + volume 1.5x (hold 10 days)", hold: 10, back: 40, pick: (D, i) => live(D, i, 40).filter((k) => D.c[k][i] > Math.max(...D.c[k].slice(i - 20, i)) && D.v[k][i] > 1.5 * sma(D.v[k], i - 1, 20)) },
  { name: "momentum 4 weeks only when BTC > MA200", hold: 7, back: 200, pick: (D, i) => (D.btc[i] > sma(D.btc, i, 200) ? top(live(D, i, 29), (k) => ret(D, k, i - 29, i - 1)) : null) },
  { name: "low volatility 30 days (lowest 20 %, hold 1 week)", hold: 7, back: 31, pick: (D, i) => top(live(D, i, 31), (k) => { const r = []; for (let j = i - 29; j <= i; j++) r.push(Math.log(D.c[k][j] / D.c[k][j - 1])); const m = r.reduce((s, x) => s + x, 0) / r.length; return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length); }, PICK, true) },
  { name: "near the 1-year high (top 20 %, hold 1 week)", hold: 7, back: 365, pick: (D, i) => top(live(D, i, 365), (k) => D.c[k][i] / Math.max(...D.c[k].slice(i - 364, i + 1))) },
];

/* run one method: non-overlapping periods of `hold` days → excess returns */
function run(D, m) {
  const out = [];
  for (let i = Math.max(m.back, 1); i + m.hold < D.days; i += m.hold) {
    const all = live(D, i, 0).filter((k) => D.ok[k][i + m.hold]);
    if (all.length < 20) continue;
    const pick = m.pick(D, i);
    if (pick === null) { out.push({ i, x: 0, out: true }); continue; } /* standing aside = 0 vs the market */
    const p = pick.filter((k) => D.ok[k][i + m.hold]);
    if (!p.length) continue;
    const avg = (ks) => ks.reduce((s, k) => s + ret(D, k, i, i + m.hold), 0) / ks.length;
    out.push({ i, x: avg(p) - avg(all) - FEE, raw: avg(p) - FEE, n: p.length });
  }
  return out;
}
const S = (xs) => {
  const n = xs.length, m = n ? xs.reduce((s, x) => s + x, 0) / n : NaN, sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n || 1)) || 1e-9;
  return { n, mean: m, win: n ? xs.filter((x) => x > 0).length / n : NaN, t: n >= 10 ? (m / sd) * Math.sqrt(n) : NaN };
};
const pct = (x, d = 2) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tick = await get("/api/v3/ticker/24hr?type=MINI");
  const coins = tick
    .filter((x) => x.symbol.endsWith("USDT") && +x.quoteVolume >= 5e6 && Date.now() - x.closeTime < 2 * 864e5 && !(+x.highPrice <= 1.01 && +x.lowPrice >= 0.99))
    .map((x) => ({ pair: x.symbol, sym: x.symbol.slice(0, -4), qv: +x.quoteVolume }))
    .filter((x) => x.sym && !SKIP.has(x.sym))
    .sort((a, b) => (b.sym === "BTC") - (a.sym === "BTC") || b.qv - a.qv)
    .slice(0, COINS);
  const day = 864e5, today = Math.floor(Date.now() / day) * day, start = today - DAYS * day;
  const rows = {};
  await pool(coins, 8, async (c) => (rows[c.sym] = await get(`/api/v3/klines?symbol=${c.pair}&interval=1d&limit=${DAYS}&endTime=${today - 1}`)));
  /* aligned grid: day index 0 = start; a coin has data from its first candle on */
  const D = { days: DAYS, c: [], v: [], ok: [], btc: null, sym: [] };
  for (const c of coins) {
    const r = rows[c.sym];
    if (!r || !r.length) continue;
    const C = new Array(DAYS).fill(NaN), V = new Array(DAYS).fill(NaN);
    for (const x of r) { const d = Math.round((x[0] - start) / day); d >= 0 && d < DAYS && ((C[d] = +x[4]), (V[d] = +x[7])); }
    for (let d = 1; d < DAYS; d++) if (!Number.isFinite(C[d]) && Number.isFinite(C[d - 1])) (C[d] = C[d - 1]), (V[d] = 0); /* gap day: carry */
    D.c.push(C); D.v.push(V); D.ok.push(C.map(Number.isFinite)); D.sym.push(c.sym);
    if (c.sym === "BTC") D.btc = C;
  }
  if (!D.btc) throw new Error("no BTC");
  const md = [`# Technical Signal — backtest v3: other kinds of signal\n`,
    `${D.c.length} coins · daily candles ${new Date(start).toISOString().slice(0, 10)} → ${new Date(today).toISOString().slice(0, 10)} · picks vs the equal-weight average of all coins, after 0.1 % fees per rebalance. Folds = 5 equal stretches of time.\n`,
    `| method | periods | excess per period | periods won | t | yearly excess (approx.) | folds won | excess per fold |`, `|---|---|---|---|---|---|---|---|`];
  const res = METHODS.map((m) => {
    const r = run(D, m), s = S(r.map((x) => x.x)), span = DAYS - m.back;
    const per = [...Array(FOLDS)].map((_, f) => S(r.filter((x) => Math.floor(((x.i - m.back) / span) * FOLDS) === f).map((x) => x.x)));
    const won = per.filter((p) => p.n >= 3 && p.mean > 0).length, used = per.filter((p) => p.n >= 3).length;
    const year = s.mean * (365 / m.hold);
    md.push(`| ${m.name} | ${s.n} | ${pct(s.mean)} | ${pct(s.win, 0)} | ${Number.isFinite(s.t) ? s.t.toFixed(1) : "—"} | ${pct(year, 0)} | ${won}/${used} | ${per.map((p) => (p.n >= 3 ? pct(p.mean, 1) : "—")).join(" · ")} |`);
    return { name: m.name, hold: m.hold, ...s, year, won, used, per: per.map((p) => p.mean) };
  });
  const good = res.filter((r) => r.t >= 2 && r.won >= r.used - 1 && r.used >= 4);
  md.push(`\n## Verdict\n`);
  md.push(good.length ? good.map((r) => `- **${r.name}**: ${pct(r.mean)} per period over the market (t ${r.t.toFixed(1)}, folds ${r.won}/${r.used}).`).join("\n") : "- No method beats the market average with t ≥ 2 AND in (almost) every fold.");
  md.push(`- |t| < 2 → could be luck. Survivorship: only coins liquid today are in the test.`);
  const text = md.join("\n");
  fs.writeFileSync(path.join(OUT, "v3.md"), text);
  fs.writeFileSync(path.join(OUT, "v3.json"), JSON.stringify({ at: Date.now(), coins: D.c.length, res }, null, 1));
  process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  console.log(text);
})().catch((e) => { console.error("failed:", e); process.exit(1); });
