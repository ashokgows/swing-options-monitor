# Swing Options Monitor

Daily swing options trade suggester with hourly monitoring for large/mega cap stocks.

## Features

- **Daily Trade Suggestions**: Analyzes 40+ stocks at 3:45 PM ET to find swing trading opportunities
- **Hourly Monitoring**: Tracks active trades every hour (9:30 AM - 4 PM ET) and alerts on price targets/stops
- **Technical Analysis**: RSI, ATR, Bollinger Bands, support/resistance confirmation
- **Greeks Auto-Update**: Daily updates to option Greeks for tracking
- **Equity Curve Tracking**: Detailed P&L monitoring with drawdown analysis
- **Discord Integration**: Real-time alerts and trade updates to Discord
- **Risk Management**: -5% weekly loss limit, backtesting support

## Quick Start

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Create `.env.production` file (copy from `.env.production.example`):
```bash
cp .env.production.example .env.production
# Edit .env.production and add your Discord webhook URL
```

3. Run the daily suggester:
```bash
npm run start:once
```

4. Run hourly monitor:
```bash
npm run monitor:once
```

### VM Deployment

1. Deploy to Oracle Cloud VM:
```bash
./deploy-swing-to-vm.sh [vm-user@vm-host] [key-path]
```

2. SSH into VM and complete setup:
```bash
ssh -i <key-path> ubuntu@158.101.112.94
cd /home/ubuntu/swing-options-monitor
npm install
nano .env.production  # Add Discord webhook
```

3. Register with PM2:
```bash
pm2 start swing-options-tracker.js --name swing-options --env-file .env.production
pm2 start swing-options-hourly-monitor.js --name swing-monitor --env-file .env.production
pm2 save
```

4. Monitor:
```bash
pm2 logs swing-options
```

## Scripts

- `npm run start` - Run daily suggester (continuous)
- `npm run start:once` - Run daily suggester once and exit
- `npm run monitor` - Run hourly monitor (continuous)
- `npm run monitor:once` - Run hourly monitor once and exit
- `npm run backtest` - Run backtesting
- `npm run check` - Syntax check all files

## Eligible Symbols

40+ large/mega cap stocks including: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, JPM, V, and more.

## State Files

- `.swing-options-state.json` - Current active trades
- `.swing-options-stats.json` - Performance statistics
- `.swing-options-equity.json` - Equity curve data
- `.swing-options-journey.json` - Trade journey log

## Documentation

- `SWING_OPTIONS_QUICKSTART.md` - Quick setup guide
- `SWING_OPTIONS_SETUP.md` - Detailed setup instructions
- `SWING_OPTIONS_CHEATSHEET.md` - Command reference

## Requirements

- Node.js 18+
- Discord webhook URL for alerts
- Internet connection for market data (Yahoo Finance)

## License

MIT
