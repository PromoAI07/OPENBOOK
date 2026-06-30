// linkpreview.js
// Link preview cards (Open Graph). When a post contains a link, we fetch the
// page's title / description / site name ONCE and cache it, so a bare URL renders
// as a titled card instead of naked text.
//
// Text only on purpose: we never hotlink the remote preview image. That would
// need an opening in the strict image CSP, would make every viewer's browser hit
// a third-party server (a privacy leak), and would cost bandwidth/storage (the
// same reason Reels are paused). A future version can proxy the image through the
// media store; until then the card is title + description + site, which already
// turns a naked link into something worth clicking.
//
// Safety: this fetches an attacker-influenced URL on the server, so it is an SSRF
// surface. We allow only http/https on the default ports, refuse credentials in
// the URL, resolve the host and refuse private/loopback/link-local IPs, cap the
// body size, and cap the time.

const dns = require('dns').promises;
const dnsCb = require('dns');
const net = require('net');
const { request: undiciRequest, Agent } = require('undici');
const db = require('./db');
const { logger } = require('./logger');

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024; // read at most 512 KB of HTML
const REFRESH_DAYS = 14;      // re-fetch a cached OK preview after this long
const MAX_REDIRECTS = 4;      // follow at most this many hops, re-validating each one

// The first http(s) URL in a chunk of text (used to pick the post's preview link).
function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"')]+/i);
  if (!m) return '';
  const u = m[0].replace(/[.,;:!?)]+$/, ''); // trim trailing sentence punctuation
  return u.slice(0, 2048);
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;             // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true;             // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)); // IPv4-mapped IPv6
  return false;
}

// A connect-time DNS lookup that REFUSES any private/loopback/link-local address.
// undici calls this for EVERY connection it makes (including each redirect hop), so the
// address it actually connects to is the one validated here. This closes the DNS-rebind
// window between safeHost()'s own resolution and the real connect (the check and the use
// are now the same resolution). Literal-IP hosts skip this lookup, but safeHost() rejects
// literal private IPs directly, so both paths are covered.
function safeLookup(hostname, options, cb) {
  dnsCb.lookup(hostname, Object.assign({ all: true }, options || {}), (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options && options.family }];
    for (const a of list) {
      if (isPrivateIp(a.address)) return cb(Object.assign(new Error('blocked private address'), { code: 'ESSRFBLOCKED' }));
    }
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}
const safeAgent = new Agent({ connect: { lookup: safeLookup } });

// Only allow public http(s) hosts. Resolves DNS and rejects if ANY resolved
// address is private, so a public name that points at 127.0.0.1 is refused too.
async function safeHost(urlObj) {
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
  if (urlObj.username || urlObj.password) return false;
  if (urlObj.port && urlObj.port !== '80' && urlObj.port !== '443') return false;
  const host = urlObj.hostname;
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch (e) { return false; }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Pull a <meta> content value for the first matching property/name (either attr order).
function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp('<meta[^>]+(?:property|name)=["\\\']' + name + '["\\\'][^>]*>', 'i');
    const tag = html.match(re);
    if (tag) {
      const c = tag[0].match(/content=["']([\s\S]*?)["']/i);
      if (c) return decodeEntities(c[1]).slice(0, 400);
    }
  }
  return '';
}

async function fetchAndParse(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects OURSELVES (maxRedirections: 0) so safeHost() re-runs on every hop.
    // Letting the client auto-follow would skip our protocol / port / credential /
    // literal-private-IP checks, and a 302 can point at an internal address (cloud
    // metadata, localhost, an admin service). undiciRequest also routes through safeAgent,
    // whose lookup rejects any hostname that resolves to a private address at connect time.
    let current = url;
    let lastHost = '';
    let res = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let urlObj;
      try { urlObj = new URL(current); } catch (e) { return { status: 'none' }; }
      if (!(await safeHost(urlObj))) return { status: 'blocked' };
      lastHost = urlObj.hostname;
      res = await undiciRequest(current, {
        dispatcher: safeAgent,
        method: 'GET',
        maxRedirections: 0,
        signal: ctrl.signal,
        headersTimeout: FETCH_TIMEOUT_MS,
        bodyTimeout: FETCH_TIMEOUT_MS,
        headers: {
          'User-Agent': 'OpenBookBot/1.0 (+https://openbook.space)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        try { res.body.destroy(); } catch (e) {}
        if (hop >= MAX_REDIRECTS) return { status: 'none' };
        try { current = new URL(res.headers.location, current).toString(); } catch (e) { return { status: 'none' }; }
        continue;
      }
      break;
    }
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    if (res.statusCode < 200 || res.statusCode >= 300 || ct.indexOf('html') === -1) {
      try { res.body.destroy(); } catch (e) {}
      return { status: 'none' };
    }
    // Read at most MAX_BYTES so a huge page cannot exhaust memory.
    let received = 0;
    const chunks = [];
    for await (const chunk of res.body) {
      received += chunk.length;
      chunks.push(chunk);
      if (received >= MAX_BYTES) { try { res.body.destroy(); } catch (e) {} break; }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const title = metaContent(html, ['og:title', 'twitter:title']) ||
      decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 200);
    const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
    const siteName = metaContent(html, ['og:site_name']) || lastHost.replace(/^www\./, '');
    if (!title && !description) return { status: 'none' };
    return { status: 'ok', title, description, site_name: siteName, image: '' };
  } catch (e) {
    return { status: 'none' };
  } finally {
    clearTimeout(timer);
  }
}

// Get a cached preview (or null). Used at render time; never fetches.
async function getPreview(url) {
  if (!url) return null;
  const row = await db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url);
  if (!row || row.status !== 'ok') return null;
  return { url: row.url, title: row.title, description: row.description, siteName: row.site_name, image: row.image };
}

// Ensure we have a fresh-enough preview, fetching at most once. Fire-and-forget
// from the post route; a failure is cached (status != 'ok') so a dead link is not
// re-fetched on every render, and is retried at most once a day.
async function ensurePreview(url) {
  if (!url) return;
  try {
    const existing = await db.prepare('SELECT status, fetched_at FROM link_previews WHERE url = ?').get(url);
    if (existing) {
      const ageDays = (Date.now() - Date.parse(String(existing.fetched_at || '').replace(' ', 'T') + 'Z')) / 86400000;
      if (existing.status === 'ok' && ageDays < REFRESH_DAYS) return;
      if (existing.status !== 'ok' && ageDays < 1) return;
    }
    const p = await fetchAndParse(url);
    await db.prepare(
      "INSERT INTO link_previews (url, status, title, description, site_name, image, fetched_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, datetime('now')) " +
      "ON CONFLICT(url) DO UPDATE SET status=excluded.status, title=excluded.title, " +
      "description=excluded.description, site_name=excluded.site_name, image=excluded.image, fetched_at=datetime('now')"
    ).run(url, p.status || 'none', p.title || '', p.description || '', p.site_name || '', p.image || '');
  } catch (e) {
    logger.warn({ err: e, url }, 'link preview fetch failed');
  }
}

module.exports = { firstUrl, getPreview, ensurePreview };
