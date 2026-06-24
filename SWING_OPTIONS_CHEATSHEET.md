# Swing Options Tracker - Command Cheat Sheet

## 🚀 Quick Deploy

```bash
cd ~/Thalaivas-Cricket-Team/stock-analysis-mcp
./deploy-swing-to-vm.sh
# Then follow prompts
```

## 🔧 On VM Commands

### Start/Restart Service
```bash
pm2 start swing-options-tracker
pm2 restart swing-options-tracker
pm2 reload ecosystem.config.js  # Reload all
pm2 stop swing-options-tracker
pm2 delete swing-options-tracker
```

### Monitor
```bash
pm2 list | grep swing              # Check status
pm2 show swing-options-tracker     # Details
pm2 logs swing-options-tracker     # Live logs
pm2 logs swing-options-tracker -e  # Errors only
tail -f ~/.pm2/logs/swing-options-tracker-out.log
```

### View Trades
```bash
cat /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.swing-options-state.json | jq .
cat /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.swing-options-state.json | jq '.trades[0]'  # Latest
cat /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.swing-options-state.json | jq '.trades | length'
```

### Configuration
```bash
nano /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.env.production
nano /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/ecosystem.config.js
pm2 save  # Save current config
```

### Test Service
```bash
cd /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp
npm run swing:options:once  # Run once
npm run swing:options:once 2>&1 | tail -10  # Show output
```

## 🏠 From Mac (Dev Machine)

### SSH to VM
```bash
ssh -i ~/Downloads/ssh-key-2026-06-06.key ubuntu@158.101.112.94
```

### Copy files
```bash
scp -i ~/Downloads/ssh-key-2026-06-06.key \
  src/swing-options-tracker.js \
  ubuntu@158.101.112.94:/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/src/
```

### Test locally
```bash
cd ~/Thalaivas-Cricket-Team/stock-analysis-mcp
npm run swing:options:once
```

### Check git status
```bash
cd ~/Thalaivas-Cricket-Team
git status
git log --oneline -5
```

## 📊 View Results

### Today's trade suggestion
```bash
# On VM:
cat .swing-options-state.json | jq '.trades[0]' | head -20
```

### P/L of all trades
```bash
# On VM:
cat .swing-options-state.json | jq '.trades[] | {symbol, entryPrice, currentPrice, pnlPercent, recommendation}'
```

### Active trades only
```bash
# On VM:
cat .swing-options-state.json | jq '.trades[] | select(.recommendation != "EXPIRED")'
```

## ⏰ Timing Reference

- **Runs at:** 3:45 PM ET (Mon-Fri)
- **UTC (summer):** 19:45 UTC (EDT)
- **UTC (winter):** 20:45 UTC (EST)
- **Next run:** Tomorrow at 3:45 PM ET

Check cron: `pm2 show swing-options-tracker | grep cron`

## 🔄 Update Service

1. Make changes locally
   ```bash
   nano src/swing-options-tracker.js
   npm run swing:options:once  # Test
   ```

2. Commit and push
   ```bash
   git add src/swing-options-tracker.js
   git commit -m "fix(swing-options): ..."
   git push origin master
   ```

3. Deploy to VM
   ```bash
   scp -i ~/Downloads/ssh-key-*.key src/swing-options-tracker.js \
     ubuntu@158.101.112.94:/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/src/
   ```

4. Restart on VM
   ```bash
   pm2 restart swing-options-tracker
   ```

## 🆘 Troubleshooting

### Service not in PM2 list
```bash
# Check if registered
pm2 list | grep swing

# If missing, reload config
cd /home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp
pm2 reload ecosystem.config.js
pm2 save
```

### No Discord posts
```bash
# Check webhook is set
grep SWING_OPTIONS_DISCORD_WEBHOOK .env.production

# Test webhook
curl -X POST -H "Content-Type: application/json" \
  -d '{"content":"Test","username":"Bot"}' \
  [WEBHOOK_URL]
```

### Wrong time on VM
```bash
date  # Check server time
timedatectl  # Check timezone (should be UTC)
```

If EST (winter) but running at EDT time:
```bash
nano ecosystem.config.js
# Change: cron_restart: "45 19 * * 1-5"  to  "45 20 * * 1-5"
pm2 reload ecosystem.config.js && pm2 save
```

### Stock data not fetching
```bash
# Test manually
npm run swing:options:once
# Check error log
tail -20 ~/.pm2/logs/swing-options-tracker-error.log
```

## 📌 Key Files

- **Service:** `/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/src/swing-options-tracker.js`
- **Config:** `/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/ecosystem.config.js`
- **Trades:** `/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.swing-options-state.json`
- **Env:** `/home/ubuntu/Thalaivas-Cricket-Team/stock-analysis-mcp/.env.production`
- **Logs:** `~/.pm2/logs/swing-options-tracker-*`

## 🎯 Trade Recommendations

Your Discord posts show:
- **HOLD** — Trade on track, keep open
- **SELL - Target reached** — Profit goal hit, close trade ✅
- **SELL 50% / HOLD 50%** — Halfway to target, take partial profit
- **SELL - Stop loss hit** — Loss limit hit, close trade ⛔
- **EXPIRED** — Trade past 5-day expiry, close if still open

## 🎓 Learn More

- **Quick start:** See `SWING_OPTIONS_QUICKSTART.md`
- **Full guide:** See `SWING_OPTIONS_SETUP.md`
- **Code:** `src/swing-options-tracker.js`
