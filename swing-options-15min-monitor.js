/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  OPTIONS TRADING ONLY — 15-Minute Position Monitor
 * ═══════════════════════════════════════════════════════════════════════════
 * Monitors active OPTIONS positions during market hours.
 * Tracks P/L, manages exits, and monitors CALL/PUT contracts only.
 * NOT for stock position tracking.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");
const WebullClient = require("./webull-integration");

const TZ = "America/New_York";
const DEFAULT_STATE_FILE = ".swing-options-state.json";
const JOURNEY_FILE = ".swing-options-journey.json";
const DECISIONS_FILE = ".swing-options-decisions.json";

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

function isMarketDay(date = new Date()) {
  const nyDate = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  const dayOfWeek = nyDate.getDay();

  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  const holidays = [
    "01-01", "01-19", "02-16", "03-29", "05-25", "06-19",
    "07-03", "09-07", "11-26", "12-25",
  ];

  const monthDay = `${String(nyDate.getMonth() + 1).padStart(2, "0")}-${String(nyDate.getDate()).padStart(2, "0")}`;
  return !holidays.includes(monthDay);
}

function isMarketHours(date = new Date()) {
  const nyDate = new Date(date.toLocaleString("en-US", { timeZone: TZ }));
  const hour = nyDate.getHours();
  const minute = nyDate.getMinutes();
  const time = hour * 100 + minute;

  // Market hours: 9:30 AM (930) to 4:00 PM (1600)
  return time >= 930 && time < 1600;
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

function daysUntilExpiryDate(expiryDate, daysHeld = 0) {
  if (!expiryDate) return Math.max(5 - daysHeld, 0);
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const today = new Date(`${todayStr}T00:00:00Z`);
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  return Math.max(Math.round((expiry - today) / (24 * 60 * 60 * 1000)), 0);
}

// Black-Scholes option price estimation (Abramowitz-Stegun approximation)
function estimateBlackScholesPrice(spotPrice, strikePrice, timeToExpiry, volatility, optionType) {
  const r = 0.05;
  const S = spotPrice;
  const K = strikePrice;
  const T = Math.max(timeToExpiry, 0.01);
  const sigma = Math.max(volatility, 0.01);

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  // Cumulative normal distribution using Abramowitz-Stegun approximation
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

async function checkDiscordReactions() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!botToken || !channelId) return {};

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
      console.error(`[${getNyTime()}] Discord API error: ${response.status} ${response.statusText}`);
      return {};
    }

    const msgs = await response.json();
    if (!Array.isArray(msgs)) return {};

    const decisions = {};
    for (const msg of msgs) {
      if (msg.author?.username !== "Swing Options Monitor" || !msg.content?.includes("POSITION UPDATE")) {
        continue;
      }

      const symbolMatches = msg.content.match(/\*\*([A-Z]{1,5}) (CALL|PUT)\*\*/g);
      if (!symbolMatches) continue;

      const symbols = symbolMatches.map(m => m.match(/\*\*([A-Z]{1,5})/)[1]);

      if (msg.reactions) {
        for (const reaction of msg.reactions) {
          const emoji = reaction.emoji.name;
          if (emoji === "✅") {
            symbols.forEach(sym => {
              if (!decisions[sym]) decisions[sym] = "KEEP";
            });
          } else if (emoji === "❌") {
            symbols.forEach(sym => {
              if (!decisions[sym]) decisions[sym] = "EXIT";
            });
          }
        }
      }
    }
    return decisions;
  } catch (error) {
    console.error(`[${getNyTime()}] Error checking Discord reactions: ${error.message}`);
    return {};
  }
}

async function sendDiscordMessage(content) {
  const webhookUrl = process.env.SWING_OPTIONS_DISCORD_WEBHOOK;
  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        username: "Swing Options Monitor (15min)",
      }),
    });

    return response.ok;
  } catch (error) {
    console.error(`[${getNyTime()}] Discord error: ${error.message}`);
    return false;
  }
}

// ==================== MAIN MONITORING LOOP ====================

async function monitorActiveTrades() {
  const stateFile = path.join(process.cwd(), DEFAULT_STATE_FILE);
  const isTestRun = process.env.TEST_MODE === "true";

  console.log(`[${getNyTime()}] 15-minute monitor started`);

  // Check if market is open
  if (!isMarketDay() && !isTestRun) {
    console.log(`[${getNyTime()}] Market is closed today. Exiting.`);
    process.exit(0);
  }

  if (!isMarketHours() && !isTestRun) {
    console.log(`[${getNyTime()}] Outside market hours (9:30 AM - 4:00 PM ET). Exiting.`);
    process.exit(0);
  }

  // Initialize Webull client
  const webull = new WebullClient();
  try {
    webull.validateCredentials();
  } catch (error) {
    console.error(`[${getNyTime()}] ${error.message}`);
    process.exit(1);
  }

  // Load state
  const state = safeReadJson(stateFile, { trades: [] });
  if (state.trades.length === 0) {
    console.log(`[${getNyTime()}] No active trades to monitor.`);
    process.exit(0);
  }

  // Load journey for updates
  const journey = safeReadJson(JOURNEY_FILE, { startDate: new Date().toISOString(), trades: [], weeklyReports: [] });
  const findJournal = (t) =>
    journey.trades.find((j) => j.symbol === t.symbol && j.suggestedDate === t.suggestedDate);

  // Check Discord reactions
  const reactionDecisions = await checkDiscordReactions();
  const decisions = { ...reactionDecisions, ...safeReadJson(DECISIONS_FILE, {}) };

  console.log(`[${getNyTime()}] Monitoring ${state.trades.length} active trades...`);

  const alerts = [];
  const updatedTrades = [];
  const statusLines = [];
  const appliedDecisions = [];

  // Monitor each trade
  for (const trade of state.trades) {
    // In real scenario, fetch current price from Webull
    // For now, use mock data or last known price
    let currentPrice = trade.currentPrice;
    let currentOptionPrice = trade.currentOptionPrice || 0;

    if (!currentPrice || currentPrice <= 0) {
      updatedTrades.push(trade);
      continue;
    }

    // Check for user decision
    if (decisions[trade.symbol]) {
      const action = decisions[trade.symbol];
      if (action === "EXIT") {
        const stockPnLPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        console.log(
          `[${getNyTime()}] ${trade.symbol}: User EXIT (❌ emoji) (${stockPnLPercent >= 0 ? "+" : ""}${stockPnLPercent.toFixed(2)}%)`
        );
        appliedDecisions.push({ symbol: trade.symbol, action: "EXIT", price: currentPrice, pnl: stockPnLPercent });
        continue; // Remove from active trades
      } else if (action === "KEEP") {
        delete decisions[trade.symbol];
        appliedDecisions.push({ symbol: trade.symbol, action: "KEEP" });
        console.log(`[${getNyTime()}] ${trade.symbol}: User KEEP (✅ emoji)`);
      }
    }

    // Calculate P/L
    const pnlPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const isCall = trade.type === "CALL";
    const isAboveTarget = isCall ? currentPrice >= trade.targetPrice : currentPrice <= trade.targetPrice;
    const isBelowStop = isCall ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;

    // Update option price estimate
    const daysHeld = Math.floor((Date.now() - new Date(trade.suggestedDate)) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(daysUntilExpiryDate(trade.expiryDate, daysHeld), 0.01);
    const timeToExpiry = daysRemaining / 365;
    const sigma = (trade.volatility / 100) * Math.sqrt(252);
    currentOptionPrice = estimateBlackScholesPrice(
      currentPrice,
      trade.strikePrice,
      timeToExpiry,
      sigma,
      trade.type
    );
    const baseOptionPrice = Math.max(trade.currentOptionPrice, 0.01); // Avoid division by zero
    const optionPnLPercent = ((currentOptionPrice - baseOptionPrice) / baseOptionPrice) * 100;

    // Build status line
    const emoji = optionPnLPercent >= 0 ? "🟢" : "🔴";
    const stockSign = pnlPercent >= 0 ? "+" : "";
    statusLines.push(
      `${emoji} **${trade.symbol} ${trade.type}** (exp ${trade.expiryDate}, ${Math.ceil(daysRemaining)}d)\n` +
        `   Stock: $${currentPrice.toFixed(2)} (${stockSign}${pnlPercent.toFixed(2)}% vs entry)\n` +
        `   Option: ~$${currentOptionPrice.toFixed(2)} est (${optionPnLPercent >= 0 ? "+" : ""}${optionPnLPercent.toFixed(0)}% P/L)\n` +
        `   🎯 $${trade.targetPrice.toFixed(2)} | 🛑 $${trade.stopLoss.toFixed(2)}`
    );

    // Check for alerts
    if (isAboveTarget) {
      alerts.push({
        symbol: trade.symbol,
        action: "TAKE_PROFIT",
        stockPrice: currentPrice,
        targetPrice: trade.targetPrice,
        pnlPercent,
      });
      console.log(
        `[${getNyTime()}] ALERT: ${trade.symbol} ${trade.type} hit target at $${currentPrice.toFixed(2)}`
      );
      continue; // Close this trade
    } else if (isBelowStop) {
      alerts.push({
        symbol: trade.symbol,
        action: "STOP_LOSS",
        stockPrice: currentPrice,
        stopPrice: trade.stopLoss,
        pnlPercent,
      });
      console.log(
        `[${getNyTime()}] ALERT: ${trade.symbol} ${trade.type} hit stop loss at $${currentPrice.toFixed(2)}`
      );
      continue; // Close this trade
    }

    // Keep trade active
    trade.currentPrice = currentPrice;
    trade.currentOptionPrice = currentOptionPrice;
    updatedTrades.push(trade);

    // Record journal update
    const journal = findJournal(trade);
    if (journal) {
      journal.dailyUpdates = journal.dailyUpdates || [];
      journal.dailyUpdates.push({
        date: new Date().toISOString(),
        price: currentPrice,
        pnlPercent,
        optionPrice: Number(currentOptionPrice.toFixed(2)),
        status: "MONITOR_15MIN",
      });
    }
  }

  // Update state files
  state.trades = updatedTrades;
  safeWriteJson(stateFile, state);
  safeWriteJson(JOURNEY_FILE, journey);

  // Post consolidated update
  if (statusLines.length > 0 && process.env.SWING_OPTIONS_DISCORD_WEBHOOK) {
    const header = `📊 **15-MIN POSITION UPDATE** — ${getNyTime()} ET\n\n`;
    const footer = `_React ✅ to KEEP, ❌ to EXIT_`;
    await sendDiscordMessage(header + statusLines.join("\n\n") + "\n\n" + footer);
  }

  // Post alerts
  for (const alert of alerts) {
    const emoji = alert.action === "TAKE_PROFIT" ? "✅" : "❌";
    const message =
      `${emoji} **${alert.symbol} ${alert.action}**\n\n` +
      `Price: $${alert.stockPrice.toFixed(2)}\n` +
      `P/L: ${alert.pnlPercent >= 0 ? "+" : ""}${alert.pnlPercent.toFixed(2)}%`;
    await sendDiscordMessage(message);
  }

  console.log(`[${getNyTime()}] Monitor complete. Active: ${updatedTrades.length}, Alerts: ${alerts.length}`);
  process.exit(0);
}

if (require.main === module) {
  monitorActiveTrades().catch((error) => {
    console.error(`[${getNyTime()}] Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { monitorActiveTrades };
