/**
 * Short-lived one-time confirm tokens for destructive War Room actions.
 * Client must call requestActionToken after hold-to-confirm UI, then pass confirmToken to the mutation.
 */
import crypto from "crypto";

export const LIVE_DESTRUCTIVE_ACTIONS = ["emergency_exit", "stop_buy", "engine_off"] as const;
export type LiveDestructiveAction = (typeof LIVE_DESTRUCTIVE_ACTIONS)[number];

const TOKEN_TTL_MS = 30_000;

interface PendingEntry {
  userId: number;
  action: LiveDestructiveAction;
  expiresAt: number;
}

const pending = new Map<string, PendingEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

export function issueActionConfirmToken(
  userId: number,
  action: LiveDestructiveAction,
): { confirmToken: string; expiresInMs: number } {
  pruneExpired();
  const confirmToken = crypto.randomBytes(32).toString("hex");
  pending.set(confirmToken, {
    userId,
    action,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return { confirmToken, expiresInMs: TOKEN_TTL_MS };
}

/** Validates and consumes token (single use). */
export function consumeActionConfirmToken(
  userId: number,
  action: LiveDestructiveAction,
  confirmToken: string,
): boolean {
  pruneExpired();
  const entry = pending.get(confirmToken);
  if (!entry) return false;
  pending.delete(confirmToken);
  if (entry.userId !== userId) return false;
  if (entry.action !== action) return false;
  if (entry.expiresAt <= Date.now()) return false;
  return true;
}

/** @internal test helper */
export function _clearActionConfirmTokensForTests(): void {
  pending.clear();
}
