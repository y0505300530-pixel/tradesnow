#!/usr/bin/env bash
# Upload manual-trading UX handoff folder to Google Drive.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_NAME="${GDRIVE_REMOTE_NAME:-tradesnow-gdrive}"
# Drive path, e.g. "TradeSnow/Manual Trading UX"
GDRIVE_FOLDER="${GDRIVE_HANDOFF_FOLDER:-TradeSnow/Manual Trading UX}"
HANDOFF_DIR="${REPO_ROOT}/docs/superpowers/handoff/cursor-manual-trading-ux-2026-06-25"
ZIP_PATH="${REPO_ROOT}/docs/superpowers/handoff/cursor-manual-trading-ux-2026-06-25.zip"

if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE_NAME}:$"; then
  echo "No rclone remote '${REMOTE_NAME}'. Run: ./scripts/gdrive-setup.sh" >&2
  exit 1
fi

if [[ ! -d "${HANDOFF_DIR}" ]]; then
  echo "Handoff folder missing: ${HANDOFF_DIR}" >&2
  exit 1
fi

echo "Building ZIP..."
(cd "$(dirname "${HANDOFF_DIR}")" && zip -qr "$(basename "${ZIP_PATH}")" "$(basename "${HANDOFF_DIR}")")

DEST="${REMOTE_NAME}:${GDRIVE_FOLDER}/cursor-manual-trading-ux-2026-06-25"
echo "Uploading to ${DEST} ..."
rclone copy "${HANDOFF_DIR}" "${DEST}" --progress
rclone copy "${ZIP_PATH}" "${REMOTE_NAME}:${GDRIVE_FOLDER}/" --progress

echo ""
echo "Upload complete."
rclone lsf "${REMOTE_NAME}:${GDRIVE_FOLDER}/" | grep cursor-manual
