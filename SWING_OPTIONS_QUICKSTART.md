# Swing Options Tracker - Quick Start

## 🎯 What It Does

Every **market day at 3:45 PM ET**, the service:
1. **Analyzes** 40+ large/mega-cap stocks (AAPL, MSFT, NVDA, TSLA, etc.)
2. **Suggests** ONE high-probability swing option trade
3. **Tracks** P/L of previous trades (5-day expiry)
4. **Posts** to your Discord channel with:
   - New trade recommendation (entry, target, stop loss)
   - Status of active trades (P/L %)
   - Final P/L of expired trades

Example Discord message:
```
🎯 NEW SWING OPTION TRADE SUGGESTION 🎯

Stock: NVDA
Current Price: $120.50
Type: CALL (5 days)
Strike Price: $120.00
Target Price: $132.55 (10.0%)
Stop Loss: $118.00
Risk/Reward: 1:2.0

Rationale: NVDA showing bullish momentum (8.5% in 5d) with volatility at 2.1%.

🟢 Active Trades:
• AAPL (Suggested 1d ago)
  Entry: $195.00 | Current: $196.50
  P/L: 0.77% | Target: $210.08
  Recommendation: HOLD - Trailing stop

⚫ Expired/Closed Trades:
• MSFT: P/L 5.23%
```

## 📦 Files Created

```
stock-analysis-mcp/
├── src/swing-options-tracker.js          # Main service (39 KB)
├── .swing-options-state.json              # Trade history (auto-generated)
├── SWING_OPTIONS_SETUP.md                 # Full setup guide
├── SWING_OPTIONS_QUICKSTART.md            # This file
├── deploy-swing-to-vm.sh                  # Auto deployment script
├── ecosystem.config.js                    # Updated with PM2 config
└── package.json                           # Updated with new npm scripts
```

## 🚀 Deploy to VM (3 steps)

### Step 1: Run the deployment script

```bash
cd /Users/ashokbalamurugan/Thalaivas-Cricket-Team/stock-analysis-mcp

# Make script executable (first time only)
chmod +x deploy-swing-to-vm.sh

# Deploy
./deploy-swing-to-vm.sh
```

### Step 2: Add Discord webhook on VM

```bash
ssh -i ~/Downloads/ssh-key-2026-06-06.key ubuntu@158.101.112.94

# Edit the env file
nano /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.env.production

# Add this line (already set):
# SWING_OPTIONS_DISCORD_WEBHOOK=https://discord.com/api/webhooks/1515581217917898802/shc05En6h1KeOzP659UdY83hiI1PDFJqj6Fqv-zM6ncEm_XO9eeEUj_8I35vw2sA46uQ

# Save: Ctrl+O, Enter, Ctrl+X
```

### Step 3: Start the service

```bash
cd /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp

# Reload PM2 config
pm2 reload ecosystem.config.js

# Save config
pm2 save

# Verify it's registered
pm2 list | grep swing

# Watch it run (one-time)
npm run swing:options:once

# Monitor live logs
pm2 logs swing-options-tracker
```

## 🧪 Test Locally (Before Deploying)

```bash
cd /Users/ashokbalamurugan/Thalaivas-Cricket-Team/stock-analysis-mcp

# One-time test
npm run swing:options:once

# Monitor the output
tail -f .swing-options-state.json | jq '.trades[0]'
```

The test will:
- Fetch real stock data from Yahoo Finance
- Analyze current market momentum/volatility
- Suggest a trade
- Post to your Discord webhook
- Save trade history to `.swing-options-state.json`

## 📋 How Trades Work

### Trade Selection
- Analyzes 5-day momentum + volatility
- Scores stocks (high momentum + high volatility = highest score)
- Top-scoring stock gets the daily suggestion

### Trade Parameters
- **Direction**: CALL (bullish) or PUT (bearish) based on 5-day trend
- **Strike**: At-the-money or slightly out-of-money
- **Target**: +5% to +15% profit
- **Stop Loss**: -2% to -5%
- **Expiry**: 5 days from entry

### Daily Recommendations
Each trade receives one of:
- **HOLD**: Moving as expected, no target/stop hit yet
- **SELL - Target reached**: Profit goal hit, close trade ✅
- **SELL 50% / HOLD 50%**: At 50% of target, take partial profit
- **SELL - Stop loss hit**: Loss limit hit, close trade ⛔
- **EXPIRED**: Trade past 5-day expiry date

## ⏰ Timing

The service runs at **3:45 PM ET** = **7:45 PM UTC** (during EDT)

During winter (EST), adjust the cron in `ecosystem.config.js`:
```javascript
// Change this line from:
cron_restart: "45 19 * * 1-5",  // EDT (current)

// To this in winter:
cron_restart: "45 20 * * 1-5",  // EST (Nov-Mar)
```

Then: `pm2 reload ecosystem.config.js && pm2 save`

## 🔍 Monitoring

### Check today's suggestion
```bash
ssh -i ~/Downloads/ssh-key-*.key ubuntu@158.101.112.94
cat /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.swing-options-state.json | jq '.trades[0]'
```

### Watch in real-time
```bash
pm2 logs swing-options-tracker  # On VM
```

### Check if it ran today
```bash
ls -lt ~/.pm2/logs/swing-options-tracker-*.log | head -1  # Most recent
tail -20 ~/.pm2/logs/swing-options-tracker-out.log
```

### Debugging
```bash
# If service isn't running, check the error log
tail -50 ~/.pm2/logs/swing-options-tracker-error.log

# Run manually to see detailed output
npm run swing:options:once

# Verify Discord webhook is set
grep SWING_OPTIONS_DISCORD_WEBHOOK .env.production
```

## 📊 Example Trade History

After a few days, your `.swing-options-state.json` looks like:

```json
{
  "trades": [
    {
      "symbol": "NVDA",
      "type": "CALL",
      "entryPrice": 120.50,
      "currentPrice": 123.45,
      "targetPrice": 132.55,
      "targetPercent": 10.0,
      "pnlPercent": 2.45,
      "recommendation": "HOLD",
      "expiryDate": "2026-06-19"
    },
    {
      "symbol": "AAPL",
      "type": "PUT",
      "entryPrice": 195.00,
      "finalPrice": 205.65,
      "pnlPercent": -5.46,
      "recommendation": "EXPIRED",
      "expiryDate": "2026-06-17"
    }
  ]
}
```

## ❓ FAQ

**Q: Can I suggest stocks to analyze?**
A: Edit the `ELIGIBLE_SYMBOLS` array in `src/swing-options-tracker.js` and redeploy.

**Q: Why 5-day expiry?**
A: Swing trades typically last 3-7 days. 5 days balances high probability with enough time to develop.

**Q: What if a trade is suggested outside market hours?**
A: The service only runs Mon-Fri at 3:45 PM ET (15 min before market close), so all prices are live.

**Q: Will it work on holidays?**
A: Service runs Mon-Fri. On US market holidays, the service runs but markets are closed, so price data will be stale.

**Q: Can I change the posting time?**
A: Yes, edit `cron_restart` in `ecosystem.config.js`. Format is `"MM HH * * 0-6"` (HH:MM UTC).

**Q: How do I remove old trades from history?**
A: Edit `.swing-options-state.json` directly and remove entries from the `trades` array, or delete the file to start fresh.

## 🆘 Support

### Service won't start
1. Check PM2 logs: `pm2 logs swing-options-tracker`
2. Test manually: `npm run swing:options:once`
3. Check cron is correct: `date` (server time should match cron)

### No Discord posts
1. Verify webhook: `grep SWING_OPTIONS_DISCORD_WEBHOOK .env.production`
2. Test webhook: `curl -X POST ... -d '{"content":"test"}'` (see SWING_OPTIONS_SETUP.md)
3. Check service runs: `pm2 logs | grep swing`

### Trades not tracking
1. Check state file exists: `ls -la .swing-options-state.json`
2. Verify permissions: `chmod 644 .swing-options-state.json`
3. Check format: `cat .swing-options-state.json | jq .`

For more details, see [SWING_OPTIONS_SETUP.md](SWING_OPTIONS_SETUP.md).
