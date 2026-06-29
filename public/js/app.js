// app.js
// The OpenBook single page app: top bar, feed, profiles, friends, stories,
// notifications, search, and the messages view. Talks to the JSON API (api.js)
// and the live socket (chat.js).

(function () {
  let ME = null;
  let currentView = 'feed';
  let activeChatUser = null;
  const view = document.getElementById('view');

  /* ============================ helpers ============================ */

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function linkify(escaped) {
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  // Only let http(s) URLs become a real href. Anything else (javascript:, data:,
  // etc.) collapses to '#', so a hostile link-post URL cannot run script when
  // clicked. The visible link text still shows the raw URL via esc().
  function safeHref(u) {
    try {
      const x = new URL(u, window.location.origin);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '#';
    } catch (e) {
      return '#';
    }
  }

  // --- Owner analytics: coarse, privacy-safe usage pings (page views, button
  // clicks, visibility heartbeats for time-on-platform). Aggregate only, no
  // content or personal data ever leaves the client here. ---
  const AN = (function () {
    let sid;
    try { sid = sessionStorage.getItem('ob_sid'); if (!sid) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('ob_sid', sid); } }
    catch (e) { sid = 's' + Date.now(); }
    let queue = [];
    function flush(beacon) {
      if (!queue.length) return;
      const body = JSON.stringify({ session: sid, events: queue });
      queue = [];
      try {
        if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/analytics', new Blob([body], { type: 'application/json' }));
        else fetch('/api/analytics', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
      } catch (e) {}
    }
    function push(type, label) { queue.push({ type: type, label: (label == null ? '' : ('' + label)).slice(0, 80) }); if (queue.length >= 12) flush(); }
    setInterval(function () { if (document.visibilityState === 'visible') push('heartbeat', ''); flush(); }, 20000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
    window.addEventListener('pagehide', function () { flush(true); });
    document.addEventListener('click', function (e) {
      const node = (e.target && e.target.closest) ? e.target.closest('[data-track],[data-go],.nav-tab,.side-link,.btn') : null;
      if (!node) return;
      let label = node.getAttribute('data-track') || node.getAttribute('data-go');
      if (!label) {
        if (node.classList.contains('nav-tab')) label = 'tab:' + (node.textContent || '').trim().slice(0, 20);
        else label = 'btn:' + ((node.textContent || '').trim().slice(0, 24) || node.tagName.toLowerCase());
      }
      push('click', label);
    }, true);
    return { page: function (name) { push('pageview', name); }, flush: flush };
  })();

  const AVATAR_COLORS = ['#4f46e5', '#0ea5a4', '#e0245e', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#3b82f6'];
  function colorFor(name) {
    const s = name || '?';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % AVATAR_COLORS.length;
    return AVATAR_COLORS[Math.abs(h)];
  }

  function avatar(user, size) {
    size = size || 40;
    const dim = 'width:' + size + 'px;height:' + size + 'px;';
    const gold = (user && user.founder) ? ' av-gold' : ''; // golden ring for the founder
    if (user && user.avatar) {
      const pos = user.avatarPos ? 'object-position:' + esc(user.avatarPos) + ';' : '';
      return '<img class="avatar' + gold + '" style="' + dim + pos + '" src="' + esc(user.avatar) + '" alt="">';
    }
    const initial = (((user && user.name) || '?').trim().charAt(0) || '?');
    const fs = Math.round(size * 0.42);
    return '<span class="avatar-fallback' + gold + '" style="' + dim + 'background:' + colorFor((user && user.name) || '?') +
      ';font-size:' + fs + 'px">' + esc(initial) + '</span>';
  }

  // Cosmetic Founder badge for the platform founder(s). Never reputation.
  function founderBadge(user) {
    if (!user || !user.founder) return '';
    return ' <span class="founder-badge" title="Founder of OpenBook">&#9733; Founder</span>';
  }
  // Cosmetic Pioneer badge for the first 5000 members. It is blue by default, but
  // takes the COLOR of the member's ACTIVE support tier while they support (bronze
  // / silver / gold for Supporter / Plus / Premium), and reverts to blue when
  // support lapses. This merges the Pioneer + supporter badges into ONE, so a
  // supporting Pioneer shows a single colored Pioneer badge, not two badges. Never
  // reputation.
  function pioneerBadge(user) {
    if (!user || !user.pioneer) return '';
    const tierClass = { bronze: ' pio-bronze', silver: ' pio-silver', gold: ' pio-gold' };
    const cls = (user.badge && tierClass[user.badge]) ? tierClass[user.badge] : '';
    const tip = user.badge
      ? 'Pioneer + ' + (user.tierName || 'Supporter') + ' supporter'
      : 'One of the first 5,000 members of OpenBook';
    return ' <span class="pioneer-badge' + cls + '" title="' + esc(tip) + '">&#9873; Pioneer</span>';
  }
  // Premium profile themes: preset accent + gradient combos. Ids MUST match the
  // server allowlist in routes/users.js (THEME_IDS).
  var PROFILE_THEMES = {
    midnight: { name: 'Midnight', accent: '#8b7cff', gradient: 'linear-gradient(135deg,#1e1b4b 0%,#4338ca 55%,#8b7cff 100%)' },
    sunset:   { name: 'Sunset',   accent: '#ff7a59', gradient: 'linear-gradient(135deg,#7a1f3d 0%,#e23e57 50%,#ff9a5a 100%)' },
    ocean:    { name: 'Ocean',    accent: '#22b8cf', gradient: 'linear-gradient(135deg,#0c4a6e 0%,#0ea5e9 55%,#22d3ee 100%)' },
    forest:   { name: 'Forest',   accent: '#22c55e', gradient: 'linear-gradient(135deg,#064e3b 0%,#15803d 55%,#4ade80 100%)' },
    rose:     { name: 'Rose',     accent: '#f472b6', gradient: 'linear-gradient(135deg,#831843 0%,#db2777 55%,#f9a8d4 100%)' },
    gold:     { name: 'Gold',     accent: '#e0a800', gradient: 'linear-gradient(135deg,#7c2d12 0%,#d97706 55%,#fcd34d 100%)' },
    aurora:   { name: 'Aurora',   accent: '#34d399', gradient: 'linear-gradient(135deg,#4338ca 0%,#06b6d4 50%,#34d399 100%)' },
    graphite: { name: 'Graphite', accent: '#94a3b8', gradient: 'linear-gradient(135deg,#0f172a 0%,#334155 55%,#94a3b8 100%)' },
  };
  function themeFor(u) { return (u && u.theme && PROFILE_THEMES[u.theme]) ? PROFILE_THEMES[u.theme] : null; }
  // Soft translucent tint from a theme accent hex, used to wash the profile
  // background behind the posts (the vibrant gradient frames only the top).
  function hexToRgba(hex, a) {
    var h = String(hex || '').replace('#', '');
    if (h.length !== 6) return 'rgba(99,102,241,' + a + ')';
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  // Supporter blue verified tick (any paid tier) plus the Founder badge if set.
  // Both are cosmetic, never reputation. Appended to author names everywhere
  // through this one helper, so the Founder badge follows the founder wherever
  // they post or comment. Returns '' for a plain free account.
  function verifTick(user) {
    let out = '';
    if (user && user.verified) {
      const label = (user.tierName ? user.tierName + ' supporter' : 'Verified supporter');
      out += ' <svg class="vtick" viewBox="0 0 24 24" role="img" aria-label="' + esc(label) + '"><title>' + esc(label) +
        '</title><path d="M12 1.5l2.4 1.8 3 .1 .9 2.8 2.4 1.7-.9 2.8.9 2.8-2.4 1.7-.9 2.8-3 .1L12 22.5l-2.4-1.8-3-.1-.9-2.8L3.3 16l.9-2.8L3.3 10.4l2.4-1.7.9-2.8 3-.1L12 1.5z"/>' +
        '<path class="vtick-check" d="M8.2 12.2l2.4 2.4 5-5"/></svg>';
    }
    out += founderBadge(user);
    out += pioneerBadge(user);
    return out;
  }
  // Small colored supporter badge (bronze/silver/gold). Shown on profiles.
  // For a Pioneer we SUPPRESS this chip: their support tier is shown by coloring
  // their Pioneer badge instead (see pioneerBadge), so they never carry two badges.
  function badgeChip(user) {
    if (!user || !user.badge) return '';
    if (user.pioneer) return '';
    const map = { bronze: 'Supporter', silver: 'Plus', gold: 'Premium' };
    const label = map[user.badge] || 'Supporter';
    return '<span class="badge-chip badge-' + esc(user.badge) + '">' + esc(label) + '</span>';
  }
  // Name plus tick, the standard way to print a user's display name.
  function nameTick(user) { return esc(user.name) + verifTick(user); }

  function parseTime(iso) {
    if (!iso) return new Date();
    // sqlite returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const t = iso.indexOf('T') >= 0 ? iso : iso.replace(' ', 'T') + 'Z';
    return new Date(t);
  }

  function timeAgo(iso) {
    const d = parseTime(iso);
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + 'd';
    return d.toLocaleDateString();
  }

  function toast(msg) {
    const t = el('<div class="toast"></div>');
    t.textContent = msg;
    document.getElementById('toastRoot').appendChild(t);
    if (window.anime) anime({ targets: t, opacity: [0, 1], translateY: [10, 0], duration: 200, easing: 'easeOutCubic' });
    setTimeout(() => t.remove(), 2600);
  }

  function modal(innerHtml) {
    const back = el('<div class="modal-back"><div class="modal">' + innerHtml + '</div></div>');
    document.getElementById('modalRoot').appendChild(back);
    function close() { back.remove(); }
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    if (window.anime) anime({ targets: back.querySelector('.modal'), scale: [0.95, 1], opacity: [0.5, 1], duration: 200, easing: 'easeOutCubic' });
    return { node: back, close: close, q: (sel) => back.querySelector(sel) };
  }

  // Share a link via the device's native share sheet (mobile, and some desktops),
  // falling back to copying it to the clipboard so it always works.
  function shareLink(url, title) {
    try { if (navigator.share) { navigator.share({ title: title || 'OpenBook', url: url }).catch(function () {}); return; } } catch (e) {}
    try { navigator.clipboard.writeText(url).then(function () { toast('Link copied to clipboard'); }, function () { toast(url); }); }
    catch (e) { toast(url); }
  }
  function profileShareUrl(u) { return window.location.origin + '/u/' + encodeURIComponent((u && u.username) || (u && u.id) || ''); }
  function postShareUrl(id) { return window.location.origin + '/p/' + id; }

  function pickImage(cb) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => { if (input.files[0]) cb(input.files[0]); };
    input.click();
  }

  function scrollBottom(elm) { if (elm) elm.scrollTop = elm.scrollHeight; }

  /* ============================ boot ============================ */

  async function boot() {
    try {
      const r = await API.me();
      ME = r.user;
    } catch (e) {
      window.location.href = '/';
      return;
    }
    Chat.init();
    setupChrome();
    wireSocket();
    refreshBadges();

    // Verification feedback from the email link (/app?verified=1).
    const params = new URLSearchParams(window.location.search);
    if (params.get('verified') === '1') { ME.emailVerified = true; toast('Email verified. You can post now.'); }
    else if (params.get('verified') === '0') { toast('That verification link was invalid or expired.'); }
    if (params.has('verified')) window.history.replaceState({}, '', '/app');

    renderVerifyBanner();

    // Deep links from a shared URL: /u/<username-or-id> opens a profile, /p/<id>
    // opens a post, /app#reel=<id> opens a reel. The clean path is normalised back
    // to /app once handled so the running app's URL stays tidy.
    const dpath = window.location.pathname;
    const um = /^\/u\/([^\/?#]+)/.exec(dpath);
    const ppm = /^\/p\/(\d+)/.exec(dpath);
    const reelMatch = /(?:^|#)reel=(\d+)/.exec(window.location.hash);
    if (um) { go('profile', decodeURIComponent(um[1])); }
    else if (ppm) { go('post', Number(ppm[1])); }
    else if (reelMatch) { pendingReel = Number(reelMatch[1]); go('reels'); }
    else go('feed');
  }

  // A dismissable-by-verifying banner shown to accounts that have not confirmed
  // their email yet. They can browse, but the soft gate blocks posting.
  function renderVerifyBanner() {
    const existing = document.getElementById('verifyBanner');
    if (ME.emailVerified) { if (existing) existing.remove(); return; }
    if (existing) return;
    const b = el(
      '<div id="verifyBanner" class="verify-banner">' +
      '<span>&#9993; Verify your email to start posting. We sent a link to <b>' + esc(ME.email || 'your inbox') + '</b>.</span>' +
      '<button class="btn btn-sm" id="resendVerify">Resend email</button></div>'
    );
    const layout = document.querySelector('.layout');
    layout.parentNode.insertBefore(b, layout);
    b.querySelector('#resendVerify').onclick = async () => {
      const btn = b.querySelector('#resendVerify');
      btn.disabled = true;
      try {
        const r = await API.resendVerification();
        toast(r.sent ? 'Verification email sent. Check your inbox.' : 'Saved. If email is not configured yet, ask the admin.');
      } catch (e) { toast(e.message); }
      btn.disabled = false;
    };
  }

  /* ============================ chrome / nav ============================ */

  function setupChrome() {
    setupChromeAvatar();
    document.getElementById('meBtn').onclick = () => go('profile', ME.id);

    // Wire every nav target: top-bar logo + center tabs, the messages button,
    // and the mobile bottom-nav tabs (all carry data-nav).
    document.querySelectorAll('.topbar [data-nav], .bottom-nav [data-nav]').forEach((b) => {
      b.addEventListener('click', () => go(b.getAttribute('data-nav')));
    });
    document.getElementById('notifBtn').addEventListener('click', toggleNotifs);

    const si = document.getElementById('searchInput');
    let to;
    si.addEventListener('input', () => {
      clearTimeout(to);
      const q = si.value.trim();
      to = setTimeout(() => { if (q) go('search', q); }, 300);
    });
    si.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const q = si.value.trim(); if (q) go('search', q); }
    });

    renderLeftRail();

    document.addEventListener('click', (e) => {
      const dd = document.getElementById('notifDropdown');
      const btn = document.getElementById('notifBtn');
      if (!dd.classList.contains('hidden') && !dd.contains(e.target) && !btn.contains(e.target)) {
        dd.classList.add('hidden');
      }
    });

    // Delegated handlers for report and appeal buttons (they appear on many
    // dynamically-rendered surfaces, so one listener covers them all).
    document.addEventListener('click', (e) => {
      const shp = e.target.closest('[data-share-post]');
      if (shp) { e.preventDefault(); e.stopPropagation(); shareLink(postShareUrl(shp.getAttribute('data-share-post')), 'OpenBook post'); return; }
      const shu = e.target.closest('[data-share-profile]');
      if (shu) { e.preventDefault(); e.stopPropagation(); shareLink(window.location.origin + '/u/' + encodeURIComponent(shu.getAttribute('data-share-profile')), 'OpenBook profile'); return; }
      const rep = e.target.closest('[data-report]');
      if (rep) { e.preventDefault(); e.stopPropagation(); reportModal(rep.getAttribute('data-report'), Number(rep.getAttribute('data-report-id'))); return; }
      const ap = e.target.closest('[data-appeal]');
      if (ap) { e.preventDefault(); e.stopPropagation(); appealModal(ap.getAttribute('data-appeal-type'), Number(ap.getAttribute('data-appeal-id')) || null); }
    });

    // A shared reel link can also be opened while the app is already running.
    window.addEventListener('hashchange', () => {
      const m = /(?:^|#)reel=(\d+)/.exec(window.location.hash);
      if (m) { pendingReel = Number(m[1]); go('reels'); }
    });
  }

  function setupChromeAvatar() {
    document.getElementById('meBtn').innerHTML = avatar(ME, 32);
  }

  // Highlight the matching top tab and side-menu link. Sub-views map back to
  // their parent destination so the right tab stays lit (e.g. a community page
  // keeps "Communities" active).
  function setActiveNav(name) {
    const alias = { community: 'communities', group: 'groups' };
    const active = alias[name] || name;
    document.querySelectorAll('.nav-tab[data-nav], .nav-btn[data-nav]').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-nav') === active)
    );
    document.querySelectorAll('.side-link[data-go]').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-go') === active)
    );
  }

  function go(name, param) {
    currentView = name;
    setActiveNav(name);
    document.getElementById('notifDropdown').classList.add('hidden');

    const layout = document.querySelector('.layout');
    const left = document.getElementById('leftRail');
    const right = document.getElementById('rightRail');
    if (name === 'messages') {
      left.style.display = 'none';
      right.style.display = 'none';
      layout.style.gridTemplateColumns = '1fr';
      layout.style.maxWidth = '960px';
    } else {
      left.style.display = '';
      right.style.display = '';
      layout.style.gridTemplateColumns = '';
      layout.style.maxWidth = '';
    }

    if (name === 'feed') renderFeed();
    else if (name === 'profile') renderProfile(param || ME.id);
    else if (name === 'friends') renderFriends();
    else if (name === 'messages') renderMessages(param);
    else if (name === 'search') renderSearch(param);
    else if (name === 'marketplace') renderMarketplace();
    else if (name === 'groups') renderGroups();
    else if (name === 'group') renderGroup(param);
    else if (name === 'album') renderAlbum(param);
    else if (name === 'communities') renderCommunities();
    else if (name === 'community') renderCommunity(param);
    else if (name === 'post') renderPost(param);
    else if (name === 'dashboard') renderDashboard();
    else if (name === 'reels') renderReels();
    else if (name === 'support') renderSupport();
    else if (name === 'invite') renderInvite();
    else if (name === 'suggestions') renderSuggestions();
    else if (name === 'jury') renderJury();
    // Keep the address bar in sync so a profile or post can be copied straight from
    // the URL. profile/post set their own /u/<username> or /p/<id> once their data
    // loads; every other view resets the URL to /app.
    if (name !== 'profile' && name !== 'post') { try { window.history.replaceState({}, '', '/app'); } catch (e) {} }
    try { AN.page(name); } catch (e) {}
    window.scrollTo(0, 0);
  }

  // The side menu holds the destinations that are NOT primary top-bar tabs, so
  // the two menus no longer duplicate each other. Home / Communities /
  // Marketplace / Dashboard live in the top bar; Messages + Notifications live
  // top-right; everything else (your profile, Friends, Groups, Reels) lives here.
  function renderLeftRail() {
    const rail = document.getElementById('leftRail');
    rail.innerHTML =
      '<div class="card" style="padding:8px">' +
      '<div class="side-link" data-go="profile">' + avatar(ME, 32) + '<span>' + esc(ME.name) + '</span></div>' +
      '<div class="side-link" data-go="friends"><span class="ic">&#128101;</span><span>Friends</span><span class="badge side-badge hidden" id="friendsBadge">0</span></div>' +
      '<div class="side-link" data-go="groups"><span class="ic">&#127760;</span><span>Groups</span></div>' +
      '<div class="side-link" data-go="reels"><span class="ic">&#127909;</span><span>Reels</span></div>' +
      '<div class="side-link" data-go="suggestions"><span class="ic">&#128161;</span><span>Suggestions</span></div>' +
      '<div class="side-link" data-go="jury"><span class="ic">&#9878;&#65039;</span><span>Jury duty</span><span class="badge side-badge hidden" id="juryBadge">0</span></div>' +
      '<div class="side-link" data-go="invite"><span class="ic">&#127881;</span><span>Invite friends</span></div>' +
      '<div class="side-link" data-go="support"><span class="ic">&#10084;&#65039;</span><span>Support OpenBook</span></div>' +
      '<div class="side-link" id="themeToggle"><span class="ic">' + (currentTheme() === 'dark' ? '&#9728;&#65039;' : '&#127769;') + '</span><span>' + (currentTheme() === 'dark' ? 'Light mode' : 'Dark mode') + '</span></div>' +
      '<div class="side-link" id="leftLogout"><span class="ic">&#128682;</span><span>Log out</span></div>' +
      '</div>' +
      '<nav class="rail-foot">' +
      '<a href="/mission">Our Mission</a>' +
      '<a href="/roadmap">Roadmap</a>' +
      '<a href="/mod-log">Transparency Log</a>' +
      '<a href="/rules">Rules</a>' +
      '<a href="/privacy">Privacy Policy</a>' +
      '<a href="/cookies">Cookies</a>' +
      '<a href="https://github.com/PromoAI07/OPENBOOK" target="_blank" rel="noopener">Open source</a>' +
      '<div class="rail-foot-copy">OpenBook. Your data is yours, always.</div>' +
      '</nav>';
    rail.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => {
        const n = b.getAttribute('data-go');
        if (n === 'profile') go('profile', ME.id);
        else go(n);
      })
    );
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('leftLogout').addEventListener('click', doLogout);
    refreshBadges();
    refreshJuryBadge();
  }

  // Light fetch to show a count on the "Jury duty" rail entry when the user has
  // open cases they have not yet voted on.
  function refreshJuryBadge() {
    API.juryDuties().then(({ duties }) => {
      const open = (duties || []).filter((d) => !d.myVote && !d.gone).length;
      const b = document.getElementById('juryBadge');
      if (!b) return;
      if (open > 0) { b.textContent = open; b.classList.remove('hidden'); }
      else b.classList.add('hidden');
    }).catch(() => {});
  }

  async function renderJury() {
    view.innerHTML =
      '<div class="card"><div class="pname">&#9878;&#65039; Jury duty</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.5">You were randomly selected to help decide whether flagged content should stay or go. Judge the content, not the person. You are anonymous, the majority decides, and the outcome (with the ballot) is posted to the public <a href="/mod-log" target="_blank" style="color:var(--brand)">transparency log</a>.</div></div>' +
      '<div id="juryList"><div class="card"><div class="empty">Loading your cases...</div></div></div>';
    try {
      const { duties } = await API.juryDuties();
      const list = document.getElementById('juryList');
      if (!duties.length) {
        list.innerHTML = '<div class="card"><div class="empty">No open cases right now. If you are picked for a jury, it will show up here and in your notifications.</div></div>';
        return;
      }
      list.innerHTML = '';
      duties.forEach((d) => {
        const actions = d.myVote
          ? '<div class="shint" style="font-size:12px">You voted <b>' + esc(d.myVote) + '</b>. Waiting on the rest of the panel of ' + d.size + '.</div>'
          : '<div class="row" style="gap:8px"><button class="btn btn-primary" data-keep="' + d.id + '">Keep</button><button class="btn" data-remove="' + d.id + '" style="color:#e5484d">Remove</button></div>';
        const card = el(
          '<div class="card">' +
          '<div class="shint" style="font-size:12px;margin-bottom:6px">Flagged for: <b>' + esc(d.reasonCode || 'other') + '</b> &middot; panel of ' + d.size + '</div>' +
          '<div style="margin:6px 0 10px;white-space:pre-wrap;word-break:break-word">' + (d.gone ? '<i>(content is no longer available)</i>' : esc(d.preview || '(no text content)')) + '</div>' +
          actions + '</div>'
        );
        list.appendChild(card);
      });
      list.querySelectorAll('[data-keep]').forEach((b) => (b.onclick = () => castJury(b.getAttribute('data-keep'), 'keep')));
      list.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => castJury(b.getAttribute('data-remove'), 'remove')));
    } catch (e) {
      document.getElementById('juryList').innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>';
    }
  }

  async function castJury(id, vote) {
    try {
      const r = await API.juryVote(id, vote);
      toast(r.settled ? 'Your vote settled the case. Thank you.' : 'Vote recorded. Thank you for serving.');
      renderJury();
      refreshJuryBadge();
    } catch (e) { toast(e.message); }
  }

  /* ---------- theme (light / dark) ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('ob_theme', theme); } catch (e) {}
  }
  function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    renderLeftRail(); // refresh the toggle's icon and label
  }

  async function doLogout() {
    try { await API.logout(); } catch (e) {}
    window.location.href = '/';
  }

  /* ============================ badges ============================ */

  function setBadge(id, count) {
    const b = document.getElementById(id);
    if (!b) return;
    if (count && count > 0) {
      b.textContent = count > 99 ? '99+' : count;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  async function refreshBadges() {
    try { setBadge('notifBadge', (await API.unreadNotifs()).count); } catch (e) {}
    try { setBadge('messagesBadge', (await API.unreadMessages()).count); } catch (e) {}
    try { setBadge('friendsBadge', (await API.friendRequests()).users.length); } catch (e) {}
  }

  /* ============================ feed ============================ */

  // A welcome banner for brand-new accounts (under 30 days old), shown at the top
  // of the home feed and dismissible. Computed from the signup date we already
  // have, so it needs no server changes and disappears on its own after 30 days.
  function welcomeBannerHtml() {
    try { if (localStorage.getItem('ob_welcome_dismissed') === '1') return ''; } catch (e) {}
    const created = ME && ME.created_at ? new Date(String(ME.created_at).replace(' ', 'T') + 'Z').getTime() : 0;
    if (!created || (Date.now() - created) / 86400000 > 30) return '';
    return '<div class="card welcome-banner" id="welcomeBanner">' +
      '<button class="welcome-x" id="welcomeClose" aria-label="Dismiss" title="Dismiss">&times;</button>' +
      '<div class="welcome-body">' +
        '<span class="welcome-text"><span class="welcome-emoji">&#127793;</span> <strong>OpenBook just launched, and you&#39;re one of the first.</strong> Help shape it: explore every corner, then tell us what&#39;s broken or what to build next in the Suggestions box.</span>' +
        '<button class="btn btn-primary btn-sm welcome-cta" id="welcomeSuggest">Open Suggestions</button>' +
      '</div></div>';
  }

  async function renderFeed() {
    view.innerHTML =
      welcomeBannerHtml() +
      '<div class="card" id="storiesCard"><div class="stories" id="storiesRow"><div class="empty" style="padding:10px">Loading stories...</div></div></div>' +
      composerHtml() +
      '<div class="card"><div class="mk-head"><div class="tabs">' +
        '<button class="tab" data-feed="latest">Latest</button>' +
        '<button class="tab" data-feed="hot">Hot</button>' +
        '<button class="tab" data-feed="top">Top</button>' +
        '<button class="tab" data-feed="discover">Discover</button>' +
      '</div><span style="flex:1"></span><span class="muted" id="feedHint" style="font-size:12px;align-self:center"></span></div></div>' +
      '<div id="announcements"></div>' +
      '<div id="feedPosts"><div class="card"><div class="empty">Loading your feed...</div></div></div>';
    wireComposer('feedPosts');
    const wSuggest = document.getElementById('welcomeSuggest');
    if (wSuggest) wSuggest.onclick = () => go('suggestions');
    const wClose = document.getElementById('welcomeClose');
    if (wClose) wClose.onclick = () => {
      try { localStorage.setItem('ob_welcome_dismissed', '1'); } catch (e) {}
      const b = document.getElementById('welcomeBanner');
      if (b) b.remove();
    };
    loadStories();
    loadAnnouncements();
    const hint = document.getElementById('feedHint');
    function syncFeedUI() {
      view.querySelectorAll('.tab[data-feed]').forEach((t) => t.classList.toggle('active', t.getAttribute('data-feed') === feedMode));
      hint.textContent = feedMode === 'latest' ? 'Friends, newest first'
        : feedMode === 'discover' ? 'Public posts from across OpenBook'
        : 'Friends + your communities, ranked';
    }
    view.querySelectorAll('.tab[data-feed]').forEach((t) => {
      t.onclick = () => { feedMode = t.getAttribute('data-feed'); syncFeedUI(); loadFeedPosts(); };
    });
    syncFeedUI();
    loadFeedPosts();
    renderRightRail();
  }

  // Pinned, clearly-labeled site announcements shown at the top of the feed.
  // Transparent: everyone sees these are pinned announcements, not organic
  // ranking. (Ranking itself is never touched.)
  function loadAnnouncements() {
    const box = document.getElementById('announcements');
    if (!box) return;
    API.announcements().then((r) => {
      const posts = (r && r.posts) || [];
      if (!posts.length) { box.innerHTML = ''; return; }
      box.innerHTML = '';
      posts.forEach((p) => {
        const wrap = el('<div class="ann-wrap"><div class="ann-label">&#128204; Announcement from OpenBook</div></div>');
        wrap.appendChild(p.community_id ? communityPostCard(p) : renderPostNode(p));
        box.appendChild(wrap);
      });
    }).catch(() => { box.innerHTML = ''; });
  }

  async function loadFeedPosts() {
    const container = document.getElementById('feedPosts');
    if (!container) return;
    container.innerHTML = '<div class="card"><div class="empty">Loading your feed...</div></div>';
    try {
      if (feedMode === 'latest') {
        const r = await API.feed();
        renderPosts(container, r.posts, 'Your feed is quiet for now. Add some friends or write your first post above.');
      } else if (feedMode === 'discover') {
        const r = await API.discoverFeed('hot');
        renderMixedFeed(container, r.posts, 'Nothing to discover yet. Public community posts from across OpenBook will show up here.');
      } else {
        const r = await API.homeFeed(feedMode);
        renderMixedFeed(container, r.posts, 'Nothing ranked yet. Join a community or add some friends to fill your feed.');
      }
    } catch (e) {
      container.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>';
    }
  }

  // The combined feed mixes plain Facebook-style posts with community posts, so
  // each renders in its native card (reactions vs vote arrows).
  function renderMixedFeed(container, posts, emptyMsg) {
    container.innerHTML = '';
    if (!posts.length) {
      container.innerHTML = '<div class="card"><div class="empty">' + esc(emptyMsg) + '</div></div>';
      return;
    }
    posts.forEach((p) => container.appendChild(p.community_id ? communityPostCard(p) : renderPostNode(p)));
  }

  /* ============================ support / funding ============================ */

  async function renderSupport() {
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading...</div></div>';
    const [lk, tr, st, pl, nw, cs, pmFull, lb] = await Promise.all([
      API.support().catch(() => ({})),
      API.tiers().then((r) => r.tiers).catch(() => []),
      API.myStats().then((r) => r.supporter).catch(() => null),
      API.billingPlans().then((r) => r.plans).catch(() => []),
      API.billingNetworks().then((r) => r.networks).catch(() => []),
      API.communityStats().catch(() => null),
      API.myPayments().catch(() => ({ payments: [], hideSupporter: false })),
      API.supporterLeaderboard().catch(() => ({ supporters: [], total: 0, supporterCount: 0 })),
    ]);
    const links = lk || {}, tiers = tr || [], mine = st, networks = nw || [];
    const payments = (pmFull && pmFull.payments) || [];
    const myHidden = !!(pmFull && pmFull.hideSupporter);
    const board = lb || { supporters: [], total: 0, supporterCount: 0 };

    // Growth-phase card: where OpenBook is on its public scaling ladder, the live
    // member count + the Phase-1 signup cap, and the Pioneer-badge note. Replaces
    // the old standalone Pioneer card (both are about the same 5,000 milestone).
    let growthCard = '';
    if (cs && cs.phase) {
      const users = cs.users || 0;
      const ph = cs.phase; // { n, name, from, to }
      const cap = cs.maxUsers || 5000;
      const ceil = ph.to || 5000;
      const into = Math.max(0, users - (ph.from || 0));
      const span = Math.max(1, (ph.to || 5000) - (ph.from || 0));
      const pct = Math.max(2, Math.min(100, Math.round((into / span) * 100)));
      const full = !!cs.signupsFull;
      const fmtN = (x) => x >= 1000000 ? (x / 1000000) + 'M' : (x >= 1000 ? (x / 1000) + 'k' : '' + x);
      const ladder = (cs.phases || []).map((p) => {
        const state = users >= p.to ? 'done' : (users >= p.from ? 'cur' : 'next');
        return '<div class="phase-step phase-' + state + '"><div class="ps-n">' + esc(p.name) + '</div><div class="ps-to">to ' + fmtN(p.to) + '</div></div>';
      }).join('');
      growthCard = '<div class="card">' +
        '<div style="font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:18px">&#128640;</span> Where OpenBook is now: <span style="color:var(--brand)">' + esc(ph.name) + '</span> <span class="pioneer-badge">&#9873; Pioneer era</span></div>' +
        '<div class="shint" style="font-size:13px;line-height:1.55;margin:5px 0 10px">We grow in stages, opening more capacity as support funds bigger servers. ' +
          (full ? 'Phase 1 is currently full at ' + cap.toLocaleString() + ' members. ' : 'Signups are open and capped at ' + cap.toLocaleString() + ' members for Phase 1. ') +
          'The first 5,000 members keep a permanent Pioneer badge, and supporting us funds the jump to the next phase.</div>' +
        '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px">' +
          '<span style="font-size:30px;font-weight:800;line-height:1;color:var(--brand)" id="supMembers">' + users.toLocaleString() + '</span>' +
          '<span class="shint" style="font-size:14px">of ' + ceil.toLocaleString() + ' members (' + esc(ph.name) + ' ceiling)</span></div>' +
        '<div style="height:9px;border-radius:99px;background:var(--hover);overflow:hidden;margin-bottom:14px">' +
          '<div style="height:100%;width:' + pct + '%;border-radius:99px;background:linear-gradient(135deg,#4f8cff,#2563eb)"></div></div>' +
        '<div class="phase-ladder">' + ladder + '</div>' +
        '</div>';
    }
    const plans = {};
    (pl || []).forEach((p) => { plans[p.tier] = p; });
    const planDefault = { 1: { usd: 12, label: '1 year' }, 2: { usd: 18, label: '6 months' }, 3: { usd: 30, label: '3 months' } };
    const curTier = mine ? mine.tier : 0;
    const origin = window.location.origin;
    const expiresNote = (mine && mine.tier > 0)
      ? (mine.expires
          ? '<div class="shint" style="font-size:12px;margin-top:6px">Your ' + esc(mine.tierName) + ' status is active until ' + esc(new Date(String(mine.expires).replace(' ', 'T') + 'Z').toLocaleDateString()) + '.</div>'
          : '<div class="shint" style="font-size:12px;margin-top:6px">You are a ' + esc(mine.tierName) + ' supporter. Thank you!</div>')
      : '';

    // --- Inline SVG coin logos (self-contained, never a broken image) ---
    var USDT_SVG = '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#26A17B"/><path fill="#fff" d="M13.4 10.6V9.3h3.1V7.3H7.5v2h3.1v1.3c-2.5.12-4.4.62-4.4 1.22 0 .6 1.9 1.1 4.4 1.22v4.06h2.8v-4.06c2.5-.12 4.4-.62 4.4-1.22 0-.6-1.9-1.1-4.4-1.22zm0 2.05c-.06 0-.4.02-1.4.02-.8 0-1.36-.01-1.4-.02-2.15-.1-3.76-.47-3.76-.92 0-.45 1.6-.83 3.76-.92v1.46c.04.01.6.04 1.42.04.97 0 1.32-.03 1.38-.04v-1.46c2.15.1 3.76.47 3.76.92 0 .45-1.6.82-3.76.92z"/></svg>';
    var NET_SVG = {
      tron: '<svg width="34" height="34" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#EF0027"/><path fill="#fff" d="M21.9 11.4c-.6-.56-1.43-1.4-2.1-2l-.04-.03a1 1 0 0 0-.3-.16l-9.92-1.86c-.13-.02-.27 0-.39.06a.6.6 0 0 0-.16.14.66.66 0 0 0-.12.28v.1l2.6 7.24c.05.16.16.3.3.38.15.08.32.1.48.06l6.06-1.13-4.2 5.22c-.07.1-.1.21-.08.32a.5.5 0 0 0 .15.28c.08.07.18.1.28.1a.5.5 0 0 0 .2-.05l9.16-4.47c.13-.06.22-.18.25-.32a.5.5 0 0 0-.1-.43zm-2.65 1.03l1.7 1.44-3.1.58zm-1-.2l-2.85.53-2.05-5.7zm-.9 4.46l-3.94.74-3.32-7.6zm.95.32l3.18-.6-4.55 2.22z"/></svg>',
      ethereum: '<svg width="34" height="34" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#627EEA"/><g fill="#fff"><path fill-opacity=".6" d="M12 3.2v6.4l5.4 2.4z"/><path d="M12 3.2L6.6 12l5.4-2.4z"/><path fill-opacity=".6" d="M12 16.1v4.7l5.4-7.5z"/><path d="M12 20.8v-4.7L6.6 13.3z"/><path fill-opacity=".2" d="M12 15.1l5.4-3.1L12 9.6z"/><path fill-opacity=".6" d="M6.6 12l5.4 3.1V9.6z"/></g></svg>',
      bsc: '<svg width="34" height="34" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#F3BA2F"/><path fill="#fff" d="M12.1 14.2L16 10.3l3.9 3.9 2.27-2.27L16 5.76l-6.17 6.17zM6.5 16l2.27-2.27L11.04 16l-2.27 2.27zm5.6 1.8L16 21.7l3.9-3.9 2.27 2.26L16 26.24l-6.17-6.18zm8.36-1.8l2.27-2.27L25.5 16l-2.27 2.27zM18.3 16L16 13.7 14.3 15.4l-.6.6L16 18.3z"/></svg>',
      polygon: '<svg width="34" height="34" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#8247E5"/><path fill="#fff" d="M21 13.4c-.36-.2-.82-.2-1.2 0l-2.66 1.56-1.8 1.02-2.64 1.56c-.36.2-.82.2-1.2 0l-2.08-1.24a1.2 1.2 0 0 1-.6-1.04v-2.4c0-.42.22-.82.6-1.04l2.06-1.2c.36-.2.82-.2 1.2 0l2.06 1.2c.36.22.6.62.6 1.04v1.56l1.8-1.06v-1.57c0-.42-.22-.82-.6-1.04l-3.84-2.26c-.36-.2-.82-.2-1.2 0l-3.92 2.26c-.38.22-.6.62-.6 1.04v4.55c0 .42.22.82.6 1.04l3.9 2.26c.37.2.83.2 1.2 0l2.64-1.53 1.8-1.06 2.64-1.53c.36-.2.82-.2 1.2 0l2.06 1.2c.36.22.6.62.6 1.04v2.32c0 .42-.22.82-.6 1.04l-2.05 1.2c-.36.2-.82.2-1.2 0l-2.06-1.2a1.2 1.2 0 0 1-.6-1.04v-1.55l-1.8 1.06v1.56c0 .42.22.82.6 1.04l3.9 2.26c.37.2.83.2 1.2 0l3.9-2.26c.38-.22.6-.62.6-1.04v-4.55c0-.42-.22-.82-.6-1.04z"/></svg>',
      solana: '<svg width="34" height="34" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#111"/><defs><linearGradient id="solg" x1="6" y1="22" x2="26" y2="10" gradientUnits="userSpaceOnUse"><stop stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><g fill="url(#solg)"><path d="M10 20.3c.13-.13.3-.2.48-.2h13.1c.3 0 .46.37.24.6l-2.6 2.5c-.13.12-.3.2-.48.2H7.64c-.3 0-.46-.37-.24-.6z"/><path d="M10 8.6c.14-.13.3-.2.48-.2h13.1c.3 0 .46.37.24.6l-2.6 2.5c-.13.13-.3.2-.48.2H7.64c-.3 0-.46-.37-.24-.6z"/><path d="M21.32 14.4a.7.7 0 0 0-.48-.2H7.74c-.3 0-.46.38-.24.6l2.6 2.5c.13.13.3.2.48.2h13.1c.3 0 .46-.37.24-.6z"/></g></svg>',
    };
    function coinPair(id) {
      return '<span style="position:relative;display:inline-block;width:34px;height:34px;flex:none">' +
        (NET_SVG[id] || '<span style="font-size:26px">&#8383;</span>') +
        '<span style="position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;border-radius:50%;background:var(--card);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px var(--line)">' + USDT_SVG + '</span>' +
        '</span>';
    }

    // PayPal Website-Payments-Standard link carrying the logged-in user + tier in
    // `custom`, which the IPN webhook reads to auto-grant the tier on payment.
    function paypalUrl(t, plan) {
      const p = new URLSearchParams({
        cmd: '_xclick',
        business: links.paypalEmail || '',
        currency_code: 'USD',
        amount: String(plan.usd),
        item_name: 'OpenBook ' + t.name + ' (' + (plan.label || '') + ')',
        custom: 'ob:' + (ME && ME.id) + ':' + t.tier + ':' + (plan.cycle || ''),
        notify_url: origin + '/api/webhooks/paypal',
        'return': origin + '/app#support',
        cancel_return: origin + '/app#support',
      });
      return 'https://www.paypal.com/cgi-bin/webscr?' + p.toString();
    }

    // A one-off TIP via the same PayPal account. custom = ob:tip:<userId> so the
    // IPN records it as a tip (no tier, no badge), counted on its own.
    function tipPaypalUrl(amount) {
      const p = new URLSearchParams({
        cmd: '_xclick',
        business: links.paypalEmail || '',
        currency_code: 'USD',
        amount: String(amount),
        item_name: 'OpenBook tip (thank you!)',
        custom: 'ob:tip:' + (ME && ME.id ? ME.id : ''),
        notify_url: origin + '/api/webhooks/paypal',
        'return': origin + '/app#support',
        cancel_return: origin + '/app#support',
      });
      return 'https://www.paypal.com/cgi-bin/webscr?' + p.toString();
    }

    function tierCard(t) {
      const isCur = t.tier === curTier;
      const plan = plans[t.tier] || planDefault[t.tier] || { usd: t.price, label: '' };
      const chargeLine = '<div class="shint" style="font-size:11px;margin-top:-2px;margin-bottom:6px">$' + t.price + '/mo &middot; billed ' + esc(plan.label || '') + ' up front ($' + plan.usd + ')</div>';
      let action;
      if (isCur) action = '<span class="pill pill-ok">Your plan</span>';
      else if (links.paypalEmail) action = '<a class="btn btn-primary btn-sm" href="' + esc(paypalUrl(t, plan)) + '" target="_blank" rel="noopener">Pay with PayPal</a>';
      else action = '<button class="btn btn-primary btn-sm" disabled title="PayPal is being set up">Choose ' + esc(t.name) + '</button>';
      return '<div class="tier-card' + (isCur ? ' tier-current' : '') + '">' +
        '<div class="tier-head"><span class="badge-chip badge-' + esc(t.badge) + '">' + esc(t.name) + '</span>' +
        '<span class="tier-price">$' + Number(t.price) + '<span>/mo</span></span></div>' +
        chargeLine +
        '<ul class="tier-perks">' + (t.perks || []).map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' +
        action + '</div>';
    }

    function linkCard(icon, title, desc, url, cta) {
      const has = !!url;
      return '<div class="card"><div style="display:flex;gap:12px;align-items:flex-start">' +
        '<div style="font-size:26px">' + icon + '</div><div style="flex:1">' +
        '<div style="font-weight:700">' + esc(title) + '</div>' +
        '<div class="shint" style="font-size:13px;margin:2px 0 8px">' + esc(desc) + '</div>' +
        (has
          ? '<a class="btn btn-primary btn-sm" href="' + esc(safeHref(url)) + '" target="_blank" rel="noopener">' + esc(cta) + '</a>'
          : '<span class="pill">Coming soon</span>') +
        '</div></div></div>';
    }

    // Explanation of fees, written under the payment section (user requested).
    const feeNote = '<div class="card"><div class="shint" style="font-size:12.5px;line-height:1.65">' +
      '<strong>About payment fees.</strong> Card processors like PayPal take a fixed fee of about $0.30 plus roughly 4.4% on <em>every</em> payment, so small or frequent charges lose a big share to fees. That is why we bill in advance, Supporter for a year, Plus for six months, Premium for three months, so that fee is paid as rarely as possible. ' +
      '<strong>USDT (crypto) is the cheapest way to support us.</strong> It has no percentage cut and only a tiny network fee paid by the sender, so almost the whole amount reaches OpenBook. If you can, paying with USDT below is the best option.' +
      '</div></div>';

    function netRow(n) {
      return '<div style="display:flex;align-items:center;gap:11px;padding:11px 0;border-top:1px solid var(--line)">' +
        coinPair(n.id) +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:13px">USDT &middot; ' + esc(n.name) + '</div>' +
          '<code style="word-break:break-all;font-size:12px;color:var(--text-soft)">' + esc(n.address) + '</code>' +
        '</div>' +
        '<button class="btn btn-sm" data-copy="' + esc(n.address) + '">Copy</button>' +
        '</div>';
    }

    const cryptoBlock = networks.length
      ? ('<div class="card">' +
          '<div style="font-weight:700;display:flex;align-items:center;gap:8px"><span style="font-size:20px">&#8383;</span> Pay with USDT (lowest fees)</div>' +
          '<div class="shint" style="font-size:13px;line-height:1.55;margin:4px 0 6px">Send USDT on whichever network you prefer to the matching address, then paste your transaction hash below and your tier is applied automatically. Almost the entire amount reaches the project.</div>' +
          networks.map(netRow).join('') +
          '<div style="border-top:1px solid var(--line);margin-top:6px;padding-top:12px">' +
            '<div class="shint" style="font-size:12px;margin-bottom:6px">Already sent USDT? Apply your tier:</div>' +
            '<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
              '<select class="input" id="cryptoNet" style="max-width:170px">' + networks.map((n) => '<option value="' + esc(n.id) + '">' + esc(n.name) + '</option>').join('') + '</select>' +
              '<select class="input" id="cryptoTier" style="max-width:210px">' +
                '<option value="1">Supporter (' + (plans[1] ? plans[1].usd : 12) + ' USDT, 1 year)</option>' +
                '<option value="2">Plus (' + (plans[2] ? plans[2].usd : 18) + ' USDT, 6 months)</option>' +
                '<option value="3" selected>Premium (' + (plans[3] ? plans[3].usd : 30) + ' USDT, 3 months)</option>' +
              '</select>' +
              '<input class="input" id="cryptoTx" placeholder="Paste transaction hash" style="flex:1;min-width:180px">' +
              '<button type="button" class="btn btn-sm" id="cryptoHelp" title="How to find your transaction hash" aria-label="How to find your transaction hash" style="flex:none;font-weight:800">How</button>' +
              '<button class="btn btn-primary" id="cryptoClaim">Apply my tier</button>' +
            '</div>' +
            '<div id="cryptoMsg" class="shint" style="font-size:12px;margin-top:6px"></div>' +
          '</div>' +
        '</div>')
      : '<div class="card"><div style="font-weight:700">Pay with USDT</div><div class="shint" style="font-size:13px;margin-top:4px">Crypto addresses are being set up. Check back soon.</div></div>';

    // --- Tip card: one-off donation, no perks, with its own running total. Crypto
    // first (lowest fees); PayPal tips go through a fee-nudge popup. ---
    const TIP_PRESETS = [3, 5, 7, 10];
    const tipTotalStr = '$' + (((board.tips && board.tips.total) || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const tipCount = (board.tips && board.tips.count) || 0;
    const hasNets = networks.length > 0;
    const tipCard = '<div class="card" id="tipCard">' +
      '<div style="font-weight:700;display:flex;align-items:center;gap:8px"><span style="font-size:20px">&#9749;</span> Tip the project</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.55;margin:4px 0 10px">Just want to help us keep going, with no perks or badge attached? Leave a one-off tip of any size. ' +
        (hasNets ? 'Tipping with <strong>USDT (crypto)</strong> is best: almost the whole amount reaches us, while PayPal takes a fee on every payment.' : 'Every bit goes straight to running OpenBook.') + '</div>' +
      (hasNets
        ? '<div style="margin-bottom:12px">' +
            '<div class="shint" style="font-size:12.5px;margin-bottom:6px"><strong>Tip with USDT (lowest fees).</strong> Send any amount to one of the USDT addresses above, then paste your hash:</div>' +
            '<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">' +
              '<select class="input" id="tipNet" style="max-width:170px">' + networks.map((n) => '<option value="' + esc(n.id) + '">' + esc(n.name) + '</option>').join('') + '</select>' +
              '<input class="input" id="tipTx" placeholder="Paste transaction hash" style="flex:1;min-width:160px">' +
              '<button class="btn btn-primary btn-sm" id="tipCryptoGo">Apply crypto tip</button>' +
            '</div>' +
            '<div id="tipCryptoMsg" class="shint" style="font-size:12px;margin-top:6px"></div>' +
          '</div>'
        : '') +
      (links.paypalEmail
        ? '<div style="' + (hasNets ? 'border-top:1px solid var(--line);padding-top:11px;' : '') + 'margin-bottom:10px">' +
            '<div class="shint" style="font-size:12.5px;margin-bottom:6px">Or tip with PayPal' + (hasNets ? ' (a fee applies)' : '') + ':</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
              TIP_PRESETS.map((a) => '<button class="btn btn-sm" data-tip-pp="' + a + '">$' + a + '</button>').join('') +
              '<span class="shint" style="font-size:13px">or</span>' +
              '<input class="input" id="tipAmount" type="number" min="1" step="1" placeholder="$ other" style="width:92px">' +
              '<button class="btn btn-sm" id="tipGo">PayPal tip</button>' +
            '</div>' +
          '</div>'
        : (hasNets ? '' : '<div style="margin-bottom:8px"><span class="pill">Payments are being set up</span></div>')) +
      '<div style="border-top:1px solid var(--line);padding-top:10px">' +
        '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap"><span style="font-size:22px;font-weight:800;line-height:1;color:var(--brand)" id="tipTotal">' + esc(tipTotalStr) + '</span>' +
        '<span class="shint" style="font-size:12.5px">in tips from <span id="tipCount">' + tipCount + '</span> tip' + (tipCount === 1 ? '' : 's') + ' so far. Thank you.</span></div>' +
      '</div>' +
    '</div>';

    // Your support history: the supporter's own payment receipts (GET /api/billing/me).
    function _payMethod(provider) {
      if (provider === 'paypal') return 'PayPal';
      if (String(provider).indexOf('usdt-') === 0) {
        var NETS = { tron: 'Tron', ethereum: 'Ethereum', bsc: 'BNB Chain', polygon: 'Polygon', solana: 'Solana' };
        return 'USDT (' + (NETS[provider.slice(5)] || provider.slice(5)) + ')';
      }
      return provider || '';
    }
    var _TIERN = { 1: 'Supporter', 2: 'Plus', 3: 'Premium' };
    function _payAmt(p) {
      var n = Number(p.amount), a = isFinite(n) ? (Math.round(n * 100) / 100) : p.amount;
      return String(p.currency || '').toUpperCase() === 'USD' ? ('$' + a) : (a + ' ' + (p.currency || ''));
    }
    function _payDate(ts) { try { return new Date(String(ts).replace(' ', 'T') + 'Z').toLocaleDateString(); } catch (e) { return String(ts || ''); } }
    const historyCard = payments.length
      ? ('<div class="card"><div class="section-title">Your support history</div>' +
          '<div class="shint" style="font-size:12px;margin:-4px 0 8px">A record of your support. You also get an email receipt for each one.</div>' +
          payments.map(function (p) {
            return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)">' +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:600;font-size:13px">' + esc(_TIERN[p.tier] || ('Tier ' + p.tier)) + ' &middot; ' + esc(_payMethod(p.provider)) + '</div>' +
                '<div class="shint" style="font-size:12px">' + esc(_payDate(p.created_at)) + '</div>' +
              '</div>' +
              '<div style="font-weight:700;font-size:13px;white-space:nowrap">' + esc(_payAmt(p)) + '</div>' +
            '</div>';
          }).join('') +
          '<label style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;cursor:pointer">' +
            '<input type="checkbox" id="supShowToggle"' + (myHidden ? '' : ' checked') + '> Show me on the public supporters wall (your support still counts in the total either way)</label>' +
        '</div>')
      : '';

    // --- The public supporters wall (newest first, never ranked by amount) ---
    function badgeChipSm(badge, label) {
      return '<span class="badge-chip badge-' + esc(badge || 'bronze') + '" style="font-size:11px;padding:2px 9px;flex:none">' + esc(label) + '</span>';
    }
    function supDate(ts) { try { return new Date(String(ts).replace(' ', 'T') + 'Z').toLocaleDateString(); } catch (e) { return String(ts || ''); } }
    function supporterRow(s) {
      const handle = s.username ? '@' + s.username : '';
      return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)">' +
        avatar({ avatar: s.avatar, name: s.name }, 34) +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + esc(s.name) +
            (handle ? '<span class="shint" style="font-size:12px;font-weight:500">' + esc(handle) + '</span>' : '') + '</div>' +
          '<div class="shint" style="font-size:12px">' + esc(supDate(s.date)) + '</div>' +
        '</div>' +
        badgeChipSm(s.badge, s.tierName) +
      '</div>';
    }
    function wallTotalStr(b) { return '$' + (Number(b.total) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
    const wallRowsHtml = board.supporters.length
      ? board.supporters.map(supporterRow).join('')
      : '<div class="shint" style="font-size:13px;padding:12px 0">No supporters yet. Be the first to help OpenBook grow.</div>';
    const wallCard = '<div class="card" id="supWall">' +
      '<div class="section-title" style="margin-top:0">&#129351; Our supporters</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.55;margin:-4px 0 8px">Everyone who chips in to keep OpenBook running, newest first. This is a thank-you wall, not a ranking: it is ordered by date, never by amount, because money never buys status here. We show the last 100.</div>' +
      '<div id="supWallList">' + wallRowsHtml + '</div>' +
      '<div style="border-top:2px solid var(--line);margin-top:8px;padding-top:12px">' +
        '<div style="font-size:28px;font-weight:800;line-height:1;color:var(--brand)" id="supTotal">' + esc(wallTotalStr(board)) + '</div>' +
        '<div class="shint" style="font-size:12.5px;margin-top:2px">raised by <span id="supCount">' + (board.supporterCount || 0) + '</span> supporter' + (board.supporterCount === 1 ? '' : 's') + ' so far. Thank you.</div>' +
      '</div>' +
    '</div>';

    view.innerHTML =
      '<div class="card"><div class="pname">&#10084;&#65039; Support OpenBook</div>' +
      '<div class="shint" style="font-size:14px;line-height:1.6;margin-top:6px">' +
      'OpenBook is free and open source, and it will stay that way. There is no paywall and we never sell your data. ' +
      'Supporter perks are cosmetic and convenience only: supporting us can never buy a place in the feed or extra weight in a vote. That stays equal for everyone.' +
      expiresNote + '</div></div>' +
      historyCard +
      growthCard +
      wallCard +
      '<div class="section-title">Supporter tiers</div>' +
      '<div class="tier-grid">' + tiers.map(tierCard).join('') + '</div>' +
      feeNote +
      cryptoBlock +
      tipCard +
      linkCard('&#128081;', 'Sponsor on GitHub', 'Back the project directly through GitHub Sponsors.', links.github, 'Sponsor on GitHub') +
      linkCard('&#129309;', 'Open Collective', 'Transparent, community funding where every expense is public.', links.opencollective, 'Give on Open Collective') +
      '<div class="card"><div class="shint" style="font-size:12px">Why not ads? OpenBook is built on the promise that your data is yours. Surveillance ads would break that promise, so we will not run them.</div></div>';

    view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => {
      try { navigator.clipboard.writeText(b.getAttribute('data-copy')); toast('Address copied'); } catch (e) { toast('Could not copy'); }
    }));
    const claimBtn = document.getElementById('cryptoClaim');
    if (claimBtn) claimBtn.onclick = async () => {
      const network = document.getElementById('cryptoNet').value;
      const tier = Number(document.getElementById('cryptoTier').value);
      const tx = document.getElementById('cryptoTx').value.trim();
      const msg = document.getElementById('cryptoMsg');
      if (!tx) { msg.textContent = 'Paste your transaction hash first.'; return; }
      claimBtn.disabled = true; msg.textContent = 'Verifying your transaction on-chain...';
      try {
        await API.claimCrypto(network, tier, tx);
        toast('Thank you! Your tier is now active.');
        renderSupport();
      } catch (e) { msg.textContent = e.message; claimBtn.disabled = false; }
    };
    const helpBtn = document.getElementById('cryptoHelp');
    if (helpBtn) helpBtn.onclick = () => {
      const m = modal(
        '<div class="mh"><h3>How to find your transaction hash</h3></div>' +
        '<div class="mc">' +
        '<p style="margin-top:0">When you send USDT, your wallet or exchange gives the payment a unique <strong>transaction hash</strong> (also shown as <strong>TxID</strong> or <strong>Transaction ID</strong>). That is what we use to confirm your payment on the blockchain. Here is how to copy it:</p>' +
        '<ol style="padding-left:20px;line-height:1.7;font-size:14px;margin:0 0 4px">' +
          '<li>Open the wallet or exchange you sent the USDT from (Binance, Trust Wallet, MetaMask, OKX, and so on).</li>' +
          '<li>Open your <strong>transaction history</strong> (it may be called History, Activity, or Transactions).</li>' +
          '<li>Tap the USDT payment you just sent.</li>' +
          '<li>Find the line labelled <strong>Transaction hash</strong>, <strong>TxID</strong>, <strong>Transaction ID</strong>, or <strong>Hash</strong>. It is a long string of letters and numbers (on Ethereum, BNB Chain, or Polygon it starts with &ldquo;0x&rdquo;).</li>' +
          '<li>Tap the copy icon next to it, or open &ldquo;View on explorer&rdquo; and copy it from there.</li>' +
          '<li>Come back here, paste it in the box, pick the <strong>same network</strong> you sent on and your tier, then press <strong>Apply my tier</strong>.</li>' +
        '</ol>' +
        '<p class="shint" style="font-size:12.5px;line-height:1.55">Tip: make sure you pick the same network you actually sent on (Tron, Ethereum, BNB Chain, Polygon, or Solana). Your tier is applied automatically once we confirm the payment on-chain, usually within a minute or two.</p>' +
        '<button class="btn btn-primary btn-block" id="cryptoHelpOk">Got it</button>' +
        '</div>'
      );
      const ok = m.q('#cryptoHelpOk');
      if (ok) ok.onclick = () => m.close();
    };

    // Opt in / out of being named on the public supporters wall (checked = shown).
    const showToggle = document.getElementById('supShowToggle');
    if (showToggle) showToggle.onchange = async () => {
      const hidden = !showToggle.checked;
      showToggle.disabled = true;
      try {
        await API.setSupporterVisibility(hidden);
        toast(hidden ? 'You are now hidden from the supporters wall' : 'You are now shown on the supporters wall');
        const b2 = await API.supporterLeaderboard().catch(() => null);
        const list = document.getElementById('supWallList');
        if (b2 && list) list.innerHTML = b2.supporters.length ? b2.supporters.map(supporterRow).join('') : '<div class="shint" style="font-size:13px;padding:12px 0">No supporters yet.</div>';
        const cc = document.getElementById('supCount'); if (b2 && cc) cc.textContent = b2.supporterCount || 0;
      } catch (e) { toast(e.message); showToggle.checked = !showToggle.checked; }
      showToggle.disabled = false;
    };

    // PayPal tips go through a fee-nudge popup that points to crypto first; the
    // crypto tip form verifies the hash on-chain and records the tip.
    function confirmPaypalTip(amount) {
      amount = Math.floor(Number(amount));
      if (!(amount >= 1)) { toast('Enter a tip amount of $1 or more'); return; }
      const m = modal(
        '<div class="mh"><h3>&#9888;&#65039; A note on PayPal fees</h3></div>' +
        '<div class="mc">' +
        '<p style="margin-top:0">PayPal takes a fee on every payment, about <strong>$0.30 plus roughly 4.4%</strong>. On a $' + amount + ' tip that is a real slice lost for both of us. ' +
        (networks.length ? 'Tipping with <strong>USDT (crypto)</strong> has almost no fee, so far more of it actually reaches OpenBook.' : '') + '</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
        (networks.length ? '<button class="btn btn-primary" id="tipUseCrypto">Use crypto instead</button>' : '') +
        '<a class="btn" id="tipPpGo" href="' + esc(tipPaypalUrl(amount)) + '" target="_blank" rel="noopener">Continue with PayPal</a>' +
        '</div></div>'
      );
      const cr = m.q('#tipUseCrypto');
      if (cr) cr.onclick = () => { m.close(); const tx = document.getElementById('tipTx'); if (tx) { tx.scrollIntoView({ behavior: 'smooth', block: 'center' }); tx.focus(); } };
      const go = m.q('#tipPpGo'); if (go) go.onclick = () => m.close();
    }
    view.querySelectorAll('[data-tip-pp]').forEach((b) => (b.onclick = () => confirmPaypalTip(b.getAttribute('data-tip-pp'))));
    const tipGo = document.getElementById('tipGo');
    if (tipGo) tipGo.onclick = () => confirmPaypalTip((document.getElementById('tipAmount') || {}).value);
    const tipCryptoGo = document.getElementById('tipCryptoGo');
    if (tipCryptoGo) tipCryptoGo.onclick = async () => {
      const network = (document.getElementById('tipNet') || {}).value;
      const tx = (((document.getElementById('tipTx') || {}).value) || '').trim();
      const msg = document.getElementById('tipCryptoMsg');
      if (!tx) { if (msg) msg.textContent = 'Paste your transaction hash first.'; return; }
      tipCryptoGo.disabled = true; if (msg) msg.textContent = 'Verifying your transaction on-chain...';
      try { await API.cryptoTip(network, tx); toast('Thank you for the tip!'); renderSupport(); }
      catch (e) { if (msg) msg.textContent = e.message; tipCryptoGo.disabled = false; }
    };

    // Live-ish refresh: re-pull the wall + member count every ~45s while the page
    // is open. Self-clears once the user navigates away (the #supWall node is gone),
    // and is reset on each render so it never stacks.
    if (window._obSupPoll) { clearInterval(window._obSupPoll); window._obSupPoll = null; }
    window._obSupPoll = setInterval(async () => {
      if (!document.getElementById('supWall')) { clearInterval(window._obSupPoll); window._obSupPoll = null; return; }
      try {
        const [b2, c2] = await Promise.all([
          API.supporterLeaderboard().catch(() => null),
          API.communityStats().catch(() => null),
        ]);
        if (b2) {
          const list = document.getElementById('supWallList');
          if (list) list.innerHTML = b2.supporters.length ? b2.supporters.map(supporterRow).join('') : '<div class="shint" style="font-size:13px;padding:12px 0">No supporters yet.</div>';
          const t = document.getElementById('supTotal'); if (t) t.textContent = wallTotalStr(b2);
          const cc = document.getElementById('supCount'); if (cc) cc.textContent = b2.supporterCount || 0;
          const tt = document.getElementById('tipTotal'); if (tt && b2.tips) tt.textContent = '$' + (b2.tips.total || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
          const tc = document.getElementById('tipCount'); if (tc && b2.tips) tc.textContent = b2.tips.count || 0;
        }
        if (c2) { const mc = document.getElementById('supMembers'); if (mc) mc.textContent = (c2.users || 0).toLocaleString(); }
      } catch (e) { /* transient */ }
    }, 45000);

    renderRightRail();
  }

  async function renderInvite() {
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading...</div></div>';
    let me, lb = [];
    try { [me, lb] = await Promise.all([API.myReferral(), API.referralLeaderboard().then((r) => r.leaderboard).catch(() => [])]); }
    catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }

    const link = me.link || '';
    const progress = Math.min(100, Math.round(((me.rewardEvery - me.toNextReward) / me.rewardEvery) * 100));
    const badgeHtml = me.badge ? '<span class="badge-chip badge-' + esc(me.badge) + '">Inviter</span>' : '';

    const lbHtml = lb.length
      ? lb.map((u, i) => '<div class="lb-row"><span class="lb-rank">' + (i + 1) + '</span>' + avatar(u, 28) +
          '<span class="lb-name">' + esc(u.name) + verifTick(u) + '</span><span class="lb-count">' + u.qualified + '</span></div>').join('')
      : '<div class="shint" style="font-size:13px">No qualified invites yet. Be the first.</div>';

    view.innerHTML =
      '<div class="card"><div class="pname">&#127881; Invite friends &amp; family</div>' +
      '<div class="shint" style="font-size:14px;line-height:1.6;margin-top:6px">' +
      'Share OpenBook and grow it the honest way, no ads, no paid reach. For every <b>' + me.rewardEvery +
      ' people</b> you invite who stay and use OpenBook as real humans for <b>' + me.qualifyDays +
      ' days</b>, you earn <b>one free month of Premium</b> (the Gold badge, verified tick, and all premium perks). It stacks, so keep inviting.</div></div>' +

      '<div class="card"><div class="section-title">Your invite link</div>' +
      '<div class="invite-link-row">' +
      '<input class="input" id="inviteLink" readonly value="' + esc(link) + '">' +
      '<button class="btn btn-primary" id="copyInvite">Copy</button></div>' +
      '<div class="shint" style="font-size:12px;margin-top:6px">Anyone who signs up from your link is tied to you automatically.</div></div>' +

      '<div class="card"><div class="section-title">Your progress ' + badgeHtml + '</div>' +
      '<div class="dash-grid">' +
        statCard(me.qualified, 'Qualified invites', 'Friends who stayed ' + me.qualifyDays + '+ days as real, active humans.') +
        statCard(me.pending, 'Pending', 'Invited, not yet past the ' + me.qualifyDays + '-day mark.') +
        statCard(me.monthsEarned, 'Free months earned', 'Months of Premium credited to your account so far.') +
      '</div>' +
      '<div class="prog-wrap"><div class="prog-bar" style="width:' + progress + '%"></div></div>' +
      '<div class="shint" style="font-size:13px;margin-top:6px"><b>' + me.toNextReward + '</b> more qualified invite' +
      (me.toNextReward === 1 ? '' : 's') + ' until your next free month.</div></div>' +

      '<div class="card"><div class="section-title">Top inviters</div>' + lbHtml + '</div>' +

      '<div class="card"><div class="shint" style="font-size:12px">Why "qualified"? It keeps the rewards fair and bot-proof. A friend counts only after they stick around and genuinely use OpenBook, not the moment they sign up. Rewards are perks only and never affect anyone\'s feed ranking or votes.</div></div>';

    const copyBtn = view.querySelector('#copyInvite');
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(link); copyBtn.textContent = 'Copied!'; setTimeout(() => (copyBtn.textContent = 'Copy'), 1500); }
      catch (e) { const inp = view.querySelector('#inviteLink'); inp.select(); document.execCommand('copy'); copyBtn.textContent = 'Copied!'; setTimeout(() => (copyBtn.textContent = 'Copy'), 1500); }
    };
    renderRightRail();
  }

  async function renderAdmin() {
    if (!ME || !ME.isAdmin) { view.innerHTML = '<div class="card"><div class="empty">Admins only.</div></div>'; return; }
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading analytics...</div></div>';
    let d;
    try { d = await API.adminAnalytics(); }
    catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const t = d.totals;
    function fmtDur(sec) { if (!sec) return '0s'; const m = Math.floor(sec / 60), s = sec % 60; return m ? (m + 'm ' + s + 's') : (s + 's'); }
    function barList(rows) {
      if (!rows || !rows.length) return '<div class="shint" style="font-size:13px">No data yet.</div>';
      const max = Math.max.apply(null, rows.map((r) => r.c)) || 1;
      return rows.map((r) => '<div class="bar-row"><span class="bar-label">' + esc(r.label) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + Math.round((r.c / max) * 100) + '%"></span></span>' +
        '<span class="bar-val">' + r.c + '</span></div>').join('');
    }
    const signups = (d.signupsByDay || []).slice().reverse().map((r) => ({ label: r.d, c: r.c }));
    view.innerHTML =
      '<div class="card"><div class="pname">&#128202; Owner analytics</div>' +
      '<div class="shint" style="font-size:13px">Private to platform admins. Aggregate usage only, no personal data.</div></div>' +
      '<div class="section-title">Users</div><div class="dash-grid">' +
        statCard(t.totalUsers, 'Total users', 'All registered accounts.') +
        statCard(t.newUsers24h, 'New (24h)', '') +
        statCard(t.newUsers7d, 'New (7 days)', '') +
        statCard(t.activeUsers7d, 'Active (7 days)', 'Distinct users with any activity.') +
        statCard(t.supporters, 'Supporters', 'Tiers active right now.') +
        statCard(t.qualifiedReferrals, 'Qualified referrals', '') +
      '</div>' +
      '<div class="section-title">Engagement</div><div class="dash-grid">' +
        statCard(fmtDur(t.avgSessionSec), 'Avg time / session', 'Estimated from active heartbeats.') +
        statCard(t.totalSessions, 'Sessions', '') +
        statCard(t.totalPageviews, 'Page views', '') +
        statCard(t.totalClicks, 'Button clicks', '') +
      '</div>' +
      '<div class="card"><div class="section-title">Signups (last 14 days)</div>' + barList(signups) + '</div>' +
      '<div class="card"><div class="section-title">Top entry pages</div>' + barList(d.entryPages) + '</div>' +
      '<div class="card"><div class="section-title">Most viewed pages</div>' + barList(d.topPages) + '</div>' +
      '<div class="card"><div class="section-title">Most clicked buttons</div>' + barList(d.topButtons) + '</div>';
    renderRightRail();
  }

  /* ============================ moderation ============================ */

  const REPORT_REASONS = [
    { v: 'spam', l: 'Spam' }, { v: 'harassment', l: 'Harassment' }, { v: 'hate', l: 'Hate speech' },
    { v: 'violence', l: 'Violence or threats' }, { v: 'sexual', l: 'Sexual content' },
    { v: 'illegal', l: 'Illegal content' }, { v: 'misinfo', l: 'Misinformation' }, { v: 'other', l: 'Other' },
  ];

  function reportModal(targetType, targetId) {
    const opts = REPORT_REASONS.map((r) => '<option value="' + r.v + '">' + r.l + '</option>').join('');
    const m = modal('<div class="mh"><h3>Report ' + esc(targetType) + '</h3></div><div class="mc">' +
      '<div class="field"><label>Reason</label><select class="input" id="repReason">' + opts + '</select></div>' +
      '<div class="field"><label>Details (optional)</label><textarea class="input" id="repDetail" rows="3" placeholder="Anything the moderators should know"></textarea></div>' +
      '<button class="btn btn-primary btn-block" id="repSend">Submit report</button></div>');
    m.q('#repSend').onclick = async () => {
      const btn = m.q('#repSend'); btn.disabled = true;
      try { await API.report(targetType, targetId, m.q('#repReason').value, m.q('#repDetail').value.trim()); m.close(); toast('Report submitted. Thank you.'); }
      catch (e) { toast(e.message); btn.disabled = false; }
    };
  }

  function appealModal(targetType, targetId) {
    const m = modal('<div class="mh"><h3>Appeal a moderation action</h3></div><div class="mc">' +
      '<div class="field"><label>Why should this be reversed?</label><textarea class="input" id="apMsg" rows="4" placeholder="Explain your appeal"></textarea></div>' +
      '<button class="btn btn-primary btn-block" id="apSend">Submit appeal</button></div>');
    m.q('#apSend').onclick = async () => {
      const msg = m.q('#apMsg').value.trim(); if (!msg) { toast('Add a message'); return; }
      const btn = m.q('#apSend'); btn.disabled = true;
      try { await API.fileAppeal(msg, targetType || null, targetId || null); m.close(); toast('Appeal submitted. A moderator will review it.'); }
      catch (e) { toast(e.message); btn.disabled = false; }
    };
  }

  function modActionLabel(a) {
    const map = {
      remove_post: 'Removed a post', remove_comment: 'Removed a comment',
      restore_post: 'Restored a post', restore_comment: 'Restored a comment',
      ban: 'Banned a user', unban: 'Unbanned a user',
      lock: 'Locked a thread', unlock: 'Unlocked a thread', pin: 'Pinned a post', unpin: 'Unpinned a post',
      announce: 'Pinned a site announcement', unannounce: 'Removed a site announcement',
    };
    return map[a] || a;
  }

  function openModLog(communityId) {
    const m = modal('<div class="mh"><h3>Moderation log</h3></div><div class="mc" id="mlogList"><div class="empty">Loading...</div></div>');
    API.communityModLog(communityId).then((r) => {
      const list = m.q('#mlogList');
      if (!r.log.length) { list.innerHTML = '<div class="empty" style="padding:8px">No public moderation actions yet. That is the point: when there are, they show here.</div>'; return; }
      list.innerHTML = r.log.map((e) =>
        '<div class="contact" style="align-items:flex-start"><div style="flex:1"><b>' + esc(modActionLabel(e.action)) + '</b>' +
        (e.reason ? ' &#183; ' + esc(e.reason) : '') +
        '<div class="ctime">by ' + esc(e.actor ? e.actor.name : 'a moderator') + ' &#183; ' + timeAgo(e.created_at) + '</div></div></div>'
      ).join('');
    }).catch((e) => { m.q('#mlogList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function openReportsQueue() {
    const m = modal('<div class="mh"><h3>Reports queue</h3></div><div class="mc" id="rqList"><div class="empty">Loading...</div></div>');
    function load() {
      API.modReports().then((r) => {
        const list = m.q('#rqList');
        if (!r.reports.length) { list.innerHTML = '<div class="empty" style="padding:8px">No open reports. All clear.</div>'; return; }
        list.innerHTML = '';
        r.reports.forEach((rep) => {
          const isIllegal = rep.reasonCode === 'illegal';
          const badge = (rep.priority === 'urgent' || isIllegal)
            ? '<span class="pill" style="background:#b3261e;color:#fff;font-weight:700">URGENT</span> ' : '';
          // Illegal content is a platform-admin / legal matter: confirming it
          // removes the content everywhere AND blocklists the media so it cannot
          // be re-uploaded. "Not illegal" restores it. Other reports keep the
          // normal remove / dismiss.
          const actions = isIllegal
            ? '<button class="btn btn-danger btn-sm" data-confirm-illegal>Confirm illegal (remove + block)</button>' +
              '<button class="btn btn-sm" data-not-illegal>Not illegal</button>'
            : (rep.removed ? '<span class="pill">already removed</span>' : '<button class="btn btn-danger btn-sm" data-rm>Remove</button>') +
              '<button class="btn btn-sm" data-dismiss>Dismiss</button>';
          const row = el('<div class="card" style="margin:0 0 8px"><div style="font-size:13px">' + badge + '<b>' + esc(rep.reasonCode) + '</b> &#183; ' + esc(rep.targetType) + ' by ' + esc(rep.author ? rep.author.name : '?') + '</div>' +
            '<div class="shint" style="font-size:13px;margin:4px 0">' + esc((rep.preview || '').slice(0, 140)) + '</div>' +
            (rep.detail ? '<div class="ctime">reporter: ' + esc(rep.detail) + '</div>' : '') +
            '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + actions +
            (rep.targetType === 'post' ? '<button class="btn btn-sm" data-open>Open post</button>' : '') + '</div></div>');
          const rm = row.querySelector('[data-rm]');
          if (rm) rm.onclick = async () => { try { await API.modRemove(rep.targetType, rep.targetId, 'report: ' + rep.reasonCode); toast('Removed'); load(); } catch (e) { toast(e.message); } };
          const dm = row.querySelector('[data-dismiss]');
          if (dm) dm.onclick = async () => { try { await API.dismissReport(rep.id); toast('Dismissed'); load(); } catch (e) { toast(e.message); } };
          const ci = row.querySelector('[data-confirm-illegal]');
          if (ci) ci.onclick = async () => {
            if (!window.confirm('Confirm this content as ILLEGAL?\n\nIt will be removed everywhere and its media blocked from being re-uploaded. This is for genuinely illegal content only (e.g. CSAM, credible threats).')) return;
            try { const r2 = await API.confirmIllegal(rep.targetType, rep.targetId); toast(r2.blocked ? 'Removed and media blocked' : 'Removed'); load(); } catch (e) { toast(e.message); }
          };
          const ni = row.querySelector('[data-not-illegal]');
          if (ni) ni.onclick = async () => { try { await API.dismissIllegal(rep.targetType, rep.targetId); toast('Dismissed, content restored'); load(); } catch (e) { toast(e.message); } };
          const op = row.querySelector('[data-open]');
          if (op) op.onclick = () => { m.close(); go('post', rep.targetId); };
          list.appendChild(row);
        });
      }).catch((e) => { m.q('#rqList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
    }
    load();
  }

  /* ============================ dashboard ============================ */

  function statCard(value, label, hint) {
    return (
      '<div class="stat"><div class="sval">' + esc(String(value)) + '</div>' +
      '<div class="slabel">' + esc(label) + '</div>' +
      (hint ? '<div class="shint">' + esc(hint) + '</div>' : '') + '</div>'
    );
  }

  function analyticsTable(title, rows, kind) {
    if (!rows.length) return '';
    let html = '<div class="card"><div class="section-title">' + esc(title) + '</div>' +
      '<table class="analytics-table"><thead><tr><th>' + (kind === 'reel' ? 'Reel' : 'Post') +
      '</th><th>Views</th><th>Likes</th><th>Comments</th></tr></thead><tbody>';
    rows.forEach((r) => {
      html += '<tr' + (kind === 'post' ? ' class="link" data-postrow="' + r.id + '"' : '') + '>' +
        '<td>' + esc(r.label || '(untitled)') + (r.community ? ' <span class="pill">community</span>' : '') + '</td>' +
        '<td>' + r.views + '</td><td>' + r.likes + '</td><td>' + r.comments + '</td></tr>';
    });
    html += '</tbody></table></div>';
    return html;
  }

  async function renderDashboard() {
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading your dashboard...</div></div>';
    let d, a;
    try { [d, a] = await Promise.all([API.myStats(), API.myAnalytics()]); }
    catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const t = d.trust;
    const s = d.stats;
    const tlNames = ['New', 'Member', 'Regular', 'Trusted', 'Veteran'];
    const tl = Math.max(0, Math.min(4, t.trustLevel || 0));

    view.innerHTML =
      '<div class="card"><div class="pname">Professional dashboard</div>' +
      '<div class="shint" style="font-size:13px">Your reputation, activity, and content analytics on OpenBook, fully in the open.</div></div>' +
      '<div class="section-title">Content analytics</div>' +
      '<div class="dash-grid">' +
        statCard(a.totals.views, 'Views / reach', 'Times your posts and reels were opened by others.') +
        statCard(a.totals.likesReceived, 'Likes & reactions', 'Across your posts, comments and reels.') +
        statCard(a.totals.commentsReceived, 'Comments received', '') +
        statCard(a.totals.netVotes, 'Net votes', 'Upvotes minus downvotes on your community posts and comments.') +
      '</div>' +
      analyticsTable('Your recent posts', a.topPosts, 'post') +
      analyticsTable('Your reels', a.reels, 'reel') +
      '<div class="section-title">Your reputation</div>' +
      '<div class="dash-grid">' +
        statCard(t.karma, 'Karma', 'From up and down votes. Affects ranking only, never your reach.') +
        statCard(t.standing, 'Standing', 'Account safety score. This is what protects your reach. Votes never lower it.') +
        statCard('TL' + tl + ' ' + tlNames[tl], 'Trust level', 'Unlocks with account age and clean activity, never with money.') +
        statCard(timeAgo(d.created_at) + ' ago', 'Joined', '') +
        statCard((d.supporter && d.supporter.tierName) || 'Free', 'Supporter tier', 'Cosmetic and convenience perks only. Never affects your reach, karma, or votes.') +
      '</div>' +
      '<div class="section-title">Your activity</div>' +
      '<div class="dash-grid">' +
        statCard(s.posts, 'Posts', '') +
        statCard(s.comments, 'Comments', '') +
        statCard(s.communities, 'Communities', '') +
        statCard(s.friends, 'Friends', '') +
        statCard(s.reactionsReceived, 'Reactions received', '') +
      '</div>' +
      storageSection(d.storage, d.supporter) +
      '<div class="card"><div class="section-title">How OpenBook scoring works</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.6">' +
      'OpenBook keeps two separate scores on purpose. <b>Karma</b> moves with community votes and only changes where your content ranks. ' +
      'It can go negative and it never hides your posts. <b>Standing</b> is your safety score: it goes up with account age and clean activity, ' +
      'and only confirmed rule violations bring it down. Standing, not votes, is what controls your reach. So you can hold an unpopular ' +
      'opinion, collect downvotes, and still be seen, as long as your standing is healthy. The ranking and reputation rules are published ' +
      'in the open-source code.</div></div>';

    view.querySelectorAll('[data-postrow]').forEach((tr) => (tr.onclick = () => go('post', Number(tr.getAttribute('data-postrow')))));
    renderRightRail();
  }

  // Human-readable size from megabytes (used by the storage meter).
  function fmtSize(mb) {
    if (mb >= 1024) { const g = mb / 1024; return (g >= 10 ? Math.round(g) : g.toFixed(1)) + ' GB'; }
    return (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
  }

  // The dashboard storage meter: how much of their tier's space the user's media
  // takes on our servers, with a colored bar that warns as it fills.
  function storageSection(storage, supporter) {
    const st = storage || { usedBytes: 0, capBytes: 0 };
    const usedMB = (st.usedBytes || 0) / (1024 * 1024);
    const capMB = (st.capBytes || 0) / (1024 * 1024);
    const pct = capMB > 0 ? Math.min(100, Math.round((usedMB / capMB) * 100)) : 0;
    const barColor = pct >= 90 ? '#e5484d' : (pct >= 70 ? '#f5a623' : 'var(--accent, #4f8cff)');
    const atMax = supporter && supporter.tier >= 3;
    return (
      '<div class="section-title">Storage</div>' +
      '<div class="card">' +
        '<div class="row" style="justify-content:space-between;align-items:baseline;margin-bottom:8px">' +
          '<div><b>' + fmtSize(usedMB) + '</b> <span class="shint" style="font-size:13px">of ' + fmtSize(capMB) + ' used</span></div>' +
          '<div class="shint" style="font-size:13px">' + pct + '%</div>' +
        '</div>' +
        '<div style="height:10px;border-radius:6px;background:var(--line,#2a2a2a);overflow:hidden">' +
          '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:6px;transition:width .4s"></div>' +
        '</div>' +
        '<div class="shint" style="font-size:12px;margin-top:8px">The space your photos and videos take on OpenBook servers. Delete old posts, reels, or photos to free up room' +
          (atMax ? '.' : ', or upgrade your supporter tier for more space.') + '</div>' +
      '</div>'
    );
  }

  // Background styles for colored / "imaged" text posts (Facebook-style status).
  const BG_STYLES = ['cbg-1', 'cbg-2', 'cbg-3', 'cbg-4', 'cbg-5', 'cbg-6'];

  function composerHtml() {
    const first = esc((ME.name || '').split(' ')[0] || 'there');
    let swatches = '<button class="cbg-swatch cbg-none on" data-bg="" title="No background">Aa</button>';
    BG_STYLES.forEach((b) => { swatches += '<button class="cbg-swatch ' + b + '" data-bg="' + b + '" title="Background"></button>'; });
    return (
      '<div class="card composer" id="composer">' +
      '<div class="row">' + avatar(ME, 40) +
      '<textarea id="composerText" rows="1" placeholder="What is on your mind, ' + first + '?"></textarea>' +
      '</div>' +
      '<div class="cbg-strip hidden" id="composerBgStrip">' + swatches + '</div>' +
      '<div class="cpoll hidden" id="composerPoll"></div>' +
      '<div class="cfile-chip hidden" id="composerFileChip"></div>' +
      '<div class="preview hidden" id="composerPreview"></div>' +
      '<div class="actions">' +
      '<button class="icon-action" id="composerPhotoBtn" title="Photo">&#128247;</button>' +
      '<button class="icon-action" id="composerFileBtn" title="Attach a file">&#128206;</button>' +
      '<button class="icon-action" id="composerPollBtn" title="Create a poll">&#128202;</button>' +
      '<button class="icon-action" id="composerBgBtn" title="Background color">&#127912;</button>' +
      '<span class="spacer"></span>' +
      '<select class="composer-audience" id="composerAudience" title="Who can see this post">' +
        '<option value="public">&#127758; Public</option>' +
        '<option value="friends">&#128100; Friends only</option>' +
      '</select>' +
      '<button class="btn btn-primary btn-sm" id="composerPost">Post</button>' +
      '</div>' +
      '<input type="file" id="composerFile" accept="image/*" class="hidden">' +
      '<input type="file" id="composerDoc" class="hidden">' +
      '</div>'
    );
  }

  function wireComposer(targetId) {
    targetId = targetId || 'feedPosts';
    const fileInput = document.getElementById('composerFile');
    const docInput = document.getElementById('composerDoc');
    const preview = document.getElementById('composerPreview');
    const textArea = document.getElementById('composerText');
    const bgStrip = document.getElementById('composerBgStrip');
    const pollBox = document.getElementById('composerPoll');
    const fileChip = document.getElementById('composerFileChip');
    let selectedFile = null; // image
    let selectedDoc = null;  // generic file attachment
    let bgValue = '';
    let pollOn = false;

    function clearBg() {
      bgValue = '';
      textArea.className = '';
      bgStrip.querySelectorAll('.cbg-swatch').forEach((s) => s.classList.toggle('on', s.getAttribute('data-bg') === ''));
    }
    function clearImage() { selectedFile = null; fileInput.value = ''; preview.classList.add('hidden'); preview.innerHTML = ''; }

    // ---- photo ----
    document.getElementById('composerPhotoBtn').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      selectedFile = fileInput.files[0] || null;
      if (selectedFile) {
        clearBg(); // a photo post is not a colored-text post
        const url = URL.createObjectURL(selectedFile);
        preview.innerHTML = '<img src="' + url + '"><button class="remove" id="composerRemove">&times;</button>';
        preview.classList.remove('hidden');
        document.getElementById('composerRemove').onclick = clearImage;
      }
    };

    // ---- file attachment ----
    document.getElementById('composerFileBtn').onclick = () => docInput.click();
    docInput.onchange = () => {
      selectedDoc = docInput.files[0] || null;
      if (selectedDoc) {
        fileChip.innerHTML = '&#128206; <span>' + esc(selectedDoc.name) + '</span> <button class="remove" id="composerDocRemove">&times;</button>';
        fileChip.classList.remove('hidden');
        document.getElementById('composerDocRemove').onclick = () => { selectedDoc = null; docInput.value = ''; fileChip.classList.add('hidden'); fileChip.innerHTML = ''; };
      }
    };

    // ---- background color (text-only posts) ----
    document.getElementById('composerBgBtn').onclick = () => bgStrip.classList.toggle('hidden');
    bgStrip.querySelectorAll('.cbg-swatch').forEach((s) => {
      s.onclick = () => {
        bgValue = s.getAttribute('data-bg') || '';
        bgStrip.querySelectorAll('.cbg-swatch').forEach((x) => x.classList.toggle('on', x === s));
        textArea.className = bgValue ? ('composer-bg ' + bgValue) : '';
        if (bgValue) clearImage(); // colored-text posts are text only
      };
    });

    // ---- poll ----
    function addPollOpt() {
      const idx = pollBox.querySelectorAll('.cpoll-opt').length;
      if (idx >= 6) return;
      const row = el('<div class="cpoll-row"><input class="input cpoll-opt" type="text" maxlength="120" placeholder="Option ' + (idx + 1) + '"></div>');
      pollBox.insertBefore(row, pollBox.querySelector('.cpoll-add'));
    }
    document.getElementById('composerPollBtn').onclick = () => {
      pollOn = !pollOn;
      if (pollOn) {
        pollBox.innerHTML = '<button class="btn btn-soft btn-sm cpoll-add" id="composerAddOpt">+ Add option</button>';
        addPollOpt(); addPollOpt();
        document.getElementById('composerAddOpt').onclick = addPollOpt;
        pollBox.classList.remove('hidden');
        if (!textArea.value) textArea.placeholder = 'Ask a question...';
      } else {
        pollBox.classList.add('hidden'); pollBox.innerHTML = '';
      }
    };

    textArea.addEventListener('input', () => {
      textArea.style.height = 'auto';
      textArea.style.height = Math.min(textArea.scrollHeight, 220) + 'px';
    });

    document.getElementById('composerPost').onclick = async () => {
      const content = textArea.value.trim();
      const pollOptions = pollOn ? Array.prototype.slice.call(pollBox.querySelectorAll('.cpoll-opt')).map((i) => i.value.trim()).filter(Boolean) : [];
      const isPoll = pollOptions.length >= 2;
      if (pollOn && !isPoll) { toast('A poll needs at least 2 options'); return; }
      if (!content && !selectedFile && !selectedDoc && !isPoll) { toast('Write something, or add a photo, file, or poll'); return; }
      const btn = document.getElementById('composerPost');
      btn.disabled = true; btn.textContent = 'Posting...';
      try {
        let fileUrl = '', fileName = '';
        if (selectedDoc) { btn.textContent = 'Uploading file...'; const up = await API.uploadPostFile(selectedDoc); fileUrl = up.url; fileName = up.name; btn.textContent = 'Posting...'; }
        const audSel = document.getElementById('composerAudience');
        const audience = audSel ? audSel.value : 'public';
        const r = await API.createPost(content, selectedFile, audience, { bg: selectedFile ? '' : bgValue, fileUrl: fileUrl, fileName: fileName, pollOptions: pollOptions });
        const container = document.getElementById(targetId);
        const empty = container.querySelector('.empty');
        if (empty) container.innerHTML = '';
        const node = renderPostNode(r.post);
        container.prepend(node);
        if (window.anime) anime({ targets: node, opacity: [0, 1], translateY: [-10, 0], duration: 300, easing: 'easeOutCubic' });
        // reset the whole composer
        textArea.value = ''; textArea.style.height = 'auto'; clearBg();
        clearImage();
        selectedDoc = null; docInput.value = ''; fileChip.classList.add('hidden'); fileChip.innerHTML = '';
        pollOn = false; pollBox.classList.add('hidden'); pollBox.innerHTML = '';
        bgStrip.classList.add('hidden');
      } catch (e) {
        toast(e.message);
      }
      btn.disabled = false; btn.textContent = 'Post';
    };
  }

  /* ============================ posts ============================ */

  function renderPosts(container, posts, emptyMsg) {
    container.innerHTML = '';
    if (!posts.length) {
      container.innerHTML = '<div class="card"><div class="empty">' + esc(emptyMsg) + '</div></div>';
      return;
    }
    posts.forEach((p) => container.appendChild(renderPostNode(p)));
  }

  /* ---------- reactions (Facebook-style) ---------- */

  const REACTIONS = [
    { key: 'like', emoji: '👍', label: 'Like' },
    { key: 'love', emoji: '❤️', label: 'Love' },
    { key: 'care', emoji: '🤗', label: 'Care' },
    { key: 'haha', emoji: '😆', label: 'Haha' },
    { key: 'wow', emoji: '😮', label: 'Wow' },
    { key: 'sad', emoji: '😢', label: 'Sad' },
    { key: 'angry', emoji: '😠', label: 'Angry' },
  ];
  const REACTION_MAP = {};
  REACTIONS.forEach((r) => { REACTION_MAP[r.key] = r; });

  function reactionSummaryHtml(summary) {
    if (!summary || !summary.total) return '';
    const present = REACTIONS.filter((r) => summary.counts[r.key])
      .sort((a, b) => summary.counts[b.key] - summary.counts[a.key])
      .slice(0, 3);
    const emojis = present.map((r) => '<span class="rx-emoji">' + r.emoji + '</span>').join('');
    return '<span class="rx-sum">' + emojis + ' ' + summary.total + '</span>';
  }

  // A reaction picker button. opts.small renders a compact text link (comments).
  function reactionControl(targetType, targetId, summary, onChange, opts) {
    opts = opts || {};
    const wrap = el('<span class="rx-ctl"></span>');
    const btn = el('<button class="' + (opts.small ? 'rxbtn-sm' : 'post-action react') + '"></button>');
    wrap.appendChild(btn);
    let mine = summary ? summary.mine : null;
    let picker = null;

    function paint() {
      const r = mine ? REACTION_MAP[mine] : null;
      if (opts.small) btn.innerHTML = r ? '<span class="rx-mine">' + r.label + '</span>' : 'Like';
      else btn.innerHTML = r ? (r.emoji + ' <span class="rx-mine">' + r.label + '</span>') : '👍 Like';
      btn.classList.toggle('reacted', !!mine);
    }
    function closePicker() {
      if (picker) { picker.remove(); picker = null; document.removeEventListener('click', outside, true); }
    }
    function outside(e) { if (picker && !picker.contains(e.target) && e.target !== btn) closePicker(); }
    async function react(type) {
      try {
        const s = await API.react(targetType, targetId, type);
        mine = s.mine; paint(); closePicker();
        if (onChange) onChange(s);
      } catch (e) { toast(e.message); }
    }
    function openPicker() {
      if (picker) { closePicker(); return; }
      picker = el('<div class="rx-picker"></div>');
      REACTIONS.forEach((r) => {
        const b = el('<button class="rx-opt' + (mine === r.key ? ' on' : '') + '" title="' + r.label + '">' + r.emoji + '</button>');
        b.onclick = (e) => { e.stopPropagation(); react(r.key); };
        picker.appendChild(b);
      });
      wrap.appendChild(picker);
      setTimeout(() => document.addEventListener('click', outside, true), 0);
    }
    btn.onclick = (e) => { e.stopPropagation(); openPicker(); };
    paint();
    return wrap;
  }

  // Poll rendering: each option is a clickable bar that fills to its share once
  // the viewer has voted. Wired by wirePoll.
  function pollHtml(p) {
    const poll = p.poll;
    if (!poll) return '';
    const total = poll.totalVotes || 0;
    const voted = poll.myVote != null;
    let h = '<div class="poll">';
    poll.options.forEach((o) => {
      const pct = total ? Math.round((o.votes / total) * 100) : 0;
      h += '<button class="poll-opt' + (poll.myVote === o.id ? ' mine' : '') + '" data-opt="' + o.id + '">' +
        '<span class="poll-fill" style="width:' + (voted ? pct : 0) + '%"></span>' +
        '<span class="poll-text">' + esc(o.text) + '</span>' +
        (voted ? '<span class="poll-pct">' + pct + '%</span>' : '') +
        '</button>';
    });
    h += '<div class="poll-total">' + total + ' vote' + (total === 1 ? '' : 's') + (voted ? '' : ' &#183; tap to vote') + '</div></div>';
    return h;
  }
  function fileChipHtml(p) {
    const key = String(p.file_url).replace(/^\/uploads\//, '');
    const href = '/download/' + encodeURIComponent(key) + '?n=' + encodeURIComponent(p.file_name || 'file');
    return '<a class="file-chip" href="' + esc(href) + '" target="_blank" rel="noopener">&#128206; <span>' + esc(p.file_name || 'Download file') + '</span></a>';
  }
  function wirePoll(node, p) {
    const pollEl = node.querySelector('.poll');
    if (!pollEl || !p.poll) return;
    pollEl.querySelectorAll('.poll-opt').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await API.pollVote(p.id, Number(b.getAttribute('data-opt')));
          p.poll = r.poll;
          pollEl.outerHTML = pollHtml(p);
          wirePoll(node, p);
        } catch (e) { toast(e.message); }
      };
    });
  }

  function renderPostNode(p) {
    const node = el('<div class="card post" data-post="' + p.id + '"></div>');
    node._post = p;
    renderPostInner(node, p);
    return node;
  }

  function renderPostInner(node, p) {
    const mineP = p.author.id === ME.id;
    const editedMark = p.edited
      ? ' &#183; <span class="edited-link" data-history="' + p.id + '" title="Edited ' + timeAgo(p.edited_at) + '">edited</span>'
      : '';
    node.innerHTML =
      '<div class="post-head">' +
      avatar(p.author, 44) +
      '<div class="meta"><div class="name" data-profile="' + p.author.id + '">' + esc(p.author.name) + verifTick(p.author) + '</div>' +
      '<div class="time">' + timeAgo(p.created_at) + editedMark + '</div></div>' +
      (mineP ? '<button class="menu-btn" data-edit="' + p.id + '" title="Edit post">&#9998;</button>' +
        '<button class="menu-btn" data-del="' + p.id + '" title="Delete post">&#128465;</button>' : '') +
      '</div>' +
      (p.content ? (p.bg
        ? '<div class="post-bg ' + esc(p.bg) + '">' + esc(p.content) + '</div>'
        : '<div class="post-body">' + linkify(esc(p.content)) + '</div>') : '') +
      (p.image ? '<div class="post-image"><img src="' + esc(p.image) + '" alt=""></div>' : '') +
      (p.poll ? pollHtml(p) : '') +
      (p.file_url ? fileChipHtml(p) : '') +
      '<div class="post-stats"></div>' +
      '<div class="post-actions">' +
      '<span data-vote></span>' +
      '<span data-react></span>' +
      '<button class="post-action" data-comment="' + p.id + '">&#128172; Comment</button>' +
      '<button class="post-action" data-share-post="' + p.id + '" title="Share this post">&#128279; Share</button>' +
      (mineP ? '' : '<button class="post-action" data-report="post" data-report-id="' + p.id + '">&#9873; Report</button>') +
      '</div>' +
      '<div class="comments hidden" data-comments="' + p.id + '"></div>';
    const voteSlot = node.querySelector('[data-vote]');
    if (voteSlot) voteSlot.appendChild(voteControl('post', p.id, p.score || 0, p.myVote || 0, true));
    wirePoll(node, p);
    renderStats(node);
    wirePost(node, p);
  }

  function renderStats(node) {
    const p = node._post;
    const stats = node.querySelector('.post-stats');
    const left = reactionSummaryHtml(p.reactions);
    const right = p.commentCount ? p.commentCount + ' comment' + (p.commentCount > 1 ? 's' : '') : '';
    stats.innerHTML = left + '<span style="flex:1"></span>' + right;
  }

  function wirePost(node, p) {
    node.querySelectorAll('[data-profile]').forEach((x) =>
      (x.onclick = () => go('profile', Number(x.getAttribute('data-profile'))))
    );
    const del = node.querySelector('[data-del]');
    if (del) del.onclick = () => deletePost(p.id, node);
    const edit = node.querySelector('[data-edit]');
    if (edit) edit.onclick = () => editPostModal(p, (updated) => { node._post = updated; renderPostInner(node, updated); });
    const hist = node.querySelector('[data-history]');
    if (hist) hist.onclick = () => openEditHistory(p.id);
    const rx = node.querySelector('[data-react]');
    if (rx) rx.appendChild(reactionControl('post', p.id, p.reactions, (s) => { p.reactions = s; renderStats(node); }));
    node.querySelector('[data-comment]').onclick = () => toggleComments(p.id, node);
  }

  async function deletePost(id, node) {
    if (!window.confirm('Delete this post?')) return;
    try {
      await API.deletePost(id);
      if (window.anime) anime({ targets: node, opacity: 0, duration: 220, complete: () => node.remove() });
      else node.remove();
    } catch (e) {
      toast(e.message);
    }
  }

  function editPostModal(p, onSaved) {
    const isComm = !!p.community_id;
    const note = (p.editCount || 0) === 0
      ? 'Your first edit is free: it will not show an edited label.'
      : 'This edit will be saved to the post history.';
    const m = modal(
      '<div class="mh"><h3>Edit post</h3></div><div class="mc">' +
      (isComm ? '<div class="field"><label>Title</label><input class="input" id="epTitle" value="' + esc(p.title || '') + '"></div>' : '') +
      '<div class="field"><label>Text</label><textarea class="input" id="epContent" rows="5">' + esc(p.content || '') + '</textarea></div>' +
      '<div class="pmeta" style="margin-bottom:10px">' + note + '</div>' +
      '<button class="btn btn-primary btn-block" id="epSave">Save changes</button></div>'
    );
    m.q('#epSave').onclick = async () => {
      const fields = { content: m.q('#epContent').value.trim() };
      if (isComm) fields.title = m.q('#epTitle').value.trim();
      const btn = m.q('#epSave'); btn.disabled = true; btn.textContent = 'Saving...';
      try { const r = await API.editPost(p.id, fields); m.close(); toast('Post updated'); if (onSaved) onSaved(r.post); }
      catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Save changes'; }
    };
  }

  function openEditHistory(postId) {
    const m = modal('<div class="mh"><h3>Edit history</h3></div><div class="mc" id="histBody"><div class="empty">Loading...</div></div>');
    API.postHistory(postId).then((r) => {
      const body = m.q('#histBody');
      if (!r.versions || !r.versions.length) { body.innerHTML = '<div class="empty">No earlier versions.</div>'; return; }
      let html = '';
      if (r.current) {
        html += '<div class="hist-item hist-current"><div class="hist-when">Current' + (r.current.edited_at ? ' &#183; edited ' + timeAgo(r.current.edited_at) : '') + '</div>' +
          (r.current.title ? '<div class="hist-title">' + esc(r.current.title) + '</div>' : '') +
          '<div>' + esc(r.current.content) + '</div></div>';
      }
      r.versions.forEach((v) => {
        html += '<div class="hist-item"><div class="hist-when">Before ' + timeAgo(v.replaced_at) + '</div>' +
          (v.title ? '<div class="hist-title">' + esc(v.title) + '</div>' : '') +
          '<div>' + esc(v.content) + '</div></div>';
      });
      body.innerHTML = html;
    }).catch((e) => { m.q('#histBody').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  async function toggleComments(postId, node) {
    const box = node.querySelector('[data-comments]');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="empty" style="padding:8px">Loading comments...</div>';
    try {
      const r = await API.comments(postId);
      box.innerHTML = '';
      r.comments.forEach((c) => box.appendChild(commentNode(c)));
      box.appendChild(commentForm(postId, node));
      const input = box.querySelector('.comment-form input');
      if (input) input.focus();
    } catch (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  function commentNode(c) {
    const mine = c.author.id === ME.id;
    const node = el('<div class="comment"></div>');
    node.innerHTML =
      avatar(c.author, 32) +
      '<div style="flex:1;min-width:0"><div class="bubble"><div class="name" data-profile="' + c.author.id + '">' + esc(c.author.name) + verifTick(c.author) + '</div>' +
      linkify(esc(c.content)) + '</div>' +
      '<div class="cmeta"><span data-cvote></span><span data-react></span><span class="time">' + timeAgo(c.created_at) + '</span>' +
      '<span data-sum></span>' +
      (mine ? ' <button data-delc="' + c.id + '" class="clink">Delete</button>' : '') +
      '</div></div>';
    node.querySelector('[data-profile]').onclick = () => go('profile', c.author.id);
    const cvote = node.querySelector('[data-cvote]');
    if (cvote) cvote.appendChild(voteControl('comment', c.id, c.score || 0, c.myVote || 0, true));
    const sumEl = node.querySelector('[data-sum]');
    function paintSum(s) { sumEl.innerHTML = s && s.total ? ' ' + reactionSummaryHtml(s) : ''; }
    paintSum(c.reactions);
    node.querySelector('[data-react]').appendChild(reactionControl('comment', c.id, c.reactions, paintSum, { small: true }));
    const delc = node.querySelector('[data-delc]');
    if (delc) delc.onclick = async () => {
      try { await API.deleteComment(c.id); node.remove(); } catch (e) { toast(e.message); }
    };
    return node;
  }

  function commentForm(postId, postNode) {
    const form = el(
      '<div class="comment-form">' + avatar(ME, 32) +
      '<input type="text" placeholder="Write a comment..."><button class="btn btn-soft btn-sm">Send</button></div>'
    );
    const input = form.querySelector('input');
    const send = async () => {
      const content = input.value.trim();
      if (!content) return;
      input.disabled = true;
      try {
        const r = await API.addComment(postId, content);
        form.parentNode.insertBefore(commentNode(r.comment), form);
        input.value = '';
        postNode._post.commentCount += 1;
        renderStats(postNode);
      } catch (e) {
        toast(e.message);
      }
      input.disabled = false;
      input.focus();
    };
    form.querySelector('button').onclick = send;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return form;
  }

  /* ============================ stories ============================ */

  async function loadStories() {
    try {
      const r = await API.stories();
      const row = document.getElementById('storiesRow');
      if (!row) return;
      row.innerHTML = '';
      const add = el('<div class="story add"><div class="plus">+</div><div class="label">Add story</div></div>');
      add.onclick = openStoryComposer;
      row.appendChild(add);
      r.groups.forEach((g) => {
        const cover = g.stories[g.stories.length - 1];
        const tile = el('<div class="story"><img src="' + esc(cover.image) + '" alt=""><div class="ring"></div><div class="who">' + esc(g.user.name) + '</div></div>');
        tile.onclick = () => openStoryViewer(g);
        row.appendChild(tile);
      });
    } catch (e) {}
  }

  function openStoryComposer() {
    const m = modal(
      '<div class="mh"><h3>Add to your story</h3></div><div class="mc">' +
      '<div class="field"><input type="file" id="storyFile" accept="image/*" class="input"></div>' +
      '<div class="preview hidden" id="storyPrev" style="margin-bottom:12px"></div>' +
      '<div class="field"><input class="input" id="storyCap" placeholder="Add a caption (optional)"></div>' +
      '<button class="btn btn-primary btn-block" id="storyPost">Share to story</button>' +
      '</div>'
    );
    const file = m.q('#storyFile');
    file.onchange = () => {
      const f = file.files[0];
      if (f) {
        const u = URL.createObjectURL(f);
        const pv = m.q('#storyPrev');
        pv.innerHTML = '<img src="' + u + '" style="border-radius:10px;max-height:280px;width:100%;object-fit:cover">';
        pv.classList.remove('hidden');
      }
    };
    m.q('#storyPost').onclick = async () => {
      const f = file.files[0];
      if (!f) { toast('Choose a photo first'); return; }
      const btn = m.q('#storyPost');
      btn.disabled = true;
      btn.textContent = 'Sharing...';
      try {
        await API.createStory(f, m.q('#storyCap').value.trim());
        m.close();
        toast('Story shared');
        loadStories();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
        btn.textContent = 'Share to story';
      }
    };
  }

  function openStoryViewer(g) {
    let i = 0;
    const back = el(
      '<div class="story-view-back"><div class="story-view">' +
      '<button class="sv-close">&times;</button><div class="sv-head"></div><img alt=""><div class="sv-cap"></div>' +
      '</div></div>'
    );
    document.getElementById('modalRoot').appendChild(back);
    const img = back.querySelector('img');
    const head = back.querySelector('.sv-head');
    const cap = back.querySelector('.sv-cap');
    function show() {
      const s = g.stories[i];
      img.src = s.image;
      head.innerHTML = avatar(g.user, 32) + '<div style="font-weight:700">' + esc(g.user.name) + '</div><div style="opacity:.8;font-size:12px">' + timeAgo(s.created_at) + '</div>';
      cap.innerHTML = s.caption ? esc(s.caption) : '';
      cap.style.display = s.caption ? 'block' : 'none';
    }
    function next() { i += 1; if (i >= g.stories.length) close(); else show(); }
    function close() { back.remove(); }
    back.querySelector('.sv-close').onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    img.onclick = next;
    show();
  }

  /* ============================ right rail ============================ */

  async function renderRightRail() {
    const rail = document.getElementById('rightRail');
    rail.innerHTML = '<div class="card"><div class="section-title">Contacts</div><div id="contactsList"><div class="empty" style="padding:8px">Loading...</div></div></div>';
    try {
      const r = await API.friends();
      const list = document.getElementById('contactsList');
      if (!list) return;
      if (!r.users.length) {
        list.innerHTML = '<div class="empty" style="padding:8px;font-size:13px">No friends yet. Find people to add on the Friends page.</div>';
        return;
      }
      list.innerHTML = '';
      r.users.forEach((u) => {
        const c = el('<div class="contact">' + avatar(u, 36) + '<span class="nm">' + esc(u.name) + verifTick(u) + '</span><span class="dot-online' + (u.online ? '' : ' off') + '" data-dot="' + u.id + '" title="' + (u.online ? 'Online' : 'Offline') + '"></span></div>');
        c.onclick = () => go('messages', u.id);
        list.appendChild(c);
      });
    } catch (e) {}
  }

  /* ============================ friends ============================ */

  async function renderFriends() {
    view.innerHTML =
      '<div class="card"><div class="section-title">Friend requests</div><div id="reqList"><div class="empty">Loading...</div></div></div>' +
      '<div class="card"><div class="section-title">People you may know</div><div id="sugList" class="people-grid"><div class="empty">Loading...</div></div></div>' +
      '<div class="card"><div class="section-title">Your friends</div><div id="frList" class="people-grid"><div class="empty">Loading...</div></div></div>';

    try {
      const r = await API.friendRequests();
      const box = document.getElementById('reqList');
      if (!r.users.length) box.innerHTML = '<div class="empty" style="padding:8px">No pending requests.</div>';
      else { box.innerHTML = ''; r.users.forEach((u) => box.appendChild(requestRow(u))); }
    } catch (e) {}

    try {
      const r = await API.suggestions();
      const box = document.getElementById('sugList');
      if (!r.users.length) box.innerHTML = '<div class="empty">No suggestions right now.</div>';
      else { box.innerHTML = ''; r.users.forEach((u) => box.appendChild(personCard(u, 'add'))); }
    } catch (e) {}

    try {
      const r = await API.friends();
      const box = document.getElementById('frList');
      if (!r.users.length) box.innerHTML = '<div class="empty">No friends yet.</div>';
      else { box.innerHTML = ''; r.users.forEach((u) => box.appendChild(personCard(u, 'message'))); }
    } catch (e) {}

    renderRightRail();
  }

  function requestRow(u) {
    const row = el(
      '<div class="contact" style="padding:10px 4px">' + avatar(u, 48) +
      '<div style="flex:1"><div class="nm" data-profile="' + u.id + '">' + esc(u.name) + '</div></div>' +
      '<button class="btn btn-primary btn-sm" data-accept>Confirm</button>&nbsp;' +
      '<button class="btn btn-sm" data-decline>Delete</button></div>'
    );
    row.querySelector('[data-profile]').onclick = () => go('profile', u.id);
    row.querySelector('[data-accept]').onclick = async () => {
      try { await API.acceptRequest(u.id); toast('You are now friends with ' + u.name); row.remove(); refreshBadges(); } catch (e) { toast(e.message); }
    };
    row.querySelector('[data-decline]').onclick = async () => {
      try { await API.declineRequest(u.id); row.remove(); refreshBadges(); } catch (e) { toast(e.message); }
    };
    return row;
  }

  function personCard(u, mode) {
    const card = el(
      '<div class="person"><div class="ph">' + avatar(u, 80) + '</div>' +
      '<div class="pn" data-profile="' + u.id + '">' + esc(u.name) + '</div><div class="pb"></div></div>'
    );
    card.querySelector('[data-profile]').onclick = () => go('profile', u.id);
    const pb = card.querySelector('.pb');
    if (mode === 'add') {
      const b = el('<button class="btn btn-primary btn-sm btn-block">Add friend</button>');
      b.onclick = async () => {
        b.disabled = true;
        try { await API.sendRequest(u.id); b.textContent = 'Request sent'; } catch (e) { toast(e.message); b.disabled = false; }
      };
      pb.appendChild(b);
    } else if (mode === 'message') {
      const b = el('<button class="btn btn-soft btn-sm btn-block">Message</button>');
      b.onclick = () => go('messages', u.id);
      pb.appendChild(b);
    } else {
      const b = el('<button class="btn btn-sm btn-block">View profile</button>');
      b.onclick = () => go('profile', u.id);
      pb.appendChild(b);
    }
    return card;
  }

  /* ============================ search ============================ */

  async function renderSearch(q) {
    view.innerHTML = '<div class="card"><div class="section-title">Results for "' + esc(q) + '"</div><div id="searchList" class="people-grid"><div class="empty">Searching...</div></div></div>';
    try {
      const r = await API.searchUsers(q);
      const box = document.getElementById('searchList');
      if (!r.users.length) box.innerHTML = '<div class="empty">No people found.</div>';
      else { box.innerHTML = ''; r.users.forEach((u) => box.appendChild(personCard(u, 'view'))); }
    } catch (e) {}
    renderRightRail();
  }

  /* ============================ profile ============================ */

  // Who-can-see-my-profile control. The three levels gate the profile page + wall
  // server-side; this is the owner's button + the explain-and-approve modal.
  var VIS_META = {
    public: { icon: '&#127760;', label: 'Public', desc: 'Anyone on OpenBook can see your profile and your public posts. Best for reaching the most people.' },
    friends: { icon: '&#128101;', label: 'Friends only', desc: 'Only people you have accepted as friends can see your profile and posts. Everyone else just sees your name and photo.' },
    private: { icon: '&#128274;', label: 'Private', desc: 'Only you can see your profile and posts. Nobody else, not even your friends, can open it.' },
  };
  function visibilityBtn(u) {
    var m = VIS_META[u.visibility] || VIS_META.public;
    return ' <button class="btn btn-soft btn-sm" id="visBtn" title="Choose who can see your profile">' + m.icon + ' ' + m.label + '</button>';
  }
  function openVisibilityModal(current) {
    var selected = VIS_META[current] ? current : 'public';
    function optHtml(v) {
      var m = VIS_META[v];
      return '<button type="button" class="vis-opt' + (v === selected ? ' sel' : '') + '" data-vis="' + v + '">' +
        '<span class="vis-ic">' + m.icon + '</span>' +
        '<span class="vis-txt"><span class="vis-label">' + m.label + '</span><span class="vis-desc">' + m.desc + '</span></span>' +
        '<span class="vis-check">&#10003;</span></button>';
    }
    var m = modal(
      '<div class="mh"><h3>Who can see your profile?</h3></div>' +
      '<div class="mc">' +
      '<p class="shint" style="font-size:13px;margin:0 0 12px">Choose who can open your profile and see your posts. You can change this any time, and it takes effect immediately.</p>' +
      '<div class="vis-opts">' + ['public', 'friends', 'private'].map(optHtml).join('') + '</div>' +
      '<button class="btn btn-primary btn-block" id="visApply" style="margin-top:14px">Apply</button>' +
      '</div>'
    );
    function mark() { m.node.querySelectorAll('.vis-opt').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-vis') === selected); }); }
    m.node.querySelectorAll('.vis-opt').forEach(function (b) { b.onclick = function () { selected = b.getAttribute('data-vis'); mark(); }; });
    m.q('#visApply').onclick = async function () {
      const btn = m.q('#visApply'); btn.disabled = true;
      try {
        await API.setVisibility(selected);
        if (ME) ME.visibility = selected;
        m.close();
        toast('Profile visibility set to "' + (VIS_META[selected] ? VIS_META[selected].label : selected) + '".');
        renderProfile(ME.id);
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  }

  function profileActions(data) {
    const u = data.user;
    const share = ' <button class="btn btn-icon" data-share-profile="' + esc((u.username || u.id) + '') + '" title="Share profile" aria-label="Share profile">&#128279;</button>';
    let main;
    switch (data.friendStatus) {
      case 'self': main = '<button class="btn btn-soft btn-sm" id="editProfileBtn">Edit profile</button>' + visibilityBtn(u); break;
      case 'friends': main = '<button class="btn btn-primary" data-msg="' + u.id + '">Message</button>&nbsp;<button class="btn" data-unfriend="' + u.id + '">Friends &#10003;</button>'; break;
      case 'requested': main = '<button class="btn" data-unfriend="' + u.id + '">Cancel request</button>'; break;
      case 'incoming': main = '<button class="btn btn-primary" data-accept="' + u.id + '">Confirm request</button>&nbsp;<button class="btn" data-decline="' + u.id + '">Delete</button>'; break;
      default: main = '<button class="btn btn-primary" data-addfriend="' + u.id + '">Add friend</button>';
    }
    return main + followBtn(data) + share;
  }

  // Follow / Following toggle, shown on everyone's profile except your own.
  // Follow is independent of friendship: you can follow without a friend request.
  function followBtn(data) {
    if (data.friendStatus === 'self') return '';
    return data.isFollowing
      ? ' <button class="btn btn-soft btn-sm" data-unfollow="' + data.user.id + '">Following &#10003;</button>'
      : ' <button class="btn btn-sm" data-follow="' + data.user.id + '">Follow</button>';
  }

  // Render a user's bio. URLs become clickable only when the server flags it
  // (u.bioLinks: Plus tier $3+, or a long-standing trusted / high-standing
  // account) - the anti-spam gate. Otherwise the URL shows as plain text.
  function bioHtml(u) {
    var raw = (u && u.bio) || '';
    if (!raw) return '';
    var safe = esc(raw);
    if (u && u.bioLinks) {
      // Linkify full URLs (http/https), www.* links, AND bare domains like
      // "openbook.space/x" so a supporter does not have to type "https://".
      var re = /(\bhttps?:\/\/[^\s<]+)|(\bwww\.[^\s<]+)|(\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|me|app|dev|xyz|space|ai|gg|tv|info|biz|link|site|online|store|shop|page|live|vn|uk|us)(?:\/[^\s<]*)?)/gi;
      safe = safe.replace(re, function (m) {
        var href = /^https?:\/\//i.test(m) ? m : 'https://' + m;
        return '<a href="' + href + '" target="_blank" rel="noopener nofollow ugc" class="bio-link">' + m + '</a>';
      });
    }
    return '<div class="profile-bio" style="margin-top:4px">' + safe + '</div>';
  }

  // A minimal, content-free profile shown when the owner set it to friends-only or
  // private and the viewer is not allowed in: name + photo + an explanation (and an
  // Add friend action for the friends-only case).
  function renderLockedProfile(u, data) {
    const isPrivate = data.locked === 'private';
    const msg = isPrivate
      ? esc(u.name) + ' keeps this profile private. Only they can see it.'
      : esc(u.name) + ' shares this profile with friends only. Add them as a friend to see their profile and posts.';
    let act = '';
    if (!isPrivate) {
      if (data.friendStatus === 'none') act = '<button class="btn btn-primary" data-addfriend="' + u.id + '">Add friend</button>';
      else if (data.friendStatus === 'requested') act = '<span class="shint">Friend request sent.</span>';
      else if (data.friendStatus === 'incoming') act = '<button class="btn btn-primary" data-accept="' + u.id + '">Confirm friend request</button>';
    }
    view.innerHTML =
      '<div class="card card-pad-0">' +
      '<div class="profile-cover"></div>' +
      '<div class="profile-head">' +
      '<div class="av-wrap">' + avatar(u, 130) + '</div>' +
      '<div class="phead-main"><div class="phead-row"><div class="phead-id">' +
      '<div class="pname">' + esc(u.name) + verifTick(u) + ' ' + badgeChip(u) + '</div>' +
      (u.username ? '<div class="pmeta" style="color:var(--text-soft);font-weight:600">@' + esc(u.username) + '</div>' : '') +
      '</div><div class="pactions"><button class="btn btn-icon" data-share-profile="' + esc((u.username || u.id) + '') + '" title="Share profile" aria-label="Share profile">&#128279;</button></div></div></div>' +
      '</div></div>' +
      '<div class="card"><div class="empty" style="padding:40px 20px">' +
      '<div style="font-size:34px;margin-bottom:10px">' + (isPrivate ? '&#128274;' : '&#128101;') + '</div>' +
      '<div style="max-width:380px;margin:0 auto;line-height:1.5">' + msg + '</div>' +
      (act ? '<div style="margin-top:16px">' + act + '</div>' : '') +
      '</div></div>';
    wireProfileActions(view, data);
    renderRightRail();
  }

  async function renderProfile(id) {
    view.innerHTML = '<div class="card card-pad-0"><div class="empty" style="padding:40px">Loading profile...</div></div>';
    let data;
    try { data = await API.getProfile(id); }
    catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }

    const u = data.user;
    // Reflect this profile's shareable link in the address bar so it can be copied
    // straight from there: /u/<username> (or /u/<id> if no username is set).
    try { window.history.replaceState({}, '', '/u/' + encodeURIComponent(u.username || u.id)); } catch (e) {}
    // The owner set this profile to friends-only or private and the viewer is not
    // allowed: show a minimal locked view instead of the full profile.
    if (data.locked) { renderLockedProfile(u, data); return; }
    const isMe = data.friendStatus === 'self';
    const _themeObj = themeFor(u); // Premium background gradient (gated server-side via u.theme)
    // Name color is chosen SEPARATELY from the background gradient: it comes only
    // from the accent color picker (u.accent), never from the theme.
    const _nameAccent = (u.accent && /^#[0-9a-fA-F]{6}$/.test(u.accent)) ? u.accent : '';
    const coverStyle = u.cover
      ? ' style="background-image:url(\'' + esc(u.cover) + '\');background-position:' + esc(u.coverPos || '50% 50%') + '"'
      : (_themeObj ? ' style="background:' + _themeObj.gradient + '"' : '');
    // The theme also skins the whole profile background (always visible, even
    // when a cover photo is set): the gradient frames the top identity area and
    // a soft accent tint washes behind the posts. Independent of the name color.
    const skinOpen = _themeObj
      ? '<div class="profile-skin themed" style="background-image:' + _themeObj.gradient + ';background-color:' + hexToRgba(_themeObj.accent, 0.14) + '">'
      : '<div class="profile-skin">';

    view.innerHTML =
      skinOpen +
      '<div class="card card-pad-0">' +
      '<div class="profile-cover"' + coverStyle + '>' + (isMe ? '<div class="cover-tools"><button class="btn btn-sm cover-btn" id="editCoverBtn">&#128247; Edit cover</button>' + (u.cover ? '<button class="btn btn-sm cover-btn" id="reposCoverBtn">&#8597; Reposition</button>' : '') + '</div>' : '') + '</div>' +
      '<div class="profile-head">' +
      '<div class="av-wrap">' + avatar(u, 130) + (isMe ? '<button class="cam" id="editAvatarBtn" title="Change photo">&#128247;</button>' + (u.avatar ? '<button class="cam cam-repos" id="reposAvatarBtn" title="Reposition photo">&#10021;</button>' : '') : '') + '</div>' +
      '<div class="phead-main">' +
      '<div class="phead-row">' +
      '<div class="phead-id"><div class="pname"' + (_nameAccent ? ' style="--name-accent:' + esc(_nameAccent) + '"' : '') + '>' + esc(u.name) + verifTick(u) + ' ' + badgeChip(u) + '</div>' +
      (u.username ? '<div class="pmeta" style="color:var(--text-soft);font-weight:600">@' + esc(u.username) + '</div>' : '') +
      '<div class="pmeta">' + data.friendsCount + ' friends &#183; ' + (data.followersCount || 0) + ' followers &#183; ' + data.postsCount + ' posts</div>' +
      (data.nameHistory && data.nameHistory.length
        ? '<div class="pmeta" style="font-size:12px">Previously known as: ' + data.nameHistory.map((h) => esc(h.name)).join(', ') + '</div>'
        : '') +
      '</div>' +
      '<div class="pactions">' + profileActions(data) + '</div>' +
      '</div>' +
      bioHtml(u) +
      '</div>' +
      '</div>' +
      '<div id="profileAlbums"></div>' +
      (isMe ? composerHtml() : '') +
      '<div id="profilePosts"><div class="card"><div class="empty">Loading posts...</div></div></div>' +
      '</div>';

    wireProfileActions(view, data);
    if (isMe) {
      wireComposer('profilePosts');
      wireProfilePhotoEdits();
    }

    try {
      const r = await API.userPosts(u.id);
      const emptyMsg = r.locked
        ? u.name + ' shares posts with friends. Add them as a friend to see their posts.'
        : (isMe ? 'You have not posted anything yet.' : u.name + ' has not posted anything yet.');
      renderPosts(document.getElementById('profilePosts'), r.posts, emptyMsg);
    } catch (e) {}

    loadProfileAlbums(u, isMe);
    renderRightRail();
  }

  function wireProfileActions(root, data) {
    const u = data.user;
    root.querySelectorAll('[data-msg]').forEach((b) => (b.onclick = () => go('messages', u.id)));
    root.querySelectorAll('[data-addfriend]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await API.sendRequest(u.id); toast('Friend request sent'); renderProfile(u.id); } catch (e) { toast(e.message); b.disabled = false; }
    }));
    root.querySelectorAll('[data-unfriend]').forEach((b) => (b.onclick = async () => {
      if (!window.confirm('Remove this connection?')) return;
      try { await API.unfriend(u.id); renderProfile(u.id); } catch (e) { toast(e.message); }
    }));
    root.querySelectorAll('[data-follow]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await API.follow(u.id); renderProfile(u.id); } catch (e) { toast(e.message); b.disabled = false; }
    }));
    root.querySelectorAll('[data-unfollow]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await API.unfollow(u.id); renderProfile(u.id); } catch (e) { toast(e.message); b.disabled = false; }
    }));
    root.querySelectorAll('[data-accept]').forEach((b) => (b.onclick = async () => {
      try { await API.acceptRequest(u.id); toast('You are now friends'); renderProfile(u.id); refreshBadges(); } catch (e) { toast(e.message); }
    }));
    root.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = async () => {
      try { await API.declineRequest(u.id); renderProfile(u.id); refreshBadges(); } catch (e) { toast(e.message); }
    }));
    const edit = root.querySelector('#editProfileBtn');
    if (edit) edit.onclick = openEditProfile;
    const vis = root.querySelector('#visBtn');
    if (vis) vis.onclick = () => openVisibilityModal(data.user.visibility);
  }

  function wireProfilePhotoEdits() {
    const avBtn = document.getElementById('editAvatarBtn');
    const cvBtn = document.getElementById('editCoverBtn');
    if (avBtn) avBtn.onclick = () => pickImage(async (file) => {
      try { ME = (await API.uploadAvatar(file)).user; toast('Profile photo updated'); setupChromeAvatar(); renderLeftRail(); renderProfile(ME.id); openReposition('avatar'); } catch (e) { toast(e.message); }
    });
    if (cvBtn) cvBtn.onclick = () => pickImage(async (file) => {
      try { const r = await API.uploadCover(file); if (r && r.user) ME.cover = r.user.cover; toast('Cover photo updated'); renderProfile(ME.id); openReposition('cover'); } catch (e) { toast(e.message); }
    });
    const rAv = document.getElementById('reposAvatarBtn');
    const rCv = document.getElementById('reposCoverBtn');
    if (rAv) rAv.onclick = () => openReposition('avatar');
    if (rCv) rCv.onclick = () => openReposition('cover');
  }

  // Drag-to-reposition for the avatar or cover photo (Facebook style). Shows the
  // photo in a frame; dragging maps to a CSS object-position the server stores and
  // every render then applies. The math: with object-fit cover the image overflows
  // the frame by (scaledSize - frameSize); a drag of d px changes the position by
  // d / overflow * 100 percent.
  function openReposition(kind) {
    const src = kind === 'cover' ? ME.cover : ME.avatar;
    if (!src) { toast('Add a photo first'); return; }
    const cur = String((kind === 'cover' ? ME.coverPos : ME.avatarPos) || '50% 50%').split(' ');
    const pos = { x: parseFloat(cur[0]) || 50, y: parseFloat(cur[1]) || 50 };
    const m = modal(
      '<div class="mh"><h3>Reposition ' + (kind === 'cover' ? 'cover' : 'profile') + ' photo</h3></div><div class="mc">' +
      '<div class="repos-frame ' + (kind === 'cover' ? 'rf-cover' : 'rf-avatar') + '"><img id="reposImg" src="' + esc(src) + '" draggable="false" alt=""></div>' +
      '<div class="shint" style="font-size:12px;margin-top:8px;text-align:center">Drag the photo to choose what shows.</div>' +
      '<button class="btn btn-primary btn-block" id="reposSave" style="margin-top:12px">Save position</button></div>'
    );
    const frame = m.q('.repos-frame');
    const img = m.q('#reposImg');
    let oX = 0, oY = 0;
    function measure() {
      const fw = frame.clientWidth, fh = frame.clientHeight, iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih || !fw || !fh) return;
      const scale = Math.max(fw / iw, fh / ih);
      oX = Math.max(0, iw * scale - fw);
      oY = Math.max(0, ih * scale - fh);
      img.style.objectPosition = pos.x + '% ' + pos.y + '%';
    }
    if (img.complete) measure(); else img.onload = measure;
    let dragging = false, lx = 0, ly = 0;
    frame.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; try { frame.setPointerCapture(e.pointerId); } catch (er) {} e.preventDefault(); });
    frame.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      if (oX > 0) pos.x = Math.max(0, Math.min(100, pos.x - (dx / oX) * 100));
      if (oY > 0) pos.y = Math.max(0, Math.min(100, pos.y - (dy / oY) * 100));
      img.style.objectPosition = pos.x + '% ' + pos.y + '%';
    });
    frame.addEventListener('pointerup', () => { dragging = false; });
    frame.addEventListener('pointercancel', () => { dragging = false; });
    m.q('#reposSave').onclick = async () => {
      const posStr = Math.round(pos.x) + '% ' + Math.round(pos.y) + '%';
      try {
        const r = await API.photoPosition(kind === 'cover' ? { coverPos: posStr } : { avatarPos: posStr });
        ME.avatarPos = r.avatarPos; ME.coverPos = r.coverPos;
        m.close();
        toast('Position saved');
        if (kind === 'avatar') { setupChromeAvatar(); renderLeftRail(); }
        renderProfile(ME.id);
      } catch (e) { toast(e.message); }
    };
  }

  function openEditProfile() {
    const m = modal(
      '<div class="mh"><h3>Edit profile</h3></div><div class="mc">' +
      '<div class="field"><label>Name</label><input class="input" id="epName" value="' + esc(ME.name) + '">' +
      '<div class="shint" style="font-size:12px">Name changes are limited (first after 30 days, then every 3 months, then yearly) and your old names stay visible on your profile.</div></div>' +
      '<div class="field"><label>Username</label>' +
      '<div class="row" style="gap:6px;align-items:center"><span style="font-weight:800;color:var(--text-soft);font-size:16px">@</span>' +
      '<input class="input" id="epUsername" maxlength="20" placeholder="username" value="' + esc(ME.username || '') + '" style="flex:1"></div>' +
      '<div class="shint" id="epUserMsg" style="font-size:12px">Your unique @handle: 3 to 20 characters, letters, numbers, or underscore.</div></div>' +
      '<div class="field"><label>Bio</label><textarea class="input" id="epBio" rows="3" maxlength="300" placeholder="Tell people about yourself">' + esc(ME.bio || '') + '</textarea>' +
      '<div class="shint" style="font-size:12px;display:flex;justify-content:space-between;gap:10px"><span>Links become clickable on <strong>Plus</strong> and above (or for long-standing trusted accounts).</span><span id="epBioCount" style="white-space:nowrap;color:var(--text-soft)"></span></div></div>' +
      ((ME.tier >= 1)
        ? ('<div class="field"><label>Name color</label>' +
            '<div class="row" style="gap:10px;align-items:center">' +
              '<input type="color" id="epAccent" value="' + ((ME.accent && /^#[0-9a-fA-F]{6}$/.test(ME.accent)) ? esc(ME.accent) : '#4f8cff') + '" style="width:48px;height:34px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--card);cursor:pointer">' +
              '<button class="btn btn-sm" type="button" id="epAccentClear">Clear</button>' +
              '<span class="shint" style="font-size:12px">A supporter perk: sets the color of your name. Chosen separately from your background.</span>' +
            '</div></div>')
        : '') +
      ((ME.tier >= 3)
        ? ('<div class="field"><label>Profile background gradient</label>' +
            '<div class="theme-grid" id="epThemes">' +
              '<button type="button" class="theme-sw theme-none" data-th="">None</button>' +
              Object.keys(PROFILE_THEMES).map(function (id) { return '<button type="button" class="theme-sw" data-th="' + id + '" title="' + esc(PROFILE_THEMES[id].name) + '" style="background:' + PROFILE_THEMES[id].gradient + '"></button>'; }).join('') +
            '</div>' +
            '<div class="shint" style="font-size:12px">A Premium perk: pick a gradient for your profile background. Chosen separately from your name color.</div></div>')
        : '') +
      '<button class="btn btn-primary btn-block" id="epSave">Save changes</button>' +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line,#2a2a2a)">' +
      '<div class="shint" style="font-size:12px;margin-bottom:6px">Your data</div>' +
      '<p class="shint" style="font-size:12px;line-height:1.5;margin:0 0 8px">Download everything OpenBook holds about you. Your data is yours, and it is never sold.</p>' +
      '<button class="btn btn-soft btn-block" id="epExportJson" style="margin-bottom:8px">Download my data (JSON)</button>' +
      '<button class="btn btn-soft btn-block" id="epExportZip">Download everything (ZIP, includes media)</button>' +
      '<div id="epExportStatus" class="shint" style="font-size:12px;margin-top:8px"></div>' +
      '</div>' +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line,#2a2a2a)">' +
      '<div class="shint" style="font-size:12px;margin-bottom:8px">Danger zone</div>' +
      '<button class="btn btn-soft btn-block" id="epDelete" style="color:#e5484d">Delete my account</button>' +
      '</div>' +
      '</div>'
    );
    var _bioEl = m.q('#epBio'), _bioCount = m.q('#epBioCount');
    if (_bioEl && _bioCount) { var _updBio = function () { _bioCount.textContent = _bioEl.value.length + ' / 300'; }; _bioEl.addEventListener('input', _updBio); _updBio(); }
    var _userEl = m.q('#epUsername'), _userMsg = m.q('#epUserMsg'), _userT;
    if (_userEl) _userEl.addEventListener('input', function () {
      clearTimeout(_userT);
      if (_userEl.value.charAt(0) === '@') _userEl.value = _userEl.value.slice(1);
      var v = _userEl.value.trim();
      if (!v || v.toLowerCase() === (ME.username || '').toLowerCase()) { _userMsg.textContent = 'Your unique @handle: 3 to 20 characters, letters, numbers, or underscore.'; _userMsg.style.color = ''; return; }
      _userMsg.textContent = 'Checking...'; _userMsg.style.color = '';
      _userT = setTimeout(function () {
        API.checkUsername(v).then(function (r) {
          _userMsg.textContent = r.available ? ('@' + v + ' is available') : (r.error || 'That username is taken.');
          _userMsg.style.color = r.available ? '#2e8b57' : '#e5484d';
        }).catch(function () { _userMsg.textContent = ''; });
      }, 350);
    });
    var _accent = (ME.accent && /^#[0-9a-fA-F]{6}$/.test(ME.accent)) ? ME.accent : '';
    var _accentEl = m.q('#epAccent');
    if (_accentEl) {
      _accentEl.addEventListener('input', function () { _accent = _accentEl.value; });
      var _accentClear = m.q('#epAccentClear');
      if (_accentClear) _accentClear.onclick = function () { _accent = ''; _accentEl.value = '#4f8cff'; toast('Accent cleared, save to apply'); };
    }
    var _theme = ME.theme || '';
    var _themeWrap = m.q('#epThemes');
    if (_themeWrap) {
      var _markTheme = function () { _themeWrap.querySelectorAll('.theme-sw').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-th') === _theme); }); };
      _themeWrap.querySelectorAll('.theme-sw').forEach(function (b) { b.onclick = function () { _theme = b.getAttribute('data-th'); _markTheme(); }; });
      _markTheme();
    }
    m.q('#epSave').onclick = async () => {
      const name = m.q('#epName').value.trim();
      const bio = m.q('#epBio').value.trim();
      if (!name) { toast('Name cannot be empty'); return; }
      try {
        const accentArg = (ME.tier >= 1) ? _accent : undefined; // only paid tiers/founder send it
        const userArg = _userEl ? _userEl.value.trim() : undefined;
        const themeArg = (ME.tier >= 3) ? _theme : undefined; // only Premium/founder send it
        ME = (await API.updateProfile(name, bio, accentArg, userArg, themeArg)).user;
        m.close();
        toast('Profile saved');
        setupChromeAvatar();
        renderLeftRail();
        renderProfile(ME.id);
      } catch (e) { toast(e.message); }
    };
    // Your data: instant JSON download, or a background ZIP (data + media).
    m.q('#epExportJson').onclick = () => { window.location.href = '/api/users/me/export.json'; };
    m.q('#epExportZip').onclick = async () => {
      const btn = m.q('#epExportZip'), st = m.q('#epExportStatus');
      btn.disabled = true;
      st.textContent = 'Building your export, this can take a moment...';
      try {
        let job = (await API.startExport()).job;
        for (let i = 0; i < 60 && job.status !== 'ready' && job.status !== 'failed'; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          job = (await API.exportJob(job.id)).job;
        }
        if (job.status === 'failed') throw new Error(job.error || 'Export failed');
        if (job.status === 'ready' && job.downloadUrl) {
          st.innerHTML = 'Ready. <a href="' + job.downloadUrl + '" style="color:var(--brand)">Download your export</a> (link expires in 24 hours).';
          window.location.href = job.downloadUrl;
        } else {
          st.textContent = 'Still building. Reopen this in a minute to grab it.';
        }
      } catch (e) { st.textContent = e.message || 'Export failed'; }
      finally { btn.disabled = false; }
    };
    // Danger zone: delete account. Swaps the modal to a password confirm step,
    // since this wipes the account and all of its media for good.
    m.q('#epDelete').onclick = () => {
      const mc = m.q('.mc');
      mc.innerHTML =
        '<h3 style="margin:0 0 8px">Delete your account?</h3>' +
        '<p class="shint" style="font-size:13px;line-height:1.5">This permanently removes your profile, posts, photos, videos, messages, and every file you uploaded. It cannot be undone. Enter your password to confirm.</p>' +
        '<div class="field"><label>Password</label><input class="input" type="password" id="epDelPw" placeholder="Your password"></div>' +
        '<button class="btn btn-block" id="epDelCancel" style="margin-bottom:8px">Cancel</button>' +
        '<button class="btn btn-primary btn-block" id="epDelConfirm" style="background:#e5484d;border-color:#e5484d">Permanently delete</button>';
      m.q('#epDelCancel').onclick = () => m.close();
      m.q('#epDelConfirm').onclick = async () => {
        const pw = m.q('#epDelPw').value;
        if (!pw) { toast('Enter your password to confirm'); return; }
        try { await API.deleteAccount(pw); window.location.href = '/'; }
        catch (e) { toast(e.message); }
      };
    };
  }

  /* ============================ suggestions ============================ */

  async function renderSuggestions() {
    view.innerHTML =
      '<div class="card"><div class="pname">&#128161; Suggestions</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.5">Suggest a fix, update, or change to OpenBook. Everyone votes, and the most upvoted ideas rise to the top. The most-wanted each week get built first. This is the community deciding what we build, in the open.</div></div>' +
      '<div class="card">' +
        '<div class="field"><input class="input" id="sugTitle" maxlength="140" placeholder="Your idea (a fix, update, or change)"></div>' +
        '<div class="field"><textarea class="input" id="sugBody" rows="2" maxlength="2000" placeholder="Add details (optional)"></textarea></div>' +
        '<div class="row" style="gap:8px;align-items:center">' +
          '<select class="input" id="sugCat" style="max-width:150px">' +
            '<option value="change">&#128260; Change</option><option value="fix">&#128295; Fix</option><option value="update">&#10024; Update</option>' +
          '</select><span class="spacer"></span>' +
          '<button class="btn btn-primary" id="sugSubmit">Submit suggestion</button>' +
        '</div>' +
      '</div>' +
      '<div id="suggestList"><div class="card"><div class="empty">Loading suggestions...</div></div></div>';

    const submit = document.getElementById('sugSubmit');
    submit.onclick = async () => {
      const title = document.getElementById('sugTitle').value.trim();
      const body = document.getElementById('sugBody').value.trim();
      const category = document.getElementById('sugCat').value;
      if (!title) { toast('Give your suggestion a short title'); return; }
      submit.disabled = true; submit.textContent = 'Submitting...';
      try {
        await API.createSuggestion(title, body, category);
        document.getElementById('sugTitle').value = '';
        document.getElementById('sugBody').value = '';
        await loadSuggestions();
        toast('Thanks! Your suggestion is live.');
      } catch (e) { toast(e.message); }
      submit.disabled = false; submit.textContent = 'Submit suggestion';
    };
    await loadSuggestions();
  }

  async function loadSuggestions() {
    const list = document.getElementById('suggestList');
    if (!list) return;
    try {
      const r = await API.listSuggestions();
      if (!r.suggestions.length) {
        list.innerHTML = '<div class="card"><div class="empty">No suggestions yet. Be the first to suggest something.</div></div>';
        return;
      }
      list.innerHTML = '';
      r.suggestions.forEach((s) => list.appendChild(suggestionItem(s, r.isAdmin)));
    } catch (e) {
      list.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>';
    }
  }

  function suggestionItem(s, isAdmin) {
    const node = el('<div class="card sug" data-sug="' + s.id + '"></div>');
    const statusBadge = s.status !== 'open' ? '<span class="sug-status sug-status-' + esc(s.status) + '">' + esc(s.status) + '</span>' : '';
    node.innerHTML =
      '<div class="sug-row">' +
        '<div class="votebox"><button class="vote up" title="Upvote">&#9650;</button><span class="vscore">' + s.score + '</span><button class="vote down" title="Downvote">&#9660;</button></div>' +
        '<div class="sug-main">' +
          '<div class="sug-title">' + esc(s.title) + '</div>' +
          (s.body ? '<div class="sug-body">' + esc(s.body) + '</div>' : '') +
          '<div class="sug-meta"><span class="sug-cat">' + esc(s.category) + '</span>' + statusBadge +
            '<span>by ' + esc(s.author.name) + verifTick(s.author) + '</span></div>' +
          '<div class="sug-admin"></div>' +
        '</div>' +
      '</div>';
    const up = node.querySelector('.vote.up');
    const down = node.querySelector('.vote.down');
    const sc = node.querySelector('.vscore');
    function paint() {
      sc.textContent = s.score;
      up.classList.toggle('on', s.myVote === 1);
      down.classList.toggle('on', s.myVote === -1);
      sc.classList.toggle('pos', s.score > 0);
      sc.classList.toggle('neg', s.score < 0);
    }
    paint();
    async function cast(v) { try { const r = await API.voteSuggestion(s.id, v); s.score = r.suggestion.score; s.myVote = r.suggestion.myVote; paint(); } catch (e) { toast(e.message); } }
    up.onclick = () => cast(s.myVote === 1 ? 0 : 1);
    down.onclick = () => cast(s.myVote === -1 ? 0 : -1);
    const adminEl = node.querySelector('.sug-admin');
    if (isAdmin) {
      ['planned', 'shipped', 'declined', 'open'].forEach((st) => {
        const b = el('<button class="btn btn-sm">' + st + '</button>');
        b.onclick = async () => { try { await API.suggestionStatus(s.id, st); await loadSuggestions(); } catch (e) { toast(e.message); } };
        adminEl.appendChild(b);
      });
    }
    if (s.mine || isAdmin) {
      const d = el('<button class="btn btn-sm btn-danger">Delete</button>');
      d.onclick = async () => { if (!window.confirm('Delete this suggestion?')) return; try { await API.deleteSuggestion(s.id); node.remove(); } catch (e) { toast(e.message); } };
      adminEl.appendChild(d);
    }
    return node;
  }

  /* ============================ messages ============================ */

  async function renderMessages(userId) {
    view.innerHTML =
      '<div class="card card-pad-0"><div class="messenger" id="messenger">' +
      '<div class="mlist" id="convoList"><div class="empty" style="padding:16px">Loading...</div></div>' +
      '<div class="mthread" id="thread"><div class="chat-empty">Select a conversation to start chatting</div></div>' +
      '</div></div>';
    await loadConversations(userId ? Number(userId) : null);
    if (userId) openThread(Number(userId));
  }

  async function loadConversations(activeId) {
    try {
      const r = await API.conversations();
      const list = document.getElementById('convoList');
      if (!list) return;
      if (!r.conversations.length) {
        list.innerHTML = '<div class="empty" style="padding:16px">No conversations yet. Open a friend and tap Message to say hi.</div>';
        return;
      }
      list.innerHTML = '';
      r.conversations.forEach((c) => list.appendChild(convoRow(c, activeId)));
    } catch (e) {}
  }

  function convoRow(c, activeId) {
    const u = c.user;
    const last = c.lastMessage ? (c.lastMessage.mine ? 'You: ' : '') + c.lastMessage.content : 'Say hi';
    const row = el(
      '<div class="convo' + (Number(activeId) === u.id ? ' active' : '') + '" data-uid="' + u.id + '">' +
      avatar(u, 48) + '<div class="cm"><div class="nm">' + esc(u.name) + '</div><div class="lm">' + esc(last) + '</div></div>' +
      (c.unreadCount ? '<span class="badge" style="position:static">' + c.unreadCount + '</span>' : '') +
      '</div>'
    );
    row.onclick = () => openThread(u.id);
    return row;
  }

  async function openThread(userId) {
    activeChatUser = userId;
    document.querySelectorAll('#convoList .convo').forEach((r) =>
      r.classList.toggle('active', Number(r.dataset.uid) === userId)
    );
    const thread = document.getElementById('thread');
    thread.innerHTML = '<div class="chat-empty">Loading...</div>';
    const messenger = document.getElementById('messenger');
    if (messenger) messenger.classList.add('show-thread');

    let data;
    try { data = await API.history(userId); }
    catch (e) { thread.innerHTML = '<div class="chat-empty">' + esc(e.message) + '</div>'; return; }

    const u = data.user;
    thread.innerHTML =
      '<div class="thead"><button class="btn btn-ghost btn-sm" id="backToList">&#8592;</button>' +
      '<span class="link" data-headprofile="' + u.id + '">' + avatar(u, 40) + '</span>' +
      '<div class="link" style="font-weight:700;flex:1" data-headprofile="' + u.id + '">' + esc(u.name) + verifTick(u) + '</div></div>' +
      '<div class="mbody" id="mbody"></div>' +
      '<div class="mfoot"><input id="msgInput" placeholder="Type a message..." autocomplete="off"><button class="btn btn-primary" id="msgSend">Send</button></div>';

    const body = document.getElementById('mbody');
    data.messages.forEach((m) => body.appendChild(msgBubble(m)));
    scrollBottom(body);

    // Jump to the other person's profile from the chat header (photo or name).
    thread.querySelectorAll('[data-headprofile]').forEach((x) => (x.onclick = () => go('profile', u.id)));

    const back = document.getElementById('backToList');
    back.style.display = window.innerWidth <= 980 ? 'inline-flex' : 'none';
    back.onclick = () => messenger.classList.remove('show-thread');

    const input = document.getElementById('msgInput');
    const send = async () => {
      const content = input.value.trim();
      if (!content) return;
      input.value = '';
      try { await Chat.send(userId, content); } catch (e) { toast(e.message); }
    };
    document.getElementById('msgSend').onclick = send;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    input.focus();
    refreshBadges();
  }

  function msgBubble(m) {
    return el('<div class="bubble-msg' + (m.mine ? ' mine' : '') + '">' + linkify(esc(m.content)) + '<div class="bt">' + timeAgo(m.created_at) + '</div></div>');
  }

  /* ============================ notifications ============================ */

  function notifText(type) {
    switch (type) {
      case 'like': return ' liked your post';
      case 'reaction': return ' reacted to your post';
      case 'comment': return ' commented on your post';
      case 'friend_request': return ' sent you a friend request';
      case 'friend_accept': return ' accepted your friend request';
      case 'follow': return ' started following you';
      case 'escrow_update': return ' updated a protected order';
      case 'mod_removed': return ' (a moderator) removed your content';
      case 'mod_restored': return ' (a moderator) restored your content';
      case 'jury_duty': return ': you were picked for a community jury';
      default: return ' interacted with you';
    }
  }

  function notifRow(n) {
    const row = el(
      '<div class="notif' + (n.is_read ? '' : ' unread') + '">' + avatar(n.actor, 44) +
      '<div class="nt"><div><b>' + esc(n.actor.name) + '</b>' + notifText(n.type) + '</div>' +
      '<div class="tm">' + timeAgo(n.created_at) + '</div></div></div>'
    );
    row.onclick = () => {
      document.getElementById('notifDropdown').classList.add('hidden');
      if (n.type === 'escrow_update') openMyOrders();
      else if (n.type === 'friend_request' || n.type === 'friend_accept' || n.type === 'follow') go('profile', n.actor.id);
      else go('profile', ME.id);
    };
    return row;
  }

  async function toggleNotifs(e) {
    e.stopPropagation();
    const dd = document.getElementById('notifDropdown');
    if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
    dd.classList.remove('hidden');
    const list = document.getElementById('notifList');
    list.innerHTML = '<div class="empty">Loading...</div>';
    try {
      const r = await API.notifications();
      if (!r.notifications.length) list.innerHTML = '<div class="empty">No notifications yet.</div>';
      else { list.innerHTML = ''; r.notifications.forEach((n) => list.appendChild(notifRow(n))); }
      await API.markNotifsRead();
      setBadge('notifBadge', 0);
    } catch (err) {
      list.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    }
  }

  /* ============================ marketplace ============================ */

  function money(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  const MARKET_CATEGORIES = ['All', 'General', 'Electronics', 'Furniture', 'Clothing', 'Vehicles', 'Property', 'Hobbies', 'Free'];
  const COND_LABELS = { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair', parts: 'For parts' };
  const DELIV_LABELS = { shipping: 'Shipping', pickup: 'Local pickup', both: 'Shipping or pickup' };
  const marketState = { q: '', category: 'All', condition: 'All', location: '', minPrice: '', maxPrice: '' };

  async function renderMarketplace() {
    view.innerHTML =
      '<div class="card"><div class="mk-head">' +
      '<div class="section-title" style="flex:1;margin:0">Marketplace</div>' +
      '<button class="btn btn-sm" id="ordersBtn">&#128230; My orders</button>' +
      (ME && ME.isAdmin ? '<button class="btn btn-sm" id="dispBtn">Disputes</button>' : '') +
      '<button class="btn btn-primary btn-sm" id="sellBtn">&#10010; Sell something</button></div>' +
      '<input class="input" id="mkSearch" placeholder="Search marketplace" value="' + esc(marketState.q) + '" style="margin-top:10px">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
        '<select class="input" id="mkCond" style="max-width:150px"><option value="All">Any condition</option>' +
          Object.keys(COND_LABELS).map((k) => '<option value="' + k + '"' + (marketState.condition === k ? ' selected' : '') + '>' + COND_LABELS[k] + '</option>').join('') + '</select>' +
        '<input class="input" id="mkLoc" placeholder="Location" value="' + esc(marketState.location) + '" style="max-width:150px">' +
        '<input class="input" id="mkMin" type="number" min="0" placeholder="Min $" value="' + esc(marketState.minPrice) + '" style="max-width:100px">' +
        '<input class="input" id="mkMax" type="number" min="0" placeholder="Max $" value="' + esc(marketState.maxPrice) + '" style="max-width:100px">' +
      '</div>' +
      '<div class="chips" id="mkChips"></div></div>' +
      '<div id="mkGrid" class="mk-grid"><div class="empty">Loading...</div></div>';
    const chips = document.getElementById('mkChips');
    MARKET_CATEGORIES.forEach((c) => {
      const chip = el('<button class="chip' + (marketState.category === c ? ' active' : '') + '">' + esc(c) + '</button>');
      chip.onclick = () => {
        marketState.category = c;
        chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        chip.classList.add('active');
        loadListings();
      };
      chips.appendChild(chip);
    });
    document.getElementById('sellBtn').onclick = openSellModal;
    const ordersBtn = document.getElementById('ordersBtn');
    if (ordersBtn) ordersBtn.onclick = openMyOrders;
    const dispBtn = document.getElementById('dispBtn');
    if (dispBtn) dispBtn.onclick = openEscrowDisputes;
    const search = document.getElementById('mkSearch');
    let to;
    search.addEventListener('input', () => { clearTimeout(to); marketState.q = search.value.trim(); to = setTimeout(loadListings, 300); });
    const cond = document.getElementById('mkCond');
    if (cond) cond.onchange = () => { marketState.condition = cond.value; loadListings(); };
    const locF = document.getElementById('mkLoc');
    if (locF) locF.addEventListener('input', () => { clearTimeout(to); marketState.location = locF.value.trim(); to = setTimeout(loadListings, 350); });
    const minF = document.getElementById('mkMin');
    if (minF) minF.addEventListener('input', () => { clearTimeout(to); marketState.minPrice = minF.value; to = setTimeout(loadListings, 400); });
    const maxF = document.getElementById('mkMax');
    if (maxF) maxF.addEventListener('input', () => { clearTimeout(to); marketState.maxPrice = maxF.value; to = setTimeout(loadListings, 400); });
    loadListings();
    renderRightRail();
  }

  async function loadListings() {
    const grid = document.getElementById('mkGrid');
    if (!grid) return;
    try {
      const r = await API.listings(marketState.q, marketState.category, { condition: marketState.condition, location: marketState.location, minPrice: marketState.minPrice, maxPrice: marketState.maxPrice });
      if (!r.listings.length) { grid.innerHTML = '<div class="card"><div class="empty">No items here yet. Be the first to list something.</div></div>'; return; }
      grid.innerHTML = '';
      r.listings.forEach((l) => grid.appendChild(listingCard(l)));
    } catch (e) { grid.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; }
  }

  function listingCard(l) {
    const card = el(
      '<div class="mk-card">' +
      '<div class="mk-photo">' + (l.image ? '<img src="' + esc(l.image) + '" alt="">' : '<div class="mk-noimg">&#128247;</div>') +
      (l.status === 'sold' ? '<div class="mk-sold">SOLD</div>' : '') + '</div>' +
      '<div class="mk-info"><div class="mk-price">' + money(l.price) + '</div>' +
      '<div class="mk-title">' + esc(l.title) + '</div>' +
      '<div class="mk-loc">' + (l.location ? esc(l.location) : esc(l.category)) + (l.condition ? ' &#183; ' + esc(COND_LABELS[l.condition] || l.condition) : '') + '</div></div></div>'
    );
    card.onclick = () => openListing(l.id);
    return card;
  }

  async function openListing(id) {
    let data;
    try { data = await API.listing(id); } catch (e) { toast(e.message); return; }
    const l = data.listing;
    const firstName = (l.seller.name || '').split(' ')[0];
    const m = modal(
      '<div class="mh"><h3>Item</h3></div><div class="mc">' +
      (l.image ? '<img src="' + esc(l.image) + '" style="width:100%;border-radius:10px;max-height:340px;object-fit:cover;margin-bottom:12px">' : '') +
      '<div class="mk-price" style="font-size:24px">' + money(l.price) + (l.status === 'sold' ? ' <span class="pill">Sold</span>' : '') + '</div>' +
      '<div style="font-size:18px;font-weight:700;margin:4px 0">' + esc(l.title) + '</div>' +
      '<div class="pmeta" style="margin-bottom:8px">' + esc(l.category) + (l.location ? ' &#183; ' + esc(l.location) : '') + (l.condition ? ' &#183; ' + esc(COND_LABELS[l.condition] || l.condition) : '') + (l.delivery ? ' &#183; ' + esc(DELIV_LABELS[l.delivery] || l.delivery) : '') + '</div>' +
      (l.description ? '<div style="white-space:pre-wrap;margin-bottom:12px">' + linkify(esc(l.description)) + '</div>' : '') +
      '<div class="contact" style="padding:0;margin-bottom:14px">' + avatar(l.seller, 36) + '<span class="nm">' + esc(l.seller.name) + '</span></div>' +
      (l.isMine
        ? '<button class="btn btn-block" id="mkSold">' + (l.status === 'sold' ? 'Mark available' : 'Mark as sold') + '</button>' +
          '<button class="btn btn-danger btn-block" id="mkDel" style="margin-top:8px">Delete listing</button>'
        : (l.status !== 'sold' && Number(l.price) > 0
            ? '<button class="btn btn-primary btn-block" id="mkBuy">&#128274; Buy with escrow protection</button>' +
              '<button class="btn btn-block" id="mkMsg" style="margin-top:8px">Message ' + esc(firstName) + '</button>'
            : '<button class="btn btn-primary btn-block" id="mkMsg">Message ' + esc(firstName) + '</button>') +
          '<button class="btn btn-block" id="mkSeller" style="margin-top:8px">View seller profile</button>') +
      '</div>'
    );
    if (l.isMine) {
      m.q('#mkSold').onclick = async () => { try { await API.toggleSold(l.id); m.close(); toast('Updated'); if (currentView === 'marketplace') loadListings(); } catch (e) { toast(e.message); } };
      m.q('#mkDel').onclick = async () => { if (!window.confirm('Delete this listing?')) return; try { await API.deleteListing(l.id); m.close(); toast('Listing deleted'); if (currentView === 'marketplace') loadListings(); } catch (e) { toast(e.message); } };
    } else {
      if (m.q('#mkBuy')) m.q('#mkBuy').onclick = () => { m.close(); escrowBuyFlow(l); };
      m.q('#mkMsg').onclick = () => { m.close(); go('messages', l.seller.id); };
      m.q('#mkSeller').onclick = () => { m.close(); go('profile', l.seller.id); };
    }
  }

  function openSellModal() {
    const m = modal(
      '<div class="mh"><h3>List an item</h3></div><div class="mc">' +
      '<div class="field"><label>Title</label><input class="input" id="slTitle" placeholder="What are you selling?"></div>' +
      '<div class="field"><label>Price (USD)</label><input class="input" id="slPrice" type="number" min="0" step="0.01" placeholder="0"></div>' +
      '<div class="field"><label>Category</label><select class="input" id="slCat"></select></div>' +
      '<div class="field"><label>Condition</label><select class="input" id="slCond"><option value="">Not specified</option>' +
        Object.keys(COND_LABELS).map((k) => '<option value="' + k + '">' + COND_LABELS[k] + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Delivery</label><select class="input" id="slDeliv"><option value="">Not specified</option>' +
        Object.keys(DELIV_LABELS).map((k) => '<option value="' + k + '">' + DELIV_LABELS[k] + '</option>').join('') + '</select></div>' +
      '<div class="field"><label>Location (optional)</label><input class="input" id="slLoc" placeholder="City or area"></div>' +
      '<div class="field"><label>Description</label><textarea class="input" id="slDesc" rows="3" placeholder="Describe your item"></textarea></div>' +
      '<div class="field"><input type="file" id="slImg" accept="image/*" class="input"></div>' +
      '<div class="preview hidden" id="slPrev" style="margin-bottom:12px"></div>' +
      '<button class="btn btn-primary btn-block" id="slPost">Post listing</button></div>'
    );
    const sel = m.q('#slCat');
    MARKET_CATEGORIES.filter((c) => c !== 'All').forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    const img = m.q('#slImg');
    img.onchange = () => { const f = img.files[0]; if (f) { const u = URL.createObjectURL(f); const pv = m.q('#slPrev'); pv.innerHTML = '<img src="' + u + '" style="border-radius:10px;max-height:240px;width:100%;object-fit:cover">'; pv.classList.remove('hidden'); } };
    m.q('#slPost').onclick = async () => {
      const title = m.q('#slTitle').value.trim();
      if (!title) { toast('Add a title'); return; }
      const btn = m.q('#slPost'); btn.disabled = true; btn.textContent = 'Posting...';
      try {
        await API.createListing({ title, price: m.q('#slPrice').value || 0, category: sel.value, condition: m.q('#slCond').value, delivery: m.q('#slDeliv').value, location: m.q('#slLoc').value.trim(), description: m.q('#slDesc').value.trim() }, img.files[0]);
        m.close(); toast('Listing posted'); if (currentView === 'marketplace') loadListings();
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Post listing'; }
    };
  }

  /* ============================ marketplace escrow ============================ */

  var _escrowCfg = null;
  async function escrowCfg() {
    if (!_escrowCfg) { try { _escrowCfg = await API.escrowConfig(); } catch (e) { _escrowCfg = { live: false, feePct: 5 }; } }
    return _escrowCfg;
  }
  var ORDER_STATUS = {
    awaiting_funds: { label: 'Awaiting payment', cls: 'pill' },
    funds_held: { label: 'Held in escrow', cls: 'pill pill-ok' },
    shipped: { label: 'Shipped / handed over', cls: 'pill pill-ok' },
    completed: { label: 'Completed', cls: 'pill pill-ok' },
    disputed: { label: 'In dispute', cls: 'pill' },
    resolved_release: { label: 'Resolved: paid the seller', cls: 'pill pill-ok' },
    resolved_refund: { label: 'Resolved: refunded the buyer', cls: 'pill' },
    cancelled: { label: 'Cancelled', cls: 'pill' },
  };
  function orderPill(status) { var s = ORDER_STATUS[status] || { label: status, cls: 'pill' }; return '<span class="' + s.cls + '">' + esc(s.label) + '</span>'; }

  // Buy-with-protection confirm flow, opened from a listing.
  async function escrowBuyFlow(listing) {
    const cfg = await escrowCfg();
    const fee = Math.round(listing.price * (cfg.feePct / 100) * 100) / 100;
    const sellerGets = Math.round((listing.price - fee) * 100) / 100;
    const m = modal(
      '<div class="mh"><h3>&#128274; Buy with escrow protection</h3></div><div class="mc">' +
      '<div style="font-weight:700;font-size:16px;margin-bottom:2px">' + esc(listing.title) + '</div>' +
      '<div class="mk-price" style="font-size:22px">' + money(listing.price) + '</div>' +
      '<div class="shint" style="font-size:13px;line-height:1.6;margin:10px 0">OpenBook holds your payment safely and only releases it to the seller once <strong>you confirm you received the item and it is as described</strong>. If something goes wrong, you open a dispute and an OpenBook admin reviews the evidence from both sides and decides. This protects you both, whether it is shipped or handed over in person.</div>' +
      '<div style="background:var(--hover);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.7;margin-bottom:10px">' +
        'Item price <span style="float:right;font-weight:700">' + money(listing.price) + '</span><br>' +
        'Platform fee (' + cfg.feePct + '%) <span style="float:right;font-weight:700">' + money(fee) + '</span><br>' +
        'Seller receives <span style="float:right;font-weight:700">' + money(sellerGets) + '</span></div>' +
      (cfg.live
        ? '<div class="shint" style="font-size:12.5px;margin-bottom:10px">Payment is in <strong>USDT</strong>. After you confirm, you will be shown the escrow address to fund the order.</div>'
        : '<div class="modbanner modbanner-soft" style="font-size:12.5px;margin-bottom:10px;padding:8px 10px;border-radius:8px">Heads up: escrow payments are in <strong>preview</strong>. This sets up the protected order and the full flow, but <strong>no real money moves yet</strong> while we finalize the payment side.</div>') +
      '<button class="btn btn-primary btn-block" id="obfGo">Confirm and open protected order</button>' +
      '<div id="obfMsg" class="shint" style="font-size:12px;margin-top:8px"></div></div>'
    );
    m.q('#obfGo').onclick = async () => {
      const b = m.q('#obfGo'); b.disabled = true; b.textContent = 'Opening...';
      try { const r = await API.escrowBuy(listing.id); m.close(); toast('Protected order opened'); openOrder(r.order.id); }
      catch (e) { m.q('#obfMsg').textContent = e.message; b.disabled = false; b.textContent = 'Confirm and open protected order'; }
    };
  }

  // The order detail view: status, money breakdown, role + state actions, evidence
  // (both sides), and the event trail. Shared by buyer, seller, and admin.
  async function openOrder(id) {
    let data;
    try { data = await API.escrowOrder(id); } catch (e) { toast(e.message); return; }
    const o = data.order;
    const meAdmin = !!(ME && ME.isAdmin);
    const role = o.isBuyer ? 'You are the buyer' : (o.isSeller ? 'You are the seller' : (meAdmin ? 'Admin view' : ''));
    const other = o.isBuyer ? o.seller : o.buyer;

    let actions = '';
    if (o.isSeller && o.status === 'funds_held') actions += '<button class="btn btn-primary btn-block" data-act="shipped">Mark as shipped / handed over</button>';
    if (o.isBuyer && (o.status === 'funds_held' || o.status === 'shipped')) {
      actions += '<button class="btn btn-primary btn-block" data-act="received">I got it, all good &#8594; release to seller</button>' +
        '<button class="btn btn-block" data-act="dispute" style="margin-top:8px">Something is wrong, open a dispute</button>';
    }
    if ((o.isBuyer || o.isSeller) && o.status === 'funds_held') actions += '<button class="btn btn-block" data-act="cancel" style="margin-top:8px">Cancel this order</button>';
    if (meAdmin && o.status === 'disputed') {
      actions += '<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:10px">' +
        '<div class="shint" style="font-size:12.5px;margin-bottom:6px"><strong>Admin:</strong> review both sides’ evidence, then decide who keeps the money.</div>' +
        '<textarea class="input" id="ordResNote" rows="2" placeholder="Reason for your decision (shown on the order)"></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary" data-act="resolve-release" style="flex:1">Release to seller</button>' +
        '<button class="btn btn-danger" data-act="resolve-refund" style="flex:1">Refund buyer</button></div></div>';
    }

    const evHtml = (o.evidence || []).length
      ? o.evidence.map((e) => '<div style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:6px">' +
          '<div style="font-size:12px;font-weight:700">' + esc(e.role === 'seller' ? 'Seller' : 'Buyer') + ' &#183; ' + esc(e.kind) + '</div>' +
          (e.mediaUrl ? '<img src="' + esc(e.mediaUrl) + '" style="width:100%;border-radius:8px;max-height:240px;object-fit:cover;margin-top:6px">' : '') +
          (e.note ? '<div style="font-size:13px;margin-top:4px;white-space:pre-wrap">' + esc(e.note) + '</div>' : '') + '</div>').join('')
      : '<div class="shint" style="font-size:13px">No evidence added yet.</div>';
    const canAddEvidence = (o.isBuyer || o.isSeller) && ['funds_held', 'shipped', 'disputed'].includes(o.status);
    const trail = (o.events || []).map((e) => '<div style="font-size:12px;color:var(--text-soft);padding:2px 0">&#8226; ' + esc(e.event) + (e.detail ? ' — ' + esc(e.detail) : '') + ' <span style="opacity:.7">(' + timeAgo(e.created_at) + ')</span></div>').join('');

    const m = modal(
      '<div class="mh"><h3>Protected order</h3></div><div class="mc">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">' + orderPill(o.status) +
        (role ? '<span class="shint" style="font-size:12px">' + esc(role) + '</span>' : '') + (o.live ? '' : '<span class="pill">preview</span>') + '</div>' +
      '<div style="font-weight:700;font-size:16px">' + esc(o.title) + '</div>' +
      (other ? '<div class="contact" style="padding:6px 0">' + avatar(other, 30) + '<span class="nm">' + esc(other.name) + '</span></div>' : '') +
      '<div style="background:var(--hover);border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.7;margin:8px 0">' +
        'Amount <span style="float:right;font-weight:700">' + money(o.amount) + '</span><br>' +
        'Fee (' + o.feePct + '%) <span style="float:right;font-weight:700">' + money(o.feeAmount) + '</span><br>' +
        'Seller receives <span style="float:right;font-weight:700">' + money(o.sellerAmount) + '</span></div>' +
      (o.disputeReason ? '<div class="modbanner modbanner-soft" style="font-size:13px;padding:8px 10px;border-radius:8px;margin-bottom:8px"><strong>Dispute:</strong> ' + esc(o.disputeReason) + '</div>' : '') +
      (o.resolution ? '<div class="shint" style="font-size:13px;margin-bottom:8px"><strong>Outcome:</strong> ' + esc(o.resolution) + '</div>' : '') +
      (actions ? '<div style="margin:10px 0">' + actions + '</div>' : '') +
      '<div class="section-title" style="font-size:14px;margin:14px 0 6px">Evidence</div>' + evHtml +
      (canAddEvidence
        ? '<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px">' +
            '<select class="input" id="evKind" style="margin-bottom:6px">' +
              (o.isSeller ? '<option value="shipping">Proof of sending</option><option value="receipt">Receipt</option>' : '<option value="damage">Damage / problem</option><option value="photo">Photo of item</option>') +
              '<option value="other">Other</option></select>' +
            '<textarea class="input" id="evNote" rows="2" placeholder="Add a note (what this shows)" style="margin-bottom:6px"></textarea>' +
            '<input type="file" id="evImg" accept="image/*" class="input" style="margin-bottom:6px">' +
            '<button class="btn btn-sm btn-block" id="evAdd">Add evidence</button></div>'
        : '') +
      (trail ? '<div class="section-title" style="font-size:14px;margin:14px 0 6px">History</div>' + trail : '') +
      '</div>'
    );

    async function act(fn, confirmMsg) {
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      try { await fn(); m.close(); openOrder(id); } catch (e) { toast(e.message); }
    }
    m.node.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
      const a = b.getAttribute('data-act');
      if (a === 'shipped') act(() => API.escrowShipped(id, ''));
      else if (a === 'received') act(() => API.escrowReceived(id), 'Confirm you received the item and it is all good? This releases the payment to the seller.');
      else if (a === 'cancel') act(() => API.escrowCancel(id), 'Cancel this order?');
      else if (a === 'dispute') { const r = window.prompt('Briefly explain the problem (an admin will review both sides):'); if (r && r.trim()) act(() => API.escrowDispute(id, r.trim())); }
      else if (a === 'resolve-release') act(() => API.escrowResolve(id, 'release', (m.q('#ordResNote') || {}).value || ''), 'Release the funds to the SELLER?');
      else if (a === 'resolve-refund') act(() => API.escrowResolve(id, 'refund', (m.q('#ordResNote') || {}).value || ''), 'Refund the BUYER?');
    }));
    const evAdd = m.q('#evAdd');
    if (evAdd) evAdd.onclick = async () => {
      const kind = m.q('#evKind').value; const note = m.q('#evNote').value.trim(); const file = m.q('#evImg').files[0];
      if (!note && !file) { toast('Add a photo or a note'); return; }
      evAdd.disabled = true; evAdd.textContent = 'Adding...';
      try { await API.escrowEvidence(id, { kind, note }, file); m.close(); openOrder(id); } catch (e) { toast(e.message); evAdd.disabled = false; evAdd.textContent = 'Add evidence'; }
    };
  }

  async function openMyOrders() {
    const m = modal('<div class="mh"><h3>My protected orders</h3></div><div class="mc" id="ordList"><div class="empty">Loading...</div></div>');
    try {
      const r = await API.escrowOrders();
      const list = m.q('#ordList');
      if (!r.orders.length) { list.innerHTML = '<div class="empty" style="padding:8px">No orders yet. Buy something with escrow protection and it shows up here.</div>'; return; }
      list.innerHTML = '';
      r.orders.forEach((o) => {
        const row = el('<div class="card" style="margin:0 0 8px;cursor:pointer"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-weight:600;flex:1;min-width:0">' + esc(o.title) + '</span><span style="font-weight:700">' + money(o.amount) + '</span></div>' +
          '<div style="margin-top:4px;display:flex;align-items:center;gap:8px">' + orderPill(o.status) + '<span class="shint" style="font-size:12px">' + (o.isBuyer ? 'buying' : 'selling') + '</span></div></div>');
        row.onclick = () => { m.close(); openOrder(o.id); };
        list.appendChild(row);
      });
    } catch (e) { m.q('#ordList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  async function openEscrowDisputes() {
    const m = modal('<div class="mh"><h3>Escrow disputes</h3></div><div class="mc" id="dispList"><div class="empty">Loading...</div></div>');
    try {
      const r = await API.escrowDisputes();
      const list = m.q('#dispList');
      if (!r.orders.length) { list.innerHTML = '<div class="empty" style="padding:8px">No open disputes.</div>'; return; }
      list.innerHTML = '';
      r.orders.forEach((o) => {
        const row = el('<div class="card" style="margin:0 0 8px;cursor:pointer"><div style="font-weight:600">' + esc(o.title) + ' &#183; ' + money(o.amount) + '</div>' +
          '<div class="shint" style="font-size:12.5px;margin-top:2px">' + esc((o.disputeReason || '').slice(0, 120)) + '</div></div>');
        row.onclick = () => { m.close(); openOrder(o.id); };
        list.appendChild(row);
      });
    } catch (e) { m.q('#dispList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  /* ============================ groups ============================ */

  async function renderGroups() {
    view.innerHTML =
      '<div class="card"><div class="mk-head"><div class="section-title" style="flex:1;margin:0">Groups</div>' +
      '<button class="btn btn-primary btn-sm" id="createGroupBtn">&#10010; Create group</button></div>' +
      '<div class="page-desc">Spaces you <strong>join to take part in</strong>, like Facebook groups. You join a group first, then you can post in it, and private groups are visible to members only. Looking for open spaces anyone can post in without joining? Those are <a href="#" id="descToComm">Communities</a>.</div></div>' +
      '<div class="card"><div class="section-title">Your groups</div><div id="myGroups" class="grp-grid"><div class="empty">Loading...</div></div></div>' +
      '<div class="card"><div class="section-title">Discover</div><div id="discoverGroups" class="grp-grid"><div class="empty">Loading...</div></div></div>';
    document.getElementById('createGroupBtn').onclick = openCreateGroup;
    var _dC = document.getElementById('descToComm'); if (_dC) _dC.onclick = function (e) { e.preventDefault(); go('communities'); };
    try {
      const r = await API.groups();
      const mine = document.getElementById('myGroups');
      const disc = document.getElementById('discoverGroups');
      if (!r.mine.length) mine.innerHTML = '<div class="empty">You have not joined any groups yet.</div>';
      else { mine.innerHTML = ''; r.mine.forEach((g) => mine.appendChild(groupCard(g))); }
      if (!r.discover.length) disc.innerHTML = '<div class="empty">No public groups to discover yet.</div>';
      else { disc.innerHTML = ''; r.discover.forEach((g) => disc.appendChild(groupCard(g))); }
    } catch (e) {}
    renderRightRail();
  }

  function groupCard(g) {
    const coverStyle = g.cover ? ' style="background-image:url(\'' + esc(g.cover) + '\')"' : '';
    const card = el(
      '<div class="grp-card"><div class="grp-cover"' + coverStyle + '></div>' +
      '<div class="grp-body"><div class="grp-name">' + esc(g.name) + '</div>' +
      '<div class="pmeta">' + (g.privacy === 'private' ? 'Private' : 'Public') + ' &#183; ' + g.memberCount + ' member' + (g.memberCount === 1 ? '' : 's') + '</div>' +
      '<div class="grp-act"></div></div></div>'
    );
    const act = card.querySelector('.grp-act');
    if (g.isMember) {
      const b = el('<button class="btn btn-soft btn-sm btn-block">Open</button>'); b.onclick = () => go('group', g.id); act.appendChild(b);
    } else {
      const b = el('<button class="btn btn-primary btn-sm btn-block">Join</button>');
      b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await API.joinGroup(g.id); toast('Joined ' + g.name); go('group', g.id); } catch (err) { toast(err.message); b.disabled = false; } };
      act.appendChild(b);
    }
    card.querySelector('.grp-cover').onclick = () => go('group', g.id);
    card.querySelector('.grp-name').onclick = () => go('group', g.id);
    return card;
  }

  function openCreateGroup() {
    const m = modal(
      '<div class="mh"><h3>Create a group</h3></div><div class="mc">' +
      '<div class="field"><label>Group name</label><input class="input" id="cgName" placeholder="Name your group"></div>' +
      '<div class="field"><label>Description</label><textarea class="input" id="cgDesc" rows="2" placeholder="What is this group about?"></textarea></div>' +
      '<div class="field"><label>Privacy</label><select class="input" id="cgPriv"><option value="public">Public (anyone can see and join)</option><option value="private">Private (members only see posts)</option></select></div>' +
      '<div class="field"><label>Cover photo (optional)</label><input type="file" id="cgCover" accept="image/*" class="input"></div>' +
      '<button class="btn btn-primary btn-block" id="cgCreate">Create group</button></div>'
    );
    m.q('#cgCreate').onclick = async () => {
      const name = m.q('#cgName').value.trim();
      if (!name) { toast('Name your group'); return; }
      const btn = m.q('#cgCreate'); btn.disabled = true; btn.textContent = 'Creating...';
      try {
        const r = await API.createGroup({ name, description: m.q('#cgDesc').value.trim(), privacy: m.q('#cgPriv').value }, m.q('#cgCover').files[0]);
        m.close(); toast('Group created'); go('group', r.group.id);
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Create group'; }
    };
  }

  async function renderGroup(id) {
    view.innerHTML = '<div class="card card-pad-0"><div class="empty" style="padding:40px">Loading group...</div></div>';
    let data;
    try { data = await API.group(id); } catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const g = data.group;
    const coverStyle = g.cover ? ' style="background-image:url(\'' + esc(g.cover) + '\')"' : '';
    view.innerHTML =
      '<div class="card card-pad-0"><div class="grp-hero"' + coverStyle + '></div>' +
      '<div class="grp-hd"><div style="flex:1"><div class="pname">' + esc(g.name) + '</div>' +
      '<div class="pmeta">' + (g.privacy === 'private' ? 'Private group' : 'Public group') + ' &#183; ' + g.memberCount + ' member' + (g.memberCount === 1 ? '' : 's') + '</div>' +
      (g.description ? '<div style="margin-top:4px">' + esc(g.description) + '</div>' : '') + '</div>' +
      '<div class="grp-hd-act"></div></div></div>' +
      '<div id="grpComposer"></div>' +
      '<div id="grpPosts"><div class="card"><div class="empty">Loading posts...</div></div></div>';

    const act = view.querySelector('.grp-hd-act');
    if (g.isMember) {
      const open = el('<button class="btn btn-soft btn-sm">Members</button>'); open.onclick = () => openGroupMembers(g.id); act.appendChild(open);
      const leave = el('<button class="btn btn-sm">Leave</button>'); leave.onclick = async () => { if (!window.confirm('Leave this group?')) return; try { await API.leaveGroup(g.id); toast('Left group'); go('groups'); } catch (e) { toast(e.message); } }; act.appendChild(leave);
      if (g.role === 'admin') { const del = el('<button class="btn btn-danger btn-sm">Delete</button>'); del.onclick = async () => { if (!window.confirm('Delete this whole group?')) return; try { await API.deleteGroup(g.id); toast('Group deleted'); go('groups'); } catch (e) { toast(e.message); } }; act.appendChild(del); }
    } else {
      const join = el('<button class="btn btn-primary btn-sm">Join group</button>'); join.onclick = async () => { try { await API.joinGroup(g.id); toast('Joined'); renderGroup(g.id); } catch (e) { toast(e.message); } }; act.appendChild(join);
    }

    if (g.isMember) {
      const c = document.getElementById('grpComposer');
      c.innerHTML =
        '<div class="card composer"><div class="row">' + avatar(ME, 40) +
        '<textarea id="gpText" rows="1" placeholder="Write something to ' + esc(g.name) + '..."></textarea></div>' +
        '<div class="preview hidden" id="gpPrev"></div>' +
        '<div class="actions"><button class="icon-action" id="gpPhotoBtn">&#128247; Photo</button><span class="spacer"></span><button class="btn btn-primary btn-sm" id="gpPost">Post</button></div>' +
        '<input type="file" id="gpFile" accept="image/*" class="hidden"></div>';
      let file = null;
      const fileInput = document.getElementById('gpFile');
      const prev = document.getElementById('gpPrev');
      document.getElementById('gpPhotoBtn').onclick = () => fileInput.click();
      fileInput.onchange = () => { file = fileInput.files[0] || null; if (file) { const u = URL.createObjectURL(file); prev.innerHTML = '<img src="' + u + '" style="border-radius:10px;max-height:280px;width:100%;object-fit:cover">'; prev.classList.remove('hidden'); } };
      document.getElementById('gpPost').onclick = async () => {
        const content = document.getElementById('gpText').value.trim();
        if (!content && !file) { toast('Write something or add a photo'); return; }
        const btn = document.getElementById('gpPost'); btn.disabled = true; btn.textContent = 'Posting...';
        try {
          const r = await API.createGroupPost(g.id, content, file);
          const cont = document.getElementById('grpPosts');
          const empt = cont.querySelector('.empty');
          if (empt) cont.innerHTML = '';
          cont.prepend(renderPostNode(r.post));
          document.getElementById('gpText').value = ''; file = null; fileInput.value = ''; prev.classList.add('hidden'); prev.innerHTML = '';
        } catch (e) { toast(e.message); }
        btn.disabled = false; btn.textContent = 'Post';
      };
    }

    try {
      const r = await API.groupPosts(g.id);
      const emptyMsg = r.locked ? 'Join this private group to see its posts.' : 'No posts in this group yet.';
      renderPosts(document.getElementById('grpPosts'), r.posts, emptyMsg);
    } catch (e) {}
    renderRightRail();
  }

  function openGroupMembers(id) {
    const m = modal('<div class="mh"><h3>Members</h3></div><div class="mc" id="memList"><div class="empty">Loading...</div></div>');
    API.groupMembers(id).then((r) => {
      const list = m.q('#memList');
      list.innerHTML = '';
      r.members.forEach((u) => {
        const row = el('<div class="contact">' + avatar(u, 40) + '<span class="nm">' + esc(u.name) + (u.role === 'admin' ? ' <span class="pill">Admin</span>' : '') + '</span></div>');
        row.onclick = () => { m.close(); go('profile', u.id); };
        list.appendChild(row);
      });
    }).catch((e) => { m.q('#memList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  /* ============================ albums ============================ */

  async function loadProfileAlbums(user, isMe) {
    const box = document.getElementById('profileAlbums');
    if (!box) return;
    let data;
    try { data = await API.userAlbums(user.id); } catch (e) { return; }
    if (data.locked) { box.innerHTML = ''; return; }
    const albums = data.albums;
    if (!albums.length && !isMe) { box.innerHTML = ''; return; }
    let html =
      '<div class="card"><div class="mk-head"><div class="section-title" style="flex:1;margin:0">Albums</div>' +
      (isMe ? '<button class="btn btn-soft btn-sm" id="newAlbumBtn">&#10010; New album</button>' : '') + '</div>';
    if (!albums.length) html += '<div class="empty">No albums yet.</div>';
    else {
      html += '<div class="alb-grid">';
      albums.forEach((a) => {
        html += '<div class="alb-card" data-album="' + a.id + '"><div class="alb-cover"' + (a.cover ? ' style="background-image:url(\'' + esc(a.cover) + '\')"' : '') + '></div>' +
          '<div class="alb-info"><div class="alb-title">' + esc(a.title) + '</div><div class="pmeta">' + a.photoCount + ' photo' + (a.photoCount === 1 ? '' : 's') + '</div></div></div>';
      });
      html += '</div>';
    }
    html += '</div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-album]').forEach((c) => (c.onclick = () => go('album', Number(c.getAttribute('data-album')))));
    const nb = document.getElementById('newAlbumBtn');
    if (nb) nb.onclick = () => openCreateAlbum(user.id);
  }

  function openCreateAlbum() {
    const m = modal('<div class="mh"><h3>New album</h3></div><div class="mc"><div class="field"><label>Album title</label><input class="input" id="abTitle" placeholder="e.g. Summer 2026"></div><button class="btn btn-primary btn-block" id="abCreate">Create album</button></div>');
    m.q('#abCreate').onclick = async () => {
      const title = m.q('#abTitle').value.trim();
      if (!title) { toast('Give the album a title'); return; }
      try { const r = await API.createAlbum(title); m.close(); toast('Album created'); go('album', r.album.id); } catch (e) { toast(e.message); }
    };
  }

  async function renderAlbum(id) {
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading album...</div></div>';
    let data;
    try { data = await API.album(id); } catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const a = data.album;
    view.innerHTML =
      '<div class="card"><div class="mk-head"><button class="btn btn-ghost btn-sm" id="albBack">&#8592;</button>' +
      '<div style="flex:1"><div class="section-title" style="margin:0">' + esc(a.title) + '</div><div class="pmeta">by ' + esc(a.owner.name) + '</div></div>' +
      (a.isMine ? '<button class="btn btn-primary btn-sm" id="albAdd">&#10010; Add photo</button>' : '') + '</div></div>' +
      '<div id="albGrid" class="ph-grid"></div>';
    document.getElementById('albBack').onclick = () => go('profile', a.owner.id);
    const grid = document.getElementById('albGrid');
    if (!data.photos.length) grid.innerHTML = '<div class="card"><div class="empty">No photos in this album yet.</div></div>';
    else {
      grid.innerHTML = '';
      data.photos.forEach((p) => {
        const ph = el('<div class="ph-item"><img src="' + esc(p.image) + '" alt="">' + (p.caption ? '<div class="ph-cap">' + esc(p.caption) + '</div>' : '') + '</div>');
        ph.querySelector('img').onclick = () => openPhoto(p);
        grid.appendChild(ph);
      });
    }
    if (a.isMine) document.getElementById('albAdd').onclick = () => addAlbumPhoto(a.id);
    renderRightRail();
  }

  function addAlbumPhoto(albumId) {
    pickImage(async (file) => {
      try { await API.addAlbumPhoto(albumId, file, ''); toast('Photo added'); renderAlbum(albumId); } catch (e) { toast(e.message); }
    });
  }

  function openPhoto(p) {
    const back = el('<div class="story-view-back"><div class="story-view"><button class="sv-close">&times;</button><img alt="">' + (p.caption ? '<div class="sv-cap"></div>' : '') + '</div></div>');
    document.getElementById('modalRoot').appendChild(back);
    back.querySelector('img').src = p.image;
    if (p.caption) back.querySelector('.sv-cap').textContent = p.caption;
    const close = () => back.remove();
    back.querySelector('.sv-close').onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
  }

  /* ============================ communities + voting ============================ */

  function voteControl(targetType, targetId, score, myVote, inline) {
    const box = el('<div class="votebox' + (inline ? ' inline' : '') + '"><button class="vote up" title="Upvote">&#9650;</button><span class="vscore"></span><button class="vote down" title="Downvote">&#9660;</button></div>');
    const up = box.querySelector('.up');
    const down = box.querySelector('.down');
    const sc = box.querySelector('.vscore');
    let s = score;
    let mv = myVote;
    function paint() {
      sc.textContent = s;
      up.classList.toggle('on', mv === 1);
      down.classList.toggle('on', mv === -1);
      sc.classList.remove('pos', 'neg');
      if (s > 0) sc.classList.add('pos'); else if (s < 0) sc.classList.add('neg');
    }
    async function cast(v) {
      try { const r = await API.vote(targetType, targetId, v); s = r.score; mv = r.myVote; paint(); }
      catch (e) { toast(e.message); }
    }
    up.onclick = (e) => { e.stopPropagation(); cast(1); };
    down.onclick = (e) => { e.stopPropagation(); cast(-1); };
    paint();
    return box;
  }

  function communityIcon(c, size) {
    size = size || 44;
    const dim = 'width:' + size + 'px;height:' + size + 'px;';
    if (c.icon) return '<img class="avatar" style="' + dim + '" src="' + esc(c.icon) + '" alt="">';
    const initial = ((c.name || '?').charAt(0) || '?');
    const fs = Math.round(size * 0.5);
    return '<span class="avatar-fallback" style="' + dim + 'background:' + colorFor(c.name || '?') + ';font-size:' + fs + 'px">' + esc(initial) + '</span>';
  }

  async function renderCommunities() {
    view.innerHTML =
      '<div class="card"><div class="mk-head"><div class="section-title" style="flex:1;margin:0">Communities</div>' +
      '<button class="btn btn-primary btn-sm" id="createCommBtn">&#10010; Create community</button></div>' +
      '<div class="page-desc">Open spaces built around a topic, like subreddits. <strong>Subscribe to follow</strong> a public community in your home feed, but you can post and comment in any public one without joining. Looking for member-only spaces you join first? Those are <a href="#" id="descToGroups">Groups</a>.</div></div>' +
      '<div class="card"><div class="section-title">Your communities</div><div id="subComm" class="grp-grid"><div class="empty">Loading...</div></div></div>' +
      '<div class="card"><div class="section-title">Discover</div><div id="discComm" class="grp-grid"><div class="empty">Loading...</div></div></div>';
    document.getElementById('createCommBtn').onclick = openCreateCommunity;
    var _dG = document.getElementById('descToGroups'); if (_dG) _dG.onclick = function (e) { e.preventDefault(); go('groups'); };
    try {
      const r = await API.communities();
      const sub = document.getElementById('subComm');
      const disc = document.getElementById('discComm');
      if (!r.subscribed.length) sub.innerHTML = '<div class="empty">You have not joined any communities yet.</div>';
      else { sub.innerHTML = ''; r.subscribed.forEach((c) => sub.appendChild(communityCard(c))); }
      if (!r.discover.length) disc.innerHTML = '<div class="empty">No public communities to discover yet.</div>';
      else { disc.innerHTML = ''; r.discover.forEach((c) => disc.appendChild(communityCard(c))); }
    } catch (e) {}
    renderRightRail();
  }

  function communityCard(c) {
    const card = el(
      '<div class="grp-card"><div class="comm-row">' + communityIcon(c, 44) +
      '<div style="flex:1;min-width:0"><div class="grp-name">o/' + esc(c.name) + '</div>' +
      '<div class="pmeta">' + (c.privacy === 'private' ? 'Private' : 'Public') + ' &#183; ' + c.memberCount + ' member' + (c.memberCount === 1 ? '' : 's') + '</div></div></div>' +
      '<div class="grp-act"></div></div>'
    );
    const act = card.querySelector('.grp-act');
    if (c.isMember) {
      const b = el('<button class="btn btn-soft btn-sm btn-block">Open</button>'); b.onclick = () => go('community', c.id); act.appendChild(b);
    } else {
      const b = el('<button class="btn btn-primary btn-sm btn-block">Join</button>');
      b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await API.joinCommunity(c.id); toast('Joined o/' + c.name); go('community', c.id); } catch (err) { toast(err.message); b.disabled = false; } };
      act.appendChild(b);
    }
    card.querySelector('.comm-row').onclick = () => go('community', c.id);
    return card;
  }

  function openCreateCommunity() {
    const m = modal(
      '<div class="mh"><h3>Create a community</h3></div><div class="mc">' +
      '<div class="field"><label>Name (the o/ handle)</label><input class="input" id="ccName" placeholder="e.g. danang_food" maxlength="21">' +
      '<div class="pmeta" style="margin-top:4px">3 to 21 characters: lowercase letters, numbers, underscores</div></div>' +
      '<div class="field"><label>Description</label><textarea class="input" id="ccDesc" rows="2" placeholder="What is this community about?"></textarea></div>' +
      '<div class="field"><label>Rules (optional)</label><textarea class="input" id="ccRules" rows="2" placeholder="Community rules"></textarea></div>' +
      '<div class="field"><label>Privacy</label><select class="input" id="ccPriv"><option value="public">Public (anyone can view and post)</option><option value="private">Private (members only)</option></select></div>' +
      '<div class="field"><label>Icon (optional)</label><input type="file" id="ccIcon" accept="image/*" class="input"></div>' +
      '<button class="btn btn-primary btn-block" id="ccCreate">Create community</button></div>'
    );
    m.q('#ccCreate').onclick = async () => {
      const name = m.q('#ccName').value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,21}$/.test(name)) { toast('Name must be 3 to 21 chars: lowercase letters, numbers, underscores'); return; }
      const btn = m.q('#ccCreate'); btn.disabled = true; btn.textContent = 'Creating...';
      try {
        const r = await API.createCommunity({ name, description: m.q('#ccDesc').value.trim(), rules: m.q('#ccRules').value.trim(), privacy: m.q('#ccPriv').value }, m.q('#ccIcon').files[0]);
        m.close(); toast('Community created'); go('community', r.community.id);
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Create community'; }
    };
  }

  let communitySort = 'hot';
  let communityWindow = 'all';
  let commentSort = 'best';
  let feedMode = 'latest';
  let postMod = false;   // can the current viewer moderate the open post's thread (mod/admin)
  let postOwner = false; // is the current viewer the owner of the open post
  let pendingReel = null; // a reel id from a shared deep link (/app#reel=<id>) to scroll to

  async function renderCommunity(id) {
    view.innerHTML = '<div class="card card-pad-0"><div class="empty" style="padding:40px">Loading community...</div></div>';
    let data;
    try { data = await API.community(id); } catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const c = data.community;
    view.innerHTML =
      '<div class="card card-pad-0"><div class="comm-hero"></div>' +
      '<div class="comm-hd">' + communityIcon(c, 72) + '<div style="flex:1;min-width:0"><div class="pname">o/' + esc(c.name) + '</div>' +
      '<div class="pmeta">' + (c.privacy === 'private' ? 'Private community' : 'Public community') + ' &#183; ' + c.memberCount + ' member' + (c.memberCount === 1 ? '' : 's') + '</div>' +
      (c.description ? '<div style="margin-top:4px">' + esc(c.description) + '</div>' : '') + '</div>' +
      '<div class="comm-act"></div></div></div>' +
      (c.rules ? '<div class="card"><div class="section-title">Rules</div><div style="white-space:pre-wrap">' + esc(c.rules) + '</div></div>' : '') +
      '<div class="card"><div class="mk-head"><div class="tabs">' +
        '<button class="tab" data-sort="hot">Hot</button>' +
        '<button class="tab" data-sort="new">New</button>' +
        '<button class="tab" data-sort="top">Top</button>' +
        '<button class="tab" data-sort="controversial">Controversial</button>' +
      '</div>' +
      '<select class="input hidden" id="commWindow" style="width:auto;margin-left:8px;padding:4px 8px">' +
        '<option value="all">All time</option><option value="week">This week</option><option value="day">Today</option>' +
      '</select>' +
      '<span style="flex:1"></span><button class="btn btn-primary btn-sm" id="newCommPost">&#10010; Create post</button></div></div>' +
      '<div id="commPosts"><div class="card"><div class="empty">Loading posts...</div></div></div>';

    const act = view.querySelector('.comm-act');
    if (c.isMember) {
      const mem = el('<button class="btn btn-soft btn-sm">Members</button>'); mem.onclick = () => openCommunityMembers(c.id, c.role === 'mod' || ME.isAdmin); act.appendChild(mem);
      const leave = el('<button class="btn btn-sm">Leave</button>'); leave.onclick = async () => { try { await API.leaveCommunity(c.id); toast('Left o/' + c.name); renderCommunity(c.id); } catch (e) { toast(e.message); } }; act.appendChild(leave);
      if (c.role === 'mod') { const del = el('<button class="btn btn-danger btn-sm">Delete</button>'); del.onclick = async () => { if (!window.confirm('Delete this community and all its posts?')) return; try { await API.deleteCommunity(c.id); toast('Community deleted'); go('communities'); } catch (e) { toast(e.message); } }; act.appendChild(del); }
    } else {
      const join = el('<button class="btn btn-primary btn-sm">Join</button>'); join.onclick = async () => { try { await API.joinCommunity(c.id); toast('Joined'); renderCommunity(c.id); } catch (e) { toast(e.message); } }; act.appendChild(join);
    }
    // Transparency: anyone can read the public mod log. Mods/admins get the queue.
    const isMod = c.role === 'mod' || ME.isAdmin;
    const mlog = el('<button class="btn btn-soft btn-sm">Mod log</button>'); mlog.onclick = () => openModLog(c.id); act.appendChild(mlog);
    if (isMod) { const rq = el('<button class="btn btn-soft btn-sm">Reports</button>'); rq.onclick = () => openReportsQueue(); act.appendChild(rq); }
    document.getElementById('newCommPost').onclick = () => openCommunityPostModal(c);
    const winSel = document.getElementById('commWindow');
    function syncSortUI() {
      view.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-sort') === communitySort));
      winSel.classList.toggle('hidden', communitySort !== 'top');
    }
    view.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => { communitySort = t.getAttribute('data-sort'); syncSortUI(); loadCommunityPosts(c); };
    });
    winSel.value = communityWindow;
    winSel.onchange = () => { communityWindow = winSel.value; loadCommunityPosts(c); };
    syncSortUI();
    loadCommunityPosts(c);
    renderRightRail();
  }

  async function loadCommunityPosts(c) {
    const cont = document.getElementById('commPosts');
    if (!cont) return;
    try {
      const r = await API.communityPosts(c.id, communitySort, communityWindow);
      if (r.locked) { cont.innerHTML = '<div class="card"><div class="empty">Join this private community to see its posts.</div></div>'; return; }
      if (!r.posts.length) { cont.innerHTML = '<div class="card"><div class="empty">No posts yet. Be the first to post.</div></div>'; return; }
      cont.innerHTML = '';
      r.posts.forEach((p) => cont.appendChild(communityPostCard(p)));
    } catch (e) { cont.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; }
  }

  function communityPostCard(p) {
    const card = el('<div class="card cpost"></div>');
    const vc = voteControl('post', p.id, p.score, p.myVote);
    const body = el('<div class="cpost-body"></div>');
    const thumb = p.image ? '<div class="cpost-thumb"><img src="' + esc(p.image) + '" alt=""></div>' : '';
    body.innerHTML =
      '<div class="cpost-title">' + esc(p.title || (p.content || '').slice(0, 120)) + '</div>' +
      (p.type === 'link' && p.url ? '<a class="cpost-link" href="' + esc(safeHref(p.url)) + '" target="_blank" rel="noopener">' + esc(p.url) + '</a>' : '') +
      (p.content && p.type !== 'link' ? '<div class="cpost-snippet">' + esc((p.content || '').slice(0, 160)) + ((p.content || '').length > 160 ? '...' : '') + '</div>' : '') +
      thumb +
      '<div class="cpost-meta">' + (p.community ? 'o/' + esc(p.community.name) + ' &#183; ' : '') + 'by ' + esc(p.author.name) + verifTick(p.author) + ' &#183; ' + timeAgo(p.created_at) + ' &#183; &#128172; ' + p.commentCount + '</div>';
    card.appendChild(vc);
    card.appendChild(body);
    body.onclick = (e) => { if (e.target.tagName !== 'A') go('post', p.id); };
    return card;
  }

  function openCommunityPostModal(c) {
    const m = modal(
      '<div class="mh"><h3>Post to o/' + esc(c.name) + '</h3></div><div class="mc">' +
      '<div class="field"><label>Title</label><input class="input" id="cpTitle" placeholder="Title"></div>' +
      '<div class="field"><label>Type</label><select class="input" id="cpType"><option value="text">Text</option><option value="link">Link</option><option value="image">Image</option></select></div>' +
      '<div class="field" id="cpTextField"><label>Text (optional)</label><textarea class="input" id="cpContent" rows="4" placeholder="Your text"></textarea></div>' +
      '<div class="field hidden" id="cpLinkField"><label>Link URL</label><input class="input" id="cpUrl" placeholder="https://..."></div>' +
      '<div class="field hidden" id="cpImgField"><label>Image</label><input type="file" id="cpImg" accept="image/*" class="input"></div>' +
      '<button class="btn btn-primary btn-block" id="cpSubmit">Post</button></div>'
    );
    const type = m.q('#cpType');
    type.onchange = () => {
      const t = type.value;
      m.q('#cpTextField').classList.toggle('hidden', t === 'link');
      m.q('#cpLinkField').classList.toggle('hidden', t !== 'link');
      m.q('#cpImgField').classList.toggle('hidden', t !== 'image');
    };
    m.q('#cpSubmit').onclick = async () => {
      const title = m.q('#cpTitle').value.trim();
      if (!title) { toast('Add a title'); return; }
      const t = type.value;
      const fields = { title, type: t, content: m.q('#cpContent').value.trim(), url: t === 'link' ? m.q('#cpUrl').value.trim() : '' };
      const file = t === 'image' ? m.q('#cpImg').files[0] : null;
      if (t === 'link' && !fields.url) { toast('Add a link URL'); return; }
      if (t === 'image' && !file) { toast('Choose an image'); return; }
      const btn = m.q('#cpSubmit'); btn.disabled = true; btn.textContent = 'Posting...';
      try { await API.createCommunityPost(c.id, fields, file); m.close(); toast('Posted'); if (currentView === 'community') renderCommunity(c.id); }
      catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Post'; }
    };
  }

  function openCommunityMembers(id, isMod) {
    const m = modal('<div class="mh"><h3>Members</h3></div><div class="mc" id="cmemList"><div class="empty">Loading...</div></div>');
    API.communityMembers(id).then((r) => {
      const list = m.q('#cmemList');
      list.innerHTML = '';
      r.members.forEach((u) => {
        const row = el('<div class="contact" style="align-items:center">' +
          '<span class="nm" style="flex:1;cursor:pointer">' + esc(u.name) + (u.role === 'mod' ? ' <span class="pill">Mod</span>' : '') + '</span></div>');
        row.insertBefore(el(avatar(u, 40)), row.firstChild);
        row.querySelector('.nm').onclick = () => { m.close(); go('profile', u.id); };
        if (isMod && u.role !== 'mod' && u.id !== ME.id) {
          const ban = el('<button class="btn btn-danger btn-sm">Ban</button>');
          ban.onclick = async () => {
            const reason = window.prompt('Reason for banning ' + u.name + ' (optional):');
            if (reason === null) return;
            try { await API.communityBan(id, u.id, reason); toast('Banned ' + u.name); row.remove(); } catch (e) { toast(e.message); }
          };
          row.appendChild(ban);
        }
        list.appendChild(row);
      });
    }).catch((e) => { m.q('#cmemList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  async function renderPost(id) {
    // Reset mod state up front so a previous post's permissions can never leak
    // into this render (including the load-failure early return below).
    postMod = false;
    postOwner = false;
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading post...</div></div>';
    let data;
    try { data = await API.getPost(id); } catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const p = data.post;
    // Reflect this post's shareable link in the address bar (/p/<id>).
    try { window.history.replaceState({}, '', '/p/' + p.id); } catch (e) {}

    // Work out whether the viewer can moderate this thread (admin, or a mod of
    // its community). postOwner/postMod are also read by the comment tree.
    postOwner = p.author.id === ME.id;
    postMod = !!ME.isAdmin;
    if (!postMod && p.community) {
      try { const cd = await API.community(p.community.id); postMod = !!(cd.community && cd.community.role === 'mod'); } catch (e) {}
    }

    view.innerHTML = '';
    const back = el('<div class="card" style="padding:8px"><button class="btn btn-ghost btn-sm" id="postBack">&#8592; Back</button></div>');
    view.appendChild(back);

    const card = el('<div class="card cpost cpost-full"></div>');
    card.appendChild(voteControl('post', p.id, p.score, p.myVote));
    const pbody = el('<div class="cpost-body"></div>');
    pbody.innerHTML =
      '<div class="cpost-meta">' + (p.community ? '<b class="link" data-comm="' + p.community.id + '">o/' + esc(p.community.name) + '</b> &#183; ' : '') +
      'by <span class="link" data-profile="' + p.author.id + '">' + esc(p.author.name) + verifTick(p.author) + '</span> &#183; ' + timeAgo(p.created_at) +
      (p.edited ? ' &#183; <span class="edited-link" data-history>edited</span>' : '') + '</div>' +
      (p.removed ? '<div class="modbanner">This post was removed by a moderator.</div>' : '') +
      (p.locked ? '<div class="modbanner modbanner-soft">&#128274; Comments are locked.</div>' : '') +
      (p.title ? '<div class="cpost-title" style="font-size:22px;cursor:default">' + esc(p.title) + '</div>' : '') +
      (p.type === 'link' && p.url ? '<a href="' + esc(safeHref(p.url)) + '" target="_blank" rel="noopener">' + esc(p.url) + '</a>' : '') +
      (p.content ? '<div class="post-body">' + linkify(esc(p.content)) + '</div>' : '') +
      (p.image ? '<div class="post-image" style="margin:10px 0"><img src="' + esc(p.image) + '" alt="" style="border-radius:10px"></div>' : '') +
      '<div class="cpost-ops" id="postOps" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"></div>';
    card.appendChild(pbody);
    view.appendChild(card);

    // Build the action row: owner edit/delete, report (others), and mod controls.
    let opsHtml = '';
    if (postOwner) opsHtml += '<button class="btn btn-sm" data-editpost>Edit</button><button class="btn btn-danger btn-sm" data-delpost>Delete</button>';
    else opsHtml += '<button class="btn btn-sm" data-report="post" data-report-id="' + p.id + '">&#9873; Report</button>';
    opsHtml += '<button class="btn btn-sm" data-share-post="' + p.id + '" title="Share this post">&#128279; Share</button>';
    if (postMod) {
      opsHtml += p.removed
        ? '<button class="btn btn-sm" data-modrestore>Restore</button>'
        : '<button class="btn btn-danger btn-sm" data-modremove>Remove</button>';
      opsHtml += '<button class="btn btn-sm" data-modlock>' + (p.locked ? 'Unlock' : 'Lock') + '</button>';
      if (p.community) opsHtml += '<button class="btn btn-sm" data-modpin>' + (p.pinned ? 'Unpin' : 'Pin') + '</button>';
    }
    // Founder/admin: pin this post as an official site announcement (transparent).
    if (ME.isAdmin || ME.founder) {
      opsHtml += '<button class="btn btn-sm" data-modannounce>' + (p.announcement ? 'Remove announcement' : '&#128204; Pin as announcement') + '</button>';
    }
    if (postOwner && p.removed) opsHtml += '<button class="btn btn-sm" data-appeal data-appeal-type="post" data-appeal-id="' + p.id + '">Appeal</button>';
    pbody.querySelector('#postOps').innerHTML = opsHtml;
    const mrm = pbody.querySelector('[data-modremove]');
    if (mrm) mrm.onclick = async () => { if (!window.confirm('Remove this post?')) return; try { await API.modRemove('post', p.id, ''); toast('Removed'); renderPost(p.id); } catch (e) { toast(e.message); } };
    const mrs = pbody.querySelector('[data-modrestore]');
    if (mrs) mrs.onclick = async () => { try { await API.modRestore('post', p.id); toast('Restored'); renderPost(p.id); } catch (e) { toast(e.message); } };
    const mlk = pbody.querySelector('[data-modlock]');
    if (mlk) mlk.onclick = async () => { try { const r = await API.modLock(p.id, !p.locked); toast(r.locked ? 'Locked' : 'Unlocked'); renderPost(p.id); } catch (e) { toast(e.message); } };
    const mpn = pbody.querySelector('[data-modpin]');
    if (mpn) mpn.onclick = async () => { try { const r = await API.modPin(p.id, !p.pinned); toast(r.pinned ? 'Pinned' : 'Unpinned'); renderPost(p.id); } catch (e) { toast(e.message); } };
    const man = pbody.querySelector('[data-modannounce]');
    if (man) man.onclick = async () => { try { const r = await API.modAnnounce(p.id, !p.announcement); toast(r.announcement ? 'Pinned as an announcement' : 'Announcement removed'); renderPost(p.id); } catch (e) { toast(e.message); } };

    const csec = el('<div class="card"><div class="mk-head" style="margin-bottom:6px">' +
      '<div class="section-title" style="margin:0">Comments</div><span style="flex:1"></span>' +
      '<select class="input" id="commentSortSel" style="width:auto;padding:4px 8px">' +
        '<option value="best">Best</option><option value="new">New</option>' +
        '<option value="top">Top</option><option value="controversial">Controversial</option>' +
      '</select></div>' +
      '<div class="comment-form" id="rootCommentForm"></div>' +
      '<div id="commentTree"><div class="empty" style="padding:8px">Loading comments...</div></div></div>');
    view.appendChild(csec);

    const csortSel = document.getElementById('commentSortSel');
    csortSel.value = commentSort;
    csortSel.onchange = () => { commentSort = csortSel.value; loadCommentTree(p.id); };

    document.getElementById('postBack').onclick = () => { if (p.community) go('community', p.community.id); else go('feed'); };
    pbody.querySelectorAll('[data-profile]').forEach((x) => (x.onclick = () => go('profile', Number(x.getAttribute('data-profile')))));
    const cm = pbody.querySelector('[data-comm]');
    if (cm) cm.onclick = () => go('community', Number(cm.getAttribute('data-comm')));
    const dp = pbody.querySelector('[data-delpost]');
    if (dp) dp.onclick = async () => { if (!window.confirm('Delete this post?')) return; try { await API.deletePost(p.id); toast('Deleted'); if (p.community) go('community', p.community.id); else go('feed'); } catch (e) { toast(e.message); } };
    const ep = pbody.querySelector('[data-editpost]');
    if (ep) ep.onclick = () => editPostModal(p, () => renderPost(p.id));
    const hp = pbody.querySelector('[data-history]');
    if (hp) hp.onclick = () => openEditHistory(p.id);

    const rcf = document.getElementById('rootCommentForm');
    rcf.innerHTML = avatar(ME, 32) + '<input type="text" placeholder="Add a comment..."><button class="btn btn-soft btn-sm">Comment</button>';
    const rin = rcf.querySelector('input');
    const rsend = async () => { const content = rin.value.trim(); if (!content) return; rin.disabled = true; try { await API.addComment(p.id, content); rin.value = ''; loadCommentTree(p.id); } catch (e) { toast(e.message); } rin.disabled = false; };
    rcf.querySelector('button').onclick = rsend;
    rin.addEventListener('keydown', (e) => { if (e.key === 'Enter') rsend(); });

    loadCommentTree(p.id);
    renderRightRail();
  }

  function commentCompare(a, b) {
    if (commentSort === 'new') return b.id - a.id;
    if (commentSort === 'top') return (b.score - a.score) || (a.id - b.id);
    if (commentSort === 'controversial') return ((b.controversy || 0) - (a.controversy || 0)) || (a.id - b.id);
    return ((b.best || 0) - (a.best || 0)) || (b.score - a.score) || (a.id - b.id); // best
  }

  async function loadCommentTree(postId) {
    const box = document.getElementById('commentTree');
    if (!box) return;
    let r;
    try { r = await API.comments(postId); } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    const comments = r.comments;
    if (!comments.length) { box.innerHTML = '<div class="empty" style="padding:8px">No comments yet. Start the conversation.</div>'; return; }
    const byParent = {};
    comments.forEach((c) => { const k = c.parent_id || 0; (byParent[k] = byParent[k] || []).push(c); });
    function render(parentId, depth) {
      const kids = byParent[parentId] || [];
      // Top-level comments follow the chosen sort; replies stay chronological so
      // a conversation reads in order.
      if (parentId === 0) kids.sort(commentCompare);
      else kids.sort((a, b) => a.id - b.id);
      const frag = document.createDocumentFragment();
      kids.forEach((c) => frag.appendChild(commentTreeNode(c, postId, depth, render)));
      return frag;
    }
    box.innerHTML = '';
    box.appendChild(render(0, 0));
  }

  function commentTreeNode(c, postId, depth, render) {
    const node = el('<div class="ctree"></div>');
    const row = el('<div class="crow"></div>');
    row.appendChild(voteControl('comment', c.id, c.score, c.myVote));
    const main = el('<div class="cmain"></div>');
    const mine = c.author.id === ME.id;
    const canModC = (postMod || postOwner) && !mine;
    main.innerHTML =
      '<div class="cbubble' + (c.removed ? ' cremoved' : '') + '"><span class="cname link" data-profile="' + c.author.id + '">' + esc(c.author.name) + verifTick(c.author) + '</span> <span class="ctime">' + timeAgo(c.created_at) + '</span>' +
      '<div>' + linkify(esc(c.content)) + '</div></div>' +
      '<div class="cactions"><button class="clink" data-reply>Reply</button>' +
      (mine ? ' <button class="clink" data-delc>Delete</button>' : ' <button class="clink" data-report="comment" data-report-id="' + c.id + '">Report</button>') +
      (canModC ? (c.removed ? ' <button class="clink" data-modrestorec>Restore</button>' : ' <button class="clink" data-modrmc>Remove</button>') : '') +
      '</div>' +
      '<div class="creply hidden"></div>';
    row.appendChild(main);
    node.appendChild(row);

    const childFrag = render(c.id, depth + 1);
    if (childFrag.childNodes.length) {
      const childWrap = el('<div class="cchildren"></div>');
      childWrap.appendChild(childFrag);
      node.appendChild(childWrap);
    }

    main.querySelector('[data-profile]').onclick = () => go('profile', c.author.id);
    main.querySelector('[data-reply]').onclick = () => {
      const rb = main.querySelector('.creply');
      if (!rb.classList.contains('hidden')) { rb.classList.add('hidden'); rb.innerHTML = ''; return; }
      rb.classList.remove('hidden');
      rb.innerHTML = '<div class="comment-form">' + avatar(ME, 28) + '<input type="text" placeholder="Reply..."><button class="btn btn-soft btn-sm">Reply</button></div>';
      const inp = rb.querySelector('input');
      const send = async () => { const content = inp.value.trim(); if (!content) return; inp.disabled = true; try { await API.addComment(postId, content, c.id); loadCommentTree(postId); } catch (e) { toast(e.message); inp.disabled = false; } };
      rb.querySelector('button').onclick = send;
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      inp.focus();
    };
    const delc = main.querySelector('[data-delc]');
    if (delc) delc.onclick = async () => { try { await API.deleteComment(c.id); loadCommentTree(postId); } catch (e) { toast(e.message); } };
    const mrmc = main.querySelector('[data-modrmc]');
    if (mrmc) mrmc.onclick = async () => { try { await API.modRemove('comment', c.id, ''); loadCommentTree(postId); } catch (e) { toast(e.message); } };
    const mrsc = main.querySelector('[data-modrestorec]');
    if (mrsc) mrsc.onclick = async () => { try { await API.modRestore('comment', c.id); loadCommentTree(postId); } catch (e) { toast(e.message); } };
    return node;
  }

  /* ============================ reels ============================ */

  async function renderReels() {
    view.innerHTML = '<div class="card"><div class="empty" style="padding:40px">Loading reels...</div></div>';
    let data;
    try { data = await API.reels(); } catch (e) { view.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + '</div></div>'; return; }
    const reels = data.reels;
    view.innerHTML =
      '<div class="card mk-head"><div class="section-title" style="margin:0">Reels</div><span style="flex:1"></span>' +
      '<button class="btn btn-primary btn-sm" id="newReel">&#10010; New reel</button></div>' +
      (reels.length ? '<div class="reels-viewer" id="reelsViewer"></div>'
        : '<div class="card"><div class="empty">No reels yet. Tap "New reel" to post the first one.</div></div>');
    document.getElementById('newReel').onclick = openReelComposer;
    if (reels.length) {
      const viewer = document.getElementById('reelsViewer');
      reels.forEach((r) => viewer.appendChild(reelStage(r)));
      wireReelAutoplay(viewer);
      // If we arrived via a shared reel link, scroll that reel into view.
      if (pendingReel) {
        const target = viewer.querySelector('.reel-stage[data-reel="' + pendingReel + '"]');
        if (target) target.scrollIntoView();
        pendingReel = null;
      }
    }
    renderRightRail();
  }

  function reelStage(r) {
    const stage = el('<div class="reel-stage" data-reel="' + r.id + '"></div>');
    stage.innerHTML =
      '<video class="reel-video" src="' + esc(r.video) + '" loop muted playsinline preload="metadata"></video>' +
      '<div class="reel-overlay">' +
        '<div class="reel-mute" data-mute>&#128263;</div>' +
        '<div class="reel-actions">' +
          '<button class="reel-act" data-like><span class="ra-ic">' + (r.liked ? '❤️' : '🤍') + '</span><span class="ra-n" data-likec>' + r.likeCount + '</span></button>' +
          '<button class="reel-act" data-comment><span class="ra-ic">&#128172;</span><span class="ra-n" data-commc>' + r.commentCount + '</span></button>' +
          '<button class="reel-act" data-share><span class="ra-ic">&#8599;</span><span class="ra-n">Share</span></button>' +
          (r.mine ? '<button class="reel-act" data-del><span class="ra-ic">&#128465;</span></button>'
                  : '<button class="reel-act" data-report="reel" data-report-id="' + r.id + '"><span class="ra-ic">&#9873;</span><span class="ra-n">Report</span></button>') +
        '</div>' +
        '<div class="reel-meta">' + avatar(r.author, 36) +
          '<div><div class="rname" data-profile="' + r.author.id + '">' + esc(r.author.name) + verifTick(r.author) + '</div>' +
          (r.caption ? '<div class="rcap">' + linkify(esc(r.caption)) + '</div>' : '') +
          '<div class="rviews">' + r.views + ' views</div></div>' +
        '</div>' +
      '</div>';

    const video = stage.querySelector('video');
    video.onclick = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    const mute = stage.querySelector('[data-mute]');
    mute.onclick = (e) => { e.stopPropagation(); video.muted = !video.muted; mute.innerHTML = video.muted ? '&#128263;' : '&#128266;'; };

    stage.querySelector('[data-like]').onclick = async () => {
      try {
        const res = await API.likeReel(r.id);
        stage.querySelector('[data-like] .ra-ic').innerHTML = res.liked ? '❤️' : '🤍';
        stage.querySelector('[data-likec]').textContent = res.likeCount;
      } catch (e) { toast(e.message); }
    };
    stage.querySelector('[data-comment]').onclick = () => openReelComments(r);
    stage.querySelector('[data-share]').onclick = () => {
      const url = window.location.origin + '/app#reel=' + r.id;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Reel link copied')).catch(() => toast('Share: ' + url));
      else toast('Share: ' + url);
    };
    stage.querySelector('[data-profile]').onclick = () => go('profile', r.author.id);
    const del = stage.querySelector('[data-del]');
    if (del) del.onclick = async () => { if (!window.confirm('Delete this reel?')) return; try { await API.deleteReel(r.id); toast('Reel deleted'); renderReels(); } catch (e) { toast(e.message); } };
    return stage;
  }

  // Play whichever reel is mostly in view, pause the rest, and count one view.
  function wireReelAutoplay(viewer) {
    const viewed = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const v = en.target.querySelector('video');
        if (!v) return;
        if (en.isIntersecting && en.intersectionRatio > 0.6) {
          v.play().catch(() => {});
          const id = Number(en.target.getAttribute('data-reel'));
          if (!viewed.has(id)) {
            viewed.add(id);
            API.viewReel(id).then((res) => { const rv = en.target.querySelector('.rviews'); if (rv) rv.textContent = res.views + ' views'; }).catch(() => {});
          }
        } else {
          v.pause();
        }
      });
    }, { threshold: [0, 0.6, 1], root: viewer });
    viewer.querySelectorAll('.reel-stage').forEach((s) => io.observe(s));
    // Kick off the first reel right away.
    const first = viewer.querySelector('.reel-stage video');
    if (first) first.play().catch(() => {});
  }

  function openReelComposer() {
    const m = modal(
      '<div class="mh"><h3>New reel</h3></div><div class="mc">' +
      '<div class="field"><label>Video</label><input type="file" id="reelFile" accept="video/*" class="input"></div>' +
      '<div class="preview hidden" id="reelPrev"></div>' +
      '<div class="field"><label>Caption (optional)</label><textarea class="input" id="reelCap" rows="2" placeholder="Say something..."></textarea></div>' +
      '<button class="btn btn-primary btn-block" id="reelPost">Post reel</button></div>'
    );
    const fileInput = m.q('#reelFile');
    const prev = m.q('#reelPrev');
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (f) { prev.classList.remove('hidden'); prev.innerHTML = '<video src="' + URL.createObjectURL(f) + '" style="max-height:220px;width:100%;border-radius:10px" muted controls></video>'; }
    };
    m.q('#reelPost').onclick = async () => {
      let f = fileInput.files[0];
      if (!f) { toast('Choose a video'); return; }
      const btn = m.q('#reelPost'); btn.disabled = true;
      try {
        // Compress in the browser before upload (Option B), so reels land on our
        // servers small. Falls back to the original if it is not supported or fails.
        if (window.VidCompress && window.VidCompress.supported() && /^video\//.test(f.type)) {
          btn.textContent = 'Optimizing video...';
          try {
            const c = await window.VidCompress.compress(f, {
              onProgress: (p) => { btn.textContent = 'Optimizing ' + Math.round(p * 100) + '%'; },
            });
            if (c && c.size && c.size < f.size) f = c;
          } catch (e) { /* keep the original on any compression error */ }
        }
        btn.textContent = 'Posting...';
        await API.createReel(f, m.q('#reelCap').value.trim());
        m.close(); toast('Reel posted'); renderReels();
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Post reel'; }
    };
  }

  function openReelComments(r) {
    const m = modal('<div class="mh"><h3>Comments</h3></div><div class="mc"><div id="reelCmList"><div class="empty">Loading...</div></div><div class="comment-form" id="reelCmForm"></div></div>');
    async function load() {
      try {
        const d = await API.reelComments(r.id);
        const list = m.q('#reelCmList');
        if (!d.comments.length) { list.innerHTML = '<div class="empty" style="padding:8px">No comments yet.</div>'; return; }
        list.innerHTML = '';
        d.comments.forEach((c) => {
          const row = el('<div class="contact" style="align-items:flex-start">' + avatar(c.author, 32) +
            '<div><b>' + esc(c.author.name) + '</b> <span class="ctime">' + timeAgo(c.created_at) + '</span>' +
            '<div>' + linkify(esc(c.content)) + '</div></div></div>');
          list.appendChild(row);
        });
      } catch (e) { m.q('#reelCmList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
    }
    const form = m.q('#reelCmForm');
    form.innerHTML = avatar(ME, 28) + '<input type="text" placeholder="Add a comment..."><button class="btn btn-soft btn-sm">Send</button>';
    const inp = form.querySelector('input');
    const send = async () => {
      const content = inp.value.trim(); if (!content) return;
      inp.disabled = true;
      try {
        await API.addReelComment(r.id, content); inp.value = ''; inp.disabled = false; load();
        const stage = document.querySelector('.reel-stage[data-reel="' + r.id + '"]');
        if (stage) { const cn = stage.querySelector('[data-commc]'); if (cn) cn.textContent = (Number(cn.textContent) || 0) + 1; }
      } catch (e) { toast(e.message); inp.disabled = false; }
    };
    form.querySelector('button').onclick = send;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    load();
  }

  /* ============================ live socket events ============================ */

  function wireSocket() {
    Chat.onMessage((m) => {
      const other = m.mine ? m.recipient_id : m.sender_id;
      if (currentView === 'messages' && activeChatUser === other) {
        const body = document.getElementById('mbody');
        if (body) { body.appendChild(msgBubble(m)); scrollBottom(body); }
        if (!m.mine) {
          // We are looking right at this thread, so mark it read, then refresh counts.
          Chat.markRead(other).then(() => { loadConversations(activeChatUser); refreshBadges(); });
        } else {
          loadConversations(activeChatUser);
        }
      } else if (!m.mine) {
        toast('New message');
        refreshBadges();
        if (currentView === 'messages') loadConversations(activeChatUser);
      }
    });
    Chat.onNotif((n) => setBadge('notifBadge', n.count));
    // Live presence: flip the matching contact dot green/grey as friends come and go.
    Chat.onPresence((p) => {
      document.querySelectorAll('[data-dot="' + p.userId + '"]').forEach((d) => {
        d.classList.toggle('off', !p.online);
        d.title = p.online ? 'Online' : 'Offline';
      });
    });
  }

  /* ============================ go ============================ */

  boot();
})();
