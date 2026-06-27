// OpenBook maintenance fallback — Cloudflare Worker (free plan).
//
// Put this Worker in front of openbook.space. It passes every request straight
// through to the origin (Render). If the origin is mid-deploy and returns a 502/
// 503/504, or is briefly unreachable, it serves a friendly branded "we'll be
// right back" page instead of a raw gateway error, and the page auto-reloads so
// visitors come back on their own the moment the new version is live.
//
// How to install (Cloudflare dashboard):
//   1. Workers & Pages -> Create application -> Create Worker -> name it
//      "openbook-maintenance" -> Deploy.
//   2. Edit code -> paste this whole file -> Deploy.
//   3. The Worker's Settings -> Triggers -> Routes -> Add route:
//        Route:  openbook.space/*      Zone: openbook.space
//      (add a second route  www.openbook.space/*  if you use www)
//
// Normal traffic (including WebSockets for chat) is returned untouched; the page
// only appears during the brief deploy window when the origin is down anyway.

export default {
  async fetch(request) {
    // Safe preview: visit  openbook.space/?__maintenance_preview  to see the page
    // live without any downtime (handy for testing). Normal traffic is unaffected.
    try {
      const url = new URL(request.url);
      if (url.searchParams.has('__maintenance_preview')) return maintenancePage();
    } catch (e) {}
    try {
      const response = await fetch(request);
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        return maintenancePage();
      }
      return response;
    } catch (err) {
      // Origin unreachable during the restart.
      return maintenancePage();
    }
  },
};

function maintenancePage() {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>OpenBook, back in a moment</title><style>' +
    'html,body{height:100%;margin:0}' +
    'body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff}' +
    '.box{max-width:460px}' +
    '.logo{width:66px;height:66px;border-radius:16px;background:rgba(255,255,255,.16);' +
    'display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:800;margin:0 auto 22px}' +
    'h1{font-size:26px;margin:0 0 10px}p{font-size:16px;opacity:.92;line-height:1.55;margin:0 0 20px}' +
    '.dots span{display:inline-block;width:9px;height:9px;border-radius:50%;background:#fff;margin:0 3px;animation:b 1.2s infinite}' +
    '.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}' +
    '@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}</style></head>' +
    '<body><div class="box"><div class="logo">O</div>' +
    '<h1>We are pushing a new update</h1>' +
    '<p>OpenBook will be right back, this usually takes less than a minute. Thanks for your patience.</p>' +
    '<div class="dots"><span></span><span></span><span></span></div>' +
    '<script>setTimeout(function(){location.reload()},15000)</script>' +
    '</div></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '20', 'cache-control': 'no-store' },
  });
}
