// Swing Options Backtester (v2 — Option P/L basis)
// --------------------------------------------------------------------------
// Validates the SIGNAL edge by replaying selection + entry rules over ~1y
// history and simulating direction-aware exits WITH DAILY THETA DECAY.
//
// Key improvement: previous version measured stock moves; this measures the
// actual OPTION P/L (entry premium → daily theta decay → exit premium).
// That's what traders care about. Theta is the dominant force on 5-day weeklies.

const axios = require("axios");
const {
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateVolatility,
  scoreStock,
  ELIGIBLE_SYMBOLS,
} = require("./swing-options-tracker.js");

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const RSI_PERIOD = 14;
const LOOKBACK = "1y";

async function fetchHistory(symbol) {
  try {
    const res = await axios.get(`${CHART_URL}/${encodeURIComponent(symbol)}`, {
      params: { range: LOOKBACK, interval: "1d" },
      timeout: 20000,
      headers: { "User-Agent": "swing-options-backtest/1.0" },
    });
    const chart = res.data?.chart?.result?.[0];
    if (!chart) return null;
    const q = chart.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    const highs = q.high || [];
    const lows = q.low || [];
    // Drop any null bars (holidays/halts) keeping arrays aligned.
    const C = [], H = [], L = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] == null || highs[i] == null || lows[i] == null) continue;
      C.push(closes[i]); H.push(highs[i]); L.push(lows[i]);
    }
    return { symbol, closes: C, highs: H, lows: L };
  } catch (e) {
    return null;
  }
}

// Build the same indicator object scoreStock expects, using data up to index i.
function indicatorsAt(hist, i) {
  const closes = hist.closes.slice(0, i + 1);
  const highs = hist.highs.slice(0, i + 1);
  const lows = hist.lows.slice(0, i + 1);
  if (closes.length < 25) return null;

  const price = closes[closes.length - 1];
  const prev5 = closes[Math.max(0, closes.length - 6)] || closes[0];
  const change5d = ((price - prev5) / prev5) * 100;
  const rsi = calculateRSI(closes);
  const bb = calculateBollingerBands(closes);
  const atr = calculateATR(highs, lows, closes);
  const volatility = calculateVolatility(closes.slice(-30));
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const distToResistance = (recentHigh - price) / price * 100;
  const distToSupport = (price - recentLow) / price * 100;

  return {
    symbol: hist.symbol,
    price,
    change5d,
    volatility,
    rsi,
    bbUpper: bb.upper[bb.upper.length - 1],
    bbMiddle: bb.middle[bb.middle.length - 1],
    bbLower: bb.lower[bb.lower.length - 1],
    atr,
    resistance: recentHigh,
    support: recentLow,
    distToResistance,
    distToSupport,
    nearSupportResistance: distToResistance < 5 || distToSupport < 5,
    high5d: Math.max(...highs.slice(-5)),
    low5d: Math.min(...lows.slice(-5)),
  };
}

// Same entry math as generateNewTrade (direction + target/stop %).
// Config parameters: min score, hold days, target/stop scaling.
function buildEntry(data, config) {
  const isBullish = data.change5d > 0;
  const baseTarget = Math.abs(data.change5d) * config.targetScale + data.volatility * 0.5;
  const targetPercent = Math.min(baseTarget, 20);
  const atrPercent = (data.atr / data.price) * 100 * config.stopScale;
  return {
    isBullish,
    entry: data.price,
    targetPrice: data.price * (1 + (isBullish ? targetPercent : -targetPercent) / 100),
    stopPrice: data.price * (1 + (isBullish ? -atrPercent : atrPercent) / 100),
    targetPercent,
    atrPercent,
  };
}

// Black-Scholes option pricing.
function estimateBS(S, K, T, sigma, type) {
  if (T <= 0 || sigma <= 0) return 0;
  const r = 0.05;
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const N = (x) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
  const Nd1 = N(d1), Nd2 = N(d2);
  return type === "CALL"
    ? S * Nd1 - K * Math.exp(-r * T) * Nd2
    : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}

// Simulate the trade forward day-by-day, computing option P/L with theta decay.
function simulate(hist, i, entry, config, volatility) {
  const strike = entry.isBullish
    ? entry.entry * 0.99  // ITM strike
    : entry.entry * 1.01;
  const type = entry.isBullish ? "CALL" : "PUT";

  // Entry option premium
  const entryPremium = estimateBS(entry.entry, strike, config.holdDays / 365, volatility / 100 * Math.sqrt(252), type);
  if (entryPremium <= 0) return null;

  for (let d = 1; d <= config.holdDays; d++) {
    const k = i + d;
    if (k >= hist.closes.length) break;
    const hi = hist.highs[k], lo = hist.lows[k], cl = hist.closes[k];

    // Check target/stop on stock
    let outcome = null;
    let exitPrice = null;
    if (entry.isBullish) {
      if (lo <= entry.stopPrice) { outcome = "stop"; exitPrice = entry.stopPrice; }
      else if (hi >= entry.targetPrice) { outcome = "target"; exitPrice = entry.targetPrice; }
    } else {
      if (hi >= entry.stopPrice) { outcome = "stop"; exitPrice = entry.stopPrice; }
      else if (lo <= entry.targetPrice) { outcome = "target"; exitPrice = entry.targetPrice; }
    }

    if (outcome) {
      // Exit on target/stop — price the option at exit price with time left
      const daysLeft = Math.max(config.holdDays - d, 0.5);
      const exitPremium = estimateBS(exitPrice, strike, daysLeft / 365, volatility / 100 * Math.sqrt(252), type);
      return {
        outcome,
        exitPrice,
        entryPremium,
        exitPremium,
        days: d,
        optionPnL: exitPremium - entryPremium,
        optionPnLPercent: ((exitPremium - entryPremium) / entryPremium) * 100,
      };
    }

    if (d === config.holdDays) {
      // Expire — close at close price with 0 DTE
      const expirePremium = Math.max(
        entry.isBullish
          ? Math.max(cl - strike, 0)
          : Math.max(strike - cl, 0),
        0
      );
      return {
        outcome: "expiry",
        exitPrice: cl,
        entryPremium,
        exitPremium: expirePremium,
        days: d,
        optionPnL: expirePremium - entryPremium,
        optionPnLPercent: entryPremium > 0 ? ((expirePremium - entryPremium) / entryPremium) * 100 : -100,
      };
    }
  }
  return null; // not enough forward data
}

// Run backtest for a single config; return stats.
async function testConfig(hists, config) {
  const maxLen = Math.max(...hists.map(h => h.closes.length));
  const trades = [];

  // Walk forward day by day; each day pick the single best-scoring symbol,
  // then simulate it with the given config.
  for (let i = RSI_PERIOD + 21; i < maxLen - 1; i++) {
    let best = null;
    for (const h of hists) {
      if (i >= h.closes.length) continue;
      const data = indicatorsAt(h, i);
      if (!data) continue;
      const s = scoreStock(data, 999);
      if (s.finalScore <= config.minScore) continue;
      if (!best || s.finalScore > best.score) best = { hist: h, idx: i, data, score: s.finalScore };
    }
    if (!best) continue;
    const entry = buildEntry(best.data, config);
    const sim = simulate(best.hist, best.idx, entry, config, best.data.volatility);
    if (!sim) continue;
    trades.push({
      symbol: best.hist.symbol,
      dir: entry.isBullish ? "CALL" : "PUT",
      outcome: sim.outcome,
      optionPnL: sim.optionPnL,
      optionPnLPercent: sim.optionPnLPercent,
      days: sim.days,
    });
  }

  const n = trades.length;
  if (n === 0) return null;

  const wins = trades.filter(t => t.optionPnL > 0);
  const losses = trades.filter(t => t.optionPnL <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.optionPnL, 0);
  const avg = (a) => a.length ? sum(a) / a.length : 0;
  const sumPercent = (a) => a.reduce((x, t) => x + t.optionPnLPercent, 0);
  const avgPercent = (a) => a.length ? sumPercent(a) / a.length : 0;
  const winRate = (wins.length / n) * 100;
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const expectancy = sum(trades) / n;
  const expectancyPercent = sumPercent(trades) / n;

  let maxLossStreak = 0, cur = 0;
  for (const t of trades) {
    if (t.optionPnL <= 0) { cur++; maxLossStreak = Math.max(maxLossStreak, cur); } else cur = 0;
  }

  const byOutcome = (o) => trades.filter(t => t.outcome === o).length;

  return {
    config,
    n,
    winRate,
    wins: wins.length,
    losses: losses.length,
    expectancyPercent,
    expectancy,
    profitFactor,
    maxLossStreak,
    avgWinPercent: avgPercent(wins),
    avgLossPercent: avgPercent(losses),
    byOutcome,
  };
}

async function run() {
  const symbols = ELIGIBLE_SYMBOLS;
  console.log(`Backtest: fetching ${LOOKBACK} history for ${symbols.length} symbols...`);
  const hists = (await Promise.all(symbols.map(fetchHistory))).filter(Boolean);
  console.log(`Got history for ${hists.length} symbols.\n`);

  // Parameter sweep: test different configurations.
  const configs = [];
  for (const minScore of [15, 20, 25, 30]) {
    for (const holdDays of [3, 5, 7]) {
      for (const targetScale of [1.0, 1.5]) {
        for (const stopScale of [1.0, 1.5]) {
          configs.push({ minScore, holdDays, targetScale, stopScale });
        }
      }
    }
  }

  console.log(`Testing ${configs.length} configurations...\n`);
  const results = [];
  for (const cfg of configs) {
    const r = await testConfig(hists, cfg);
    if (r) results.push(r);
  }

  // Sort by expectancy (best first).
  results.sort((a, b) => b.expectancyPercent - a.expectancyPercent);

  console.log("=============== PARAMETER SWEEP RESULTS (Option P/L basis) ===============\n");
  console.log("Rank | Min Score | Hold Days | Target Scale | Stop Scale | Trades | Win % | Expectancy | PF");
  console.log("------|-----------|-----------|--------------|------------|--------|-------|------------|-----");
  for (let i = 0; i < Math.min(15, results.length); i++) {
    const r = results[i];
    const c = r.config;
    const exp = r.expectancyPercent >= 0 ? "+" : "";
    console.log(
      `${i + 1}     | ${c.minScore.toString().padStart(9)} | ${c.holdDays.toString().padStart(9)} | ` +
      `${c.targetScale.toString().padStart(12)} | ${c.stopScale.toString().padStart(10)} | ` +
      `${r.n.toString().padStart(6)} | ${r.winRate.toFixed(1).padStart(5)}% | ` +
      `${exp}${r.expectancyPercent.toFixed(2)}% | ${r.profitFactor.toFixed(2)}`
    );
  }

  console.log("\n========== TOP CONFIG IN DETAIL ==========");
  const top = results[0];
  console.log(`Min Score: ${top.config.minScore} | Hold Days: ${top.config.holdDays} | ` +
    `Target Scale: ${top.config.targetScale} | Stop Scale: ${top.config.stopScale}`);
  console.log(`Trades:                ${top.n}`);
  console.log(`Win rate:              ${top.winRate.toFixed(1)}%  (W ${top.wins} / L ${top.losses})`);
  console.log(`Exits:                 target ${top.byOutcome("target")} | stop ${top.byOutcome("stop")} | ` +
    `expiry ${top.byOutcome("expiry")}`);
  console.log(`Avg win (option %):    ${top.avgWinPercent >= 0 ? "+" : ""}${top.avgWinPercent.toFixed(1)}%`);
  console.log(`Avg loss (option %):   ${top.avgLossPercent.toFixed(1)}%`);
  console.log(`Expectancy per trade:  ${top.expectancyPercent >= 0 ? "+" : ""}${top.expectancyPercent.toFixed(2)}% ` +
    `(${top.expectancy >= 0 ? "+" : ""}$${top.expectancy.toFixed(2)} dollar P/L per trade)`);
  console.log(`Profit factor:         ${top.profitFactor.toFixed(2)}`);
  console.log(`Max consecutive losses:${top.maxLossStreak}`);
  console.log("\n=================================================================");
  console.log("Note: OPTION P/L basis with daily theta decay. The first config");
  console.log("ranked by expectancy %. Negative = strategy loses money on options.");
}

if (require.main === module) {
  run().catch(e => { console.error("Backtest error:", e.message); process.exit(1); });
}

module.exports = { run };
