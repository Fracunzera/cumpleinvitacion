#!/usr/bin/env bash
# Instala el backend OPCIONAL (confirmaciones + links cortos). Licencia MIT.
#
# Todo en el mismo VPS (lo más común), desde la carpeta del repo:
#   sudo bash extras/rsvp-server/instalar.sh
#
# Backend en otra máquina (por ejemplo, un server de casa conectado por VPN):
#   en el server de casa:  sudo HOST=10.8.0.2 bash extras/rsvp-server/instalar.sh --solo-servicio
#   en el VPS:             sudo BACKEND=10.8.0.2:8787 bash extras/rsvp-server/instalar.sh --solo-nginx
#
# Se puede correr de nuevo sin problema (por ejemplo, después de un git pull):
# conserva el token y la base de datos. La config del sitio en nginx
# (/etc/nginx/sites-available/invitacion) se reescribe entera, con backup en
# /root; si nginx -t falla, se deja la anterior.
set -euo pipefail

MODE="${1:-todo}"
case "$MODE" in todo|--solo-servicio|--solo-nginx) ;; *)
  echo "Uso: sudo bash $0 [--solo-servicio|--solo-nginx]" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "Correlo con sudo." >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
BACKEND="${BACKEND:-127.0.0.1:$PORT}"
ENV_FILE=/etc/invitacion-rsvp.env
UNIT=/etc/systemd/system/invitacion-rsvp.service
SNIPPET=/etc/nginx/snippets/invitacion-backend.conf
SITE_CONF="${SITE_CONF:-/etc/nginx/sites-available/invitacion}"

instalar_servicio() {
  command -v python3 >/dev/null || { echo "Falta python3 (sudo apt install python3)." >&2; exit 1; }
  id invitacion >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin invitacion
  mkdir -p /var/lib/invitacion
  chown invitacion /var/lib/invitacion

  if ! runuser -u invitacion -- test -r "$REPO/extras/rsvp-server/server.py"; then
    echo "El usuario 'invitacion' no puede leer $REPO." >&2
    echo "Cloná el repo en una carpeta accesible (por ejemplo /srv/invitacion) y corré el script desde ahí." >&2
    exit 1
  fi

  # Token y clave: se generan una sola vez y se conservan.
  local token secret
  token="$(sed -n 's/^RSVP_TOKEN=//p' "$ENV_FILE" 2>/dev/null || true)"
  secret="$(sed -n 's/^RSVP_SECRET=//p' "$ENV_FILE" 2>/dev/null || true)"
  [ -n "$token" ] || token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  [ -n "$secret" ] || secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  umask 077
  cat > "$ENV_FILE" <<EOF
RSVP_TOKEN=$token
RSVP_SECRET=$secret
RSVP_DB=/var/lib/invitacion/rsvp.sqlite3
SITE_ROOT=$REPO
HOST=$HOST
PORT=$PORT
# Días después de la fiesta en que se borra cada link corto
SHORT_DAYS=60
EOF
  umask 022

  cat > "$UNIT" <<EOF
[Unit]
Description=Invitacion de cumpleanos - backend opcional (RSVP y links cortos)
After=network-online.target
Wants=network-online.target

[Service]
User=invitacion
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env python3 $REPO/extras/rsvp-server/server.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/invitacion

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable invitacion-rsvp >/dev/null
  systemctl restart invitacion-rsvp

  local check_host="$HOST"
  [ "$check_host" = "0.0.0.0" ] && check_host=127.0.0.1
  local ok=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if python3 -c "import urllib.request,sys; sys.exit(0 if b'\"ok\"' in urllib.request.urlopen('http://$check_host:$PORT/api/s', timeout=2).read() else 1)" 2>/dev/null; then
      ok=1; break
    fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    echo "El servicio no responde en http://$check_host:$PORT. Mirá los logs con:" >&2
    echo "  sudo journalctl -u invitacion-rsvp -n 50" >&2
    exit 1
  fi
  echo "✓ Backend andando en http://$HOST:$PORT"
  echo "  Token para ver la lista de confirmados: $token  (guardado en $ENV_FILE)"
  if [ "$HOST" != "127.0.0.1" ]; then
    echo "  OJO: el puerto $PORT tiene que quedar accesible solo desde la VPN, no desde internet."
  fi
}

instalar_nginx() {
  command -v nginx >/dev/null || { echo "No encontré nginx en esta máquina." >&2; exit 1; }
  mkdir -p "$(dirname "$SNIPPET")"
  rm -f "$SNIPPET.anterior"
  [ -f "$SNIPPET" ] && cp "$SNIPPET" "$SNIPPET.anterior"
  cat > "$SNIPPET" <<EOF
# Generado por extras/rsvp-server/instalar.sh: backend opcional de la invitación.
# Va dentro del server { } del sitio, con: include snippets/invitacion-backend.conf;

# /api/rsvp (confirmaciones) y /api/s (links cortos)
location /api/ {
    proxy_pass http://$BACKEND;
    proxy_set_header X-Real-IP \$remote_addr;
    client_max_body_size 20k;
}

# Vista previa personalizada en WhatsApp para ?i= y ?s=
location = / {
    access_log off;   # no guardar los datos de la fiesta en los logs
    if (\$args ~ "(^|&)[is]=") {
        proxy_pass http://$BACKEND;
    }
    try_files /index.html =404;
}
EOF
  echo "✓ Config de nginx en $SNIPPET (backend: $BACKEND)"

  escribir_sitio
}

# Reescribe la config del sitio entera (con backup) para que incluya el
# snippet. Si nginx -t falla, vuelve a dejar la anterior.
escribir_sitio() {
  if [ ! -f "$SITE_CONF" ]; then
    cat <<EOF

No encontré $SITE_CONF. Agregá a mano esta línea dentro del server { } de tu
sitio (el que tiene "listen 443") y recargá nginx:
  include snippets/invitacion-backend.conf;
(o corré el script con SITE_CONF=/ruta/a/tu/config)
EOF
    return
  fi
  local domain
  domain="${DOMAIN:-$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^[:space:];]*\).*/\1/p' "$SITE_CONF" | head -1)}"
  [ -n "$domain" ] || { echo "No pude sacar el dominio de $SITE_CONF. Corré el script con DOMAIN=tu.dominio" >&2; exit 1; }

  local backup
  backup="/root/invitacion-nginx.$(date +%Y%m%d-%H%M%S).bak"
  cp "$SITE_CONF" "$backup"

  local le="/etc/letsencrypt/live/$domain"
  {
    echo "# Generado por extras/rsvp-server/instalar.sh. Backup de la versión anterior: $backup"
    echo "server {"
    echo "    server_name $domain;"
    echo "    root $REPO;"
    echo "    index index.html;"
    cat <<'EOF'

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        # no-cache = el navegador revalida siempre (304 si no cambió), así un deploy se ve al instante
        add_header Cache-Control "no-cache";
    }
    location ~ /\.(git|nojekyll) { deny all; }
    location /extras/ { deny all; }

    # Backend opcional: confirmaciones, links cortos y vista previa personalizada
    include snippets/invitacion-backend.conf;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Permissions-Policy "microphone=(self), camera=(), geolocation=()" always;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml;

EOF
    if [ -f "$le/fullchain.pem" ] && [ -f "$le/privkey.pem" ]; then
      echo "    listen 443 ssl; # managed by Certbot"
      echo "    ssl_certificate $le/fullchain.pem; # managed by Certbot"
      echo "    ssl_certificate_key $le/privkey.pem; # managed by Certbot"
      [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot"
      [ -f /etc/letsencrypt/ssl-dhparams.pem ] && echo "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot"
      echo "}"
      echo "server {"
      echo "    listen 80;"
      echo "    server_name $domain;"
      # shellcheck disable=SC2016  # $host es de nginx
      echo '    return 301 https://$host$request_uri;'
      echo "}"
    else
      echo "    listen 80;"
      echo "}"
    fi
  } > "$SITE_CONF.nuevo"
  mv "$SITE_CONF.nuevo" "$SITE_CONF"
  [ -e "/etc/nginx/sites-enabled/$(basename "$SITE_CONF")" ] || ln -s "$SITE_CONF" /etc/nginx/sites-enabled/

  if nginx -t 2>/tmp/invitacion-nginx-test.log; then
    systemctl reload nginx
    rm -f "$SNIPPET.anterior"
    echo "✓ Config de $domain reescrita y nginx recargado (backup: $backup)"
  else
    cp "$backup" "$SITE_CONF"
    if [ -f "$SNIPPET.anterior" ]; then mv "$SNIPPET.anterior" "$SNIPPET"; else rm -f "$SNIPPET"; fi
    echo "✗ nginx -t falló con la config nueva; dejé la anterior como estaba." >&2
    cat /tmp/invitacion-nginx-test.log >&2
    exit 1
  fi
}

[ "$MODE" = "--solo-nginx" ] || instalar_servicio
[ "$MODE" = "--solo-servicio" ] || instalar_nginx

echo
echo "Para probar:  curl https://TU-DOMINIO/api/s   → tiene que responder {\"ok\":true}"
echo "Después recargá el generador: debajo del link aparece «✂️ Acortar link»."
