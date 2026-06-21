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

// True when real sending is configured (used to decide whether to surface the
// dev link in API responses).
const EMAIL_CONFIGURED = !!RESEND_API_KEY;

module.exports = { sendVerificationEmail, EMAIL_CONFIGURED };
