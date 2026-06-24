const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const TZ = "America/New_York";
const DEFAULT_STATE_FILE = ".swing-options-state.json";
const JOURNEY_FILE = ".swing-options-journey.json";
const DECISIONS_FILE = ".swing-options-decisions.json";

// Calendar days remaining until a stored expiry date (YYYY-MM-DD), >= 0.
// Falls back to the legacy 5-day model for older trades without expiryDate.
function daysUntilExpiryDate(expiryDate, daysHeld = 0) {
  if (!expiryDate) return Math.max(5 - daysHeld, 0);
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const today = new Date(`${todayStr}T00:00:00Z`);
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  return Math.max(Math.round((expiry - today) / (24 * 60 * 60 * 1000)), 0);
}

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

async function fetchCurrentPrice(symbol) {
  try {
    const response = await axios.get(`${CHART_URL}/${encodeURIComponent(symbol)}`, {
      params: {
        range: "1d",
        interval: "1m",
      },
      timeout: 15000,
      headers: { "User-Agent": "swing-options-hourly-monitor/2.0" },
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
    console.error(`[${getNyTime()}] Failed to fetch ${symbol}: ${error.message}`);
    return null;
  }
}

// Check Discord reactions on recent monitor messages for KEEP/EXIT decisions.
async function checkDiscordReactions() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!botToken || !channelId) return {};

  try {
    // Fetch recent messages in the channel (last 10).
    const msgs = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
      headers: { Authorization: `Bot ${botToken}` },
    }).then(r => r.json());

    if (!Array.isArray(msgs)) return {};

    const decisions = {};
    // Look for messages from the bot (username "Swing Options Monitor").
    for (const msg of msgs) {
      if (msg.author?.username !== "Swing Options Monitor" || !msg.content?.includes("HOURLY POSITION UPDATE")) {
        continue;
      }

      // Extract trade symbols from the message (look for **SYMBOL**)
      const symbolMatches = msg.content.match(/\*\*([A-Z]{1,5}) (CALL|PUT)\*\*/g);
      if (!symbolMatches) continue;

      const symbols = symbolMatches.map(m => m.match(/\*\*([A-Z]{1,5})/)[1]);

      // Check reactions on this message.
      if (msg.reactions) {
        for (const reaction of msg.reactions) {
          // ✅ emoji = keep (Unicode emoji, emoji.id null for standard emoji)
          // ❌ emoji = exit
          const emoji = reaction.emoji.name;
          if (emoji === "✅") {
            // Check who reacted — ideally the owner/user, but accept anyone for now
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

async function monitorActiveTrades() {
  const stateFile = path.join(process.cwd(), DEFAULT_STATE_FILE);
  const isTestRun = process.env.TEST_MODE === "true";

  console.log(`[${getNyTime()}] Hourly monitor started`);

  // ✅ CHECK IF MARKET HOURS
  if (!isMarketDay() && !isTestRun) {
    console.log(`[${getNyTime()}] Market is closed today. Exiting.`);
    process.exit(0);
  }

  if (!isMarketHours() && !isTestRun) {
    console.log(`[${getNyTime()}] Outside market hours (9:30 AM - 4:00 PM ET). Exiting.`);
    process.exit(0);
  }

  // Load active trades
  const state = safeReadJson(stateFile, { trades: [] });
  if (state.trades.length === 0) {
    console.log(`[${getNyTime()}] No active trades to monitor.`);
    process.exit(0);
  }

  // Load the trade journal so we can record intraday snapshots and closures.
  const journey = safeReadJson(JOURNEY_FILE, { startDate: new Date().toISOString(), trades: [], weeklyReports: [] });
  const findJournal = (t) => journey.trades.find(
    (j) => j.symbol === t.symbol && j.suggestedDate === t.suggestedDate
  );

  // Check Discord for emoji reactions (✅ KEEP, ❌ EXIT).
  const reactionDecisions = await checkDiscordReactions();
  const decisions = { ...reactionDecisions, ...safeReadJson(DECISIONS_FILE, {}) };

  console.log(`[${getNyTime()}] Monitoring ${state.trades.length} active trades...${Object.keys(reactionDecisions).length > 0 ? ` (${Object.keys(reactionDecisions).length} reactions found)` : ""}`);

  const alerts = [];
  const updatedTrades = [];
  const statusLines = [];
  const appliedDecisions = [];

  for (const trade of state.trades) {
    const currentPrice = await fetchCurrentPrice(trade.symbol);
    if (!currentPrice || !trade.entryPrice || trade.entryPrice <= 0) {
      updatedTrades.push(trade);
      continue;
    }

    // Check for user decision (KEEP/EXIT from Discord emoji reactions or decision file)
    if (decisions[trade.symbol]) {
      const action = typeof decisions[trade.symbol] === "string"
        ? decisions[trade.symbol]
        : decisions[trade.symbol].action;
      if (action === "EXIT") {
        // User decided to exit — close the trade and record P/L
        const stockPnLPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        const daysHeld = Math.floor((Date.now() - new Date(trade.suggestedDate)) / (1000 * 60 * 60 * 24));
        const journal = findJournal(trade);
        if (journal) {
          journal.isClosed = true;
          journal.closedDate = new Date().toISOString();
          journal.finalPrice = currentPrice;
          journal.finalPnLPercent = stockPnLPercent;
          journal.reason = "User decision (EXIT button)";
          journal.dailyUpdates = journal.dailyUpdates || [];
          journal.dailyUpdates.push({
            date: new Date().toISOString(),
            price: currentPrice,
            pnlPercent: stockPnLPercent,
            status: "CLOSED_USER_DECISION",
          });
        }
        appliedDecisions.push({ symbol: trade.symbol, action: "EXIT", price: currentPrice, pnl: stockPnLPercent });
        console.log(`[${getNyTime()}] ${trade.symbol}: User EXIT (❌ emoji) (${stockPnLPercent >= 0 ? "+" : ""}${stockPnLPercent.toFixed(2)}%)`);
        continue; // skip to next trade (don't add to updatedTrades)
      } else if (action === "KEEP") {
        // User decided to keep — continue monitoring (remove from decisions so it doesn't repeat)
        delete decisions[trade.symbol];
        appliedDecisions.push({ symbol: trade.symbol, action: "KEEP" });
        console.log(`[${getNyTime()}] ${trade.symbol}: User KEEP (✅ emoji) — continue monitoring`);
        // Fall through to normal monitoring
      }
    }

    const pnlPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    // Direction-aware: a CALL profits when price rises (target above, stop below);
    // a PUT profits when price falls (target below, stop above).
    const isCall = trade.type === "CALL";
    const isAboveTarget = isCall ? currentPrice >= trade.targetPrice : currentPrice <= trade.targetPrice;
    const isBelowStop = isCall ? currentPrice <= trade.stopLoss : currentPrice >= trade.stopLoss;

    // Calculate option price at current stock price. Volatility must be
    // ANNUALIZED (stored value is a daily percentage).
    const daysHeld = Math.floor((Date.now() - new Date(trade.suggestedDate)) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(daysUntilExpiryDate(trade.expiryDate, daysHeld), 0.01);
    const timeToExpiry = daysRemaining / 365;
    const sigma = (trade.volatility / 100) * Math.sqrt(252);
    const currentOptionPrice = estimateBlackScholesPrice(
      currentPrice,
      trade.strikePrice,
      timeToExpiry,
      sigma,
      trade.type
    );
    const optionPnLPercent = ((currentOptionPrice - trade.currentOptionPrice) / trade.currentOptionPrice) * 100;

    // Progress from entry toward target / toward stop (0 = at entry, 1 = reached).
    // Direction-agnostic: works for both CALL and PUT.
    const towardTarget = (currentPrice - trade.entryPrice) / (trade.targetPrice - trade.entryPrice);
    const towardStop = (currentPrice - trade.entryPrice) / (trade.stopLoss - trade.entryPrice);
    const journal = findJournal(trade);

    // ONLY alert if actionable: target hit or stop loss hit (NO NOISE)
    if (isAboveTarget) {
      alerts.push({
        symbol: trade.symbol,
        action: "TAKE_PROFIT",
        stockPrice: currentPrice,
        targetPrice: trade.targetPrice,
        pnlPercent: pnlPercent.toFixed(2),
        optionPrice: currentOptionPrice.toFixed(2),
        originalOptionPrice: trade.currentOptionPrice.toFixed(2),
        optionPnL: optionPnLPercent.toFixed(1),
        daysHeld,
        entryPrice: trade.entryPrice,
      });
      console.log(`[${getNyTime()}] ✅ ${trade.symbol}: TARGET HIT! $${currentPrice.toFixed(2)} >= $${trade.targetPrice.toFixed(2)}`);
      // Record closure in the journal.
      if (journal) {
        journal.isClosed = true;
        journal.closedDate = new Date().toISOString();
        journal.finalPrice = currentPrice;
        journal.finalPnLPercent = pnlPercent;
        journal.reason = "Target hit (intraday)";
        journal.dailyUpdates = journal.dailyUpdates || [];
        journal.dailyUpdates.push({ date: new Date().toISOString(), price: currentPrice, pnlPercent, status: "CLOSED_TARGET" });
      }
    } else if (isBelowStop) {
      alerts.push({
        symbol: trade.symbol,
        action: "STOP_LOSS",
        stockPrice: currentPrice,
        stopPrice: trade.stopLoss,
        pnlPercent: pnlPercent.toFixed(2),
        optionPrice: currentOptionPrice.toFixed(2),
        originalOptionPrice: trade.currentOptionPrice.toFixed(2),
        optionPnL: optionPnLPercent.toFixed(1),
        daysHeld,
        entryPrice: trade.entryPrice,
      });
      console.log(`[${getNyTime()}] ❌ ${trade.symbol}: STOP LOSS HIT! $${currentPrice.toFixed(2)} <= $${trade.stopLoss.toFixed(2)}`);
      // Record closure in the journal.
      if (journal) {
        journal.isClosed = true;
        journal.closedDate = new Date().toISOString();
        journal.finalPrice = currentPrice;
        journal.finalPnLPercent = pnlPercent;
        journal.reason = "Stop loss (intraday)";
        journal.dailyUpdates = journal.dailyUpdates || [];
        journal.dailyUpdates.push({ date: new Date().toISOString(), price: currentPrice, pnlPercent, status: "CLOSED_STOP" });
      }
    } else {
      // Position still open — decide HOLD vs EXIT and add a line to the update.
      trade.currentPrice = currentPrice;
      updatedTrades.push(trade);

      let action = "HOLD";
      let actionReason = "trend intact — let it work";
      if (daysRemaining <= 1) {
        action = "EXIT"; actionReason = "expiry imminent — theta decay";
      } else if (towardTarget >= 0.85) {
        action = "EXIT"; actionReason = "near target — lock profit";
      } else if (towardStop >= 0.7) {
        action = "EXIT"; actionReason = "approaching stop — cut risk";
      }

      // Position P/L is the OPTION P/L (a PUT gains when the stock falls),
      // so base the win/loss color on that, not the raw stock move.
      const emoji = optionPnLPercent >= 0 ? "🟢" : "🔴";
      const stockSign = pnlPercent >= 0 ? "+" : "";
      const actionEmoji = action === "EXIT" ? "🚪" : "✋";
      statusLines.push(
        `${emoji} **${trade.symbol} ${trade.type}** (exp ${trade.expiryDate}, ${Math.ceil(daysRemaining)}d)\n` +
        `   Stock: $${currentPrice.toFixed(2)} (${stockSign}${pnlPercent.toFixed(2)}% vs entry $${trade.entryPrice.toFixed(2)})\n` +
        `   Option: ~$${currentOptionPrice.toFixed(2)} est (entry $${trade.currentOptionPrice.toFixed(2)}, ${optionPnLPercent >= 0 ? "+" : ""}${optionPnLPercent.toFixed(0)}% P/L)\n` +
        `   🎯 $${trade.targetPrice.toFixed(2)} | 🛑 $${trade.stopLoss.toFixed(2)}\n` +
        `   ${actionEmoji} **${action}** — ${actionReason}`
      );

      // Record an hourly snapshot in the journal.
      if (journal) {
        journal.dailyUpdates = journal.dailyUpdates || [];
        journal.dailyUpdates.push({
          date: new Date().toISOString(),
          price: currentPrice,
          pnlPercent,
          optionPrice: Number(currentOptionPrice.toFixed(2)),
          status: "HOURLY",
          recommendation: action,
        });
      }
    }
  }

  // Update state with only active trades (remove closed ones)
  state.trades = updatedTrades;
  safeWriteJson(DEFAULT_STATE_FILE, state);

  // Persist journal updates (intraday snapshots + any closures).
  safeWriteJson(JOURNEY_FILE, journey);

  // Clear applied decisions from the file (they've been processed).
  for (const decision of appliedDecisions) {
    delete decisions[decision.symbol];
  }
  if (Object.keys(decisions).length > 0) {
    safeWriteJson(DECISIONS_FILE, decisions);
  } else {
    try {
      fs.unlinkSync(DECISIONS_FILE);
    } catch (_) {}
  }

  // Post one consolidated hourly update for positions that remain open.
  if (statusLines.length > 0) {
    const webhookUrl = process.env.SWING_OPTIONS_DISCORD_WEBHOOK;
    if (webhookUrl) {
      const header = `📊 **HOURLY POSITION UPDATE** — ${getNyTime()} ET\n\n`;
      const reactionGuide = `_To manage positions: React ✅ to KEEP, ❌ to EXIT (checked each hour)_`;
      const footer = `\n\n_Stock P/L is live; option value is a Black-Scholes estimate._\n\n${reactionGuide}`;
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: header + statusLines.join("\n\n") + footer,
            username: "Swing Options Monitor",
          }),
        }).catch(err => console.error(`Discord send error: ${err.message}`));
      } catch (error) {
        console.error(`[${getNyTime()}] Discord error: ${error.message}`);
      }
    }
  }

  // Post summary of applied decisions
  if (appliedDecisions.length > 0 && process.env.SWING_OPTIONS_DISCORD_WEBHOOK) {
    const summary = appliedDecisions
      .map(d => `• ${d.symbol}: ${d.action}${d.pnl ? ` (${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}%)` : ""}`)
      .join("\n");
    try {
      await fetch(process.env.SWING_OPTIONS_DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `✅ **USER DECISIONS APPLIED**\n\n${summary}`,
          username: "Swing Options Monitor",
        }),
      }).catch(e => console.error(`Decision summary error: ${e.message}`));
    } catch (e) {
      console.error(`Discord summary error: ${e.message}`);
    }
  }

  // Post alerts to Discord
  if (alerts.length > 0) {
    const webhookUrl = process.env.SWING_OPTIONS_DISCORD_WEBHOOK;
    if (webhookUrl) {
      for (const alert of alerts) {
        let message = `🔔 **TRADE ALERT** 🔔\n\n`;

        if (alert.action === "TAKE_PROFIT") {
          message += `✅ **CLOSE FOR PROFIT** - ${alert.symbol}\n\n`;
          message += `Entry: $${alert.entryPrice.toFixed(2)} → Current: $${alert.stockPrice.toFixed(2)}\n`;
          message += `P/L: +${alert.pnlPercent}%\n`;
          message += `Days Held: ${alert.daysHeld}\n\n`;
          message += `Option: $${alert.originalOptionPrice} → $${alert.optionPrice} (+${alert.optionPnL}%)\n`;
        } else if (alert.action === "STOP_LOSS") {
          message += `❌ **CLOSE AT STOP LOSS** - ${alert.symbol}\n\n`;
          message += `Entry: $${alert.entryPrice.toFixed(2)} → Current: $${alert.stockPrice.toFixed(2)}\n`;
          message += `P/L: ${alert.pnlPercent}%\n`;
          message += `Days Held: ${alert.daysHeld}\n\n`;
          message += `Option: $${alert.originalOptionPrice} → $${alert.optionPrice} (${alert.optionPnL}%)\n`;
        }

        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: message,
              username: "Swing Options Monitor",
            }),
          }).catch(err => console.error(`Discord send error: ${err.message}`));
        } catch (error) {
          console.error(`[${getNyTime()}] Discord error: ${error.message}`);
        }
      }
    }
  }

  console.log(`[${getNyTime()}] Monitor complete. Alerts: ${alerts.length}`);
  process.exit(0);
}

if (require.main === module) {
  monitorActiveTrades().catch((error) => {
    console.error(`[${getNyTime()}] Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { monitorActiveTrades };
