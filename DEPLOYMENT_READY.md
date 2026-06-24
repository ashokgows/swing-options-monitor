# 🚀 Swing Options Monitor — DEPLOYMENT READY

## Status: ✅ FULLY CONFIGURED

All components are configured and tested. Your swing options monitor is ready for production deployment.

---

## Configuration Summary

### Webull Integration ✅
```
App Key:      916a0b14a0e74baccbb06a75e298bde8
Account ID:   cvt7y3da
Region:       US
Environment:  Production (prod)
```

### Discord Integration ✅
```
Webhook:      Connected ✓
Bot Token:    Configured ✓
Channel ID:   1515581217917898802
Status:       Test message posted
```

### Risk Management ✅
```
Max Order Value:    $5,000 USD
Max Order Qty:      100 contracts
Symbol Whitelist:   38 large/mega cap stocks
```

### Trading Rules ✅
```
Daily Tracker:      3:45 PM ET (market days only)
15-Min Monitor:     9:30 AM - 4:00 PM ET
Position Hold:      5 days max (or earlier if target/stop hit)
Loss Limit:         -5% weekly
Monitoring:         Every 15 minutes during market hours
```

---

## What's Ready NOW

### ✅ Immediate Commands

**Run daily trade suggestion (anytime):**
```bash
npm run start:webull
```
Generates trade suggestion based on technical analysis
→ Posts to Discord
→ Logs to `.swing-options-state.json`

**Run 15-minute position monitor (anytime):**
```bash
npm run monitor:15min
```
Checks active trade positions
→ Monitors P/L vs target/stop
→ Closes trades when targets hit
→ Posts updates to Discord

**Check syntax (anytime):**
```bash
npm run check
```
Verifies all 5 scripts are syntactically correct

---

## 🎯 Recommended Setup

### Option 1: Manual Trading (Simplest)
Run commands as needed:
```bash
# Every morning:
npm run start:webull

# During market hours (manually):
npm run monitor:15min
```

### Option 2: Automated with PM2 (Recommended)
Set it and forget it:

```bash
# Install PM2 globally (one-time)
npm install -g pm2

# Register daily tracker (3:45 PM ET, weekdays only)
pm2 start swing-options-tracker-webull.js \
  --name swing-tracker \
  --env-file .env.production \
  --cron "45 15 * * 1-5"

# Register 15-minute monitor (every 15 min, 9:30 AM - 4:00 PM ET)
pm2 start swing-options-15min-monitor.js \
  --name swing-monitor \
  --env-file .env.production \
  --cron "*/15 9-16 * * 1-5"

# Save configuration
pm2 save

# Restart on system reboot
pm2 startup
pm2 save
```

Monitor your trades:
```bash
pm2 logs swing-tracker      # Watch daily tracker
pm2 logs swing-monitor      # Watch 15-min monitor
pm2 monit                   # Dashboard
pm2 list                    # Status
```

### Option 3: Cloud VM Deployment (Always-On)
For 24/7 automated trading on a server:

```bash
# Deploy to your VM
./deploy-swing-to-vm.sh ubuntu@your-vm-ip /path/to/key.pem

# SSH into VM
ssh -i /path/to/key.pem ubuntu@your-vm-ip

# Complete setup on VM
cd swing-options-monitor
npm install
pip install webull-openapi-mcp

# Update .env.production with credentials
nano .env.production

# Register with PM2
pm2 start swing-options-tracker-webull.js --cron "45 15 * * 1-5"
pm2 start swing-options-15min-monitor.js --cron "*/15 9-16 * * 1-5"
pm2 save
pm2 startup
```

---

## Discord Channel Messages

Your swing options monitor will post:

### 1. Daily Trade Suggestion (3:45 PM ET)
```
🎯 NEW TRADE SUGGESTION 🎯

AAPL - 📈 CALL (Bullish)

Entry: $150.50
Strike: $152.00
Target: $158.53 (+5.3%)
Stop Loss: $148.50 (-1.3%)
Expiry: 2026-06-29 (5 days)
Volatility: 2.5%

📝 Reasoning:
• RSI 35 (oversold, potential reversal)
• High volatility (good for options)
• Price near support

🔗 Next Step: Place order on Webull
```

### 2. Every 15 Minutes (Position Update)
```
📊 15-MIN POSITION UPDATE — 11:30 ET

🟢 AAPL CALL (exp 2026-06-29, 4d)
   Stock: $151.25 (+0.50% vs entry)
   Option: ~$1.50 est (+25.0% P/L)
   🎯 $158.53 | 🛑 $148.50

React ✅ to KEEP, ❌ to EXIT
```

### 3. When Target/Stop Hit (Alerts)
```
✅ AAPL TAKE_PROFIT

Price: $158.60
P/L: +5.4%
```

---

## State Files (Auto-Managed)

These files track your trades automatically:

```
.swing-options-state.json       → Active trades (updated every 15 min)
.swing-options-journey.json     → Trade history + daily updates
.swing-options-stats.json       → Performance metrics
.swing-options-equity.json      → Equity curve
```

View your trades:
```bash
cat .swing-options-state.json | jq '.'
cat .swing-options-journey.json | jq '.trades[0]'
cat .swing-options-stats.json | jq '.'
```

---

## Technical Analysis (Automatic)

Your monitor analyzes every eligible stock on:

- **RSI (14-period)** — Oversold/overbought detection
- **Bollinger Bands (20-period)** — Mean reversion signals
- **ATR (14-period)** — Volatility and support/resistance
- **Volume** — Confirmation of moves
- **Support/Resistance** — Entry/exit levels

Scoring factors:
- Momentum (5-day trend)
- Volatility (1-day moves)
- Technical indicators alignment
- Support/resistance proximity

---

## Security Checklist

- [x] API credentials in `.env.production` (protected from git)
- [x] `.env.production` in `.gitignore` (no accidental commits)
- [x] Production environment (WEBULL_ENVIRONMENT=prod)
- [x] Order limits enforced ($5000 max per order)
- [x] Symbol whitelist configured (38 stocks)
- [x] Discord webhook secure (webhook URL only)
- [ ] **TODO:** Regenerate Discord credentials (you shared them)
- [ ] **TODO:** Rotate API credentials quarterly

### ⚠️ Action Required

**Regenerate your Discord credentials immediately:**
1. Go to Discord Developer Portal
2. Delete the current bot token
3. Generate a new bot token
4. Update `.env.production` with new token
5. Update webhook in Discord integrations

This prevents anyone with these credentials from accessing your trading channel.

---

## Next Steps

### Immediate (Today)
1. ✅ Credentials configured
2. ✅ Discord connected
3. ✅ All systems tested
4. **TODO:** Regenerate Discord credentials (security)
5. **TODO:** Start first trade (manual or PM2)

### Short Term (This Week)
1. Monitor your first few trades
2. Verify Discord notifications work
3. Check P/L tracking
4. Fine-tune symbol whitelist if needed

### Long Term (This Month)
1. Set up PM2 automation (recommended)
2. Deploy to VM if 24/7 trading wanted
3. Review performance metrics
4. Adjust risk limits based on results

---

## Troubleshooting

### Discord not posting?
```bash
# Test webhook manually
curl -X POST -H "Content-Type: application/json" \
  -d '{"content":"Test"}' \
  https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

### Webull connection issues?
```bash
# Check credentials in .env.production
cat .env.production | grep WEBULL

# Try with sandbox mode
sed -i 's/WEBULL_ENVIRONMENT=prod/WEBULL_ENVIRONMENT=uat/' .env.production
npm run start:webull
```

### Trades not logging?
```bash
# Check if state file is writable
ls -la .swing-options-state.json
cat .swing-options-state.json | jq '.'
```

---

## Files & Documentation

**Core Files:**
- `swing-options-tracker-webull.js` — Daily analysis & suggestion
- `swing-options-15min-monitor.js` — Real-time position monitoring
- `webull-integration.js` — Webull API wrapper

**Documentation:**
- `WEBULL_SETUP.md` — Complete Webull integration guide
- `REFACTOR_SUMMARY.md` — What changed from v1 to v2
- `SETUP_CHECKLIST.md` — Detailed setup instructions

**Configuration:**
- `.env.production` — Your credentials (protected by .gitignore)
- `package.json` — npm scripts

---

## Quick Commands Cheat Sheet

```bash
# Testing
npm run check                   # Verify syntax
TEST_MODE=true npm run start:webull
TEST_MODE=true npm run monitor:15min

# Manual run
npm run start:webull            # Generate trade suggestion
npm run monitor:15min           # Check positions

# PM2 management
pm2 start swing-options-tracker-webull.js --cron "45 15 * * 1-5"
pm2 start swing-options-15min-monitor.js --cron "*/15 9-16 * * 1-5"
pm2 logs swing-tracker
pm2 logs swing-monitor
pm2 monit
pm2 stop swing-tracker
pm2 delete swing-tracker

# Debugging
cat .swing-options-state.json | jq '.'
cat .swing-options-journey.json | jq '.trades[0]'
grep ERROR ~/.pm2/logs/*.log
```

---

## Summary

Your Swing Options Monitor v2.0 is **fully configured and ready to deploy**. 

Choose your deployment option:
- 🟢 **Manual:** Run commands as needed
- 🟡 **PM2:** Automated on your local machine
- 🔴 **Cloud VM:** 24/7 automated on a server

All trading logic, position monitoring, and Discord notifications are ready to use.

**Start trading:** `npm run start:webull`

---

**Deployed:** 2026-06-24
**Status:** ✅ PRODUCTION READY
**Version:** 2.0 (Webull Integration)
