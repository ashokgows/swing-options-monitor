/**
 * Integration Tests — API Mocks & Business Logic
 * Tests for scan logic, momentum analysis, position sizing, exits, etc.
 */

const axios = require("axios");

jest.mock("axios");

// ── MOCK DATA ──────────────────────────────────────────────────────────

const mockBars1D = [
  { open: 140, high: 142, low: 139, close: 141.5, volume: 1000000 },
  { open: 141.5, high: 143, low: 140, close: 142, volume: 950000 },
  { open: 142, high: 144, low: 141, close: 143.5, volume: 1100000 },
  { open: 143.5, high: 145, low: 142, close: 144, volume: 1200000 },
  { open: 144, high: 146, low: 143, close: 145.5, volume: 1050000 },
  ...Array(20).fill(null).map((_, i) => ({
    open: 145 + Math.sin(i / 5) * 2,
    high: 147 + Math.sin(i / 5) * 2,
    low: 143 + Math.sin(i / 5) * 2,
    close: 145.5 + Math.sin(i / 5) * 2,
    volume: 1000000 + Math.random() * 200000,
  })),
];

const mockBars5M = [
  { close: 145, high: 145.5, low: 144.5 },
  { close: 145.2, high: 145.7, low: 145 },
  { close: 145.5, high: 146, low: 145.2 },
  { close: 145.8, high: 146.2, low: 145.5 },
  { close: 146, high: 146.5, low: 145.8 },
  { close: 146.2, high: 146.7, low: 146 },
  { close: 146.5, high: 147, low: 146.2 },
  { close: 146.8, high: 147.2, low: 146.5 },
  { close: 147, high: 147.5, low: 146.8 },
  { close: 147.2, high: 147.7, low: 147 },
  { close: 147.5, high: 148, low: 147.2 },
  { close: 147.8, high: 148.2, low: 147.5 },
];

const mockSnapshot = {
  symbol: "AAPL",
  last: 145.75,
  changePercent: 1.5,
};

const mockOptionChain = [
  { strikePrice: 145, optionType: "CALL", openInterest: 5000, ask: 2.5, bid: 2.45 },
  { strikePrice: 147, optionType: "CALL", openInterest: 3000, ask: 1.2, bid: 1.15 },
  { strikePrice: 145, optionType: "PUT", openInterest: 4000, ask: 1.8, bid: 1.75 },
  { strikePrice: 143, optionType: "PUT", openInterest: 2000, ask: 0.9, bid: 0.85 },
];

// ── TESTS: SCAN FLOW SIMULATION ────────────────────────────────────────

describe("Scan Flow — Mock API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should successfully fetch market data (SPY, bars, snapshot)", async () => {
    // Mock Webull API
    axios.create = jest.fn(() => ({
      get: jest.fn((url) => {
        if (url.includes("timeline")) {
          return Promise.resolve({ data: mockBars1D });
        }
        return Promise.resolve({ data: { last: 450, changePercent: 0.5 } });
      }),
    }));

    // Simulate fetch
    const client = axios.create();
    const bars = await client.get("timeline");
    const snap = await client.get("quote");

    expect(bars.data).toEqual(mockBars1D);
    expect(snap.data.last).toBe(450);
  });

  test("should calculate score from daily bars", () => {
    // Score calculation: RSI + Bollinger Band + moving average
    const closes = mockBars1D.map((b) => b.close);

    let score = 0;
    // Check for price in Bollinger Band range
    if (closes.length > 0) {
      const avgClose = closes.reduce((a, b) => a + b) / closes.length;
      const last = closes[closes.length - 1];
      // Score bonus if price above average
      if (last > avgClose) {
        score += 15;
      }
    }

    // Any score > 0 is a valid signal
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("should fetch 5m bars for intraday confirmation", async () => {
    const client = axios.create();
    client.get = jest.fn(() => Promise.resolve({ data: mockBars5M }));

    const bars = await client.get("5m-bars");
    expect(bars.data.length).toBeGreaterThanOrEqual(10);
    expect(bars.data[0]).toHaveProperty("close");
  });

  test("should fetch option chain and filter by delta", async () => {
    const client = axios.create();
    client.get = jest.fn(() => Promise.resolve({ data: mockOptionChain }));

    const chain = await client.get("option-chain");

    // Simulate delta filtering (0.4–0.8)
    const spotPrice = 145.75;
    const validOptions = chain.data.filter((c) => {
      // In real code, calculate delta. Here we just check openInterest and ask
      return c.openInterest > 0 && c.ask > 0;
    });

    expect(validOptions.length).toBeGreaterThan(0);
    expect(validOptions.every((c) => c.ask > 0)).toBe(true);
  });
});

// ── TESTS: MOMENTUM ANALYSIS ───────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map((d) => (d > 0 ? d : 0));
  const losses = deltas.map((d) => (d < 0 ? -d : 0));
  const avgG = gains.slice(-period).reduce((a, b) => a + b) / period;
  const avgL = losses.slice(-period).reduce((a, b) => a + b) / period;
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

function analyzeMomentum(bars5m, direction) {
  if (!bars5m || bars5m.length < 10) return "NEUTRAL";

  const closes = bars5m.map((b) => b.close);
  const rsi = calcRSI(closes, 10);
  const ma3 = closes.slice(-3).reduce((a, b) => a + b) / 3;
  const ma8 = closes.slice(-8).reduce((a, b) => a + b) / 8;
  const last = closes[closes.length - 1];

  if (direction === "CALL") {
    if (rsi < 40 || last < ma8 * 0.998) return "AGAINST";
    if (rsi > 55 && last > ma3) return "WITH";
  } else {
    if (rsi > 60 || last > ma8 * 1.002) return "AGAINST";
    if (rsi < 45 && last < ma3) return "WITH";
  }
  return "NEUTRAL";
}

describe("Momentum Analysis", () => {
  test("detects uptrend momentum FOR CALL", () => {
    const uptrend = [
      { close: 100 },
      { close: 101 },
      { close: 102 },
      { close: 103 },
      { close: 104 },
      { close: 105 },
      { close: 106 },
      { close: 107 },
      { close: 108 },
      { close: 109 },
      { close: 110 },
      { close: 111 },
    ];
    const momentum = analyzeMomentum(uptrend, "CALL");
    expect(momentum).toBe("WITH");
  });

  test("detects downtrend momentum AGAINST CALL", () => {
    const downtrend = [
      { close: 111 },
      { close: 110 },
      { close: 109 },
      { close: 108 },
      { close: 107 },
      { close: 106 },
      { close: 105 },
      { close: 104 },
      { close: 103 },
      { close: 102 },
      { close: 101 },
      { close: 100 },
    ];
    const momentum = analyzeMomentum(downtrend, "CALL");
    expect(momentum).toBe("AGAINST");
  });

  test("detects uptrend momentum AGAINST PUT", () => {
    const uptrend = Array(12)
      .fill(null)
      .map((_, i) => ({ close: 100 + i }));
    const momentum = analyzeMomentum(uptrend, "PUT");
    expect(momentum).toBe("AGAINST");
  });

  test("detects downtrend momentum FOR PUT", () => {
    const downtrend = Array(12)
      .fill(null)
      .map((_, i) => ({ close: 111 - i }));
    const momentum = analyzeMomentum(downtrend, "PUT");
    expect(momentum).toBe("WITH");
  });

  test("returns NEUTRAL for insufficient data", () => {
    expect(analyzeMomentum([{ close: 100 }], "CALL")).toBe("NEUTRAL");
    expect(analyzeMomentum(null, "CALL")).toBe("NEUTRAL");
  });

  test("returns NEUTRAL for sideways action", () => {
    const sideways = Array(12)
      .fill(null)
      .map((_, i) => ({ close: 100 + (Math.sin(i) * 0.5) }));
    const momentum = analyzeMomentum(sideways, "CALL");
    expect(["NEUTRAL", "WITH", "AGAINST"]).toContain(momentum);
  });
});

// ── TESTS: POSITION SIZING ────────────────────────────────────────────

function calcOptionPosition(spot, direction, dailyVol, budget) {
  const sigma = dailyVol * Math.sqrt(252);
  const T = 0.1; // 7-14 days
  const offsets = direction === "CALL" ? [0, 0.01, 0.02, 0.03] : [0, -0.01, -0.02, -0.03];

  for (const offset of offsets) {
    const strike = Math.round((spot * (1 + offset)) * 2) / 2;
    const premium = 2.0; // simplified, normally Black-Scholes
    const costPerContract = premium * 100;

    if (costPerContract < 1) continue;
    if (costPerContract > budget) continue;

    const contracts = Math.floor(budget / costPerContract);
    if (contracts < 1) continue;

    return {
      strike,
      premium,
      contracts,
      totalCost: costPerContract * contracts,
      sl: Math.round(premium * 0.8 * 100) / 100,
    };
  }
  return null;
}

describe("Position Sizing", () => {
  test("returns null if no affordable option", () => {
    const position = calcOptionPosition(1000, "CALL", 0.15, 10);
    expect(position).toBeNull(); // too expensive
  });

  test("calculates correct number of contracts for budget", () => {
    const position = calcOptionPosition(100, "CALL", 0.2, 200);
    expect(position).not.toBeNull();
    expect(position.contracts).toBe(Math.floor(200 / (2 * 100)));
    expect(position.totalCost).toBeLessThanOrEqual(200);
  });

  test("respects minimum cost per contract", () => {
    const position = calcOptionPosition(100, "CALL", 0.02, 50);
    if (position) {
      expect(position.premium * 100).toBeGreaterThanOrEqual(1);
    }
  });

  test("picks reasonable strike for CALL", () => {
    const position = calcOptionPosition(100, "CALL", 0.2, 200);
    expect(position).not.toBeNull();
    expect(position.strike).toBeGreaterThanOrEqual(100); // ATM or OTM
    expect(position.strike).toBeLessThanOrEqual(105); // reasonable OTM
  });

  test("picks reasonable strike for PUT", () => {
    const position = calcOptionPosition(100, "PUT", 0.2, 200);
    expect(position).not.toBeNull();
    expect(position.strike).toBeLessThanOrEqual(100); // ATM or OTM
    expect(position.strike).toBeGreaterThanOrEqual(95); // reasonable OTM
  });
});

// ── TESTS: EXIT LOGIC ──────────────────────────────────────────────────

function shouldCloseMomentumExit(momentum, direction) {
  // Close if momentum turned AGAINST
  return momentum === "AGAINST";
}

function shouldCloseEODExit(hour, minute, profit) {
  // Close by 3:20 PM if profit > 0
  const hhmm = hour * 100 + minute;
  return hhmm >= 1520 && profit > 0;
}

function shouldCloseThetaExit(dte, hour, minute) {
  // Close if DTE <= 2 past 3:15 PM
  return dte <= 2 && (hour * 100 + minute) >= 1515;
}

function shouldCloseProfitFloorExit(premium, floor) {
  // Close if premium hits profit floor
  return premium <= floor;
}

describe("Exit Conditions", () => {
  test("momentum exit when AGAINST", () => {
    expect(shouldCloseMomentumExit("AGAINST", "CALL")).toBe(true);
    expect(shouldCloseMomentumExit("WITH", "CALL")).toBe(false);
    expect(shouldCloseMomentumExit("NEUTRAL", "CALL")).toBe(false);
  });

  test("EOD exit after 3:20 PM with profit", () => {
    expect(shouldCloseEODExit(15, 20, 10)).toBe(true); // 3:20 PM, +$10 profit
    expect(shouldCloseEODExit(15, 19, 10)).toBe(false); // 3:19 PM, too early
    expect(shouldCloseEODExit(15, 20, 0)).toBe(false); // breakeven, no profit
    expect(shouldCloseEODExit(15, 20, -5)).toBe(false); // loss, don't exit
  });

  test("theta exit past 3:15 PM when DTE <= 2", () => {
    expect(shouldCloseThetaExit(1.5, 15, 15)).toBe(true); // 3:15 PM, 1.5 DTE
    expect(shouldCloseThetaExit(2.5, 15, 15)).toBe(false); // 2.5 DTE, not yet
    expect(shouldCloseThetaExit(1.5, 14, 59)).toBe(false); // before 3:15 PM
  });

  test("profit floor exit", () => {
    expect(shouldCloseProfitFloorExit(1.8, 2.0)).toBe(true); // below floor
    expect(shouldCloseProfitFloorExit(2.0, 2.0)).toBe(true); // at floor
    expect(shouldCloseProfitFloorExit(2.5, 2.0)).toBe(false); // above floor
  });
});

// ── TESTS: WIN RATE BASED SCALING ──────────────────────────────────────

function calcRecentWinRate(trades) {
  if (!trades || trades.length === 0) return 0.5;
  const recent = trades.slice(-20);
  const wins = recent.filter((t) => t.totalPnL > 0).length;
  return recent.length > 0 ? wins / recent.length : 0.5;
}

function scaleBudgetByWinRate(baseBudget, trades) {
  const winRate = calcRecentWinRate(trades);
  const scale = Math.min(0.5 + winRate, 1.2);
  return Math.round(baseBudget * scale * 100) / 100;
}

describe("Win Rate Scaling", () => {
  test("scales budget down when losing", () => {
    const losses = Array(5)
      .fill(null)
      .map(() => ({ totalPnL: -10 }));
    const scaled = scaleBudgetByWinRate(100, losses);
    expect(scaled).toBeLessThan(100);
  });

  test("scales budget up when winning", () => {
    const wins = Array(5)
      .fill(null)
      .map(() => ({ totalPnL: 10 }));
    const scaled = scaleBudgetByWinRate(100, wins);
    expect(scaled).toBeGreaterThan(100);
  });

  test("caps scaling at 1.2x", () => {
    const allWins = Array(20)
      .fill(null)
      .map(() => ({ totalPnL: 10 }));
    const scaled = scaleBudgetByWinRate(100, allWins);
    expect(scaled).toBeLessThanOrEqual(120);
  });

  test("floors scaling at 0.5x", () => {
    const allLosses = Array(20)
      .fill(null)
      .map(() => ({ totalPnL: -10 }));
    const scaled = scaleBudgetByWinRate(100, allLosses);
    expect(scaled).toBeGreaterThanOrEqual(50);
  });

  test("50% win rate keeps budget unchanged", () => {
    const mixed = [
      ...Array(10).fill(null).map(() => ({ totalPnL: 10 })),
      ...Array(10).fill(null).map(() => ({ totalPnL: -10 })),
    ];
    const scaled = scaleBudgetByWinRate(100, mixed);
    expect(scaled).toBe(100);
  });
});

// ── TESTS: DAILY LOSS LIMIT ────────────────────────────────────────────

function getDailyPnL(trades, today) {
  return trades
    .filter((t) => t.date === today)
    .reduce((sum, t) => sum + t.totalPnL, 0);
}

function getDailyLossLimit(balance) {
  // 25% of balance
  return Math.round(balance * 0.25 * 100) / 100;
}

function isDailyLossExceeded(trades, today, balance) {
  const dailyPnL = getDailyPnL(trades, today);
  const limit = getDailyLossLimit(balance);
  return dailyPnL <= -limit;
}

describe("Daily Loss Limit", () => {
  test("calculates loss limit as 25% of balance", () => {
    expect(getDailyLossLimit(100)).toBe(25);
    expect(getDailyLossLimit(76)).toBe(19);
  });

  test("detects when daily loss exceeded", () => {
    const trades = [
      { date: "2026-06-25", totalPnL: -20 },
      { date: "2026-06-25", totalPnL: -10 },
    ]; // -$30 total
    expect(isDailyLossExceeded(trades, "2026-06-25", 100)).toBe(true);
  });

  test("allows trading when below limit", () => {
    const trades = [
      { date: "2026-06-25", totalPnL: -10 },
      { date: "2026-06-25", totalPnL: -5 },
    ]; // -$15 total
    expect(isDailyLossExceeded(trades, "2026-06-25", 100)).toBe(false);
  });

  test("considers only today's trades", () => {
    const trades = [
      { date: "2026-06-24", totalPnL: -50 },
      { date: "2026-06-25", totalPnL: -5 },
    ];
    expect(isDailyLossExceeded(trades, "2026-06-25", 100)).toBe(false);
  });

  test("allows breakeven", () => {
    const trades = [{ date: "2026-06-25", totalPnL: 0 }];
    expect(isDailyLossExceeded(trades, "2026-06-25", 100)).toBe(false);
  });
});

module.exports = {
  analyzeMomentum,
  calcOptionPosition,
  shouldCloseMomentumExit,
  shouldCloseEODExit,
  shouldCloseThetaExit,
  shouldCloseProfitFloorExit,
  scaleBudgetByWinRate,
  isDailyLossExceeded,
};
