/**
 * Zhenzhu Miner — wallet loading
 *
 * Keys live in a plain text file, one private key per line, with an optional
 * label after whitespace. The file is never logged and keys are never printed.
 *
 *   0xabc123...            wallet-1
 *   0xdef456...            wallet-2
 *   # a comment line
 *
 * An empty file is not an error: the miner starts, reports that it has nothing
 * to mine with, and exits cleanly rather than crashing a cron job.
 */

const fs = require('fs');
const { ethers } = require('ethers');
const config = require('./config');
const log = require('./logger');

/**
 * @returns {Map<string, ethers.Wallet>} label -> wallet, in file order
 */
function loadWallets() {
  const wallets = new Map();
  let raw;
  try {
    raw = fs.readFileSync(config.keysFile, 'utf8');
  } catch {
    log.warn(`keys: ${config.keysFile} not readable, no miners loaded`);
    return wallets;
  }

  const lines = raw.split(/\r?\n/);
  let auto = 0;
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    // Split on whitespace; first token is the key, the rest is a label.
    const parts = trimmed.split(/\s+/);
    const key = parts[0];
    const label = parts.slice(1).join(' ') || `miner-${(auto += 1)}`;

    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      log.warn(`keys: line ${idx + 1} is not a 32-byte hex key, skipped`);
      return;
    }

    try {
      const wallet = new ethers.Wallet(key);
      if (wallets.has(label)) {
        log.warn(`keys: duplicate label "${label}", skipping the second entry`);
        return;
      }
      wallets.set(label, wallet);
      log.info(`keys: loaded ${label} -> ${wallet.address}`);
    } catch (err) {
      log.warn(`keys: line ${idx + 1} could not be parsed: ${err.message}`);
    }
  });

  return wallets;
}

/** The payout wallet, for display only. Never holds a key here. */
function payoutAddress() {
  return config.payoutWallet;
}

module.exports = { loadWallets, payoutAddress };
