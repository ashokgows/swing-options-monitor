/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  OPTIONS TRADING ONLY — Swing Options Bot
 * ═══════════════════════════════════════════════════════════════════════════
 * Always-on Discord bot for swing options trading.
 * • Max $100 per trade
 * • Scans at 9:45 AM ET + every 15 min (if no open position)
 * • Monitors every 5 min during market hours
 * • TP1 hit → SL moves to breakeven, wait for TP2
 * • Commands: !scan !positions !health !status !performance
 * • Reports: Daily (4 PM) | Weekly (Fri 4 PM) | Monthly (last trading day)
 * • All times in ET
 * ═══════════════════════════════════════════════════════════════════════════
 */

const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require("discord.js");
const fs   = require("fs");
const path = require("path");
const WebullClient = require("./webull-integration"); // Using direct API with correct endpoints

// ── CONSTANTS ──────────────────────────────────────────────────────────────

const TZ         = "America/New_York";
const STATE_FILE = path.join(process.cwd(), ".swing-options-state.json");
const PERF_FILE  = path.join(process.cwd(), ".swing-options-performance.json");

const MIN_BUDGET          = 10;    // absolute floor — won't trade with less than $10
const FALLBACK_BUDGET     = parseFloat(process.env.MAX_TRADE_BUDGET || "76"); // used when balance API is unavailable
const ABSOLUTE_MAX_BUDGET = parseInt(process.env.ABSOLUTE_MAX_BUDGET || "2000", 10);
const CHANNEL_ID          = process.env.DISCORD_CHANNEL_ID;
const APPROVAL_TIMEOUT    = 10 * 60 * 1000;

const DAILY_LOSS_PCT       = 0.25;  // halt when daily loss > 25% of balance
const SL_MULT              = 0.80;  // −20% initial stop loss
const PROFIT_TRAIL_TRIGGER = 1.15;  // activate trailing floor when up 15%
const PROFIT_TRAIL_PCT     = 0.88;  // trail floor at 88% of peak (12% pullback allowed)

// ── MAGIC NUMBER CONFIG (easier to tune) ───────────────────────────────────
const CONFIG = {
  VOLATILITY_FLOOR:        0.008,  // min daily volatility to trade
  IV_PERCENTILE_WINDOW:    0.80,   // min IV percentile rank
  ZERO_DTE_BUDGET_THRESHOLD: 150,  // budget threshold for 0DTE trades
  ADX_TREND_STRENGTH:      25,     // minimum ADX for strong trend
  VOLUME_RATIO:            0.80,   // min volume as % of 20-day avg
};

// ── TRANSACTION LOCK (prevent race conditions) ────────────────────────────
let isPlacingOrder = false;  // flag to prevent concurrent order placements
const LOCK_TIMEOUT = 10000;  // 10 second timeout for lock

// ── ADX CACHE (#4 - Performance optimization) ────────────────────────────
// Avoid recalculating ADX (O(n²)) on every symbol scan
// Format: { "SYMBOL": { adx: 25.5, timestamp: Date.now(), lastBarTime: "2026-06-27 14:30" } }
const adxCache = {};
const ADX_CACHE_TTL = 60000; // 1 minute TTL

function getCachedADX(symbol, barTime) {
  const cached = adxCache[symbol];
  if (!cached) return null;
  if (cached.lastBarTime === barTime && Date.now() - cached.timestamp < ADX_CACHE_TTL) {
    return cached.adx;
  }
  return null;
}

function setCachedADX(symbol, adx, barTime) {
  adxCache[symbol] = { adx, timestamp: Date.now(), lastBarTime: barTime };
}

// Top 100 S&P 500 components (by market cap) + major sector/index ETFs
const ELIGIBLE_SYMBOLS = [
  // ── MEGA-CAP TECH (30+) ──────────────────────────────────────────────────
  "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD",
  "INTC", "QCOM", "AMAT", "LRCX", "MU", "ARM", "DELL", "ORCL", "CRM",
  "ADBE", "NOW", "INTU", "SNOW", "PANW", "CRWD", "NET", "PLTR", "ASML",
  "ASML", "MSTR", "PYPL", "COIN", "HOOD", "SQ", "RBLX", "ZM",

  // ── LARGE-CAP TECH (additional) ──────────────────────────────────────────
  "ACN", "IBM", "CSCO", "ORCL", "INTU", "ENPH", "SEDG", "ON", "ONTO", "AMD",
  "NXPI", "AVGO", "MRVL", "QRVO", "SWKS", "LSCC", "LDOS", "GIB", "SNPS", "CDNS",

  // ── MEGA-CAP FINANCIALS (35+) ──────────────────────────────────────────
  "JPM", "BAC", "GS", "MS", "WFC", "C", "BLK", "SCHW", "AXP", "V", "MA",
  "COF", "LEN", "PGR", "PRU", "MET", "PFG", "AIG", "LEG", "NRG", "ALL",
  "CME", "CBOE", "ICE", "NDAQ", "SPGI", "MCO", "SPY", "IVZ", "STT", "BRK",
  "USB", "PNC", "KEY", "MI", "CFG", "FITB", "HBAN",

  // ── LARGE-CAP HEALTHCARE (50+) ──────────────────────────────────────────
  "UNH", "LLY", "JNJ", "MRK", "ABBV", "PFE", "AMGN", "ABT", "TMO", "DHR",
  "ISRG", "MDT", "BSX", "CVS", "CL", "ELV", "VEEV", "DXCM", "PODD", "MASI",
  "TMDX", "ALCO", "CI", "AET", "HUM", "UHS", "CPRT", "XRAY", "DLTR", "JBT",
  "TEVA", "IDXX", "HST", "LPLA", "HCA", "OHI", "OKE", "EVR", "INVZ", "RGEN",
  "PSTG", "VCYT", "NVRO", "EXAS", "OMCL", "CAR", "SEM", "NECA", "FGEN", "AKAM",

  // ── LARGE-CAP INDUSTRIALS (40+) ──────────────────────────────────────────
  "GE", "CAT", "DE", "RTX", "BA", "MMM", "ADP", "ITT", "CARR", "OTIS",
  "AXON", "EFX", "RSG", "GWW", "AWK", "ARW", "CUZ", "ITW", "EPAC", "LRX",
  "XPO", "KEX", "UFI", "PCAR", "FWDG", "STLD", "NUE", "CF", "ALB", "FCX",
  "LAD", "GPC", "WSM", "TYL", "SLF", "NVDC", "BFAM", "BTU", "ENV", "FANG",

  // ── CONSUMER DISCRETIONARY (50+) ────────────────────────────────────────
  "WMT", "COST", "HD", "LOW", "MCD", "SBUX", "NKE", "TGT", "AMZN", "SHOP",
  "MELI", "BKNG", "ABNB", "UBER", "LYFT", "DASH", "EXPE", "AKAM", "DECK",
  "TJX", "BBY", "ROST", "DKL", "RH", "LVS", "MGM", "WYNN", "PENN", "GSAT",
  "TPL", "KM", "WRK", "ATGE", "DCP", "CPRI", "SJM", "SCCO", "EGO", "MAN",
  "DLTR", "DKNG", "GMAB", "TXRH", "GLDD", "HOLO", "WING", "AWK", "CALM", "BJ",

  // ── ENERGY (25+) ───────────────────────────────────────────────────────
  "XOM", "CVX", "COP", "MPC", "PSX", "VLO", "EOG", "SLB", "HAL", "OKE",
  "MRO", "FANG", "PXD", "AR", "CNX", "SM", "MOD", "CIVI", "KKR", "RIG",
  "SPY", "EQNR", "EQT", "DXPE", "ATMU",

  // ── COMMUNICATIONS (20+) ────────────────────────────────────────────────
  "NFLX", "DIS", "T", "VZ", "SNAP", "PINS", "TWTR", "CMCSA", "CHTR", "PARA",
  "FOX", "FOXA", "WBD", "MTCH", "RDDT", "IAC", "MICT", "INSE", "LMND", "OTTY",

  // ── CONSUMER STAPLES (25+) ──────────────────────────────────────────────
  "PG", "KO", "JNJ", "MO", "PM", "UL", "CL", "KMB", "EL", "CPB", "CLX",
  "GIS", "HSY", "MNST", "AGRO", "K", "NSP", "BGC", "USFD", "LW", "STZ", "TAP",
  "HUBB", "CERS", "LILA", "LILAK",

  // ── REAL ESTATE/REITs (20+) ─────────────────────────────────────────────
  "AMT", "PLD", "CCI", "EQIX", "SPG", "VTR", "O", "LTC", "WELL", "EXR",
  "PSA", "AVB", "EQR", "ARE", "BXP", "KIM", "REXR", "STAG", "SCHW", "VICI",

  // ── UTILITIES (15+) ──────────────────────────────────────────────────────
  "NEE", "DUK", "SO", "EXC", "AEP", "XEL", "DTE", "ED", "WEC", "ETR",
  "PPL", "AES", "PEG", "FE", "NRG",

  // ── MATERIALS (20+) ──────────────────────────────────────────────────────
  "LIN", "SHW", "FCX", "NUE", "CF", "ALB", "DD", "APD", "ECL", "IFF",
  "PPG", "CTVA", "WRK", "SCL", "AMRS", "SBAC", "STLD", "NEM", "GOLD", "OMC",

  // ── TRANSPORTATION (10+) ─────────────────────────────────────────────────
  "UAL", "DAL", "LUV", "AAL", "FDX", "UPS", "SAIA", "KEX", "ALK", "XPO",

  // ── SEMICONDUCTORS (15+) ─────────────────────────────────────────────────
  "NVIDIA", "AMD", "INTC", "QCOM", "AMAT", "LRCX", "ASML", "MU", "MRVL",
  "NXPI", "AVGO", "QRVO", "SWKS", "ON", "SYNA",

  // ── GROWTH & SPECULATION (20+) ───────────────────────────────────────────
  "PLTR", "ROKU", "SOFI", "UPST", "NVTA", "RBLX", "GEVO", "CCIV", "LCID",
  "RIVN", "NKLA", "CCSI", "NET", "CRWD", "PANW", "OKTA", "CHWY", "ZG", "Z",

  // ── ETFs (12) ───────────────────────────────────────────────────────────
  "SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY",
  "TQQQ", "SQQQ",
].filter((s, i, arr) => arr.indexOf(s) === i).sort();

const MARKET_HOLIDAYS_2026 = [
  "01-01", "01-19", "02-16", "04-03", "05-25",
  "06-19", "07-03", "09-07", "11-26", "12-25",
];

// ── TIME HELPERS (all ET) ──────────────────────────────────────────────────

function etDateStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

function etTimeStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
}

function etFull(d = new Date()) {
  return `${etDateStr(d)} ${etTimeStr(d)} ET`;
}

function getEtParts(d = new Date()) {
  const nd = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  return {
    year: nd.getFullYear(),
    month: nd.getMonth(),
    date: nd.getDate(),
    hour: nd.getHours(),
    min: nd.getMinutes(),
    dow: nd.getDay(),
  };
}

function isMarketDay(d = new Date()) {
  const { dow, month, date } = getEtParts(d);
  if (dow === 0 || dow === 6) return false;
  const md = `${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  return !MARKET_HOLIDAYS_2026.includes(md);
}

function isMarketHours(d = new Date()) {
  if (!isMarketDay(d)) return false;
  const { hour, min } = getEtParts(d);
  const t = hour * 100 + min;
  return t >= 930 && t < 1600;
}

// Optimal expiry: Friday at least 7 calendar days out (avoids high theta decay on 1-2 DTE options)
function optimalExpiry() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const dow = et.getDay();
  let daysToFriday = (5 - dow + 7) % 7 || 7;
  if (daysToFriday < 7) daysToFriday += 7; // ensure at least 7 days out
  et.setDate(et.getDate() + daysToFriday);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}

// Days between now (ET) and a YYYY-MM-DD date string (ET, expiry at 4:00 PM)
function daysUntil(dateStr) {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const [year, month, day] = dateStr.split("-").map(Number);
  const expiry = new Date(year, month - 1, day, 16, 0, 0);
  return Math.max(Math.round((expiry - et) / 86400000), 0.01);
}

// ── STATE MANAGEMENT ───────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (err) {
    console.warn(`[${etFull()}] State load error: ${err.message}, using defaults`);
    return {
      pendingApproval: null,
      activeTrades: [],
      closedTrades: [],
      symbolStats: {} // #5: Track wins/losses per symbol for win rate scaling
    };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
  } catch (err) {
    console.error(`[${etFull()}] CRITICAL: State save failed: ${err.message}`);
  }
}

function loadPerf() {
  try {
    return JSON.parse(fs.readFileSync(PERF_FILE, "utf-8"));
  } catch {
    return { allTrades: [] };
  }
}

function savePerf(p) {
  fs.writeFileSync(PERF_FILE, JSON.stringify(p, null, 2) + "\n");
}

// ── DAILY LOSS GUARD ───────────────────────────────────────────────────────

function getDailyPnL() {
  const today = etDateStr();
  return loadPerf().allTrades
    .filter(t => t.date === today)
    .reduce((s, t) => s + t.totalPnL, 0);
}

function getDailyLossLimit() {
  // 25% of last known balance; falls back to 25% of FALLBACK_BUDGET / 0.95
  const state   = loadState();
  const balance = state.lastKnownBalance || (FALLBACK_BUDGET / 0.95);
  return Math.round(balance * DAILY_LOSS_PCT * 100) / 100;
}

function isDailyLossExceeded() {
  return getDailyPnL() <= -getDailyLossLimit();
}

// ── DYNAMIC BUDGET ─────────────────────────────────────────────────────────

// Calculates trade budget dynamically from account balance.
// • balance < $300  → use 95% of balance (small account, deploy most of it)
// • balance ≥ $300  → use 50% of balance (larger account, preserve capital)
// Falls back to MAX_TRADE_BUDGET env var (default $76) when balance API is unavailable.
async function calcTradeBudget(webull) {
  try {
    const bal = await webull.getBalance();
    const bp  = parseFloat(
      bal?.optionBuyingPower || bal?.buyingPower || bal?.cash || 0
    );
    if (bp > MIN_BUDGET) {
      // Persist balance for dynamic daily loss limit
      const s = loadState();
      s.lastKnownBalance = bp;
      saveState(s);

      const ratio   = 1.0; // Use 100% of balance for maximum position sizing
      let dynamic = Math.round(bp * ratio);

      // #3: Scale by recent win rate — 0% WR → 50% of dynamic, 100% WR → 150% of dynamic
      dynamic = scaleBudgetByWinRate(dynamic);

      const budget  = Math.min(Math.max(dynamic, MIN_BUDGET), ABSOLUTE_MAX_BUDGET);
      const winRate = Math.round(calcRecentWinRate() * 100);
      console.log(`[${etFull()}] Balance: $${bp.toFixed(2)} → budget $${budget} (100% of balance, scaled by ${winRate}% win rate)`);
      return budget;
    }
  } catch (e) {
    console.warn(`[${etFull()}] Balance fetch failed — using $${FALLBACK_BUDGET} fallback: ${e.message}`);
  }
  return FALLBACK_BUDGET;
}

// ── VIX REGIME ─────────────────────────────────────────────────────────────

async function getVixLevel(webull) {
  // 1. Try Webull (works if their API exposes index data)
  for (const sym of ["VIX", "^VIX"]) {
    try {
      const bars = await webull.getBars(sym, "1d", 5);
      if (bars && bars.length > 0) return bars[bars.length - 1].close;
    } catch { /* try next */ }
  }

  // 2. Yahoo Finance public endpoint — no key, no auth required
  try {
    const resp = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (resp.ok) {
      const json = await resp.json();
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const last   = closes.filter(Boolean).at(-1);
      if (last) return Math.round(last * 10) / 10;
    }
  } catch { /* fall through */ }

  return null;
}

function classifyVix(vix) {
  if (vix === null) return { label: "Unknown", emoji: "❓", skip: false };
  if (vix > 35)    return { label: `${vix.toFixed(1)} — Extreme fear`, emoji: "🔴", skip: true };
  if (vix > 28)    return { label: `${vix.toFixed(1)} — Elevated`, emoji: "🟠", skip: true };
  if (vix > 20)    return { label: `${vix.toFixed(1)} — Moderate`, emoji: "🟡", skip: false };
  if (vix < 13)    return { label: `${vix.toFixed(1)} — Complacency`, emoji: "🟢", skip: false };
  return             { label: `${vix.toFixed(1)} — Normal`, emoji: "🟢", skip: false };
}

// ── EARNINGS FILTER ────────────────────────────────────────────────────────

// Fetch earnings from Nasdaq public calendar — no API key needed.
// Returns Set of ticker symbols reporting in the next `lookaheadDays` trading days.
async function getEarningsSymbols(lookaheadDays = 3) {
  const symbols = new Set();
  const now     = new Date();

  for (let i = 0; i <= lookaheadDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const dateStr = d.toISOString().split("T")[0];
    try {
      const resp = await fetch(
        `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept":     "application/json",
          },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!resp.ok) continue;
      const json = await resp.json();
      const rows = json?.data?.rows || json?.data?.earnings?.rows || [];
      rows.forEach(r => {
        if (r.symbol) symbols.add(r.symbol.toUpperCase().replace(/\s+/g, ""));
      });
    } catch { /* network error — skip date */ }
  }

  return symbols;
}

// ── TECHNICAL ANALYSIS ─────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains  = deltas.map(d => (d > 0 ? d : 0));
  const losses = deltas.map(d => (d < 0 ? -d : 0));
  const avgG   = gains.slice(-period).reduce((a, b) => a + b) / period;
  const avgL   = losses.slice(-period).reduce((a, b) => a + b) / period;
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std, std };
}

function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = highs.slice(1).map((h, i) =>
    Math.max(h - lows[i + 1], Math.abs(h - closes[i]), Math.abs(lows[i + 1] - closes[i]))
  );
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function calcVolatility(closes) {
  if (closes.length < 5) return 0.02;
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean = rets.reduce((a, b) => a + b) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
}

/**
 * Intraday momentum check using 5-min bars.
 * Returns "WITH" (momentum supports trade), "AGAINST" (turn against), "NEUTRAL"
 */
function intradayMomentum(bars5m, direction) {
  if (!bars5m || bars5m.length < 8) return "NEUTRAL";
  const closes  = bars5m.map(b => b.close);
  const period  = Math.min(closes.length - 1, 9);
  const rsi     = calcRSI(closes, period);
  const last4   = closes.slice(-4);
  const allUp   = last4.every((c, i) => i === 0 || c >= last4[i - 1]);
  const allDown = last4.every((c, i) => i === 0 || c <= last4[i - 1]);
  // Short-term MA cross
  const ma3  = closes.slice(-3).reduce((a, b) => a + b) / 3;
  const ma8  = closes.slice(-8).reduce((a, b) => a + b) / 8;
  const last = closes[closes.length - 1];

  if (direction === "CALL") {
    if (rsi < 40 || allDown || last < ma8 * 0.998) return "AGAINST";
    if (rsi > 55 && (allUp || last > ma3))          return "WITH";
  } else {
    if (rsi > 60 || allUp   || last > ma8 * 1.002)  return "AGAINST";
    if (rsi < 45 && (allDown || last < ma3))         return "WITH";
  }
  return "NEUTRAL";
}

/**
 * Determine market trend from SPY bars (used to bias CALL/PUT preference).
 * Returns: "BULLISH" | "BEARISH" | "NEUTRAL"
 */
function getMarketTrend(spyBars) {
  if (!spyBars || spyBars.length < 10) return "NEUTRAL";
  const closes = spyBars.map(b => b.close);
  const rsi    = calcRSI(closes);
  const ma5    = closes.slice(-5).reduce((a, b) => a + b) / 5;
  const ma20   = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const last   = closes[closes.length - 1];
  if (rsi < 45 || last < ma20 * 0.99) return "BEARISH";
  if (rsi > 55 || last > ma20 * 1.01) return "BULLISH";
  return "NEUTRAL";
}

// ── MACD (12/26/9 standard) ────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── DELTA CALCULATION (for Greeks filtering) ─────────────────────────────

function calcDelta(S, K, T, sigma, type) {
  if (T <= 0) return type === "CALL" ? 1 : 0;
  const r = 0.05;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return type === "CALL" ? cnd(d1) : cnd(d1) - 1;
}

// ── WIN RATE & POSITION SIZING (#3) ──────────────────────────────────────

function calcRecentWinRate(tradeHistory = null) {
  const perf = tradeHistory || loadPerf();
  if (!perf.allTrades || perf.allTrades.length === 0) return 0.5; // default 50%
  const recent = perf.allTrades.slice(-20);
  const wins = recent.filter(t => t.totalPnL > 0).length;
  return recent.length > 0 ? wins / recent.length : 0.5;
}

function scaleBudgetByWinRate(baseBudget) {
  const winRate = calcRecentWinRate();
  // Scale: 0% WR → 50% budget, 50% WR → 100%, 100% WR → 120% (capped to avoid over-leverage)
  const scale = Math.min(0.5 + winRate, 1.2);
  return Math.round(baseBudget * scale * 100) / 100;
}

// ── IV PERCENTILE RANK (#4) ──────────────────────────────────────────────

function calcHistVolPercentile(bars) {
  if (!bars || bars.length < 30) return 0.5; // insufficient data, neutral
  const closes = bars.map(b => b.close);
  const allVols = [];

  // Calculate rolling 20-day volatility across history
  const maxLookback = Math.min(closes.length, 252);
  for (let i = 20; i < maxLookback; i++) {
    const vol = calcVolatility(closes.slice(i - 20, i));
    if (vol > 0) allVols.push(vol);
  }

  if (allVols.length < 5) return 0.5; // too little history

  const currentVol = calcVolatility(closes.slice(-Math.min(20, closes.length)));
  allVols.sort((a, b) => a - b);

  // Find rank: what percentile is current vol
  const rank = allVols.filter(v => v <= currentVol).length / allVols.length;
  return Math.max(0, Math.min(1, rank)); // clamp to [0,1]
}

function isValidIVRank(bars) {
  const rank = calcHistVolPercentile(bars);
  // Only trade when IV is HIGH (> 80th percentile). Skip low/mid-range
  if (rank > 0.8) return true;
  return false;
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12     = calcEMA(closes, 12);
  const ema26     = calcEMA(closes, 26);
  const prevEma12 = calcEMA(closes.slice(0, -1), 12);
  const prevEma26 = calcEMA(closes.slice(0, -1), 26);
  if (!ema12 || !ema26 || !prevEma12 || !prevEma26) return null;

  const macdLine     = ema12 - ema26;
  const prevMacdLine = prevEma12 - prevEma26;
  // Signal line approximation using 9-period EMA of MACD
  const macdHistory = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdHistory.push(e12 - e26);
  }
  const signalLine = macdHistory.length >= 9 ? calcEMA(macdHistory, 9) : 0;
  const histogram  = macdLine - signalLine;

  return {
    macdLine,
    signalLine,
    histogram,
    crossUp:   prevMacdLine <= signalLine && macdLine > signalLine,
    crossDown: prevMacdLine >= signalLine && macdLine < signalLine,
  };
}

// #4: ADX (Average Directional Index) — measure trend strength
function calcADX(highs, lows, closes, period = 14) {
  if (!highs || !lows || !closes || highs.length < period * 2) return null;

  // Calculate True Range
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i - 1];
    const trv = Math.max(h - l, Math.abs(h - c), Math.abs(l - c));
    tr.push(trv);
  }

  // Calculate +DM and -DM
  const dmp = [];
  const dmm = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    let dp = 0, dm = 0;
    if (upMove > 0 && upMove > downMove) dp = upMove;
    if (downMove > 0 && downMove > upMove) dm = downMove;

    dmp.push(dp);
    dmm.push(dm);
  }

  // Calculate smoothed values
  let sumTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sumDP = dmp.slice(0, period).reduce((a, b) => a + b, 0);
  let sumDM = dmm.slice(0, period).reduce((a, b) => a + b, 0);

  let atrSmooth = sumTR;
  let diPlus = (sumDP / sumTR) * 100;
  let diMinus = (sumDM / sumTR) * 100;

  // Calculate DX and ADX
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    atrSmooth = atrSmooth - atrSmooth / period + tr[i];
    sumDP = sumDP - sumDP / period + dmp[i];
    sumDM = sumDM - sumDM / period + dmm[i];

    diPlus = (sumDP / atrSmooth) * 100;
    diMinus = (sumDM / atrSmooth) * 100;
    const di = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
    dx.push(di);
  }

  // ADX is smoothed DX
  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return Math.round(adx * 10) / 10;
}

// #4: STOCHASTIC RSI — RSI of RSI (confirmation for RSI extremes) ──────────
function calcStochRSI(closes, rsiPeriod = 5, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod) return null;

  const rsiValues = [];
  for (let i = rsiPeriod; i <= closes.length; i++) {
    const rsi = calcRSI(closes.slice(0, i), rsiPeriod);
    if (rsi !== null) rsiValues.push(rsi);
  }

  if (rsiValues.length < stochPeriod) return null;

  const minRSI = Math.min(...rsiValues.slice(-stochPeriod));
  const maxRSI = Math.max(...rsiValues.slice(-stochPeriod));
  const lastRSI = rsiValues[rsiValues.length - 1];

  if (maxRSI === minRSI) return 50; // avoid division by zero
  return ((lastRSI - minRSI) / (maxRSI - minRSI)) * 100;
}

// #5: VIX-BASED POSITION SIZING ADJUSTMENT ────────────────────────────────
function getVixPositionAdjustment(vixLevel) {
  if (vixLevel <= 12) {
    return 0.7; // Low VIX: smaller position
  } else if (vixLevel <= 18) {
    return 1.0; // Normal VIX
  } else if (vixLevel <= 25) {
    return 1.1; // Elevated VIX
  } else {
    return 1.2; // High VIX
  }
}

// #6: TIME-BASED POSITION SCALING (larger early in day) ────────────────────
function getTimeOfDayPositionAdjustment() {
  const { hour, min } = getEtParts();

  // Early morning (9:45-10:30): Highest volatility, trade larger
  if (hour === 9 && min >= 45 || hour === 10 && min < 30) return 1.2;

  // Mid-morning (10:30-11:30): Still good, normal size
  if (hour >= 10 && hour < 11 || hour === 11 && min < 30) return 1.0;

  // Midday (11:30-1:30): Skip anyway, but if signal appears, reduce
  if (hour >= 11 && hour < 13 || hour === 13 && min < 30) return 0.7;

  // Afternoon (1:30-3:20): Good moves, normal size
  if (hour >= 13 && hour < 15 || hour === 15 && min < 20) return 1.0;

  return 0.8; // Outside hours, reduced
}

// #7: RECENT HIGH/LOW AVOIDANCE ──────────────────────────────────────────
function isNearRecentExtreme(bars, lookback = 10) {
  if (!bars || bars.length < lookback) return false;

  const recent = bars.slice(-lookback);
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);

  const recentHigh = Math.max(...highs);
  const recentLow = Math.min(...lows);
  const current = bars[bars.length - 1].close;

  // Don't trade if within 1% of recent high or low (reversal risk)
  const nearHigh = current >= recentHigh * 0.99;
  const nearLow = current <= recentLow * 1.01;

  return nearHigh || nearLow;
}

// #8: TRADE FREQUENCY LIMITER ──────────────────────────────────────────────
function getSymbolTradeCountToday(symbol, state) {
  if (!state.closedTrades) return 0;

  const today = etDateStr();
  return state.closedTrades.filter(t =>
    t.symbol === symbol && t.date === today
  ).length;
}

function canTradeSymbolAgain(symbol, state, maxPerDay = 2) {
  const count = getSymbolTradeCountToday(symbol, state);
  return count < maxPerDay;
}

// #9: PROFIT TARGET OPTIMIZATION (varies by IV) ────────────────────────────
function getOptimalProfitTarget(iv, direction = "CALL") {
  // Low IV: Take smaller profits (1-2%)
  if (iv < 0.15) return 1.01; // 1%

  // Normal IV: Reasonable targets (2-4%)
  if (iv < 0.30) return 1.03; // 3%

  // High IV: Can aim for bigger moves (4-6%)
  if (iv < 0.50) return 1.05; // 5%

  // Very high IV: Maximum 6%
  return 1.06;
}

// #10: VOLUME PROFILE CHECK ──────────────────────────────────────────────────
function isHighVolumeZone(bars, lookback = 20) {
  if (!bars || bars.length < lookback) return true; // default allow

  const recent = bars.slice(-lookback);
  const volumes = recent.map(b => b.volume || 0);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const lastVolume = bars[bars.length - 1].volume || 0;

  // Trading where volume is above average = good liquidity
  return lastVolume >= avgVolume * 0.8;
}

// #11: MOMENTUM DECAY DETECTOR ───────────────────────────────────────────────
function hasMomentumDecayed(closes, rsiPeriod = 5, lookback = 3) {
  if (closes.length < rsiPeriod + lookback) return false;

  const rsiValues = [];
  for (let i = rsiPeriod; i <= closes.length; i++) {
    const rsi = calcRSI(closes.slice(0, i), rsiPeriod);
    if (rsi !== null) rsiValues.push(rsi);
  }

  if (rsiValues.length < lookback) return false;

  const recentRSI = rsiValues.slice(-lookback);
  const trend = recentRSI[recentRSI.length - 1] - recentRSI[0];

  // If RSI is declining fast, momentum is decaying
  return trend < -10; // More than 10 point drop = decay
}

// #12: OVERNIGHT GAP CHECK ───────────────────────────────────────────────────
function hasOvernightGap(bars, threshold = 0.02) {
  if (bars.length < 2) return false;

  const yesterday = bars[bars.length - 2];
  const today = bars[bars.length - 1];

  if (!yesterday || !today) return false;

  const gap = Math.abs(today.open - yesterday.close) / yesterday.close;

  // Gap > 2% = significant gap (might reverse)
  return gap > threshold;
}

// #2: BOLLINGER BANDS SQUEEZE DETECTION ──────────────────────────────────
function calcBollingerMetrics(closes, period = 20) {
  if (closes.length < period) return null;

  const recent = closes.slice(-period);
  const sma = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + (2 * stdDev);
  const lower = sma - (2 * stdDev);
  const bandwidth = (upper - lower) / sma; // width as % of price

  const last = closes[closes.length - 1];
  const isNearUpper = last >= upper * 0.99;
  const isNearLower = last <= lower * 1.01;
  const isSqueezed = bandwidth < 0.02; // < 2% bandwidth = squeeze

  return {
    upper,
    lower,
    sma,
    bandwidth,
    isNearUpper,
    isNearLower,
    isSqueezed,
  };
}

// #3: SUPPORT/RESISTANCE LEVELS ──────────────────────────────────────────
function calcSupportResistance(bars, lookback = 20) {
  if (!bars || bars.length < lookback) return null;

  const recent = bars.slice(-lookback);
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const current = bars[bars.length - 1].close;

  // Check if current price is near support or resistance
  const nearSupport = current <= support * 1.02;
  const nearResistance = current >= resistance * 0.98;

  return {
    support,
    resistance,
    nearSupport,
    nearResistance,
  };
}

// ── SECTOR ETF MAP ─────────────────────────────────────────────────────────

const SECTOR_ETF_MAP = {
  XLK: ["NVDA","AAPL","MSFT","AVGO","AMD","INTC","QCOM","AMAT","LRCX","MU","ARM","DELL","ORCL","CRM","ADBE","NOW","INTU","SNOW","PANW","CRWD"],
  XLF: ["JPM","BAC","GS","MS","WFC","C","BLK","SCHW","AXP","V","MA","PYPL","COIN","HOOD","SPGI","CME"],
  XLY: ["WMT","COST","HD","LOW","MCD","SBUX","NKE","TGT","SHOP","MELI","BKNG","ABNB","UBER","LYFT","DASH","AMZN"],
  XLV: ["UNH","LLY","ABBV","PFE","MRK","AMGN","ABT","TMO","DHR","ISRG","MDT","BSX","CVS"],
  XLI: ["GE","CAT","DE","RTX","BA","ADP","MMM"],
  XLE: ["XOM","CVX"],
  XLC: ["NFLX","DIS","T","VZ","SNAP","PINS","RBLX","ZM","META","GOOGL"],
};

// Build reverse map: symbol → { etf }
const SYMBOL_SECTOR_MAP = {};
for (const [etf, symbols] of Object.entries(SECTOR_ETF_MAP)) {
  for (const sym of symbols) {
    SYMBOL_SECTOR_MAP[sym] = { etf, _trend: "NEUTRAL" };
  }
}

// ── #5: WIN RATE SCALING BY SYMBOL ───────────────────────────────────────
/**
 * Get position size multiplier based on symbol's historical win rate
 * High win rate symbols → larger position (up to 1.5x)
 * Low win rate symbols → smaller position (down to 0.5x)
 */
function getSymbolWinRateMultiplier(symbol, direction, state) {
  if (!state.symbolStats || !state.symbolStats[symbol]) return 1.0;

  // #1: Use direction-specific win rate (CALL vs PUT)
  const dirWinRate = getDirectionWinRate(symbol, direction, state);
  const dirKey = direction === "CALL" ? "calls" : "puts";
  const dirStats = state.symbolStats[symbol][dirKey];
  const dirTotal = dirStats.wins + dirStats.losses;

  if (dirTotal < 2) return 1.0; // need at least 2 trades for direction

  // Calculate overall win rate
  const allStats = Object.values(state.symbolStats || {});
  const allWins = allStats.reduce((s, v) => s + v.calls.wins + v.puts.wins, 0);
  const allLosses = allStats.reduce((s, v) => s + v.calls.losses + v.puts.losses, 0);
  const overallWinRate = (allWins + allLosses > 0) ? allWins / (allWins + allLosses) : 0.5;

  // #1: Scale based on direction-specific win rate
  const multiplier = 0.5 + (dirWinRate / (overallWinRate || 0.5) * 0.5);

  // Bonus: If direction win rate is significantly better, allow up to 1.5x
  if (dirWinRate > 0.7 && overallWinRate > 0) {
    return Math.min(Math.max(multiplier, 0.5), 1.5);
  }

  return Math.min(Math.max(multiplier, 0.5), 1.2); // cap between 0.5x and 1.2x if not strong
}

/**
 * Record trade result (win/loss) by symbol
 */
function recordTradeResult(symbol, direction, isWin, state) {
  if (!state.symbolStats) state.symbolStats = {};
  if (!state.symbolStats[symbol]) {
    state.symbolStats[symbol] = {
      calls: { wins: 0, losses: 0 },
      puts: { wins: 0, losses: 0 }
    };
  }

  const dirKey = direction === "CALL" ? "calls" : "puts";
  if (isWin) {
    state.symbolStats[symbol][dirKey].wins += 1;
  } else {
    state.symbolStats[symbol][dirKey].losses += 1;
  }
}

// Get direction-specific win rate for a symbol
function getDirectionWinRate(symbol, direction, state) {
  if (!state.symbolStats || !state.symbolStats[symbol]) return 0.5; // neutral if no data

  const dirKey = direction === "CALL" ? "calls" : "puts";
  const stats = state.symbolStats[symbol][dirKey];
  const total = stats.wins + stats.losses;

  if (total < 2) return 0.5; // need at least 2 trades

  return stats.wins / total;
}

// ── #2: RISK/REWARD RATIO CALCULATOR ──────────────────────────────────────
/**
 * Calculate risk/reward ratio for a potential trade
 * RR = (TP - Entry) / (Entry - SL)
 * Only trade if RR >= 1.5x (or configurable threshold)
 */
function calcRiskRewardRatio(entryPrice, stopLoss, targetPrice) {
  if (entryPrice <= stopLoss || targetPrice <= entryPrice) return 0;

  const risk = entryPrice - stopLoss;
  const reward = targetPrice - entryPrice;

  return reward / risk; // e.g., 1.5x means 2:3 risk/reward
}

/**
 * Score a stock for an options setup.
 * @param {string} symbol
 * @param {Array}  bars        — daily OHLCV array
 * @param {string} marketTrend — "BULLISH" | "BEARISH" | "NEUTRAL"
 * Returns null if no qualifying setup.
 */
function scoreSetup(symbol, bars, marketTrend = "NEUTRAL", state = null) {
  if (!bars || bars.length < 22) return null;

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);

  // ── PRE-FILTERS (quick exit if disqualified) ──────────────────────────────
  // #7: Skip if near recent highs/lows (reversal risk)
  if (isNearRecentExtreme(bars)) return null;

  // #12: Skip if overnight gap (mean reversion risk)
  if (hasOvernightGap(bars)) return null;

  // #8: Skip if already traded this symbol today (limit frequency)
  if (state && !canTradeSymbolAgain(symbol, state, 2)) return null;
  const volumes = bars.map(b => b.volume);

  const last  = closes[closes.length - 1];
  const rsi   = calcRSI(closes);
  const bb    = calcBB(closes);
  const atr   = calcATR(highs, lows, closes);
  const vol   = calcVolatility(closes.slice(-10));

  if (!bb || !atr || last <= 0) return null;
  if (vol < CONFIG.VOLATILITY_FLOOR) return null; // too quiet for options

  // #3: Volume confirmation — only trade high-volume stocks
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (volumes[volumes.length - 1] < avgVol20 * 0.8) {
    return null; // skip if today's volume < 80% of 20-day average
  }

  // #4: ADX trend strength — only trade strong trends (ADX > 25)
  // Use cache to avoid O(n²) recalculation
  const barTime = bars[bars.length - 1].time || new Date().toISOString();
  let adx = getCachedADX(symbol, barTime);
  if (adx === null) {
    adx = calcADX(highs, lows, closes);
    if (adx !== null) setCachedADX(symbol, adx, barTime);
  }
  if (!adx || adx < CONFIG.ADX_TREND_STRENGTH) {
    return null; // skip if trend is weak
  }

  let score     = 0;
  let direction = null;
  const reasons = [];

  // ── #1: ENTRY CONFIRMATION CANDLE (improved entry timing) ────────────────
  const prevRSI = closes.length >= 2 ? calcRSI(closes.slice(0, -1), 5) : null;

  // ── Bullish signals → CALL ──
  if (rsi < 30) {
    score += 35; direction = "CALL";
    reasons.push(`RSI ${rsi.toFixed(0)} — deeply oversold`);

    // #1: Confirmation: RSI bounced ABOVE 30 (confirmation candle) ─────────
    if (prevRSI !== null && prevRSI < 30 && rsi > 30 && rsi < 40) {
      score += 10; reasons.push("Entry confirmation: RSI bounced off 30 (buy signal)");
    }
  } else if (rsi < 40 && last <= bb.lower * 1.01) {
    score += 28; direction = "CALL";
    reasons.push(`RSI ${rsi.toFixed(0)} + price at BB lower ($${bb.lower.toFixed(2)})`);
  } else if (rsi < 45 && last <= bb.lower * 1.005) {
    score += 20; direction = "CALL";
    reasons.push(`Price at BB lower, RSI ${rsi.toFixed(0)}`);
  }

  // ── Bearish signals → PUT ──
  if (rsi > 70) {
    score += 35; direction = "PUT";
    reasons.push(`RSI ${rsi.toFixed(0)} — deeply overbought`);

    // #1: Confirmation: RSI dropped BELOW 70 (confirmation candle) ─────────
    if (prevRSI !== null && prevRSI > 70 && rsi < 70 && rsi > 60) {
      score += 10; reasons.push("Entry confirmation: RSI broke below 70 (sell signal)");
    }
  } else if (rsi > 60 && last >= bb.upper * 0.99) {
    score += 28; direction = "PUT";
    reasons.push(`RSI ${rsi.toFixed(0)} + price at BB upper ($${bb.upper.toFixed(2)})`);
  } else if (rsi > 55 && last >= bb.upper * 0.995) {
    score += 20; direction = "PUT";
    reasons.push(`Price at BB upper, RSI ${rsi.toFixed(0)}`);
  }

  if (!direction || score < 20) return null;

  // ── Market trend alignment bonus ─────────────────────────────────────────
  if (direction === "CALL" && marketTrend === "BULLISH") {
    score += 10; reasons.push("Aligned with bullish market trend (SPY)");
  } else if (direction === "PUT" && marketTrend === "BEARISH") {
    score += 10; reasons.push("Aligned with bearish market trend (SPY)");
  } else if (direction === "CALL" && marketTrend === "BEARISH") {
    score -= 8;  reasons.push("Counter-trend (bearish market) — reduced score");
  } else if (direction === "PUT" && marketTrend === "BULLISH") {
    score -= 8;  reasons.push("Counter-trend (bullish market) — reduced score");
  }

  if (score < 15) return null; // discard if trend kills the signal

  // ── MACD confirmation ──────────────────────────────────────────────────
  const macd = calcMACD(closes);
  if (macd) {
    if (direction === "CALL" && macd.histogram > 0 && macd.crossUp) {
      score += 12; reasons.push("MACD bullish crossover confirmed");
    } else if (direction === "PUT" && macd.histogram < 0 && macd.crossDown) {
      score += 12; reasons.push("MACD bearish crossover confirmed");
    } else if (direction === "CALL" && macd.histogram > 0) {
      score += 5;  reasons.push("MACD positive");
    } else if (direction === "PUT" && macd.histogram < 0) {
      score += 5;  reasons.push("MACD negative");
    } else {
      score -= 5;  reasons.push("MACD diverging from signal");
    }
  }

  // ── #4: STOCHASTIC RSI CONFIRMATION (avoid false RSI extremes) ──────────
  const stochRSI = calcStochRSI(closes);
  if (stochRSI !== null) {
    if (direction === "CALL" && rsi < 30 && stochRSI < 20) {
      score += 8; reasons.push(`Stochastic RSI ${stochRSI.toFixed(0)} confirms oversold (strong buy)`);
    } else if (direction === "PUT" && rsi > 70 && stochRSI > 80) {
      score += 8; reasons.push(`Stochastic RSI ${stochRSI.toFixed(0)} confirms overbought (strong sell)`);
    }
  }

  // ── #2: BOLLINGER SQUEEZE + BREAKOUT (high probability moves) ──────────
  const bbMetrics = calcBollingerMetrics(closes);
  if (bbMetrics && bbMetrics.isSqueezed) {
    score += 12; reasons.push(`Bollinger Squeeze detected (bandwidth: ${(bbMetrics.bandwidth * 100).toFixed(1)}%)`);

    if (direction === "CALL" && bbMetrics.isNearLower) {
      score += 4; reasons.push("Breaking out ABOVE lower BB band");
    } else if (direction === "PUT" && bbMetrics.isNearUpper) {
      score += 4; reasons.push("Breaking out BELOW upper BB band");
    }
  }

  // ── #3: SUPPORT/RESISTANCE CONFLUENCE (better entry levels) ────────────
  const levels = calcSupportResistance(bars);
  if (levels) {
    if (direction === "CALL" && levels.nearSupport) {
      score += 8; reasons.push(`Price near support level ($${levels.support.toFixed(2)}) — strong reversal`);
    } else if (direction === "PUT" && levels.nearResistance) {
      score += 8; reasons.push(`Price near resistance level ($${levels.resistance.toFixed(2)}) — strong reversal`);
    }
  }

  // ── Sector ETF alignment (#6) ──────────────────────────────────────────
  const sector = SYMBOL_SECTOR_MAP[symbol];
  if (sector) {
    if (direction === "CALL" && sector._trend === "BULLISH") {
      score += 8; reasons.push(`Sector ${sector.etf} aligned (bullish)`);
    } else if (direction === "PUT" && sector._trend === "BEARISH") {
      score += 8; reasons.push(`Sector ${sector.etf} aligned (bearish)`);
    } else if (direction === "CALL" && sector._trend === "BEARISH") {
      score -= 6; reasons.push(`Sector ${sector.etf} against (bearish)`);
    } else if (direction === "PUT" && sector._trend === "BULLISH") {
      score -= 6; reasons.push(`Sector ${sector.etf} against (bullish)`);
    }
  }

  // ── Volume confirmation bonus ─────────────────────────────────────────────
  const avgVol = volumes.slice(-10).reduce((a, b) => a + b) / 10;
  const lastVol = volumes[volumes.length - 1];
  if (lastVol > avgVol * 1.5) {
    score += 10; reasons.push(`Volume spike ${(lastVol / avgVol).toFixed(1)}× avg`);
  } else if (lastVol > avgVol * 1.2) {
    score += 5;  reasons.push(`Above-avg volume ${(lastVol / avgVol).toFixed(1)}×`);
  }

  // ── Volatility bonus (options need movement) ──────────────────────────────
  if (vol > 0.015) { score += 8; reasons.push(`Daily vol ${(vol * 100).toFixed(1)}%`); }
  if (vol > 0.025) { score += 7; reasons.push("High vol — options favored"); }

  // ── ATR (absolute move available) ────────────────────────────────────────
  const atrPct = atr / last * 100;
  if (atrPct > 1.5) { score += 5; reasons.push(`ATR ${atrPct.toFixed(1)}% (strong range)`); }

  return { symbol, score, direction, rsi, bb, atr, vol, last, reasons };
}

// ── OPTION PRICING ─────────────────────────────────────────────────────────

// Cumulative normal distribution (Abramowitz-Stegun approximation)
function cnd(x) {
  const t   = 1 / (1 + 0.2316419 * Math.abs(x));
  const d   = 0.3989423 * Math.exp((-x * x) / 2) * t;
  const p   = 1 - d * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}

function blackScholes(S, K, T, sigma, type) {
  const r  = 0.05;
  T        = Math.max(T, 0.003);   // floor at ~1 day
  sigma    = Math.max(sigma, 0.05);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === "CALL"
    ? Math.max(S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2), 0)
    : Math.max(K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1), 0);
}

function roundToStrike(price) {
  if (price < 25)  return Math.round(price / 0.5) * 0.5;
  if (price < 200) return Math.round(price);
  return Math.round(price / 5) * 5;
}

/**
 * Calculate an affordable option position within MAX_BUDGET.
 * Tries ATM first, then goes OTM until budget fits.
 * Returns null if no option is affordable.
 */
function calcOptionPosition(spot, direction, dailyVol, expiryDate, budget = MIN_BUDGET) {
  // Annualized IV from daily vol (× sqrt(252))
  const sigma     = Math.max(dailyVol, 0.005) * Math.sqrt(252);
  const T         = daysUntil(expiryDate) / 365;

  // Strike offsets: ATM → progressively OTM (up to ~8% for high-priced stocks like AAPL $200+)
  const offsets = direction === "CALL"
    ? [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08]
    : [0, -0.01, -0.02, -0.03, -0.04, -0.05, -0.06, -0.07, -0.08];

  for (const offset of offsets) {
    const strike         = roundToStrike(spot * (1 + offset));
    const premium        = blackScholes(spot, strike, T, sigma, direction);
    const costPerContract = premium * 100; // 1 contract = 100 shares

    if (costPerContract < 5)        continue; // too cheap → illiquid/junk (minimum $5 per contract)
    if (costPerContract > budget)   continue; // exceeds trade budget

    // #2: Greeks filter — prefer delta 0.4–0.8 (ATM-ish, high probability, less theta bleed)
    const delta = Math.abs(calcDelta(spot, strike, T, sigma, direction));
    if (delta < 0.4 || delta > 0.8) continue;

    const contracts = Math.floor(budget / costPerContract);
    if (contracts < 1) continue;

    const totalCost = Math.round(contracts * costPerContract * 100) / 100;
    const sl        = Math.round(premium * SL_MULT * 100) / 100;

    return {
      strike,
      expiryDate,
      premium:   Math.round(premium * 100) / 100,
      contracts,
      totalCost,
      sl,        // −20% initial stop loss; trails up dynamically
    };
  }

  return null; // no affordable strike found
}

/**
 * Like calcOptionPosition but uses real bid/ask from Webull option chain.
 * Picks the ask price, finds the most contracts within budget, filters by OI > 0.
 *
 * Smart strike selection: If ATM is too expensive, finds next-closest strike within budget.
 * This preserves probability of profit while fitting within buying power.
 *
 * #2: Adaptive SL — uses ATR for stop loss instead of fixed -20%
 */
function calcOptionPositionFromChain(chain, direction, expiryDate, budget = MIN_BUDGET, spotPrice = null, atr = null) {
  if (!chain || chain.length === 0) return null;

  // Filter base criteria (type, OI, price)
  const baseFiltered = chain.filter(c =>
    c.optionType === direction && c.openInterest > 0 && c.ask > 0
  );

  if (baseFiltered.length === 0) return null;

  // Strategy: Try progressively wider delta ranges until we find something affordable
  // This ensures we get closest-to-ATM that fits budget
  const deltaRanges = [
    { min: 0.4, max: 0.8, label: "ATM (strict)" },
    { min: 0.35, max: 0.85, label: "ATM (loose)" },
    { min: 0.3, max: 0.9, label: "Near-ATM" },
    { min: 0.2, max: 0.95, label: "Wide range" },
    { min: 0, max: 1.0, label: "Any delta" },
  ];

  for (const range of deltaRanges) {
    const filtered = baseFiltered
      .filter(c => {
        // Estimate delta if spot is available
        if (spotPrice && expiryDate) {
          const T = daysUntil(expiryDate) / 365;
          const sigma = 0.25;
          const delta = Math.abs(calcDelta(spotPrice, c.strikePrice, T, sigma, direction));
          return delta >= range.min && delta <= range.max;
        }
        // If no spot price, accept all
        return true;
      })
      .sort((a, b) => a.ask - b.ask); // cheapest first (closest to ATM in this range)

    for (const c of filtered) {
      const premium = c.ask;
      const costPerContract = premium * 100;
      if (costPerContract < 5) continue;
      if (costPerContract > budget) continue;

      // #2: Liquidity check — skip if spread > 5%
      if (!hasGoodLiquidity(c.bid, c.ask)) {
        console.log(`[${etFull()}] Skipped ${c.strikePrice} strike — spread too wide (${((c.ask - c.bid) / ((c.ask + c.bid) / 2) * 100).toFixed(1)}%)`);
        continue;
      }

      const contracts = Math.floor(budget / costPerContract);
      if (contracts < 1) continue;

      const totalCost = Math.round(contracts * costPerContract * 100) / 100;

      // #2: Adaptive stop loss — use ATR if available, otherwise fixed -20%
      let sl = premium * SL_MULT;
      if (atr && spotPrice && spotPrice > 0) {
        const atrFactor = 1.5 * atr / spotPrice;
        sl = Math.max(premium * (1 - atrFactor), premium * 0.5); // floor at 50% of premium
      }

      if (range.label !== "ATM (strict)") {
        console.log(`[${etFull()}] Strike selection: expanded to ${range.label} to fit budget`);
      }
      return {
        strike:    c.strikePrice,
        expiryDate,
        premium:   Math.round(premium * 100) / 100,
        contracts,
        totalCost,
        sl:        Math.round(sl * 100) / 100,
      };
    }
  }

  // No affordable strike found
  return null;
}

// ── STRATEGY HELPERS ──────────────────────────────────────────────────────

// Market closure check — skip holidays when market is closed
function isMarketClosed() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD format

  // US stock market holidays (2026-2027)
  const closedDays = [
    "2026-01-01", // New Year's Day
    "2026-01-19", // MLK Jr. Day
    "2026-02-16", // Presidents' Day
    "2026-03-27", // Good Friday
    "2026-05-25", // Memorial Day
    "2026-06-19", // Juneteenth
    "2026-07-03", // Independence Day (observed)
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving
    "2026-12-25", // Christmas
    "2027-01-01", // New Year's Day
    "2027-01-18", // MLK Jr. Day
    "2027-02-15", // Presidents' Day
    "2027-04-16", // Good Friday
    "2027-05-31", // Memorial Day
    "2027-06-18", // Juneteenth
    "2027-07-05", // Independence Day (observed)
    "2027-09-06", // Labor Day
    "2027-11-25", // Thanksgiving
    "2027-12-24", // Christmas (observed, 24th is Friday)
  ];

  return closedDays.includes(todayStr);
}

// #1: Time-of-day filter — higher volatility/better odds in morning
function shouldTradeByTimeOfDay() {
  const { hour, min } = getEtParts();
  const hhmm = hour * 100 + min;

  // Morning: 9:45-11:30 (high volatility, faster moves) ✅ YES
  if (hhmm >= 945 && hhmm < 1130) return { ok: true, period: "morning", label: "🌅 Morning (high vol)" };

  // Midday: 11:30-1:30 (choppy, low vol) ❌ SKIP
  if (hhmm >= 1130 && hhmm < 1330) return { ok: false, period: "midday", label: "☕ Midday (choppy)" };

  // Afternoon: 1:30-3:20 (earnings/news, risky) ✅ YES but monitor closer
  if (hhmm >= 1330 && hhmm < 1520) return { ok: true, period: "afternoon", label: "🌤️ Afternoon" };

  return { ok: false, period: "outside", label: "⏰ Outside trading hours" };
}

// #2: Check if option chain has good liquidity
function hasGoodLiquidity(bid, ask) {
  if (bid <= 0 || ask <= 0) return false;
  const mid = (bid + ask) / 2;
  const spread = (ask - bid) / mid;
  return spread <= 0.05; // Allow up to 5% spread
}

// ── DISCORD HELPERS ────────────────────────────────────────────────────────

async function sendMsg(client, content) {
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    return await ch.send(content.slice(0, 2000));
  } catch (err) {
    console.error(`[${etFull()}] Discord send error: ${err.message}`);
    return null;
  }
}

// Send trade proposal with Approve / Skip buttons.
async function sendApproval(client, content) {
  try {
    const ch  = await client.channels.fetch(CHANNEL_ID);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("trade_approve").setLabel("✅  Place Order").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("trade_skip"  ).setLabel("❌  Skip"        ).setStyle(ButtonStyle.Danger),
    );
    return await ch.send({ content: content.slice(0, 2000), components: [row] });
  } catch (err) {
    console.error(`[${etFull()}] Discord approval send error: ${err.message}`);
    return null;
  }
}

// ── SCANNER ───────────────────────────────────────────────────────────────

let _scanning = false; // guard against concurrent scans from overlapping scheduler ticks

async function runScan(client, webull, force = false) {
  if (_scanning) {
    console.log(`[${etFull()}] Scan skipped — another scan already running`);
    return;
  }
  if (!isMarketHours() && !force) {
    console.log(`[${etFull()}] Scan skipped — outside market hours`);
    return;
  }
  if (isMarketClosed()) {
    console.log(`[${etFull()}] Scan skipped — US stock market closed (holiday)`);
    return;
  }

  const state = loadState();
  if (state.activeTrades.length > 0) {
    console.log(`[${etFull()}] Skipping scan — ${state.activeTrades.length} open position(s)`);
    return;
  }
  if (state.pendingApproval) {
    console.log(`[${etFull()}] Skipping scan — awaiting trade approval`);
    return;
  }

  _scanning = true;
  try {
  // ── Daily loss guard ──────────────────────────────────────────────────────
  if (isDailyLossExceeded()) {
    const pnl = getDailyPnL();
    console.log(`[${etFull()}] Daily loss limit hit ($${pnl.toFixed(2)}) — scanning halted`);
    return;
  }

  // ── Dynamic budget ────────────────────────────────────────────────────────
  const budget = await calcTradeBudget(webull);
  console.log(`[${etFull()}] Trade budget: $${budget}`);

  // ── 0DTE ETF WINDOW: Scan ALL symbols (including 0DTE) until 12:30 PM, then exclude 0DTE after ──
  const { hour, min } = getEtParts();
  const timeNow = hour * 100 + min;
  const is0DTEWindow = timeNow < 1230; // Include 0DTE until 12:30 PM
  const zeroDTESymbols = ["SPY", "QQQ", "IWM"];

  let scanList = [];
  if (is0DTEWindow) {
    // Before 12:30: Scan ALL symbols including 0DTE ETFs
    scanList = ELIGIBLE_SYMBOLS.filter(s => webull.isSymbolAllowed(s));
    console.log(`[${etFull()}] 0DTE Window (until 12:30 PM): Scanning ALL ${scanList.length} symbols (0DTE included)`);
  } else {
    // After 12:30: Scan only non-0DTE symbols (exclude SPY, QQQ, IWM)
    scanList = ELIGIBLE_SYMBOLS.filter(s => !zeroDTESymbols.includes(s) && webull.isSymbolAllowed(s));
    console.log(`[${etFull()}] After 0DTE window (12:30+ PM): Scanning ${scanList.length} symbols (0DTE excluded)`);
  }

  await sendMsg(client, `🔍 **SCANNING** ${scanList.length} symbols${is0DTEWindow ? " (0DTE included until 12:30)" : " (0DTE excluded)"} _(${etFull()})_`);

  // ── 1. Parallel pre-scan: market trend (SPY) + VIX + earnings ────────────
  let marketTrend = "NEUTRAL";
  let vixLevel    = null;
  let earningsSet = new Set();

  const [spyResult, vixResult, earningsResult] = await Promise.allSettled([
    webull.getBars("SPY", "1d", 25),
    getVixLevel(webull),
    getEarningsSymbols(3),
  ]);

  if (spyResult.status === "fulfilled") marketTrend = getMarketTrend(spyResult.value);
  if (vixResult.status  === "fulfilled") vixLevel   = vixResult.value;
  if (earningsResult.status === "fulfilled") earningsSet = earningsResult.value;

  const vixInfo    = classifyVix(vixLevel);
  const trendEmoji = marketTrend === "BULLISH" ? "📈" : marketTrend === "BEARISH" ? "📉" : "➡️";
  console.log(`[${etFull()}] Market: ${marketTrend} | VIX: ${vixLevel ?? "N/A"} ${vixInfo.label} | Earnings skip: ${earningsSet.size}`);

  // ── VIX regime gate — skip trading when VIX > 28 (panic market) ──────────
  if (vixInfo.skip) {
    await sendMsg(client,
      `⛔ **SCAN SKIPPED** — VIX ${vixInfo.label} ${vixInfo.emoji}\n` +
      `High volatility regime detected. Skipping new trades to protect capital.\n` +
      `_(Resumes when VIX drops below 28)_`
    );
    return;
  }

  // ── 2a. Fetch sector ETF trends in parallel (#6) ─────────────────────────
  const sectorETFs = [...new Set(Object.keys(SECTOR_ETF_MAP))];
  const sectorResults = await Promise.allSettled(
    sectorETFs.map(etf => webull.getBars(etf, "1d", 25))
  );
  sectorETFs.forEach((etf, i) => {
    if (sectorResults[i].status === "fulfilled") {
      const trend = getMarketTrend(sectorResults[i].value);
      for (const sym of SECTOR_ETF_MAP[etf]) {
        if (SYMBOL_SECTOR_MAP[sym]) SYMBOL_SECTOR_MAP[sym]._trend = trend;
      }
    }
  });

  // ── 2b. Scan symbols in parallel batches of 10 ──────────────────────────
  const setups         = [];
  const allScores      = []; // Track ALL scores for reporting (passed + failed)
  let   earningsSkipped = 0;
  let   ivSkipped       = 0; // #4: IV filter
  const BATCH_SIZE     = 25; // Increased for 300-symbol coverage (parallel execution handles it)
  const MIN_SCORE      = 80; // #1: EXCELLENT quality only (80+ = multiple confirmations strongly aligned)

  for (let i = 0; i < scanList.length; i += BATCH_SIZE) {
    const batch = scanList.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        if (earningsSet.has(symbol)) return { _earningsSkip: true };
        const bars = await webull.getBars(symbol, "1d", 35);
        if (!bars || bars.length < 22) return null;
        // #4: IV rank filter — only trade extremes
        if (!isValidIVRank(bars)) return { _ivSkip: true };
        // #8: Pass state for trade frequency limiting
        return scoreSetup(symbol, bars, marketTrend, state);
      })
    );
    let resultCount = 0;
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      if (!r.value) continue;

      resultCount++;

      // Handle special filter markers
      if (r.value._earningsSkip) { earningsSkipped++; continue; }
      if (r.value._ivSkip) { ivSkipped++; continue; }

      // Collect ALL scored symbols (both passed 80+ and failed <80)
      if (typeof r.value.score === "number") {
        allScores.push(r.value);
        // Only execute trades with score >= 80
        if (r.value.score >= MIN_SCORE) {
          setups.push(r.value);
        }
      }
    }
    console.log(`[${etFull()}] Batch results: ${resultCount} returned, ${earningsSkipped} earnings-skipped, ${ivSkipped} iv-skipped, ${allScores.length} scored`);
  }

  const earningsNote = earningsSkipped > 0 ? `⚠️ ${earningsSkipped} symbols skipped (earnings risk) · ` : "";
  const ivNote = ivSkipped > 0 ? `${ivSkipped} symbols skipped (IV rank mid-range)` : "";

  console.log(`[${etFull()}] Score collection: ${allScores.length} symbols scored, ${setups.length} passed 80+ threshold`);

  // ── LOG ALL SCORES: Passed (80+) and Failed (< 80) ──────────────────────
  const passed = allScores.filter(s => s.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
  const failed = allScores.filter(s => s.score < MIN_SCORE).sort((a, b) => b.score - a.score);
  const maxScore = allScores.length > 0 ? Math.max(...allScores.map(s => s.score)) : 0;

  let scoreReport = `📊 **SCAN RESULTS** _(${etFull()})_\n`;
  scoreReport += `📈 **Max Score: ${maxScore}/100** · Scanned: ${allScores.length} symbols\n\n`;
  scoreReport += `✅ **PASSED (${passed.length}) — Score 80+:**\n`;
  if (passed.length > 0) {
    scoreReport += passed.slice(0, 10).map(s => `• ${s.symbol} ${s.direction}: **${s.score}/100**`).join("\n");
    if (passed.length > 10) scoreReport += `\n_(+${passed.length - 10} more)_`;
  } else {
    scoreReport += "_(none)_";
  }
  scoreReport += `\n\n❌ **FAILED (${failed.length}) — Score < 80:**\n`;
  if (failed.length > 0) {
    scoreReport += failed.slice(0, 10).map(s => `• ${s.symbol} ${s.direction}: ${s.score}/100`).join("\n");
    if (failed.length > 10) scoreReport += `\n_(+${failed.length - 10} more)_`;
  } else {
    scoreReport += "_(none)_";
  }
  scoreReport += `\n\n${earningsNote}${ivNote}\nVIX: ${vixInfo.emoji} ${vixInfo.label}`;

  if (setups.length === 0) {
    await sendMsg(client, scoreReport);
    return;
  }

  // ── 3. Pick best setup + 5m confirmation (#3) ───────────────────────────
  setups.sort((a, b) => b.score - a.score);

  // Multi-timeframe confirmation: check 5m bars for intraday trend alignment
  let best = null;
  for (const setup of setups) {
    try {
      // #1: Time-of-day filter (skip midday chop)
      const timeFilter = shouldTradeByTimeOfDay();
      if (!timeFilter.ok && timeFilter.period === "midday") {
        console.log(`[${etFull()}] ${setup.symbol} skipped — ${timeFilter.label} (avoid chop)`);
        continue;
      }

      const bars5m = await webull.getBars(setup.symbol, "5m", 20);
      if (bars5m && bars5m.length >= 11) {
        const closes5m = bars5m.map(b => b.close);
        const rsi5m    = calcRSI(closes5m, 10);

        // #1: Mean reversion filter — require RSI extremes for reversal trades
        const isMeanReversionSetup =
          (setup.direction === "CALL" && rsi5m < 30) ||  // Oversold for CALL
          (setup.direction === "PUT" && rsi5m > 70);      // Overbought for PUT

        if (isMeanReversionSetup) {
          setup.reasons.push(`5m RSI ${rsi5m.toFixed(0)} extreme — mean reversion confirmed`);
          setup.score += 8;  // Bonus for mean reversion
          best = setup;
          break;
        } else {
          console.log(`[${etFull()}] ${setup.symbol} skipped — 5m RSI ${rsi5m.toFixed(0)} not extreme enough (need <30 for CALL or >70 for PUT)`);
        }
      } else {
        best = setup; // can't confirm, take the daily signal
        break;
      }
    } catch {
      best = setup; // 5m fetch failed, take daily signal
      break;
    }
  }

  if (!best) {
    await sendMsg(client,
      `🔍 **SCAN COMPLETE** — ${setups.length} setup(s) rejected by 5m confirmation _(${etFull()})_\n` +
      (earningsNote || ivNote ? `${earningsNote}${ivNote}\n` : "") +
      `VIX: ${vixInfo.emoji} ${vixInfo.label}`
    );
    return;
  }

  // ── 3b. Determine expiry: 0DTE for SPY/QQQ with small budgets (#5) ─────
  const is0DTECandidate = ["SPY", "QQQ", "IWM"].includes(best.symbol) && budget < CONFIG.ZERO_DTE_BUDGET_THRESHOLD;
  let expiry;
  if (is0DTECandidate) {
    // 0DTE: today's date
    expiry = etDateStr();
    best.reasons.push("0DTE — small account, intraday play");
  } else {
    expiry = optimalExpiry();
  }

  // Attempt to get real bid/ask from Webull option chain; fall back to Black-Scholes
  let chainData = null;
  let priceSource = "Black-Scholes est.";
  try {
    chainData   = await webull.getOptionChain(best.symbol, expiry);
    priceSource = "live bid/ask";
  } catch (e) {
    console.warn(`[${etFull()}] Option chain unavailable for ${best.symbol} (geo-blocked API): ${e.message} — using Black-Scholes estimate`);
  }

  // ── #1/#5/#6: Multi-factor position sizing ────────────────────────────────
  const state = loadState();
  const symbolMultiplier = getSymbolWinRateMultiplier(best.symbol, best.direction, state);
  const vixAdjustment = vixLevel ? getVixPositionAdjustment(vixLevel) : 1.0;
  const timeAdjustment = getTimeOfDayPositionAdjustment(); // #6

  const scaledBudget = Math.round(budget * symbolMultiplier * vixAdjustment * timeAdjustment);
  if (symbolMultiplier !== 1.0 || vixAdjustment !== 1.0 || timeAdjustment !== 1.0) {
    const adjustLog = [];
    if (symbolMultiplier !== 1.0) adjustLog.push(`WR ${symbolMultiplier.toFixed(2)}x`);
    if (vixAdjustment !== 1.0) adjustLog.push(`VIX ${vixAdjustment.toFixed(2)}x`);
    if (timeAdjustment !== 1.0) adjustLog.push(`Time ${timeAdjustment.toFixed(2)}x`);
    console.log(`[${etFull()}] ${best.symbol} ${best.direction}: ${adjustLog.join(" + ")} → $${scaledBudget} (from $${budget})`);
  }

  const position = chainData && chainData.length > 0
    ? calcOptionPositionFromChain(chainData, best.direction, expiry, scaledBudget, best.last, best.atr) // #5: use scaled budget
    : calcOptionPosition(best.last, best.direction, best.vol, expiry, scaledBudget);

  if (!position) {
    await sendMsg(client,
      `🔍 **SCAN COMPLETE** — Best: **${best.symbol} ${best.direction}** (score ${best.score})\n` +
      `⚠️ No affordable option within $${budget} budget at $${best.last.toFixed(2)}\n` +
      earningsNote
    );
    return;
  }

  // ── 4. Send trade proposal with Discord buttons ───────────────────────────
  const dirEmoji  = best.direction === "CALL" ? "📈" : "📉";
  const runners   = setups.slice(1, 4).map(s => `${s.symbol} ${s.direction} (${s.score})`).join(", ");
  const budgetSrc = budget === FALLBACK_BUDGET ? `fallback (balance API unavailable)` : budget < 300 ? `95% of $${Math.round(budget / 0.95)} balance` : `50% of balance`;
  const isDTE0 = position.expiryDate === etDateStr() ? " 🏃 **0DTE** (expires TODAY)" : "";

  const proposalText =
    `${dirEmoji} **AUTO-PLACED ORDER** — ${etFull()}\n` +
    `Market: ${trendEmoji} ${marketTrend} · VIX: ${vixInfo.emoji} ${vixInfo.label} · ${setups.length} setup(s)\n` +
    (earningsNote ? earningsNote : "") +
    `\n**${best.symbol} ${best.direction}** · Score: ${best.score}/100\n\n` +
    `📊 **Signals:**\n${best.reasons.map(r => `• ${r}`).join("\n")}\n\n` +
    `📋 **Option Contract** _(${priceSource})_${isDTE0}:\n` +
    `• Strike:    $${position.strike.toFixed(2)}\n` +
    `• Expiry:    ${position.expiryDate}\n` +
    `• Premium:   $${position.premium.toFixed(2)}/contract (×100 shares)\n` +
    `• Contracts: ${position.contracts}\n` +
    `• **Total Cost: $${position.totalCost.toFixed(2)}** (budget: $${budget} — ${budgetSrc})\n` +
    (priceSource === "Black-Scholes est." ? `⚠️ _**Premium is estimated** — check Webull for actual bid/ask_\n` : "") +
    `\n🎯 **Exit Strategy (dynamic):**\n` +
    `• Initial SL: $${position.sl.toFixed(2)}\n` +
    `• Profit floor: activates at +15%, trails 12% below peak\n` +
    `• Momentum exit: closes if 5m RSI/price turns against position\n` +
    `• Profit take: closes at +50% if momentum is fading\n\n` +
    (runners ? `📌 Runners-up: ${runners}\n\n` : "") +
    `✅ **Order placed automatically** — Monitoring in progress`;

  // AUTOMATICALLY PLACE THE ORDER (no user approval needed)
  await placeTradeOrder(client, webull, {
    symbol:    best.symbol,
    direction: best.direction,
    setup:     { score: best.score, rsi: best.rsi, vol: best.vol, last: best.last, reasons: best.reasons },
    position,
    budget,
  });

  // Send notification to Discord
  await sendMsg(client, proposalText);

  } finally {
    _scanning = false;
  }
}

// ── ORDER MANAGEMENT ───────────────────────────────────────────────────────

async function placeTradeOrder(client, webull, approval) {
  const { symbol, direction, position } = approval;
  const PAPER_TRADE = process.env.PAPER_TRADE === "true";

  // ── TRANSACTION LOCK: Prevent concurrent order placements (#1, #2) ────────
  if (isPlacingOrder) {
    console.warn(`[${etFull()}] Order placement already in progress, rejecting duplicate request for ${symbol}`);
    return;
  }

  isPlacingOrder = true;
  const lockTimer = setTimeout(() => {
    isPlacingOrder = false;
    console.error(`[${etFull()}] CRITICAL: Order placement lock timeout after ${LOCK_TIMEOUT}ms`);
  }, LOCK_TIMEOUT);

  // Guard: reject if a trade was already opened since approval was sent
  const currentState = loadState();
  if (currentState.activeTrades.length > 0) {
    isPlacingOrder = false;
    await sendMsg(client, `⚠️ **Order blocked** — ${currentState.activeTrades.length} trade(s) already active. Only 1 position at a time.`);
    return;
  }

  const modeLabel = PAPER_TRADE ? "📋 PAPER TRADE (SIMULATED)" : "💰 LIVE TRADE";
  console.log(`[${etFull()}] ${modeLabel}: Placing ${direction} order: ${symbol} $${position.strike} exp ${position.expiryDate}`);

  try {
    let order = null;

    // ── LIVE TRADE: Place actual order on Webull ──────────────────────────────
    if (!PAPER_TRADE) {
      order = await webull.placeOptionOrder({
        symbol,
        quantity:   position.contracts,
        side:       "BUY",
        optionType: direction,
        strike:     position.strike,
        expiryDate: position.expiryDate,
        limitPrice: position.premium,
        timeInForce: "DAY",
      });
    } else {
      // ── PAPER TRADE: Simulate order (no real execution) ──────────────────────
      console.log(`[${etFull()}] PAPER TRADE: Simulating order execution (no real money)`);
      order = { orderId: `PAPER_${Date.now()}` };
    }

    const trade = {
      id:             `trade_${Date.now()}`,
      symbol,
      direction,
      position,
      orderId:        order?.orderId || `local_${Date.now()}`,
      entryPremium:   position.premium,
      currentPremium: position.premium,
      peakPremium:    position.premium,
      profitFloor:    null,       // activates when up 15%, trails below peak
      entryTime:      new Date().toISOString(),
      status:         "ACTIVE",
      activeSL:       position.sl,
      isPaperTrade:   PAPER_TRADE,
    };

    const state          = loadState();
    state.pendingApproval = null;
    state.activeTrades.push(trade);
    saveState(state);

    const dirEmoji = direction === "CALL" ? "📈" : "📉";
    const paperLabel = PAPER_TRADE ? "📋 **[PAPER TRADE]** " : "✅ ";
    await sendMsg(client,
      `${paperLabel}**ORDER PLACED** ${dirEmoji}\n\n` +
      `**${symbol} ${direction}** @ $${position.premium.toFixed(2)}/contract\n` +
      `• Contracts: ${position.contracts} · Cost: $${position.totalCost.toFixed(2)}\n` +
      `• Strike: $${position.strike.toFixed(2)} · Expiry: ${position.expiryDate}\n` +
      `• Order ID: \`${trade.orderId}\`\n` +
      (PAPER_TRADE ? `• Mode: **PAPER TRADE (Simulated, no real money)**\n` : "") +
      `\n🎯 **Exit Strategy (dynamic):**\n` +
      `• Initial SL: $${position.sl.toFixed(2)} (−20%)\n` +
      `• Profit floor: activates at +15%, trails 12% below peak\n` +
      `• Momentum exit: closes if intraday trend turns against position\n\n` +
      `_Monitoring every 2 min · ${etFull()}_`
    );

    console.log(`[${etFull()}] ${modeLabel} placed for ${symbol} ${direction} — ID: ${trade.orderId}`);
  } catch (err) {
    console.error(`[${etFull()}] Order failed: ${err.message}`);
    const state          = loadState();
    state.pendingApproval = null;
    saveState(state);
    await sendMsg(client, `❌ **ORDER FAILED** — ${err.message}\n\nTrade cancelled. Will scan next cycle.`);
  } finally {
    // Release transaction lock
    clearTimeout(lockTimer);
    isPlacingOrder = false;
  }
}

async function closePosition(client, trade, reason, webull) {
  console.log(`[${etFull()}] Closing ${trade.symbol} — ${reason}`);

  try {
    await webull.closeOptionOrder(trade);
  } catch (err) {
    console.error(`[${etFull()}] Webull close error for ${trade.symbol}: ${err.message}`);
  }

  // Remaining-contracts P&L (final leg)
  const finalContracts = trade.position.contracts;
  const finalPnL       = Math.round((trade.currentPremium - trade.entryPremium) * 100 * finalContracts * 100) / 100;
  const partialPnL     = trade.realizedPnL || 0;           // locked at TP1 partial close
  const totalPnL       = Math.round((finalPnL + partialPnL) * 100) / 100;
  const pct            = Math.round((trade.currentPremium - trade.entryPremium) / trade.entryPremium * 100 * 10) / 10;
  const isWin          = totalPnL > 0;

  // Update state
  const state         = loadState();
  state.activeTrades  = state.activeTrades.filter(t => t.id !== trade.id);
  state.closedTrades.push({ ...trade, closedAt: new Date().toISOString(), reason, totalPnL, pct, exitPremium: trade.currentPremium });

  // ── #1/#5: Record win/loss by symbol + direction ───────────────────────
  recordTradeResult(trade.symbol, trade.direction, isWin, state);

  saveState(state);

  // Performance log
  const perf = loadPerf();
  perf.allTrades.push({
    symbol:       trade.symbol,
    direction:    trade.direction,
    entryPremium: trade.entryPremium,
    exitPremium:  trade.currentPremium,
    contracts:    trade.position.contracts + (trade.partialCloseContracts || 0),
    totalPnL,
    pct,
    reason,
    date:         etDateStr(),
    entryTime:    trade.entryTime,
    exitTime:     new Date().toISOString(),
  });
  savePerf(perf);

  const emoji = isWin ? "✅" : "❌";
  await sendMsg(client,
    `${emoji} **POSITION CLOSED** — ${trade.symbol} ${trade.direction}\n\n` +
    `• Entry: $${trade.entryPremium.toFixed(2)} → Exit: $${trade.currentPremium.toFixed(2)}\n` +
    (trade.peakPremium ? `• Peak premium: $${trade.peakPremium.toFixed(2)}\n` : "") +
    `• **Total P&L: $${totalPnL.toFixed(2)}** (${pct >= 0 ? "+" : ""}${pct}%)\n` +
    `• Contracts: ${finalContracts}\n` +
    `• Reason: ${reason}\n` +
    `• Time: ${etFull()}`
  );

  // Check daily loss limit after close
  if (isDailyLossExceeded()) {
    const dayPnL    = getDailyPnL();
    const lossLimit = getDailyLossLimit();
    await sendMsg(client,
      `🛑 **DAILY LOSS LIMIT REACHED** — $${Math.abs(dayPnL).toFixed(2)} lost (limit: 25% = $${lossLimit.toFixed(2)})\n` +
      `Scanning halted for the rest of the trading day. Resumes tomorrow.`
    );
    console.log(`[${etFull()}] Daily loss limit exceeded ($${dayPnL.toFixed(2)}) — scanning paused`);
  }
}

// ── POSITION MONITOR (every 2 min) ────────────────────────────────────────

async function monitor2Min(client, webull) {
  if (!isMarketHours()) return;

  const state = loadState();
  if (state.activeTrades.length === 0) return;

  console.log(`[${etFull()}] 2-min check — ${state.activeTrades.length} active trade(s)`);

  for (const trade of [...state.activeTrades]) {
    try {
      // Fetch intraday 5m bars (momentum) + daily bars (IV/vol) + snapshot in parallel
      const [snap5mResult, barsResult, snapResult] = await Promise.allSettled([
        webull.getBars(trade.symbol, "5m", 20),
        webull.getBars(trade.symbol, "1d", 30),
        webull.getSnapshot(trade.symbol),
      ]);

      const bars5m = snap5mResult.status === "fulfilled" ? snap5mResult.value : null;
      const bars   = barsResult.status   === "fulfilled" ? barsResult.value   : null;
      const snap   = snapResult.status   === "fulfilled" ? snapResult.value    : null;

      if (!bars || bars.length === 0) continue;

      // Best available spot price: intraday snapshot → last 5m bar → last daily bar
      const spot = (snap?.last > 0)
        ? snap.last
        : (bars5m?.length > 0 ? bars5m[bars5m.length - 1].close : bars[bars.length - 1].close);

      const vol        = Math.max(calcVolatility(bars.map(b => b.close).slice(-10)), 0.005);
      const sigma      = vol * Math.sqrt(252);
      const T          = daysUntil(trade.position.expiryDate) / 365;
      const curPremium = Math.round(blackScholes(spot, trade.position.strike, T, sigma, trade.direction) * 100) / 100;
      const pct        = Math.round((curPremium - trade.entryPremium) / trade.entryPremium * 100 * 10) / 10;

      // ── Intraday momentum check ───────────────────────────────────────────
      const momentum = intradayMomentum(bars5m, trade.direction);

      // ── Update peak premium + profit floor (trailing) ─────────────────────
      if (curPremium > (trade.peakPremium || 0)) trade.peakPremium = curPremium;

      // ── #3: AGGRESSIVE PROFIT LOCKING ──────────────────────────────────────
      // Lock in profits faster: at +5%, +10%, then use regular profit floor
      const profitPct = (curPremium - trade.entryPremium) / trade.entryPremium;

      if (profitPct >= 0.10 && !trade.hasHardLock) {
        // At +10% profit: trail at +5%
        const hardLock = Math.round(trade.entryPremium * 1.05 * 100) / 100;
        if (hardLock > trade.activeSL) {
          trade.activeSL = hardLock;
          trade.hasHardLock = true;
          console.log(`[${etFull()}] Profit lock: At +10%, locked in +5% ($${hardLock.toFixed(2)})`);
        }
      } else if (profitPct >= 0.05 && !trade.breakEvenLock) {
        // At +5% profit: move SL to breakeven
        const beEven = trade.entryPremium;
        if (beEven > trade.activeSL) {
          trade.activeSL = beEven;
          trade.breakEvenLock = true;
          console.log(`[${etFull()}] Profit lock: At +5%, locked breakeven ($${beEven.toFixed(2)})`);
        }
      }

      // Regular profit floor (after aggressive locking)
      if (curPremium >= trade.entryPremium * PROFIT_TRAIL_TRIGGER) {
        const floor = Math.round(trade.peakPremium * PROFIT_TRAIL_PCT * 100) / 100;
        if (!trade.profitFloor || floor > trade.profitFloor) {
          trade.profitFloor = floor;
          if (floor > trade.activeSL) {
            trade.activeSL = floor;
            console.log(`[${etFull()}] Profit floor raised → $${floor.toFixed(2)} (peak $${trade.peakPremium.toFixed(2)})`);
          }
        }
      }

      // Persist updated trade state
      trade.currentPremium = curPremium;
      const s   = loadState();
      const idx = s.activeTrades.findIndex(t => t.id === trade.id);
      if (idx >= 0) s.activeTrades[idx] = trade;
      saveState(s);

      const floorLabel = trade.profitFloor
        ? ` | Floor: $${trade.profitFloor.toFixed(2)}`
        : "";
      const logEmoji = pct >= 0 ? "🟢" : "🔴";
      console.log(`[${etFull()}] ${logEmoji} ${trade.symbol} ${trade.direction}: $${curPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%) | SL: $${trade.activeSL.toFixed(2)}${floorLabel} | Mom: ${momentum}`);

      // ── EXIT DECISIONS (priority order) ───────────────────────────────────

      // 1. Hard SL hit
      if (curPremium <= trade.activeSL) {
        const slType = trade.profitFloor ? "Profit floor" : "Stop loss";
        await closePosition(client, trade,
          `${slType} hit — $${curPremium.toFixed(2)} ≤ $${trade.activeSL.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)`, webull);
        continue;
      }

      // 2. Time-based EOD exit (#1) — lock wins by 3:20 PM (before 3:30 auto-close)
      const { hour: hh, min: mm } = getEtParts();
      if ((hh * 100 + mm) >= 1520 && pct > 0) {
        await closePosition(client, trade,
          `EOD lock — Market closing in 10 min, securing +${pct}% · $${curPremium.toFixed(2)}`, webull);
        continue;
      }

      // 3. Momentum turned AGAINST position — exit to protect capital
      if (momentum === "AGAINST") {
        const againstMsg = trade.direction === "CALL"
          ? "RSI/price turning bearish on 5m chart"
          : "RSI/price turning bullish on 5m chart";
        await closePosition(client, trade,
          `Momentum exit — ${againstMsg} · $${curPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)`, webull);
        continue;
      }

      // 4. Option expired
      if (T <= 0) {
        await closePosition(client, trade, "Option expired", webull);
        continue;
      }

      // 5. Theta decay exit: DTE ≤ 2 past 3:15 PM
      const dte = T * 365;
      if (dte <= 2 && (hh * 100 + mm) >= 1515) {
        await closePosition(client, trade,
          `Theta exit — ${dte.toFixed(1)} DTE, cutting before overnight decay · $${curPremium.toFixed(2)}`, webull);
        continue;
      }

      // 6. Strong profit + momentum neutral/fading → take profit
      if (pct >= 50 && momentum !== "WITH") {
        await closePosition(client, trade,
          `Profit secured — +${pct}% with fading momentum · $${curPremium.toFixed(2)}`, webull);
        continue;
      }

    } catch (err) {
      console.error(`[${etFull()}] Monitor error for ${trade.symbol}: ${err.message}`);
    }
  }
}

// ── POSITION STATUS UPDATE (every 15 min, Discord) ────────────────────────

async function post15MinUpdate(client) {
  const state = loadState();
  if (state.activeTrades.length === 0) return;

  const lines = state.activeTrades.map(t => {
    const pct       = Math.round((t.currentPremium - t.entryPremium) / t.entryPremium * 100 * 10) / 10;
    const emoji     = pct >= 0 ? "🟢" : "🔴";
    const floorLine = t.profitFloor ? ` · Floor: $${t.profitFloor.toFixed(2)}` : "";
    return (
      `${emoji} **${t.symbol} ${t.direction}** · $${t.currentPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)\n` +
      `   SL: $${t.activeSL.toFixed(2)}${floorLine} · Peak: $${(t.peakPremium || t.currentPremium).toFixed(2)}\n` +
      `   Strike $${t.position.strike.toFixed(2)} · Exp ${t.position.expiryDate} · ${t.position.contracts} contract(s)`
    );
  });

  await sendMsg(client,
    `📊 **15-MIN UPDATE** — ${etFull()}\n\n${lines.join("\n\n")}`
  );
}

// ── PERFORMANCE REPORTING ─────────────────────────────────────────────────

function calcStats(trades) {
  if (!trades || trades.length === 0) return null;
  const wins        = trades.filter(t => t.totalPnL > 0);
  const losses      = trades.filter(t => t.totalPnL <= 0);
  const total       = Math.round(trades.reduce((a, t) => a + t.totalPnL, 0) * 100) / 100;
  const avgWin      = wins.length   ? Math.round(wins.reduce((a, t)   => a + t.totalPnL, 0) / wins.length   * 100) / 100 : 0;
  const avgLoss     = losses.length ? Math.round(losses.reduce((a, t) => a + t.totalPnL, 0) / losses.length * 100) / 100 : 0;
  const grossProfit = wins.reduce((a, t) => a + t.totalPnL, 0);
  const grossLoss   = Math.abs(losses.reduce((a, t) => a + t.totalPnL, 0));
  const profitFactor = grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : null;
  const rr           = avgLoss < 0  ? Math.round(avgWin / Math.abs(avgLoss) * 100) / 100 : null;
  const best  = trades.reduce((a, t) => t.totalPnL > a.totalPnL ? t : a, trades[0]);
  const worst = trades.reduce((a, t) => t.totalPnL < a.totalPnL ? t : a, trades[0]);

  // Per-symbol breakdown (top 3 by count)
  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { count: 0, pnl: 0 };
    bySym[t.symbol].count++;
    bySym[t.symbol].pnl += t.totalPnL;
  }
  const topSymbols = Object.entries(bySym)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([sym, d]) => `${sym} (${d.count}x, $${Math.round(d.pnl * 100) / 100 >= 0 ? "+" : ""}${Math.round(d.pnl * 100) / 100})`);

  return { count: trades.length, wins: wins.length, losses: losses.length, total, avgWin, avgLoss, profitFactor, rr, best, worst, topSymbols };
}

function formatPerfReport(label, stats) {
  if (!stats) return `📊 **${label} Performance** — No completed trades yet`;
  const topEmoji  = stats.total >= 0 ? "✅" : "❌";
  const winRate   = Math.round(stats.wins / stats.count * 100);
  const rrStr     = stats.rr !== null ? `${stats.rr.toFixed(2)}:1` : "N/A";
  const pfStr     = stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : "N/A";
  return (
    `📊 **${label} Performance Report** — ${etFull()}\n\n` +
    `${topEmoji} **Net P&L: $${stats.total.toFixed(2)}**\n\n` +
    `• Trades:         ${stats.count} (${stats.wins}W / ${stats.losses}L) · Win Rate: ${winRate}%\n` +
    `• Avg Win:        +$${stats.avgWin.toFixed(2)} · Avg Loss: $${stats.avgLoss.toFixed(2)}\n` +
    `• Risk/Reward:    ${rrStr} · Profit Factor: ${pfStr}\n` +
    `• Best:           ${stats.best.symbol} ${stats.best.direction} +$${stats.best.totalPnL.toFixed(2)}\n` +
    `• Worst:          ${stats.worst.symbol} ${stats.worst.direction} $${stats.worst.totalPnL.toFixed(2)}\n` +
    (stats.topSymbols.length ? `• Top symbols:    ${stats.topSymbols.join(" · ")}` : "")
  );
}

async function postDailyReport(client) {
  const perf   = loadPerf();
  const today  = etDateStr();
  const trades = perf.allTrades.filter(t => t.date === today);
  await sendMsg(client, formatPerfReport("📅 DAILY", calcStats(trades)));
}

async function postWeeklyReport(client) {
  const perf  = loadPerf();
  const now   = new Date();
  const week  = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const trades = perf.allTrades.filter(t => new Date(t.date) >= week);
  await sendMsg(client, formatPerfReport("📅 WEEKLY", calcStats(trades)));
}

async function postMonthlyReport(client) {
  const perf  = loadPerf();
  const { year, month } = getEtParts();
  const trades = perf.allTrades.filter(t => {
    const d = new Date(t.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
  await sendMsg(client, formatPerfReport("📅 MONTHLY", calcStats(trades)));
}

// ── DISCORD COMMANDS ──────────────────────────────────────────────────────

async function handleCommand(client, webull, msg) {
  const cmd = msg.content.trim().toLowerCase();

  // ── !balance ──
  if (cmd === "!balance") {
    try {
      const balance = await webull.getBalance();
      const cash = (balance.cash || 0).toFixed(2);
      const bp = (balance.buyingPower || 0).toFixed(2);
      const total = (balance.totalValue || 0).toFixed(2);
      await msg.reply(
        `💰 **Account Balance** — ${etFull()}\n\n` +
        `• Cash: $${cash}\n` +
        `• Buying Power: $${bp}\n` +
        `• Total Value: $${total}`
      );
    } catch (err) {
      const msg1 = err.message.split("\n")[0];
      await msg.reply(`❌ Balance check failed: ${msg1}\n_Note: Set WEBULL_PROXY_URL to fix geo-blocking_`);
    }
    return;
  }

  // ── !scan ──
  if (cmd === "!scan") {
    if (!isMarketHours()) {
      await msg.reply(`⚠️ Market is currently closed. Scan will run at 9:45 AM ET on the next trading day.\n_(Current ET time: ${etFull()})_`);
      return;
    }
    await msg.reply("⏳ Running scan...");
    await runScan(client, webull);
    return;
  }

  // ── !positions ──
  if (cmd === "!positions") {
    const state = loadState();
    if (state.activeTrades.length === 0 && !state.pendingApproval) {
      await msg.reply(`📭 **No open positions** · ${etFull()}`);
      return;
    }

    let text = `📋 **OPEN POSITIONS** — ${etFull()}\n\n`;

    if (state.pendingApproval) {
      const pa = state.pendingApproval;
      text += `⏳ **Pending Approval:** ${pa.symbol} ${pa.direction} · $${pa.position.totalCost.toFixed(2)} total\n`;
      text += `   Strike $${pa.position.strike.toFixed(2)} · Exp ${pa.position.expiryDate}\n\n`;
    }

    for (const t of state.activeTrades) {
      const pct       = Math.round((t.currentPremium - t.entryPremium) / t.entryPremium * 100 * 10) / 10;
      const emoji     = pct >= 0 ? "🟢" : "🔴";
      const floorLine = t.profitFloor ? `· Floor: $${t.profitFloor.toFixed(2)} ` : "";
      text += `${emoji} **${t.symbol} ${t.direction}**\n`;
      text += `   Premium: $${t.entryPremium.toFixed(2)} → $${t.currentPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)\n`;
      text += `   SL: $${t.activeSL.toFixed(2)} ${floorLine}· Peak: $${(t.peakPremium || t.currentPremium).toFixed(2)}\n`;
      text += `   Strike $${t.position.strike.toFixed(2)} · Exp ${t.position.expiryDate} · ${t.position.contracts} contract(s)\n\n`;
    }

    await msg.reply(text.slice(0, 2000));
    return;
  }

  // ── !health ──
  if (cmd === "!health") {
    const state      = loadState();
    const uptime     = Math.round(process.uptime() / 60);
    const dayPnL     = getDailyPnL();
    const lossHalted = isDailyLossExceeded();
    const budget     = await calcTradeBudget(webull);
    await msg.reply(
      `🤖 **BOT HEALTH** — ${etFull()}\n\n` +
      `• Status:            ✅ Online · ${uptime} min uptime\n` +
      `• Market Open:       ${isMarketHours() ? "🟢 Yes" : "🔴 No"}\n` +
      `• Active Trades:     ${state.activeTrades.length}\n` +
      `• Pending Approval:  ${state.pendingApproval ? "⏳ Yes" : "None"}\n` +
      `• Trade Budget:      $${budget}\n` +
      `• Daily P&L:         $${dayPnL.toFixed(2)} ${lossHalted ? "🛑 HALTED" : ""}\n` +
      `• Daily Loss Limit:  −$${getDailyLossLimit().toFixed(2)} (25% of balance)\n` +
      `• SL:                −20% initial · trails up with profit floor\n` +
      `• Exit:              Momentum-based · closes when 5m trend turns against\n` +
      `• VIX gate:          skip when VIX > 28\n` +
      `• Earnings filter:   skip ±3 days\n` +
      `• Webull Account:    ${process.env.WEBULL_ACCOUNT_ID}\n` +
      `• Environment:       ${process.env.WEBULL_ENVIRONMENT || "prod"}`
    );
    return;
  }

  // ── !status ──
  if (cmd === "!status") {
    const state  = loadState();
    const perf   = loadPerf();
    const today  = perf.allTrades.filter(t => t.date === etDateStr());
    const todayPnL = Math.round(today.reduce((a, t) => a + t.totalPnL, 0) * 100) / 100;
    const lossHalted = isDailyLossExceeded();
    await msg.reply(
      `📊 **STATUS** — ${etFull()}\n\n` +
      `• Active Trades:    ${state.activeTrades.length}\n` +
      `• Pending Approval: ${state.pendingApproval ? `⏳ ${state.pendingApproval.symbol} ${state.pendingApproval.direction}` : "None"}\n` +
      `• Trades Today:     ${today.length}\n` +
      `• Today P&L:        $${todayPnL.toFixed(2)}${lossHalted ? " 🛑 loss limit hit" : ""}\n` +
      `• Market Hours:     ${isMarketHours() ? "✅ Open" : "❌ Closed"}\n\n` +
      `📅 Schedule (ET):\n` +
      `• 9:30 AM → Market brief\n` +
      `• 9:45 AM → Morning scan (buttons)\n` +
      `• Every 15min → Rescan · Every 2min → Monitor\n` +
      `• 3:30 PM → Auto-close · 4:00 PM → Reports`
    );
    return;
  }

  // ── !performance ──
  if (cmd === "!performance") {
    const perf   = loadPerf();
    const today  = perf.allTrades.filter(t => t.date === etDateStr());
    const week   = perf.allTrades.filter(t => new Date(t.date) >= new Date(Date.now() - 7 * 86400000));
    const all    = perf.allTrades;

    const lines = [
      formatPerfReport("Today", calcStats(today)),
      formatPerfReport("This Week", calcStats(week)),
      formatPerfReport("All Time", calcStats(all)),
    ];

    // Send separately to avoid 2000-char limit
    for (const line of lines) {
      await sendMsg(client, line);
    }
    return;
  }

  // ── !close ── manually close the active trade at current price
  if (cmd === "!close") {
    const state = loadState();
    if (state.activeTrades.length === 0) {
      await msg.reply("📭 No active trades to close.");
      return;
    }
    await msg.reply("⏳ Closing position(s)...");
    for (const trade of [...state.activeTrades]) {
      await closePosition(client, trade, "Manual close via !close", webull);
    }
    return;
  }

  // ── !cancel ── cancel a pending approval
  if (cmd === "!cancel") {
    const state = loadState();
    if (!state.pendingApproval) {
      await msg.reply("📭 No pending trade approval to cancel.");
      return;
    }
    const sym = state.pendingApproval.symbol;
    state.pendingApproval = null;
    saveState(state);
    await msg.reply(`❌ Cancelled pending approval for **${sym}**.`);
    return;
  }

  // ── !improve ── show improvement suggestions
  if (cmd === "!improve") {
    await msg.reply(
      `💡 **IMPROVEMENT SUGGESTIONS**\n\n` +
      `**Accuracy**\n` +
      `• 🔑 Pull real option chain bid/ask from Webull instead of Black-Scholes estimates — exact fill price\n` +
      `• Add IV rank/percentile filter — only trade when IV is elevated (options priced well)\n` +
      `• Add earnings calendar check — skip stocks with earnings within 3 days\n\n` +
      `**Risk Management**\n` +
      `• Add max daily loss limit (e.g., −$200/day → stop trading)\n` +
      `• Add VIX filter — skip new trades when VIX > 30 (panic market)\n` +
      `• Trail stop after TP1: instead of fixed breakeven, use 50% retracement of TP1→TP2 move\n\n` +
      `**Signal Quality**\n` +
      `• Add MACD crossover as a confirming signal\n` +
      `• Add sector ETF momentum (e.g., AAPL aligned with XLK)\n` +
      `• Add pre-market gap filter — stocks gapping >2% up/down often follow through\n\n` +
      `**UX / Discord**\n` +
      `• Use Discord buttons (✅ Yes / ❌ No) instead of text replies for order approval\n` +
      `• Add \`!export\` command to DM a CSV of all trades\n` +
      `• Send a daily market brief at 9:30 AM (SPY, QQQ, VIX levels)\n\n` +
      `**Infrastructure**\n` +
      `• Add paper trading mode (\`PAPER_MODE=true\`) to test signals risk-free\n` +
      `• Use PM2 for process management (auto-restart on crash)\n` +
      `• Add Telegram as a backup alert channel`
    );
    return;
  }

  // ── Unknown command ──
  if (cmd.startsWith("!")) {
    await msg.reply(
      `❓ Unknown command.\n\n` +
      `**Available commands:**\n` +
      `\`!scan\` \`!positions\` \`!close\` \`!cancel\` \`!health\` \`!status\` \`!performance\` \`!improve\``
    );
  }
}

// ── 9:30 AM MARKET BRIEF ─────────────────────────────────────────────────

async function postMarketBrief(client, webull) {
  const [spyRes, qqqRes, vixRes] = await Promise.allSettled([
    webull.getBars("SPY", "1d", 5),
    webull.getBars("QQQ", "1d", 5),
    getVixLevel(webull),
  ]);

  function pctChange(bars) {
    if (!bars || bars.length < 2) return null;
    const prev = bars[bars.length - 2].close;
    const last = bars[bars.length - 1].close;
    return Math.round((last - prev) / prev * 1000) / 10;
  }

  function fmtPct(v) {
    if (v === null) return "N/A";
    return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  }

  const spyPct = spyRes.status === "fulfilled" ? pctChange(spyRes.value) : null;
  const qqqPct = qqqRes.status === "fulfilled" ? pctChange(qqqRes.value) : null;
  const vix    = vixRes.status  === "fulfilled" ? vixRes.value : null;
  const vixInfo = classifyVix(vix);

  // Fetch pre-market gappers from our watchlist (top 3 by abs change)
  const gapCandidates = [];
  for (const sym of ["SPY", "QQQ", "AAPL", "NVDA", "MSFT", "TSLA", "META", "AMZN", "GOOGL"]) {
    try {
      const snap = await webull.getSnapshot(sym);
      if (snap.changePercent !== 0) gapCandidates.push(snap);
    } catch { /* skip */ }
  }
  gapCandidates.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  const topGappers = gapCandidates.slice(0, 3)
    .map(s => `${s.symbol} ${fmtPct(s.changePercent * 100)}`).join(" · ");

  // Market trend
  let trend = "NEUTRAL";
  if (spyRes.status === "fulfilled") trend = getMarketTrend(spyRes.value);
  const trendEmoji = trend === "BULLISH" ? "📈" : trend === "BEARISH" ? "📉" : "➡️";

  await sendMsg(client,
    `🌅 **MARKET OPEN** — ${etFull()}\n\n` +
    `• SPY: ${fmtPct(spyPct)}\n` +
    `• QQQ: ${fmtPct(qqqPct)}\n` +
    `• VIX: ${vixInfo.emoji} ${vixInfo.label}\n` +
    `• Trend: ${trendEmoji} ${trend}\n` +
    (topGappers ? `• Movers: ${topGappers}\n` : "") +
    `\n_📋 Scan at 9:45 AM ET — Budget: dynamic (50% buying power, min $${MIN_BUDGET})_`
  );
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────

function startScheduler(client, webull) {
  const fired = new Set();

  setInterval(async () => {
    if (!isMarketDay()) return;

    const { hour, min, dow, year, month, date } = getEtParts();
    const hhmm    = `${String(hour).padStart(2, "0")}${String(min).padStart(2, "0")}`;
    const today   = etDateStr();

    // 9:30 AM — Market open brief (SPY, QQQ, VIX, trend, gappers)
    if (hhmm === "0930" && !fired.has(`brief_${today}`)) {
      fired.add(`brief_${today}`);
      await postMarketBrief(client, webull);
    }

    // 9:45 AM — Morning scan
    if (hhmm === "0945" && !fired.has(`scan_${today}`)) {
      fired.add(`scan_${today}`);
      await runScan(client, webull);
    }

    // Every 2 min during market hours — monitor positions
    if (isMarketHours() && min % 2 === 0 && !fired.has(`mon_${today}_${hhmm}`)) {
      fired.add(`mon_${today}_${hhmm}`);
      await monitor2Min(client, webull);
    }

    // Every 15 min during market hours (skip 9:45, skip after 3:00 PM EOD window) — rescan + status update
    if (isMarketHours() && min % 15 === 0 && hhmm !== "0945" && hhmm < "1500" && !fired.has(`rescan_${today}_${hhmm}`)) {
      fired.add(`rescan_${today}_${hhmm}`);
      await runScan(client, webull);
      await post15MinUpdate(client);
    }

    // 3:30 PM — Auto-close any open position 30 min before close
    if (hhmm === "1530" && !fired.has(`autoclose_${today}`)) {
      fired.add(`autoclose_${today}`);
      const s = loadState();
      if (s.activeTrades.length > 0) {
        await sendMsg(client, `⏰ **AUTO-CLOSE** — 30 min before market close. Closing all open positions.`);
        for (const trade of [...s.activeTrades]) {
          await closePosition(client, trade, "Auto-close 3:30 PM ET", webull);
        }
        // Confirm auto-close complete
        const updated = loadState();
        if (updated.activeTrades.length === 0) {
          await sendMsg(client, `✅ **AUTO-CLOSE COMPLETE** — All positions closed. Daily report at 4:00 PM.`);
        }
      } else {
        await sendMsg(client, `ℹ️ **3:30 PM Check** — No open positions to close.`);
      }
    }

    // 4:00 PM — Daily report + close remaining positions
    if (hhmm === "1600" && !fired.has(`eod_${today}`)) {
      fired.add(`eod_${today}`);
      await postDailyReport(client);

      // Friday → weekly report too
      if (dow === 5) await postWeeklyReport(client);

      // Last calendar day of month → monthly report
      const lastDay = new Date(year, month + 1, 0).getDate();
      if (date === lastDay) await postMonthlyReport(client);
    }

    // Keep fired set from growing unboundedly — clear yesterday's entries
    for (const key of fired) {
      if (!key.includes(today)) fired.delete(key);
    }
  }, 30 * 1000); // tick every 30 seconds

  console.log(`[${etFull()}] Scheduler started (30s tick)`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  const isTestMode = process.env.TEST_MODE === "true";
  console.log(`[${etFull()}] Starting Swing Options Bot${isTestMode ? " [TEST MODE]" : ""}...`);

  // Validate required env vars
  const required = [
    "DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID",
    "WEBULL_APP_KEY", "WEBULL_APP_SECRET", "WEBULL_ACCOUNT_ID",
  ];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  const webull = new WebullClient();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // Privileged intent — must enable in Discord Dev Portal
    ],
  });

  client.once("clientReady", async () => {
    const PAPER_TRADE = process.env.PAPER_TRADE === "true";
    const modeLabel = PAPER_TRADE ? "📋 **PAPER TRADE MODE**" : "💰 **LIVE TRADING MODE**";
    const modeWarning = PAPER_TRADE ? "⚠️ ALL TRADES ARE SIMULATED (NO REAL MONEY EXCHANGED)" : "⚠️ OPTIONS TRADING ONLY (CALL/PUT) — REAL MONEY";

    console.log(`[${etFull()}] Discord bot ready: ${client.user.tag}`);
    startScheduler(client, webull);

    await sendMsg(client,
      `🤖 **Swing Options Bot v2.5** — ${etFull()}\n` +
      `${modeWarning}\n` +
      `${modeLabel}\n\n` +
      `📋 **Config:** Dynamic budget (scales with balance) · ${ELIGIBLE_SYMBOLS.length} symbols\n` +
      `• SL −20% · Profit floor at +15%, trails 12% below peak\n` +
      `• Momentum exit: closes when 5m trend turns against position\n` +
      `• VIX filter: skip when VIX > 28 · Earnings filter: skip ±3 days\n` +
      `• Daily loss limit: 25% of balance · Auto-close 3:30 PM ET\n\n` +
      `📅 **Schedule (ET):**\n` +
      `• 9:30 AM → Market brief (SPY/QQQ/VIX/gappers)\n` +
      `• 9:45 AM → Morning scan · Buttons: ✅ Place / ❌ Skip\n` +
      `• Every 15 min → Rescan if no open position\n` +
      `• Every 2 min → Monitor open position (dynamic exits)\n` +
      `• 3:30 PM → Auto-close · 4:00 PM → Reports\n\n` +
      `💬 **Commands:**\n` +
      `\`!scan\` \`!positions\` \`!close\` \`!cancel\` \`!health\` \`!status\` \`!performance\``
    );
  });

  // ── Button interactions (✅ Place Order / ❌ Skip) ──────────────────────
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.channelId !== CHANNEL_ID) return;

    const state = loadState();

    if (interaction.customId === "trade_approve") {
      if (!state.pendingApproval) {
        await interaction.update({ content: interaction.message.content + "\n\n⚠️ No pending trade found.", components: [] });
        return;
      }
      await interaction.update({ content: interaction.message.content + "\n\n✅ **Approved — placing order...**", components: [] });
      await placeTradeOrder(client, webull, state.pendingApproval);
    }

    if (interaction.customId === "trade_skip") {
      state.pendingApproval = null;
      saveState(state);
      await interaction.update({ content: interaction.message.content + "\n\n❌ **Skipped.**", components: [] });
      await sendMsg(client, "Trade skipped. Will rescan in 15 min.");
    }
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot)                return;
    if (msg.channelId !== CHANNEL_ID)  return;

    const content = msg.content.trim().toLowerCase();

    // Commands
    if (content.startsWith("!")) {
      await handleCommand(client, webull, msg);
      return;
    }

    // Fallback text YES/NO (in case buttons fail or are expired)
    const state = loadState();
    if (!state.pendingApproval) return;

    if (["yes", "y"].includes(content)) {
      await msg.reply("✅ Confirmed (text fallback)! Placing order...");
      await placeTradeOrder(client, webull, state.pendingApproval);
    } else if (["no", "n"].includes(content)) {
      state.pendingApproval = null;
      saveState(state);
      await msg.reply("❌ Trade skipped. Will scan again at the next 15-min interval.");
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log(`[${etFull()}] Shutting down gracefully...`);
    await sendMsg(client, `🔴 **Swing Options Bot Offline** — ${etFull()}`);
    process.exit(0);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(err => {
  console.error(`[${etFull()}] Fatal error: ${err.message}`);
  process.exit(1);
});

module.exports = { runScan, monitor2Min, calcOptionPosition, scoreSetup, blackScholes };
