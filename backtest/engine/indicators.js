/* indicators.js — THE one place indicators are computed (server scanner AND browser chart).
   Formulas and defaults follow TradingView (Pine v5 built-ins):
     sma, ema (seeded with the SMA of the first `n` values), rma (Wilder, same seeding),
     rsi 14 (rma of gains/losses), macd 12/26/9, bollinger 20/2 (population stdev),
     atr 14 (rma of true range), dmi/adx 14/14, obv,
     wma, hma 9, vwma 20, stoch 14/3/3, stochRsi 3/3/14/14, cci 20 (hlc3), willr 14, mom 10,
     ao 5/34 (hl2), uo 7/14/28, bbPower 13, ichimoku 9/26/52, sar 0.02/0.02/0.2, mfi 14 (hlc3),
     donchian 20, keltner 20/2 with atr 10, supertrend 10/3   (added 05/10/2026).
   Every function takes plain arrays and returns arrays of the same length; values that are not
   defined yet (warm-up) are NaN. No DOM, no globals: works in Node and in the browser.
   Checked against TA-Lib in test/indicators.test.js (≤ 0.1% after warm-up). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BLI = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const nan = (n) => new Array(n).fill(NaN);

  function sma(src, n) {
    const out = nan(src.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!Number.isFinite(v)) { sum = 0; cnt = 0; continue; }
      sum += v; cnt++;
      if (cnt > n) sum -= src[i - n];
      if (cnt >= n) out[i] = sum / n;
    }
    return out;
  }

  /* exponential average with smoothing alpha, seeded with the SMA of the first n valid values */
  function smooth(src, n, alpha) {
    const out = nan(src.length);
    let prev = NaN, sum = 0, cnt = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (!Number.isFinite(v)) continue;
      if (Number.isNaN(prev)) {
        sum += v; cnt++;
        if (cnt === n) out[i] = prev = sum / n;
      } else out[i] = prev = alpha * v + (1 - alpha) * prev;
    }
    return out;
  }
  const ema = (src, n) => smooth(src, n, 2 / (n + 1));
  const rma = (src, n) => smooth(src, n, 1 / n);

  function stdev(src, n) {
    const m = sma(src, n), out = nan(src.length);
    for (let i = n - 1; i < src.length; i++) {
      if (!Number.isFinite(m[i])) continue;
      let s = 0;
      for (let k = i - n + 1; k <= i; k++) s += (src[k] - m[i]) ** 2;
      out[i] = Math.sqrt(s / n);
    }
    return out;
  }

  function rsi(close, n = 14) {
    const up = nan(close.length), dn = nan(close.length);
    for (let i = 1; i < close.length; i++) {
      const d = close[i] - close[i - 1];
      up[i] = Math.max(d, 0);
      dn[i] = Math.max(-d, 0);
    }
    const u = rma(up, n), d = rma(dn, n);
    return u.map((x, i) => (Number.isFinite(x) ? (d[i] === 0 ? 100 : x === 0 ? 0 : 100 - 100 / (1 + x / d[i])) : NaN));
  }

  function macd(close, fast = 12, slow = 26, sig = 9) {
    const f = ema(close, fast), s = ema(close, slow);
    const line = f.map((x, i) => x - s[i]);
    const signal = ema(line, sig);
    return { line, signal, hist: line.map((x, i) => x - signal[i]) };
  }

  function bollinger(close, n = 20, mult = 2) {
    const mid = sma(close, n), sd = stdev(close, n);
    const upper = mid.map((m, i) => m + mult * sd[i]), lower = mid.map((m, i) => m - mult * sd[i]);
    return { mid, upper, lower, width: mid.map((m, i) => (upper[i] - lower[i]) / m) };
  }

  function trueRange(high, low, close) {
    return high.map((h, i) => (i === 0 ? h - low[i] : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]))));
  }
  const atr = (high, low, close, n = 14) => rma(trueRange(high, low, close), n);

  /* Pine ta.dmi(diLength, adxSmoothing) → +DI, −DI, ADX */
  function dmi(high, low, close, n = 14, smoothing = 14) {
    const len = high.length, pdm = nan(len), mdm = nan(len);
    for (let i = 1; i < len; i++) {
      const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
      pdm[i] = up > down && up > 0 ? up : 0;
      mdm[i] = down > up && down > 0 ? down : 0;
    }
    const tr = trueRange(high, low, close);
    tr[0] = NaN; /* first bar has no previous close: start with the DM series */
    const trur = rma(tr, n), p = rma(pdm, n), m = rma(mdm, n);
    const plus = p.map((x, i) => (100 * x) / trur[i]), minus = m.map((x, i) => (100 * x) / trur[i]);
    const dx = plus.map((x, i) => {
      const s = x + minus[i];
      return Number.isFinite(s) ? Math.abs(x - minus[i]) / (s === 0 ? 1 : s) : NaN;
    });
    return { plus, minus, adx: rma(dx, smoothing).map((x) => 100 * x) };
  }

  function obv(close, volume) {
    const out = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) out[i] = out[i - 1] + Math.sign(close[i] - close[i - 1]) * volume[i];
    return out;
  }

  /* swing points: bar i is a swing high if its high is above the `k` bars on each side
     (known only k bars later). Returns arrays of {i, p}. */
  function swings(high, low, k = 3) {
    const hi = [], lo = [];
    for (let i = k; i < high.length - k; i++) {
      let H = true, Lo = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (high[j] >= high[i]) H = false;
        if (low[j] <= low[i]) Lo = false;
      }
      if (H) hi.push({ i, p: high[i] });
      if (Lo) lo.push({ i, p: low[i] });
    }
    return { hi, lo };
  }

  /* ── added 05/10/2026: everything TradingView's Technical Ratings and the chart need ── */
  function highest(src, n) {
    const out = nan(src.length);
    for (let i = n - 1; i < src.length; i++) { let m = -Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.max(m, src[k]); out[i] = m; }
    return out;
  }
  function lowest(src, n) {
    const out = nan(src.length);
    for (let i = n - 1; i < src.length; i++) { let m = Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.min(m, src[k]); out[i] = m; }
    return out;
  }
  /* linearly weighted MA, weights 1..n (Pine ta.wma) */
  function wma(src, n) {
    const out = nan(src.length), den = (n * (n + 1)) / 2;
    for (let i = n - 1; i < src.length; i++) {
      let s = 0, ok = true;
      for (let k = 0; k < n; k++) { const v = src[i - k]; if (!Number.isFinite(v)) { ok = false; break; } s += v * (n - k); }
      if (ok) out[i] = s / den;
    }
    return out;
  }
  /* Hull MA (Pine ta.hma): wma(2·wma(n/2) − wma(n), round(√n)) */
  function hma(src, n = 9) {
    const a = wma(src, Math.floor(n / 2)), b = wma(src, n);
    return wma(a.map((x, i) => 2 * x - b[i]), Math.round(Math.sqrt(n)));
  }
  /* volume-weighted MA (Pine ta.vwma) */
  function vwma(src, vol, n = 20) {
    const a = sma(src.map((x, i) => x * vol[i]), n), b = sma(vol, n);
    return a.map((x, i) => x / b[i]);
  }
  /* %K of (src) in its n-bar high-low range */
  function stochRaw(src, high, low, n) {
    const hh = highest(high, n), ll = lowest(low, n);
    return src.map((x, i) => (Number.isFinite(hh[i]) ? (hh[i] === ll[i] ? NaN : (100 * (x - ll[i])) / (hh[i] - ll[i])) : NaN));
  }
  /* Stochastic 14/3/3 (TradingView default): K = sma(raw %K, 3), D = sma(K, 3) */
  function stoch(high, low, close, n = 14, smoothK = 3, smoothD = 3) {
    const k = sma(stochRaw(close, high, low, n), smoothK);
    return { k, d: sma(k, smoothD) };
  }
  /* Stochastic RSI 3/3/14/14: stoch of RSI(14) over 14, K = sma 3, D = sma 3 */
  function stochRsi(close, lenRsi = 14, lenStoch = 14, smoothK = 3, smoothD = 3) {
    const r = rsi(close, lenRsi), k = sma(stochRaw(r, r, r, lenStoch), smoothK);
    return { k, d: sma(k, smoothD) };
  }
  /* CCI 20 on hlc3: (tp − sma) / (0.015 · mean deviation) */
  function cci(high, low, close, n = 20) {
    const tp = close.map((c, i) => (high[i] + low[i] + c) / 3), m = sma(tp, n), out = nan(tp.length);
    for (let i = n - 1; i < tp.length; i++) {
      if (!Number.isFinite(m[i])) continue;
      let d = 0;
      for (let k = i - n + 1; k <= i; k++) d += Math.abs(tp[k] - m[i]);
      d /= n;
      out[i] = d === 0 ? 0 : (tp[i] - m[i]) / (0.015 * d);
    }
    return out;
  }
  /* Williams %R 14: −100 · (highest high − close) / (highest high − lowest low) */
  function willr(high, low, close, n = 14) {
    const hh = highest(high, n), ll = lowest(low, n);
    return close.map((c, i) => (Number.isFinite(hh[i]) ? (hh[i] === ll[i] ? NaN : (-100 * (hh[i] - c)) / (hh[i] - ll[i])) : NaN));
  }
  const mom = (src, n = 10) => src.map((x, i) => (i >= n ? x - src[i - n] : NaN));
  /* Awesome Oscillator: sma(hl2, 5) − sma(hl2, 34) */
  function ao(high, low) {
    const hl2 = high.map((h, i) => (h + low[i]) / 2), a = sma(hl2, 5), b = sma(hl2, 34);
    return a.map((x, i) => x - b[i]);
  }
  /* Ultimate Oscillator 7/14/28 (Larry Williams; same as TA-Lib ULTOSC) */
  function uo(high, low, close, a = 7, b = 14, c = 28) {
    const len = close.length, bp = nan(len), tr = nan(len);
    for (let i = 1; i < len; i++) {
      const lo = Math.min(low[i], close[i - 1]), hi = Math.max(high[i], close[i - 1]);
      bp[i] = close[i] - lo; tr[i] = hi - lo;
    }
    const avg = (n) => { const s1 = sma(bp, n), s2 = sma(tr, n); return s1.map((x, i) => x / s2[i]); };
    const A = avg(a), B = avg(b), C = avg(c);
    return A.map((x, i) => (100 * (4 * x + 2 * B[i] + C[i])) / 7);
  }
  /* Elder's Bull / Bear power 13: high − ema(close), low − ema(close) */
  function bbPower(high, low, close, n = 13) {
    const e = ema(close, n);
    return { bull: high.map((h, i) => h - e[i]), bear: low.map((l, i) => l - e[i]) };
  }
  /* Ichimoku 9/26/52, values AT each bar (not shifted); the chart draws spans A/B 26 bars ahead */
  function ichimoku(high, low, conv = 9, base = 26, spanB = 52) {
    const mid = (n) => { const hh = highest(high, n), ll = lowest(low, n); return hh.map((x, i) => (x + ll[i]) / 2); };
    const c = mid(conv), b = mid(base);
    return { conv: c, base: b, spanA: c.map((x, i) => (x + b[i]) / 2), spanB: mid(spanB) };
  }
  /* Parabolic SAR 0.02 / 0.02 / 0.2 — Wilder's rules, started exactly like TA-Lib (direction from
     the first two bars' −DM, output from bar 1) */
  function sar(high, low, start = 0.02, inc = 0.02, max = 0.2) {
    const len = high.length, out = nan(len);
    if (len < 2) return out;
    const dp = high[1] - high[0], dm = low[0] - low[1];
    let isLong = !(dm > 0 && dp < dm), af = start, ep, s;
    let newHigh = high[0], newLow = low[0];
    if (isLong) { ep = high[1]; s = newLow; } else { ep = low[1]; s = newHigh; }
    newLow = low[1]; newHigh = high[1];
    for (let t = 1; t < len; t++) {
      const prevLow = newLow, prevHigh = newHigh;
      newLow = low[t]; newHigh = high[t];
      if (isLong) {
        if (newLow <= s) {
          isLong = false; s = ep;
          if (s < prevHigh) s = prevHigh;
          if (s < newHigh) s = newHigh;
          out[t] = s; af = start; ep = newLow;
          s = s + af * (ep - s);
          if (s < prevHigh) s = prevHigh;
          if (s < newHigh) s = newHigh;
        } else {
          out[t] = s;
          if (newHigh > ep) { ep = newHigh; af = Math.min(af + inc, max); }
          s = s + af * (ep - s);
          if (s > prevLow) s = prevLow;
          if (s > newLow) s = newLow;
        }
      } else if (newHigh >= s) {
        isLong = true; s = ep;
        if (s > prevLow) s = prevLow;
        if (s > newLow) s = newLow;
        out[t] = s; af = start; ep = newHigh;
        s = s + af * (ep - s);
        if (s > prevLow) s = prevLow;
        if (s > newLow) s = newLow;
      } else {
        out[t] = s;
        if (newLow < ep) { ep = newLow; af = Math.min(af + inc, max); }
        s = s + af * (ep - s);
        if (s < prevHigh) s = prevHigh;
        if (s < newHigh) s = newHigh;
      }
    }
    return out;
  }
  /* Money Flow Index 14 on hlc3 */
  function mfi(high, low, close, volume, n = 14) {
    const tp = close.map((c, i) => (high[i] + low[i] + c) / 3), len = tp.length, pos = nan(len), neg = nan(len);
    for (let i = 1; i < len; i++) {
      const f = tp[i] * volume[i];
      pos[i] = tp[i] > tp[i - 1] ? f : 0;
      neg[i] = tp[i] < tp[i - 1] ? f : 0;
    }
    const out = nan(len);
    for (let i = n; i < len; i++) {
      let p = 0, m = 0;
      for (let k = i - n + 1; k <= i; k++) { p += pos[k]; m += neg[k]; }
      out[i] = m === 0 ? 100 : 100 - 100 / (1 + p / m);
    }
    return out;
  }
  function donchian(high, low, n = 20) {
    const upper = highest(high, n), lower = lowest(low, n);
    return { upper, lower, mid: upper.map((x, i) => (x + lower[i]) / 2) };
  }
  /* Keltner (TradingView default): ema(close, 20) ± 2 · atr(10) */
  function keltner(high, low, close, n = 20, mult = 2, atrLen = 10) {
    const mid = ema(close, n), a = atr(high, low, close, atrLen);
    return { mid, upper: mid.map((m, i) => m + mult * a[i]), lower: mid.map((m, i) => m - mult * a[i]) };
  }
  /* Supertrend — direct port of TradingView's reference pine_supertrend(3, 10) (Pine manual,
     ta.supertrend). Returns the line and the direction, 1 = up (line under price), −1 = down. */
  function supertrend(high, low, close, atrLen = 10, factor = 3) {
    const a = atr(high, low, close, atrLen), len = close.length, line = nan(len), dir = nan(len);
    let pUp = NaN, pLo = NaN, pST = NaN;
    for (let i = 0; i < len; i++) {
      const hl2 = (high[i] + low[i]) / 2;
      let up = hl2 + factor * a[i], lo = hl2 - factor * a[i];
      if (!Number.isFinite(a[i])) { pUp = up; pLo = lo; continue; }
      const prevLo = Number.isFinite(pLo) ? pLo : 0, prevUp = Number.isFinite(pUp) ? pUp : 0;
      lo = lo > prevLo || close[i - 1] < prevLo ? lo : prevLo;
      up = up < prevUp || close[i - 1] > prevUp ? up : prevUp;
      let d; /* Pine: −1 = uptrend */
      if (!Number.isFinite(a[i - 1])) d = 1;
      else if (pST === pUp) d = close[i] > up ? -1 : 1;
      else d = close[i] < lo ? 1 : -1;
      const st = d === -1 ? lo : up;
      line[i] = st; dir[i] = -d;
      pUp = up; pLo = lo; pST = st;
    }
    return { line, dir };
  }

  return { sma, ema, rma, stdev, rsi, macd, bollinger, trueRange, atr, dmi, obv, swings,
    highest, lowest, wma, hma, vwma, stoch, stochRsi, cci, willr, mom, ao, uo, bbPower, ichimoku, sar, mfi, donchian, keltner, supertrend };
});
