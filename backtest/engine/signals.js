/* signals.js — technical alert engine (spec: HANDOFF-PHAN-TICH-CANH-BAO.md §0.5, approved 2026-10-04).
   Runs the same in the server scanner and in the browser. Uses ONLY indicators.js.

   prepare(k)                k = {t,o,h,l,c,v,tb} arrays of CLOSED candles → series P (all indicators once)
   eventsAt(P, i)            technical events on candle i, both directions: [{f, d, id, en, vi}]
   trendAt(P, i)             higher-timeframe trend at i: 1 up · −1 down · 0 neither
   evaluate(P, e, ctx)       alert for candle e or null: {dir, stars, fams, reasons, title, t}
                             ctx = {htf: −1|0|1, btc: −1|0|1 or null (this coin IS btc), liquid: bool}
   key(sym, tf, a) / fresh(state, k, a)   one alert per coin+timeframe+direction until it upgrades or resets

   An alert describes technical facts only: no buy/sell, no entry, no stop, no target. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./indicators.js") : root.BLI);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BLS = api;
})(typeof self !== "undefined" ? self : this, function (I) {
  "use strict";
  /* the six families: each counts ONCE, whatever number of its events fired */
  const FAM = ["momentum", "volume", "price", "trend", "volatility", "divergence"];
  /* thresholds (spec §0.5); the validation lab may change them to calibrate, then they are written back here */
  const CFG = { WINDOW: 3, VOL_X: 2, TAKER: 0.6, SQUEEZE_PCT: 0.2, SQUEEZE_LOOK: 5, STRETCH_RSI: 75, STRETCH_ATR: 3 };
  const MIN_BARS = 300;
  const fmt = (p) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p >= 0.01 ? p.toFixed(4) : p.toPrecision(3));
  const fv = (p) => fmt(p).replace(".", ","); /* Vietnamese decimal comma */
  const r0 = (x) => Math.round(x);

  function prepare(k) {
    const { c, h, l, v } = k, n = c.length;
    const md = I.macd(c), bb = I.bollinger(c, 20, 2), dm = I.dmi(h, l, c, 14, 14);
    /* bandwidth percentile vs the previous 100 candles (0 = narrowest) */
    const bwp = new Array(n).fill(NaN);
    for (let i = 100; i < n; i++) {
      let below = 0, cnt = 0;
      for (let j = i - 100; j < i; j++) if (Number.isFinite(bb.width[j])) (cnt++, bb.width[j] < bb.width[i] && below++);
      if (cnt) bwp[i] = below / cnt;
    }
    /* average volume of the 20 candles BEFORE i */
    const va = new Array(n).fill(NaN);
    for (let i = 20, s = 0; i < n; i++) {
      if (i === 20) for (let j = 0; j < 20; j++) s += v[j];
      else s += v[i - 1] - v[i - 21];
      va[i] = s / 20;
    }
    const sw = I.swings(h, l, 3), pv = I.swings(h, l, 2);
    return {
      k, n,
      rsi: I.rsi(c, 14), macd: md.line, sig: md.signal,
      sma20: I.sma(c, 20), sma50: I.sma(c, 50), ema20: I.ema(c, 20), ema50: I.ema(c, 50), ema200: I.ema(c, 200),
      adx: dm.adx, pdi: dm.plus, mdi: dm.minus, atr: I.atr(h, l, c, 14),
      bbu: bb.upper, bbl: bb.lower, bwp, va,
      swHi: sw.hi, swLo: sw.lo, pvHi: pv.hi, pvLo: pv.lo, /* swing = 3 bars each side; pivot = 2 */
    };
  }

  /* nearest swing high above `ref` / low below `ref`, known (confirmed) by candle i, within 100 candles */
  function level(list, i, ref, above) {
    let best = NaN;
    for (const s of list) {
      if (s.i + 3 > i || s.i < i - 100) continue;
      if (above ? s.p >= ref && !(s.p >= best) : s.p <= ref && !(s.p <= best)) best = s.p;
    }
    return best;
  }
  const crossUp = (a, b, i) => a[i - 1] < b(i - 1) && a[i] >= b(i);
  const crossDn = (a, b, i) => a[i - 1] > b(i - 1) && a[i] <= b(i);
  const at = (x) => () => x;

  function eventsAt(P, i) {
    const { c, o, h, l, v, tb } = P.k, out = [];
    if (i < 1 || i >= P.n) return out;
    const ev = (f, d, id, en, vi) => out.push({ f, d, id, en, vi });
    const rs = P.rsi, R1 = r0(rs[i - 1]), R2 = r0(rs[i]);
    /* 1 momentum */
    if (crossUp(rs, at(50), i)) ev("momentum", 1, "rsi50", `RSI crossed above 50 (${R1} → ${R2})`, `RSI cắt lên trên 50 (${R1} → ${R2})`);
    if (crossUp(rs, at(30), i)) ev("momentum", 1, "rsi30", `RSI left oversold, crossed above 30 (${R1} → ${R2})`, `RSI thoát quá bán, cắt lên 30 (${R1} → ${R2})`);
    if (crossDn(rs, at(50), i)) ev("momentum", -1, "rsi50", `RSI crossed below 50 (${R1} → ${R2})`, `RSI cắt xuống dưới 50 (${R1} → ${R2})`);
    if (crossDn(rs, at(70), i)) ev("momentum", -1, "rsi70", `RSI left overbought, crossed below 70 (${R1} → ${R2})`, `RSI rời vùng quá mua, cắt xuống 70 (${R1} → ${R2})`);
    if (crossUp(P.macd, (j) => P.sig[j], i)) ev("momentum", 1, "macd", "MACD crossed above its signal line", "MACD cắt lên đường tín hiệu");
    if (crossDn(P.macd, (j) => P.sig[j], i)) ev("momentum", -1, "macd", "MACD crossed below its signal line", "MACD cắt xuống đường tín hiệu");
    /* 2 volume (needs taker-buy volume for the buyer/seller share; without it only the spike counts) */
    const avg = P.va[i], x = v[i] / avg, share = tb && v[i] ? tb[i] / v[i] : NaN;
    if (avg > 0) {
      const spike = x >= CFG.VOL_X, sx = x.toFixed(1).replace(".", ","), sxe = x.toFixed(1);
      const pct = Number.isFinite(share) ? Math.round(share * 100) : null;
      if ((spike && c[i] > o[i]) || (share >= CFG.TAKER && x >= 1))
        ev("volume", 1, "vol", `Volume ${sxe}× its 20-candle average${pct != null ? `, buyers ${pct}%` : ""}`, `Khối lượng gấp ${sx} lần trung bình 20 nến${pct != null ? `, lực mua chủ động ${pct}%` : ""}`);
      if ((spike && c[i] < o[i]) || (share <= 1 - CFG.TAKER && x >= 1))
        ev("volume", -1, "vol", `Volume ${sxe}× its 20-candle average${pct != null ? `, sellers ${100 - pct}%` : ""}`, `Khối lượng gấp ${sx} lần trung bình 20 nến${pct != null ? `, lực bán chủ động ${100 - pct}%` : ""}`);
    }
    /* 3 price structure */
    const res = level(P.swHi, i - 1, c[i - 1], true), sup = level(P.swLo, i - 1, c[i - 1], false);
    if (c[i] > res) ev("price", 1, "res", `Closed above resistance ${fmt(res)}`, `Giá đóng trên kháng cự ${fv(res)}`);
    if (c[i] < sup) ev("price", -1, "sup", `Closed below support ${fmt(sup)}`, `Giá đóng dưới hỗ trợ ${fv(sup)}`);
    if (i >= 21) {
      let hi = -Infinity, lo = Infinity, hi1 = -Infinity, lo1 = Infinity;
      for (let j = i - 20; j < i; j++) (hi = Math.max(hi, h[j])), (lo = Math.min(lo, l[j]));
      for (let j = i - 21; j < i - 1; j++) (hi1 = Math.max(hi1, h[j])), (lo1 = Math.min(lo1, l[j]));
      if (c[i] > hi && c[i - 1] <= hi1) ev("price", 1, "hi20", `Broke the 20-candle high ${fmt(hi)}`, `Phá đỉnh 20 nến ${fv(hi)}`);
      if (c[i] < lo && c[i - 1] >= lo1) ev("price", -1, "lo20", `Broke the 20-candle low ${fmt(lo)}`, `Thủng đáy 20 nến ${fv(lo)}`);
    }
    /* 4 trend */
    if (crossUp(P.sma20, (j) => P.sma50[j], i)) ev("trend", 1, "ma", "MA20 crossed above MA50", "MA20 vừa cắt lên MA50");
    if (crossDn(P.sma20, (j) => P.sma50[j], i)) ev("trend", -1, "ma", "MA20 crossed below MA50", "MA20 vừa cắt xuống MA50");
    if (c[i - 1] <= P.ema200[i - 1] && c[i] > P.ema200[i]) ev("trend", 1, "e200", "Closed above EMA200", "Giá đóng trên EMA200");
    if (c[i - 1] >= P.ema200[i - 1] && c[i] < P.ema200[i]) ev("trend", -1, "e200", "Closed below EMA200", "Giá đóng dưới EMA200");
    if (P.adx[i - 1] < 25 && P.adx[i] >= 25) {
      const A = r0(P.adx[i]);
      if (P.pdi[i] > P.mdi[i]) ev("trend", 1, "adx", `ADX rose above 25 (${A}), buyers lead`, `ADX vượt 25 (${A}), phe mua dẫn`);
      else ev("trend", -1, "adx", `ADX rose above 25 (${A}), sellers lead`, `ADX vượt 25 (${A}), phe bán dẫn`);
    }
    /* 5 volatility: a squeeze in the 5 candles before, then a close outside the band */
    let squeezed = false;
    for (let j = i - CFG.SQUEEZE_LOOK; j < i; j++) if (P.bwp[j] <= CFG.SQUEEZE_PCT) squeezed = true;
    if (squeezed && c[i] > P.bbu[i]) ev("volatility", 1, "bb", "Broke out of a squeeze above the upper Bollinger band", "Thoát nén, đóng trên dải Bollinger trên");
    if (squeezed && c[i] < P.bbl[i]) ev("volatility", -1, "bb", "Broke out of a squeeze below the lower Bollinger band", "Thoát nén, đóng dưới dải Bollinger dưới");
    /* 6 divergence: a pivot (2 candles each side) confirmed now, compared with the previous one 5–40 candles earlier */
    const piv = (list, d) => {
      const p = list.find((s) => s.i === i - 2);
      if (!p) return;
      let q = null;
      for (const s of list) if (s.i >= p.i - 40 && s.i <= p.i - 5) q = s;
      if (!q) return;
      if (d > 0 && p.p < q.p && rs[p.i] > rs[q.i] && rs[p.i] < 40)
        ev("divergence", 1, "div", `Bullish RSI divergence: lower low, higher RSI (${r0(rs[q.i])} → ${r0(rs[p.i])})`, `Phân kỳ tăng RSI: giá đáy thấp hơn, RSI đáy cao hơn (${r0(rs[q.i])} → ${r0(rs[p.i])})`);
      if (d < 0 && p.p > q.p && rs[p.i] < rs[q.i] && rs[p.i] > 60)
        ev("divergence", -1, "div", `Bearish RSI divergence: higher high, lower RSI (${r0(rs[q.i])} → ${r0(rs[p.i])})`, `Phân kỳ giảm RSI: giá đỉnh cao hơn, RSI đỉnh thấp hơn (${r0(rs[q.i])} → ${r0(rs[p.i])})`);
    };
    piv(P.pvLo, 1);
    piv(P.pvHi, -1);
    return out;
  }

  function trendAt(P, i) {
    const c = P.k.c[i], e = P.ema50;
    if (!(i >= 5) || !Number.isFinite(e[i - 5])) return 0;
    if (c > e[i] && e[i] > e[i - 5]) return 1;
    if (c < e[i] && e[i] < e[i - 5]) return -1;
    return 0;
  }
  const stretched = (P, e, d) =>
    d > 0
      ? P.rsi[e] >= CFG.STRETCH_RSI || P.k.c[e] - P.ema20[e] >= CFG.STRETCH_ATR * P.atr[e]
      : P.rsi[e] <= 100 - CFG.STRETCH_RSI || P.ema20[e] - P.k.c[e] >= CFG.STRETCH_ATR * P.atr[e];

  function evaluate(P, e, ctx = {}) {
    if (e < MIN_BARS - 1 || e >= P.n || !Number.isFinite(P.ema200[e]) || ctx.liquid === false) return null;
    /* events of the last WINDOW candles; at least one must be on candle e itself */
    const byDir = { 1: new Map(), "-1": new Map() }, now = { 1: false, "-1": false };
    const cache = P._ev || (P._ev = []);
    for (let i = e; i > e - CFG.WINDOW; i--)
      for (const x of cache[i] || (cache[i] = eventsAt(P, i))) {
        const m = byDir[x.d];
        if (!m.has(x.f)) m.set(x.f, []);
        m.get(x.f).push(x);
        if (i === e) now[x.d] = true;
      }
    const n1 = byDir[1].size, n2 = byDir[-1].size;
    const dir = n1 > n2 ? 1 : n2 > n1 ? -1 : 0;
    if (!dir || !now[dir]) return null;
    const fams = byDir[dir], n = fams.size, has = (f) => fams.has(f);
    const htfOk = ctx.htf === dir, btcOk = ctx.btc == null || ctx.btc === dir, calm = !stretched(P, e, dir);
    let stars = 0;
    if (n >= 3) stars = 3;
    if (stars && has("volume") && (has("price") || has("trend")) && htfOk) stars = 4;
    if (stars === 4 && n >= 4 && has("price") && btcOk && calm) stars = 5;
    if (!stars) return null;
    /* reasons: newest event of each family, in family order; then the context that holds */
    const reasons = FAM.filter(has).map((f) => fams.get(f)[0]);
    if (htfOk) reasons.push({ f: "context", en: `Higher timeframe trending ${dir > 0 ? "up" : "down"} too`, vi: `Khung lớn cùng xu hướng ${dir > 0 ? "tăng" : "giảm"}` });
    if (ctx.btc != null && btcOk) reasons.push({ f: "context", en: `BTC trending ${dir > 0 ? "up" : "down"}`, vi: `BTC cùng chiều ${dir > 0 ? "tăng" : "giảm"}` });
    return {
      dir, stars, n, fams: [...fams.keys()], reasons, t: P.k.t ? P.k.t[e] : e,
      title: { en: `${n} ${dir > 0 ? "bullish" : "bearish"} signals together`, vi: `${n} tín hiệu ${dir > 0 ? "tăng" : "giảm"} cùng lúc` },
    };
  }

  /* one alert per coin + timeframe + direction: again only when the stars go UP, or after the
     setup has disappeared (no alert of that direction) for at least one candle */
  const key = (sym, tf, a) => sym + "|" + tf + "|" + a.dir;
  function fresh(state, k, a, bar) {
    const s = state[k];
    const ok = !s || a.stars > s.stars || bar - s.bar > 1;
    state[k] = { stars: ok ? a.stars : Math.max(s.stars, a.stars), bar };
    return ok;
  }

  return { FAM, CFG, MIN_BARS, prepare, eventsAt, trendAt, evaluate, key, fresh, stretched };
});
