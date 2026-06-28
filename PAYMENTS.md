# OpenBook supporter payments (Vietnam, no Stripe)

Two rails, both optional, both auto-grant the tier on payment. Nothing here can
buy karma, standing, reach, or vote weight: a payment only ever sets the
supporter tier (cosmetic, capacity, convenience perks).

Charge model: **Supporter ($1/mo) and Plus ($3/mo) are billed once a year in
advance** ($12 and $36, one transaction each, so a per-payment fee is paid once
not twelve times). **Premium ($10/mo) is billed monthly.**

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

## Rail 2: USDT (TRC-20) crypto

Why: near-zero fees, works in Vietnam, fits the open/sovereign ethos.

Setup:
1. Create a TRON wallet (e.g. TronLink) and copy its USDT (TRC-20) deposit
   address (starts with `T...`).
2. In Render, set `SUPPORT_CRYPTO` to that address. Optionally set `TRON_API_KEY`
   (a free TronGrid key) to raise rate limits.
3. Done. The Support page shows the address and an "Apply my tier" form. A
   supporter sends USDT, pastes their transaction hash, and the server confirms
   the transfer on-chain (correct token, your address, enough USDT) and grants
   the tier. Each tx hash can only be used once.

## Tuning (optional env)
- `PRICE_SUPPORTER_YEAR` (12), `PRICE_PLUS_YEAR` (36), `PRICE_PREMIUM_MONTH` (10).
- `BILLING_TEST_MODE=1` bypasses PayPal/TronGrid verification. **Tests only;
  never set this in production.**

## How a grant is recorded
Every confirmed payment writes one row to `payment_events` (provider + external
id, unique, so a payment can never be counted twice) and calls
`entitlements.extendTier`, which extends the supporter time (never shortens it)
and writes a `supporter_events` audit row. A supporter can see their own receipts
at `GET /api/billing/me`.
