#!/usr/bin/env bash
# ------------------------------------------------------------------
# FB-Alert Tracker - mise a jour apres recopie des sources
# Usage : bash deploy/update.sh   (depuis le dossier backend du serveur)
# ------------------------------------------------------------------
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi
SERVICE_NAME="fb-alert-backend"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${DIR}"

echo "=== npm ci ==="
npm ci
echo "=== prisma generate ==="
npx prisma generate
echo "=== prisma migrate deploy ==="
npx prisma migrate deploy
echo "=== build ==="
npm run build
echo "=== redemarrage du service ==="
$SUDO systemctl restart "${SERVICE_NAME}"
sleep 3
if $SUDO systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "Service actif."
else
  $SUDO journalctl -u "${SERVICE_NAME}" -n 40 --no-pager || true
  exit 1
fi
$SUDO journalctl -u "${SERVICE_NAME}" -n 15 --no-pager
