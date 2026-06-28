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
const { extendTier } = require('../entitlements');
const { logger } = require('../logger');

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
    rpc: process.env.ETH_RPC || 'https://eth.llamarpc.com',
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
    rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  },
  solana: {
    name: 'Solana (SPL)', type: 'solana', decimals: 6,
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    addrEnv: 'SUPPORT_USDT_SOLANA', addrDefault: 'Fb8Yq8oBRKtxnwcRBkXrZu5TvBthCf9gpNYXGZrqzGF6',
    rpc: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
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
  const u = userId ? await db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId)) : null;
  if (!u) { logger.warn({ provider, externalId, userId }, 'payment: unknown user'); return { ok: false, reason: 'unknown_user' }; }

  const ins = await db.prepare(
    "INSERT OR IGNORE INTO payment_events (provider, external_id, user_id, tier, days, amount, currency, status, detail) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)"
  ).run(provider, externalId, u.id, tier, plan.days, Number(amount), currency || '', String(detail || ''));
  if (!ins.changes) { logger.info({ provider, externalId }, 'payment: duplicate ignored'); return { ok: false, reason: 'duplicate', duplicate: true }; }

  const snapshot = await extendTier(u.id, tier, plan.days, provider + ':' + externalId);
  logger.info({ provider, externalId, userId: u.id, tier, days: plan.days }, 'payment applied, tier granted');
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
    if (to && to !== addr) return { ok: false, error: 'That transaction did not pay the OpenBook Tron address.' };
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
    if (process.env.BILLING_TEST_MODE !== '1') {
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

  let amount = PLANS[tier].usd; // BILLING_TEST_MODE trusts the tier price
  if (process.env.BILLING_TEST_MODE !== '1') {
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
  res.json({ payments: rows });
});

module.exports = { webhooks, api, applyPayment, PLANS, publicPlans, publicNetworks, parseCustom };
