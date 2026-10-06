/* events.js — FACTS: what just happened on a candle that closed, never a prediction
   (copy of the live scanner's engine file, for backtest/facts.js).

   coin(k, tf)          → facts of the LAST candle of k (closed candles, scanner.closed)
     move   |close / open − 1| ≥ MOVE[tf]
     vol    volume ≥ VOL_X × the average of the 20 candles before, worth ≥ VOL_USD[tf], and price
            moved at least half of MOVE[tf] (a volume spike on a flat candle is noise)
     hi/lo  close above the highest / below the lowest close of the last 1 year / 90 days (1D only)
   Thresholds tuned on 30 days of real candles (coin-data backtest/facts.js, 06/10/2026): the first
   set gave ~43 facts a day (mostly 15m volume spikes on flat candles and repeated 4H 30-day highs).
   market(list, tf)     → one fact when ≥ SHARE of the coins closed the candle the same way and the
                          median move is ≥ MKT[tf]
   capture(klines, tf)  → {klines, rows}: wraps the scanner's kline fetcher and keeps each coin's
                          rows of the scanned timeframe (no extra request: facts use the same candles)
   collect(scan, rows, coins, now) → {coins:[{sym, pair, price, facts}], market}
   apply(state, got, tf, at, now)  → the NEW facts; state.facts (oldest first) and state.factLast
                          (cool-down per coin + timeframe + kind) are updated
   fact = {id, kind:"coin"|"market", sym, pair, tf, at, dir, price, title:{en,vi}, list:[{k, dir, en, vi}]}
          at = close time of the candle (same as stories), id = sym|tf|at ("MKT" for the market) */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./scanner.js") : root.BLSCAN);
  if (node) module.exports = api;
  else root.BLEV = api;
})(typeof self !== "undefined" ? self : this, function (SCAN) {
  "use strict";
  const CFG = {
    MOVE: { "15m": 0.04, "1H": 0.06, "4H": 0.1, "1D": 0.15 },
    VOL_X: 5,
    VOL_USD: { "15m": 5e5, "1H": 2e6, "4H": 5e6, "1D": 2e7 },
    HILO: { "1D": [[365, "1 year", "1 năm"], [90, "90 days", "90 ngày"]] },
    SHARE: 0.8,
    MKT: { "15m": 0.008, "1H": 0.015, "4H": 0.03, "1D": 0.05 },
    MIN_COINS: 20,
    COIN_QV: 2e7, /* coin facts only for coins trading ≥ $20M a day (small coins jump all the time) */
    COOL: { "15m": 4, "1H": 3, "4H": 2, "1D": 1 }, /* same kind on the same coin + timeframe: not again for N candles */
    COOL_HILO: 3 * 864e5, /* a coin making new highs every day of a rally: once in 3 days */
    MAX_RUN: 12, /* coin facts kept per timeframe scan (a crash = one market fact, not 300 coins) */
    KEEP_MS: 48 * 36e5,
    MAX: 400,
  };
  const SPAN = { "15m": ["15 minutes", "15 phút"], "1H": ["1 hour", "1 giờ"], "4H": ["4 hours", "4 giờ"], "1D": ["1 day", "1 ngày"] };
  const RANK = { move: 0, hi: 1, lo: 1, vol: 2 };
  const num = (x, d, vi) => (vi ? x.toFixed(d).replace(".", ",") : x.toFixed(d));
  const pct = (x, vi) => (x >= 0 ? "+" : "−") + num(Math.abs(x) * 100, 1, vi) + "%";

  function coin(k, tf) {
    const i = k.c.length - 1, out = [], [en, vi] = SPAN[tf] || [tf, tf];
    if (i < 21) return out;
    const ch = k.c[i] / k.o[i] - 1;
    if (Math.abs(ch) >= CFG.MOVE[tf])
      out.push({ k: "move", dir: Math.sign(ch), v: ch, en: `${pct(ch)} in ${en}`, vi: `${pct(ch, 1)} trong ${vi}` });
    let avg = 0;
    for (let j = i - 20; j < i; j++) avg += k.v[j];
    avg /= 20;
    const x = avg > 0 ? k.v[i] / avg : 0;
    if (x >= CFG.VOL_X && k.v[i] * k.c[i] >= CFG.VOL_USD[tf] && Math.abs(ch) >= CFG.MOVE[tf] / 2)
      out.push({ k: "vol", dir: Math.sign(ch) || 1, v: x, en: `Volume ${num(x, 1)}× the average of the last 20 candles`, vi: `Khối lượng gấp ${num(x, 1, 1)} lần trung bình 20 nến trước` });
    for (const [n, pen, pvi] of CFG.HILO[tf] || []) {
      if (i < n) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - n; j < i; j++) (hi = Math.max(hi, k.c[j])), (lo = Math.min(lo, k.c[j]));
      if (k.c[i] > hi) { out.push({ k: "hi", dir: 1, v: n, en: `Highest close in ${pen}`, vi: `Giá đóng cao nhất ${pvi}` }); break; }
      if (k.c[i] < lo) { out.push({ k: "lo", dir: -1, v: n, en: `Lowest close in ${pen}`, vi: `Giá đóng thấp nhất ${pvi}` }); break; }
    }
    return out.sort((a, b) => RANK[a.k] - RANK[b.k]);
  }

  /* list = candle moves (close / open − 1) of every coin scanned */
  function market(list, tf) {
    if (list.length < CFG.MIN_COINS) return null;
    const up = list.filter((x) => x > 0).length / list.length, dn = list.filter((x) => x < 0).length / list.length;
    const s = [...list].sort((a, b) => a - b), med = s[s.length >> 1], dir = up >= CFG.SHARE ? 1 : dn >= CFG.SHARE ? -1 : 0;
    if (!dir || med * dir < CFG.MKT[tf]) return null;
    const share = Math.round((dir > 0 ? up : dn) * 100), [en, vi] = SPAN[tf] || [tf, tf];
    return {
      k: "market", dir, v: med, share, coins: list.length,
      en: `${share}% of coins ${dir > 0 ? "rose" : "fell"} in ${en}, typically ${pct(med)}`,
      vi: `${share}% coin ${dir > 0 ? "tăng" : "giảm"} trong ${vi}, phổ biến ${pct(med, 1)}`,
    };
  }

  function capture(klines, tf) {
    const iv = SCAN.TF[tf].iv, rows = new Map();
    return {
      rows,
      klines: async (pair, interval, limit) => {
        const r = await klines(pair, interval, limit);
        if (interval === iv && Array.isArray(r) && !(rows.get(pair) && rows.get(pair).length >= r.length)) rows.set(pair, r);
        return r;
      },
    };
  }

  function collect(scan, rows, coins, now) {
    const ms = SCAN.TF[scan.tf].ms, moves = [], out = [];
    for (const c of coins) {
      const r = rows.get(c.pair);
      if (!r) continue;
      const k = SCAN.closed(r, ms, now), n = k.t.length;
      if (!n || k.t[n - 1] + ms !== scan.at) continue; /* the candle just closed must be there */
      moves.push(k.c[n - 1] / k.o[n - 1] - 1);
      if (c.qv < CFG.COIN_QV) continue;
      const facts = coin(k, scan.tf);
      facts.length && out.push({ sym: c.sym, pair: c.pair, price: k.c[n - 1], facts });
    }
    return { coins: out, market: market(moves, scan.tf) };
  }

  const strength = (f) => (f.k === "move" ? Math.abs(f.v) / 0.05 : f.k === "vol" ? f.v / CFG.VOL_X : 1.5);
  function apply(state, got, tf, at, now) {
    state.facts = state.facts || [];
    state.factLast = state.factLast || {};
    const ms = SCAN.TF[tf].ms, cool = CFG.COOL[tf] * ms, last = state.factLast, fresh = [];
    const take = (sym, f) => {
      const hilo = f.k === "hi" || f.k === "lo", key = sym + "|" + tf + "|" + (hilo ? "hilo" : f.k);
      if (last[key] != null && at - last[key] < (hilo ? CFG.COOL_HILO : cool)) return false;
      last[key] = at;
      return true;
    };
    const make = (kind, sym, pair, price, list) => {
      const head = list[0], name = kind === "market" ? ["Market", "Thị trường"] : [sym, sym];
      return { id: sym + "|" + tf + "|" + at, kind, sym, pair, tf, at, dir: head.dir, price, title: { en: `${name[0]}: ${head.en}`, vi: `${name[1]}: ${head.vi}` }, list };
    };
    if (got.market && take("MKT", got.market)) fresh.push(make("market", "MKT", null, null, [got.market]));
    got.coins
      .map((c) => ({ c, s: Math.max(...c.facts.map(strength)) }))
      .sort((a, b) => b.s - a.s)
      .forEach(({ c }) => {
        if (fresh.filter((f) => f.kind === "coin").length >= CFG.MAX_RUN) return;
        const list = c.facts.filter((f) => take(c.sym, f));
        list.length && fresh.push(make("coin", c.sym, c.pair, c.price, list));
      });
    const have = new Set(state.facts.map((f) => f.id));
    state.facts.push(...fresh.filter((f) => !have.has(f.id)));
    state.facts = state.facts.filter((f) => now - f.at <= CFG.KEEP_MS).slice(-CFG.MAX);
    for (const k in last) now - last[k] > CFG.KEEP_MS && delete last[k];
    return fresh;
  }

  return { CFG, coin, market, capture, collect, apply };
});
