/**
 * Webull Remote Client — Calls Python SDK on GCP VM via SSH
 * Executes SDK commands on the VM and returns results to local bot
 */

const { execSync } = require("child_process");

class WebullRemoteClient {
  constructor() {
    this.vm_user = "ubuntu";
    this.vm_ip = "localhost"; // via IAP tunnel
    this.vm_port = 2247;
    this.ssh_key = process.env.SSH_KEY || `${process.env.HOME}/.ssh/id_rsa`;
    this.accountId = process.env.WEBULL_ACCOUNT_ID;
    this.appKey = process.env.WEBULL_APP_KEY;
    this.appSecret = process.env.WEBULL_APP_SECRET;
    this._debug = process.env.DEBUG_WEBULL === "true";
  }

  /**
   * Execute Python code on remote VM via SSH
   */
  execRemote(pythonCode) {
    try {
      const cmd = `ssh -i ${this.ssh_key} -p ${this.vm_port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${this.vm_user}@${this.vm_ip} "python3 -c '${pythonCode.replace(/'/g, "'\\''")}'"`;

      if (this._debug) console.log(`[SSH] Executing: ${cmd.substring(0, 100)}...`);

      const result = execSync(cmd, { timeout: 20000, encoding: "utf8" });
      return result.trim();
    } catch (e) {
      throw new Error(`Remote execution failed: ${e.message}`);
    }
  }

  /**
   * Get historical bars from Webull SDK on VM
   */
  async getBars(symbol, timeframe = "1d", limit = 35) {
    try {
      const code = `
import json
from webull.trade.trade_client import TradeClient
client = TradeClient(app_key='${this.appKey}', app_secret='${this.appSecret}')
bars = client.get_bars(symbol='${symbol}', timeframe='${timeframe}', limit=${limit})
print(json.dumps(bars if bars else []))
`.replace(/\n/g, ";");

      const result = this.execRemote(code);
      const bars = JSON.parse(result || "[]");
      return Array.isArray(bars) ? bars : [];
    } catch (e) {
      console.warn(`[Webull] getBars(${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Get account balance from Webull SDK on VM
   */
  async getBalance() {
    try {
      const code = `
import json
from webull.trade.trade_client import TradeClient
client = TradeClient(app_key='${this.appKey}', app_secret='${this.appSecret}')
account = client.get_account_balance(account_id='${this.accountId}')
print(json.dumps({
    'balance': account.get('accountValue', 0) if isinstance(account, dict) else 0,
    'buyingPower': account.get('optionBuyingPower', 0) if isinstance(account, dict) else 0,
    'cash': account.get('cash', 0) if isinstance(account, dict) else 0
}))
`.replace(/\n/g, ";");

      const result = this.execRemote(code);
      const data = JSON.parse(result || "{}");
      return {
        balance: parseFloat(data.balance || 0),
        buyingPower: parseFloat(data.buyingPower || 0),
        optionBuyingPower: parseFloat(data.buyingPower || 0),
        cash: parseFloat(data.cash || 0),
      };
    } catch (e) {
      console.warn(`[Webull] getBalance failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Get option chain from Webull SDK on VM
   */
  async getOptionChain(symbol, expiryDate) {
    try {
      const code = `
import json
from webull.trade.trade_client import TradeClient
client = TradeClient(app_key='${this.appKey}', app_secret='${this.appSecret}')
chain = client.get_option_chain(symbol='${symbol}', expiration_date='${expiryDate}')
print(json.dumps(chain if chain else []))
`.replace(/\n/g, ";");

      const result = this.execRemote(code);
      return JSON.parse(result || "[]");
    } catch (e) {
      console.warn(`[Webull] getOptionChain(${symbol}) failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Place option order via Webull SDK on VM
   */
  async placeOptionOrder(order) {
    try {
      const { symbol, optionType, strike, expiryDate, quantity, limitPrice, side } = order;

      const code = `
import json
from webull.trade.trade_client import TradeClient
client = TradeClient(app_key='${this.appKey}', app_secret='${this.appSecret}')
result = client.place_option_order(
    account_id='${this.accountId}',
    symbol='${symbol}',
    option_type='${optionType}',
    strike_price=${strike},
    expiration_date='${expiryDate}',
    quantity=${quantity},
    order_type='LIMIT' if ${limitPrice} else 'MARKET',
    limit_price=${limitPrice || 0},
    side='${side || "BUY"}'
)
print(json.dumps({'order_id': result.get('order_id'), 'status': result.get('status')}))
`.replace(/\n/g, ";");

      const result = this.execRemote(code);
      const res = JSON.parse(result || "{}");
      return { orderId: res.order_id, status: res.status || "SUBMITTED", raw: res };
    } catch (e) {
      console.warn(`[Webull] placeOptionOrder failed: ${e.message}`);
      return null;
    }
  }
}

module.exports = WebullRemoteClient;
