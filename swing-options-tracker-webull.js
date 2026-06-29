/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  OPTIONS TRADING ONLY — Swing Options Tracker
 * ═══════════════════════════════════════════════════════════════════════════
 * Daily swing options trade suggester. Analyzes stocks for OPTIONS trading only.
 * NOT for stock trading. Only CALL/PUT options on underlying stocks.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");
const WebullClient = require("./webull-integration");

const TZ = "America/New_York";
const DEFAULT_STATE_FILE = ".swing-options-state.json";
const STATS_FILE = ".swing-options-stats.json";
const EQUITY_CURVE_FILE = ".swing-options-equity.json";
const JOURNEY_FILE = ".swing-options-journey.json";

// Technical indicator periods
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const BB_PERIOD = 20;

// Large and mega cap stocks - matches Webull whitelist
const ELIGIBLE_SYMBOLS = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V",
  "WMT", "PG", "JNJ", "INTC", "MA", "HD", "PFE", "KO", "MCD", "CSCO",
  "NFLX", "ADBE", "AVGO", "CRM", "ACN", "IBM", "VZ", "T", "XOM", "CVX",
  "BAC", "GS", "MS", "C", "BLK", "SCHW", "SPY", "QQQ", "IWM",
];

// US stock market holidays (NYSE/Nasdaq)
const US_MARKET_HOLIDAYS_2026 = [
  "01-01", "01-19", "02-16", "04-03", "05-25", "06-19",
  "07-03", "09-07", "11-26", "12-25",
];

function getNyTime(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date);
}

function etDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
}

function daysUntilExpiryDate(expiryDate) {
  if (!expiryDate) return 0;
  const today = new Date(`${etDateString()}T00:00:00Z`);
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  return Math.max(Math.round((expiry - today) / (24 * 60 * 60 * 1000)), 0);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function roundToStrike(price) {
  let increment;
  if (price < 25) increment = 0.5;
  else if (price < 200) increment = 1;
  else increment = 5;
  return Math.round(price / increment) * increment;
}

function isHolidayOrWeekendLocal(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return true;
  const monthDay = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return US_MARKET_HOLIDAYS_2026.includes(monthDay);
}

function isMarketDay(date = new Date()) {
  const nyDate = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  return !isHolidayOrWeekendLocal(nyDate);
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_error) {
    return fallback;
  }
}

function safeWriteJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// ==================== TECHNICAL ANALYSIS ====================

function calculateRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return 50;
  const deltas = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  const gains = deltas.map(d => (d > 0 ? d : 0));
  const losses = deltas.map(d => (d < 0 ? -d : 0));
  const avgGain = gains.slice(-period).reduce((a, b) => a + b) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b) / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(closes, period = BB_PERIOD) {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b) / period;
  const variance = recent.reduce((a, b) => a + (b - mean) ** 2) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + 2 * stdDev,
    lower: mean - 2 * stdDev,
    stdDev,
  };
}

function calculateATR(highs, lows, closes, period = ATR_PERIOD) {
  if (highs.length < period) return null;
  const trueRanges = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  const atr = trueRanges.slice(-period).reduce((a, b) => a + b) / period;
  return atr;
}

function calculateVolatility(closes) {
  if (closes.length < 2) return 0.15;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2) / returns.length;
  return Math.sqrt(variance);
}

// ==================== DATA PROCESSING ====================

async function processStockBars(symbol, bars) {
  if (!bars || bars.length === 0) return null;

  const closes = bars.map(b => b.close).filter(c => c > 0);
  const highs = bars.map(b => b.high).filter(h => h > 0);
  const lows = bars.map(b => b.low).filter(l => l > 0);
  const volumes = bars.map(b => b.volume).filter(v => v > 0);

  if (closes.length < 14) return null;

  const currentPrice = closes[closes.length - 1];
  const rsi = calculateRSI(closes, RSI_PERIOD);
  const bb = calculateBollingerBands(closes, BB_PERIOD);
  const atr = calculateATR(highs, lows, closes, ATR_PERIOD);
  const volatility = calculateVolatility(closes);

  // Simple trend detection
  const sma20 = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b) / 50 : sma20;

  // Support/Resistance (simplified: recent lows/highs)
  const recentLows = lows.slice(-10);
  const recentHighs = highs.slice(-10);
  const support = Math.min(...recentLows);
  const resistance = Math.max(...recentHighs);
  const distToSupport = currentPrice - support;
  const distToResistance = resistance - currentPrice;

  return {
    symbol,
    currentPrice,
    bars: bars.length,
    rsi,
    bb,
    atr,
    volatility,
    trend: currentPrice > sma20 ? "UP" : "DOWN",
    support,
    resistance,
    distToSupport,
    distToResistance,
    nearSupportResistance: distToSupport < atr * 2 || distToResistance < atr * 2,
    sma20,
    sma50,
    volume: volumes.length > 0 ? volumes[volumes.length - 1] : 0,
  };
}

// ==================== SCORING ====================

function scoreStock(data) {
  if (!data) return { finalScore: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  // RSI scoring: oversold (< 30) or overbought (> 70)
  if (data.rsi < 30) {
    score += 25;
    reasons.push(`RSI ${data.rsi.toFixed(0)} (oversold, potential reversal)`);
  } else if (data.rsi > 70) {
    score += 20;
    reasons.push(`RSI ${data.rsi.toFixed(0)} (overbought, potential pullback)`);
  } else if (data.rsi < 40) {
    score += 10;
    reasons.push(`RSI ${data.rsi.toFixed(0)} (weak)`);
  } else if (data.rsi > 60) {
    score += 15;
    reasons.push(`RSI ${data.rsi.toFixed(0)} (strong)`);
  }

  // Bollinger Bands
  if (data.bb) {
    if (data.currentPrice < data.bb.lower) {
      score += 20;
      reasons.push("Price near Bollinger lower band (mean reversion play)");
    } else if (data.currentPrice > data.bb.upper) {
      score += 15;
      reasons.push("Price near Bollinger upper band (momentum play)");
    }
  }

  // Volatility
  if (data.volatility > 0.02) {
    score += 15;
    reasons.push(`High volatility ${(data.volatility * 100).toFixed(1)}% (good for options)`);
  }

  // Trend alignment
  if (data.trend === "UP" && data.rsi > 50) {
    score += 10;
    reasons.push("Uptrend confirmed");
  } else if (data.trend === "DOWN" && data.rsi < 50) {
    score += 10;
    reasons.push("Downtrend confirmed");
  }

  return {
    finalScore: score,
    reasons,
    rsi: data.rsi,
    volatility: data.volatility,
  };
}

// ==================== TRADE GENERATION ====================

async function generateNewTrade(symbol, stockData, scoring) {
  const entryPrice = stockData.currentPrice;
  const volatility = stockData.volatility;

  // Determine direction
  const isCall = stockData.rsi < 40 || (stockData.trend === "UP" && stockData.rsi < 60);
  const type = isCall ? "CALL" : "PUT";

  // Set strike (ATM or slightly OTM)
  const strikePrice = roundToStrike(entryPrice * (isCall ? 1.01 : 0.99));

  // Calculate target and stop
  const movePercent = volatility * 100 * 1.5; // 1.5x daily volatility
  const targetPercent = Math.max(5, movePercent);
  const stopPercent = Math.min(2, movePercent / 2);

  const targetPrice = isCall
    ? entryPrice * (1 + targetPercent / 100)
    : entryPrice * (1 - targetPercent / 100);
  const stopLoss = isCall
    ? entryPrice * (1 - stopPercent / 100)
    : entryPrice * (1 + stopPercent / 100);

  // Expiry: 5 days from now
  const today = new Date();
  const expiry = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
  const expiryDate = etDateString(expiry);

  const trade = {
    symbol,
    type,
    entryPrice,
    strikePrice: roundToStrike(strikePrice),
    targetPrice: roundToStrike(targetPrice),
    stopLoss: roundToStrike(stopLoss),
    currentPrice: entryPrice,
    currentOptionPrice: 1.0, // Avoid division by zero in monitor
    volatility: volatility * 100,
    expiryDate,
    suggestedDate: new Date().toISOString(),
    scoring,
    status: "PENDING_ORDER",
    orderId: null,
    greeks: {
      delta: isCall ? 0.5 : -0.5,
      gamma: 0,
      theta: 0,
      vega: 0,
    },
  };

  return trade;
}

// ==================== DISCORD ====================

async function sendDiscordMessage(content) {
  const webhookUrl = process.env.SWING_OPTIONS_DISCORD_WEBHOOK;

  if (!webhookUrl) {
    console.log("[NO_WEBHOOK] Would post to Discord:", content.substring(0, 100));
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        username: "Swing Options Tracker (Webull)",
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord request failed with status ${response.status}`);
    }

    return true;
  } catch (error) {
    console.error(`[${getNyTime()}] Discord send failed: ${error.message}`);
    return false;
  }
}

function formatTradeMessage(trade, symbol) {
  const direction = trade.type === "CALL" ? "📈 CALL (Bullish)" : "📉 PUT (Bearish)";
  return (
    `🎯 **NEW TRADE SUGGESTION** 🎯\n\n` +
    `**${symbol}** - ${direction}\n\n` +
    `Entry: $${trade.entryPrice.toFixed(2)}\n` +
    `Strike: $${trade.strikePrice.toFixed(2)}\n` +
    `Target: $${trade.targetPrice.toFixed(2)} (+${((trade.targetPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(1)}%)\n` +
    `Stop Loss: $${trade.stopLoss.toFixed(2)} (-${((trade.entryPrice - trade.stopLoss) / trade.entryPrice * 100).toFixed(1)}%)\n` +
    `Expiry: ${trade.expiryDate} (5 days)\n` +
    `Volatility: ${trade.volatility.toFixed(1)}%\n\n` +
    `📝 **Reasoning:**\n${trade.scoring.reasons.map(r => `• ${r}`).join("\n")}\n\n` +
    `🔗 **Next Step:** Place order on Webull (${trade.symbol} ${trade.type} @ $${trade.strikePrice.toFixed(2)})\n\n` +
    `⏱️ Generated: ${getNyTime()} ET`
  );
}

// ==================== STATE MANAGEMENT ====================

function updateStats(trade) {
  const stats = safeReadJson(STATS_FILE, {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0,
    avgWinSize: 0,
    avgLossSize: 0,
    winRate: 0,
    lastUpdate: new Date().toISOString(),
  });

  stats.totalTrades += 1;
  stats.lastUpdate = new Date().toISOString();
  safeWriteJson(STATS_FILE, stats);

  return stats;
}

function recordTradeJourney(trade) {
  const journey = safeReadJson(JOURNEY_FILE, {
    startDate: new Date().toISOString(),
    trades: [],
    weeklyReports: [],
  });

  const journalEntry = {
    symbol: trade.symbol,
    type: trade.type,
    entryPrice: trade.entryPrice,
    strikePrice: trade.strikePrice,
    targetPrice: trade.targetPrice,
    stopLoss: trade.stopLoss,
    expiryDate: trade.expiryDate,
    suggestedDate: trade.suggestedDate,
    isClosed: false,
    closedDate: null,
    finalPrice: null,
    finalPnLPercent: null,
    dailyUpdates: [
      {
        date: new Date().toISOString(),
        price: trade.currentPrice,
        pnlPercent: 0,
        status: "SUGGESTED",
      },
    ],
  };

  journey.trades.push(journalEntry);
  safeWriteJson(JOURNEY_FILE, journey);
}

// ==================== MAIN ====================

async function main() {
  console.log(`[${getNyTime()}] Swing Options Tracker (Webull) started`);

  const isTestRun = process.env.TEST_MODE === "true";

  // Check if market is open
  if (!isMarketDay() && !isTestRun) {
    console.log(`[${getNyTime()}] Market is closed today. Exiting.`);
    process.exit(0);
  }

  // Initialize Webull client
  const webull = new WebullClient();
  try {
    webull.validateCredentials();
  } catch (error) {
    console.error(`[${getNyTime()}] ${error.message}`);
    await sendDiscordMessage(`❌ **Webull API Error**\n\n${error.message}`);
    process.exit(1);
  }

  const stateFile = path.join(process.cwd(), DEFAULT_STATE_FILE);
  let state = safeReadJson(stateFile, { trades: [] });

  console.log(`[${getNyTime()}] Analyzing ${ELIGIBLE_SYMBOLS.length} stocks...`);

  // TODO: Implement Webull data integration
  // This requires calling webull.getBars() for each symbol and processing the results
  // For now, this is a stub that exits cleanly
  if (!isTestRun) {
    console.log(`[${getNyTime()}] ⚠️ Webull MCP integration not yet implemented`);
    console.log(`[${getNyTime()}] For now, use TEST_MODE=true npm run start:webull to test`);
    process.exit(0);
  }

  // Test mode: generate sample trade without real data
  if (isTestRun) {
    const testSymbol = "AAPL";
    console.log(`[${getNyTime()}] [TEST] Creating sample trade for ${testSymbol}`);

    const testData = {
      symbol: testSymbol,
      currentPrice: 150.5,
      rsi: 35,
      bb: { lower: 145, middle: 150, upper: 155, stdDev: 2.5 },
      atr: 2.0,
      volatility: 0.025,
      trend: "DOWN",
      support: 145,
      resistance: 160,
      distToSupport: 5.5,
      distToResistance: 9.5,
      nearSupportResistance: true,
      sma20: 151,
      sma50: 152,
      volume: 45000000,
    };

    const scoring = scoreStock(testData);
    if (scoring.finalScore > 20) {
      const trade = await generateNewTrade(testSymbol, testData, scoring);
      recordTradeJourney(trade);
      state.trades.unshift(trade);
      safeWriteJson(stateFile, state);
      updateStats(trade);

      const message = formatTradeMessage(trade, testSymbol);
      console.log(`[${getNyTime()}] Generated trade message:\n${message}`);
      await sendDiscordMessage(message);
      console.log(`[${getNyTime()}] Trade logged and Discord notified ✓`);
    }
  }

  console.log(`[${getNyTime()}] Tracker complete`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${getNyTime()}] Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateVolatility,
  scoreStock,
  ELIGIBLE_SYMBOLS,
};
