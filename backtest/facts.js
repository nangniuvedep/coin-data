/* backtest/facts.js — how many FACTS (engine/events.js: big move, volume spike, new high / low,
   market moving together) the live scanner would have sent over the last 30 days, per timeframe and
   per day, with the same coin list rules (USDT, ≥ $5M a day for the market count, ≥ $20M for coin
   facts), cool-downs and per-scan cap. Purpose: check the thresholds do not flood the red count.
   Output: backtest/out/facts.md (+ .json). */
"use strict";
const fs = require("fs"), path = require("path");
const E = require("./engine/events.js"), SCAN = require("./engine/scanner.js");
const HOST = "https://data-api.binance.vision";
const DAYS = 30, MAX_COINS = 500, LIQ = 5e6;
const SKIP = new Set("USDC FDUSD TUSD USDP DAI BUSD USDE USDS USD1 U EUR EURI AEUR XUSD BFUSD PYUSD RLUSD GUSD SUSD FRAX LUSD PAX WBTC WBETH BETH STETH WSTETH CBBTC BTCB PAXG XAUT".split(" "));
const TFS = ["15m", "1H", "4H", "1D"];
const NEED = { "15m": 21, "1H": 21, "4H": 181, "1D": 366 }; /* candles before the one judged */
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
/* the last `n` closed candles, paged backwards */
async function rows(pair, iv, n, end) {
  let out = [], e = end - 1;
  while (out.length < n) {
    const p = await get(`/api/v3/klines?symbol=${pair}&interval=${iv}&limit=1000&endTime=${e}`);
    if (!p.length) break;
    out = p.concat(out);
    e = p[0][0] - 1;
    if (p.length < 1000) break;
  }
  return out.slice(-n);
}
const win = (k, a, b) => { const o = {}; for (const f of ["t", "o", "h", "l", "c", "v", "tb"]) o[f] = k[f].slice(a, b); return o; };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tick = await get("/api/v3/ticker/24hr?type=MINI");
  const coins = tick
    .filter((x) => x.symbol.endsWith("USDT") && +x.quoteVolume >= LIQ && Date.now() - x.closeTime < 2 * 864e5 && !(+x.highPrice <= 1.01 && +x.lowPrice >= 0.99))
    .map((x) => ({ pair: x.symbol, sym: x.symbol.slice(0, -4), qv: +x.quoteVolume }))
    .filter((x) => x.sym && !SKIP.has(x.sym))
    .sort((a, b) => b.qv - a.qv)
    .slice(0, MAX_COINS);
  const md = [`# Facts the scanner would send — last ${DAYS} days\n`,
    `${coins.length} coins (≥ $5M a day; coin facts only ≥ $20M: ${coins.filter((c) => c.qv >= E.CFG.COIN_QV).length}) · thresholds: move ${TFS.map((t) => t + " " + E.CFG.MOVE[t] * 100 + "%").join(", ")} · volume ×${E.CFG.VOL_X} · market ${E.CFG.SHARE * 100}% of coins · cap ${E.CFG.MAX_RUN} coins per scan.\n`,
    `| timeframe | facts in ${DAYS} days | per day (avg) | busiest day | quietest day | market facts | move | volume | high / low | coins involved |`, `|---|---|---|---|---|---|---|---|---|---|`];
  const res = {}, all = [];
  for (const tf of TFS) {
    const ms = SCAN.TF[tf].ms, now = Math.floor(Date.now() / ms) * ms, steps = Math.round((DAYS * 864e5) / ms);
    const K = new Map();
    await pool(coins, 8, async (c) => {
      const r = await rows(c.pair, SCAN.TF[tf].iv, steps + NEED[tf] + 1, now);
      const k = SCAN.closed(r, ms, now);
      k.at = new Map(k.t.map((t, i) => [t, i]));
      K.set(c.pair, k);
    });
    const st = {}, got = [];
    for (let s = steps; s >= 1; s--) {
      const at = now - (s - 1) * ms; /* close time of the candle judged */
      const moves = [], cs = [];
      for (const c of coins) {
        const k = K.get(c.pair);
        if (!k) continue;
        const i = k.at.get(at - ms);
        if (i == null) continue;
        moves.push(k.c[i] / k.o[i] - 1);
        if (c.qv < E.CFG.COIN_QV || i < NEED[tf]) continue;
        const f = E.coin(win(k, i - NEED[tf], i + 1), tf);
        f.length && cs.push({ sym: c.sym, pair: c.pair, price: k.c[i], facts: f });
      }
      got.push(...E.apply(st, { coins: cs, market: E.market(moves, tf) }, tf, at, at));
    }
    const day = new Map();
    for (let d = 0; d < DAYS; d++) day.set(Math.floor(now / 864e5) - d, 0);
    got.forEach((f) => { const d = Math.floor((f.at - 1) / 864e5); day.has(d) && day.set(d, day.get(d) + 1); });
    const per = [...day.values()], kinds = (k) => got.filter((f) => f.list.some((x) => x.k === k || (k === "hilo" && (x.k === "hi" || x.k === "lo")))).length;
    res[tf] = { n: got.length, avg: got.length / DAYS, max: Math.max(...per), min: Math.min(...per), market: got.filter((f) => f.kind === "market").length, move: kinds("move"), vol: kinds("vol"), hilo: kinds("hilo"), coins: new Set(got.filter((f) => f.kind === "coin").map((f) => f.sym)).size };
    const r = res[tf];
    md.push(`| ${tf} | ${r.n} | ${r.avg.toFixed(1)} | ${r.max} | ${r.min} | ${r.market} | ${r.move} | ${r.vol} | ${r.hilo} | ${r.coins} |`);
    all.push(...got);
  }
  const tot = TFS.reduce((s, t) => s + res[t].n, 0);
  md.push(`\n**All timeframes: ${tot} facts in ${DAYS} days ≈ ${(tot / DAYS).toFixed(0)} a day.**\n`);
  md.push(`## Newest 25 (what the pop-up would have shown)\n`);
  all.sort((a, b) => b.at - a.at).slice(0, 25).forEach((f) => md.push(`- ${new Date(f.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${f.tf} · ${f.title.en}${f.list.length > 1 ? " · " + f.list.slice(1).map((x) => x.en).join(" · ") : ""}`));
  const text = md.join("\n");
  fs.writeFileSync(path.join(OUT, "facts.md"), text);
  fs.writeFileSync(path.join(OUT, "facts.json"), JSON.stringify({ at: Date.now(), cfg: E.CFG, res }, null, 1));
  process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  console.log(text);
})().catch((e) => { console.error("failed:", e); process.exit(1); });
