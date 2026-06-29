/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Webull SDK Wrapper — Uses Official Python SDK via Node child_process
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { spawn } = require("child_process");
const path = require("path");

const TZ = "America/New_York";

function log(msg) {
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
  console.log(`[${t} ET] [Webull SDK] ${msg}`);
}

class WebullSDKWrapper {
  constructor() {
    this.accountId = process.env.WEBULL_ACCOUNT_ID;
    this.appKey = process.env.WEBULL_APP_KEY;
    this.appSecret = process.env.WEBULL_APP_SECRET;
    this.whitelistArr = (process.env.WEBULL_SYMBOL_WHITELIST || "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    this._debug = process.env.DEBUG_WEBULL === "true";
  }

  validateCredentials() {
    if (!this.accountId || !this.appKey || !this.appSecret) {
      throw new Error("Missing credentials: WEBULL_ACCOUNT_ID, WEBULL_APP_KEY, WEBULL_APP_SECRET");
    }
  }

  isSymbolAllowed(symbol) {
    return this.whitelistArr.length === 0 || this.whitelistArr.includes(symbol.toUpperCase());
  }

  // Execute Python SDK command
  async executePython(pythonCode) {
    return new Promise((resolve, reject) => {
      const python = spawn("python3", ["-c", pythonCode], {
        timeout: 15000,
      });

      let stdout = "";
      let stderr = "";

      python.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      python.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      python.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python error: ${stderr || stdout}`));
        } else {
          resolve(stdout.trim());
        }
      });

      python.on("error", (err) => {
        reject(err);
      });
    });
  }

  // Get historical bars
  async getBars(symbol, timeframe = "1d", limit = 35) {
    try {
      this.validateCredentials();
      if (!this.isSymbolAllowed(symbol)) return null;

      if (this._debug) log(`Fetching ${symbol} bars (${timeframe}, ${limit})`);

      const code = `
import json
from webull_openapi import ApiClient

client = ApiClient(
    app_key="${this.appKey}",
    app_secret="${this.appSecret}",
    region_id="us"
)
bars = client.get_bars(
    symbol="${symbol.toUpperCase()}",
    timeframe="${timeframe}",
    limit=${limit}
)
print(json.dumps(bars if bars else []))
`;

      const result = await this.executePython(code);
      const bars = JSON.parse(result || "[]");
      return Array.isArray(bars) ? bars : [];
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getBars(${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  // Get account balance
  async getBalance() {
    try {
      this.validateCredentials();
      if (this._debug) log("Fetching account balance");

      const code = `
import json
from webull_openapi import ApiClient

client = ApiClient(
    app_key="${this.appKey}",
    app_secret="${this.appSecret}",
    region_id="us"
)
account = client.get_account_balance(account_id="${this.accountId}")
print(json.dumps({
    "balance": account.get("accountValue", 0),
    "buyingPower": account.get("optionBuyingPower", 0),
    "optionBuyingPower": account.get("optionBuyingPower", 0),
    "cash": account.get("cash", 0)
}))
`;

      const result = await this.executePython(code);
      const data = JSON.parse(result || "{}");
      return {
        balance: parseFloat(data.balance || 0),
        buyingPower: parseFloat(data.buyingPower || 0),
        optionBuyingPower: parseFloat(data.optionBuyingPower || 0),
        cash: parseFloat(data.cash || 0),
      };
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getBalance() failed: ${e.message}`);
      return null;
    }
  }

  // Get option chain
  async getOptionChain(symbol, expiryDate) {
    try {
      if (this._debug) log(`Fetching option chain for ${symbol} ${expiryDate}`);

      const code = `
import json
from webull_openapi import ApiClient

client = ApiClient(
    app_key="${this.appKey}",
    app_secret="${this.appSecret}",
    region_id="us"
)
chain = client.get_option_chain(
    symbol="${symbol.toUpperCase()}",
    expiration_date="${expiryDate}"
)
print(json.dumps(chain if chain else []))
`;

      const result = await this.executePython(code);
      return JSON.parse(result || "[]");
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] getOptionChain() failed: ${e.message}`);
      return [];
    }
  }

  // Place option order
  async placeOptionOrder(order) {
    try {
      this.validateCredentials();
      const { symbol, optionType, strike, expiryDate, quantity, limitPrice, side } = order;

      if (this._debug) log(`Placing ${optionType} order: ${symbol} ${strike} exp ${expiryDate}`);

      const code = `
import json
from webull_openapi import ApiClient

client = ApiClient(
    app_key="${this.appKey}",
    app_secret="${this.appSecret}",
    region_id="us"
)
order_result = client.place_option_order(
    account_id="${this.accountId}",
    symbol="${symbol.toUpperCase()}",
    option_type="${optionType.toUpperCase()}",
    strike_price=${strike},
    expiration_date="${expiryDate}",
    quantity=${quantity},
    order_type="LIMIT" if ${limitPrice} else "MARKET",
    limit_price=${limitPrice || 0},
    side="${(side || 'BUY').toUpperCase()}"
)
print(json.dumps({"order_id": order_result.get("order_id"), "status": order_result.get("status")}))
`;

      const result = await this.executePython(code);
      const res = JSON.parse(result || "{}");
      return { orderId: res.order_id, status: res.status || "SUBMITTED", raw: res };
    } catch (e) {
      console.warn(`[${new Date().toISOString()}] placeOptionOrder() failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = WebullSDKWrapper;
