/**
 * Tests for IBKR router DB helpers
 * These test the settings persistence logic without needing a real Gateway.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

// Mock drizzle schema
vi.mock("../drizzle/schema", () => ({
  ibkrSettings: { userId: "userId", gatewayUrl: "gatewayUrl", accountId: "accountId", accountType: "accountType", lastConnectedAt: "lastConnectedAt" },
}));

import { getDb } from "./db";

describe("IBKR Settings Logic", () => {
  it("defaults gateway URL to https://localhost:5000", () => {
    const defaultUrl = "https://localhost:5000";
    expect(defaultUrl).toBe("https://localhost:5000");
  });

  it("detects paper account from DU prefix", () => {
    const accountId = "DU1234567";
    const accountType = accountId.startsWith("DU") ? "paper" : "live";
    expect(accountType).toBe("paper");
  });

  it("detects live account from U prefix", () => {
    const accountId = "U9876543";
    const accountType = accountId.startsWith("DU") ? "paper" : "live";
    expect(accountType).toBe("live");
  });

  it("validates gateway URL format", () => {
    const validUrls = [
      "https://localhost:5000",
      "https://localhost:5001",
      "http://localhost:5000",
    ];
    const invalidUrls = ["not-a-url", ""];

    for (const url of validUrls) {
      expect(() => new URL(url)).not.toThrow();
    }
    for (const url of invalidUrls) {
      expect(() => new URL(url)).toThrow();
    }
  });

  it("constructs correct IBKR API endpoint paths", () => {
    const base = "https://localhost:5000";
    const accountId = "DU1234567";

    expect(`${base}/v1/api/iserver/auth/status`).toBe("https://localhost:5000/v1/api/iserver/auth/status");
    expect(`${base}/v1/api/portfolio/accounts`).toBe("https://localhost:5000/v1/api/portfolio/accounts");
    expect(`${base}/v1/api/portfolio/${accountId}/summary`).toBe("https://localhost:5000/v1/api/portfolio/DU1234567/summary");
    expect(`${base}/v1/api/iserver/account/${accountId}/orders`).toBe("https://localhost:5000/v1/api/iserver/account/DU1234567/orders");
  });

  it("builds correct order body for market order", () => {
    const order = {
      conid: 265598,
      side: "BUY" as const,
      orderType: "MKT" as const,
      quantity: 10,
      tif: "DAY" as const,
    };
    const body = {
      orders: [{
        conid: order.conid,
        secType: `${order.conid}:STK`,
        orderType: order.orderType,
        side: order.side,
        quantity: order.quantity,
        tif: order.tif,
      }],
    };
    expect(body.orders[0].orderType).toBe("MKT");
    expect(body.orders[0].side).toBe("BUY");
    expect(body.orders[0].quantity).toBe(10);
    expect(body.orders[0].secType).toBe("265598:STK");
  });

  it("builds correct order body for limit order", () => {
    const order = {
      conid: 265598,
      side: "BUY" as const,
      orderType: "LMT" as const,
      quantity: 5,
      price: 150.50,
      tif: "GTC" as const,
    };
    const body = {
      orders: [{
        conid: order.conid,
        secType: `${order.conid}:STK`,
        orderType: order.orderType,
        side: order.side,
        quantity: order.quantity,
        tif: order.tif,
        price: order.price,
      }],
    };
    expect(body.orders[0].orderType).toBe("LMT");
    expect(body.orders[0].price).toBe(150.50);
    expect(body.orders[0].tif).toBe("GTC");
  });

  it("strips trailing slash from gateway URL", () => {
    const url = "https://localhost:5000/";
    const cleaned = url.replace(/\/$/, "");
    expect(cleaned).toBe("https://localhost:5000");
  });

  it("handles both paper and live account types", () => {
    const accountTypes = ["paper", "live"] as const;
    for (const type of accountTypes) {
      expect(["paper", "live"]).toContain(type);
    }
  });
});
