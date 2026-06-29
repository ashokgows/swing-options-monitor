/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Webull MCP Client — Uses Claude's Webull MCP Connector
 * ═══════════════════════════════════════════════════════════════════════════
 * Connects to: https://api.webull.com/mcp
 * ═══════════════════════════════════════════════════════════════════════════
 */

const axios = require("axios");

const TZ = "America/New_York";

function log(msg) {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
  console.log(`[${t} ET] [Webull MCP] ${msg}`);
}

class WebullMCPClient {
  constructor() {
    this.mcpUrl = "https://api.webull.com/mcp";
    this.accountId = process.env.WEBULL_ACCOUNT_ID;
    this.axiosClient = axios.create({
      timeout: 12000,
      headers: { "User-Agent": "SwingOptionsBot/2.8" },
    });
    this._debug = process.env.DEBUG_WEBULL === "true";
    this.whitelistArr = (process.env.WEBULL_SYMBOL_WHITELIST || "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  validateCredentials() {
    if (!this.accountId) {
      throw new Error("Missing credential: WEBULL_ACCOUNT_ID");
    }
  }

  isSymbolAllowed(symbol) {
    return this.whitelistArr.length === 0 || this.whitelistArr.includes(symbol.toUpperCase());
  }

  // ── MARKET DATA METHODS ────────────────────────────────────────────────────

  async getBars(symbol, timeframe = "1d", limit = 35) {
    try {
      this.validateCredentials();
      if (!this.isSymbolAllowed(symbol)) return null;

      if (this._debug) log(`Fetching ${symbol} bars (${timeframe}, ${limit} bars)`);

      // Call MCP: get_stock_bars
      const response = await this.axiosClient.post(`${this.mcpUrl}`, {
        method: "get_stock_bars",
        params: {
          symbol: symbol.toUpperCase(),
          timeframe: timeframe,
          limit: limit,
        },
      });

      const bars = response.data?.bars || response.data?.data || [];
      if (Array.isArray(bars)) return bars.slice(-limit);
      return null;
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getBars(${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  async getBalance() {
    try {
      this.validateCredentials();
      if (this._debug) log("Fetching account balance");

      // Call MCP: get_account_balance
      const response = await this.axiosClient.post(`${this.mcpUrl}`, {
        method: "get_account_balance",
        params: {
          account_id: this.accountId,
        },
      });

      const balance = response.data?.balance || response.data?.optionBuyingPower || response.data?.buyingPower || 0;
      return {
        balance: parseFloat(balance),
        buyingPower: parseFloat(balance),
        optionBuyingPower: parseFloat(balance),
        cash: parseFloat(balance),
      };
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getBalance() failed: ${e.message}`);
      return null;
    }
  }

  async getOptionChain(symbol, expiryDate) {
    try {
      if (this._debug) log(`Fetching option chain for ${symbol} ${expiryDate}`);

      // MCP may not have direct option chain support, return empty for now
      // This will fall back to Black-Scholes estimation
      return [];
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getOptionChain() failed: ${e.message}`);
      return [];
    }
  }

  async placeOrder(orderParams) {
    try {
      this.validateCredentials();
      if (this._debug) log(`Placing order: ${JSON.stringify(orderParams)}`);

      // MCP read-only tools don't support order placement
      // This will need to fall back to direct API or be implemented separately
      console.warn("Order placement not available via MCP (read-only tools only)");
      return null;
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] placeOrder() failed: ${e.message}`);
      return null;
    }
  }

  async getAccountPositions() {
    try {
      this.validateCredentials();
      if (this._debug) log("Fetching account positions");

      // Call MCP: get_account_positions
      const response = await this.axiosClient.post(`${this.mcpUrl}`, {
        method: "get_account_positions",
        params: {
          account_id: this.accountId,
        },
      });

      return response.data?.positions || [];
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getAccountPositions() failed: ${e.message}`);
      return [];
    }
  }

  async getStockQuote(symbol) {
    try {
      if (!this.isSymbolAllowed(symbol)) return null;

      if (this._debug) log(`Fetching quote for ${symbol}`);

      // Call MCP: get_stock_quotes
      const response = await this.axiosClient.post(`${this.mcpUrl}`, {
        method: "get_stock_quotes",
        params: {
          symbols: [symbol.toUpperCase()],
        },
      });

      const quotes = response.data?.quotes || response.data?.data || [];
      return quotes[0] || null;
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getStockQuote(${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  async getStockSnapshot(symbol) {
    try {
      if (!this.isSymbolAllowed(symbol)) return null;

      if (this._debug) log(`Fetching snapshot for ${symbol}`);

      // Call MCP: get_stock_snapshot
      const response = await this.axiosClient.post(`${this.mcpUrl}`, {
        method: "get_stock_snapshot",
        params: {
          symbol: symbol.toUpperCase(),
        },
      });

      return response.data?.snapshot || response.data?.data || null;
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getStockSnapshot(${symbol}) failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = WebullMCPClient;
