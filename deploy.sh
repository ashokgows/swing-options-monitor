#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Manual deploy to GCP VM (push .env.production + restart)
#
# Usage:
#   ./deploy.sh <vm-ip>           (uses ~/.ssh/id_ed25519)
#   ./deploy.sh <vm-ip> <key>     (use custom key path)
#
# The GitHub Actions workflow handles code deploys automatically.
# Use this script only to:
#   • Sync .env.production secrets (not committed to git)
#   • Bootstrap a fresh VM
#   • Force restart without a git push
# ─────────────────────────────────────────────────────────────────────────────
set -e

VM_IP="${1:?Usage: ./deploy.sh <vm-ip> [ssh-key-path]}"
KEY="${2:-$HOME/.ssh/id_ed25519}"
VM_USER="ubuntu"
APP_DIR="/home/$VM_USER/swing-options-monitor"

SSH_OPTS="-i $KEY -o StrictHostKeyChecking=accept-new"

echo "🚀 Deploying to $VM_USER@$VM_IP ..."

# ── 1. Ensure setup script has been run ───────────────────────────────────────
echo "[1] Verifying app directory exists..."
ssh $SSH_OPTS "$VM_USER@$VM_IP" "[ -d '$APP_DIR' ] || echo 'NOT_FOUND'" | grep -q "NOT_FOUND" && {
  echo "   App not found — running bootstrap..."
  ssh $SSH_OPTS "$VM_USER@$VM_IP" \
    "curl -fsSL https://raw.githubusercontent.com/ashokgows/swing-options-monitor/main/scripts/setup-gcp-vm.sh | bash"
}

# ── 2. Push .env.production (secrets — never committed to git) ────────────────
if [ -f ".env.production" ]; then
  echo "[2] Uploading .env.production..."
  scp $SSH_OPTS .env.production "$VM_USER@$VM_IP:$APP_DIR/.env.production"
  echo "   ✅ .env.production uploaded"
else
  echo "[2] ⚠️  .env.production not found locally — skipping secrets upload"
fi

# ── 3. Pull latest code & restart ─────────────────────────────────────────────
echo "[3] Pulling code and restarting..."
ssh $SSH_OPTS "$VM_USER@$VM_IP" "
  set -e
  cd $APP_DIR
  git fetch origin main
  git reset --hard origin/main
  npm ci --omit=dev --quiet
  pm2 restart swing-options-bot --update-env || pm2 start ecosystem.config.js
  pm2 save
  pm2 list
  echo '✅ Done'
"

echo ""
echo "─────────────────────────────────────────────"
echo " ✅ Deploy complete"
echo " Logs: ssh $SSH_OPTS $VM_USER@$VM_IP 'pm2 logs swing-options-bot'"
echo "─────────────────────────────────────────────"
