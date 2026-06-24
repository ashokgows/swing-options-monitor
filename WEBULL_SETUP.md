# Swing Options Monitor — Webull Integration Guide

This version of swing-options-monitor uses **Webull OpenAPI MCP** for all trading operations (data fetching, order placement, position management).

## Quick Start

### 1. Install Webull OpenAPI MCP

```bash
# Option A: Using uvx (recommended)
uvx webull-openapi-mcp serve

# Option B: Install via pip
pip install webull-openapi-mcp
webull-openapi-mcp serve

# Option C: Local development
git clone https://github.com/webull-inc/webull-openapi-mcp.git
cd webull-openapi-mcp
uv sync
uv run python -m webull_openapi_mcp serve
```

### 2. Get Webull API Credentials

1. Register at [Webull Developer Portal](https://developer.webull.com/apis/home)
2. Create an app → Get **App Key** and **App Secret**
3. Subscribe to market data at [webullapp.com/quote](https://webullapp.com/quote)
4. Find your **Account ID** in Webull app settings

### 3. Configure Environment

Copy and edit `.env.production`:

```bash
cp .env.production.example .env.production
nano .env.production
```

Fill in:
```bash
WEBULL_APP_KEY=your_app_key
WEBULL_APP_SECRET=your_app_secret
WEBULL_ACCOUNT_ID=your_account_id
WEBULL_REGION_ID=us
WEBULL_ENVIRONMENT=uat          # Use 'uat' for testing, 'prod' for live
WEBULL_MAX_ORDER_NOTIONAL_USD=5000
WEBULL_MAX_ORDER_QUANTITY=100
WEBULL_SYMBOL_WHITELIST=AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA,SPY,QQQ
SWING_OPTIONS_DISCORD_WEBHOOK=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 4. Handle Two-Factor Authentication (if enabled)

If your Webull account has 2FA:

```bash
uvx webull-openapi-mcp auth
# Approve the login request in your Webull mobile app
# Token saves for 15 days, auto-refreshes
```

### 5. Test Configuration

```bash
# Verify syntax
npm run check

# Test tracker (generates sample trade)
TEST_MODE=true npm run start:webull

# Test monitor (checks for active positions)
TEST_MODE=true npm run monitor:15min
```

## Architecture

### Daily Tracker (`swing-options-tracker-webull.js`)

Runs daily at **3:45 PM ET** (via cron or scheduler):

1. ✅ Validates market is open
2. ✅ Fetches 40+ stock OHLCV data from Webull
3. ✅ Calculates technical indicators (RSI, ATR, Bollinger Bands)
4. ✅ Scores stocks and selects best trade opportunity
5. ✅ Generates option trade with entry/target/stop levels
6. ✅ **Posts suggestion to Discord** (ready for manual or auto placement)

**Note:** Order placement to Webull requires additional integration beyond this MVP.

### 15-Minute Monitor (`swing-options-15min-monitor.js`)

Runs every 15 minutes during **9:30 AM - 4:00 PM ET**:

1. ✅ Loads active trades from state
2. ✅ Fetches current prices from Webull
3. ✅ Calculates P/L against entry/target/stop
4. ✅ Estimates option prices (Black-Scholes)
5. ✅ Checks Discord emoji reactions (✅ KEEP, ❌ EXIT)
6. ✅ **Closes trades** when target/stop hit via Webull API
7. ✅ Updates Discord with position snapshots

## Scripts

### Development

```bash
# Syntax check
npm run check

# Test tracker (generates sample trade, no Webull calls)
TEST_MODE=true npm run start:webull

# Test monitor (checks state without Webull calls)
TEST_MODE=true npm run monitor:15min

# Run tracker once (real mode, connects to Webull)
npm run start:webull

# Run monitor once
npm run monitor:15min
```

### Production (with PM2)

```bash
# Install PM2 globally
npm install -g pm2

# Start daily tracker (3:45 PM ET)
pm2 start swing-options-tracker-webull.js --name swing-tracker \
  --env-file .env.production \
  --cron "45 15 * * 1-5"

# Start 15-min monitor (9:30 AM - 4 PM ET)
pm2 start swing-options-15min-monitor.js --name swing-monitor \
  --env-file .env.production \
  --cron "*/15 9-16 * * 1-5"

# Save configuration
pm2 save

# Monitor logs
pm2 logs swing-tracker
pm2 logs swing-monitor
```

### VM Deployment

```bash
# Deploy to Oracle Cloud VM (update host/key)
./deploy-swing-to-vm.sh ubuntu@158.101.112.94 ~/path/to/ssh-key.pem

# SSH into VM
ssh -i ~/path/to/ssh-key.pem ubuntu@158.101.112.94

# Complete setup on VM
cd ~/swing-options-monitor
npm install
nano .env.production  # Add credentials

# Install Python + Webull MCP
pip install webull-openapi-mcp

# Register with PM2
pm2 start swing-options-tracker-webull.js --name swing-tracker \
  --env-file .env.production \
  --cron "45 15 * * 1-5"
pm2 start swing-options-15min-monitor.js --name swing-monitor \
  --env-file .env.production \
  --cron "*/15 9-16 * * 1-5"
pm2 save
```

## Available Webull MCP Tools

Your integration can use these tools via Claude or the MCP:

### Market Data
- `get_stock_quotes` - Current bid/ask/last/change
- `get_stock_bars` - 1m/5m/15m/30m/1h/1d/1w/1mo bars
- `get_stock_snapshot` - Real-time snapshot
- `get_stock_tick` - Tick data

### Trading
- `place_option_single_order` - Buy/sell single-leg options
- `place_option_strategy_order` - Multi-leg strategies (spreads, straddles, etc)
- `preview_option_order` - Preview before placing
- `replace_option_order` - Modify existing option order
- `cancel_order` - Cancel any open order

### Account & Portfolio
- `get_account_positions` - All open positions
- `get_account_balance` - Balance, buying power, cash
- `get_account_list` - All linked accounts
- `get_open_orders` - Current open orders
- `get_order_detail` - Specific order info
- `get_order_history` - Order history (queryable)

### Full Documentation
See [Webull OpenAPI MCP](https://github.com/webull-inc/webull-openapi-mcp) for complete tool reference.

## State Files

- `.swing-options-state.json` — Active trades
- `.swing-options-journey.json` — Trade journal + history
- `.swing-options-stats.json` — Performance metrics
- `.swing-options-equity.json` — Equity curve
- `.swing-options-decisions.json` — User decisions from Discord

## Discord Integration

### Channel Setup

1. Create private Discord channel for trading signals
2. Get your bot token and channel ID
3. Add to `.env.production`:
   ```bash
   DISCORD_BOT_TOKEN=your_bot_token
   DISCORD_CHANNEL_ID=your_channel_id
   ```

### Message Types

**Daily Suggestion (3:45 PM ET):**
```
🎯 NEW TRADE SUGGESTION 🎯

AAPL - 📈 CALL (Bullish)
Entry: $150.50
Strike: $151.00
Target: $158.53 (+5.3%)
Stop Loss: $148.50 (-1.3%)
Expiry: 2026-06-25 (5 days)
Volatility: 2.5%

📝 Reasoning:
• RSI 35 (oversold, potential reversal)
• Price near Bollinger lower band
```

**Position Update (every 15 min):**
```
📊 15-MIN POSITION UPDATE — 11:30 ET

🟢 AAPL CALL (exp 2026-06-25, 4d)
   Stock: $151.25 (+0.50% vs entry)
   Option: ~$1.50 est (+25.0% P/L)
   🎯 $158.53 | 🛑 $148.50

🟢 TSLA PUT (exp 2026-06-25, 4d)
   Stock: $245.00 (-1.00% vs entry)
   Option: ~$2.10 est (-5.0% P/L)
   🎯 $238.50 | 🛑 $248.00

React ✅ to KEEP, ❌ to EXIT
```

**Trade Alert:**
```
✅ AAPL TAKE_PROFIT

Price: $158.60
P/L: +5.4%
```

## Security Best Practices

1. **Never commit `.env.production`** to git
2. **Use sandbox mode** (`WEBULL_ENVIRONMENT=uat`) for testing
3. **Restrict symbols** via `WEBULL_SYMBOL_WHITELIST`
4. **Set order limits** (`WEBULL_MAX_ORDER_*`)
5. **Review preview** before placing via `preview_option_order`
6. **Rotate credentials** quarterly
7. **Enable audit logging** if available
8. **Monitor all Discord alerts** for execution

## Troubleshooting

### Market Data Shows Old Prices

**Problem:** Webull showing EOD prices instead of real-time

**Solution:** Ensure you've subscribed to market quotes at [webullapp.com/quote](https://webullapp.com/quote)

### Authentication Fails

**Problem:** "Invalid credentials" error

**Solution:**
```bash
# Check credentials are correct in .env.production
# For 2FA accounts:
uvx webull-openapi-mcp auth
# Approve in Webull mobile app

# Clear old tokens
rm -rf ./conf/token.txt
```

### 2FA Issues

**Problem:** "Device registration required"

**Solution:**
1. Log into Webull app on your phone
2. Complete device registration
3. Re-run `uvx webull-openapi-mcp auth`

### Discord Messages Not Posting

**Problem:** No Discord notifications

**Check:**
```bash
# Verify webhook URL
curl -X POST -H "Content-Type: application/json" \
  -d '{"content":"Test"}' \
  https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN

# Check bot token and channel ID
echo "Bot token: $DISCORD_BOT_TOKEN"
echo "Channel ID: $DISCORD_CHANNEL_ID"
```

### Orders Not Placing

**Problem:** Trade suggestions generated but Webull orders fail

**Note:** Current MVP generates suggestions only. Full order placement requires:
1. Webull `place_option_single_order` MCP tool integration
2. Risk validation (max notional, max qty)
3. Preview confirmation
4. Order status tracking

Example integration pattern (when ready):
```javascript
const webull = new WebullClient();

// Generate trade
const trade = await generateNewTrade(symbol, data);

// Preview order
const preview = await webull.previewOptionOrder({
  symbol: trade.symbol,
  quantity: 1,
  side: 'BUY',
  optionType: trade.type,
  strike: trade.strikePrice,
  expiryDate: trade.expiryDate,
  limitPrice: estimateOptionPrice(trade),
});

// Place if preview OK
if (preview.estimatedCost < webull.maxOrderValue) {
  const order = await webull.placeOptionOrder({...});
  console.log(`Order placed: ${order.orderId}`);
}
```

## Next Steps

1. **✅ Core:** Get credentials → Test tracker → Monitor positions
2. **📋 Options:** Add Webull order placement when ready
3. **📊 Analytics:** Integrate with backtester for strategy refinement
4. **🔄 Automation:** Run on VM with PM2 + cron jobs

## Support

- **Webull API Docs:** https://developer.webull.com/apis/docs/
- **MCP GitHub:** https://github.com/webull-inc/webull-openapi-mcp
- **Discord Channel:** #swing-options-monitor (your Discord)

---

**Last Updated:** 2026-06-24
**Version:** 2.0 (Webull Integration)
