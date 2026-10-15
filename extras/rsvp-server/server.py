#!/usr/bin/env python3
"""
Backend OPCIONAL para la invitación de cumpleaños. Licencia MIT.

El sitio funciona 100% sin esto. Sirve para dos cosas extra en tu VPS:

  1. Lista de confirmados: POST /api/rsvp guarda cada confirmación en SQLite y
     GET /api/rsvp?event=<id>&token=<RSVP_TOKEN> muestra la lista.
     Anti-spam propio ("No soy un robot"), sin servicios externos:
     GET /api/rsvp/challenge entrega un desafío firmado con HMAC y el navegador
     tiene que resolver una prueba de trabajo (SHA-256 con N bits en cero)
     antes de confirmar. Cada desafío vence y sirve una sola vez. Además hay
     un campo trampa (honeypot) y un límite de envíos por IP.
  2. Vista previa personalizada (modo ?i=): GET /?i=<datos> devuelve index.html
     con og:title / og:description armados con el nombre y la fecha.
     OJO: con ?i= los datos SÍ llegan al servidor y quedan en los logs.

Solo usa la biblioteca estándar de Python 3.8+. Sin dependencias.

Variables de entorno:
  RSVP_TOKEN   (obligatoria) clave para ver la lista de confirmados
  RSVP_DB      ruta de la base SQLite        (default: ./rsvp.sqlite3)
  SITE_ROOT    carpeta donde está index.html (default: ../..)
  HOST / PORT  dónde escuchar                (default: 127.0.0.1:8787)
  RSVP_POW_BITS  dificultad del desafío      (default: 17, ~1 s en un celular)
  RSVP_SECRET    clave para firmar desafíos  (default: aleatoria al iniciar)
"""
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = os.environ.get("RSVP_TOKEN", "")
DB_PATH = os.environ.get("RSVP_DB", os.path.join(HERE, "rsvp.sqlite3"))
SITE_ROOT = os.environ.get("SITE_ROOT", os.path.normpath(os.path.join(HERE, "..", "..")))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))

POW_BITS = max(8, min(26, int(os.environ.get("RSVP_POW_BITS", "17"))))
SECRET = os.environ.get("RSVP_SECRET", "").encode("utf-8") or os.urandom(32)
CHALLENGE_TTL = 600  # segundos
USED = {}  # desafíos ya usados: salt -> vencimiento

MAX_BODY = 4096
RATE = {}  # ip -> [timestamps]
RATE_LIMIT = 10  # confirmaciones por IP cada 10 minutos


def db():
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """CREATE TABLE IF NOT EXISTS rsvp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event TEXT NOT NULL,
            name TEXT NOT NULL,
            count INTEGER NOT NULL,
            going INTEGER NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"""
    )
    con.execute("CREATE INDEX IF NOT EXISTS rsvp_event ON rsvp(event)")
    return con


def rate_limited(ip, kind="rsvp", limit=RATE_LIMIT):
    now = time.time()
    key = (kind, ip)
    hits = [t for t in RATE.get(key, []) if now - t < 600]
    RATE[key] = hits
    if len(hits) >= limit:
        return True
    hits.append(now)
    return False


def sign(salt, bits):
    return hmac.new(SECRET, ("%s|%d" % (salt, bits)).encode("utf-8"), hashlib.sha256).hexdigest()


def new_challenge():
    salt = "%s.%d" % (secrets.token_hex(12), int(time.time()) + CHALLENGE_TTL)
    return {"alg": "SHA-256", "salt": salt, "bits": POW_BITS, "sig": sign(salt, POW_BITS)}


def verify_pow(pow_):
    """True si la prueba de trabajo es válida, está vigente y no se usó antes."""
    if not isinstance(pow_, dict):
        return False
    salt, bits, sig, nonce = (str(pow_.get(k, "")) for k in ("salt", "bits", "sig", "nonce"))
    m = re.fullmatch(r"[0-9a-f]{24}\.(\d{10})", salt)
    if not m or not bits.isdigit() or int(bits) != POW_BITS or not re.fullmatch(r"\d{1,10}", nonce):
        return False
    now = time.time()
    if int(m.group(1)) < now or not hmac.compare_digest(sig, sign(salt, POW_BITS)):
        return False
    for k in [k for k, exp in USED.items() if exp < now]:
        del USED[k]
    if salt in USED:
        return False
    digest = hashlib.sha256(("%s:%s" % (salt, nonce)).encode("ascii")).digest()
    if int.from_bytes(digest, "big") >> (256 - POW_BITS) != 0:
        return False
    USED[salt] = int(m.group(1))
    return True


def decode_invite(raw):
    s = raw.strip().replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    data = json.loads(base64.b64decode(s).decode("utf-8"))
    return data if isinstance(data, dict) else {}


class Handler(BaseHTTPRequestHandler):
    server_version = "invitacion-rsvp"

    def client_ip(self):
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def send(self, status, body, ctype="application/json; charset=utf-8"):
        payload = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        # No logueamos la query string (puede tener datos de la fiesta).
        print("%s %s %s" % (self.client_ip(), self.command, urlparse(self.path).path))

    # ---- POST /api/rsvp ----
    def do_POST(self):
        if urlparse(self.path).path != "/api/rsvp":
            return self.send(404, '{"error":"not found"}')
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send(413, '{"error":"too large"}')
        if rate_limited(self.client_ip()):
            return self.send(429, '{"error":"too many requests"}')
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            event = str(data.get("event", ""))
            name = str(data.get("name", "")).strip()[:60]
            count = max(1, min(30, int(data.get("count", 1))))
            going = 1 if data.get("going", True) else 0
            note = str(data.get("note", ""))[:300]
            honeypot = str(data.get("website", ""))
            pow_ = data.get("pow")
        except (ValueError, TypeError, AttributeError):
            return self.send(400, '{"error":"bad request"}')
        if honeypot:
            return self.send(400, '{"error":"bad request"}')
        if not verify_pow(pow_):
            return self.send(403, '{"error":"challenge failed"}')
        if not re.fullmatch(r"[0-9a-f]{8}", event) or not name:
            return self.send(400, '{"error":"bad request"}')
        with db() as con:
            con.execute(
                "INSERT INTO rsvp(event, name, count, going, note) VALUES (?,?,?,?,?)",
                (event, name, count, going, note),
            )
        return self.send(201, '{"ok":true}')

    # ---- GET ----
    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/api/rsvp/challenge":
            if rate_limited(self.client_ip(), "challenge", 30):
                return self.send(429, '{"error":"too many requests"}')
            return self.send(200, json.dumps(new_challenge()))
        if url.path == "/api/rsvp":
            return self.list_rsvps(q)
        if url.path in ("/", "/index.html"):
            return self.index_with_preview(q)
        return self.send(404, '{"error":"not found"}')

    def list_rsvps(self, q):
        token = (q.get("token") or [""])[0]
        if not TOKEN or not hmac.compare_digest(token, TOKEN):
            return self.send(403, '{"error":"forbidden"}')
        event = (q.get("event") or [""])[0]
        with db() as con:
            if event:
                rows = con.execute(
                    "SELECT name, count, going, note, created_at FROM rsvp WHERE event=? ORDER BY id",
                    (event,),
                ).fetchall()
            else:
                rows = con.execute(
                    "SELECT event, COUNT(*), SUM(CASE WHEN going THEN count ELSE 0 END), MAX(created_at) "
                    "FROM rsvp GROUP BY event ORDER BY 4 DESC"
                ).fetchall()
        if (q.get("format") or [""])[0] == "json":
            return self.send(200, json.dumps(rows, ensure_ascii=False))
        esc = html.escape
        if event:
            total = sum(r[1] for r in rows if r[2])
            body = "".join(
                "<tr><td>%s</td><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>"
                % (esc(r[0]), r[1], "✅ Va" if r[2] else "❌ No va", esc(r[3] or ""), esc(r[4]))
                for r in rows
            )
            table = (
                "<h1>Confirmados: %d personas</h1><table><tr><th>Nombre</th><th>Cant.</th>"
                "<th>Respuesta</th><th>Mensaje</th><th>Fecha (UTC)</th></tr>%s</table>" % (total, body)
            )
        else:
            body = "".join(
                "<tr><td><a href='?event=%s&token=%s'>%s</a></td><td>%d</td><td>%d</td><td>%s</td></tr>"
                % (esc(r[0]), esc(token), esc(r[0]), r[1], r[2] or 0, esc(r[3]))
                for r in rows
            )
            table = (
                "<h1>Eventos</h1><table><tr><th>Evento</th><th>Respuestas</th><th>Van</th>"
                "<th>Última</th></tr>%s</table>" % body
            )
        page = (
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
            "<title>Confirmaciones</title><style>body{font-family:system-ui;margin:1rem}"
            "table{border-collapse:collapse;width:100%%}td,th{border:1px solid #ccc;padding:.4rem;text-align:left}"
            "</style>%s" % table
        )
        return self.send(200, page, "text/html; charset=utf-8")

    def index_with_preview(self, q):
        try:
            with open(os.path.join(SITE_ROOT, "index.html"), encoding="utf-8") as fh:
                page = fh.read()
        except OSError:
            return self.send(500, '{"error":"index.html not found"}')
        raw = (q.get("i") or [""])[0]
        if raw:
            try:
                d = decode_invite(raw)
                name = str(d.get("n", ""))[:60]
                title = "🎂 ¡Estás invitado/a al cumple de %s!" % name if name else None
                desc = "Tocá para abrir la invitación y soplar las velitas 🎉"
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d.get("d", ""))):
                    y, m, dd = str(d["d"]).split("-")
                    desc = "📅 %s/%s/%s · %s hs. %s" % (dd, m, y, str(d.get("t", ""))[:5], desc)
                if title:
                    t, ds = html.escape(title, quote=True), html.escape(desc, quote=True)
                    page = re.sub(r'(property="og:title" content=")[^"]*', lambda m: m.group(1) + t, page)
                    page = re.sub(r'(name="twitter:title" content=")[^"]*', lambda m: m.group(1) + t, page)
                    page = re.sub(r'(property="og:description" content=")[^"]*', lambda m: m.group(1) + ds, page)
                    page = re.sub(r'(name="twitter:description" content=")[^"]*', lambda m: m.group(1) + ds, page)
            except (ValueError, KeyError, UnicodeDecodeError):
                pass  # link inválido: se sirve la página genérica
        return self.send(200, page, "text/html; charset=utf-8")


if __name__ == "__main__":
    if not TOKEN:
        print("Aviso: RSVP_TOKEN vacío; la lista de confirmados queda deshabilitada.")
    db().close()
    print("Escuchando en http://%s:%d" % (HOST, PORT))
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
