# Zhenzhu Miner

Pearl Coin (珍珠币) PoW miner for BNB Smart Chain. Mines with wallets that
hold a `.ai` identity, sweeps every reward to one payout wallet.

## What it does

```
miner wallets (each needs a .ai identity)
      │
      │  mine(id, nonce, minReward)   ← reward goes to msg.sender
      ▼
  reward lands in the mining wallet
      │
      │  transfer(payout, balance)    ← one cheap call
      ▼
  payout wallet (wallet 1)
```

The contract pays `msg.sender`, so a wallet without a `.ai` identity cannot
mine and cannot be the destination of a direct mine. Sweeping is the second
step, and it is one `transfer()` per wallet rather than one per proof.

## Files

| File | Purpose |
|---|---|
| `config.js` | chain, contracts, payout address, gas, notification settings |
| `pow.js` | keccak proof search. Verified against the contract's rule |
| `chain.js` | RPC reads with failover across four endpoints |
| `wallets.js` | loads `miner-keys.txt`, never logs a key |
| `sweep.js` | moves a wallet's balance to the payout address |
| `miner.js` | orchestrator: one pass over every wallet |
| `notify.js` | Telegram alerts |
| `ui.js` | local control panel on 127.0.0.1:8787 |
| `run.sh` | cron wrapper (Hermes runs `.js` through Python, not node) |
| `miner-keys.txt` | one private key per line, chmod 600 |

## Setup

```bash
cd /home/ubuntu/zhenzhu-miner

# 1. add miner wallets, one key per line with an optional label
nano miner-keys.txt
#   0xabc...  wallet-1
#   0xdef...  wallet-2

# 2. point the payout somewhere (defaults to wallet 1)
export ZZ_PAYOUT=0xa0F64e1719f063c732EA8f436F774f1f13d9c79F

# 3. optional Telegram alerts
export ZZ_TG_TOKEN=123456:ABC...
export ZZ_TG_CHAT=5692450119
```

## Run

```bash
# one pass, foreground
node miner.js

# control panel
node ui.js          # then open http://127.0.0.1:8787

# every 30 minutes from cron
*/30 * * * * /home/ubuntu/zhenzhu-miner/run.sh
```

## What the panel does

- lists every wallet with its `.ai` identity, token balance and gas
- add a wallet by pasting a key; it is written to `miner-keys.txt` with 0600
- remove a wallet
- **Claim now** runs a mining pass in the background
- shows daily quota remaining, difficulty and total proofs mined

## Alerts

| Alert | When |
|---|---|
| 🟢 started | a run begins with wallets loaded |
| 💎 mined | a proof is confirmed, with reward, gas and tx link |
| 📤 swept | a balance moved to the payout wallet |
| 🟡 quota empty | `dailyRemaining` fell below the floor |
| 🟠 stalled | a read failed and the run will retry |
| 🟠 low gas | a wallet cannot cover the next broadcast |
| 🟠 RPC trouble | an endpoint failed and a backup took over |
| 🔴 stopped | the run ended, with the reason |
| 🔴 error | anything unexpected |

## Verified

```
pow.search()      nonce found, verify() true, negative control false
chain.readState() live, paused, dailyRemaining, workBits, proofs
chain.handleOf()  returns '' for a wallet with no .ai identity
RPC failover      primary failed, secondary answered, run continued
miner.js          no wallets -> exit 0; not live -> exit 0; quota -> exit 0
ui.js             add / delete / invalid-key 400 / status reads chain
run.sh            wrapper exits 0 on a clean stop
```

## Known limits

- **Single-threaded.** ~265k hashes/s on this host. A 30-bit target needs
  ~1.07e9 hashes on average, so roughly 70 minutes per proof. Two cores are
  available; running two wallets in parallel splits that rather than halving
  it.
- **`mineBatch` is not wired up.** It would cut gas per proof by about 7x, but
  the contract rolls back the whole batch if any single proof fails, and the
  daily quota is currently empty. The ABI is in `chain.js`; the call is not
  made.
- **Quota resets per mining day, not per calendar day.** The contract counts
  86400 seconds from the first-ever mining transaction and does not carry a
  remainder over.

## Contract addresses

```
chainId   56  (BNB Smart Chain)
token     0x7E2DA878217EB995F9e5d36eD32c9Cea52442681
registry  0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
```

Verify these before trusting them: `eth_getCode` on both, and compare against
`tokenCodeHash` and `registryCodeHash` in the site's `mining-prompt.md`.
