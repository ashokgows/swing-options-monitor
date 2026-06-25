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
const WebullClient = require("./webull-integration");

// ── CONSTANTS ──────────────────────────────────────────────────────────────

const TZ         = "America/New_York";
const STATE_FILE = path.join(process.cwd(), ".swing-options-state.json");
const PERF_FILE  = path.join(process.cwd(), ".swing-options-performance.json");

const MIN_BUDGET          = 10;    // absolute floor — won't trade with less than $10
const FALLBACK_BUDGET     = parseFloat(process.env.MAX_TRADE_BUDGET || "76"); // used when balance API is unavailable
const ABSOLUTE_MAX_BUDGET = parseInt(process.env.ABSOLUTE_MAX_BUDGET || "2000", 10);
const BUYING_POWER_RATIO  = 0.95;  // use 95% of balance when small (<$300), 50% otherwise
const CHANNEL_ID          = process.env.DISCORD_CHANNEL_ID;
const APPROVAL_TIMEOUT    = 10 * 60 * 1000;

const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || "150"); // $ loss before halting

// Option P/L targets as multipliers of entry premium
const TP1_MULT = 1.30;  // +30%
const TP2_MULT = 1.60;  // +60%
const SL_MULT  = 0.75;  // -25%

// Top 100 S&P 500 components (by market cap) + major sector/index ETFs
const ELIGIBLE_SYMBOLS = [
  // ── Mega-cap tech ───────────────────────────────────────────────────────
  "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO",
  "AMD",  "INTC", "QCOM", "AMAT", "LRCX",  "MU",   "ARM",  "DELL",
  "ORCL", "CRM",  "ADBE", "NOW",  "INTU",  "SNOW", "PANW", "CRWD",
  // ── Financials ──────────────────────────────────────────────────────────
  "JPM",  "BAC",  "GS",   "MS",   "WFC",   "C",    "BLK",  "SCHW",
  "AXP",  "V",    "MA",   "PYPL", "COIN",  "HOOD", "SPGI", "CME",
  // ── Consumer & Retail ───────────────────────────────────────────────────
  "WMT",  "COST", "HD",   "LOW",  "MCD",   "SBUX", "NKE",  "TGT",
  "AMZN", "SHOP", "MELI", "BKNG", "ABNB",  "UBER", "LYFT", "DASH",
  // ── Healthcare & Pharma ─────────────────────────────────────────────────
  "UNH",  "LLY",  "ABBV", "PFE",  "MRK",   "AMGN", "ABT",  "TMO",
  "DHR",  "ISRG", "MDT",  "BSX",  "CVS",
  // ── Industrials ─────────────────────────────────────────────────────────
  "GE",   "CAT",  "DE",   "RTX",  "BA",    "ADP",  "MMM",
  // ── Energy ──────────────────────────────────────────────────────────────
  "XOM",  "CVX",
  // ── Communication & Media ───────────────────────────────────────────────
  "NFLX", "DIS",  "T",    "VZ",   "SNAP",  "PINS", "RBLX", "ZM",
  // ── Consumer Staples ────────────────────────────────────────────────────
  "PG",   "KO",   "IBM",  "JNJ",  "PM",    "CSCO",
  // ── Autos & EV ──────────────────────────────────────────────────────────
  "F",    "GM",   "RIVN", "SOFI", "PLTR",  "MSTR",
  // ── Growth & Speculative (liquid options) ────────────────────────────────
  "APP",  "ROKU", "SQ",   "HOOD", "ACN",   "NEE",
  // ── Index ETFs ──────────────────────────────────────────────────────────
  "SPY",  "QQQ",  "IWM",  "DIA",
  // ── Sector ETFs ─────────────────────────────────────────────────────────
  "XLK",  "XLF",  "XLE",  "XLV",  "XLI",   "XLY",
  // ── Leveraged ETFs (high-vol, great for options) ─────────────────────────
  "TQQQ", "SQQQ",
]
// Deduplicate (AMZN appears twice above for grouping readability)
.filter((s, i, arr) => arr.indexOf(s) === i);

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

// Days between now and a YYYY-MM-DD date string
function daysUntil(dateStr) {
  return Math.max(Math.round((new Date(dateStr + "T16:00:00") - Date.now()) / 86400000), 0.01);
}

// ── STATE MANAGEMENT ───────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { pendingApproval: null, activeTrades: [], closedTrades: [] };
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
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

function isDailyLossExceeded() {
  return getDailyPnL() <= -Math.abs(MAX_DAILY_LOSS);
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
      const ratio   = bp < 300 ? 0.95 : 0.50;
      const dynamic = Math.round(bp * ratio);
      const budget  = Math.min(Math.max(dynamic, MIN_BUDGET), ABSOLUTE_MAX_BUDGET);
      console.log(`[${etFull()}] Balance: $${bp.toFixed(2)} → budget $${budget} (${Math.round(ratio * 100)}% of balance)`);
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

/**
 * Score a stock for an options setup.
 * @param {string} symbol
 * @param {Array}  bars        — daily OHLCV array
 * @param {string} marketTrend — "BULLISH" | "BEARISH" | "NEUTRAL"
 * Returns null if no qualifying setup.
 */
function scoreSetup(symbol, bars, marketTrend = "NEUTRAL") {
  if (!bars || bars.length < 22) return null;

  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const last  = closes[closes.length - 1];
  const rsi   = calcRSI(closes);
  const bb    = calcBB(closes);
  const atr   = calcATR(highs, lows, closes);
  const vol   = calcVolatility(closes.slice(-10));

  if (!bb || !atr || last <= 0) return null;
  if (vol < 0.008) return null; // too quiet for options

  let score     = 0;
  let direction = null;
  const reasons = [];

  // ── Bullish signals → CALL ──
  if (rsi < 30) {
    score += 35; direction = "CALL";
    reasons.push(`RSI ${rsi.toFixed(0)} — deeply oversold`);
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

    if (costPerContract < 1)        continue; // too cheap → illiquid/junk
    if (costPerContract > budget)   continue; // exceeds trade budget

    const contracts = Math.floor(budget / costPerContract);
    if (contracts < 1) continue;

    const totalCost = Math.round(contracts * costPerContract * 100) / 100;
    const tp1       = Math.round(premium * TP1_MULT * 100) / 100;
    const tp2       = Math.round(premium * TP2_MULT * 100) / 100;
    const sl        = Math.round(premium * SL_MULT  * 100) / 100;

    return {
      strike,
      expiryDate,
      premium:    Math.round(premium * 100) / 100,
      contracts,
      totalCost,
      tp1,  // +30% on premium
      tp2,  // +60% on premium
      sl,   // -25% on premium
    };
  }

  return null; // no affordable strike found
}

/**
 * Like calcOptionPosition but uses real bid/ask from Webull option chain.
 * Picks the ask price, finds the most contracts within budget, filters by OI > 0.
 */
function calcOptionPositionFromChain(chain, direction, expiryDate, budget = MIN_BUDGET) {
  const filtered = chain
    .filter(c => c.optionType === direction && c.openInterest > 0 && c.ask > 0)
    .sort((a, b) => a.ask - b.ask); // cheapest first

  for (const c of filtered) {
    const premium        = c.ask;
    const costPerContract = premium * 100;
    if (costPerContract < 5)     continue;
    if (costPerContract > budget) continue;

    const contracts = Math.floor(budget / costPerContract);
    if (contracts < 1) continue;

    const totalCost = Math.round(contracts * costPerContract * 100) / 100;
    return {
      strike:     c.strikePrice,
      expiryDate,
      premium:    Math.round(premium * 100) / 100,
      contracts,
      totalCost,
      tp1:        Math.round(premium * TP1_MULT * 100) / 100,
      tp2:        Math.round(premium * TP2_MULT * 100) / 100,
      sl:         Math.round(premium * SL_MULT  * 100) / 100,
    };
  }
  return null;
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

  const scanList = ELIGIBLE_SYMBOLS.filter(s => s !== "SPY" && webull.isSymbolAllowed(s));
  console.log(`[${etFull()}] Scanning ${scanList.length} symbols...`);
  await sendMsg(client, `🔍 **SCANNING** ${scanList.length} symbols... _(${etFull()})_`);

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

  // ── 2. Scan symbols in parallel batches of 10 ────────────────────────────
  const setups         = [];
  let   earningsSkipped = 0;
  const BATCH_SIZE     = 10;

  for (let i = 0; i < scanList.length; i += BATCH_SIZE) {
    const batch = scanList.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        if (earningsSet.has(symbol)) return { _earningsSkip: true };
        const bars = await webull.getBars(symbol, "1d", 30);
        if (!bars || bars.length < 22) return null;
        return scoreSetup(symbol, bars, marketTrend);
      })
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      if (r.value._earningsSkip) { earningsSkipped++; continue; }
      setups.push(r.value);
    }
  }

  const earningsNote = earningsSkipped > 0 ? `⚠️ ${earningsSkipped} symbols skipped (earnings risk)\n` : "";

  if (setups.length === 0) {
    await sendMsg(client,
      `🔍 **SCAN COMPLETE** — No qualifying setups found _(${etFull()})_\n` +
      earningsNote +
      `VIX: ${vixInfo.emoji} ${vixInfo.label}`
    );
    return;
  }

  // ── 3. Pick best setup + real option chain pricing ───────────────────────
  setups.sort((a, b) => b.score - a.score);
  const best   = setups[0];
  const expiry = optimalExpiry(); // 7-14 days out to avoid excessive theta decay

  // Attempt to get real bid/ask from Webull option chain; fall back to Black-Scholes
  let chainData = null;
  let priceSource = "Black-Scholes est.";
  try {
    chainData   = await webull.getOptionChain(best.symbol, expiry);
    priceSource = "live bid/ask";
  } catch (e) {
    console.warn(`[${etFull()}] Option chain unavailable for ${best.symbol} (geo-blocked API): ${e.message} — using Black-Scholes estimate`);
  }

  const position = chainData && chainData.length > 0
    ? calcOptionPositionFromChain(chainData, best.direction, expiry, budget)
    : calcOptionPosition(best.last, best.direction, best.vol, expiry, budget);

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

  const proposalText =
    `${dirEmoji} **TRADE SETUP** — ${etFull()}\n` +
    `Market: ${trendEmoji} ${marketTrend} · VIX: ${vixInfo.emoji} ${vixInfo.label} · ${setups.length} setup(s)\n` +
    (earningsNote ? earningsNote : "") +
    `\n**${best.symbol} ${best.direction}** · Score: ${best.score}/100\n\n` +
    `📊 **Signals:**\n${best.reasons.map(r => `• ${r}`).join("\n")}\n\n` +
    `📋 **Option Contract** _(${priceSource})_:\n` +
    `• Strike:    $${position.strike.toFixed(2)}\n` +
    `• Expiry:    ${position.expiryDate}\n` +
    `• Premium:   $${position.premium.toFixed(2)}/contract (×100 shares)\n` +
    `• Contracts: ${position.contracts}\n` +
    `• **Total Cost: $${position.totalCost.toFixed(2)}** (budget: $${budget} — ${budgetSrc})\n` +
    (priceSource === "Black-Scholes est." ? `⚠️ _**Premium is estimated** — check Webull for actual bid/ask before approving_\n` : "") +
    `\n🎯 **Levels (on premium):**\n` +
    `• SL:  $${position.sl.toFixed(2)}  (−25%)\n` +
    `• TP1: $${position.tp1.toFixed(2)} (+30%) → SL moves to breakeven\n` +
    `• TP2: $${position.tp2.toFixed(2)} (+60%) → Close position\n\n` +
    (runners ? `📌 Runners-up: ${runners}\n\n` : "") +
    `_Click ✅ Place Order or ❌ Skip below · 10-min timeout_`;

  const msg = await sendApproval(client, proposalText);

  // Save pending approval
  state.pendingApproval = {
    symbol:    best.symbol,
    direction: best.direction,
    setup:     { score: best.score, rsi: best.rsi, vol: best.vol, last: best.last, reasons: best.reasons },
    position,
    budget,
    sentAt:    new Date().toISOString(),
    msgId:     msg?.id || null,
  };
  saveState(state);

  // Auto-expire approval
  setTimeout(async () => {
    const s = loadState();
    if (s.pendingApproval && s.pendingApproval.sentAt === state.pendingApproval.sentAt) {
      s.pendingApproval = null;
      saveState(s);
      await sendMsg(client, `⏰ **Trade proposal expired** — No response in 10 min. Scanning next cycle.`);
      console.log(`[${etFull()}] Pending approval for ${best.symbol} expired`);
    }
  }, APPROVAL_TIMEOUT);

  } finally {
    _scanning = false;
  }
}

// ── ORDER MANAGEMENT ───────────────────────────────────────────────────────

async function placeTradeOrder(client, webull, approval) {
  const { symbol, direction, position } = approval;

  // Guard: reject if a trade was already opened since approval was sent
  const currentState = loadState();
  if (currentState.activeTrades.length > 0) {
    await sendMsg(client, `⚠️ **Order blocked** — ${currentState.activeTrades.length} trade(s) already active. Only 1 position at a time.`);
    return;
  }

  console.log(`[${etFull()}] Placing ${direction} order: ${symbol} $${position.strike} exp ${position.expiryDate}`);

  try {
    const order = await webull.placeOptionOrder({
      symbol,
      quantity:   position.contracts,
      side:       "BUY",
      optionType: direction,
      strike:     position.strike,
      expiryDate: position.expiryDate,
      limitPrice: position.premium,
      timeInForce: "DAY",
    });

    const trade = {
      id:             `trade_${Date.now()}`,
      symbol,
      direction,
      position,
      orderId:        order?.orderId || `local_${Date.now()}`,
      entryPremium:   position.premium,
      currentPremium: position.premium,
      entryTime:      new Date().toISOString(),
      status:         "ACTIVE",   // ACTIVE → TP1_HIT → CLOSED
      tp1Hit:         false,
      slMoved:        false,      // true once SL moved to entry after TP1
      activeSL:       position.sl,
    };

    const state          = loadState();
    state.pendingApproval = null;
    state.activeTrades.push(trade);
    saveState(state);

    const dirEmoji = direction === "CALL" ? "📈" : "📉";
    await sendMsg(client,
      `✅ **ORDER PLACED** ${dirEmoji}\n\n` +
      `**${symbol} ${direction}** @ $${position.premium.toFixed(2)}/contract\n` +
      `• Contracts: ${position.contracts} · Cost: $${position.totalCost.toFixed(2)}\n` +
      `• Strike: $${position.strike.toFixed(2)} · Expiry: ${position.expiryDate}\n` +
      `• Order ID: \`${trade.orderId}\`\n\n` +
      `🎯 **Monitoring levels:**\n` +
      `• SL:  $${position.sl.toFixed(2)} (−25%)\n` +
      `• TP1: $${position.tp1.toFixed(2)} (+30%) → SL moves to breakeven\n` +
      `• TP2: $${position.tp2.toFixed(2)} (+60%) → Full close\n\n` +
      `_Monitoring every 5 min · ${etFull()}_`
    );

    console.log(`[${etFull()}] Order placed for ${symbol} ${direction} — ID: ${trade.orderId}`);
  } catch (err) {
    console.error(`[${etFull()}] Order failed: ${err.message}`);
    const state          = loadState();
    state.pendingApproval = null;
    saveState(state);
    await sendMsg(client, `❌ **ORDER FAILED** — ${err.message}\n\nTrade cancelled. Will scan next cycle.`);
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

  const emoji       = isWin ? "✅" : "❌";
  const partialLine = partialPnL !== 0
    ? `• TP1 partial (locked): $${partialPnL.toFixed(2)}\n`
    : "";
  await sendMsg(client,
    `${emoji} **POSITION CLOSED** — ${trade.symbol} ${trade.direction}\n\n` +
    `• Entry: $${trade.entryPremium.toFixed(2)} → Exit: $${trade.currentPremium.toFixed(2)}\n` +
    partialLine +
    `• **Total P&L: $${totalPnL.toFixed(2)}** (${pct >= 0 ? "+" : ""}${pct}%)\n` +
    `• Contracts closed: ${finalContracts}\n` +
    `• Reason: ${reason}\n` +
    `• Time: ${etFull()}`
  );

  // Check daily loss limit after close
  if (isDailyLossExceeded()) {
    const dayPnL = getDailyPnL();
    await sendMsg(client,
      `🛑 **DAILY LOSS LIMIT REACHED** — $${dayPnL.toFixed(2)} (limit: −$${MAX_DAILY_LOSS})\n` +
      `Scanning halted for the rest of the trading day. Resumes tomorrow.`
    );
    console.log(`[${etFull()}] Daily loss limit exceeded ($${dayPnL.toFixed(2)}) — scanning paused`);
  }
}

// ── POSITION MONITOR (every 5 min) ────────────────────────────────────────

async function monitor5Min(client, webull) {
  if (!isMarketHours()) return;

  const state = loadState();
  if (state.activeTrades.length === 0) return;

  console.log(`[${etFull()}] 5-min check — ${state.activeTrades.length} active trade(s)`);

  for (const trade of [...state.activeTrades]) {
    try {
      // Fetch intraday snapshot (real-time price) + daily bars (vol) in parallel
      const [snapResult, barsResult] = await Promise.allSettled([
        webull.getSnapshot(trade.symbol),
        webull.getBars(trade.symbol, "1d", 30),
      ]);
      const bars = barsResult.status === "fulfilled" ? barsResult.value : null;
      if (!bars || bars.length === 0) continue;

      const snap       = snapResult.status === "fulfilled" ? snapResult.value : null;
      const spot       = (snap?.last > 0) ? snap.last : bars[bars.length - 1].close;
      const vol        = Math.max(calcVolatility(bars.map(b => b.close).slice(-10)), 0.005);
      const sigma      = vol * Math.sqrt(252);
      const T          = daysUntil(trade.position.expiryDate) / 365;
      const curPremium = Math.round(blackScholes(spot, trade.position.strike, T, sigma, trade.direction) * 100) / 100;
      const pct        = Math.round((curPremium - trade.entryPremium) / trade.entryPremium * 100 * 10) / 10;

      // Trailing stop: after TP1, trail activeSL 15% below rolling peak premium
      if (trade.tp1Hit) {
        if (!trade.peakPremium || curPremium > trade.peakPremium) {
          trade.peakPremium = curPremium;
        }
        const trailSL = Math.round(trade.peakPremium * 0.85 * 100) / 100;
        if (trailSL > trade.activeSL) {
          trade.activeSL = trailSL;
          console.log(`[${etFull()}] Trailing SL → $${trailSL.toFixed(2)} (${trade.symbol} peak $${trade.peakPremium.toFixed(2)})`);
        }
      }

      // Update current premium in state
      trade.currentPremium = curPremium;
      const s   = loadState();
      const idx = s.activeTrades.findIndex(t => t.id === trade.id);
      if (idx >= 0) s.activeTrades[idx] = trade;
      saveState(s);

      const logEmoji = pct >= 0 ? "🟢" : "🔴";
      console.log(`[${etFull()}] ${logEmoji} ${trade.symbol} ${trade.direction}: $${curPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%) | SL: $${trade.activeSL.toFixed(2)} | TP1: $${trade.position.tp1.toFixed(2)} | TP2: $${trade.position.tp2.toFixed(2)}`);

      // ── TP2 hit → close for full profit ──
      if (curPremium >= trade.position.tp2) {
        await closePosition(client, trade, `TP2 hit — $${curPremium.toFixed(2)} ≥ $${trade.position.tp2.toFixed(2)} (+60%)`, webull);
        continue;
      }

      // ── TP1 hit → partial close (if ≥2 contracts) or move SL to breakeven ──
      if (!trade.tp1Hit && curPremium >= trade.position.tp1) {
        const totalContracts = trade.position.contracts;

        if (totalContracts >= 2) {
          // PARTIAL CLOSE: sell half, hold rest for TP2
          const sellQty    = Math.floor(totalContracts / 2);
          const keepQty    = totalContracts - sellQty;
          const partialPnL = Math.round((curPremium - trade.entryPremium) * 100 * sellQty * 100) / 100;

          try {
            await webull.closeOptionOrder({ ...trade, position: { ...trade.position, contracts: sellQty } });
          } catch (e) {
            console.error(`[${etFull()}] Partial close (TP1) error for ${trade.symbol}: ${e.message}`);
          }

          trade.tp1Hit                = true;
          trade.slMoved               = true;
          trade.activeSL              = trade.entryPremium;
          trade.realizedPnL           = partialPnL;
          trade.partialCloseContracts = sellQty;
          trade.position.contracts    = keepQty;

          const s2   = loadState();
          const idx2 = s2.activeTrades.findIndex(t => t.id === trade.id);
          if (idx2 >= 0) s2.activeTrades[idx2] = trade;
          saveState(s2);

          await sendMsg(client,
            `🎯 **TP1 HIT — PARTIAL CLOSE** — ${trade.symbol} ${trade.direction}\n\n` +
            `• Sold:   ${sellQty} of ${totalContracts} contracts @ $${curPremium.toFixed(2)} (+${pct}%)\n` +
            `• 💰 Locked P&L: +$${partialPnL.toFixed(2)}\n` +
            `• Remaining: ${keepQty} contract(s) — 🛡️ SL at breakeven ($${trade.entryPremium.toFixed(2)})\n` +
            `• Holding for TP2: $${trade.position.tp2.toFixed(2)} (+60%) · ${etFull()}`
          );
        } else {
          // 1 contract — just move SL
          trade.tp1Hit  = true;
          trade.slMoved = true;
          trade.activeSL = trade.entryPremium;

          const s2   = loadState();
          const idx2 = s2.activeTrades.findIndex(t => t.id === trade.id);
          if (idx2 >= 0) s2.activeTrades[idx2] = trade;
          saveState(s2);

          await sendMsg(client,
            `🎯 **TP1 HIT** — ${trade.symbol} ${trade.direction}\n\n` +
            `• Premium: $${curPremium.toFixed(2)} (+${pct}%)\n` +
            `• 🛡️ SL moved to breakeven → $${trade.entryPremium.toFixed(2)}\n` +
            `• Holding for TP2: $${trade.position.tp2.toFixed(2)} (+60%) · ${etFull()}`
          );
        }
        continue;
      }

      // ── SL hit ──
      if (curPremium <= trade.activeSL) {
        const slLabel = trade.slMoved ? "Breakeven SL" : "Initial SL";
        await closePosition(client, trade, `${slLabel} hit — $${curPremium.toFixed(2)} ≤ $${trade.activeSL.toFixed(2)}`, webull);
        continue;
      }

      // ── Expiry reached ──
      if (T <= 0) {
        await closePosition(client, trade, "Option expired", webull);
        continue;
      }

      // ── Theta decay exit: DTE ≤ 2 + past 3:15 PM + no TP1 hit → exit early ──
      const dte = T * 365;
      const { hour: hh, min: mm } = getEtParts();
      if (dte <= 2 && (hh * 100 + mm) >= 1515 && !trade.tp1Hit) {
        await closePosition(client, trade,
          `Theta exit — ${dte.toFixed(1)} DTE, cutting before overnight decay`, webull);
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
    const pct   = Math.round((t.currentPremium - t.entryPremium) / t.entryPremium * 100 * 10) / 10;
    const emoji = pct >= 0 ? "🟢" : "🔴";
    const slLabel = t.slMoved ? "BE" : "SL";
    return (
      `${emoji} **${t.symbol} ${t.direction}** · $${t.currentPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)\n` +
      `   ${slLabel}: $${t.activeSL.toFixed(2)} · TP1: $${t.position.tp1.toFixed(2)} · TP2: $${t.position.tp2.toFixed(2)}\n` +
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
      const pct   = Math.round((t.currentPremium - t.entryPremium) / t.entryPremium * 100 * 10) / 10;
      const emoji = pct >= 0 ? "🟢" : "🔴";
      const slLabel = t.slMoved ? "🛡️ BE" : "SL";
      text += `${emoji} **${t.symbol} ${t.direction}**\n`;
      text += `   Premium: $${t.entryPremium.toFixed(2)} → $${t.currentPremium.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct}%)\n`;
      text += `   ${slLabel}: $${t.activeSL.toFixed(2)} · TP1: $${t.position.tp1.toFixed(2)} · TP2: $${t.position.tp2.toFixed(2)}\n`;
      text += `   Strike $${t.position.strike.toFixed(2)} · Exp ${t.position.expiryDate} · ${t.position.contracts} contract(s)\n`;
      text += `   TP1 Hit: ${t.tp1Hit ? "✅ (SL at breakeven)" : "Not yet"}\n\n`;
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
      `• Trade Budget:      $${budget} (50% buying power, min $${MIN_BUDGET})\n` +
      `• Daily P&L:         $${dayPnL.toFixed(2)} ${lossHalted ? "🛑 HALTED" : ""}\n` +
      `• Daily Loss Limit:  −$${MAX_DAILY_LOSS}\n` +
      `• TP1/TP2/SL:        +30% partial-close / +60% full-close / −25%\n` +
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
      `• Every 15min → Rescan · Every 5min → Monitor\n` +
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

    // Every 5 min during market hours — monitor positions
    if (isMarketHours() && min % 5 === 0 && !fired.has(`mon_${today}_${hhmm}`)) {
      fired.add(`mon_${today}_${hhmm}`);
      await monitor5Min(client, webull);
    }

    // Every 15 min during market hours (skip 9:45) — rescan + status update
    if (isMarketHours() && min % 15 === 0 && hhmm !== "0945" && !fired.has(`rescan_${today}_${hhmm}`)) {
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
    console.log(`[${etFull()}] Discord bot ready: ${client.user.tag}`);
    startScheduler(client, webull);

    await sendMsg(client,
      `🤖 **Swing Options Bot v2** — ${etFull()}\n` +
      `⚠️ OPTIONS TRADING ONLY (CALL/PUT) · **LIVE MODE**\n\n` +
      `📋 **Config:** Dynamic budget (50% buying power, min $${MIN_BUDGET}) · ${ELIGIBLE_SYMBOLS.length} symbols\n` +
      `• TP1 +30% → partial close 50% + SL to breakeven · TP2 +60% → Full close · SL −25%\n` +
      `• VIX filter: skip when VIX > 28 · Earnings filter: skip ±3 days\n` +
      `• Daily loss limit: −$${MAX_DAILY_LOSS} · Auto-close 3:30 PM ET\n\n` +
      `📅 **Schedule (ET):**\n` +
      `• 9:30 AM → Market brief (SPY/QQQ/VIX/gappers)\n` +
      `• 9:45 AM → Morning scan · Buttons: ✅ Place / ❌ Skip\n` +
      `• Every 15 min → Rescan if no open position\n` +
      `• Every 5 min → Monitor open position\n` +
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

module.exports = { runScan, monitor5Min, calcOptionPosition, scoreSetup, blackScholes };
