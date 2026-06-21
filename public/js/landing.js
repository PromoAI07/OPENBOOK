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

  function showAlert(el, message) {
    el.innerHTML = '<div class="alert">' + escapeHtml(message) + '</div>';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      await API.signup(name, email, password);
      window.location.href = '/app';
    } catch (err) {
      showAlert(document.getElementById('signupAlert'), err.message);
      btn.disabled = false;
      btn.textContent = 'Sign up';
    }
  });

  animateCard();
})();
