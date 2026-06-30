import { describe, expect, it, beforeEach } from "vitest";
import {
  issueActionConfirmToken,
  consumeActionConfirmToken,
  _clearActionConfirmTokensForTests,
} from "./actionConfirmToken";

describe("actionConfirmToken", () => {
  beforeEach(() => {
    _clearActionConfirmTokensForTests();
  });

  it("issues and consumes a valid token once", () => {
    const { confirmToken } = issueActionConfirmToken(1, "emergency_exit");
    expect(consumeActionConfirmToken(1, "emergency_exit", confirmToken)).toBe(true);
    expect(consumeActionConfirmToken(1, "emergency_exit", confirmToken)).toBe(false);
  });

  it("rejects wrong user or action", () => {
    const { confirmToken } = issueActionConfirmToken(1, "engine_off");
    expect(consumeActionConfirmToken(2, "engine_off", confirmToken)).toBe(false);
    expect(consumeActionConfirmToken(1, "stop_buy", confirmToken)).toBe(false);
  });
});
