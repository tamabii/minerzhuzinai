/**
 * Zhenzhu Miner — chain access with RPC failover
 *
 * Every read goes through a provider that fails over to the next endpoint when
 * one stalls or errors. A miner that dies because one RPC hiccuped is a miner
 * that loses money, so this is the one place that knows about endpoints.
 */

const { ethers } = require('ethers');
const config = require('./config');
const log = require('./logger');
const notify = require('./notify');

const TOKEN_ABI = [
  'function WORK_BITS() view returns (uint256)',
  'function DIFFICULTY_NUMERATOR() view returns (uint256)',
  'function DIFFICULTY_DENOMINATOR() view returns (uint256)',
  'function EMISSION_K() view returns (uint256)',
  'function MAX_BATCH() view returns (uint256)',
  'function MINING_SUPPLY() view returns (uint256)',
  'function DAILY_MINING_CAP() view returns (uint256)',
  'function currentStage() view returns (uint256)',
  'function dailyRemaining() view returns (uint256)',
  'function miningDay() view returns (uint256)',
  'function paused() view returns (bool)',
  'function startsAt() view returns (uint256)',
  'function isLive() view returns (bool)',
  'function cumulativeMining(uint256 claims) pure returns (uint256)',
  'function challenge(address wallet, uint256 id) view returns (bytes32 seed, uint256 target, uint256 reward, bool eligible, bool live, uint256 claims)',
  'function mine(uint256 id, uint256 nonce, uint256 minReward)',
  'function mineBatch(uint256 id, uint256[] nonces, uint256 minTotalReward)',
  'function balanceOf(address account) view returns (uint256)',
  'function successfulProofs() view returns (uint256)',
  'function currentTarget() view returns (uint256)',
  'function publicChallenge() view returns (bytes32)',
  'function proofDigest(address wallet, uint256 nonce) view returns (bytes32)',
  'function usedProofs(bytes32) view returns (bool)',
  'event Mined(address indexed miner, uint256 indexed agentId, bytes32 indexed proof, uint256 nonce, uint256 claimIndex, uint256 reward)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const REGISTRY_ABI = ['function handleOf(address) view returns (string)'];

const endpoints = [config.rpc, ...config.rpcFallbacks];
let current = 0;
let provider = null;
let token = null;
let registry = null;
let notifiedRpc = false;

function connect(index) {
  const url = endpoints[index];
  const p = new ethers.JsonRpcProvider(url, config.chainId, {
    staticNetwork: true,
  });
  return {
    provider: p,
    token: new ethers.Contract(config.token, TOKEN_ABI, p),
    registry: new ethers.Contract(config.registry, REGISTRY_ABI, p),
  };
}

function ensure() {
  if (!provider) {
    const c = connect(current);
    provider = c.provider;
    token = c.token;
    registry = c.registry;
  }
  return { provider, token, registry };
}

/**
 * Run a call against the current endpoint, failing over on error.
 * @param {function} fn receives (token, registry, provider)
 * @param {string} label for logs
 */
async function withFailover(fn, label = 'call') {
  ensure();
  const attempts = endpoints.length;
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    const idx = (current + i) % attempts;
    try {
      if (idx !== current) {
        const c = connect(idx);
        provider = c.provider;
        token = c.token;
        registry = c.registry;
        current = idx;
        log.warn(`rpc: failed over to ${endpoints[idx]}`);
        if (!notifiedRpc) {
          notifiedRpc = true;
          notify.rpcDown(`Now using ${endpoints[idx]}`);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await fn(token, registry, provider);
      notifiedRpc = false;
      return result;
    } catch (err) {
      lastErr = err;
      log.warn(`rpc: ${label} failed on ${endpoints[idx]}: ${err.shortMessage || err.message}`);
    }
  }
  throw lastErr || new Error(`${label}: all endpoints failed`);
}

/** Current block number, used as a liveness probe. */
async function blockNumber() {
  return withFailover((t, r, p) => p.getBlockNumber(), 'blockNumber');
}

/** Full miner state, read in one pass. */
async function readState() {
  return withFailover(async (t) => {
    const [
      workBits, diffNum, diffDen, emissionK, maxBatch,
      miningSupply, dailyCap, currentStage, dailyRemaining, miningDay,
      paused, startsAt, isLive, successfulProofs, currentTarget, publicChallenge,
    ] = await Promise.all([
      t.WORK_BITS(), t.DIFFICULTY_NUMERATOR(), t.DIFFICULTY_DENOMINATOR(),
      t.EMISSION_K(), t.MAX_BATCH(), t.MINING_SUPPLY(), t.DAILY_MINING_CAP(),
      t.currentStage(), t.dailyRemaining(), t.miningDay(), t.paused(),
      t.startsAt(), t.isLive(), t.successfulProofs(), t.currentTarget(),
      t.publicChallenge(),
    ]);
    return {
      workBits: Number(workBits),
      difficultyNumerator: Number(diffNum),
      difficultyDenominator: Number(diffDen),
      emissionK: Number(emissionK),
      maxBatch: Number(maxBatch),
      miningSupply,
      dailyCap,
      currentStage: Number(currentStage),
      dailyRemaining,
      miningDay: Number(miningDay),
      paused,
      startsAt: Number(startsAt),
      isLive,
      successfulProofs: Number(successfulProofs),
      currentTarget,
      publicChallenge,
    };
  }, 'readState');
}

/** The .ai handle registered for a wallet, or '' when it has none. */
async function handleOf(wallet) {
  return withFailover((t, r) => r.handleOf(wallet), 'handleOf');
}

/** The challenge for a wallet and agent id. */
async function challenge(wallet, id) {
  return withFailover((t) => t.challenge(wallet, id), 'challenge');
}

/** Token balance of an address, as a formatted string. */
async function balanceOf(address) {
  return withFailover((t) => t.balanceOf(address), 'balanceOf');
}

/** Native BNB balance of an address, in BNB. */
async function bnbBalance(address) {
  return withFailover(async (t, r, p) => {
    const wei = await p.getBalance(address);
    return Number(ethers.formatEther(wei));
  }, 'bnbBalance');
}

/** Whether a proof digest has already been used. */
async function usedProof(digest) {
  return withFailover((t) => t.usedProofs(digest), 'usedProofs');
}

module.exports = {
  ensure,
  withFailover,
  blockNumber,
  readState,
  handleOf,
  challenge,
  balanceOf,
  bnbBalance,
  usedProof,
  endpoints,
  currentEndpoint: () => endpoints[current],
};
