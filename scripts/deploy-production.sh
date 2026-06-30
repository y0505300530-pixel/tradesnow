#!/usr/bin/env bash
# Git-based production deploy — single source of truth for /root/tradesnow
#
# Usage:
#   ./scripts/deploy-production.sh                    # pull current branch
#   ./scripts/deploy-production.sh main               # pull + checkout main
#   ./scripts/deploy-production.sh feat/my-branch
#
# Workflow (developer machine):
#   git add … && git commit -m "…" && git push origin <branch>
#
# Workflow (droplet):
#   ./scripts/deploy-production.sh <branch>
#
set -euo pipefail

APP_DIR="${APP_DIR:-/root/tradesnow}"
BRANCH="${1:-}"
PM2_APP="${PM2_APP:-tradesnow-app}"

cd "$APP_DIR"

if [[ ! -d .git ]]; then
  echo "ERROR: $APP_DIR is not a git repository." >&2
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

echo "==> Deploy: $APP_DIR @ origin/$BRANCH"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "WARN: Working tree has uncommitted changes. Stashing before pull…"
  git stash push -u -m "deploy-production auto-stash $(date -Iseconds)" || true
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> HEAD: $(git log -1 --oneline)"

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  pnpm build
else
  echo "ERROR: pnpm not found" >&2
  exit 1
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP" --update-env
  pm2 status "$PM2_APP"
else
  echo "WARN: pm2 not found — build complete, restart app manually."
fi

echo "==> Deploy complete."
