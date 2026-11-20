#!/usr/bin/env bash
# Actualiza Control de Asistencia a la última versión de GitHub y reinicia el servicio.
# Uso (como root):  bash /opt/control-asistencia/deploy/actualizar.sh
set -euo pipefail
APP_DIR=/opt/control-asistencia
cd "$APP_DIR"
ANTES=$(git rev-parse --short HEAD)
git fetch -q origin main
git reset -q --hard origin/main
npm ci --omit=dev --no-audit --no-fund >/dev/null
systemctl restart control-asistencia
sleep 3
DESPUES=$(git rev-parse --short HEAD)
systemctl is-active -q control-asistencia \
  && echo "✅ Actualizado de $ANTES a $DESPUES: $(git log -1 --format=%s)" \
  || { echo "❌ El servicio no arrancó. Revisa: journalctl -u control-asistencia -n 50"; exit 1; }
