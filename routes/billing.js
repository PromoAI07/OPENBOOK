// routes/billing.js
// Non-Stripe supporter payments: a PayPal rail (auto-granted from PayPal's IPN)
// and a multi-network USDT rail (auto-granted when the supporter submits their
// on-chain transaction hash, which we verify on the right chain).
//
// Both rails funnel into ONE idempotent, audited step: applyPayment ->
// entitlements.extendTier (never shortens existing time, writes a supporter_events
// audit row). payment_events' UNIQUE(provider, external_id) guarantees a
// re-delivered webhook or re-submitted tx hash can never grant twice.
//
// CREDIBLE-NEUTRALITY: a payment only ever sets supporter_tier / supporter_expires.
// It never touches karma, standing, reach, or vote weight. No trust.js / ranking.js here.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { extendTier, tierConfig } = require('../entitlements');
const { logger } = require('../logger');

// Test-only bypass of payment verification, used by offline smoke tests. HARD-OFF
// in production even if the env var is set, so a misconfigured live server can
// never grant paid tiers for free.
const TEST_MODE = process.env.BILLING_TEST_MODE === '1' && process.env.NODE_ENV !== 'production';
if (process.env.BILLING_TEST_MODE === '1' && process.env.NODE_ENV === 'production') {
  logger.warn('BILLING_TEST_MODE is set but IGNORED in production; payment verification stays ON.');
}

// Charge model: bill several periods IN ADVANCE so PayPal's fixed per-transaction
// fee (~$0.30 + 4.4%) is paid as rarely as possible.
//   Supporter $1/mo  -> 1 year   in advance ($12, 365 days)
//   Plus      $3/mo  -> 6 months in advance ($18, 182 days)
//   Premium   $10/mo -> 3 months in advance ($30, 90 days)
const PLANS = {
  1: { usd: Number(process.env.PRICE_SUPPORTER || 12), days: 365, cycle: 'year', label: '1 year' },
  2: { usd: Number(process.env.PRICE_PLUS || 18), days: 182, cycle: '6mo', label: '6 months' },
  3: { usd: Number(process.env.PRICE_PREMIUM || 30), days: 90, cycle: '3mo', label: '3 months' },
};
function publicPlans() {
  return [1, 2, 3].map((t) => ({ tier: t, usd: PLANS[t].usd, days: PLANS[t].days, cycle: PLANS[t].cycle, label: PLANS[t].label }));
}

// USDT receiving addresses + the chain specifics needed to verify a transfer.
// Addresses are PUBLIC receive addresses (safe to ship); overridable via env so a
// fork can point them at its own wallets without editing code. USDT is 6 decimals
// on every chain here except BNB Chain (18).
const NETWORKS = {
  tron: {
    name: 'Tron (TRC-20)', type: 'tron', decimals: 6,
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    addrEnv: 'SUPPORT_USDT_TRON', addrDefault: 'TTvv7YJbwP48soTz5AdD5dUq5JFFnPnVzu',
    base: process.env.TRON_API_BASE || 'https://api.trongrid.io',
  },
  ethereum: {
    name: 'Ethereum (ERC-20)', type: 'evm', decimals: 6,
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    addrEnv: 'SUPPORT_USDT_ETH', addrDefault: '0x4561d34b554Ff7956b547120f9B34A97e126ca1d',
    rpc: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com',
  },
  bsc: {
    name: 'BNB Chain (BEP-20)', type: 'evm', decimals: 18,
    contract: '0x55d398326f99059fF775485246999027B3197955',
    addrEnv: 'SUPPORT_USDT_BSC', addrDefault: '0x4561d34b554Ff7956b547120f9B34A97e126ca1d',
    rpc: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org',
  },
  polygon: {
    name: 'Polygon', type: 'evm', decimals: 6,
    contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    addrEnv: 'SUPPORT_USDT_POLYGON', addrDefault: '0x4561d34b554Ff7956b547120f9B34A97e126ca1d',
    rpc: process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com',
  },
  solana: {
    name: 'Solana (SPL)', type: 'solana', decimals: 6,
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    addrEnv: 'SUPPORT_USDT_SOLANA', addrDefault: 'Fb8Yq8oBRKtxnwcRBkXrZu5TvBthCf9gpNYXGZrqzGF6',
    rpc: process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com',
  },
};
function networkAddress(id) {
  const n = NETWORKS[id];
  if (!n) return '';
  return (process.env[n.addrEnv] || n.addrDefault || (id === 'tron' ? process.env.SUPPORT_CRYPTO : '') || '').trim();
}
function publicNetworks() {
  return Object.keys(NETWORKS)
    .map((id) => ({ id, name: NETWORKS[id].name, address: networkAddress(id) }))
    .filter((n) => n.address);
}

// Human-readable bits for the supporter thank-you / receipt email.
function tierName(tier) { try { return require('../entitlements').tierConfig(tier).name; } catch (e) { return 'Supporter'; } }
function methodLabel(provider) {
  if (provider === 'paypal') return 'PayPal';
  if (String(provider).indexOf('usdt-') === 0) {
    const NETS = { tron: 'Tron', ethereum: 'Ethereum', bsc: 'BNB Chain', polygon: 'Polygon', solana: 'Solana' };
    const net = provider.slice(5);
    return 'USDT (' + (NETS[net] || net) + ')';
  }
  return String(provider || '');
}
function amountText(amount, currency) {
  const n = Number(amount);
  const a = Number.isFinite(n) ? (Math.round(n * 100) / 100) : amount;
  return String(currency || '').toUpperCase() === 'USD' ? ('$' + a) : (a + ' ' + (currency || ''));
}
function fmtDate(ts) {
  const m = String(ts || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
}

// Partial name for the PUBLIC supporters wall: only the first few letters of the
// first name, the rest masked. A privacy courtesy on the real name (the username,
// which the supporter chose as their public handle, is shown in full).
function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return 'Supporter';
  const first = s.split(/\s+/)[0];
  const keep = Math.max(1, Math.min(3, Math.ceil(first.length / 2)));
  return first.length <= keep ? first : first.slice(0, keep) + '…';
}

// The single idempotent, audited grant step shared by both rails.
async function applyPayment(provider, externalId, userId, tier, amount, currency, detail) {
  tier = Number(tier);
  externalId = String(externalId || '').trim();
  const plan = PLANS[tier];
  if (!plan || !externalId) { logger.warn({ provider, externalId, tier }, 'payment: bad tier/id'); return { ok: false, reason: 'bad_request' }; }
  if (!(Number(amount) >= plan.usd)) {
    logger.warn({ provider, externalId, tier, amount, need: plan.usd }, 'payment: amount below tier price');
    return { ok: false, reason: 'amount_too_low' };
  }
  const u = userId ? await db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(Number(userId)) : null;
  if (!u) { logger.warn({ provider, externalId, userId }, 'payment: unknown user'); return { ok: false, reason: 'unknown_user' }; }

  const ins = await db.prepare(
    "INSERT OR IGNORE INTO payment_events (provider, external_id, user_id, tier, days, amount, currency, status, detail) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)"
  ).run(provider, externalId, u.id, tier, plan.days, Number(amount), currency || '', String(detail || ''));
  if (!ins.changes) { logger.info({ provider, externalId }, 'payment: duplicate ignored'); return { ok: false, reason: 'duplicate', duplicate: true }; }

  const snapshot = await extendTier(u.id, tier, plan.days, provider + ':' + externalId);
  logger.info({ provider, externalId, userId: u.id, tier, days: plan.days }, 'payment applied, tier granted');

  // Thank-you + receipt email. Fire-and-forget so a slow/misconfigured mailer can
  // never delay or fail the webhook/claim response. It runs HERE, after the
  // INSERT OR IGNORE already proved this is a fresh, non-duplicate payment, so a
  // re-delivered webhook or re-submitted tx hash can never re-email.
  if (u.email) {
    try {
      const { sendSupporterThankYouEmail } = require('../mailer');
      const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
      Promise.resolve(sendSupporterThankYouEmail(u.email, u.name, {
        tierName: tierName(tier),
        amountText: amountText(amount, currency),
        method: methodLabel(provider),
        durationText: plan.label,
        untilText: snapshot && snapshot.expires ? fmtDate(snapshot.expires) : '',
        txId: externalId,
        supportUrl: base ? (base + '/app') : '',
      })).catch((e) => logger.warn({ err: e }, 'thank-you email failed'));
    } catch (e) { logger.warn({ err: e }, 'thank-you email dispatch failed'); }
  }

  return { ok: true, tier, days: plan.days, snapshot };
}

function parseCustom(custom) {
  const parts = String(custom || '').split(':');
  if (parts[0] !== 'ob') return null;
  const userId = Number(parts[1]);
  const tier = Number(parts[2]);
  if (!userId || !(tier >= 1 && tier <= 3)) return null;
  return { userId, tier, cycle: parts[3] || '' };
}

// --- PayPal IPN verification ---
async function verifyIpn(body) {
  const base = process.env.PAYPAL_ENV === 'sandbox'
    ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
    : 'https://ipnpb.paypal.com/cgi-bin/webscr';
  const params = new URLSearchParams();
  params.append('cmd', '_notify-validate');
  for (const k of Object.keys(body || {})) params.append(k, body[k]);
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  return (await r.text()).trim() === 'VERIFIED';
}

// Tron addresses come in three forms: base58 (T...), 41-prefixed hex, and the
// EVM-style 0x + 20-byte hex that TronGrid's event logs actually return. Normalize
// any of them to a lowercase 0x + 20-byte hex so a base58 receive address compares
// equal to the hex `to` in a transfer event. (Without this, real payments to a
// base58 address are wrongly rejected, as the real on-chain test caught.)
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  const bytes = [0];
  for (let i = 0; i < s.length; i++) {
    const v = B58_ALPHABET.indexOf(s[i]);
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0);
  return bytes.reverse();
}
function tronHex(a) {
  a = String(a || '').trim();
  if (!a) return '';
  if (a[0] === 'T') {
    const b = base58Decode(a);
    if (!b || b.length < 25) return '';
    const payload = b.slice(0, b.length - 4); // drop the 4-byte checksum
    if (payload[0] !== 0x41) return '';        // 0x41 = Tron mainnet version byte
    return '0x' + Buffer.from(payload.slice(1)).toString('hex').toLowerCase();
  }
  let h = a.toLowerCase().replace(/^0x/, '');
  if (h.length === 42 && h.slice(0, 2) === '41') h = h.slice(2);
  return '0x' + h;
}

// --- On-chain USDT verification, dispatched by network type ---
// Each returns { ok, amount? , error? }. amount is in whole USDT (with cents).
async function verifyUsdt(networkId, txHash) {
  const n = NETWORKS[networkId];
  const addr = networkAddress(networkId);
  if (!n || !addr) return { ok: false, error: 'That network is not available right now.' };
  if (n.type === 'tron') return verifyTron(txHash, addr, n);
  if (n.type === 'evm') return verifyEvm(txHash, addr, n);
  if (n.type === 'solana') return verifySolana(txHash, addr, n);
  return { ok: false, error: 'Unsupported network.' };
}

function unitsToAmount(rawBig, decimals) {
  const cents = (rawBig * 100n) / (10n ** BigInt(decimals)); // keep 2 dp without float drift
  return Number(cents) / 100;
}

async function verifyTron(txHash, addr, n) {
  try {
    const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
    const r = await fetch(n.base + '/v1/transactions/' + encodeURIComponent(txHash) + '/events', { headers });
    const data = await r.json();
    const events = (data && data.data) || [];
    const t = events.find((e) => e.event_name === 'Transfer' && String(e.contract_address) === n.contract);
    if (!t) return { ok: false, error: 'No confirmed USDT transfer found in that transaction yet. Wait for it to confirm and try again.' };
    const res = t.result || {};
    const to = String(res.to || res['1'] || '');
    if (to && tronHex(to) !== tronHex(addr)) return { ok: false, error: 'That transaction did not pay the OpenBook Tron address.' };
    const amount = unitsToAmount(BigInt(res.value || res['2'] || 0), n.decimals);
    return amount > 0 ? { ok: true, amount } : { ok: false, error: 'Could not read the USDT amount.' };
  } catch (e) { logger.warn({ err: e, txHash }, 'tron verify failed'); return { ok: false, error: 'Could not reach the Tron network. Please try again shortly.' }; }
}

async function verifyEvm(txHash, addr, n) {
  try {
    const hash = txHash.startsWith('0x') ? txHash : '0x' + txHash;
    const r = await fetch(n.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }) });
    const j = await r.json();
    const rc = j && j.result;
    if (!rc) return { ok: false, error: 'Transaction not found yet. Wait for it to confirm and try again.' };
    if (rc.status && rc.status !== '0x1') return { ok: false, error: 'That transaction failed on-chain.' };
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const want = addr.toLowerCase();
    const contract = n.contract.toLowerCase();
    for (const log of rc.logs || []) {
      if (String(log.address).toLowerCase() !== contract) continue;
      if (!log.topics || !log.topics[0] || log.topics[0].toLowerCase() !== TRANSFER || log.topics.length < 3) continue;
      const to = '0x' + String(log.topics[2]).slice(-40).toLowerCase();
      if (to !== want) continue;
      const amount = unitsToAmount(BigInt(log.data), n.decimals);
      if (amount > 0) return { ok: true, amount };
    }
    return { ok: false, error: 'No USDT transfer to the OpenBook address was found in that transaction.' };
  } catch (e) { logger.warn({ err: e, txHash }, 'evm verify failed'); return { ok: false, error: 'Could not reach the network. Please try again shortly.' }; }
}

async function verifySolana(txHash, ownerAddr, n) {
  try {
    const r = await fetch(n.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }) });
    const j = await r.json();
    const tx = j && j.result;
    if (!tx) return { ok: false, error: 'Transaction not found yet. Wait for it to confirm and try again.' };
    if (tx.meta && tx.meta.err) return { ok: false, error: 'That transaction failed on-chain.' };
    const sum = (arr) => (arr || [])
      .filter((b) => b.mint === n.mint && b.owner === ownerAddr)
      .reduce((s, b) => s + Number((b.uiTokenAmount && b.uiTokenAmount.amount) || 0), 0);
    const delta = (sum(tx.meta && tx.meta.postTokenBalances) - sum(tx.meta && tx.meta.preTokenBalances)) / Math.pow(10, n.decimals);
    return delta > 0 ? { ok: true, amount: delta } : { ok: false, error: 'No USDT transfer to the OpenBook Solana address was found in that transaction.' };
  } catch (e) { logger.warn({ err: e, txHash }, 'solana verify failed'); return { ok: false, error: 'Could not reach Solana. Please try again shortly.' }; }
}

// --- Webhooks router (mounted at /api/webhooks) ---
const webhooks = express.Router();
webhooks.post('/paypal', async (req, res) => {
  try {
    const body = req.body || {};
    if (!TEST_MODE) {
      if (!(await verifyIpn(body))) { logger.warn('paypal ipn failed validation'); return res.status(200).send('IGNORED'); }
    }
    if (String(body.payment_status) !== 'Completed') return res.status(200).send('OK');
    if (String(body.mc_currency || '').toUpperCase() !== 'USD') return res.status(200).send('OK');
    const receiver = String(body.receiver_email || body.business || '').toLowerCase();
    const want = String(process.env.PAYPAL_RECEIVER_EMAIL || '').toLowerCase();
    if (want && receiver && receiver !== want) { logger.warn({ receiver }, 'paypal ipn wrong receiver'); return res.status(200).send('OK'); }
    const parsed = parseCustom(body.custom);
    if (!parsed) { logger.warn('paypal ipn missing/invalid custom'); return res.status(200).send('OK'); }
    await applyPayment('paypal', body.txn_id, parsed.userId, parsed.tier, Number(body.mc_gross || 0), 'USD', 'paypal ipn');
    return res.status(200).send('OK');
  } catch (e) { logger.error({ err: e }, 'paypal ipn handler error'); return res.status(200).send('OK'); }
});

// --- API router (mounted at /api/billing) ---
const api = express.Router();
api.get('/plans', (req, res) => res.json({ plans: publicPlans() }));
api.get('/networks', (req, res) => res.json({ networks: publicNetworks() }));

api.post('/crypto/claim', requireAuth, async (req, res) => {
  const tier = Number(req.body.tier);
  const network = String(req.body.network || '').toLowerCase();
  const txHash = String(req.body.txHash || '').trim();
  if (!(tier >= 1 && tier <= 3)) return res.status(400).json({ error: 'Pick a tier first.' });
  if (!NETWORKS[network]) return res.status(400).json({ error: 'Pick a network.' });
  if (txHash.length < 16) return res.status(400).json({ error: 'Paste your transaction hash.' });

  // Short-circuit a hash we have already applied, BEFORE spending an on-chain
  // lookup on it (cheaper, and returns a clean 409 even if the chain is slow).
  const seen = await db.prepare('SELECT 1 FROM payment_events WHERE provider = ? AND external_id = ?').get('usdt-' + network, txHash);
  if (seen) return res.status(409).json({ error: 'That transaction has already been used.' });

  let amount = PLANS[tier].usd; // tier price; only trusted when TEST_MODE bypasses verification
  if (!TEST_MODE) {
    const v = await verifyUsdt(network, txHash);
    if (!v.ok) return res.status(400).json({ error: v.error });
    amount = v.amount;
  }
  const result = await applyPayment('usdt-' + network, txHash, req.user.id, tier, amount, 'USDT', 'crypto ' + network);
  if (!result.ok) {
    if (result.duplicate) return res.status(409).json({ error: 'That transaction has already been used.' });
    if (result.reason === 'amount_too_low') return res.status(400).json({ error: 'That payment is below the ' + PLANS[tier].usd + ' USDT needed for this tier.' });
    return res.status(400).json({ error: 'Could not apply that payment. Check the hash and try again.' });
  }
  res.json({ ok: true, entitlements: result.snapshot });
});

api.get('/me', requireAuth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT provider, tier, days, amount, currency, status, created_at FROM payment_events WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  const u = await db.prepare('SELECT hide_supporter FROM users WHERE id = ?').get(req.user.id);
  res.json({ payments: rows, hideSupporter: !!(u && u.hide_supporter) });
});

// PUBLIC supporters wall (transparency about funding). The last 100 supporter
// payments, NEWEST FIRST (deliberately NOT ranked by amount, so it is a thank-you
// + funding-transparency wall, never a "who paid most" board, which would imply
// money buys status). Per-row shows only the tier/badge, never a dollar figure;
// the one aggregate total is shown separately. Opted-out supporters are excluded
// from the list but still counted in the total (anonymously).
api.get('/leaderboard', async (req, res) => {
  try {
    const rows = await db.prepare(
      "SELECT pe.tier t, pe.created_at d, u.username un, u.name nm, u.avatar av " +
      "FROM payment_events pe JOIN users u ON u.id = pe.user_id " +
      "WHERE pe.status = 'applied' AND COALESCE(u.hide_supporter, 0) = 0 " +
      "ORDER BY pe.created_at DESC, pe.id DESC LIMIT 100"
    ).all();
    const supporters = rows.map((r) => {
      const cfg = tierConfig(r.t);
      return { username: r.un || '', name: maskName(r.nm), avatar: r.av || '', tier: r.t, tierName: cfg.name, badge: cfg.badge, date: r.d };
    });
    const agg = await db.prepare(
      "SELECT COALESCE(SUM(amount), 0) total, COUNT(*) payments, COUNT(DISTINCT user_id) supporters FROM payment_events WHERE status = 'applied'"
    ).get();
    res.json({
      supporters,
      total: Math.round((agg.total || 0) * 100) / 100,
      currency: 'USD',
      supporterCount: agg.supporters || 0,
      paymentCount: agg.payments || 0,
    });
  } catch (e) {
    logger.warn({ err: e }, 'leaderboard failed');
    res.json({ supporters: [], total: 0, currency: 'USD', supporterCount: 0, paymentCount: 0 });
  }
});

// Opt in / out of being NAMED on the public supporters wall (default shown). Even
// when hidden, the payment still counts in the aggregate total.
api.post('/leaderboard-visibility', requireAuth, async (req, res) => {
  const hidden = req.body.hidden ? 1 : 0;
  await db.prepare('UPDATE users SET hide_supporter = ? WHERE id = ?').run(hidden, req.user.id);
  res.json({ ok: true, hidden: !!hidden });
});

module.exports = { webhooks, api, applyPayment, PLANS, publicPlans, publicNetworks, parseCustom, tronHex };
