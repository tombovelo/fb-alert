#!/usr/bin/env bash
# ------------------------------------------------------------------
# FB-Alert Tracker - installation du backend sur Ubuntu (systemd)
# Usage : depuis le dossier backend copie sur le serveur
#         bash deploy/install-ubuntu.sh
# Idempotent : peut etre relance.
# ------------------------------------------------------------------
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi
APP_USER="fbalert"
APP_PARENT="/opt/fb-alert"
APP_DIR="${APP_PARENT}/backend"
DB_NAME="fb_summarizer"
DB_USER="fbalert"
SERVICE_NAME="fb-alert-backend"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
PORT="${PORT:-4100}"

log() { printf '\n\033[1;32m=== %s ===\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$1"; }
die() { printf '\033[1;31m[ERREUR] %s\033[0m\n' "$1"; exit 1; }

log "1/8 Paquets systeme (PostgreSQL, Redis, outils)"
$SUDO apt-get update -y
$SUDO apt-get install -y curl ca-certificates gnupg build-essential rsync sudo \
  postgresql redis-server ufw

NODE_MAJOR="$( (node -v 2>/dev/null || echo v0) | sed 's/v\([0-9]*\).*/\1/' )"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  log "2/8 Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  log "2/8 Node.js deja present ($(node -v))"
fi

log "3/8 Utilisateur applicatif et dossier"
$SUDO useradd --system --home "${APP_PARENT}" --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null || true
CURRENT_DIR="$(pwd)"
TARGET_DIR="$(realpath "${APP_DIR}" 2>/dev/null || echo '')"
if [ "$(realpath "${CURRENT_DIR}")" != "${TARGET_DIR}" ]; then
  warn "Le dossier courant (${CURRENT_DIR}) n'est pas ${APP_DIR}."
  warn "Copie vers ${APP_DIR} (rsync)…"
  $SUDO mkdir -p "${APP_PARENT}"
  $SUDO rsync -a --exclude node_modules --exclude dist --exclude .git \
    "${CURRENT_DIR}/" "${APP_DIR}/"
fi
$SUDO chown -R "${APP_USER}:${APP_USER}" "${APP_PARENT}"

log "4/8 PostgreSQL : role + base"
$SUDO systemctl enable --now postgresql >/dev/null 2>&1 || true
$SUDO systemctl enable --now redis-server >/dev/null 2>&1 || true
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  read -r -s -p "Mot de passe PostgreSQL pour l'utilisateur '${DB_USER}' : " DB_PASS
  echo
  [ -n "${DB_PASS}" ] || die "Mot de passe vide."
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
else
  DB_PASS=""
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
fi
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" >/dev/null

log "5/8 Dependances Node et build"
cd "${APP_DIR}"
if [ ! -f .env ]; then
  cp .env.example .env
  warn "Fichier .env cree depuis .env.example : renseignez DATABASE_URL et les cles IA."
  warn "Base suggeree : postgresql://${DB_USER}:<mot de passe>@localhost:5432/${DB_NAME}?schema=public"
fi
if [ ! -f fb-storage-state.json ]; then
  warn "fb-storage-state.json absent : copiez la session Facebook (scp), sinon le scraping echouera."
fi
sudo -u "${APP_USER}" npm ci
sudo -u "${APP_USER}" npx prisma generate
sudo -u "${APP_USER}" npx prisma migrate deploy
sudo -u "${APP_USER}" npm run build

log "6/8 Chromium Playwright"
sudo -u "${APP_USER}" npx playwright install chromium
$SUDO npx playwright install-deps chromium >/dev/null 2>&1 || {
  $SUDO apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2t64 libasound2 libpango-1.0-0 libcairo2 \
    libx11-6 libxshmfence1 fonts-liberation >/dev/null || true
}

log "7/8 Service systemd"
$SUDO sed -e "s|User=.*|User=${APP_USER}|" \
          -e "s|Group=.*|Group=${APP_USER}|" \
          -e "s|WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
          -e "s|ExecStart=.*|ExecStart=/usr/bin/node ${APP_DIR}/dist/main|" \
          deploy/fb-alert-backend.service > "/tmp/${SERVICE_NAME}.service"
$SUDO mv "/tmp/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "${SERVICE_NAME}"

log "8/8 Pare-feu + verification"
if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow "${PORT}/tcp" >/dev/null
fi
sleep 4
if $SUDO systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "Service actif."
else
  $SUDO journalctl -u "${SERVICE_NAME}" -n 40 --no-pager || true
  die "Service non demarre (voir : journalctl -u ${SERVICE_NAME})."
fi
curl -s -o /dev/null -w "GET /api/posts -> HTTP %{http_code}\n" \
  "http://localhost:${PORT}/api/posts" || true

printf '\nInstallation terminee.\n'
printf '  Service    : sudo systemctl status %s\n' "${SERVICE_NAME}"
printf '  Logs       : journalctl -u %s -f\n' "${SERVICE_NAME}"
printf '  API        : http://<IP_SERVEUR>:%s/api\n' "${PORT}"
printf '  Mise a jour: apres recopie des sources -> bash deploy/update.sh\n\n'
