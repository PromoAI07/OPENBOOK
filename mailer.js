// mailer.js
// Transactional email via Resend's HTTP API (https://resend.com). No SDK needed,
// just an API key. Set these env vars in production:
//   RESEND_API_KEY  - your Resend API key (required to actually send)
//   EMAIL_FROM      - a verified sender, e.g. "OpenBook <noreply@yourdomain>".
//                     Defaults to Resend's shared test sender, which can only
//                     deliver to your own Resend account email until you verify
//                     a domain.
//
// If RESEND_API_KEY is not set (local dev), nothing is sent: the function logs
// the link and returns it so the flow stays testable without an email account.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'OpenBook <onboarding@resend.dev>';

function verifyEmailHtml(name, link) {
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1c1c28">' +
    '<h2 style="color:#4f46e5">Welcome to OpenBook' + (name ? ', ' + escapeHtml(name) : '') + '</h2>' +
    '<p>Confirm your email address to start posting, commenting, and messaging.</p>' +
    '<p style="margin:24px 0"><a href="' + link + '" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Verify my email</a></p>' +
    '<p style="font-size:13px;color:#65656f">Or paste this link into your browser:<br>' + link + '</p>' +
    '<p style="font-size:12px;color:#9a9aa5">If you did not create an OpenBook account, you can ignore this email.</p>' +
    '</div>'
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Send the verification email. Returns { sent: boolean, link: string }.
async function sendVerificationEmail(to, link, name) {
  if (!RESEND_API_KEY) {
    console.log('[mailer] RESEND_API_KEY not set. Verification link for ' + to + ':\n  ' + link);
    return { sent: false, link };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: 'Verify your OpenBook account',
        html: verifyEmailHtml(name, link),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[mailer] Resend returned ' + res.status + ': ' + body);
      return { sent: false, link };
    }
    return { sent: true, link };
  } catch (e) {
    console.error('[mailer] send failed: ' + (e && e.message));
    return { sent: false, link };
  }
}

function resetEmailHtml(name, link) {
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1c1c28">' +
    '<h2 style="color:#4f46e5">Reset your OpenBook password</h2>' +
    '<p>Hi' + (name ? ' ' + escapeHtml(name) : '') + ', we got a request to reset your password. Click below to choose a new one. This link expires in 1 hour.</p>' +
    '<p style="margin:24px 0"><a href="' + link + '" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Reset my password</a></p>' +
    '<p style="font-size:13px;color:#65656f">Or paste this link into your browser:<br>' + link + '</p>' +
    '<p style="font-size:12px;color:#9a9aa5">If you did not request this, you can safely ignore this email; your password will not change.</p>' +
    '</div>'
  );
}

// Send the password-reset email. Returns { sent: boolean, link: string }.
async function sendPasswordResetEmail(to, link, name) {
  if (!RESEND_API_KEY) {
    console.log('[mailer] RESEND_API_KEY not set. Password reset link for ' + to + ':\n  ' + link);
    return { sent: false, link };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: 'Reset your OpenBook password',
        html: resetEmailHtml(name, link),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[mailer] Resend returned ' + res.status + ': ' + body);
      return { sent: false, link };
    }
    return { sent: true, link };
  } catch (e) {
    console.error('[mailer] send failed: ' + (e && e.message));
    return { sent: false, link };
  }
}

// Branded thank-you + receipt sent when a supporter payment is applied (both the
// PayPal and the USDT rails). For crypto this is the ONLY acknowledgment the
// supporter gets; for PayPal it is a warmer, on-brand confirmation than PayPal's
// generic receipt. d = { tierName, amountText, method, durationText, untilText,
// txId, supportUrl }.
function supporterThankYouHtml(name, d) {
  function row(label, val) {
    return '<tr><td style="padding:6px 0;color:#65656f;font-size:13px">' + escapeHtml(label) + '</td>' +
      '<td style="padding:6px 0;color:#1c1c28;font-size:13px;text-align:right;font-weight:700">' + escapeHtml(val) + '</td></tr>';
  }
  var receipt = '<table style="width:100%;border-collapse:collapse">' +
    row('Tier', d.tierName || '') +
    row('Amount', d.amountText || '') +
    row('Method', d.method || '') +
    (d.durationText ? row('Covers', d.durationText) : '') +
    (d.untilText ? row('Active until', d.untilText) : '') +
    (d.txId ? row('Reference', d.txId) : '') +
    '</table>';
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1c1c28">' +
    '<h2 style="color:#4f46e5">Thank you for supporting OpenBook' + (name ? ', ' + escapeHtml(name) : '') + '</h2>' +
    '<p>Your support keeps OpenBook free, independent, and neutral: no ads, and your data is never sold. It genuinely means a lot.</p>' +
    '<p>You are now on <strong>' + escapeHtml(d.tierName || 'Supporter') + '</strong>' + (d.untilText ? ', active until <strong>' + escapeHtml(d.untilText) + '</strong>' : '') + '. Your supporter perks are already live on your profile.</p>' +
    '<div style="background:#f6f6fb;border-radius:10px;padding:14px 16px;margin:18px 0">' +
    '<div style="font-size:12px;color:#9a9aa5;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Receipt</div>' +
    receipt + '</div>' +
    (d.supportUrl ? '<p style="margin:18px 0"><a href="' + d.supportUrl + '" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Open OpenBook</a></p>' : '') +
    '<p style="font-size:12px;color:#9a9aa5;line-height:1.5">Our promise: money never affects your karma, standing, reach, feed ranking, or votes. Support unlocks only cosmetic and capacity perks. This message is a receipt for your records, not a tax invoice.</p>' +
    '</div>'
  );
}

// Send the supporter thank-you + receipt. Returns { sent, html } so callers and
// tests can inspect the rendered email even when no provider is configured.
async function sendSupporterThankYouEmail(to, name, d) {
  d = d || {};
  const html = supporterThankYouHtml(name, d);
  if (!RESEND_API_KEY) {
    console.log('[mailer] (no key) supporter thank-you to ' + to + ' (' + (d.tierName || '') + ', ' + (d.amountText || '') + ')');
    return { sent: false, html };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: 'Thank you for supporting OpenBook', html }),
    });
    if (!res.ok) { const body = await res.text().catch(() => ''); console.error('[mailer] Resend returned ' + res.status + ': ' + body); return { sent: false, html }; }
    return { sent: true, html };
  } catch (e) {
    console.error('[mailer] supporter email failed: ' + (e && e.message));
    return { sent: false, html };
  }
}

// True when real sending is configured (used to decide whether to surface the
// dev link in API responses).
const EMAIL_CONFIGURED = !!RESEND_API_KEY;

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendSupporterThankYouEmail, EMAIL_CONFIGURED };
