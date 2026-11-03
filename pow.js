/**
 * Zhenzhu Miner — proof-of-work search
 *
 * The contract's rule:
 *   uint256(keccak256(abi.encode(bytes32 seed, uint256 nonce))) <= target
 *
 * abi.encode of two static words is their concatenation: 32 bytes of seed
 * followed by 32 bytes of big-endian nonce, 64 bytes total. Ethereum keccak-256,
 * not SHA3-256.
 *
 * Node's crypto module does not expose keccak, so this uses js-sha3. Measured
 * on the target host: ~265k hashes/s through the arrayBuffer path used here.
 * A 30-bit target needs ~1.07e9 hashes on average, so roughly 70 minutes per
 * proof single-threaded, and the machine has two cores.
 */

const { keccak256 } = require('js-sha3');

const SEED_LEN = 32;
const NONCE_LEN = 32;
const INPUT_LEN = SEED_LEN + NONCE_LEN; // 64

// Reused across the whole search: the input buffer and a DataView over a
// scratch ArrayBuffer for reading the digest's top word.
const input = Buffer.alloc(INPUT_LEN);
const scratch = new ArrayBuffer(32);
const scratchView = new DataView(scratch);

/**
 * Write a nonce into the tail of the shared input buffer, big-endian.
 * The seed occupies the first 32 bytes and is written once per search.
 */
function writeNonce(nonce) {
  // Low 64 bits.
  input.writeBigUInt64BE(nonce & 0xffffffffffffffffn, INPUT_LEN - 8);
  // Nonces above 2^64 are not reachable in practice, but write the high words
  // rather than silently truncating.
  if (nonce > 0xffffffffffffffffn) {
    const hi = nonce >> 64n;
    input.writeBigUInt64BE(hi & 0xffffffffffffffffn, INPUT_LEN - 16);
    input.writeBigUInt64BE((hi >> 64n) & 0xffffffffn, INPUT_LEN - 24);
  }
}

/**
 * Search for a nonce whose digest is at or below target.
 *
 * @param {string} seedHex 32-byte hex string, with or without 0x
 * @param {bigint} target the contract's current target
 * @param {object} [opts]
 * @param {bigint} [opts.startNonce] where to begin, for resuming
 * @param {number} [opts.maxHashes] stop after this many and re-read the target
 * @param {number} [opts.timeoutMs] wall-clock cap
 * @param {() => boolean} [opts.shouldStop] external abort, polled on each yield
 * @returns {Promise<{nonce: bigint, digest: string, hashes: number, ms: number}|null>}
 *          null when the search was cut short by a cap or an abort.
 */
async function search(seedHex, target, opts = {}) {
  const startNonce = opts.startNonce ?? 0n;
  const maxHashes = opts.maxHashes ?? 40_000_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const shouldStop = opts.shouldStop;

  const seed = Buffer.from(seedHex.replace(/^0x/, ''), 'hex');
  if (seed.length !== SEED_LEN) {
    throw new Error(`seed must be ${SEED_LEN} bytes, got ${seed.length}`);
  }
  seed.copy(input, 0);

  // The top 64 bits of the target. Comparing the digest's top word against
  // this rejects essentially every candidate without touching the other 24
  // bytes, which is what makes the loop fast.
  const targetTop = target >> 192n;

  const started = Date.now();
  let hashes = 0;
  let nonce = startNonce;

  // Yield to the event loop periodically so notifications, state polling and
  // the abort check still run while the search is hot.
  const YIELD_EVERY = 100_000;

  while (hashes < maxHashes) {
    writeNonce(nonce);

    const ab = keccak256.arrayBuffer(input);
    const view = new DataView(ab);
    const top = view.getBigUint64(0, false);

    if (top <= targetTop) {
      // The top word passes; compare all 32 bytes to be exact.
      let v = 0n;
      for (let i = 0; i < 32; i += 1) {
        v = (v << 8n) | BigInt(view.getUint8(i));
      }
      if (v <= target) {
        return {
          nonce,
          digest: '0x' + Buffer.from(ab).toString('hex'),
          hashes: hashes + 1,
          ms: Date.now() - started,
        };
      }
    }

    hashes += 1;
    nonce += 1n;

    if (hashes % YIELD_EVERY === 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setImmediate(r));
      if (Date.now() - started > timeoutMs) return null;
      if (shouldStop && shouldStop()) return null;
    }
  }

  return null;
}

/**
 * The digest the contract will compute, for independent verification before
 * broadcasting. Must match search()'s construction exactly.
 *
 * @param {string} seedHex
 * @param {bigint} nonce
 * @returns {string} 0x-prefixed 32-byte hex
 */
function digestOf(seedHex, nonce) {
  const seed = Buffer.from(seedHex.replace(/^0x/, ''), 'hex');
  const buf = Buffer.alloc(INPUT_LEN);
  seed.copy(buf, 0);
  buf.writeBigUInt64BE(nonce & 0xffffffffffffffffn, INPUT_LEN - 8);
  if (nonce > 0xffffffffffffffffn) {
    const hi = nonce >> 64n;
    buf.writeBigUInt64BE(hi & 0xffffffffffffffffn, INPUT_LEN - 16);
    buf.writeBigUInt64BE((hi >> 64n) & 0xffffffffn, INPUT_LEN - 24);
  }
  return '0x' + keccak256.hex(buf);
}

/**
 * Independent verification that a candidate satisfies the rule. Used before
 * every broadcast, because a wasted transaction costs real gas.
 *
 * @returns {boolean}
 */
function verify(seedHex, nonce, target) {
  const d = digestOf(seedHex, nonce);
  return BigInt(d) <= target;
}

/** Expected hashes for a target, for progress and ETA reporting. */
function expectedHashes(target) {
  if (target <= 0n) return Infinity;
  return (2n ** 256n) / (target + 1n);
}

/** Bits of difficulty implied by a target. */
function bitsOf(target) {
  if (target <= 0n) return 0;
  return 256 - target.toString(2).length + 1;
}

module.exports = {
  search,
  digestOf,
  verify,
  expectedHashes,
  bitsOf,
  SEED_LEN,
  INPUT_LEN,
};
