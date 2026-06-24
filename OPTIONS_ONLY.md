# ⚠️ SWING OPTIONS MONITOR — OPTIONS TRADING ONLY

## IMPORTANT DISCLAIMER

This application is designed **EXCLUSIVELY for OPTIONS TRADING** and does NOT support stock trading.

---

## ✅ SUPPORTED (OPTIONS TRADING)

### Trade Types
- **CALL Options** — Bullish bets on underlying stock going up
- **PUT Options** — Bearish bets on underlying stock going down
- **Single-Leg Trades** — One option contract per trade (no spreads yet)

### Trading Features
- ✅ Analyze underlying stocks for options opportunities
- ✅ Suggest options entry/target/stop levels
- ✅ Calculate option Greeks (delta, theta, vega)
- ✅ Monitor options positions
- ✅ Track options P/L
- ✅ Close options contracts at targets/stops
- ✅ Manage options portfolio

### Data Tracked
- Strike price (required)
- Expiry date (required)
- Option type (CALL/PUT)
- Underlying stock price (for Greeks calculation only)
- Volatility (IV)
- Greeks (delta, theta, vega)

---

## ❌ NOT SUPPORTED (STOCK TRADING)

### These Are NOT Permitted
- ❌ Buying/selling stocks directly
- ❌ Long stock positions
- ❌ Short stock positions
- ❌ Margin trading on equities
- ❌ Equity day trading
- ❌ Stock swing trades
- ❌ Any non-option positions

### Underlying Stock Data
The system fetches underlying stock prices **ONLY** to:
- Analyze technical indicators for options selection
- Calculate option Greeks (requires spot price)
- Monitor options P/L (compared to entry price)

**Stock prices are NOT for trading stocks — only for options analysis.**

---

## Code Enforcement

### webull-integration.js
```javascript
// ⚠️  OPTIONS TRADING ONLY — No Stock Trading
// All methods require options parameters:
// - optionType: 'CALL' | 'PUT' (REQUIRED)
// - strikePrice: number (REQUIRED)
// - expiryDate: 'YYYY-MM-DD' (REQUIRED)

async placeOptionOrder(order) {
  const { optionType, strike, expiryDate } = order;
  // Only options allowed
}
```

### swing-options-tracker-webull.js
```javascript
// ⚠️  OPTIONS TRADING ONLY — Swing Options Tracker
// Generates trades with:
// - type: 'CALL' | 'PUT' (never plain "BUY/SELL")
// - strikePrice: number
// - expiryDate: string
// - volatility: percentage
```

### swing-options-15min-monitor.js
```javascript
// ⚠️  OPTIONS TRADING ONLY — 15-Minute Position Monitor
// Monitors:
// - Option contracts (identified by strike + expiry)
// - Option Greeks (delta, theta, vega)
// - Option P/L (separate from stock P/L)
// - NOT stock positions
```

---

## Trade Flow (OPTIONS ONLY)

```
┌─────────────────────────────────────────────────────────┐
│ 1. Analyze Underlying Stocks (technical analysis only)  │
│    ✓ RSI, ATR, Bollinger Bands                          │
│    ✓ Momentum, volatility                               │
│    ✓ Support/Resistance                                 │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Select Best Stock for Options Trade                  │
│    ✓ Score stocks by technical indicators              │
│    ✓ Pick the highest-scoring stock                    │
│    ✓ Note: Stock itself is NOT bought/sold             │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Generate Option Trade (CALL or PUT)                  │
│    ✓ Determine direction (bullish = CALL, bearish = PUT)│
│    ✓ Select strike price (ATM or slightly OTM)         │
│    ✓ Set target (5-15% move on the option)             │
│    ✓ Set stop loss (2-5% move on the option)           │
│    ✓ Set expiry (5 days)                               │
│    ✓ Calculate Greeks                                   │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Place Option Order on Webull                         │
│    ✓ Buy 1 CALL contract at strike price              │
│    ✓ OR Buy 1 PUT contract at strike price            │
│    ✓ Set limit price based on Greeks/volatility       │
│    ✓ 5-day expiry                                      │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Monitor Option Position (every 15 minutes)           │
│    ✓ Get current underlying stock price                │
│    ✓ Estimate current option value (Black-Scholes)    │
│    ✓ Check if target hit (close for profit)           │
│    ✓ Check if stop hit (close for loss)               │
│    ✓ Check if expired (close at expiry)               │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ 6. Close Option Position                                │
│    ✓ Market order to sell the option contract         │
│    ✓ Record final P/L                                 │
│    ✓ Log trade to journal                             │
│    ✓ Update stats and equity curve                    │
└─────────────────────────────────────────────────────────┘
```

---

## Risk Management

### Position Limits
- **Max notional per trade:** $5,000 USD (configurable)
- **Max contracts per trade:** 100 (configurable)
- **Hold period:** 5 days (configurable)
- **Weekly loss limit:** -5% (stop trading if hit)

### Order Validation
- Strike price must be real and tradeable
- Expiry must be a valid options expiration date
- Quantity must be within limits
- All orders go through "preview" before execution

---

## What This Is NOT

| This Is NOT | What To Use Instead |
|-------------|-------------------|
| Stock trading system | Interactive Brokers, TD Ameritrade, etc. |
| Day trading bot | Margin trading platform |
| Automated stock investment | Robo-advisor (Betterment, Wealthfront) |
| Long-term equity strategy | Index fund allocation |
| Swing trading on stocks | TradeStation, ThinkorSwim |

---

## Compliance & Warnings

⚠️ **By using this software, you acknowledge:**
1. This system is for **options trading only**
2. **Do not** attempt to use it for stock trading
3. **Do not** modify the code to enable stock trading
4. **Do not** place stock orders through Webull if using this system for position tracking
5. This is an **automated trading system** — review all orders before execution
6. **Options trading carries risk** — you can lose 100% of your investment
7. **Past performance is not indicative of future results**

---

## Configuration Enforcement

The system enforces OPTIONS-ONLY through:

1. **Method Signatures** — All trade methods require `optionType`, `strikePrice`, `expiryDate`
2. **Type Validation** — Will error if you try to place non-option orders
3. **Greeks Calculation** — Only valid for options, not stocks
4. **Exit Logic** — Based on option Greeks decay and volatility, not stock momentum

---

## Support

If you need:
- **Stock trading:** Use a stock trading platform
- **Options education:** CBOE, OptionAlpha, tastytrade
- **Options data:** Webull, TD Ameritrade, Interactive Brokers
- **This system help:** See documentation in repo

---

**Last Updated:** 2026-06-24
**Status:** ✅ OPTIONS ONLY — NO STOCK TRADING
