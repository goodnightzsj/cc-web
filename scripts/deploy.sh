#!/usr/bin/env bash
# Deploy cc-web: hash assets → restart service → health check.
# Idempotent. Safe to run repeatedly.
#
# Usage: bash scripts/deploy.sh

set -euo pipefail

CC_WEB_DIR="${CC_WEB_DIR:-/root/cc-web}"
SERVICE="${CC_WEB_SERVICE:-cc-web.service}"
HEALTH_URL="${CC_WEB_HEALTH_URL:-http://127.0.0.1:8003/}"

cd "$CC_WEB_DIR"

echo "[1/4] hashing public/ assets…"
node scripts/build-assets.js

echo "[2/4] restarting $SERVICE…"
systemctl restart "$SERVICE"

echo "[3/4] waiting for service to accept connections…"
for i in $(seq 1 20); do
  if code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$HEALTH_URL" 2>/dev/null); then
    if [ "$code" = "200" ]; then
      echo "  ✓ HTTP $code at attempt $i"
      break
    fi
  fi
  sleep 0.5
  if [ "$i" -eq 20 ]; then
    echo "  ✗ service did not return 200 within 10s"
    systemctl status "$SERVICE" --no-pager -n 20
    exit 1
  fi
done

echo "[4/4] verifying hashed assets cache headers via internal port…"
# Find the first hashed asset and curl it
HASHED=$(ls -1 public/ | grep -E '^[a-z]+\.[0-9a-f]{10}\.(js|css)$' | head -1 || true)
if [ -n "$HASHED" ]; then
  IMMUTABLE=$(curl -sSI --max-time 2 "${HEALTH_URL%/}/$HASHED" | grep -i '^cache-control:' || true)
  echo "  $HASHED: $IMMUTABLE"
fi
INDEX_CC=$(curl -sSI --max-time 2 "$HEALTH_URL" | grep -i '^cache-control:' || true)
echo "  index.html: $INDEX_CC"

echo "done."
