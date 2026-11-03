/**
 * Zhenzhu Miner — web control panel
 *
 * A small local server for adding miner wallets, watching status, and firing a
 * claim by hand. Binds to 127.0.0.1 only: it holds no keys itself, but it can
 * read the key file and trigger transactions, so it is not for a public port.
 *
 *   GET  /                 the panel
 *   GET  /api/status       chain state, wallet list, balances
 *   POST /api/wallets      add a key   {key, label}
 *   POST /api/wallets/del  remove one  {label}
 *   POST /api/claim        mine + sweep now, in the background
 *   GET  /api/log          tail of miner.log
 */

const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const log = require('./logger');
const chain = require('./chain');
const { loadWallets } = require('./wallets');

const PORT = Number(process.env.ZZ_PORT || 8787);
const HOST = '127.0.0.1';

let claiming = false;
let lastClaim = null;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Append a key to the keys file, creating it if needed. */
function addKey(key, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('not a 32-byte hex private key');
  const line = `${key}${label ? `  ${label}` : ''}\n`;
  fs.appendFileSync(config.keysFile, line);
  try { fs.chmodSync(config.keysFile, 0o600); } catch { /* best effort */ }
}

function removeKey(label) {
  const raw = fs.readFileSync(config.keysFile, 'utf8');
  const kept = raw.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return true;
    const parts = t.split(/\s+/);
    const lbl = parts.slice(1).join(' ') || '';
    return lbl !== label;
  });
  fs.writeFileSync(config.keysFile, `${kept.join('\n').replace(/\n+$/, '')}\n`);
}

async function status() {
  const wallets = loadWallets();
  const out = { chain: null, payout: config.payoutWallet, miners: [], claiming, lastClaim };
  try {
    const st = await chain.readState();
    out.chain = {
      live: st.isLive,
      paused: st.paused,
      stage: st.currentStage,
      dailyRemaining: Number(st.dailyRemaining) / 1e8,
      dailyCap: Number(st.dailyCap) / 1e8,
      proofs: st.successfulProofs,
      workBits: st.workBits,
    };
  } catch (err) {
    out.chainError = err.shortMessage || err.message;
  }

  for (const [label, wallet] of wallets) {
    const row = { label, address: wallet.address, handle: null, balance: null, bnb: null };
    try {
      row.handle = (await chain.handleOf(wallet.address)) || null;
    } catch { /* leave null */ }
    try {
      const b = await chain.balanceOf(wallet.address);
      row.balance = Number(b) / 1e8;
    } catch { /* leave null */ }
    try {
      row.bnb = await chain.bnbBalance(wallet.address);
    } catch { /* leave null */ }
    out.miners.push(row);
  }
  return out;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zhenzhu Miner</title>
<style>
:root{--bg:#0b0d12;--card:#14171f;--line:#232733;--txt:#e6e8ee;--dim:#8b93a7;--acc:#d4af37;--ok:#3ecf8e;--warn:#f0a93b;--err:#ef5f5f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kv .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.kv .v{font-size:17px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.p-ok{background:rgba(62,207,142,.14);color:var(--ok)}
.p-no{background:rgba(239,95,95,.14);color:var(--err)}
.p-warn{background:rgba(240,169,59,.14);color:var(--warn)}
input{background:#0d1017;border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:9px 11px;font-size:13px;width:100%}
input:focus{outline:none;border-color:var(--acc)}
button{background:var(--acc);color:#1a1408;border:none;border-radius:7px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row>input{flex:1;min-width:180px}
.del{background:transparent;color:var(--err);border:1px solid rgba(239,95,95,.3);padding:4px 10px;font-size:11px;font-weight:600}
.note{color:var(--dim);font-size:12px;margin-top:8px}
#msg{font-size:12px;margin-top:8px;min-height:18px}
</style></head><body><div class="wrap">
<h1>Zhenzhu Miner</h1>
<div class="sub">Pearl Coin PoW &middot; BNB Smart Chain &middot; rewards sweep to one wallet</div>

<div class="card"><div class="grid" id="chain"></div></div>

<div class="card">
  <div class="row" style="justify-content:space-between;margin-bottom:10px">
    <strong>Miner wallets</strong>
    <button id="claimBtn" onclick="claim()">Claim now</button>
  </div>
  <table><thead><tr>
    <th>Label</th><th>Address</th><th>.ai identity</th><th>Balance</th><th>Gas</th><th></th>
  </tr></thead><tbody id="rows"></tbody></table>
  <div id="msg"></div>
</div>

<div class="card">
  <strong>Add wallet</strong>
  <div class="row" style="margin-top:10px">
    <input id="pk" placeholder="0x private key (stays on this machine)" spellcheck="false">
    <input id="lbl" placeholder="label, e.g. wallet-2" style="max-width:180px">
    <button onclick="addWallet()">Add</button>
  </div>
  <div class="note">Keys are written to <span class="mono">miner-keys.txt</span> with 0600 and are never sent anywhere but the chain.</div>
</div>

<div class="card">
  <strong>Payout wallet</strong>
  <div class="mono" id="payout" style="margin-top:6px;color:var(--acc)"></div>
  <div class="note">Every miner's reward is swept here after each successful proof.</div>
</div>

</div>
<script>
const $ = s => document.querySelector(s);
const short = a => a ? a.slice(0,6)+'…'+a.slice(-4) : '—';

async function refresh(){
  const r = await fetch('/api/status');
  const d = await r.json();
  const c = d.chain;
  $('#chain').innerHTML = c ? [
    ['Status', c.live && !c.paused ? '<span class="pill p-ok">live</span>' : '<span class="pill p-no">stopped</span>'],
    ['Daily left', c.dailyRemaining.toLocaleString(undefined,{maximumFractionDigits:0})],
    ['Daily cap', c.dailyCap.toLocaleString()],
    ['Difficulty', c.workBits + ' bits'],
    ['Proofs mined', c.proofs.toLocaleString()],
  ].map(([k,v]) => '<div class="kv"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('')
    : '<div class="kv"><div class="k">Chain</div><div class="v" style="color:var(--err)">unreachable</div></div>';

  $('#rows').innerHTML = d.miners.length ? d.miners.map(m => '<tr>'
    + '<td>'+m.label+'</td>'
    + '<td class="mono">'+short(m.address)+'</td>'
    + '<td>'+(m.handle ? '<span class="pill p-ok">'+m.handle+'</span>' : '<span class="pill p-no">none</span>')+'</td>'
    + '<td>'+(m.balance===null?'—':m.balance.toLocaleString(undefined,{maximumFractionDigits:4}))+'</td>'
    + '<td>'+(m.bnb===null?'—':m.bnb.toFixed(5))+'</td>'
    + '<td><button class="del" onclick="del(\\''+m.label+'\\')">remove</button></td>'
    + '</tr>').join('') : '<tr><td colspan="6" style="color:var(--dim)">No wallets yet. Add one below.</td></tr>';

  $('#payout').textContent = d.payout || '—';
  $('#claimBtn').disabled = d.claiming;
  $('#claimBtn').textContent = d.claiming ? 'Claiming…' : 'Claim now';
}

function say(t, ok){ $('#msg').innerHTML = '<span style="color:var(--'+(ok===false?'err':'ok')+')">'+t+'</span>'; }

async function addWallet(){
  const key = $('#pk').value.trim(), label = $('#lbl').value.trim();
  if(!key) return say('Paste a private key first', false);
  const r = await fetch('/api/wallets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,label})});
  const d = await r.json();
  if(!r.ok) return say(d.error || 'failed', false);
  $('#pk').value=''; $('#lbl').value='';
  say('Added '+(d.label||'wallet')); refresh();
}

async function del(label){
  if(!confirm('Remove '+label+'?')) return;
  const r = await fetch('/api/wallets/del',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});
  if(r.ok) say('Removed '+label); else say('failed', false);
  refresh();
}

async function claim(){
  $('#claimBtn').disabled = true; $('#claimBtn').textContent = 'Claiming…';
  say('Mining in the background, this can take a while…');
  const r = await fetch('/api/claim',{method:'POST'});
  const d = await r.json();
  say(d.message || 'done', r.ok);
  refresh();
}

refresh(); setInterval(refresh, 20000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    try {
      json(res, 200, await status());
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/log') {
    try {
      const txt = fs.readFileSync(config.logFile, 'utf8');
      const lines = txt.split('\n').slice(-120).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('(no log yet)');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/wallets') {
    try {
      const { key, label } = await readBody(req);
      addKey(key.trim(), (label || '').trim());
      const wallets = loadWallets();
      const added = [...wallets.keys()].pop();
      log.info(`ui: added wallet ${added}`);
      json(res, 200, { ok: true, label: added });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/wallets/del') {
    try {
      const { label } = await readBody(req);
      removeKey(label);
      log.info(`ui: removed wallet ${label}`);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/claim') {
    if (claiming) {
      json(res, 409, { message: 'a claim is already running' });
      return;
    }
    claiming = true;
    lastClaim = { startedAt: new Date().toISOString() };
    // Run the miner as a child so a crash cannot take the panel down.
    execFile(process.execPath, [require('path').join(__dirname, 'miner.js')], {
      cwd: __dirname,
      timeout: 3_600_000,
    }, (err) => {
      claiming = false;
      lastClaim = {
        ...lastClaim,
        finishedAt: new Date().toISOString(),
        ok: !err,
      };
      log.info(`ui: claim run finished ${err ? `with error: ${err.message}` : 'ok'}`);
    });
    json(res, 200, { message: 'claim started in the background' });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log.info(`ui: listening on http://${HOST}:${PORT}`);
});
