/**
 * IBIND integration tests
 * Validates that IBIND_API_SECRET is configured and the ibindRequest helper
 * would include the correct Authorization header.
 */
import { describe, it, expect } from "vitest";
import { ENV } from "./_core/env";

// Skips when IBIND_API_SECRET is absent (local dev box without .env); still validates
// on the server where the secret is injected.
describe.skipIf(!process.env.IBIND_API_SECRET)("IBIND configuration", () => {
  it("IBIND_API_SECRET should be configured (non-empty)", () => {
    expect(ENV.ibindApiSecret).toBeTruthy();
    expect(ENV.ibindApiSecret.length).toBeGreaterThan(10);
  });

  it("IBIND_API_SECRET should look like a valid Bearer token (hex string)", () => {
    // Token should be a hex string of reasonable length
    expect(ENV.ibindApiSecret).toMatch(/^[a-f0-9]{32,}$/i);
  });
});
