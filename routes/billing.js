// routes/billing.js
// Non-Stripe supporter payments for a Vietnam-based project: a PayPal rail
// (auto-granted from PayPal's IPN) and a USDT (TRC-20) rail (auto-granted when
// the supporter submits their on-chain transaction hash, which we verify).
//
// Both rails funnel into ONE idempotent, audited step: applyPayment ->
// entitlements.extendTier (which never shortens existing time and writes a
// supporter_events audit row). The payment_events table's UNIQUE(provider,
// external_id) index guarantees a re-delivered webhook or a re-submitted tx hash
// can never grant twice.
//
// CREDIBLE-NEUTRALITY: a payment only ever sets supporter_tier / supporter_expires
// (via extendTier). It never touches karma, standing, reach, or vote weight, by
// design. Nothing here imports trust.js or ranking.js.
//
// The founder must set the env that turns each rail on (PAYPAL_RECEIVER_EMAIL,
// SUPPORT_CRYPTO). With neither set, the manual /api/admin/grant path still works.

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { extendTier } = require('../entitlements');
const { logger } = require('../logger');

// The charge model the founder chose: $1 and $3 billed ONCE per year in advance
// (so a fixed per-transaction fee is paid once, not 12x), $10 billed monthly.
// Env-overridable without a deploy.
const PLANS = {
  1: { usd: Number(process.env.PRICE_SUPPORTER_YEAR || 12), days: 365, cycle: 'year' },
  2: { usd: Number(process.env.PRICE_PLUS_YEAR || 36), days: 365, cycle: 'year' },
  3: { usd: Number(process.env.PRICE_PREMIUM_MONTH || 10), days: 30, cycle: 'month' },
};

// USDT (TRC-20) contract address on TRON. Transfers of this token are what we accept.
const USDT_TRON_CONTRACT = process.env.USDT_TRON_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function publicPlans() {
  return [1, 2, 3].map((t) => ({ tier: t, usd: PLANS[t].usd, days: PLANS[t].days, cycle: PLANS[t].cycle }));
}

// The single, idempotent, audited grant step shared by both rails. Returns
// { ok, reason?, duplicate?, snapshot? }.
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

  // Idempotency: the UNIQUE index makes a second identical payment a no-op.
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO payment_events (provider, external_id, user_id, tier, days, amount, currency, status, detail) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)"
  ).run(provider, externalId, u.id, tier, plan.days, Number(amount), currency || '', String(detail || ''));
  if (!ins.changes) { logger.info({ provider, externalId }, 'payment: duplicate ignored'); return { ok: false, reason: 'duplicate', duplicate: true }; }

  const snapshot = await extendTier(u.id, tier, plan.days, provider + ':' + externalId);
  logger.info({ provider, externalId, userId: u.id, tier, days: plan.days }, 'payment applied, tier granted');
  return { ok: true, tier, days: plan.days, snapshot };
}

// custom field carried by the PayPal button: "ob:<userId>:<tier>:<cycle>".
function parseCustom(custom) {
  const parts = String(custom || '').split(':');
  if (parts[0] !== 'ob') return null;
  const userId = Number(parts[1]);
  const tier = Number(parts[2]);
  if (!userId || !(tier >= 1 && tier <= 3)) return null;
  return { userId, tier, cycle: parts[3] || '' };
}

// Validate an IPN message by echoing it back to PayPal and expecting "VERIFIED".
async function verifyIpn(body) {
  const base = process.env.PAYPAL_ENV === 'sandbox'
    ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
    : 'https://ipnpb.paypal.com/cgi-bin/webscr';
  const params = new URLSearchParams();
  params.append('cmd', '_notify-validate');
  for (const k of Object.keys(body || {})) params.append(k, body[k]);
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = (await r.text()).trim();
  return text === 'VERIFIED';
}

// Verify a TRON transaction actually moved >= the needed USDT to our address.
// Uses TronGrid's decoded-events endpoint (no key needed for light use; set
// TRON_API_KEY to raise limits). Returns { ok, amount? , error? }.
async function verifyTronUsdt(txHash) {
  const addr = (process.env.SUPPORT_CRYPTO || '').trim();
  if (!addr) return { ok: false, error: 'Crypto support is not configured yet.' };
  const base = process.env.TRON_API_BASE || 'https://api.trongrid.io';
  const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {};
  let data;
  try {
    const r = await fetch(base + '/v1/transactions/' + encodeURIComponent(txHash) + '/events', { headers });
    data = await r.json();
  } catch (e) {
    logger.warn({ err: e, txHash }, 'tron lookup failed');
    return { ok: false, error: 'Could not reach the TRON network. Please try again shortly.' };
  }
  const events = (data && data.data) || [];
  const transfer = events.find((e) => e.event_name === 'Transfer' && String(e.contract_address) === USDT_TRON_CONTRACT);
  if (!transfer) return { ok: false, error: 'No confirmed USDT transfer found in that transaction yet. Wait for it to confirm and try again.' };
  const r = transfer.result || {};
  const to = String(r.to || r['1'] || '');
  if (to && addr && to !== addr) return { ok: false, error: 'That transaction did not pay the OpenBook USDT address.' };
  const raw = Number(r.value || r['2'] || 0);
  const amount = raw / 1e6; // USDT has 6 decimals
  if (!(amount > 0)) return { ok: false, error: 'Could not read the USDT amount from that transaction.' };
  return { ok: true, amount };
}

// ---------------------------------------------------------------------------
// Webhooks router (mounted at /api/webhooks). Unauthenticated, server-to-server.
// Always answers 200 so PayPal does not retry forever; problems are logged.
// ---------------------------------------------------------------------------
const webhooks = express.Router();

webhooks.post('/paypal', async (req, res) => {
  try {
    const body = req.body || {};
    if (process.env.BILLING_TEST_MODE !== '1') {
      const verified = await verifyIpn(body);
      if (!verified) { logger.warn('paypal ipn failed validation'); return res.status(200).send('IGNORED'); }
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
  } catch (e) {
    logger.error({ err: e }, 'paypal ipn handler error');
    return res.status(200).send('OK');
  }
});

// ---------------------------------------------------------------------------
// API router (mounted at /api/billing). Exempt from the email gate in server.js.
// ---------------------------------------------------------------------------
const api = express.Router();

// Public: the charge model (amounts + cycle) so the Support UI is env-driven.
api.get('/plans', (req, res) => res.json({ plans: publicPlans() }));

// The caller pastes their TRON tx hash; we verify on-chain and grant their tier.
api.post('/crypto/claim', requireAuth, async (req, res) => {
  const tier = Number(req.body.tier);
  const txHash = String(req.body.txHash || '').trim();
  if (!(tier >= 1 && tier <= 3)) return res.status(400).json({ error: 'Pick a tier first.' });
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'Enter a valid TRON transaction hash (64 hex characters).' });

  let amount = PLANS[tier].usd; // BILLING_TEST_MODE trusts the tier price
  if (process.env.BILLING_TEST_MODE !== '1') {
    const v = await verifyTronUsdt(txHash);
    if (!v.ok) return res.status(400).json({ error: v.error });
    amount = v.amount;
  }
  const result = await applyPayment('usdt-tron', txHash, req.user.id, tier, amount, 'USDT', 'crypto claim');
  if (!result.ok) {
    if (result.duplicate) return res.status(409).json({ error: 'That transaction has already been used.' });
    if (result.reason === 'amount_too_low') return res.status(400).json({ error: 'That payment is below the ' + PLANS[tier].usd + ' USDT needed for this tier.' });
    return res.status(400).json({ error: 'Could not apply that payment. Check the hash and try again.' });
  }
  res.json({ ok: true, entitlements: result.snapshot });
});

// The caller's own payment receipts.
api.get('/me', requireAuth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT provider, tier, days, amount, currency, status, created_at FROM payment_events WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ payments: rows });
});

module.exports = { webhooks, api, applyPayment, PLANS, publicPlans, parseCustom };
