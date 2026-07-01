#!/usr/bin/env bash
# IBIND2 for Dror — port 5002 (5000=CEO live, 5001=paper). Dormant until Dror IBKR OAuth wired.
set -euo pipefail

DROR_DIR="/root/ibind-oauth-dror"
PAPER_DIR="/root/ibind-oauth-paper"
API_SECRET="${DROR_IBIND_API_SECRET:-$(openssl rand -hex 32)}"
HMAC_SECRET="${DROR_IBIND_HMAC_SECRET:-$(openssl rand -hex 32)}"

echo "[ibind2-dror] Installing to ${DROR_DIR} (CEO :5000 untouched)"

if [[ ! -d "$PAPER_DIR" ]]; then
  echo "Missing ${PAPER_DIR}" >&2
  exit 1
fi

mkdir -p "$DROR_DIR"
rsync -a --delete \
  --exclude 'idempotency.db' \
  --exclude '.env.paper' \
  --exclude '__pycache__' \
  "$PAPER_DIR/" "$DROR_DIR/"

# Path rewrites paper → dror
sed -i 's|/root/ibind-oauth-paper|/root/ibind-oauth-dror|g' "$DROR_DIR/oauth_server.py"

# Dormant guard: block IBKR session until Dror OAuth credentials are configured
if ! grep -q 'IBKR_OAUTH_PENDING' "$DROR_DIR/oauth_server.py"; then
  python3 <<'PY'
from pathlib import Path
p = Path("/root/ibind-oauth-dror/oauth_server.py")
text = p.read_text()
needle = "def start_session():"
guard = '''def start_session():
    """Start IBKR OAuth session. Idempotent: returns success if already active."""
    if os.environ.get('IBKR_OAUTH_PENDING', '').strip().lower() in ('1', 'true', 'yes'):
        return jsonify({
            'success': False,
            'session_active': False,
            'message': 'Dror IBKR OAuth not configured — set credentials in /root/ibind-oauth-dror/.env.dror and clear IBKR_OAUTH_PENDING',
        }), 503'''
if needle not in text:
    raise SystemExit('start_session anchor not found')
# Replace first occurrence of docstring block after def start_session
import re
text2, n = re.subn(
    r"def start_session\(\):\n    \"\"\"Start IBKR OAuth session\. Idempotent: returns success if already active\.\"\"\"",
    guard,
    text,
    count=1,
)
if n != 1:
    raise SystemExit('start_session patch failed')
p.write_text(text2)
PY
fi

# Health banner: dror dormant
sed -i "s/'mode': 'paper'/'mode': 'dror_dormant'/g" "$DROR_DIR/oauth_server.py" || true
sed -i 's/=== MODE=PAPER ===/=== MODE=DROR_DORMANT ===/g' "$DROR_DIR/oauth_server.py" || true

cat > "$DROR_DIR/.env.dror" <<EOF
# IBIND2 — Dror (dormant). Port 5002. Separate from CEO :5000 and paper :5001.
IBIND_API_SECRET=${API_SECRET}
IBIND_HMAC_SECRET=${HMAC_SECRET}

# IBKR OAuth — fill when Dror live account is registered (IBKR Self-Service)
CONSUMER_KEY=PENDING_DROR_CONSUMER_KEY
ACCESS_TOKEN=PENDING_DROR_ACCESS_TOKEN
ACCESS_TOKEN_SECRET=PENDING_DROR_ACCESS_TOKEN_SECRET
SIGNATURE_PEM=/root/ibind-oauth-dror/certs/private_signature.pem
ENCRYPTION_PEM=/root/ibind-oauth-dror/certs/private_encryption.pem

# Block session/start until real OAuth is wired
IBKR_OAUTH_PENDING=1

PORT=5002
FLASK_ENV=production
LOG_LEVEL=INFO
REQUIRE_DU_PREFIX=false
MODE=dror_dormant
EOF
chmod 600 "$DROR_DIR/.env.dror"

# Certs: copy DH material from paper (generic); replace signature/encryption when Dror OAuth ready
mkdir -p "$DROR_DIR/certs"
for f in dh_prime.hex dhparam.pem; do
  cp -n "$PAPER_DIR/certs/$f" "$DROR_DIR/certs/$f" 2>/dev/null || true
done
# Placeholder PEMs so import paths exist (session blocked by IBKR_OAUTH_PENDING)
if [[ ! -f "$DROR_DIR/certs/private_signature.pem" ]]; then
  cp "$PAPER_DIR/certs/private_signature.pem" "$DROR_DIR/certs/private_signature.pem"
  cp "$PAPER_DIR/certs/private_encryption.pem" "$DROR_DIR/certs/private_encryption.pem"
  echo "# WARNING: using paper placeholder certs — replace before go-live" > "$DROR_DIR/certs/README.txt"
fi

cat > /etc/systemd/system/ibind-oauth-dror.service <<'UNIT'
[Unit]
Description=IBIND OAuth 1.0a Server - DROR (port 5002, dormant)
After=network.target
Wants=network-online.target

[Service]
Type=exec
User=root
WorkingDirectory=/root/ibind-oauth-dror
EnvironmentFile=/root/ibind-oauth-dror/.env.dror
Environment=PATH=/root/ibind-oauth-dror/venv/bin
ExecStart=/root/ibind-oauth-dror/venv/bin/python oauth_server.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ibind-oauth-dror

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log /root/ibind-oauth-dror
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ibind-oauth-dror.service
systemctl restart ibind-oauth-dror.service

# tradesnow .env — append Dror secrets if missing
ENV_FILE="/root/tradesnow/.env"
touch "$ENV_FILE"
grep -q '^IBIND_API_SECRET_DROR=' "$ENV_FILE" || echo "IBIND_API_SECRET_DROR=${API_SECRET}" >> "$ENV_FILE"
grep -q '^IBIND_HMAC_SECRET_DROR=' "$ENV_FILE" || echo "IBIND_HMAC_SECRET_DROR=${HMAC_SECRET}" >> "$ENV_FILE"

# DB gateway port 5002
if command -v mysql >/dev/null && [[ -f /root/tradesnow/.env ]]; then
  DB_URL=$(grep '^DATABASE_URL=' /root/tradesnow/.env | cut -d= -f2-)
  if [[ -n "$DB_URL" ]]; then
    node --env-file=/root/tradesnow/.env -e "
      const u=new URL(process.env.DATABASE_URL);
      const mysql=require('mysql2/promise');
      (async()=>{
        const c=await mysql.createConnection({host:u.hostname,port:u.port||3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:u.pathname.slice(1).split('?')[0]});
        await c.execute(\"UPDATE ibkrGateways SET baseUrl='http://127.0.0.1:5002' WHERE slug='dror'\");
        await c.end();
        console.log('[ibind2-dror] DB ibkrGateways.dror → :5002');
      })().catch(e=>{console.error(e);process.exit(1);});
    " 2>/dev/null || echo "[ibind2-dror] DB update skipped (run manually)"
  fi
fi

sleep 2
if ss -tlnp | grep -q ':5002 '; then
  echo "[ibind2-dror] ✅ Listening on :5002"
else
  echo "[ibind2-dror] ⚠️ Port 5002 not listening — check: journalctl -u ibind-oauth-dror -n 30"
  exit 1
fi

echo "[ibind2-dror] API_SECRET (for tradesnow IBIND_API_SECRET_DROR): ${API_SECRET}"
echo "[ibind2-dror] HMAC_SECRET (for tradesnow IBIND_HMAC_SECRET_DROR): ${HMAC_SECRET}"
echo "[ibind2-dror] Restart tradesnow app to load new env vars."
