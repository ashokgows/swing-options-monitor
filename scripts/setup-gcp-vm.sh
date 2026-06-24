#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-gcp-vm.sh — One-shot bootstrap for a fresh GCP e2-micro (Ubuntu 22.04)
#
# Run this ONCE on the new VM:
#   curl -fsSL https://raw.githubusercontent.com/ashokgows/swing-options-monitor/main/scripts/setup-gcp-vm.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/ashokgows/swing-options-monitor.git"
APP_DIR="$HOME/swing-options-monitor"
NODE_VERSION="20"

echo "───────────────────────────────────────────────"
echo " Swing Options Bot — GCP VM Setup"
echo "───────────────────────────────────────────────"

# ── 1. System packages ────────────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl unzip

# ── 2. Node.js via NodeSource ─────────────────────────────────────────────────
echo "[2/7] Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash - > /dev/null 2>&1
sudo apt-get install -y -qq nodejs
echo "   Node: $(node -v)  npm: $(npm -v)"

# ── 3. PM2 process manager ────────────────────────────────────────────────────
echo "[3/7] Installing PM2..."
sudo npm install -g pm2 --quiet

# ── 4. Clone repo ────────────────────────────────────────────────────────────
echo "[4/7] Cloning repo..."
if [ -d "$APP_DIR/.git" ]; then
  echo "   Repo already exists — pulling latest..."
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

# ── 5. Install dependencies ───────────────────────────────────────────────────
echo "[5/7] Installing npm dependencies..."
cd "$APP_DIR"
npm ci --omit=dev --quiet
mkdir -p logs

# ── 6. Create .env.production from template if not present ───────────────────
echo "[6/7] Checking .env.production..."
if [ ! -f "$APP_DIR/.env.production" ]; then
  cp "$APP_DIR/.env.production.example" "$APP_DIR/.env.production"
  echo ""
  echo "   ⚠️  .env.production created from example."
  echo "   FILL IN YOUR REAL CREDENTIALS before starting the bot:"
  echo "   nano $APP_DIR/.env.production"
  echo ""
  NEED_ENV=true
fi

# ── 7. Register PM2 with system startup ──────────────────────────────────────
echo "[7/7] Registering PM2 startup service..."
pm2_startup=$(pm2 startup systemd -u $USER --hp $HOME 2>&1 | grep 'sudo env' | tr -d '\n')
if [ -n "$pm2_startup" ]; then
  eval "$pm2_startup" > /dev/null 2>&1 || true
fi

echo ""
echo "───────────────────────────────────────────────"
echo " ✅ Setup complete!"
echo "───────────────────────────────────────────────"
echo ""
if [ "$NEED_ENV" = "true" ]; then
  echo " NEXT STEP — add your credentials:"
  echo "   nano $APP_DIR/.env.production"
  echo ""
  echo " Then start the bot:"
  echo "   cd $APP_DIR && pm2 start ecosystem.config.js && pm2 save"
else
  echo " Start the bot:"
  echo "   cd $APP_DIR && pm2 start ecosystem.config.js && pm2 save"
fi
echo ""
echo " Useful commands:"
echo "   pm2 status                  — process list"
echo "   pm2 logs swing-options-bot  — live logs"
echo "   pm2 restart swing-options-bot"
echo "   pm2 stop swing-options-bot"
