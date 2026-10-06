# checkcoin — backtest

85 coins (24h volume ≥ 5 M USD) · 1H 4000 / 4H 3000 / 1D 1000 candles · 44456 alerts · fees 0.1 % round trip · 2024-11-05 → 2026-10-05.
Walk-forward: 5 folds of equal time on each timeframe; train = folds 1-3 (choosing), test = folds 4-5 (never seen while choosing). Edge = return minus the plain drift of the same coin in the same direction.

## 1. Current rules — by stars and timeframe (all data)

| | alerts | win | avg return (10 candles, after fees) | edge vs drift | t |
|---|---|---|---|---|---|
| 3★ | 27426 | 44% | -0.12% | -0.12% | -2.7 |
| 4★ | 13440 | 45% | -0.01% | -0.03% | -0.6 |
| 5★ | 3590 | 43% | -0.18% | -0.22% | -2.2 |
| 1H | 26771 | 43% | -0.18% | -0.18% | -8.6 |
| 4H | 15079 | 46% | -0.02% | -0.03% | -0.5 |
| 1D | 2606 | 48% | 0.40% | 0.35% | 0.9 |
| bullish | 22031 | 43% | 0.07% | -0.06% | -1.0 |
| bearish | 22425 | 46% | -0.25% | -0.15% | -3.8 |

By holding time (all alerts): 5 candles: avg -0.10%, win 44%, edge -0.11% · 10 candles: avg -0.09%, win 44%, edge -0.10% · 20 candles: avg 0.05%, win 46%, edge 0.03%

## 2. Each family alone (train)

| | alerts | win | avg return (10 candles, after fees) | edge vs drift | t |
|---|---|---|---|---|---|
| momentum | 12772 | 46% | -0.11% | -0.11% | -1.5 |
| volume | 12717 | 45% | -0.13% | -0.13% | -1.8 |
| price | 16189 | 46% | -0.12% | -0.12% | -1.8 |
| trend | 7569 | 46% | -0.19% | -0.19% | -2.0 |
| volatility | 6390 | 45% | -0.24% | -0.24% | -2.6 |
| divergence | 703 | 47% | -0.51% | -0.51% | -1.6 |

## 3. Alternatives — train (choose) → test (simulation)

| method | train alerts | train edge | test alerts | test win | test avg | test edge | test t | folds won (edge > 0) | edge per fold |
|---|---|---|---|---|---|---|---|---|---|
| current: all alerts (3★+) | 17166 | -0.13% | 27290 | 44% | -0.07% | -0.08% | -2.2 | 1/5 | 2.6% · -0.1% · -0.3% · -0.1% · -0.1% |
| current: 4★+ | 6539 | -0.25% | 10491 | 44% | 0.08% | 0.04% | 0.6 | 2/5 | 1.5% · -0.3% · -0.3% · -0.0% · 0.1% |
| current: 5★ | 1450 | -0.45% | 2140 | 43% | 0.01% | -0.06% | -0.5 | 1/5 | 1.6% · -0.2% · -0.6% · -0.1% · -0.1% |
| trend-aligned (higher TF + EMA200 side) | 8326 | -0.20% | 13096 | 44% | 0.01% | -0.03% | -0.6 | 1/5 | 0.8% · -0.4% · -0.2% · -0.0% · -0.0% |
| trend-aligned + not stretched | 7714 | -0.09% | 12273 | 44% | -0.02% | -0.06% | -1.1 | 1/5 | 0.5% · -0.2% · -0.1% · -0.0% · -0.1% |
| trend-aligned + ADX > 20 | 5011 | -0.30% | 7522 | 43% | -0.02% | -0.08% | -1.0 | 1/5 | 1.2% · -0.9% · -0.2% · -0.1% · -0.1% |
| with BTC + higher TF | 6008 | -0.20% | 8976 | 44% | 0.14% | 0.08% | 1.2 | 3/5 | 0.7% · -0.4% · -0.2% · 0.0% · 0.1% |
| only bullish alerts | 7979 | -0.36% | 14052 | 44% | 0.26% | 0.12% | 2.0 | 2/5 | 4.1% · -0.3% · -0.8% · -0.3% · 0.5% |
| only bearish alerts | 9187 | 0.07% | 13238 | 44% | -0.42% | -0.30% | -6.7 | 3/5 | 1.0% · -0.0% · 0.0% · 0.2% · -0.8% |
| fade (opposite direction) — all | 17166 | -0.07% | 27290 | 52% | -0.13% | -0.12% | -3.1 | 1/5 | -2.8% · -0.1% · 0.1% · -0.1% · -0.1% |
| fade — stretched alerts only | 893 | 1.06% | 1256 | 53% | -0.46% | -0.35% | -1.4 | 3/5 | -8.4% · 2.1% · 1.5% · 0.2% · -0.8% |
| fade — against higher TF only | 8773 | -0.14% | 14142 | 52% | -0.07% | -0.08% | -1.5 | 1/5 | -4.4% · -0.3% · 0.3% · -0.1% · -0.1% |
| trend-follow: 4H/1D, higher TF + EMA200 side + price breakout | 4103 | -0.22% | 4063 | 48% | 0.26% | 0.17% | 1.2 | 2/5 | 1.2% · -0.5% · -0.3% · 0.5% · -0.2% |
| breakout + volume (price & volume families) | 11798 | -0.11% | 19422 | 44% | -0.01% | -0.04% | -0.8 | 2/5 | 4.8% · -0.1% · -0.4% · -0.1% · 0.0% |
| squeeze breakout with the trend (volatility + higher TF) | 3572 | -0.54% | 5112 | 42% | -0.09% | -0.16% | -1.8 | 2/5 | 0.9% · -1.2% · -0.4% · 0.0% · -0.3% |
| fade in a range (ADX < 20) | 7116 | -0.27% | 11711 | 51% | -0.20% | -0.19% | -3.9 | 1/5 | -3.3% · -0.7% · 0.1% · -0.2% · -0.2% |
| bullish in an uptrend only (higher TF + above EMA200) | 2355 | -0.45% | 6041 | 44% | 0.40% | 0.23% | 2.6 | 2/5 | 1.0% · -0.7% · -0.6% · -0.3% · 0.6% |
| 1D only | 1527 | 1.00% | 1079 | 47% | -0.41% | -0.59% | -1.1 | 2/5 | 5.1% · -0.2% · -1.2% · 1.5% · -2.5% |
| family score > 0 (weights learned on train) | 0 | — | 0 | — | — | — | — | 0/0 | — · — · — · — · — |
| family score in top 30 % (train threshold) | 5369 | -0.02% | 8748 | 44% | -0.01% | -0.04% | -0.6 | 1/5 | -0.2% · -0.2% · 0.0% · -0.0% · -0.0% |

Family weights learned on train (edge when present): momentum -0.11% · volume -0.13% · price -0.12% · trend -0.19% · volatility -0.24% · divergence -0.51%; top-30 % score threshold -0.0028.

## 4. Verdict

- Current rules on the test period: 27290 alerts, win 44%, avg -0.07%, edge -0.08% (t -2.2).
- Best on train: **fade — stretched alerts only** (train edge 1.06%) → test: 1256 alerts, win 53%, avg -0.46%, edge -0.35% (t -1.4), folds won 3/5.
- No method is positive in almost every fold and significant on test.
- |t| < 2 means the result could be luck.