/**
 * Zhenzhu Miner — Telegram notifier
 *
 * Sends alerts when the miner stops, stalls, fails, or sweeps a reward.
 * Silently does nothing when Telegram is not configured, so the miner runs
 * fine without it.
 */

const https = require('https');
const config = require('./config');
const log = require('./logger');

const enabled = Boolean(config.telegram.token && config.telegram.chatId);

/** Escape the five characters Telegram's Markdown parser treats specially. */
function esc(s) {
  return String(s).replace(/([_*`[\]])/g, '\\$1');
}

function post(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        host: 'api.telegram.org',
        path: `/bot${config.telegram.token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15_000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.warn(`telegram: HTTP ${res.statusCode} ${d.slice(0, 200)}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', (e) => { log.warn(`telegram: ${e.message}`); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function send(text) {
  if (!enabled) {
    log.debug(`notify (telegram off): ${text.replace(/\n/g, ' | ')}`);
    return false;
  }
  return post({
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

module.exports = {
  enabled,
  send,

  // --- the alerts the operator asked for ---------------------------------
  async started(miners) {
    return send(
      `🟢 *Zhenzhu miner started*\n`
      + `${esc(miners)} miner wallet(s) loaded\n`
      + `Payout → \`${esc(config.payoutWallet)}\``,
    );
  },

  async mined(label, amount, txHash, gasCost) {
    return send(
      `💎 *Proof mined* — ${esc(label)}\n`
      + `Reward: ${esc(amount)} 珍珠币\n`
      + `Gas: ${esc(gasCost)} BNB\n`
      + `[tx](https://bscscan.com/tx/${esc(txHash)})`,
    );
  },

  async swept(label, amount, txHash) {
    return send(
      `📤 *Swept to wallet 1* — ${esc(label)}\n`
      + `${esc(amount)} 珍珠币 → \`${esc(config.payoutWallet)}\`\n`
      + `[tx](https://bscscan.com/tx/${esc(txHash)})`,
    );
  },

  async stopped(reason) {
    return send(`🔴 *Zhenzhu miner stopped*\n${esc(reason)}`);
  },

  async stalled(label, detail) {
    return send(
      `🟠 *Miner stalled* — ${esc(label)}\n${esc(detail)}\n`
      + `Will retry; the process is still alive.`,
    );
  },

  async quotaEmpty(label, remaining) {
    return send(
      `🟡 *Daily quota empty* — ${esc(label)}\n`
      + `Remaining: ${esc(remaining)} 珍珠币\n`
      + `Pausing until the next mining day.`,
    );
  },

  async rpcDown(detail) {
    return send(`🟠 *RPC trouble*\n${esc(detail)}\nFailing over to a backup endpoint.`);
  },

  async lowGas(label, balanceBnb) {
    return send(
      `🟠 *Low gas* — ${esc(label)}\n`
      + `Balance: ${esc(balanceBnb)} BNB\n`
      + `Top up or the next proof cannot be broadcast.`,
    );
  },

  async error(label, message) {
    return send(`🔴 *Error* — ${esc(label)}\n\`${esc(message).slice(0, 300)}\``);
  },
};
