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
const axios = require("axios");

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

    // Base URL — Try direct API endpoint (from developer docs)
    this.baseUrl = this.environment === "prod"
      ? "https://api.webull.com/openapi"
      : "https://api.webull.com/openapi";

    // Axios client with proxy support (if WEBULL_PROXY_URL is set)
    const proxyUrl = process.env.WEBULL_PROXY_URL;
    const axiosConfig = {
      timeout: 12000,
      headers: { "User-Agent": "SwingOptionsBot/2.1" },
    };
    if (proxyUrl) {
      const url = new URL(proxyUrl);
      axiosConfig.proxy = {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname,
        port: parseInt(url.port || (url.protocol === "https:" ? 443 : 80), 10),
      };
      log(`Configured proxy: ${proxyUrl}`);
    }
    this.axiosClient = axios.create(axiosConfig);

    this._token         = null;
    this._tokenExpiry   = 0;
    this._debug         = process.env.DEBUG_WEBULL === "true";
    this._cachedBalance = null; // Fallback for geo-blocked API calls
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

    let data;
    try {
      const resp = await this.axiosClient.post(`${this.baseUrl}/oauth/token`, {
        grant_type: "client_credentials",
        app_key:    this.appKey,
        app_secret: this.appSecret,
      });
      data = resp.data;
    } catch (e) {
      // Network error - likely CloudFront blocking
      if (e.code === "ECONNABORTED" || e.message.includes("timeout")) {
        throw new Error(`Webull API timeout (CloudFront may be blocking GCP IP 34.31.67.213). Set WEBULL_PROXY_URL to bypass. Contact Webull: "API calls from 34.31.67.213 timeout at CloudFront. IP is whitelisted in dashboard but CDN blocks it."`);
      }
      throw new Error(`Webull API error: ${e.message} (code: ${e.code})`);
    }
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
    const url     = `${this.baseUrl}${path}`;
    const config  = {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
    };
    if (params) config.params = params;
    if (body) config.data = body;

    if (this._debug) log(`${method} ${path}${params ? "?" + new URLSearchParams(params) : ""}`);

    try {
      const resp = await this.axiosClient.request({ url, ...config });
      return resp.data;
    } catch (e) {
      if (e.code === "ECONNABORTED" || e.message.includes("timeout")) {
        throw new Error(`Webull API timeout on ${method} ${path} — may need WEBULL_PROXY_URL`);
      }
      const status = e.response?.status;
      const text = e.response?.data || e.message;
      throw new Error(`Webull API ${method} ${path}: HTTP ${status || "error"} — ${JSON.stringify(text).substring(0, 100)}`);
    }
  }

  // ── MARKET DATA ───────────────────────────────────────────────────────────

  /**
   * Historical bars (OHLCV).
   * Tries Webull first; falls back to Yahoo Finance if Webull is unreachable
   * (common when running from cloud datacenter IPs that Webull geo-blocks).
   * Returns [{time, open, high, low, close, volume}]
   */
  async getBars(symbol, interval = "1d", count = 30) {
    // ── 1. Try Webull ────────────────────────────────────────────────────────
    try {
      const granMap = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "1d": "d",  "1w": "1w",   "1mo": "1mo",
      };
      const data = await this.request("GET", "/quotes/bars", null, {
        symbol, granularity: granMap[interval] || "d", count,
      });
      const raw = (data?.data) ? data.data : (Array.isArray(data) ? data : []);
      const bars = raw.map(b => ({
        time:   b.timestamp || b.time || b.t,
        open:   parseFloat(b.open   || b.o),
        high:   parseFloat(b.high   || b.h),
        low:    parseFloat(b.low    || b.l),
        close:  parseFloat(b.close  || b.c),
        volume: parseFloat(b.volume || b.v || 0),
      })).filter(b => b.close > 0);
      if (bars.length > 0) return bars;
    } catch { /* fall through to Yahoo Finance */ }

    // ── 2. Fallback: Yahoo Finance (no API key, accessible from cloud VMs) ───
    return this._getBarsYahoo(symbol, interval, count);
  }

  async _getBarsYahoo(symbol, interval = "1d", count = 30) {
    // Map our interval codes to Yahoo's
    const yhInterval = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
                         "1h": "60m", "1d": "1d", "1w": "1wk", "1mo": "1mo" }[interval] || "1d";
    // Request more range than count to ensure we get enough bars
    const rangeMap   = { "1m": "7d", "5m": "7d", "15m": "60d", "30m": "60d",
                         "1h": "60d", "1d": "3mo", "1w": "2y", "1mo": "5y" };
    const range      = rangeMap[interval] || "3mo";

    // Yahoo Finance uses different ticker formats for some symbols
    const yhSym = symbol.startsWith("^") ? symbol : encodeURIComponent(symbol);
    const url   = `https://query2.finance.yahoo.com/v8/finance/chart/${yhSym}` +
                  `?range=${range}&interval=${yhInterval}&events=div`;

    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`Yahoo Finance HTTP ${resp.status} for ${symbol}`);

    const json       = await resp.json();
    const result     = json?.chart?.result?.[0];
    if (!result)     throw new Error(`Yahoo Finance: no data for ${symbol}`);

    const timestamps = result.timestamp || [];
    const q          = result.indicators.quote[0];

    const bars = timestamps.map((t, i) => ({
      time:   t * 1000,
      open:   parseFloat(q.open[i]   || 0),
      high:   parseFloat(q.high[i]   || 0),
      low:    parseFloat(q.low[i]    || 0),
      close:  parseFloat(q.close[i]  || 0),
      volume: parseFloat(q.volume[i] || 0),
    })).filter(b => b.close > 0);

    // Return only the last `count` bars
    return bars.slice(-count);
  }

  /**
   * Current snapshot (latest quote).
   * Returns {symbol, last, bid, ask, change, changePercent, volume}
   */
  async getSnapshot(symbol) {
    // Try Webull first, fall back to Yahoo Finance
    try {
      const data = await this.request("GET", "/quotes/snapshot", null, { symbol });
      const raw  = data?.data?.[0] || data?.[0] || data;
      const last = parseFloat(raw.close || raw.last || raw.price || 0);
      if (last > 0) return {
        symbol,
        last,
        bid:           parseFloat(raw.bid || 0),
        ask:           parseFloat(raw.ask || 0),
        change:        parseFloat(raw.change || 0),
        changePercent: parseFloat(raw.changeRatio || raw.changePercent || 0),
        volume:        parseFloat(raw.volume || 0),
      };
    } catch { /* fall through */ }

    // Yahoo Finance fallback
    const bars = await this._getBarsYahoo(symbol, "1d", 2);
    if (bars.length < 2) throw new Error(`No snapshot data for ${symbol}`);
    const prev = bars[bars.length - 2].close;
    const last = bars[bars.length - 1].close;
    return {
      symbol,
      last,
      bid: 0, ask: 0,
      change:        Math.round((last - prev) * 100) / 100,
      changePercent: Math.round((last - prev) / prev * 1000) / 10,
      volume:        bars[bars.length - 1].volume,
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
  async getBalance(retries = 3) {
    let lastError;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const data = await this.request("GET", `/account/${this.accountId}/balance`);
        // Cache successful response
        if (data) {
          this._cachedBalance = { data: data?.data || data, timestamp: Date.now() };
        }
        return data?.data || data;
      } catch (err) {
        lastError = err;

        // If geo-blocked (403, CloudFront block), suggest proxy
        if (err.response?.status === 403 || err.message?.includes("403")) {
          if (attempt === 0) {
            log(`⚠️  Webull API geo-blocked (403). Retrying with backoff...`);
          }
          // Exponential backoff: 500ms, 1s, 2s
          if (attempt < retries - 1) {
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          }
        } else {
          // Other errors, retry anyway
          if (attempt < retries - 1) {
            await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          }
        }
      }
    }

    // All retries failed — use cached balance if available
    if (this._cachedBalance) {
      const age = ((Date.now() - this._cachedBalance.timestamp) / 1000 / 60).toFixed(1);
      log(`⚠️  Using cached balance (${age} min old). Configure WEBULL_PROXY_URL to fix geo-blocking.`);
      return this._cachedBalance.data;
    }

    // No cache available — throw error with helpful message
    const msg = lastError?.message || "Unknown error";
    throw new Error(
      `getBalance failed after ${retries} retries: ${msg}\n` +
      `Fix: Set WEBULL_PROXY_URL env var (e.g., WEBULL_PROXY_URL=http://proxy-ip:port)\n` +
      `Free options: SmartProxy, Bright Data, or other residential proxy service`
    );
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
