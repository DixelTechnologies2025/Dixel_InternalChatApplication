(function () {
  const { api, setLoading, showAlert, clearFieldErrors, fieldErrors } = D;
  const form = document.getElementById('form');
  const alertBox = document.getElementById('alert');
  const page = document.body.dataset.page;
  const q = new URLSearchParams(location.search);

  async function redirectIfSignedIn() {
    try { await api('/auth/me'); location.replace('/chat'); } catch (e) { /* stay */ }
  }

  if (page === 'login') {
    redirectIfSignedIn();
    if (q.get('reset')) showAlert(alertBox, 'ok', 'Password updated. Sign in with your new password.');
  }

  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearFieldErrors(form); alertBox.classList.add('hidden');
    const btn = form.querySelector('button[type=submit]');
    const body = Object.fromEntries(new FormData(form).entries());
    if (page === 'reset') body.token = q.get('token');
    const routes = { login: '/auth/login', signup: '/auth/signup', forgot: '/auth/forgot', reset: '/auth/reset' };
    setLoading(btn, true);
    try {
      const r = await api(routes[page], { method: 'POST', body });
      if (page === 'login') return location.replace('/chat');
      if (page === 'reset') return location.replace('/login.html?reset=1');
      form.reset();
      const message = page === 'signup'
        ? 'Your request has been sent. You can sign in after an administrator approves your account.'
        : r.message;
      showAlert(alertBox, 'ok', message);
    } catch (e) {
      fieldErrors(form, e.data && e.data.errors);
      showAlert(alertBox, 'error', e.message);
    } finally { setLoading(btn, false); }
  });
})();
