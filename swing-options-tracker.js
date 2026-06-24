const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const TZ = "America/New_York";
const DEFAULT_STATE_FILE = ".swing-options-state.json";
const STATS_FILE = ".swing-options-stats.json";
const EQUITY_CURVE_FILE = ".swing-options-equity.json";
const EARNINGS_CACHE_FILE = ".swing-options-earnings.json";

// Technical indicator periods
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const BB_PERIOD = 20;

// Large and mega cap stocks
const ELIGIBLE_SYMBOLS = [
  "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "NVDA", "META", "TSLA", "JPM", "V",
  "WMT", "PG", "JNJ", "INTC", "MA", "HD", "PFE", "KO", "MCD", "CSCO",
  "NFLX", "ADBE", "AVGO", "CRM", "ACN", "IBM", "VZ", "T", "XOM", "CVX",
  "BAC", "GS", "MS", "C", "BLK", "SCHW", "SPY", "QQQ", "IWM",
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

function getExpiryDaysFromTrade(startDate) {
  const today = new Date();
  const diffTime = today - startDate;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(diffDays, 0);
}

// Today's date in ET as YYYY-MM-DD (lexicographically comparable).
function etDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
}

// Calendar days remaining until a stored expiry date (YYYY-MM-DD), >= 0.
function daysUntilExpiryDate(expiryDate) {
  if (!expiryDate) return 0;
  const today = new Date(`${etDateString()}T00:00:00Z`);
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  return Math.max(Math.round((expiry - today) / (24 * 60 * 60 * 1000)), 0);
}

// US stock market holidays (NYSE/Nasdaq), MM-DD. Single source of truth.
const US_MARKET_HOLIDAYS_2026 = [
  "01-01", // New Year's Day
  "01-19", // MLK Day
  "02-16", // Presidents Day
  "04-03", // Good Friday (2026)
  "05-25", // Memorial Day
  "06-19", // Juneteenth
  "07-03", // Independence Day (observed, July 4 is Saturday)
  "09-07", // Labor Day
  "11-26", // Thanksgiving
  "12-25", // Christmas
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Round to a realistic, tradeable option strike increment.
// Most US equities list $1 strikes (≈$25–$200), $0.50 below that, $5 above.
function roundToStrike(price) {
  let increment;
  if (price < 25) increment = 0.5;
  else if (price < 200) increment = 1;
  else increment = 5;
  return Math.round(price / increment) * increment;
}

// Checks weekend/holiday using a Date's own calendar fields (no timezone
// re-conversion). Use this when the Date already carries the intended ET date.
function isHolidayOrWeekendLocal(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return true;
  const monthDay = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return US_MARKET_HOLIDAYS_2026.includes(monthDay);
}

function isMarketDay(date = new Date()) {
  // Convert to NY time, then evaluate its calendar fields.
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

// ==================== EARNINGS CALENDAR ====================

async function fetchEarningsDate(symbol) {
  try {
    const cache = safeReadJson(EARNINGS_CACHE_FILE, {});
    const cacheAge = cache[symbol]?.cacheTime ? Date.now() - cache[symbol].cacheTime : Infinity;

    if (cacheAge < 24 * 60 * 60 * 1000 && cache[symbol]?.date) {
      return cache[symbol].date;
    }

    const response = await axios.get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}`, {
      params: { modules: "calendarEvents" },
      timeout: 10000,
      headers: { "User-Agent": "swing-options-tracker/2.0" },
    });

    const earningsDate = response.data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.[0]?.earningsDate;
    if (earningsDate) {
      cache[symbol] = { date: earningsDate, cacheTime: Date.now() };
      safeWriteJson(EARNINGS_CACHE_FILE, cache);
      return earningsDate;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function daysUntilEarnings(earningsDate) {
  if (!earningsDate) return 999;
  const earnings = new Date(earningsDate * 1000);
  const today = new Date();
  const diffTime = earnings - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// ==================== REAL OPTIONS DATA (WEBULL / POLYGON) ====================

// Fetch real Webull option quote for a specific contract.
// Returns { bid, ask, last, bidSize, askSize, impliedVol, source: "webull" } or null.
async function fetchWebullOptionQuote(symbol, strikePrice, optionType, expiryDate) {
  const webullApiUrl = process.env.WEBULL_API_URL || "http://localhost:3001";
  if (!webullApiUrl) return null;

  try {
    // Call local Webull bridge API (Claude Code runs the bridge).
    const response = await axios.get(`${webullApiUrl}/webull/options-quote`, {
      params: {
        symbol: symbol.toUpperCase(),
        strikePrice,
        contractType: optionType.toUpperCase(),
        expirationDate: expiryDate,
      },
      timeout: 15000,
    });

    if (response.data?.quote) {
      return {
        bid: response.data.quote.bid,
        ask: response.data.quote.ask,
        last: response.data.quote.last,
        bidSize: response.data.quote.bidSize,
        askSize: response.data.quote.askSize,
        impliedVol: response.data.quote.impliedVolatility,
        openInterest: response.data.quote.openInterest,
        source: "webull",
      };
    }
    return null;
  } catch (error) {
    // Webull bridge not available; will fall back to Polygon/BS.
    if (process.env.DEBUG_WEBULL) {
      console.error(`[${getNyTime()}] Webull quote failed for ${symbol} ${strikePrice} ${optionType}: ${error.message}`);
    }
    return null;
  }
}

// Build an OCC option ticker, e.g. C $142 CALL exp 2026-06-18 -> O:C260618C00142000
function buildOccTicker(symbol, expiryDate, optionType, strike) {
  const [y, m, d] = expiryDate.split("-");
  const cp = optionType.toUpperCase() === "CALL" ? "C" : "P";
  const strikeInt = String(Math.round(strike * 1000)).padStart(8, "0");
  return `O:${symbol.toUpperCase()}${y.slice(2)}${m}${d}${cp}${strikeInt}`;
}

// Fetch the REAL option for one expiry/type nearest `desiredStrike`.
// Free Polygon tier: the live snapshot endpoint is blocked, but the reference
// (contract listings) and previous-day aggregate (EOD price) endpoints work — so
// we get real strikes + real end-of-day prices. Returns null on no key/failure.
async function fetchPolygonOption(symbol, desiredStrike, optionType, expiryDate) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  try {
    // 1) Find the real listed strike nearest what we want to trade.
    const ref = await axios.get("https://api.polygon.io/v3/reference/options/contracts", {
      params: {
        underlying_ticker: symbol,
        contract_type: optionType.toLowerCase(), // "call" | "put"
        expiration_date: expiryDate,
        limit: 1000,
        apiKey,
      },
      timeout: 12000,
    });
    const contracts = ref.data?.results || [];
    if (contracts.length === 0) return null;

    let best = null;
    let bestDist = Infinity;
    for (const c of contracts) {
      const strike = c.strike_price;
      if (typeof strike !== "number") continue;
      const dist = Math.abs(strike - desiredStrike);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    if (!best) return null;

    const occ = best.ticker || buildOccTicker(symbol, expiryDate, optionType, best.strike_price);

    // 2) Get the real previous-day price for that exact contract (EOD on free tier),
    //    plus the underlying's matching prev close so we can reprice to current spot.
    let premium = null;
    let bar = null;
    let underlyingEodClose = null;
    try {
      const [agg, stockAgg] = await Promise.all([
        axios.get(`https://api.polygon.io/v2/aggs/ticker/${occ}/prev`, {
          params: { adjusted: true, apiKey }, timeout: 12000,
        }),
        axios.get(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, {
          params: { adjusted: true, apiKey }, timeout: 12000,
        }).catch(() => null),
      ]);
      bar = agg.data?.results?.[0] || null;
      if (bar) {
        // VWAP best reflects the day's traded level; fall back to close.
        premium = (typeof bar.vw === "number" && bar.vw > 0) ? bar.vw : bar.c;
      }
      const sBar = stockAgg?.data?.results?.[0];
      if (sBar && typeof sBar.c === "number") underlyingEodClose = sBar.c;
    } catch (_e) {
      // Price endpoint may be unavailable; we still return the real strike below.
    }

    return {
      strike: best.strike_price,
      ticker: occ,
      premium: typeof premium === "number" && premium > 0 ? premium : null,
      underlyingEodClose,
      lastClose: bar?.c ?? null,
      dayHigh: bar?.h ?? null,
      dayLow: bar?.l ?? null,
      volume: bar?.v ?? null,
      asOf: bar?.t ? new Date(bar.t).toISOString().split("T")[0] : null,
      impliedVolatility: null, // not available on free tier
      delta: null,
      theta: null,
      vega: null,
      source: premium ? "polygon-eod" : "polygon-strike-only",
    };
  } catch (error) {
    console.error(`[${getNyTime()}] Polygon options fetch failed for ${symbol}: ${error.message}`);
    return null;
  }
}

// ==================== VOLATILITY REGIME ====================

async function fetchVIX() {
  try {
    const response = await axios.get(`${CHART_URL}/^VIX`, {
      params: {
        range: "1d",
        interval: "1m",
      },
      timeout: 10000,
      headers: { "User-Agent": "swing-options-tracker/2.0" },
    });

    const chart = response.data?.chart?.result?.[0];
    if (!chart) return null;

    const closes = chart.indicators?.quote?.[0]?.close || [];
    if (closes.length === 0) return null;

    // Get last non-null close
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null) return closes[i];
    }
    return null;
  } catch (error) {
    console.error(`[${getNyTime()}] Failed to fetch VIX: ${error.message}`);
    return null;
  }
}

function checkVolatilityRegime(vix) {
  if (!vix) return { safe: true, reason: null, vix: null };

  if (vix > 30) {
    return {
      safe: false,
      reason: `VIX at ${vix.toFixed(1)} (panic zone > 30) - Skip trading today`,
      vix,
    };
  }

  if (vix < 12) {
    return {
      safe: false,
      reason: `VIX at ${vix.toFixed(1)} (complacency zone < 12) - Skip trading today`,
      vix,
    };
  }

  return {
    safe: true,
    reason: `VIX at ${vix.toFixed(1)} (optimal range 12-30) - Good trading conditions`,
    vix,
  };
}

// ==================== TECHNICAL INDICATORS ====================

async function fetchStockData(symbol) {
  try {
    const response = await axios.get(`${CHART_URL}/${encodeURIComponent(symbol)}`, {
      params: {
        range: "60d",  // Get 60 days for better technical analysis
        interval: "1d",
        events: "div,splits",
      },
      timeout: 15000,
      headers: {
        "User-Agent": "swing-options-tracker/2.0",
      },
    });

    const chart = response.data?.chart?.result?.[0];
    if (!chart) return null;

    const closes = chart.indicators?.quote?.[0]?.close || [];
    const highs = chart.indicators?.quote?.[0]?.high || [];
    const lows = chart.indicators?.quote?.[0]?.low || [];

    if (closes.length < RSI_PERIOD) return null;

    const currentPrice = closes[closes.length - 1];
    if (!currentPrice || currentPrice === null) return null;

    const prev5Close = closes[Math.max(0, closes.length - 6)] || closes[0];
    const change5d = ((currentPrice - prev5Close) / prev5Close) * 100;

    // Calculate technical indicators
    const rsi = calculateRSI(closes);
    const { upper: bbUpper, lower: bbLower, middle: bbMiddle } = calculateBollingerBands(closes);
    const atr = calculateATR(highs, lows, closes);
    const volatility = calculateVolatility(closes);

    // Support/resistance (simple: recent high/low)
    const recentHigh = Math.max(...highs.slice(-20));
    const recentLow = Math.min(...lows.slice(-20));

    // Check if price is near support/resistance
    const distToResistance = (recentHigh - currentPrice) / currentPrice * 100;
    const distToSupport = (currentPrice - recentLow) / currentPrice * 100;
    const nearSupportResistance = distToResistance < 5 || distToSupport < 5;

    // Safely calculate 5-day high/low
    const last5Highs = highs.slice(-5);
    const last5Lows = lows.slice(-5);
    const high5d = last5Highs.length > 0 ? Math.max(...last5Highs) : currentPrice;
    const low5d = last5Lows.length > 0 ? Math.min(...last5Lows) : currentPrice;

    return {
      symbol,
      price: currentPrice,
      change5d,
      volatility,
      rsi,
      bbUpper: bbUpper[bbUpper.length - 1],
      bbMiddle: bbMiddle[bbMiddle.length - 1],
      bbLower: bbLower[bbLower.length - 1],
      atr,
      resistance: recentHigh,
      support: recentLow,
      distToResistance,
      distToSupport,
      nearSupportResistance,
      high5d,
      low5d,
      closes: closes.slice(-60),  // Keep for backtesting
      highs: highs.slice(-60),
      lows: lows.slice(-60),
    };
  } catch (error) {
    console.error(`[${getNyTime()}] Failed to fetch ${symbol}: ${error.message}`);
    return null;
  }
}

function calculateRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(closes, period = BB_PERIOD) {
  const middle = [];
  const upper = [];
  const lower = [];

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);

    middle.push(mean);
    upper.push(mean + 2 * std);
    lower.push(mean - 2 * std);
  }

  return { upper, lower, middle };
}

function calculateATR(highs, lows, closes, period = ATR_PERIOD) {
  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(tr1, tr2, tr3));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }

  return atr;
}

function calculateVolatility(closes) {
  if (closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

// ==================== SAFETY FILTERS ====================

function checkEarningsRisk(daysUntilEarnings) {
  if (!daysUntilEarnings) return 1.0;
  if (daysUntilEarnings <= 5) return 0.3; // High risk: skip entirely
  if (daysUntilEarnings <= 7) return 0.6; // Moderate risk: reduce confidence
  if (daysUntilEarnings <= 10) return 0.8; // Minor risk
  return 1.0;
}

function checkMacroRisk() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 3) return 0.8;
  return 1.0;
}

// ==================== TRADE SCORING ====================

// MOMENTUM-consistent scoring. Direction is taken from 5-day momentum
// (see generateNewTrade), so selection rewards stocks whose trend is strong
// and CONFIRMED, and penalizes exhaustion (so we don't pile into the single
// most overextended name). This replaces the old mean-reversion scoring that
// rewarded RSI/Bollinger extremes — which contradicted the momentum entry.
function scoreStock(data, daysUntilEarnings = 999) {
  if (!data) return 0;

  let score = 0;
  let confidence = 1.0;
  const bullish = data.change5d > 0;

  // 1. Trend strength (35) — magnitude of the 5-day move.
  score += Math.min(Math.abs(data.change5d) * 3.5, 35);

  // 2. RSI trend confirmation (25), with an exhaustion penalty.
  //    Aligned + healthy zone = full; aligned but over-extended = partial;
  //    not aligned with the trend = none.
  const rsi = data.rsi;
  let rsiScore = 0;
  if (bullish) {
    if (rsi >= 55 && rsi <= 78) rsiScore = 25;        // strong, not exhausted
    else if (rsi > 78) rsiScore = 8;                   // overbought/exhaustion risk
    else if (rsi >= 50) rsiScore = 15;                 // mild confirmation
  } else {
    if (rsi <= 45 && rsi >= 22) rsiScore = 25;
    else if (rsi < 22) rsiScore = 8;                   // oversold/exhaustion risk
    else if (rsi <= 50) rsiScore = 15;
  }
  score += rsiScore;

  // 3. Bollinger position alignment (20) — price on the trend side of the
  //    middle band with room to run; very edge = over-extended, half credit.
  const pricePosition = (data.price - data.bbLower) / (data.bbUpper - data.bbLower);
  if (bullish) {
    if (pricePosition >= 0.55 && pricePosition <= 0.95) score += 20;
    else if (pricePosition > 0.95) score += 10;        // hugging upper band
    else if (pricePosition >= 0.5) score += 8;
  } else {
    if (pricePosition <= 0.45 && pricePosition >= 0.05) score += 20;
    else if (pricePosition < 0.05) score += 10;        // hugging lower band
    else if (pricePosition <= 0.5) score += 8;
  }

  // 4. Volatility (10) — need enough movement for an option payoff.
  score += Math.min(data.volatility * 1.5, 10);

  // 5. Continuation (10) — price at/near the 5-day extreme in the trend
  //    direction signals the move is still pushing (not stalling).
  if (bullish && data.high5d && data.price >= data.high5d * 0.999) score += 10;
  else if (!bullish && data.low5d && data.price <= data.low5d * 1.001) score += 10;

  // Apply confidence adjustments
  confidence *= checkEarningsRisk(daysUntilEarnings);
  confidence *= checkMacroRisk();

  return {
    score,
    confidence,
    finalScore: score * confidence,
    momentum: data.change5d,
    rsi: data.rsi,
    bbPosition: pricePosition,
    volatility: data.volatility,
    supportConfirmed: data.nearSupportResistance,
    daysUntilEarnings,
  };
}

// ==================== TRADE GENERATION ====================

async function generateNewTrade(bestStock, scoring) {
  const entryPrice = bestStock.price;

  // Direction: MOMENTUM strategy — ride the prevailing 5-day trend.
  //   Positive momentum → CALL (uptrend continues)
  //   Negative momentum → PUT  (downtrend continues)
  // RSI relative to 50 confirms the regime (reported in the rationale).
  const isBullish = bestStock.change5d > 0;
  const rsiConfirms = isBullish ? bestStock.rsi >= 50 : bestStock.rsi < 50;

  // Use ATR for dynamic stops
  const targetPercent = Math.min(
    Math.abs(bestStock.change5d) * 1.5 + bestStock.volatility * 0.5,
    20
  );
  const atrPercent = bestStock.atr / entryPrice * 100 * 1.5;

  // For CALL: stop is below (negative), target is above (positive)
  // For PUT: stop is above (positive), target is below (negative)
  const stopLossPercent = isBullish ? -atrPercent : atrPercent;
  const signedTargetPercent = isBullish ? targetPercent : -targetPercent;

  // Pick the nearest real, tradeable strike (slightly ITM for higher delta).
  const strikePrice = roundToStrike(isBullish ? entryPrice * 0.99 : entryPrice * 1.01);

  // Next Friday = standard weekly option expiry. Work in ET so the day-of-week
  // doesn't drift when the server runs in UTC, and read calendar fields directly.
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  let expiry = new Date(nowEt.getTime() + ((5 - nowEt.getDay() + 7) % 7 || 7) * 24 * 60 * 60 * 1000);
  // If that Friday is a market holiday (e.g. Juneteenth, Good Friday), options
  // expire on the preceding trading day. Roll back until we hit one.
  while (isHolidayOrWeekendLocal(expiry)) {
    expiry = new Date(expiry.getTime() - 24 * 60 * 60 * 1000);
  }
  const expiryDate = `${expiry.getFullYear()}-${pad2(expiry.getMonth() + 1)}-${pad2(expiry.getDate())}`;
  const daysToExpiry = Math.max(Math.round((expiry - nowEt) / (24 * 60 * 60 * 1000)), 1);
  const timeToExpiryYears = daysToExpiry / 365;
  const dayBeforeExpiryYears = Math.max(daysToExpiry - 1, 0.5) / 365;

  const optionType = isBullish ? "CALL" : "PUT";

  // Try to pull REAL option prices: Webull (live) → Polygon (EOD) → BS estimate.
  let real = await fetchWebullOptionQuote(bestStock.symbol, strikePrice, optionType, expiryDate);
  if (!real) {
    real = await fetchPolygonOption(bestStock.symbol, strikePrice, optionType, expiryDate);
  }

  // Snap to the real listed strike when we have it.
  const finalStrike = real?.strike ?? strikePrice;

  // Volatility for Black-Scholes must be ANNUALIZED.
  const histAnnualVol = (bestStock.volatility / 100) * Math.sqrt(252);
  const haveWebull = real?.source === "webull" && typeof real.last === "number" && real.last > 0;
  const havePolygonPrice = real && typeof real.premium === "number" && real.premium > 0 && real.source !== "webull";

  let sigma = real?.impliedVol && real.impliedVol > 0 ? real.impliedVol : histAnnualVol;
  let priceSource = "estimate";
  let currentOptionPrice = null;

  // Priority: Webull (live) > Polygon repriced > Polygon EOD > BS estimate
  if (haveWebull) {
    // Webull gives us real live prices — use the last traded price
    currentOptionPrice = real.last;
    priceSource = "webull";
    if (real.impliedVol && real.impliedVol > 0) sigma = real.impliedVol;
  } else if (havePolygonPrice && real.underlyingEodClose > 0) {
    // Polygon EOD: back out implied vol and reprice to today's stock price
    const eodT = (daysToExpiry + 1) / 365;
    const iv = impliedVolFromPrice(real.underlyingEodClose, finalStrike, eodT, real.premium, optionType);
    if (iv) {
      sigma = iv;
      currentOptionPrice = estimateBlackScholesPrice(entryPrice, finalStrike, timeToExpiryYears, iv, optionType);
      priceSource = "polygon-eod-repriced";
    } else {
      currentOptionPrice = real.premium;
      priceSource = "polygon-eod";
    }
  } else if (havePolygonPrice) {
    currentOptionPrice = real.premium;
    priceSource = "polygon-eod";
  }

  // If no real price, use Black-Scholes estimate
  if (!currentOptionPrice || currentOptionPrice <= 0) {
    currentOptionPrice = estimateBlackScholesPrice(entryPrice, finalStrike, timeToExpiryYears, sigma, optionType);
    priceSource = "estimate";
  }

  const targetStockPrice = entryPrice * (1 + signedTargetPercent / 100);
  const stopStockPrice = entryPrice * (1 + stopLossPercent / 100);

  // Model target/stop prices with Black-Scholes (projected, anchored to real entry)
  const bsCurrent = estimateBlackScholesPrice(entryPrice, finalStrike, timeToExpiryYears, sigma, optionType);
  const bsTarget = estimateBlackScholesPrice(targetStockPrice, finalStrike, dayBeforeExpiryYears, sigma, optionType);
  const bsStop = estimateBlackScholesPrice(stopStockPrice, finalStrike, dayBeforeExpiryYears, sigma, optionType);

  // Project target/stop by ratio, anchored to the real entry price
  const ratio = bsCurrent > 0 ? currentOptionPrice / bsCurrent : 1;
  const targetOptionPrice = bsTarget * ratio;
  const stopOptionPrice = bsStop * ratio;
  const priceAsOf = real?.asOf ?? null;

  // Liquidity proxy: previous-day traded volume of the chosen contract.
  const optionVolume = real?.volume ?? null;
  const thinLiquidity = typeof optionVolume === "number" && optionVolume < 50;

  // Greeks: use real values from Polygon when present, else rough estimates.
  const delta = real?.delta ?? (isBullish ? 0.65 : -0.65);
  const theta = real?.theta ?? -0.05;
  const vega = real?.vega ?? sigma / Math.sqrt(252);

  // Calculate option profit
  const optionProfit = targetOptionPrice - currentOptionPrice;
  const optionProfitPercent = currentOptionPrice > 0 ? (optionProfit / currentOptionPrice) * 100 : 0;

  return {
    symbol: bestStock.symbol,
    price: entryPrice,
    strikePrice: finalStrike,
    type: optionType,
    expiryDays: daysToExpiry,
    expiryDate,
    entryPrice,
    targetPrice: targetStockPrice,
    targetPercent: signedTargetPercent,
    stopLoss: stopStockPrice,
    stopLossPercent,
    suggestedDate: new Date().toISOString(),
    recommendation: "HOLD - Fresh entry",
    currentPrice: entryPrice,

    // Option prices (CRITICAL FOR TRADERS)
    currentOptionPrice: Math.max(currentOptionPrice, 0.01),
    targetOptionPrice: Math.max(targetOptionPrice, 0.01),
    stopOptionPrice: Math.max(stopOptionPrice, 0.01),
    optionProfit,
    optionProfitPercent,
    priceSource,                       // polygon-eod-repriced | polygon-eod | estimate
    priceAsOf,                         // date of the real EOD price, if any
    optionVolume,                      // prev-day contract volume (liquidity proxy)
    thinLiquidity,                     // true if volume below threshold
    impliedVolatility: sigma,          // annualized IV (real when recovered)

    // Technical details
    rsi: bestStock.rsi,
    atr: bestStock.atr,
    volatility: bestStock.volatility,

    // Greeks estimate
    delta,
    theta,
    vega,

    // Confidence
    confidence: Math.round(scoring.confidence * 100),
    rationale: `${bestStock.symbol}: ${isBullish ? "Uptrend" : "Downtrend"} (Momentum ${bestStock.change5d.toFixed(1)}%), RSI ${bestStock.rsi.toFixed(0)}${rsiConfirms ? " confirms" : " (mixed)"}, Vol ${bestStock.volatility.toFixed(1)}%. ${isBullish ? "Bullish CALL" : "Bearish PUT"} — riding the trend.`,
  };
}

function estimateBlackScholesPrice(spotPrice, strikePrice, timeToExpiry, volatility, optionType) {
  const r = 0.05;
  const S = spotPrice;
  const K = strikePrice;
  const T = Math.max(timeToExpiry, 0.01);
  const sigma = Math.max(volatility, 0.01);

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  const normDist = (x) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2) * t;
    const prob = 1 - d * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? prob : 1 - prob;
  };

  if (optionType === "CALL") {
    const Nd1 = normDist(d1);
    const Nd2 = normDist(d2);
    return S * Nd1 - K * Math.exp(-r * T) * Nd2;
  } else {
    const Nmd1 = normDist(-d1);
    const Nmd2 = normDist(-d2);
    return K * Math.exp(-r * T) * Nmd2 - S * Nmd1;
  }
}

// Back out annualized implied volatility from a market option price via
// bisection. Returns null if it can't bracket a solution.
function impliedVolFromPrice(spot, strike, timeToExpiry, marketPrice, optionType) {
  if (!(marketPrice > 0) || !(spot > 0) || !(strike > 0)) return null;
  let lo = 0.01, hi = 5.0;
  const priceAt = (v) => estimateBlackScholesPrice(spot, strike, timeToExpiry, v, optionType);
  if (priceAt(lo) > marketPrice || priceAt(hi) < marketPrice) return null; // out of range
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const p = priceAt(mid);
    if (Math.abs(p - marketPrice) < 0.005) return mid;
    if (p < marketPrice) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function updateTradeGreeks(trade, currentPrice, currentVolatility) {
  const daysRemaining = Math.max(daysUntilExpiryDate(trade.expiryDate), 0.01);
  const timeToExpiry = daysRemaining / 365;

  const r = 0.05;
  const S = currentPrice;
  const K = trade.strikePrice;
  const T = timeToExpiry;
  const sigma = Math.max(currentVolatility / 100, 0.01);

  // Calculate d1 and d2 for Greeks
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  const normDist = (x) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2) * t;
    const prob = 1 - d * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? prob : 1 - prob;
  };

  const pdf = (x) => 0.3989423 * Math.exp(-x * x / 2);
  const pdfD1 = pdf(d1);
  const Nd1 = normDist(d1);
  const Nd2 = normDist(d2);

  let delta, theta, vega;

  if (trade.type === "CALL") {
    delta = Nd1;
    vega = S * pdfD1 * Math.sqrt(T) / 100;
    theta = (-(S * pdfD1 * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Nd2) / 365;
  } else {
    delta = Nd1 - 1;
    vega = S * pdfD1 * Math.sqrt(T) / 100;
    theta = (-(S * pdfD1 * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * (1 - Nd2)) / 365;
  }

  // Update current option price
  const currentOptionPrice = estimateBlackScholesPrice(currentPrice, K, timeToExpiry, sigma * 100, trade.type);

  return {
    delta: Math.round(delta * 100) / 100,
    theta: Math.round(theta * 1000) / 1000,
    vega: Math.round(vega * 1000) / 1000,
    currentOptionPrice: Math.max(currentOptionPrice, 0.01),
    timeToExpiry: daysRemaining,
  };
}

// ==================== TRADE ANALYSIS ====================

function generateTradeSummary(closedTrade) {
  let summary = `📋 **TRADE CLOSED: ${closedTrade.symbol}**\n\n`;

  const finalPnL = closedTrade.finalPnLPercent || 0;
  const isWin = finalPnL >= 0;

  summary += `${isWin ? "✅ WIN" : "❌ LOSS"} | P/L: ${finalPnL.toFixed(2)}%\n`;
  summary += `Entry: $${closedTrade.entryPrice.toFixed(2)} → Final: $${(closedTrade.finalPrice || closedTrade.entryPrice).toFixed(2)}\n`;
  summary += `Days Held: ${closedTrade.daysHeld || 5}\n\n`;

  // Analysis of why it won or lost
  summary += `**📊 WHY THIS TRADE ${isWin ? "WON" : "LOST"}:**\n\n`;

  if (isWin) {
    // Winning trade analysis
    if (closedTrade.hitTarget) {
      summary += `✅ Hit profit target (+${closedTrade.targetPercent.toFixed(1)}%)\n`;
      summary += `   RSI was ${closedTrade.rsi.toFixed(0)} (${closedTrade.rsi > 70 ? "overbought" : "oversold"}) → Strong momentum\n`;
    }
    if (closedTrade.rsiHelped) {
      summary += `✅ RSI signal was accurate (${closedTrade.rsi.toFixed(0)})\n`;
      summary += `   ${closedTrade.rsi > 70 ? "Overbought conditions proved profitable" : "Oversold bounce worked"}\n`;
    }
    if (closedTrade.volatilityHelped) {
      summary += `✅ High volatility (+${closedTrade.volatility.toFixed(1)}%) generated strong option moves\n`;
    }
    summary += `\n**Key Factor:** ${closedTrade.winReason || "Technical setup was solid"}\n`;
  } else {
    // Losing trade analysis
    if (closedTrade.hitStop) {
      summary += `❌ Hit stop loss (-${Math.abs(closedTrade.stopLossPercent).toFixed(1)}%)\n`;
      summary += `   Stock reversed against the position\n`;
    }
    if (closedTrade.rsiWrong) {
      summary += `❌ RSI signal failed (${closedTrade.rsi.toFixed(0)})\n`;
      summary += `   ${closedTrade.rsi > 70 ? "Overbought didn't reverse as expected" : "Oversold bounce fizzled"}\n`;
    }
    if (closedTrade.expiredLoss) {
      summary += `❌ Trade expired worthless (5-day theta decay)\n`;
      summary += `   Time decay overcame directional move\n`;
    }
    summary += `\n**Lesson:** ${closedTrade.lossReason || "Momentum didn't sustain"}\n`;
  }

  summary += `\n**Indicators:**\n`;
  summary += `  • RSI: ${closedTrade.rsi.toFixed(0)}\n`;
  summary += `  • Volatility: ${closedTrade.volatility.toFixed(1)}%\n`;
  summary += `  • ATR: ${closedTrade.atr.toFixed(2)}\n`;

  return summary;
}

// ==================== TRADE JOURNEY ====================

function recordTradeJourney(trade) {
  const journey = safeReadJson(".swing-options-journey.json", {
    startDate: new Date().toISOString(),
    trades: [],
    weeklyReports: [],
  });

  // Add/update trade journey
  const existingTradeIndex = journey.trades.findIndex(t => t.symbol === trade.symbol && t.suggestedDate === trade.suggestedDate);

  const journeyEntry = {
    symbol: trade.symbol,
    suggestedDate: trade.suggestedDate,
    entryPrice: trade.entryPrice,
    strikePrice: trade.strikePrice,
    type: trade.type,
    expiryDate: trade.expiryDate,
    targetPrice: trade.targetPrice,
    stopLoss: trade.stopLoss,
    dailyUpdates: [
      {
        date: new Date().toISOString(),
        price: trade.currentPrice,
        pnlPercent: ((trade.currentPrice - trade.entryPrice) / trade.entryPrice * 100),
        status: "ENTRY",
      }
    ],
    isClosed: false,
    closedDate: null,
    finalPrice: null,
    finalPnLPercent: null,
    reason: null,
  };

  if (existingTradeIndex >= 0) {
    journey.trades[existingTradeIndex].dailyUpdates.push(journeyEntry.dailyUpdates[0]);
  } else {
    journey.trades.push(journeyEntry);
  }

  safeWriteJson(".swing-options-journey.json", journey);
  return journey;
}

function generateWeeklySummary(journey) {
  const week = new Date();
  const weekStart = new Date(week);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const weekTrades = journey.trades.filter(t => {
    const tradeDate = new Date(t.suggestedDate);
    return tradeDate >= weekStart && tradeDate <= weekEnd && t.isClosed;
  });

  let summary = `📊 **WEEKLY SWING OPTIONS REPORT**\n\n`;
  summary += `**Week of ${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}**\n\n`;

  // Calculate stats
  const wins = weekTrades.filter(t => t.finalPnLPercent >= 0).length;
  const losses = weekTrades.filter(t => t.finalPnLPercent < 0).length;
  const totalProfit = weekTrades.reduce((sum, t) => sum + (t.finalPnLPercent || 0), 0);
  const winRate = weekTrades.length > 0 ? (wins / weekTrades.length * 100).toFixed(1) : 0;
  const avgWin = wins > 0
    ? weekTrades.filter(t => t.finalPnLPercent >= 0).reduce((sum, t) => sum + t.finalPnLPercent, 0) / wins
    : 0;
  const avgLoss = losses > 0
    ? weekTrades.filter(t => t.finalPnLPercent < 0).reduce((sum, t) => sum + t.finalPnLPercent, 0) / losses
    : 0;

  // Summary stats
  summary += `📈 **STATISTICS:**\n`;
  summary += `Total Trades: ${weekTrades.length}\n`;
  summary += `✅ Wins: ${wins} | ❌ Losses: ${losses}\n`;
  summary += `Win Rate: ${winRate}%\n`;
  summary += `Total P/L: ${totalProfit.toFixed(2)}%\n`;
  summary += `Avg Win: +${avgWin.toFixed(2)}% | Avg Loss: ${avgLoss.toFixed(2)}%\n\n`;

  // Detailed trades
  summary += `📋 **TRADE DETAILS:**\n\n`;
  weekTrades.sort((a, b) => new Date(b.closedDate) - new Date(a.closedDate));

  weekTrades.forEach((trade, idx) => {
    const status = trade.finalPnLPercent >= 0 ? "✅" : "❌";
    summary += `${idx + 1}. ${status} **${trade.symbol}**\n`;
    summary += `   Entry: $${trade.entryPrice.toFixed(2)} → Final: $${trade.finalPrice.toFixed(2)}\n`;
    summary += `   P/L: ${trade.finalPnLPercent.toFixed(2)}% | Days: ${(new Date(trade.closedDate) - new Date(trade.suggestedDate)) / (1000 * 60 * 60 * 24)}\n`;
    summary += `   Reason: ${trade.reason || "Expired"}\n\n`;
  });

  // Best and worst
  if (weekTrades.length > 0) {
    const best = weekTrades.reduce((max, t) => t.finalPnLPercent > max.finalPnLPercent ? t : max);
    const worst = weekTrades.reduce((min, t) => t.finalPnLPercent < min.finalPnLPercent ? t : min);

    summary += `🏆 **BEST TRADE:** ${best.symbol} (+${best.finalPnLPercent.toFixed(2)}%)\n`;
    summary += `⚠️ **WORST TRADE:** ${worst.symbol} (${worst.finalPnLPercent.toFixed(2)}%)\n\n`;
  }

  summary += `**Week Complete!** Ready for next week 🚀\n`;

  return summary;
}

// ==================== EQUITY CURVE & DRAWDOWN ====================

function getEquityCurve() {
  return safeReadJson(EQUITY_CURVE_FILE, {
    startDate: new Date().toISOString(),
    dailyPnL: [{ date: new Date().toISOString().split("T")[0], pnl: 0 }],
    peakEquity: 0,
    maxDrawdown: 0,
    drawdownDays: 0,
    weeklyStart: new Date().toISOString().split("T")[0],
    weeklyStartEquity: 0,
  });
}

function updateEquityCurve(trade, finalPnL = null) {
  const equity = getEquityCurve();
  const today = new Date().toISOString().split("T")[0];
  const lastEntry = equity.dailyPnL[equity.dailyPnL.length - 1];

  let totalPnL = equity.dailyPnL.reduce((sum, d) => sum + d.pnl, 0);

  if (finalPnL !== null) {
    totalPnL += finalPnL;
  }

  if (lastEntry.date !== today) {
    equity.dailyPnL.push({ date: today, pnl: finalPnL || 0 });
  } else if (finalPnL !== null) {
    lastEntry.pnl += finalPnL;
    totalPnL = equity.dailyPnL.reduce((sum, d) => sum + d.pnl, 0);
  }

  const peakEquity = Math.max(equity.peakEquity, Math.max(totalPnL, 0));
  const drawdown = peakEquity - totalPnL;
  const drawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;

  equity.peakEquity = peakEquity;
  equity.maxDrawdown = Math.max(equity.maxDrawdown, drawdownPercent);
  equity.drawdownDays = drawdown > 0 ? (equity.drawdownDays || 0) + 1 : 0;
  equity.currentPnL = totalPnL;
  equity.currentDrawdownPercent = drawdownPercent;

  safeWriteJson(EQUITY_CURVE_FILE, equity);
  return equity;
}

function getWeeklyPnL() {
  const equity = getEquityCurve();
  const week = new Date();
  const weekStart = new Date(week);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split("T")[0];

  const weeklyTrades = equity.dailyPnL.filter(d => d.date >= weekStartStr);
  return weeklyTrades.reduce((sum, d) => sum + d.pnl, 0);
}

function checkDailyLossLimit() {
  const weeklyPnL = getWeeklyPnL();
  const maxWeeklyLoss = -5; // Stop if down 5% from week start
  return weeklyPnL > maxWeeklyLoss;
}

// ==================== STATISTICS ====================

function updateStats(trade, finalPnL = null) {
  const stats = safeReadJson(STATS_FILE, {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    totalLoss: 0,
    avgWinSize: 0,
    avgLossSize: 0,
    winRate: 0,
    currentStreak: 0,
    maxStreak: 0,
    lastUpdate: new Date().toISOString(),
  });

  if (finalPnL !== null) {
    stats.totalTrades++;
    if (finalPnL >= 0) {
      stats.wins++;
      stats.totalProfit += finalPnL;
      stats.currentStreak = Math.max(stats.currentStreak + 1, stats.currentStreak);
    } else {
      stats.losses++;
      stats.totalLoss += Math.abs(finalPnL);
      stats.currentStreak = Math.min(stats.currentStreak - 1, stats.currentStreak);
    }
    stats.maxStreak = Math.max(Math.abs(stats.currentStreak), stats.maxStreak);
    stats.winRate = (stats.wins / stats.totalTrades * 100).toFixed(1);
    stats.avgWinSize = stats.wins > 0 ? (stats.totalProfit / stats.wins).toFixed(2) : 0;
    stats.avgLossSize = stats.losses > 0 ? (stats.totalLoss / stats.losses).toFixed(2) : 0;
  }

  stats.lastUpdate = new Date().toISOString();
  safeWriteJson(STATS_FILE, stats);
  return stats;
}

// ==================== DISCORD FORMATTING ====================

function formatTradeMessage(trade, stats, equity, vix) {
  let message = "🎯 **NEW SWING OPTION TRADE SUGGESTION** 🎯\n\n";

  message += `**${trade.symbol}** | RSI: ${trade.rsi.toFixed(0)} | Vol: ${trade.volatility.toFixed(1)}%\n`;
  message += `**Stock Price:** $${trade.price.toFixed(2)} | **Type:** ${trade.type}\n`;
  message += `**Strike:** $${trade.strikePrice.toFixed(2)} | **Expires:** ${trade.expiryDate} (${trade.expiryDays}d) | **Conf:** ${trade.confidence}%\n`;

  if (vix) {
    message += `📊 VIX: ${vix.toFixed(1)} (${vix > 20 ? "elevated" : vix < 15 ? "low" : "normal"} volatility)\n`;
  }

  if (trade.supportConfirmed) {
    message += `✅ **Near support/resistance** | Support: ${trade.distToSupport?.toFixed(1)}% away\n\n`;
  } else {
    message += `⚠️ Not near key levels\n\n`;
  }

  const src = trade.priceSource;
  const priceLabel = src === "webull"
    ? `(✅ LIVE — Webull)`
    : src === "polygon-eod-repriced"
      ? `(REAL — Polygon EOD${trade.priceAsOf ? " " + trade.priceAsOf : ""}, repriced)`
      : src === "polygon-eod"
        ? `(REAL — Polygon EOD${trade.priceAsOf ? " " + trade.priceAsOf : ""})`
        : "(⚠️ Black-Scholes estimate)";
  message += `💰 **OPTION PRICES** ${priceLabel}:\n`;
  message += `📍 Entry: $${trade.currentOptionPrice.toFixed(2)}\n`;
  message += `🎯 Target: $${trade.targetOptionPrice.toFixed(2)} (projected)\n`;
  message += `🛑 Stop Loss: $${trade.stopOptionPrice.toFixed(2)} (projected)\n`;
  message += `💹 Potential: $${trade.optionProfit.toFixed(2)} (+${trade.optionProfitPercent.toFixed(1)}%)\n`;
  if (trade.optionVolume != null) {
    message += `📦 Liquidity: ${trade.optionVolume} contracts/day${trade.thinLiquidity ? " ⚠️ THIN — wide spreads likely" : ""}\n`;
  }
  message += `\n`;

  message += `📊 **GREEKS (UPDATED):**\n`;
  message += `Δ: ${trade.delta.toFixed(2)} | Θ: ${trade.theta.toFixed(3)}/day | ν: ${trade.vega.toFixed(3)}\n\n`;

  message += `📈 **TARGETS:**\n`;
  message += `Entry: $${trade.entryPrice.toFixed(2)} → Target: $${trade.targetPrice.toFixed(2)} (+${trade.targetPercent.toFixed(1)}%)\n`;
  message += `Stop: $${trade.stopLoss.toFixed(2)} (${trade.stopLossPercent.toFixed(1)}%) | R/R: 1:${(Math.abs(trade.targetPercent / trade.stopLossPercent)).toFixed(1)}\n\n`;

  message += `**${trade.rationale}**\n\n`;

  if (stats && stats.totalTrades > 0) {
    message += `📊 **TRACK RECORD:** ${stats.wins}W-${stats.losses}L (${stats.winRate}%)\n`;
    message += `Avg: +${stats.avgWinSize}% / ${stats.avgLossSize}% | Streak: ${Math.abs(stats.currentStreak)}${stats.currentStreak > 0 ? "W" : "L"}\n\n`;
  }

  if (equity) {
    const weeklyPnL = getWeeklyPnL();
    message += `📈 **EQUITY CURVE:**\n`;
    message += `Weekly P/L: ${weeklyPnL.toFixed(2)}% | Max Drawdown: ${equity.maxDrawdown.toFixed(2)}%\n`;
    message += `Current Drawdown: ${equity.currentDrawdownPercent?.toFixed(2) || "0"}%\n`;
  }

  return message;
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
        username: "Swing Options Tracker v2",
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

// ==================== MAIN ====================

async function main() {
  const stateFile = path.join(process.cwd(), DEFAULT_STATE_FILE);
  const isTestRun = process.env.TEST_MODE === "true";

  console.log(`[${getNyTime()}] Swing Options Tracker v2 (Enhanced) started`);

  // ✅ CHECK IF MARKET DAY
  if (!isMarketDay() && !isTestRun) {
    console.log(`[${getNyTime()}] Market is closed today (weekend/holiday). Exiting.`);
    process.exit(0);
  }

  // ✅ CHECK DAILY LOSS LIMIT
  if (!checkDailyLossLimit() && !isTestRun) {
    const weeklyPnL = getWeeklyPnL();
    console.log(`[${getNyTime()}] ⚠️ Weekly P/L at ${weeklyPnL.toFixed(2)}% (below -5% threshold). Skipping today's suggestion.`);
    await sendDiscordMessage(`⚠️ **DAILY LOSS LIMIT HIT** ⚠️\n\nWeekly P/L: ${weeklyPnL.toFixed(2)}%\n\nTaking a break today. Risk management in effect.`);
    process.exit(0);
  }

  // ✅ CHECK VOLATILITY REGIME
  console.log(`[${getNyTime()}] Checking market volatility (VIX)...`);
  const vix = await fetchVIX();
  const volRegime = checkVolatilityRegime(vix);
  console.log(`[${getNyTime()}] ${volRegime.reason}`);

  if (!volRegime.safe && !isTestRun) {
    let message = `🚨 **VOLATILITY REGIME ALERT** 🚨\n\n`;
    if (volRegime.vix > 30) {
      message += `VIX at **${volRegime.vix.toFixed(1)}** — Market in panic mode\n`;
      message += `High implied volatility makes option pricing unstable\n`;
      message += `Skipping trade suggestion today for risk management.\n\n`;
    } else if (volRegime.vix < 12) {
      message += `VIX at **${volRegime.vix.toFixed(1)}** — Market too complacent\n`;
      message += `Low volatility options are expensive relative to movement\n`;
      message += `Skipping trade suggestion today for better risk/reward.\n\n`;
    }
    message += `📊 Check back tomorrow when VIX normalizes to 12-30 range.`;
    await sendDiscordMessage(message);
    process.exit(0);
  }

  // Load state and journey
  let state = safeReadJson(stateFile, { trades: [] });
  let journey = safeReadJson(".swing-options-journey.json", {
    startDate: new Date().toISOString(),
    trades: [],
    weeklyReports: [],
  });

  // Check for trades to close and generate summaries
  const closedTrades = [];
  const activeTrades = [];

  for (const trade of state.trades) {
    const daysSuggested = getExpiryDaysFromTrade(new Date(trade.suggestedDate));
    // Close once we reach the trade's actual expiry date (fallback to legacy
    // 5-day rule for older trades without an expiryDate).
    const expired = trade.expiryDate
      ? etDateString() >= trade.expiryDate
      : daysSuggested >= 5;
    if (expired) {
      const closedTrade = {
        ...trade,
        daysHeld: daysSuggested,
        finalPrice: trade.currentPrice,
        finalPnLPercent: ((trade.currentPrice - trade.entryPrice) / trade.entryPrice * 100),
        expiredLoss: true,
        lossReason: "Expiry reached without hitting target",
      };
      closedTrades.push(closedTrade);

      // Update journey
      const journeyTradeIndex = journey.trades.findIndex(
        t => t.symbol === trade.symbol && t.suggestedDate === trade.suggestedDate
      );
      if (journeyTradeIndex >= 0) {
        journey.trades[journeyTradeIndex].isClosed = true;
        journey.trades[journeyTradeIndex].closedDate = new Date().toISOString();
        journey.trades[journeyTradeIndex].finalPrice = closedTrade.finalPrice;
        journey.trades[journeyTradeIndex].finalPnLPercent = closedTrade.finalPnLPercent;
        journey.trades[journeyTradeIndex].reason = closedTrade.lossReason;
      }

      // Update equity curve
      updateEquityCurve(closedTrade, closedTrade.finalPnLPercent);
    } else {
      activeTrades.push(trade);

      // Update journey with daily update
      const journeyTradeIndex = journey.trades.findIndex(
        t => t.symbol === trade.symbol && t.suggestedDate === trade.suggestedDate
      );
      if (journeyTradeIndex >= 0) {
        const lastUpdate = journey.trades[journeyTradeIndex].dailyUpdates[
          journey.trades[journeyTradeIndex].dailyUpdates.length - 1
        ];
        const today = new Date().toDateString();
        const lastUpdateDate = new Date(lastUpdate.date).toDateString();

        if (today !== lastUpdateDate) {
          journey.trades[journeyTradeIndex].dailyUpdates.push({
            date: new Date().toISOString(),
            price: trade.currentPrice,
            pnlPercent: ((trade.currentPrice - trade.entryPrice) / trade.entryPrice * 100),
            status: "UPDATE",
          });
        }
      }
    }
  }

  // Post summaries for closed trades
  for (const closedTrade of closedTrades) {
    const summary = generateTradeSummary(closedTrade);
    console.log(`[${getNyTime()}] Posting summary for closed trade: ${closedTrade.symbol}`);
    await sendDiscordMessage(summary);
  }

  // Check if Saturday for weekly summary
  const today = new Date();
  const nyToday = new Date(today.toLocaleString("en-US", { timeZone: TZ }));
  const dayOfWeek = nyToday.getDay();

  if (dayOfWeek === 6 && !isTestRun) {
    const weeklySummary = generateWeeklySummary(journey);
    console.log(`[${getNyTime()}] Posting weekly summary`);
    await sendDiscordMessage(weeklySummary);
  }

  safeWriteJson(".swing-options-journey.json", journey);
  state.trades = activeTrades;

  // Fetch stock data
  console.log(`[${getNyTime()}] Analyzing ${ELIGIBLE_SYMBOLS.length} stocks...`);
  const stockDataPromises = ELIGIBLE_SYMBOLS.map((symbol) => fetchStockData(symbol));
  const allStocks = await Promise.all(stockDataPromises);
  const validStocks = allStocks.filter((s) => s !== null);

  console.log(`[${getNyTime()}] Fetched data for ${validStocks.length} stocks`);

  // Fetch earnings dates and score stocks
  console.log(`[${getNyTime()}] Checking earnings dates...`);
  const earningsPromises = validStocks.map((stock) => fetchEarningsDate(stock.symbol));
  const earningsDates = await Promise.all(earningsPromises);

  const scoredStocks = validStocks
    .map((stock, idx) => {
      const daysEarnings = daysUntilEarnings(earningsDates[idx]);
      return {
        ...stock,
        earningsDate: earningsDates[idx],
        daysUntilEarnings: daysEarnings,
        scoring: scoreStock(stock, daysEarnings),
      };
    })
    .filter((s) => {
      if (s.daysUntilEarnings <= 5) {
        console.log(`[${getNyTime()}] Skipping ${s.symbol}: earnings in ${s.daysUntilEarnings} days`);
        return false;
      }
      return s.scoring.finalScore > 20;
    })
    .sort((a, b) => b.scoring.finalScore - a.scoring.finalScore);

  if (scoredStocks.length === 0) {
    console.log(`[${getNyTime()}] No high-confidence trades found today`);
    process.exit(0);
  }

  // Select best trade
  const bestStock = scoredStocks[0];
  console.log(`[${getNyTime()}] Top trade: ${bestStock.symbol} (score: ${bestStock.scoring.finalScore.toFixed(0)})`);

  // Generate trade with updated Greeks
  const newTrade = await generateNewTrade(bestStock, bestStock.scoring);
  newTrade.supportConfirmed = bestStock.nearSupportResistance;
  newTrade.distToSupport = bestStock.distToSupport;
  newTrade.distToResistance = bestStock.distToResistance;

  recordTradeJourney(newTrade);
  state.trades.unshift(newTrade);

  const stats = updateStats(newTrade);
  const equity = getEquityCurve();

  safeWriteJson(stateFile, state);

  // Post to Discord with equity curve and VIX
  const message = formatTradeMessage(newTrade, stats, equity, vix);
  await sendDiscordMessage(message);
  console.log(`[${getNyTime()}] Posted to Discord ✓`);

  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${getNyTime()}] Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  fetchStockData,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateVolatility,
  scoreStock,
  generateNewTrade,
  updateStats,
  ELIGIBLE_SYMBOLS,
};
