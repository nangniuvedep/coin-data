/* backtest/run.js — how good are the Technical Signal alerts, and is there a better way?
   Runs on GitHub Actions (Binance data-api is reachable there). Read-only: no secrets, no R2.

   1. Data: the most liquid USDT coins (24h volume >= 5 M), 1000 closed candles on 15m / 1H / 4H,
      plus the higher timeframe of each (1H / 4H / 1D) and BTC for the context, exactly what the
      live scanner uses.
   2. The CURRENT rules (engine/ = the same signals.js the app runs): every alert the scanner would
      have raised (new or upgraded, like the live stories), and what price did after it: return at
      the close of 5 / 10 / 20 candles in the alert's direction, minus 0.1 % fees (round trip).
      Compared with the plain drift of the same coins (every candle, same direction) = the edge.
   3. ALTERNATIVES, chosen on the first 70 % of the time only (train), then run on the last 30 %
      (test, never seen while choosing) — that second run is the simulation of the better method.
   Output: backtest/out/report.md (also the job summary) + report.json. */
"use strict";
const fs = require("fs"), path = require("path");
const S = require("./engine/signals.js"), SCAN = require("./engine/scanner.js"), I = require("./engine/indicators.js");

const HOST = "https://data-api.binance.vision";
const COINS = +process.env.COINS || 120, BARS = 1000, FEE = 0.001, HS = [5, 10, 20], SPLIT = 0.7;
const TFS = ["15m", "1H", "4H"];
const IV = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
const SKIP = new Set("USDC FDUSD TUSD USDP DAI BUSD USDE USDS USD1 U EUR EURI AEUR XUSD BFUSD PYUSD RLUSD GUSD SUSD FRAX LUSD PAX WBTC WBETH BETH STETH WSTETH CBBTC BTCB PAXG XAUT".split(" "));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, "out");

let calls = 0;
async function get(p) {
  for (let t = 0; ; t++) {
    calls++;
    try {
      const r = await fetch(HOST + p, { signal: AbortSignal.timeout(20e3) });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status === 418) { await sleep(1e3 * (+r.headers.get("retry-after") || 30)); continue; }
      if (t >= 2) throw new Error("HTTP " + r.status + " " + p);
    } catch (e) {
      if (t >= 2) throw e;
    }
    await sleep(1500 * (t + 1));
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all([...Array(n)].map(async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ err: String(e.message || e) })); } }));
  return out;
}
const klines = (pair, tf, limit = BARS) => get(`/api/v3/klines?symbol=${pair}&interval=${IV[tf]}&limit=${limit}`).then((rows) => SCAN.closed(rows, SCAN.TF[tf].ms, Date.now()));

/* trend of the higher timeframe at each candle of k (same mapping as scanner.replay) */
function htfAt(k, H, tf) {
  if (!H || !H.c.length) return k.c.map(() => 0);
  const ms = SCAN.TF[tf].ms, hms = SCAN.TF[SCAN.TF[tf].htf].ms, tr = SCAN.trendSeries(H), out = [];
  for (let r = 0, j = -1; r < k.t.length; r++) {
    while (j + 1 < H.t.length && H.t[j + 1] + hms <= k.t[r] + ms) j++;
    out.push(j >= 0 ? tr[j] : 0);
  }
  return out;
}

/* every alert of the current rules on one coin + timeframe, with its features and what followed */
function events(sym, tf, k, H, B) {
  const P = S.prepare(k), n = k.c.length, htf = htfAt(k, H, tf), btc = sym === "BTC" ? null : htfAt(k, B, tf), seen = {}, out = [];
  const drift = { 1: {}, "-1": {} };
  for (const h of HS) {
    let s = 0, m = 0;
    for (let e = S.MIN_BARS - 1; e < n - h; e++) (s += k.c[e + h] / k.c[e] - 1), m++;
    drift[1][h] = m ? s / m : 0;
    drift[-1][h] = -drift[1][h];
  }
  for (let e = S.MIN_BARS - 1; e < n - Math.max(...HS); e++) {
    const a = S.evaluate(P, e, { htf: htf[e], btc: btc ? btc[e] : null });
    if (!a || !S.fresh(seen, S.key(sym, tf, a), a, e)) continue;
    const c0 = k.c[e], ret = {}, edge = {};
    for (const h of HS) (ret[h] = (k.c[e + h] / c0 - 1) * a.dir - FEE), (edge[h] = ret[h] - drift[a.dir][h]);
    let best = 0, worst = 0;
    for (let j = e + 1; j <= e + 10; j++) (best = Math.max(best, (a.dir > 0 ? k.h[j] / c0 - 1 : 1 - k.l[j] / c0))), (worst = Math.max(worst, (a.dir > 0 ? 1 - k.l[j] / c0 : k.h[j] / c0 - 1)));
    out.push({
      sym, tf, t: k.t[e], dir: a.dir, stars: a.stars, n: a.n, fams: a.fams,
      htf: htf[e] === a.dir, btc: btc ? btc[e] === a.dir : null, stretched: S.stretched(P, e, a.dir),
      above200: k.c[e] > P.ema200[e], rsi: P.rsi[e], adx: P.adx[e], atrp: P.atr[e] / c0,
      ret, edge, best, worst,
    });
  }
  return out;
}

/* ── statistics ── */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function stat(list, h = 10) {
  const r = list.map((x) => x.ret[h]), g = list.map((x) => x.edge[h]);
  const m = mean(r), sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2))) || 1e-9;
  /* t = edge / (st.dev. / √n): |t| < 2 → could be luck; meaningless under 10 alerts */
  return { n: list.length, win: list.length ? list.filter((x) => x.ret[h] > 0).length / list.length : NaN, avg: m, edge: mean(g), t: list.length >= 10 ? (mean(g) / sd) * Math.sqrt(list.length) : NaN };
}
const pct = (x, d = 2) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
const row = (name, s) => `| ${name} | ${s.n} | ${pct(s.win, 0)} | ${pct(s.avg)} | ${pct(s.edge)} | ${Number.isFinite(s.t) ? s.t.toFixed(1) : "—"} |`;
const HEAD = "| | alerts | win | avg return (10 candles, after fees) | edge vs drift | t |\n|---|---|---|---|---|---|";

/* ── alternatives: each is a rule on the alert features (and an optional direction flip) ── */
const flip = (e) => ({ ...e, dir: -e.dir, ret: Object.fromEntries(HS.map((h) => [h, -(e.ret[h] + FEE) - FEE])), edge: Object.fromEntries(HS.map((h) => [h, -e.edge[h] - 2 * FEE])) });
function alternatives(train) {
  const fams = S.FAM;
  /* weight of each family = its edge on TRAIN when present (both directions pooled) */
  const w = {};
  for (const f of fams) {
    const a = train.filter((e) => e.fams.includes(f));
    w[f] = a.length >= 30 ? stat(a).edge : 0;
  }
  const score = (e) => e.fams.reduce((s, f) => s + w[f], 0) + (e.htf ? 0.002 : -0.002) + (e.stretched ? -0.002 : 0);
  const cands = [
    ["current: all alerts (3★+)", () => true],
    ["current: 4★+", (e) => e.stars >= 4],
    ["current: 5★", (e) => e.stars >= 5],
    ["trend-aligned (higher TF + EMA200 side)", (e) => e.htf && (e.dir > 0 ? e.above200 : !e.above200)],
    ["trend-aligned + not stretched", (e) => e.htf && (e.dir > 0 ? e.above200 : !e.above200) && !e.stretched],
    ["trend-aligned + ADX > 20", (e) => e.htf && (e.dir > 0 ? e.above200 : !e.above200) && e.adx > 20],
    ["with BTC + higher TF", (e) => e.htf && e.btc !== false],
    ["only bullish alerts", (e) => e.dir > 0],
    ["only bearish alerts", (e) => e.dir < 0],
    ["fade (opposite direction) — all", () => true, true],
    ["fade — stretched alerts only", (e) => e.stretched, true],
    ["fade — against higher TF only", (e) => !e.htf, true],
    ["family score > 0 (weights learned on train)", (e) => score(e) > 0],
    ["family score in top 30 % (train threshold)", null],
  ];
  const sc = train.map(score).sort((a, b) => b - a), thr = sc[Math.floor(sc.length * 0.3)] ?? Infinity;
  cands[cands.length - 1][1] = (e) => score(e) >= thr;
  return { cands, w, thr };
}
const applyRule = (list, [, f, fl]) => list.filter(f).map((e) => (fl ? flip(e) : e));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const tick = await get("/api/v3/ticker/24hr?type=MINI");
  const coins = tick
    .filter((x) => x.symbol.endsWith("USDT") && +x.quoteVolume >= SCAN.LIQ && Date.now() - x.closeTime < 2 * 864e5 && !(+x.highPrice <= 1.01 && +x.lowPrice >= 0.99))
    .map((x) => ({ pair: x.symbol, sym: x.symbol.slice(0, -4), qv: +x.quoteVolume }))
    .filter((x) => x.sym && !SKIP.has(x.sym))
    .sort((a, b) => (b.sym === "BTC") - (a.sym === "BTC") || b.qv - a.qv)
    .slice(0, COINS);
  console.log(`coins: ${coins.length}`);
  const need = new Set([...TFS, ...TFS.map((t) => SCAN.TF[t].htf)]);
  const data = {};
  await pool(coins.flatMap((c) => [...need].map((tf) => ({ c, tf }))), 8, async ({ c, tf }) => {
    (data[c.sym] = data[c.sym] || {})[tf] = await klines(c.pair, tf);
  });
  console.log(`candles loaded: ${calls} requests, ${((Date.now() - t0) / 1e3).toFixed(0)} s`);
  const B = data.BTC || {};
  let all = [];
  for (const c of coins)
    for (const tf of TFS) {
      const k = data[c.sym] && data[c.sym][tf];
      if (!k || k.err || k.c.length < S.MIN_BARS + 30) continue;
      all = all.concat(events(c.sym, tf, k, data[c.sym][SCAN.TF[tf].htf], B[SCAN.TF[tf].htf]));
    }
  all.sort((a, b) => a.t - b.t);
  const cut = all.length ? all[Math.floor(all.length * SPLIT)].t : 0;
  const train = all.filter((e) => e.t < cut), test = all.filter((e) => e.t >= cut);
  console.log(`alerts: ${all.length} (train ${train.length} · test ${test.length})`);

  const md = [];
  md.push(`# Technical Signal — backtest\n`);
  md.push(`${coins.length} coins (24h volume ≥ 5 M USD) · ${TFS.join(" / ")} · ${BARS} candles each · ${all.length} alerts · fees 0.1 % round trip.`);
  md.push(`Train = first 70 % of the time (choosing), test = last 30 % (never seen while choosing). Edge = return minus the plain drift of the same coin in the same direction.\n`);

  md.push(`## 1. Current rules — by stars and timeframe (all data)\n\n${HEAD}`);
  for (const s of [3, 4, 5]) md.push(row(`${s}★`, stat(all.filter((e) => e.stars === s))));
  for (const tf of TFS) md.push(row(tf, stat(all.filter((e) => e.tf === tf))));
  for (const d of [1, -1]) md.push(row(d > 0 ? "bullish" : "bearish", stat(all.filter((e) => e.dir === d))));
  md.push(`\nBy holding time (all alerts): ` + HS.map((h) => `${h} candles: avg ${pct(stat(all, h).avg)}, win ${pct(stat(all, h).win, 0)}, edge ${pct(stat(all, h).edge)}`).join(" · "));

  md.push(`\n## 2. Each family alone (train)\n\n${HEAD}`);
  for (const f of S.FAM) md.push(row(f, stat(train.filter((e) => e.fams.includes(f)))));

  const { cands, w, thr } = alternatives(train);
  md.push(`\n## 3. Alternatives — train (choose) → test (simulation)\n\n| method | train alerts | train edge | test alerts | test win | test avg | test edge | test t |\n|---|---|---|---|---|---|---|---|`);
  const res = cands.map((c) => {
    const a = stat(applyRule(train, c)), b = stat(applyRule(test, c));
    md.push(`| ${c[0]} | ${a.n} | ${pct(a.edge)} | ${b.n} | ${pct(b.win, 0)} | ${pct(b.avg)} | ${pct(b.edge)} | ${Number.isFinite(b.t) ? b.t.toFixed(1) : "—"} |`);
    return { name: c[0], train: a, test: b };
  });
  /* the pick: best TRAIN edge among methods with enough alerts (>= 100 train, >= 30 test) */
  const ok = res.filter((r) => r.train.n >= 100 && r.test.n >= 30);
  const pick = ok.sort((a, b) => b.train.edge - a.train.edge)[0];
  const base = res[0];
  md.push(`\nFamily weights learned on train (edge when present): ${Object.entries(w).map(([f, v]) => `${f} ${pct(v)}`).join(" · ")}; top-30 % score threshold ${thr.toFixed(4)}.`);
  md.push(`\n## 4. Verdict\n`);
  md.push(`- Current rules on the test period: ${base.test.n} alerts, win ${pct(base.test.win, 0)}, avg ${pct(base.test.avg)}, edge ${pct(base.test.edge)} (t ${Number.isFinite(base.test.t) ? base.test.t.toFixed(1) : "—"}).`);
  if (pick) md.push(`- Best on train: **${pick.name}** (train edge ${pct(pick.train.edge)}${pick.train.edge > 0 ? "" : " — no method beat the drift even on train"}) → test: ${pick.test.n} alerts, win ${pct(pick.test.win, 0)}, avg ${pct(pick.test.avg)}, edge ${pct(pick.test.edge)} (t ${Number.isFinite(pick.test.t) ? pick.test.t.toFixed(1) : "—"}).`);
  md.push(`- |t| < 2 means the result could be luck.`);
  const text = md.join("\n");
  fs.writeFileSync(path.join(OUT, "report.md"), text);
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ at: Date.now(), coins: coins.length, alerts: all.length, cut, res, w, thr }, null, 1));
  process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  console.log("\n" + text);
})().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
