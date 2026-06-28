# OpenBook supporter payments (Vietnam, no Stripe)

Two rails, both optional, both auto-grant the tier on payment. Nothing here can
buy karma, standing, reach, or vote weight: a payment only ever sets the
supporter tier (cosmetic, capacity, convenience perks).

Charge model (billed in advance so PayPal's fixed per-transaction fee is paid as
rarely as possible): **Supporter ($1/mo) = 1 year up front ($12), Plus ($3/mo) =
6 months up front ($18), Premium ($10/mo) = 3 months up front ($30).**

## Rail 1: PayPal (cards + PayPal balance)

Why: a Vietnamese PayPal account can receive worldwide and withdraw to a local
bank/Visa debit. Cheapest effective fees for these small amounts.

Setup (you do this; I never enter your credentials or create the account):
1. Use a PayPal account that can receive payments in Vietnam.
2. In PayPal: Account Settings -> Notifications -> Instant Payment Notifications
   (IPN). Turn it ON. The notify URL is sent per-payment by the button, so you
   can leave the default URL blank or set it to `https://openbook.space/api/webhooks/paypal`.
3. In Render, set `PAYPAL_RECEIVER_EMAIL` to that PayPal email. (Leave
   `PAYPAL_ENV` unset for live; set it to `sandbox` only while testing.)
4. Done. The Support page "Pay with PayPal" buttons now work. When someone pays,
   PayPal posts an IPN to `/api/webhooks/paypal`, the server verifies it with
   PayPal, checks the amount and receiver, and grants the tier automatically.

If your PayPal account type does not expose IPN, the **manual fallback** still
works: you get the PayPal email, then grant the tier yourself from the admin
panel at `https://openbook.space/admin` (or via `POST /api/admin/grant`).

## Rail 2: USDT (multi-network) crypto

Why: near-zero fees, works in Vietnam, fits the open/sovereign ethos. Almost the
whole amount reaches the project.

Five networks are supported: **Tron (TRC-20), Ethereum (ERC-20), BNB Chain
(BEP-20), Polygon, and Solana (SPL).** The receive addresses live in
`routes/billing.js` (`NETWORKS`, set to the founder's wallets) and can be
overridden by env (`SUPPORT_USDT_TRON`, `SUPPORT_USDT_ETH`, `SUPPORT_USDT_BSC`,
`SUPPORT_USDT_POLYGON`, `SUPPORT_USDT_SOLANA`).

How it works: the Support page shows each network's address with its logo and a
copy button, plus one "Apply my tier" form. A supporter sends USDT, picks the
network, pastes their transaction hash, and the server confirms the transfer
on-chain (correct token + your address + enough USDT) and grants the tier. Each
hash can be used once. On-chain reads use public RPC/explorer endpoints
(overridable via `ETH_RPC`, `BSC_RPC`, `POLYGON_RPC`, `SOLANA_RPC`, `TRON_API_BASE`
/ `TRON_API_KEY`). If a chain's read ever fails, the supporter is asked to retry
and the founder can still grant manually from `/admin`.

## Tuning (optional env)
- Prices: `PRICE_SUPPORTER` (12), `PRICE_PLUS` (18), `PRICE_PREMIUM` (30).
- `BILLING_TEST_MODE=1` bypasses PayPal/on-chain verification. **Tests only;
  never set this in production.**

## How a grant is recorded
Every confirmed payment writes one row to `payment_events` (provider + external
id, unique, so a payment can never be counted twice) and calls
`entitlements.extendTier`, which extends the supporter time (never shortens it)
and writes a `supporter_events` audit row. A supporter can see their own receipts
at `GET /api/billing/me`.
