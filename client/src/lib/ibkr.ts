/**
 * IBKR Client Portal Gateway — Frontend Client (Proxy Mode)
 *
 * All calls go through our server-side proxy at /api/ibkr-proxy,
 * which forwards them to the user's IBKR Client Portal Gateway.
 *
 * This solves two browser-side problems:
 *   1. CORS — browser blocks cross-origin requests to external Gateway URLs
 *   2. Self-signed SSL — browser blocks https requests to gateways with self-signed certs
 *
 * The server proxy uses Node.js (which ignores CORS) and disables SSL cert
 * verification for the Gateway connection.
 */

export interface IbkrAccount {
  id: string;
  accountId: string;
  accountVan: string;
  accountTitle: string;
  displayName: string;
  accountType: string;
  tradingType: string;
  currency: string;
  businessType: string;
  ibEntity: string;
  faclient: boolean;
  clearingStatus: string;
  covestor: boolean;
  noClientTrading: boolean;
  trackVirtualFXPortfolio: boolean;
  acctCustType: string;
}

export interface IbkrAccountSummary {
  accountready: { amount: number; currency: string };
  netliquidation: { amount: number; currency: string };
  totalcashvalue: { amount: number; currency: string };
  buyingpower: { amount: number; currency: string };
  grosspositionvalue: { amount: number; currency: string };
  unrealizedpnl: { amount: number; currency: string };
  realizedpnl: { amount: number; currency: string };
  dailypnl?: { amount: number; currency: string };
}

export interface IbkrPosition {
  acctId: string;
  conid: number;
  contractDesc: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  currency: string;
  avgCost: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  exchs: string;
  expiry: string;
  putOrCall: string;
  multiplier: number;
  strike: number;
  exerciseStyle: string;
  undConid: number;
  model: string;
  incrementRules: { lowerEdge: number; increment: number }[];
  displayRule: { magnification: number; displayRuleStep: { decimalDigits: number; lowerEdge: number; wholeDigits: number }[] };
  time: number;
  chineseName: string;
  allExchanges: string;
  listingExchange: string;
  countryCode: string;
  name: string;
  lastTradingDay: string;
  group: string;
  sector: string;
  sectorGroup: string;
  ticker: string;
  type: string;
  hasOptions: boolean;
  fullName: string;
  isUS: boolean;
  incrementRuleIndex: number;
}

export interface IbkrOrderResult {
  order_id?: string;
  order_status?: string;
  encrypt_message?: string;
  id?: string;
  message?: string[];
  isSuppressed?: boolean;
  isError?: boolean;
}

export interface IbkrContractResult {
  conid: number;
  companyHeader: string;
  companyName: string;
  symbol: string;
  description: string;
  restricted: boolean;
  fop: string;
  opt: string;
  war: string;
  sections: { secType: string; months?: string; symbol?: string }[];
}

class IbkrGatewayClient {
  private gatewayUrl: string;
  private sessionCookie: string | null = null;

  constructor(gatewayUrl = "https://localhost:5000") {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
  }

  setGatewayUrl(url: string) {
    this.gatewayUrl = url.replace(/\/$/, "");
  }

  getGatewayUrl(): string {
    return this.gatewayUrl;
  }

  setSessionCookie(cookie: string | null) {
    this.sessionCookie = cookie;
  }

  /** Fetch the JSESSIONID cookie that was sent by the bookmarklet to the server */
  async fetchBookmarkletCookie(): Promise<string | null> {
    try {
      const res = await fetch("/api/ibkr-proxy/get-cookie", {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json() as { cookie?: string };
      return data.cookie ?? null;
    } catch {
      return null;
    }
  }

  /**
   * All requests go through the server-side proxy at /api/ibkr-proxy.
   * The proxy forwards to the actual Gateway URL and handles CORS + SSL.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch("/api/ibkr-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",  // forward session cookies
      body: JSON.stringify({
        gatewayUrl: this.gatewayUrl,
        method,
        path,
        body,
        ...(this.sessionCookie && { sessionCookie: this.sessionCookie }),
      }),
    });

    if (!res.ok) {
      let errMsg = `Gateway error ${res.status}`;
      let errCode = "";
      try {
        const errData = await res.json() as { error?: string; code?: string };
        if (errData?.error) errMsg = errData.error;
        if (errData?.code) errCode = errData.code;
      } catch { /* ignore */ }
      const err = new Error(errMsg);
      (err as any).code = errCode;
      throw err;
    }

    return res.json() as Promise<T>;
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  async getAuthStatus(): Promise<{ authenticated: boolean; connected: boolean; competing: boolean; message: string }> {
    return this.request("GET", "/iserver/auth/status");
  }

  async initBrokerageSession(): Promise<{ authenticated: boolean; competing: boolean; message: string }> {
    return this.request("POST", "/iserver/auth/ssodh/init", { "publish": true, "compete": true });
  }

  async reauthenticate(): Promise<{ message: string }> {
    return this.request("POST", "/iserver/reauthenticate");
  }

  /** Keep the session alive — must be called every 60s or IBKR will disconnect */
  async tickle(): Promise<void> {
    await this.request("POST", "/tickle");
  }

  // ── Accounts ────────────────────────────────────────────────────────────────

  async getAccounts(): Promise<IbkrAccount[]> {
    return this.request("GET", "/portfolio/accounts");
  }

  async getAccountSummary(accountId: string): Promise<IbkrAccountSummary> {
    return this.request("GET", `/portfolio/${accountId}/summary`);
  }

  async getPositions(accountId: string, pageId = 0): Promise<IbkrPosition[]> {
    return this.request("GET", `/portfolio/${accountId}/positions/${pageId}`);
  }

  // ── Contract Search ─────────────────────────────────────────────────────────

  async searchContract(symbol: string): Promise<IbkrContractResult[]> {
    return this.request("GET", `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&name=false&secType=STK`);
  }

  async getConidForTicker(ticker: string): Promise<number | null> {
    try {
      const results = await this.searchContract(ticker);
      const match = results.find(r =>
        r.symbol === ticker &&
        r.sections?.some(s => s.secType === "STK")
      ) ?? results[0];
      return match?.conid ?? null;
    } catch {
      return null;
    }
  }

  // ── Market Data ─────────────────────────────────────────────────────────────

  async getMarketSnapshot(conids: number[]): Promise<Record<string, { "31"?: string; "84"?: string; "86"?: string }>> {
    return this.request("GET", `/iserver/marketdata/snapshot?conids=${conids.join(",")}&fields=31,84,86`);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  async placeOrder(accountId: string, order: {
    conid: number;
    side: "BUY" | "SELL";
    orderType: "MKT" | "LMT" | "STP";
    quantity: number;
    price?: number;
    auxPrice?: number;
    tif?: "DAY" | "GTC";
    outsideRTH?: boolean;
  }): Promise<IbkrOrderResult[]> {
    const body = {
      orders: [{
        conid: order.conid,
        secType: `${order.conid}:STK`,
        orderType: order.orderType,
        side: order.side,
        quantity: order.quantity,
        tif: order.tif ?? "DAY",
        ...(order.price !== undefined && { price: order.price }),
        ...(order.auxPrice !== undefined && { auxPrice: order.auxPrice }),
        ...(order.outsideRTH !== undefined && { outsideRTH: order.outsideRTH }),
      }],
    };
    return this.request("POST", `/iserver/account/${accountId}/orders`, body);
  }

  async confirmOrder(replyId: string): Promise<IbkrOrderResult[]> {
    return this.request("POST", `/iserver/reply/${replyId}`, { confirmed: true });
  }

  async getOpenOrders(): Promise<{ orders: Array<{
    orderId: string;
    account: string;
    ticker: string;
    conid: number;
    orderType: string;
    side: string;
    totalSize: number;
    price: number;
    status: string;
    listingExchange: string;
    remainingQuantity: number;
    filledQuantity: number;
  }> }> {
    return this.request("GET", "/iserver/account/orders");
  }

  async cancelOrder(accountId: string, orderId: string): Promise<{ msg: string; order_id: number; conid: number; account: string; error?: string }> {
    return this.request("DELETE", `/iserver/account/${accountId}/order/${orderId}`);
  }
}

// Singleton instance — updated when user changes Gateway URL
export const ibkrClient = new IbkrGatewayClient();
