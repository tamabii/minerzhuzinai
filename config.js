/**
 * Zhenzhu Miner — config
 *
 * Pearl Coin (珍珠币) PoW miner for BNB Smart Chain.
 * Mines with any wallet that holds a .ai identity, sweeps the reward to a
 * single destination wallet.
 *
 * Nothing here is a secret except the miner keys, which live in miner-keys.txt
 * (one private key per line) and are never logged.
 */

const path = require('path');

const config = {
  // --- chain -------------------------------------------------------------
  chainId: 56,
  rpc: process.env.ZZ_RPC || 'https://bsc-rpc.publicnode.com',
  // Fallback RPCs, tried in order when the primary fails or stalls.
  rpcFallbacks: [
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://rpc.ankr.com/bsc',
  ],

  // --- contracts (verified on-chain, do not change without re-verifying) --
  token: '0x7E2DA878217EB995F9e5d36eD32c9Cea52442681',
  registry: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',

  // --- reward destination ------------------------------------------------
  // Every miner's reward is swept here. Set via env or edit directly.
  payoutWallet: process.env.ZZ_PAYOUT || '0xa0F64e1719f063c732EA8f436F774f1f13d9c79F',

  // --- miner keys --------------------------------------------------------
  // File with one private key per line. Lines starting with # are comments.
  // An optional label may follow the key after whitespace: 0xabc...  wallet-3
  keysFile: process.env.ZZ_KEYS || path.join(__dirname, 'miner-keys.txt'),

  // --- mining parameters -------------------------------------------------
  // Reward floor: submit only if reward >= this fraction of the quoted reward.
  // 0.99 means accept up to a 1% reduction, per the site's own guidance.
  minRewardBps: 9900,
  // Stop searching a single proof after this many hashes and re-read the
  // challenge. Difficulty rises as the network progresses, so a stale target
  // wastes work.
  maxHashesPerProof: 40_000_000,
  // Wall-clock cap for one proof search.
  proofTimeoutMs: 600_000,
  // How often to re-read chain state while mining.
  pollIntervalMs: 30_000,
  // Gas ceiling for the mine() call. The call is value=0, so this only needs
  // to cover execution.
  gasLimit: 400_000,
  // Retries for a broadcast that fails transiently.
  broadcastRetries: 3,

  // --- daily quota guard -------------------------------------------------
  // Do not start a new proof if dailyRemaining is below this many raw units.
  // The contract refuses anyway; this avoids burning gas on a doomed call.
  minDailyRemainingRaw: 1_000_000_000n, // 10 tokens at 8 decimals

  // --- notifications -----------------------------------------------------
  // Telegram. Leave blank to disable. The bot token and chat id are read from
  // the environment so they never sit in the repo.
  telegram: {
    token: process.env.ZZ_TG_TOKEN || '',
    chatId: process.env.ZZ_TG_CHAT || '',
  },

  // --- paths -------------------------------------------------------------
  stateFile: path.join(__dirname, 'state.json'),
  logFile: path.join(__dirname, 'miner.log'),
};

module.exports = config;
