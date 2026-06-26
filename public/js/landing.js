// landing.js
// Handles the login and signup forms on the landing page.

(function () {
  // If already logged in, go straight to the app.
  API.me().then(() => { window.location.href = '/app'; }).catch(() => {});

  const loginView = document.getElementById('loginView');
  const signupView = document.getElementById('signupView');

  document.getElementById('toSignup').addEventListener('click', () => {
    loginView.classList.add('hidden');
    signupView.classList.remove('hidden');
    animateCard();
  });
  document.getElementById('toLogin').addEventListener('click', () => {
    signupView.classList.add('hidden');
    loginView.classList.remove('hidden');
    animateCard();
  });

  function animateCard() {
    if (window.anime) {
      anime({ targets: '#authCard', opacity: [0.4, 1], translateY: [8, 0], duration: 350, easing: 'easeOutCubic' });
    }
  }

  // Show/hide password toggles.
  document.querySelectorAll('.pw-toggle').forEach((b) => {
    b.addEventListener('click', () => {
      const inp = document.getElementById(b.getAttribute('data-pw'));
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  function showAlert(el, message) {
    el.innerHTML = '<div class="alert">' + escapeHtml(message) + '</div>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Anti-sybil: signup proof-of-work + a coarse device fingerprint ---
  // Compact synchronous SHA-256 (ASCII in, hex out), so the proof-of-work loop
  // runs fast in a tight loop without thousands of async Web Crypto calls.
  function sha256hex(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    const mp = Math.pow; const maxWord = mp(2, 32); let result = '';
    const words = []; const asciiBitLength = ascii.length * 8;
    let hash = sha256hex.h = sha256hex.h || [];
    const k = sha256hex.k = sha256hex.k || []; let primeCounter = k.length;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mp(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mp(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash;
      hash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = hash[7]
          + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
            w[i - 16]
            + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        const temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  function solvePoW(salt, difficulty) {
    const prefix = '0'.repeat(difficulty);
    const MAX = 20000000; // hard cap so a bad difficulty can never hang the tab
    for (let nonce = 0; nonce < MAX; nonce++) {
      if (sha256hex(salt + ':' + nonce).indexOf(prefix) === 0) return String(nonce);
    }
    return '0';
  }

  function deviceFingerprint() {
    try {
      const parts = [
        navigator.userAgent, navigator.language, (navigator.languages || []).join(','),
        screen.width + 'x' + screen.height, screen.colorDepth,
        new Date().getTimezoneOffset(), navigator.hardwareConcurrency || 0, navigator.platform || '',
      ];
      return sha256hex(parts.join('|')).slice(0, 32);
    } catch (e) { return ''; }
  }

  // Fetch a challenge and solve it. Returns {} when the server has proof-of-work
  // disabled (enabled === false). On a transient fetch failure we retry once,
  // then throw a clear, retryable error rather than silently submitting an empty
  // proof (which the server would reject with a misleading "verify your browser"),
  // mirroring how the server fails OPEN on a CAPTCHA outage.
  async function signupProof() {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = await API.signupChallenge();
        if (!c || c.enabled === false || !c.salt) return {}; // PoW is off, nothing to solve
        return { powSalt: c.salt, powNonce: solvePoW(c.salt, c.difficulty || 4) };
      } catch (e) { lastErr = e; }
    }
    throw new Error('Could not reach the server to verify your browser. Please try again in a moment.');
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    btn.disabled = true;
    btn.textContent = 'Logging in...';
    try {
      await API.login(email, password);
      window.location.href = '/app';
    } catch (err) {
      showAlert(document.getElementById('loginAlert'), err.message);
      btn.disabled = false;
      btn.textContent = 'Log in';
    }
  });

  document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signupBtn');
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    btn.disabled = true;
    btn.textContent = 'Creating account...';
    try {
      const proof = await signupProof();
      await API.signup(name, email, password, Object.assign({ fp: deviceFingerprint() }, proof));
      window.location.href = '/app';
    } catch (err) {
      showAlert(document.getElementById('signupAlert'), err.message);
      btn.disabled = false;
      btn.textContent = 'Sign up';
    }
  });

  animateCard();

  // Progressive enhancement: stagger the promise rows in on load.
  // The start state is set here in JS, so without JS the list is fully visible.
  (function animatePromises() {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rows = document.querySelectorAll('.promise');
    if (!window.anime || reduce || !rows.length) return;
    anime.set(rows, { opacity: 0, translateY: 10 });
    anime({
      targets: rows,
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 480,
      delay: anime.stagger(80, { start: 120 }),
      easing: 'easeOutCubic'
    });
  })();
})();
