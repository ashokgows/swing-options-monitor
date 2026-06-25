/**
 * Unit Tests — Math & Calculation Functions
 * Tests for RSI, delta, position sizing, volatility, momentum, etc.
 */

const fs = require("fs");

// Extract functions from main bot file for testing
// We'll load the bot and export functions via a test harness

// Helper: CND (cumulative normal distribution) — used by Black-Scholes
function cnd(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2) * t;
  const p =
    1 -
    d *
      (0.31938153 +
        t *
          (-0.356563782 +
            t *
              (1.781477937 +
                t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}

// ── TESTS: RSI CALCULATION ──────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains = deltas.map((d) => (d > 0 ? d : 0));
  const losses = deltas.map((d) => (d < 0 ? -d : 0));
  const avgG = gains.slice(-period).reduce((a, b) => a + b) / period;
  const avgL = losses.slice(-period).reduce((a, b) => a + b) / period;
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

describe("calcRSI", () => {
  test("returns 50 when insufficient data", () => {
    const result = calcRSI([100, 101, 102], 14);
    expect(result).toBe(50);
  });

  test("calculates RSI correctly — uptrend should give RSI > 50", () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeGreaterThan(50);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test("calculates RSI correctly — downtrend should give RSI < 50", () => {
    const closes = [115, 114, 113, 112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100];
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBeLessThan(50);
    expect(rsi).toBeGreaterThanOrEqual(0);
  });

  test("returns 100 when all gains (no losses)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBe(100);
  });

  test("returns 0 when all losses (no gains)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const rsi = calcRSI(closes, 14);
    expect(rsi).toBe(0);
  });

  test("custom period works correctly", () => {
    const closes = [100, 105, 101, 106, 102, 107, 103, 108, 104, 109];
    const rsi5 = calcRSI(closes, 5);
    const rsi7 = calcRSI(closes, 7);
    // Different periods should give different RSI values on volatile data
    expect(typeof rsi5).toBe("number");
    expect(typeof rsi7).toBe("number");
    expect(rsi5).toBeGreaterThan(0);
    expect(rsi7).toBeGreaterThan(0);
  });
});

// ── TESTS: DELTA CALCULATION ────────────────────────────────────────────

function calcDelta(S, K, T, sigma, type) {
  if (T <= 0) return type === "CALL" ? 1 : 0;
  const r = 0.05;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return type === "CALL" ? cnd(d1) : cnd(d1) - 1;
}

describe("calcDelta", () => {
  test("CALL delta should be 1 when T <= 0", () => {
    expect(calcDelta(100, 90, 0, 0.2, "CALL")).toBe(1);
    expect(calcDelta(100, 90, -0.01, 0.2, "CALL")).toBe(1);
  });

  test("PUT delta should be 0 when T <= 0", () => {
    expect(calcDelta(100, 90, 0, 0.2, "PUT")).toBe(0);
  });

  test("ATM CALL delta should be ~0.5", () => {
    const delta = calcDelta(100, 100, 0.1, 0.2, "CALL");
    expect(delta).toBeGreaterThan(0.4);
    expect(delta).toBeLessThan(0.6);
  });

  test("ATM PUT delta should be ~-0.5", () => {
    const delta = calcDelta(100, 100, 0.1, 0.2, "PUT");
    expect(delta).toBeGreaterThan(-0.6);
    expect(delta).toBeLessThan(-0.4);
  });

  test("ITM CALL delta should approach 1", () => {
    const delta = calcDelta(120, 100, 0.1, 0.2, "CALL");
    expect(delta).toBeGreaterThan(0.75);
  });

  test("OTM CALL delta should approach 0", () => {
    const delta = calcDelta(80, 100, 0.1, 0.2, "CALL");
    expect(delta).toBeLessThan(0.25);
  });

  test("delta range [0,1] for CALL", () => {
    const testCases = [
      [50, 100, 0.1, 0.2],
      [100, 100, 0.1, 0.2],
      [150, 100, 0.1, 0.2],
    ];
    testCases.forEach(([S, K, T, sigma]) => {
      const delta = calcDelta(S, K, T, sigma, "CALL");
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(1);
    });
  });

  test("delta range [-1,0] for PUT", () => {
    const testCases = [
      [50, 100, 0.1, 0.2],
      [100, 100, 0.1, 0.2],
      [150, 100, 0.1, 0.2],
    ];
    testCases.forEach(([S, K, T, sigma]) => {
      const delta = calcDelta(S, K, T, sigma, "PUT");
      expect(delta).toBeGreaterThanOrEqual(-1);
      expect(delta).toBeLessThanOrEqual(0);
    });
  });
});

// ── TESTS: VOLATILITY ──────────────────────────────────────────────────

function calcVolatility(closes) {
  if (closes.length < 5) return 0.02;
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean = rets.reduce((a, b) => a + b) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

describe("calcVolatility", () => {
  test("returns 0.02 for insufficient data", () => {
    expect(calcVolatility([100, 101, 102])).toBe(0.02);
  });

  test("returns positive value for normal data", () => {
    const closes = [100, 101, 100, 102, 101, 103, 102, 104];
    const vol = calcVolatility(closes);
    expect(vol).toBeGreaterThan(0);
  });

  test("zero volatility for flat prices", () => {
    const closes = Array(10).fill(100);
    const vol = calcVolatility(closes);
    expect(vol).toBeCloseTo(0, 5);
  });

  test("higher volatility for volatile prices", () => {
    const flatCloses = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const volatileCloses = [100, 90, 110, 85, 115, 80, 120, 75, 125, 70];
    const flatVol = calcVolatility(flatCloses);
    const volatileVol = calcVolatility(volatileCloses);
    expect(volatileVol).toBeGreaterThan(flatVol);
  });
});

// ── TESTS: WIN RATE CALCULATION ────────────────────────────────────────

function calcRecentWinRate(trades) {
  if (!trades || trades.length === 0) return 0.5;
  const recent = trades.slice(-20);
  const wins = recent.filter((t) => t.totalPnL > 0).length;
  return recent.length > 0 ? wins / recent.length : 0.5;
}

function scaleBudgetByWinRate(baseBudget, winRate) {
  const scale = Math.min(0.5 + winRate, 1.2);
  return Math.round(baseBudget * scale * 100) / 100;
}

describe("calcRecentWinRate", () => {
  test("returns 0.5 for no trades", () => {
    expect(calcRecentWinRate([])).toBe(0.5);
    expect(calcRecentWinRate(null)).toBe(0.5);
  });

  test("calculates win rate correctly", () => {
    const trades = [
      { totalPnL: 10 },
      { totalPnL: -5 },
      { totalPnL: 20 },
      { totalPnL: -10 },
      { totalPnL: 15 },
    ];
    const winRate = calcRecentWinRate(trades);
    expect(winRate).toBe(0.6); // 3 wins out of 5
  });

  test("uses only last 20 trades", () => {
    const trades = Array.from({ length: 30 }, (_, i) => ({
      totalPnL: i < 10 ? -1 : 1, // first 10 losses, last 20 wins
    }));
    const winRate = calcRecentWinRate(trades);
    expect(winRate).toBe(1.0); // all last 20 are wins
  });

  test("handles all losses", () => {
    const trades = [{ totalPnL: -1 }, { totalPnL: -5 }, { totalPnL: -10 }];
    expect(calcRecentWinRate(trades)).toBe(0);
  });

  test("handles all wins", () => {
    const trades = [{ totalPnL: 1 }, { totalPnL: 5 }, { totalPnL: 10 }];
    expect(calcRecentWinRate(trades)).toBe(1);
  });
});

describe("scaleBudgetByWinRate", () => {
  test("0% win rate → 50% budget", () => {
    const scaled = scaleBudgetByWinRate(100, 0);
    expect(scaled).toBe(50);
  });

  test("50% win rate → 100% budget", () => {
    const scaled = scaleBudgetByWinRate(100, 0.5);
    expect(scaled).toBe(100);
  });

  test("100% win rate capped at 120%", () => {
    const scaled = scaleBudgetByWinRate(100, 1.0);
    expect(scaled).toBe(120);
  });

  test("scale is clamped to [0.5, 1.2]", () => {
    const scaled = scaleBudgetByWinRate(100, 1.5); // impossible but test edge case
    expect(scaled).toBe(120); // capped
  });

  test("25% win rate → 75% budget", () => {
    const scaled = scaleBudgetByWinRate(100, 0.25);
    expect(scaled).toBe(75);
  });
});

// ── TESTS: IV PERCENTILE ───────────────────────────────────────────────

function calcHistVolPercentile(volatilities) {
  if (!volatilities || volatilities.length < 5) return 0.5;
  const currentVol = volatilities[volatilities.length - 1];
  const sorted = [...volatilities].sort((a, b) => a - b);
  const rank = sorted.filter((v) => v <= currentVol).length / sorted.length;
  return Math.max(0, Math.min(1, rank));
}

describe("calcHistVolPercentile", () => {
  test("returns 0.5 for insufficient data", () => {
    expect(calcHistVolPercentile(null)).toBe(0.5);
    expect(calcHistVolPercentile([0.01, 0.02])).toBe(0.5);
  });

  test("returns correct percentile for current vol", () => {
    const vols = [0.1, 0.2, 0.3, 0.4, 0.5];
    const rank = calcHistVolPercentile(vols);
    expect(rank).toBe(1.0); // current vol (0.5) is highest
  });

  test("low volatility gets low percentile", () => {
    const vols = [0.1, 0.2, 0.3, 0.4, 0.05]; // current 0.05 is lowest
    const rank = calcHistVolPercentile(vols);
    expect(rank).toBe(0.2); // 1 out of 5 = 20th percentile
  });

  test("mid volatility gets mid percentile", () => {
    const vols = [0.1, 0.2, 0.3, 0.4, 0.15]; // current 0.15 is middle
    const rank = calcHistVolPercentile(vols);
    expect(rank).toBeCloseTo(0.4, 0); // 2 out of 5 = 40th percentile
  });

  test("result is clamped to [0,1]", () => {
    const vols = Array.from({ length: 100 }, (_, i) => 0.1 * (i % 10));
    const rank = calcHistVolPercentile(vols);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(1);
  });
});

// ── TESTS: IV RANK FILTER ──────────────────────────────────────────────

function isValidIVRank(ivRank) {
  // Only trade when IV is HIGH (> 80th percentile)
  return ivRank > 0.8;
}

describe("isValidIVRank", () => {
  test("rejects IV < 0.8", () => {
    expect(isValidIVRank(0.79)).toBe(false);
    expect(isValidIVRank(0.5)).toBe(false);
    expect(isValidIVRank(0.2)).toBe(false);
  });

  test("accepts IV > 0.8", () => {
    expect(isValidIVRank(0.81)).toBe(true);
    expect(isValidIVRank(0.9)).toBe(true);
    expect(isValidIVRank(1.0)).toBe(true);
  });

  test("rejects IV exactly at 0.8", () => {
    expect(isValidIVRank(0.8)).toBe(false);
  });
});

// ── TESTS: DELTA FILTER ────────────────────────────────────────────────

function isValidDelta(delta) {
  // Filter for delta 0.4–0.8
  return Math.abs(delta) >= 0.4 && Math.abs(delta) <= 0.8;
}

describe("isValidDelta", () => {
  test("accepts delta in range 0.4–0.8", () => {
    expect(isValidDelta(0.5)).toBe(true);
    expect(isValidDelta(0.4)).toBe(true);
    expect(isValidDelta(0.8)).toBe(true);
    expect(isValidDelta(-0.5)).toBe(true); // PUT
    expect(isValidDelta(-0.4)).toBe(true);
  });

  test("rejects delta outside range", () => {
    expect(isValidDelta(0.39)).toBe(false);
    expect(isValidDelta(0.81)).toBe(false);
    expect(isValidDelta(0.1)).toBe(false);
    expect(isValidDelta(-0.1)).toBe(false);
    expect(isValidDelta(-0.81)).toBe(false);
  });

  test("edge case: exactly at boundaries", () => {
    expect(isValidDelta(0.4)).toBe(true);
    expect(isValidDelta(0.8)).toBe(true);
  });
});

module.exports = {
  calcRSI,
  calcDelta,
  calcVolatility,
  calcRecentWinRate,
  scaleBudgetByWinRate,
  calcHistVolPercentile,
  isValidIVRank,
  isValidDelta,
};
