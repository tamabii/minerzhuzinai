/**
 * Zhenzhu Miner — sweep
 *
 * mine() always pays msg.sender, so a wallet holding a .ai identity mines into
 * itself. This moves the balance onward to the single payout wallet with
 * transfer(), which is one cheap call rather than one per proof.
 */

const { ethers } = require('ethers');
const config = require('./config');
const log = require('./logger');
const notify = require('./notify');

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

/**
 * Sweep the whole token balance of one wallet to the payout address.
 *
 * @param {ethers.Wallet} wallet the miner wallet, already connected
 * @param {string} label for logs and notifications
 * @returns {Promise<{txHash: string, amount: string}|null>} null when there
 *          was nothing to sweep or the transfer failed
 */
async function sweepWallet(wallet, label) {
  const token = new ethers.Contract(config.token, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);
  if (balance === 0n) {
    log.debug(`sweep: ${label} has nothing to move`);
    return null;
  }

  const amount = ethers.formatUnits(balance, 8);
  log.info(`sweep: ${label} moving ${amount} to ${config.payoutWallet}`);

  try {
    // Estimate first so a revert costs nothing.
    // eslint-disable-next-line no-await-in-loop
    await token.transfer.estimateGas(config.payoutWallet, balance);
    const tx = await token.transfer(config.payoutWallet, balance, {
      gasLimit: 120_000,
    });
    log.info(`sweep: ${label} broadcast ${tx.hash}`);
    // eslint-disable-next-line no-await-in-loop
    const receipt = await tx.wait(1);
    if (receipt.status === 1) {
      log.info(`sweep: ${label} confirmed in block ${receipt.blockNumber}`);
      notify.swept(label, amount, tx.hash);
      return { txHash: tx.hash, amount };
    }
    log.error(`sweep: ${label} reverted on-chain`);
    notify.error(label, 'sweep transaction reverted');
    return null;
  } catch (err) {
    log.error(`sweep: ${label} failed: ${err.shortMessage || err.message}`);
    notify.error(label, `sweep failed: ${err.shortMessage || err.message}`);
    return null;
  }
}

/**
 * Sweep every miner wallet in turn. One failure does not stop the others.
 *
 * @param {Map<string, ethers.Wallet>} wallets label -> wallet
 * @returns {Promise<Array<{label: string, txHash: string, amount: string}>>}
 */
async function sweepAll(wallets) {
  const results = [];
  for (const [label, wallet] of wallets) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sweepWallet(wallet, label);
    if (r) results.push({ label, ...r });
  }
  return results;
}

module.exports = { sweepWallet, sweepAll };
