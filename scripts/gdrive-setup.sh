#!/usr/bin/env bash
# Google Drive auth for TradeSnow handoff uploads (rclone).
# Run from repo root: ./scripts/gdrive-setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${REPO_ROOT}/secrets"
RCLONE_CONFIG="${HOME}/.config/rclone/rclone.conf"
REMOTE_NAME="${GDRIVE_REMOTE_NAME:-tradesnow-gdrive}"
SA_FILE="${GDRIVE_SERVICE_ACCOUNT_FILE:-${SECRETS_DIR}/google-service-account.json}"

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

echo "=== TradeSnow Google Drive setup ==="
echo ""
echo "Choose auth method:"
echo "  1) Service Account (recommended — share a Drive folder with the SA email)"
echo "  2) OAuth token from your PC (run 'rclone authorize drive' locally, paste JSON)"
echo ""
read -r -p "Method [1/2]: " METHOD

mkdir -p "$(dirname "${RCLONE_CONFIG}")"

case "${METHOD}" in
  1)
    if [[ ! -f "${SA_FILE}" ]]; then
      echo ""
      echo "Place your service account JSON at:"
      echo "  ${SA_FILE}"
      echo ""
      echo "Steps:"
      echo "  1. https://console.cloud.google.com/ → APIs → Enable Google Drive API"
      echo "  2. IAM → Service Accounts → Create → Keys → JSON → save to secrets/"
      echo "  3. In Drive, share target folder with client_email from the JSON"
      exit 1
    fi
    CLIENT_EMAIL="$(python3 -c "import json; print(json.load(open('${SA_FILE}'))['client_email'])")"
    echo "Service account: ${CLIENT_EMAIL}"
    echo "Share your Drive folder with this email (Editor)."
    read -r -p "Press Enter after sharing the folder..."
    if rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:$"; then
      rclone config delete "${REMOTE_NAME}" -y
    fi
    rclone config create "${REMOTE_NAME}" drive \
      service_account_file "${SA_FILE}" \
      scope drive
    ;;
  2)
    echo ""
    echo "On a machine with a browser, run:"
    echo "  rclone authorize drive"
    echo ""
    echo "Copy the entire JSON blob rclone prints, then paste below (end with empty line):"
    TOKEN=""
    while IFS= read -r line; do
      [[ -z "${line}" ]] && break
      TOKEN+="${line}"
    done
    if [[ -z "${TOKEN}" ]]; then
      echo "No token pasted." >&2
      exit 1
    fi
    if rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:$"; then
      rclone config delete "${REMOTE_NAME}" -y
    fi
    rclone config create "${REMOTE_NAME}" drive config_token "${TOKEN}"
    ;;
  *)
    echo "Invalid choice." >&2
    exit 1
    ;;
esac

echo ""
echo "Testing connection..."
rclone lsd "${REMOTE_NAME}:" | head -5
echo ""
echo "Done. Remote: ${REMOTE_NAME}:"
echo "Add to .env (optional):"
echo "  GDRIVE_REMOTE_NAME=${REMOTE_NAME}"
