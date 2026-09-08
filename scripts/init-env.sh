#!/usr/bin/env bash
# Generate safe .env secrets for a fresh TornScope checkout.
# Refuses to overwrite existing non-empty values unless --force is passed.
set -euo pipefail

ENV_FILE="${1:-.env}"
FORCE=false
[[ "${1:-}" == "--force" ]] && ENV_FILE=".env" && FORCE=true

if [[ ! -f .env.example ]]; then
  echo "Error: .env.example not found. Run from the repository root." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]] && [[ "$FORCE" == false ]]; then
  echo ".env already exists. Use --force to regenerate missing secrets anyway."
  exit 0
fi

cp .env.example "$ENV_FILE"

gen_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p | tr -d '\n'; }
gen_pass() { openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 32; }

PG_PASS=$(gen_pass)
ENC_KEY=$(gen_hex 32)

# Replace placeholders with generated values (only if still placeholder/empty).
sed -i "s|POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${PG_PASS}|" "$ENV_FILE" 2>/dev/null || true
sed -i "s|API_KEY_ENCRYPTION_KEY=CHANGE_ME_64_HEX_CHARS|API_KEY_ENCRYPTION_KEY=${ENC_KEY}|" "$ENV_FILE"
sed -i "s|POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${PG_PASS}|" "$ENV_FILE"

echo "Generated secrets in $ENV_FILE:"
echo "  POSTGRES_PASSWORD: (set)"
echo "  API_KEY_ENCRYPTION_KEY: (set)"
echo ""
echo "Review .env and set APP_BASE_URL / ORIGIN / PUBLIC_BASE_URL to your public URL."
echo "Then: docker compose up -d --build"
