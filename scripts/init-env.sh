#!/usr/bin/env bash
# Generate a ready-to-run .env with fresh secrets for a new TornScope install.
# Portable across GNU/BSD sed (writes to a temp file, never edits in place).
#
# Usage:  bash scripts/init-env.sh [--force]
#         --force also refills secrets in an existing .env (leaves the rest).
set -euo pipefail

if [[ ! -f .env.example ]]; then
  echo "Error: .env.example not found. Run from the repository root." >&2
  exit 1
fi

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env already exists — nothing changed. Re-run with --force to (re)generate missing secrets."
  exit 0
fi

# Hex only: safe inside a PostgreSQL URI and Compose ${...} interpolation,
# no shell-quoting or URL-encoding pitfalls.
PG_PASS=$(openssl rand -hex 16)
ENC_KEY=$(openssl rand -hex 32)

sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASS}|" \
    -e "s|^API_KEY_ENCRYPTION_KEY=.*|API_KEY_ENCRYPTION_KEY=${ENC_KEY}|" \
    .env.example > .env.tmp
mv .env.tmp .env

echo "Generated secrets in .env:"
echo "  POSTGRES_PASSWORD: set ($(printf '%s' "$PG_PASS" | wc -c | tr -d ' ') hex chars)"
echo "  API_KEY_ENCRYPTION_KEY: set (64 hex chars)"
echo ""
echo "Defaults are localhost-ready. For non-local access, set APP_BASE_URL /"
echo "ORIGIN / PUBLIC_BASE_URL / ALLOWED_ORIGINS — see README."
echo "Then: docker compose up -d --build"
