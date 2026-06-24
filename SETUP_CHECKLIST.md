# Swing Options Monitor — Setup Checklist

## ✅ Completed

- [x] Webull API credentials configured (API Key + Secret)
- [x] `.env.production` created with placeholders
- [x] All syntax checks pass (`npm run check`)
- [x] Tracker test successful (generates sample AAPL CALL trade)
- [x] Monitor test successful (tracks active positions)
- [x] State files initialized:
  - `.swing-options-state.json` (active trades)
  - `.swing-options-journey.json` (trade history)
  - `.swing-options-stats.json` (performance)

## ⏳ TODO — Complete These to Go Live

### 1. Add Webull Account ID
**Status:** ❌ REQUIRED

Get your Webull Account ID:
1. Open Webull app on your phone
2. Go to **Settings → Account Info → Account Number**
3. Copy the account ID (looks like: `123456789`)
4. Update `.env.production`:
   ```bash
   WEBULL_ACCOUNT_ID=your_account_id_here
   ```

### 2. Add Discord Webhook URL
**Status:** ⏳ OPTIONAL (but recommended)

Get your Discord webhook:
1. Create a private Discord channel for trading alerts
2. Right-click channel → **Edit Channel → Integrations → Webhooks**
3. Click **New Webhook** → Copy the webhook URL
4. Update `.env.production`:
   ```bash
   SWING_OPTIONS_DISCORD_WEBHOOK=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
   ```

Test webhook:
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"content":"🎯 Test message from Swing Options Monitor"}' \
  https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

### 3. Test Real Webull Connection
**Status:** ⏳ READY

Once you update Account ID:
```bash
# Test tracker with real Webull data
npm run start:webull

# Test monitor
npm run monitor:15min
```

### 4. Install Webull MCP (if not already)
**Status:** ⏳ NEEDED

```bash
# Option A: Using uvx (recommended)
pip install webull-openapi-mcp

# Option B: Using Poetry/pip
pip install webull-openapi-mcp
```

Verify installation:
```bash
webull-openapi-mcp --version
```

### 5. Set Up PM2 for Automated Trading
**Status:** ⏳ OPTIONAL (for production)

Install PM2 globally:
```bash
npm install -g pm2
```

Register daily tracker (3:45 PM ET):
```bash
pm2 start swing-options-tracker-webull.js \
  --name swing-tracker \
  --env-file .env.production \
  --cron "45 15 * * 1-5"
```

Register 15-minute monitor:
```bash
pm2 start swing-options-15min-monitor.js \
  --name swing-monitor \
  --env-file .env.production \
  --cron "*/15 9-16 * * 1-5"
```

Save configuration:
```bash
pm2 save
```

Monitor:
```bash
pm2 logs swing-tracker    # Watch daily tracker
pm2 logs swing-monitor    # Watch 15-min monitor
pm2 monit                 # Dashboard
```

### 6. (Optional) Deploy to VM
**Status:** ⏳ OPTIONAL (for always-on automation)

If you want 24/7 trading on a cloud VM:

```bash
# Deploy to Oracle Cloud / AWS
./deploy-swing-to-vm.sh ubuntu@your-vm-ip /path/to/ssh-key.pem

# SSH into VM
ssh -i /path/to/ssh-key.pem ubuntu@your-vm-ip

# Complete setup on VM
cd swing-options-monitor
npm install
pip install webull-openapi-mcp
nano .env.production  # Update credentials

# Register with PM2 on VM
pm2 start swing-options-tracker-webull.js --cron "45 15 * * 1-5"
pm2 start swing-options-15min-monitor.js --cron "*/15 9-16 * * 1-5"
pm2 save
```

## 📋 Testing Levels

### Level 1: Basic Test (No Real Data)
```bash
TEST_MODE=true npm run start:webull
TEST_MODE=true npm run monitor:15min
```
✅ **Current Status:** PASSED

### Level 2: Webull Connection Test
```bash
# After adding WEBULL_ACCOUNT_ID:
npm run start:webull
npm run monitor:15min
```
⏳ **Status:** Ready once you add Account ID

### Level 3: Full Integration Test
```bash
# With Discord webhook:
npm run start:webull
npm run monitor:15min
# Check Discord for alerts
```
⏳ **Status:** Ready once you add Discord webhook

### Level 4: Production Automation
```bash
pm2 start swing-options-tracker-webull.js --cron "45 15 * * 1-5"
pm2 start swing-options-15min-monitor.js --cron "*/15 9-16 * * 1-5"
```
⏳ **Status:** Ready once PM2 configured

## 🔐 Security Checklist

- [x] API credentials in `.env.production` (not in code)
- [x] `.env.production` added to `.gitignore` ✓
- [ ] Webull sandbox mode test (`WEBULL_ENVIRONMENT=uat`)
- [ ] Order limits set (`WEBULL_MAX_ORDER_*`)
- [ ] Symbol whitelist configured
- [ ] Discord webhook secured (private channel only)
- [ ] Credentials rotated quarterly

## 📊 Current State

**Active Trades:** 1 (AAPL CALL - test only)
**Performance:** No live trades yet
**Last Update:** 2026-06-24 12:53 ET
**Syntax Status:** ✅ All pass

## 🚀 Next Immediate Steps

1. **Find your Webull Account ID** (5 min)
   - Webull app → Settings → Account Number
   - Update `.env.production`

2. **Test real Webull connection** (2 min)
   ```bash
   npm run start:webull
   ```

3. **(Optional) Add Discord webhook** (10 min)
   - Create Discord channel
   - Get webhook URL
   - Update `.env.production`

4. **(Optional) Set up PM2 automation** (15 min)
   - `npm install -g pm2`
   - Register cron jobs
   - `pm2 save`

## 📞 Support

- **Webull Setup Issues:** See `WEBULL_SETUP.md`
- **Code Issues:** See `REFACTOR_SUMMARY.md`
- **API Reference:** https://developer.webull.com/apis/docs/
- **MCP Documentation:** https://github.com/webull-inc/webull-openapi-mcp

## Quick Commands Reference

```bash
# Check syntax
npm run check

# Test mode (no API calls)
TEST_MODE=true npm run start:webull
TEST_MODE=true npm run monitor:15min

# Real mode (calls Webull API)
npm run start:webull
npm run monitor:15min

# View state
cat .swing-options-state.json | jq '.'
cat .swing-options-journey.json | jq '.trades[0]'

# Clear test data
rm -f .swing-options-state.json .swing-options-journey.json

# Edit env (IMPORTANT: .gitignore prevents accidental commit)
nano .env.production
```

---

**Setup Date:** 2026-06-24
**Version:** 2.0 (Webull Integration)
**Status:** ✅ Ready for Webull Account ID
