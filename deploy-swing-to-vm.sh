#!/bin/bash

# Deploy swing-options-monitor to Oracle VM
# Usage: ./deploy-swing-to-vm.sh [vm-user@vm-host] [key-path]

VM_TARGET="${1:-ubuntu@158.101.112.94}"
KEY_PATH="${2:-$HOME/Downloads/ssh-key-2026-06-06.key}"
APP_DIR="/home/ubuntu/swing-options-monitor"

echo "🚀 Deploying swing-options-monitor to $VM_TARGET..."
echo "Using key: $KEY_PATH"

# Check if key exists
if [ ! -f "$KEY_PATH" ]; then
    echo "❌ SSH key not found: $KEY_PATH"
    exit 1
fi

# Deploy all source files
echo "📝 Deploying swing-options services..."
scp -i "$KEY_PATH" \
    "swing-options-tracker.js" \
    "swing-options-hourly-monitor.js" \
    "swing-options-backtest.js" \
    "$VM_TARGET:$APP_DIR/" || exit 1

# Deploy package.json and .gitignore
echo "📝 Deploying package.json..."
scp -i "$KEY_PATH" \
    "package.json" \
    ".gitignore" \
    "$VM_TARGET:$APP_DIR/" || exit 1

echo "✅ Files deployed successfully"

echo ""
echo "⚙️  Now you need to:"
echo "1. SSH to the VM:"
echo "   ssh -i $KEY_PATH $VM_TARGET"
echo ""
echo "2. Install dependencies (if not already installed):"
echo "   cd $APP_DIR"
echo "   npm install"
echo ""
echo "3. Configure Discord webhook in .env.production:"
echo "   nano $APP_DIR/.env.production"
echo "   Add: SWING_OPTIONS_DISCORD_WEBHOOK=https://discord.com/api/webhooks/..."
echo ""
echo "4. Add PM2 process to ecosystem.config.js (or manual start):"
echo "   # For PM2:"
echo "   pm2 start swing-options-tracker.js --name swing-options --env-file .env.production"
echo "   pm2 start swing-options-hourly-monitor.js --name swing-monitor --env-file .env.production"
echo "   pm2 save"
echo ""
echo "5. Test the service:"
echo "   npm run start:once"
echo ""
echo "6. Monitor:"
echo "   pm2 logs swing-options"
echo ""
