/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️  OPTIONS TRADING ONLY — Webull OpenAPI Client (LIVE)
 * ═══════════════════════════════════════════════════════════════════════════
 * Direct REST client for Webull OpenAPI.
 * Credentials: WEBULL_APP_KEY, WEBULL_APP_SECRET, WEBULL_ACCOUNT_ID
 * Docs: https://developer.webull.com/api/
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TZ = "America/New_York";

function log(msg) {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
  console.log(`[${t} ET] [Webull] ${msg}`);
}

class WebullClient {
  constructor() {
    this.appKey      = process.env.WEBULL_APP_KEY;
    this.appSecret   = process.env.WEBULL_APP_SECRET;
    this.accountId   = process.env.WEBULL_ACCOUNT_ID;
    this.region      = process.env.WEBULL_REGION_ID || "us";
    this.environment = process.env.WEBULL_ENVIRONMENT || "prod";
    this.maxOrderQty = parseInt(process.env.WEBULL_MAX_ORDER_QUANTITY || "100", 10);
    this.whitelistArr = (process.env.WEBULL_SYMBOL_WHITELIST || "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    // Base URL — swap for UAT when needed
    this.baseUrl = this.environment === "prod"
      ? "https://openapi.webull.com/openapi"
      : "https://openapi-test.webull.com/openapi";

    this._token       = null;
    this._tokenExpiry = 0;
    this._debug       = process.env.DEBUG_WEBULL === "true";
  }

  // ── CREDENTIALS ───────────────────────────────────────────────────────────

  validateCredentials() {
    if (!this.appKey || !this.appSecret || !this.accountId) {
      throw new Error("Missing credentials: WEBULL_APP_KEY, WEBULL_APP_SECRET, WEBULL_ACCOUNT_ID");
    }
  }

  // ── AUTHENTICATION (OAuth2 client_credentials) ────────────────────────────

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;

    this.validateCredentials();
    if (this._debug) log("Refreshing access token...");

    const resp = await fetch(`${this.baseUrl}/oauth/token`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        grant_type: "client_credentials",
        app_key:    this.appKey,
        app_secret: this.appSecret,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Webull auth failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    // Webull may return accessToken or access_token
    this._token       = data.accessToken || data.access_token || data.token;
    this._tokenExpiry = Date.now() + ((data.expires_in || 86400) - 120) * 1000;

    if (!this._token) throw new Error(`Webull auth: no token in response: ${JSON.stringify(data)}`);
    if (this._debug) log("Token refreshed OK");
    return this._token;
  }

  // ── GENERIC REQUEST ───────────────────────────────────────────────────────

  async request(method, path, body = null, params = null) {
    const token   = await this.getToken();
    const url     = new URL(`${this.baseUrl}${path}`);
    if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    if (this._debug) log(`${method} ${url.pathname}${url.search}`);

    const resp = await fetch(url, opts);
    const text = await resp.text();

    if (!resp.ok) throw new Error(`Webull API ${method} ${path}: HTTP ${resp.status} — ${text}`);

    try { return JSON.parse(text); }
    catch { return text; }
  }

  // ── MARKET DATA ───────────────────────────────────────────────────────────

  /**
   * Historical bars (OHLCV).
   * Webull granularity: "1m" "5m" "15m" "30m" "1h" "d" "1w" "1mo"
   * Returns [{time, open, high, low, close, volume}]
   */
  async getBars(symbol, interval = "1d", count = 30) {
    const granMap = {
      "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
      "1h": "1h", "1d": "d",  "1w":  "1w",  "1mo": "1mo",
    };
    const granularity = granMap[interval] || "d";

    const data = await this.request("GET", "/quotes/bars", null, {
      symbol, granularity, count,
    });

    // Webull may nest under data.data or return array directly
    const raw = (data && data.data) ? data.data : (Array.isArray(data) ? data : []);
    return raw.map(b => ({
      time:   b.timestamp || b.time || b.t,
      open:   parseFloat(b.open   || b.o),
      high:   parseFloat(b.high   || b.h),
      low:    parseFloat(b.low    || b.l),
      close:  parseFloat(b.close  || b.c),
      volume: parseFloat(b.volume || b.v || 0),
    })).filter(b => b.close > 0);
  }

  /**
   * Current snapshot (latest quote).
   * Returns {symbol, last, bid, ask, change, changePercent, volume}
   */
  async getSnapshot(symbol) {
    const data = await this.request("GET", "/quotes/snapshot", null, { symbol });
    const raw  = data?.data?.[0] || data?.[0] || data;
    return {
      symbol:        symbol,
      last:          parseFloat(raw.close   || raw.last   || raw.price || 0),
      bid:           parseFloat(raw.bid     || 0),
      ask:           parseFloat(raw.ask     || 0),
      change:        parseFloat(raw.change  || 0),
      changePercent: parseFloat(raw.changeRatio || raw.changePercent || 0),
      volume:        parseFloat(raw.volume  || 0),
    };
  }

  // ── ACCOUNT ───────────────────────────────────────────────────────────────

  /**
   * Open positions in account.
   * Returns [{symbol, qty, avgCost, marketValue, unrealizedPnL, ...}]
   */
  async getPositions() {
    const data = await this.request("GET", `/account/${this.accountId}/positions`);
    const raw  = data?.data || data?.positions || data || [];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Account balance / buying power.
   * Returns {totalValue, buyingPower, cash, ...}
   */
  async getBalance() {
    const data = await this.request("GET", `/account/${this.accountId}/balance`);
    return data?.data || data;
  }

  // ── ORDERS ────────────────────────────────────────────────────────────────

  /** Open / pending orders. Returns [{orderId, symbol, status, ...}] */
  async getOpenOrders() {
    const data = await this.request("GET", `/account/${this.accountId}/open-orders`);
    return data?.data || data?.orders || data || [];
  }

  /** Order detail by ID. */
  async getOrderStatus(orderId) {
    const data = await this.request("GET", `/account/${this.accountId}/orders/${orderId}`);
    return data?.data || data;
  }

  /** Order history (closed + filled). */
  async getOrderHistory({ startDate, endDate, limit = 50 } = {}) {
    const data = await this.request("GET", `/account/${this.accountId}/order-history`, null, {
      startDate, endDate, limit,
    });
    return data?.data || data?.orders || data || [];
  }

  /**
   * ⚠️  OPTIONS ONLY — Place a single-leg option order.
   * @param {object} order
   * @param {string}  order.symbol       — underlying ticker (e.g. 'AAPL')
   * @param {string}  order.optionType   — 'CALL' | 'PUT'
   * @param {number}  order.strike       — strike price
   * @param {string}  order.expiryDate   — 'YYYY-MM-DD'
   * @param {number}  order.quantity     — number of contracts
   * @param {number}  order.limitPrice   — premium per contract (limit order)
   * @param {string}  [order.side]       — 'BUY' (default) | 'SELL'
   * @param {string}  [order.timeInForce]— 'DAY' (default) | 'GTC'
   * @returns {Promise<{orderId, status, ...}>}
   */
  async placeOptionOrder(order) {
    this.validateCredentials();

    const { optionType, strike, expiryDate, quantity, limitPrice } = order;

    // Validate required options-specific fields
    if (!["CALL", "PUT"].includes(optionType)) throw new Error(`optionType must be CALL or PUT, got: ${optionType}`);
    if (!strike)     throw new Error("strike is required for option orders");
    if (!expiryDate) throw new Error("expiryDate is required for option orders");
    if (quantity > this.maxOrderQty) throw new Error(`quantity ${quantity} exceeds max ${this.maxOrderQty}`);

    // Webull expiry format: YYYYMMDD
    const expiry = expiryDate.replace(/-/g, "");

    const body = {
      symbol:      order.symbol,
      qty:         quantity,
      action:      (order.side || "BUY").toUpperCase(),
      orderType:   "LMT",
      lmtPrice:    limitPrice.toFixed(2),
      timeInForce: order.timeInForce || "DAY",
      // Option-specific fields
      optionType:   optionType,   // CALL | PUT
      strikePrice:  strike.toFixed(2),
      expireDate:   expiry,       // YYYYMMDD
    };

    log(`Placing ${optionType} order: ${order.symbol} $${strike} exp ${expiry} x${quantity} @ $${limitPrice.toFixed(2)}`);

    const data = await this.request("POST", `/account/${this.accountId}/option-orders/place`, body);
    const res  = data?.data || data;

    const orderId = res?.orderId || res?.order_id || res?.id || `wb_${Date.now()}`;
    log(`Order placed — ID: ${orderId}`);
    return { orderId, status: res?.status || "SUBMITTED", raw: res };
  }

  /**
   * Sell/close an open option position (submit SELL order at market).
   * @param {object} trade  — active trade object from state
   * @param {number} [qty]  — contracts to close; defaults to trade.position.contracts (full close)
   */
  async closeOptionOrder(trade, qty = null) {
    const contracts = qty ?? trade.position.contracts;
    const body = {
      symbol:      trade.symbol,
      qty:         contracts,
      action:      "SELL",
      orderType:   "MKT",
      timeInForce: "DAY",
      optionType:  trade.direction,
      strikePrice: trade.position.strike.toFixed(2),
      expireDate:  trade.position.expiryDate.replace(/-/g, ""),
    };

    log(`Closing ${trade.direction}: ${trade.symbol} x${contracts}${qty ? ` (partial of ${trade.position.contracts})` : ""}`);
    const data = await this.request("POST", `/account/${this.accountId}/option-orders/place`, body);
    return data?.data || data;
  }

  /**
   * ⚠️  OPTIONS ONLY — Fetch the option chain for a symbol/expiry.
   * Returns an array of strikes with real bid/ask from Webull.
   * Falls back gracefully: caller should catch and use Black-Scholes if this throws.
   */
  async getOptionChain(symbol, expiryDate) {
    // Webull expiry format: YYYYMMDD
    const expiry = expiryDate.replace(/-/g, "");
    const data   = await this.request("GET", "/options/chain", null, { symbol, expireDate: expiry });
    const raw    = data?.data?.strikes || data?.data || data || [];
    return raw.map(s => ({
      optionType:    s.optionType   || s.type,
      strikePrice:   parseFloat(s.strikePrice || s.strike || 0),
      bid:           parseFloat(s.bid   || 0),
      ask:           parseFloat(s.ask   || 0),
      last:          parseFloat(s.close || s.last || 0),
      volume:        parseInt(s.volume || 0, 10),
      openInterest:  parseInt(s.openInterest || s.oi || 0, 10),
      impliedVol:    parseFloat(s.impliedVolatility || s.iv || 0),
    })).filter(s => s.strikePrice > 0 && (s.bid > 0 || s.ask > 0));
  }

  /** Cancel an open (not-yet-filled) order. */
  async cancelOrder(orderId) {
    if (!orderId || orderId.startsWith("local_") || orderId.startsWith("mock_")) return;
    log(`Cancelling order ${orderId}`);
    const data = await this.request("DELETE", `/account/${this.accountId}/orders/${orderId}`);
    return data?.data || data;
  }

  /** Modify (replace) an existing order (e.g., move stop limit). */
  async replaceOptionOrder(orderId, updates) {
    const body = { orderId, ...updates };
    const data = await this.request("PUT", `/account/${this.accountId}/orders/${orderId}`, body);
    return data?.data || data;
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────

  /** Check if symbol is in allowed whitelist. Returns true if whitelist is empty (allow all). */
  isSymbolAllowed(symbol) {
    if (this.whitelistArr.length === 0) return true;
    return this.whitelistArr.includes(symbol.toUpperCase());
  }

  /** Extract Greeks from a Webull position object (if available). */
  estimateGreeks(position) {
    return position.greeks
      ? { delta: position.greeks.delta, gamma: position.greeks.gamma, theta: position.greeks.theta, vega: position.greeks.vega }
      : null;
  }
}

module.exports = WebullClient;
