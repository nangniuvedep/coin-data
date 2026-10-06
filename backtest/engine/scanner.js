/* scanner.js — scan one timeframe over the whole coin list at a candle close, and replay history
   for the validation lab. Same code on the server (Worker) and in the browser test page.

   scan({tf, coins, klines, now})   → {tf, at, scanned, skipped, alerts[]}   (at = close time of the candle scanned)
       coins  = [{pair, sym, qv}]  (qv = 24h quote volume, USD)
       klines = async (pair, interval, limit) → Binance kline rows (raw arrays)
   replay(k, htfK, btcHtf, tf)      → every alert the rules would have raised over k, with what
                                      price did in the HOLD candles after it (lab only)
   Spec: HANDOFF-PHAN-TICH-CANH-BAO.md §0.5. */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./signals.js") : root.BLS, node ? require("./indicators.js") : root.BLI);
  if (node) module.exports = api;
  else root.BLSCAN = api;
})(typeof self !== "undefined" ? self : this, function (S, I) {
  "use strict";
  const TF = {
    "15m": { iv: "15m", ms: 9e5, htf: "1H" },
    "1H": { iv: "1h", ms: 36e5, htf: "4H" },
    "4H": { iv: "4h", ms: 144e5, htf: "1D" },
    "1D": { iv: "1d", ms: 864e5, htf: "1W" },
    "1W": { iv: "1w", ms: 6048e5 },
  };
  const LIQ = 5e6, BARS = 600, HTF_BARS = 120, HOLD = 10;
  /* special candles (HANDOFF §0.5 Q): abnormal = range > ABN_ATR × ATR; pump = |close/open − 1| ≥ PUMP_PCT
     on ≥ PUMP_VOL × average volume; rs = move over RS_N candles minus BTC's, in the alert's direction (%) */
  const ABN_ATR = 5, PUMP_PCT = 0.1, PUMP_VOL = 10, RS_N = 3;

  /* raw rows → arrays of CLOSED candles (the forming one is dropped) */
  function closed(rows, ms, now) {
    const k = { t: [], o: [], h: [], l: [], c: [], v: [], tb: [] };
    for (const r of rows) {
      if (r[0] + ms > now) break;
      k.t.push(r[0]); k.o.push(+r[1]); k.h.push(+r[2]); k.l.push(+r[3]); k.c.push(+r[4]); k.v.push(+r[5]); k.tb.push(+r[9]);
    }
    return k;
  }
  /* the last 50 candles must be complete and the newest must be the candle that just closed */
  function intact(k, ms, now) {
    const n = k.t.length;
    if (!n || (ms < 6048e5 && k.t[n - 1] !== Math.floor(now / ms) * ms - ms)) return false;
    for (let i = Math.max(1, n - 50); i < n; i++) if (k.t[i] - k.t[i - 1] !== ms) return false;
    return true;
  }
  /* higher-timeframe trend per candle: 1 up · −1 down · 0 (same rule as signals.trendAt) */
  function trendSeries(k) {
    const e = I.ema(k.c, 50);
    return k.c.map((c, i) => (i < 5 || !Number.isFinite(e[i - 5]) ? 0 : c > e[i] && e[i] > e[i - 5] ? 1 : c < e[i] && e[i] < e[i - 5] ? -1 : 0));
  }

  async function scan({ tf, coins, klines, now = Date.now(), concurrency = 8, ageOk = null }) {
    const T = TF[tf], H = TF[T.htf];
    const htfOf = async (pair) => {
      const k = closed(await klines(pair, H.iv, HTF_BARS), H.ms, now);
      return k.c.length >= 60 ? trendSeries(k).pop() : 0;
    };
    const btc = coins.find((c) => c.sym === "BTC");
    const btcTrend = btc ? await htfOf(btc.pair).catch(() => 0) : 0;
    let btcRet = 0;
    if (btc)
      try {
        const bk = closed(await klines(btc.pair, T.iv, RS_N + 2), T.ms, now), n = bk.c.length;
        btcRet = n > RS_N ? (bk.c[n - 1] / bk.c[n - 1 - RS_N] - 1) * 100 : 0;
      } catch (e) {}
    const alerts = [], skipped = [];
    let scanned = 0, next = 0;
    const one = async (coin) => {
      if (coin.qv < LIQ) return skipped.push([coin.sym, "liquidity"]);
      try {
        if (ageOk && !(await ageOk(coin))) return skipped.push([coin.sym, "age"]); /* listed < 14 days */
        const k = closed(await klines(coin.pair, T.iv, BARS), T.ms, now);
        if (k.c.length < S.MIN_BARS) return skipped.push([coin.sym, "history"]);
        if (!intact(k, T.ms, now)) return skipped.push([coin.sym, "gap"]);
        const P = S.prepare(k), e = k.c.length - 1;
        const a = S.evaluate(P, e, { htf: await htfOf(coin.pair), btc: coin.sym === "BTC" ? null : btcTrend });
        scanned++;
        if (a) {
          const tags = [], rng = k.h[e] - k.l[e], body = Math.abs(k.c[e] / k.o[e] - 1);
          if (rng > ABN_ATR * P.atr[e - 1]) tags.push("abnormal");
          if (body >= PUMP_PCT && k.v[e] >= PUMP_VOL * P.va[e]) tags.push("pump");
          const rs = ((k.c[e] / k.c[e - RS_N] - 1) * 100 - btcRet) * a.dir;
          alerts.push({ sym: coin.sym, pair: coin.pair, tf, price: k.c[e], qv: coin.qv, rs, tags, ...a });
        }
      } catch (err) {
        skipped.push([coin.sym, "error"]);
      }
    };
    await Promise.all([...Array(concurrency)].map(async () => { while (next < coins.length) await one(coins[next++]); }));
    alerts.sort((a, b) => b.stars - a.stars || b.n - a.n);
    return { tf, at: Math.floor(now / T.ms) * T.ms, scanned, skipped, btcTrend, btcRet, alerts };
  }

  /* Lab: every alert over the history of one coin (de-duplicated like the live scan), and what
     price did next: best move in the alert's direction vs worst move against it over HOLD candles,
     and the close HOLD candles later. htfK = higher-timeframe candles of the coin; btcHtf = the
     same for BTC (or null when the coin is BTC). Uses closed candles only. */
  function replay(k, htfK, btcHtf, tf) {
    const T = TF[tf], H = TF[T.htf], P = S.prepare(k), n = k.c.length, out = [], state = {};
    const map = (hk) => {
      if (!hk) return null;
      const tr = trendSeries(hk), at = new Array(n).fill(0);
      for (let i = 0, j = -1; i < n; i++) {
        while (j + 1 < hk.t.length && hk.t[j + 1] + H.ms <= k.t[i] + T.ms) j++;
        at[i] = j >= 0 ? tr[j] : 0;
      }
      return at;
    };
    const htf = map(htfK), bt = map(btcHtf);
    for (let e = S.MIN_BARS - 1; e < n - HOLD; e++) {
      const a = S.evaluate(P, e, { htf: htf[e], btc: bt ? bt[e] : null });
      if (!a || !S.fresh(state, S.key("x", tf, a), a, e)) continue;
      const c0 = k.c[e];
      let best = 0, worst = 0;
      for (let j = e + 1; j <= e + HOLD; j++) {
        const up = k.h[j] / c0 - 1, dn = k.l[j] / c0 - 1;
        best = Math.max(best, a.dir > 0 ? up : -dn);
        worst = Math.max(worst, a.dir > 0 ? -dn : up);
      }
      out.push({ e, t: k.t[e], dir: a.dir, stars: a.stars, best, worst, close: (k.c[e + HOLD] / c0 - 1) * a.dir });
    }
    return out;
  }

  return { TF, LIQ, BARS, HTF_BARS, HOLD, closed, intact, trendSeries, scan, replay };
});
