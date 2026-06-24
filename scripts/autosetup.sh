#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# autosetup.sh  — Zero-to-live on GCP e2-micro (always-free tier)
#
# What this does (fully automatic):
#   1.  Installs gcloud CLI (macOS native installer, no brew needed)
#   2.  Opens browser for Google sign-in (one click — unavoidable)
#   3.  Creates / selects a GCP project
#   4.  Enables Compute Engine API
#   5.  Creates an e2-micro VM in us-central1 (free-tier region)
#   6.  Adds your SSH key to the VM
#   7.  Installs Node.js 20, PM2, clones repo, starts the bot
#   8.  Uploads .env.production (secrets never touch git)
#   9.  Adds GitHub Secrets so every `git push` auto-deploys
#
# Usage (from the repo root):
#   bash scripts/autosetup.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── CONFIG ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/ashokgows/swing-options-monitor.git"
GITHUB_REPO="ashokgows/swing-options-monitor"   # owner/repo  (for gh secrets)
VM_NAME="swing-options-bot"
VM_ZONE="us-central1-a"       # one of the three always-free GCP zones
VM_MACHINE="e2-micro"          # always-free machine type
VM_IMAGE="ubuntu-2204-lts"
VM_IMAGE_PROJECT="ubuntu-os-cloud"
VM_DISK_SIZE="20GB"
VM_DISK_TYPE="pd-standard"
VM_USER="ubuntu"
APP_DIR="/home/$VM_USER/swing-options-monitor"
SSH_KEY="$HOME/.ssh/id_rsa"
SSH_PUB_KEY="${SSH_KEY}.pub"
GCLOUD_SDK_DIR="$HOME/google-cloud-sdk"
ENV_FILE="$(pwd)/.env.production"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step()  { echo; echo -e "${GREEN}───────────────────────────────────────────────${NC}"; echo -e "${GREEN} $*${NC}"; echo -e "${GREEN}───────────────────────────────────────────────${NC}"; }

# ── VALIDATE .env.production ──────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  error ".env.production not found in $(pwd). Cannot continue without credentials."
fi
# Check required keys are filled in
for KEY in DISCORD_BOT_TOKEN DISCORD_CHANNEL_ID WEBULL_APP_KEY WEBULL_APP_SECRET WEBULL_ACCOUNT_ID; do
  if ! grep -q "^${KEY}=" "$ENV_FILE" || grep -q "^${KEY}=your_" "$ENV_FILE"; then
    error "$KEY missing or placeholder in .env.production. Fill it in first."
  fi
done
info ".env.production OK"

# ── STEP 1: Install gcloud CLI ────────────────────────────────────────────────
step "1/8  Installing gcloud CLI"
if command -v gcloud &>/dev/null; then
  info "gcloud already installed: $(gcloud version 2>/dev/null | head -1)"
else
  GCLOUD_PKG="google-cloud-cli-darwin-x86_64.tar.gz"
  if [[ "$(uname -m)" == "arm64" ]]; then
    GCLOUD_PKG="google-cloud-cli-darwin-arm.tar.gz"
  fi
  warn "Downloading gcloud CLI (~150 MB)..."
  curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/${GCLOUD_PKG}" \
    -o "/tmp/${GCLOUD_PKG}"
  tar -xzf "/tmp/${GCLOUD_PKG}" -C "$HOME"
  "$GCLOUD_SDK_DIR/install.sh" --quiet --usage-reporting=false
  # Add to current PATH without needing shell restart
  export PATH="$GCLOUD_SDK_DIR/bin:$PATH"
  info "gcloud installed"
fi
# Ensure gcloud is on PATH for this session
export PATH="$GCLOUD_SDK_DIR/bin:$PATH"

# ── STEP 2: Authenticate ──────────────────────────────────────────────────────
step "2/8  Google authentication"
if gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q "@"; then
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1)
  info "Already signed in as: $ACCOUNT"
else
  warn "Opening browser for Google sign-in (one click required)..."
  gcloud auth login --update-adc --quiet
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1)
  info "Signed in as: $ACCOUNT"
fi

# ── STEP 3: Project ───────────────────────────────────────────────────────────
step "3/8  GCP project"
EXISTING_PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [ -n "$EXISTING_PROJECT" ]; then
  PROJECT_ID="$EXISTING_PROJECT"
  info "Using existing project: $PROJECT_ID"
else
  PROJECT_ID="swing-options-$(date +%s)"
  warn "Creating project: $PROJECT_ID"
  gcloud projects create "$PROJECT_ID" --quiet

  # Link billing — required for Compute Engine even on free tier
  warn "Checking billing account..."
  BILLING_ACCOUNT=$(gcloud billing accounts list --format="value(name)" --filter="open=true" 2>/dev/null | head -1 || true)
  if [ -z "$BILLING_ACCOUNT" ]; then
    warn "No billing account found."
    echo
    echo "  GCP requires a billing account even for free-tier VMs (no charge applies)."
    echo "  Please open this URL, add a credit card (will NOT be charged), then press Enter:"
    echo "  → https://console.cloud.google.com/billing?project=${PROJECT_ID}"
    read -r -p "  Press Enter once billing is set up..."
    BILLING_ACCOUNT=$(gcloud billing accounts list --format="value(name)" --filter="open=true" | head -1)
  fi
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" --quiet
  gcloud config set project "$PROJECT_ID"
  info "Project created and billing linked: $PROJECT_ID"
fi

# ── STEP 4: Enable Compute Engine API ────────────────────────────────────────
step "4/8  Enabling APIs (takes ~30 s)"
gcloud services enable compute.googleapis.com --quiet
info "Compute Engine API enabled"

# ── STEP 5: SSH key ───────────────────────────────────────────────────────────
step "5/8  SSH key"
if [ ! -f "$SSH_KEY" ]; then
  warn "Generating SSH key at $SSH_KEY..."
  ssh-keygen -t rsa -b 4096 -N "" -f "$SSH_KEY" -C "swing-options-bot@gcp" -q
fi
info "SSH key: $SSH_PUB_KEY"

# ── STEP 6: Create VM ─────────────────────────────────────────────────────────
step "6/8  Creating VM ($VM_MACHINE in $VM_ZONE — free forever)"
if gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" --quiet &>/dev/null; then
  warn "VM '$VM_NAME' already exists — skipping creation"
else
  PUB_KEY_CONTENT="${VM_USER}:$(cat "$SSH_PUB_KEY")"
  gcloud compute instances create "$VM_NAME" \
    --zone="$VM_ZONE" \
    --machine-type="$VM_MACHINE" \
    --image-family="$VM_IMAGE" \
    --image-project="$VM_IMAGE_PROJECT" \
    --boot-disk-size="$VM_DISK_SIZE" \
    --boot-disk-type="$VM_DISK_TYPE" \
    --no-address \
    --metadata="ssh-keys=${PUB_KEY_CONTENT}" \
    --tags=swing-options-bot \
    --quiet
  info "VM created"
fi

# Get VM's external IP (GCP gives an ephemeral IP; we'll use IAP tunnel for SSH)
VM_IP=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$VM_ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || true)

# If no external IP (--no-address), enable IAP SSH
if [ -z "$VM_IP" ]; then
  warn "No external IP — using IAP SSH tunnel"
  gcloud compute firewall-rules create allow-ssh-iap \
    --direction=INGRESS --priority=1000 \
    --network=default --action=ALLOW \
    --rules=tcp:22 --source-ranges=35.235.240.0/20 \
    --quiet 2>/dev/null || true
  USE_IAP="true"
else
  USE_IAP="false"
fi

info "VM is ready"

# ── SSH helper ────────────────────────────────────────────────────────────────
vm_ssh() {
  if [ "$USE_IAP" = "true" ]; then
    gcloud compute ssh "${VM_USER}@${VM_NAME}" \
      --zone="$VM_ZONE" --tunnel-through-iap \
      --ssh-key-file="$SSH_KEY" --quiet \
      -- "$@"
  else
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "${VM_USER}@${VM_IP}" "$@"
  fi
}

vm_scp() {
  local src="$1" dst="$2"
  if [ "$USE_IAP" = "true" ]; then
    gcloud compute scp "$src" "${VM_USER}@${VM_NAME}:${dst}" \
      --zone="$VM_ZONE" --tunnel-through-iap \
      --ssh-key-file="$SSH_KEY" --quiet
  else
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=no "$src" "${VM_USER}@${VM_IP}:${dst}"
  fi
}

# Wait for SSH to be ready
echo -n "   Waiting for VM SSH..."
for i in $(seq 1 24); do
  if vm_ssh "echo ok" &>/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 5
done

# ── STEP 7: Bootstrap VM ─────────────────────────────────────────────────────
step "7/8  Bootstrapping VM (Node.js, PM2, repo, systemd)"
vm_ssh "bash" <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive

echo "[boot] Installing system deps..."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl

echo "[boot] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
sudo apt-get install -y -qq nodejs

echo "[boot] Installing PM2..."
sudo npm install -g pm2 --quiet

echo "[boot] Cloning repo..."
if [ -d "$HOME/swing-options-monitor/.git" ]; then
  git -C "$HOME/swing-options-monitor" pull --ff-only
else
  git clone https://github.com/ashokgows/swing-options-monitor.git "$HOME/swing-options-monitor"
fi

echo "[boot] npm install..."
cd "$HOME/swing-options-monitor"
npm ci --omit=dev --quiet
mkdir -p logs

echo "[boot] Registering PM2 startup..."
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu --silent > /dev/null 2>&1 || true

echo "[boot] Done"
node -v && npm -v && pm2 -v
REMOTE
info "VM bootstrapped"

# ── STEP 8: Upload secrets + start bot ───────────────────────────────────────
step "8/8  Uploading .env.production and starting the bot"
vm_scp "$ENV_FILE" "$APP_DIR/.env.production"
info ".env.production uploaded"

vm_ssh "
  set -e
  cd $APP_DIR
  pm2 start ecosystem.config.js || pm2 restart swing-options-bot
  pm2 save
  pm2 list
"
info "Bot is live on the VM"

# ── OPTIONAL: Add GitHub Secrets for auto-deploy ─────────────────────────────
step "Bonus  Wiring up GitHub Actions auto-deploy"
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  PRIVATE_KEY_CONTENT=$(cat "$SSH_KEY")

  if [ "$USE_IAP" = "true" ]; then
    VM_HOST_SECRET="$VM_NAME"
    VM_USER_SECRET="$VM_USER"
    warn "IAP mode: GitHub Actions deploys via 'gcloud compute ssh'. Skipping SSH secrets (manual setup needed)."
  else
    gh secret set GCP_VM_HOST         -b "$VM_IP"               -R "$GITHUB_REPO" 2>/dev/null || true
    gh secret set GCP_VM_USER         -b "$VM_USER"             -R "$GITHUB_REPO" 2>/dev/null || true
    gh secret set GCP_SSH_PRIVATE_KEY -b "$PRIVATE_KEY_CONTENT" -R "$GITHUB_REPO" 2>/dev/null || true
    info "GitHub Secrets set: GCP_VM_HOST, GCP_VM_USER, GCP_SSH_PRIVATE_KEY"
    info "Every 'git push main' will now auto-deploy in ~30 s"
  fi
else
  warn "gh CLI not installed or not authenticated — skipping GitHub Secrets."
  warn "Set these secrets manually at https://github.com/${GITHUB_REPO}/settings/secrets/actions :"
  warn "  GCP_VM_HOST         = ${VM_IP:-<vm-ip>}"
  warn "  GCP_VM_USER         = $VM_USER"
  warn "  GCP_SSH_PRIVATE_KEY = (content of $SSH_KEY)"
fi

# ── SUMMARY ───────────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅  Swing Options Bot is LIVE${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo "  VM:       $VM_NAME ($VM_ZONE) — GCP e2-micro [FREE forever]"
[ -n "$VM_IP" ] && echo "  IP:       $VM_IP"
echo "  Bot:      running via PM2 (auto-restarts, survives reboots)"
echo
echo "  Useful commands:"
echo "  ─────────────────────────────────────────────────"
if [ "$USE_IAP" = "true" ]; then
  echo "  SSH:      gcloud compute ssh ubuntu@$VM_NAME --zone=$VM_ZONE --tunnel-through-iap"
else
  echo "  SSH:      ssh -i $SSH_KEY ubuntu@$VM_IP"
fi
echo "  Logs:     pm2 logs swing-options-bot"
echo "  Restart:  pm2 restart swing-options-bot"
echo "  Status:   pm2 list"
echo
echo "  Deploy code changes:  git push origin main  (auto via GitHub Actions)"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
