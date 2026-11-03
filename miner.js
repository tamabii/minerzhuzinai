/**
 * Zhenzhu Miner — orchestrator
 *
 * One pass over every miner wallet:
 *   1. read chain state, stop if paused or the daily quota is empty
 *   2. read the wallet's .ai handle; skip it when it has none
 *   3. read the challenge; stop when not eligible or not live
 *   4. search for a proof, re-reading the target whenever the search is cut
 *   5. verify the proof independently, then broadcast
 *   6. sweep the wallet's balance to the payout address
 *
 * Every step is guarded so one bad wallet cannot take the run down. The
 * process exits 0 on a clean stop and non-zero only on an unexpected fault,
 * which is what makes it safe to run from cron.
 */

const fs = require('fs');
const { ethers } = require('ethers');
const config = require('./config');
const log = require('./logger');
const notify = require('./notify');
const chain = require('./chain');
const pow = require('./pow');
const { loadWallets } = require('./wallets');
const { sweepWallet } = require('./sweep');

const MINE_ABI = [
  'function mine(uint256 id, uint256 nonce, uint256 minReward)',
  'function mineBatch(uint256 id, uint256[] nonces, uint256 minTotalReward)',
];

let stopping = false;
function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log.warn(`stop requested: ${reason}`);
  notify.stopped(reason);
}

process.on('SIGINT', () => requestStop('SIGINT received'));
process.on('SIGTERM', () => requestStop('SIGTERM received'));

function fmt(raw) {
  return ethers.formatUnits(raw, 8);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch {
    return { lastRun: null, proofs: 0, swept: 0, wallets: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    log.warn(`state: could not write ${config.stateFile}: ${err.message}`);
  }
}

/** Sleep that a stop request cuts short. */
function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (stopping) {
        clearTimeout(t);
        clearInterval(poll);
        resolve();
      }
    }, 250);
    setTimeout(() => clearInterval(poll), ms + 300);
  });
}

/**
 * Mine one proof for one wallet and broadcast it.
 *
 * @returns {Promise<{txHash: string, reward: string}|null>}
 */
async function mineOne(wallet, label, id, agentId) {
  const token = new ethers.Contract(config.token, MINE_ABI, wallet);
  let startNonce = BigInt(Math.floor(Math.random() * 1e9)) * 1_000_000_000n;
  let attempt = 0;

  // Re-read the challenge between attempts: difficulty rises as the network
  // progresses, so a target read once at the start goes stale.
  while (!stopping && attempt < 6) {
    attempt += 1;
    let ch;
    try {
      ch = await chain.challenge(wallet.address, id);
    } catch (err) {
      log.error(`${label}: challenge read failed: ${err.shortMessage || err.message}`);
      notify.stalled(label, `challenge read failed: ${err.shortMessage || err.message}`);
      return null;
    }

    if (!ch.eligible) {
      log.warn(`${label}: not eligible (no .ai identity for this wallet)`);
      return null;
    }
    if (!ch.live) {
      log.warn(`${label}: mining is not live`);
      return null;
    }
    if (ch.reward <= 0n) {
      log.warn(`${label}: reward is zero`);
      return null;
    }

    const target = ch.target;
    log.info(
      `${label}: attempt ${attempt} target=${pow.bitsOf(target)} bits `
      + `expected=${Number(pow.expectedHashes(target)).toLocaleString()} hashes`,
    );

    const result = await pow.search(ch.seed, target, {
      startNonce,
      maxHashes: config.maxHashesPerProof,
      timeoutMs: config.proofTimeoutMs,
      shouldStop: () => stopping,
    });

    if (!result) {
      log.info(`${label}: search cut short, re-reading the challenge`);
      startNonce += BigInt(config.maxHashesPerProof);
      continue;
    }

    log.info(
      `${label}: proof found nonce=${result.nonce} after ${result.hashes.toLocaleString()} `
      + `hashes in ${(result.ms / 1000).toFixed(1)}s`,
    );

    // Independent verification before spending gas.
    if (!pow.verify(ch.seed, result.nonce, target)) {
      log.error(`${label}: local verification failed, discarding`);
      continue;
    }

    // The contract may have moved on. Re-read and re-check against the latest
    // target, which is what the site's own instructions require.
    try {
      const fresh = await chain.challenge(wallet.address, id);
      if (!fresh.eligible || !fresh.live || fresh.reward <= 0n) {
        log.warn(`${label}: state changed before broadcast, re-searching`);
        continue;
      }
      if (!pow.verify(ch.seed, result.nonce, fresh.target)) {
        log.warn(`${label}: target rose, proof no longer valid, re-searching`);
        continue;
      }
    } catch (err) {
      log.error(`${label}: pre-broadcast re-read failed: ${err.shortMessage || err.message}`);
      continue;
    }

    // Reward floor: accept at most a 1% reduction, per the site's guidance.
    const minReward = (ch.reward * BigInt(config.minRewardBps)) / 10_000n;

    let lastErr = null;
    for (let i = 0; i < config.broadcastRetries && !stopping; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const gas = await token.mine.estimateGas(id, result.nonce, minReward);
        // eslint-disable-next-line no-await-in-loop
        const tx = await token.mine(id, result.nonce, minReward, {
          gasLimit: (gas * 12n) / 10n,
        });
        log.info(`${label}: broadcast ${tx.hash}`);
        // eslint-disable-next-line no-await-in-loop
        const receipt = await tx.wait(1);
        if (receipt.status !== 1) {
          log.error(`${label}: mine() reverted`);
          notify.error(label, 'mine() reverted on-chain');
          return null;
        }
        const reward = fmt(ch.reward);
        log.info(`${label}: confirmed in block ${receipt.blockNumber}, reward ${reward}`);
        notify.mined(label, reward, tx.hash, ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || 0n)));
        return { txHash: tx.hash, reward };
      } catch (err) {
        lastErr = err;
        log.warn(`${label}: broadcast attempt ${i + 1} failed: ${err.shortMessage || err.message}`);
        // eslint-disable-next-line no-await-in-loop
        await delay(3000);
      }
    }

    log.error(`${label}: broadcast gave up: ${lastErr && (lastErr.shortMessage || lastErr.message)}`);
    notify.error(label, `broadcast failed: ${lastErr && (lastErr.shortMessage || lastErr.message)}`);
    return null;
  }

  return null;
}

async function main() {
  log.info('=== Zhenzhu miner starting ===');
  const wallets = loadWallets();
  if (wallets.size === 0) {
    const msg = 'no miner wallets loaded, nothing to do';
    log.warn(msg);
    notify.stopped(msg);
    return;
  }

  notify.started(wallets.size);
  const state = loadState();
  state.lastRun = new Date().toISOString();

  // --- chain state -------------------------------------------------------
  let st;
  try {
    st = await chain.readState();
  } catch (err) {
    const msg = `could not read chain state: ${err.shortMessage || err.message}`;
    log.error(msg);
    notify.stopped(msg);
    process.exitCode = 1;
    return;
  }

  log.info(
    `state: live=${st.isLive} paused=${st.paused} stage=${st.currentStage} `
    + `dailyRemaining=${fmt(st.dailyRemaining)} proofs=${st.successfulProofs}`,
  );

  if (st.paused) {
    requestStop('mining is paused on-chain');
    return;
  }
  if (!st.isLive) {
    requestStop('mining is not live');
    return;
  }
  if (st.dailyRemaining < config.minDailyRemainingRaw) {
    notify.quotaEmpty('all miners', fmt(st.dailyRemaining));
    requestStop(`daily quota nearly empty (${fmt(st.dailyRemaining)} left)`);
    return;
  }

  // --- per wallet --------------------------------------------------------
  for (const [label, wallet] of wallets) {
    if (stopping) break;

    // Gas check: a proof that cannot be broadcast is wasted CPU.
    try {
      // eslint-disable-next-line no-await-in-loop
      const bnb = await chain.bnbBalance(wallet.address);
      if (bnb < 0.0005) {
        log.warn(`${label}: low gas ${bnb} BNB`);
        notify.lowGas(label, bnb.toFixed(6));
        continue;
      }
    } catch (err) {
      log.warn(`${label}: gas check failed: ${err.shortMessage || err.message}`);
    }

    // .ai identity check.
    let handle;
    try {
      // eslint-disable-next-line no-await-in-loop
      handle = await chain.handleOf(wallet.address);
    } catch (err) {
      log.error(`${label}: handleOf failed: ${err.shortMessage || err.message}`);
      continue;
    }
    if (!handle) {
      log.warn(`${label}: no .ai identity registered, skipping`);
      state.wallets[label] = { ...(state.wallets[label] || {}), eligible: false };
      continue;
    }
    log.info(`${label}: identity "${handle}"`);

    // The agent id is keccak256 of the raw name in UTF-8, as uint256, with no
    // .ai suffix appended.
    const id = BigInt(ethers.keccak256(ethers.toUtf8Bytes(handle)));

    // eslint-disable-next-line no-await-in-loop
    const mined = await mineOne(wallet, label, id, handle);
    if (mined) {
      state.proofs += 1;
      state.wallets[label] = {
        ...(state.wallets[label] || {}),
        eligible: true,
        lastTx: mined.txHash,
        lastReward: mined.reward,
        lastAt: new Date().toISOString(),
      };
      saveState(state);

      // Sweep so the reward lands in the payout wallet.
      // eslint-disable-next-line no-await-in-loop
      await sweepWallet(wallet, label);
    }
  }

  saveState(state);
  log.info(`=== run complete: ${state.proofs} proof(s) this session ===`);
}

main().catch((err) => {
  log.error(`fatal: ${err.stack || err.message}`);
  notify.stopped(`fatal: ${err.message}`);
  process.exitCode = 1;
});
