#!/usr/bin/env bash
# Instala Control de Asistencia como servicio en Debian/Ubuntu (p. ej. contenedor LXC de Proxmox).
# Uso (como root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/arturoretana-procesoseguro/ps-control-asistencia/main/deploy/instalar.sh)
set -euo pipefail

REPO="${REPO:-https://github.com/arturoretana-procesoseguro/ps-control-asistencia.git}"
APP_DIR=/opt/control-asistencia
DATA_DIR=/var/lib/control-asistencia
ENV_FILE=/etc/control-asistencia.env
PUERTO="${PUERTO:-8080}"

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta este script como root"; exit 1; }

echo "==> Zona horaria America/Mexico_City"
ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime
echo "America/Mexico_City" > /etc/timezone

echo "==> Paquetes base"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg >/dev/null

NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "==> Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    Node $(node -v)"

echo "==> Usuario del servicio"
id asistencia >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin asistencia

echo "==> Descargando la aplicación en $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main && git -C "$APP_DIR" reset -q --hard origin/main
else
  git clone -q "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund >/dev/null
mkdir -p "$DATA_DIR"
chown -R asistencia:asistencia "$DATA_DIR"

PASS_NUEVA=""
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Configuración en $ENV_FILE"
  if [ ! -f "$DATA_DIR/asistencia.db" ]; then PASS_NUEVA=$(node -e "process.stdout.write(require('crypto').randomBytes(9).toString('base64url'))"); fi
  cat > "$ENV_FILE" <<CFG
PORT=$PUERTO
TZ=America/Mexico_City
DATA_DIR=$DATA_DIR
ZK_SYNC_MIN=5
ODOO_SYNC_MIN=10
${PASS_NUEVA:+ADMIN_PASSWORD=$PASS_NUEVA}
CFG
  chmod 600 "$ENV_FILE"
fi

echo "==> Servicio systemd"
cat > /etc/systemd/system/control-asistencia.service <<UNIT
[Unit]
Description=Control de Asistencia (checadores ZKTeco/Hikvision, campo y Odoo)
After=network-online.target
Wants=network-online.target

[Service]
User=asistencia
Group=asistencia
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q control-asistencia
systemctl restart control-asistencia
sleep 3

IP=$(hostname -I | awk '{print $1}')
echo
if systemctl is-active -q control-asistencia; then
  echo "=============================================================="
  echo " ✅ Control de Asistencia instalado y en marcha"
  echo "    Abre:        http://$IP:$PUERTO"
  echo "    Usuario:     admin"
  if [ -n "$PASS_NUEVA" ]; then
  echo "    Contraseña:  $PASS_NUEVA   (cámbiala al entrar)"
  else
  echo "    Contraseña:  la que ya tenías"
  fi
  echo "    Datos en:    $DATA_DIR  (respáldalo con el backup de Proxmox)"
  echo "    Checadores:  usa la IP $IP y el puerto $PUERTO"
  echo "=============================================================="
else
  echo "❌ El servicio no arrancó. Revisa con:  journalctl -u control-asistencia -n 50"
  exit 1
fi
