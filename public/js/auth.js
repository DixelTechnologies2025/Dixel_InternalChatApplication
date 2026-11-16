(function () {
  const { api, setLoading, showAlert, clearFieldErrors, fieldErrors } = D;
  const form = document.getElementById('form');
  const alertBox = document.getElementById('alert');
  const page = document.body.dataset.page;
  const q = new URLSearchParams(location.search);
  const approvalWaitingMessage = 'Your request has been sent. You can sign in after an administrator approves your account.';
  let approvalPollTimer;
  let approvalRedirectTimer;

  function stopApprovalPolling() {
    clearTimeout(approvalPollTimer);
    sessionStorage.removeItem('approvalTracking');
  }

  function scheduleApprovalCheck() {
    approvalPollTimer = setTimeout(checkApprovalStatus, 5000);
  }

  async function checkApprovalStatus() {
    try {
      const { status } = await api('/auth/approval-status');
      if (status === 'active') {
        stopApprovalPolling();
        showAlert(alertBox, 'ok', 'Approved! You can sign in now.');
        approvalRedirectTimer = setTimeout(() => location.replace('/login.html'), 3000);
      } else if (status === 'rejected') {
        stopApprovalPolling();
        showAlert(alertBox, 'error', 'Your registration was not approved. Contact your administrator.');
      } else if (status === 'pending') {
        showAlert(alertBox, 'ok', approvalWaitingMessage);
        scheduleApprovalCheck();
      } else {
        stopApprovalPolling();
        showAlert(alertBox, 'error', 'Approval status is no longer available. Please contact your administrator.');
      }
    } catch (e) {
      if (e.status === 401) {
        stopApprovalPolling();
        return;
      }
      showAlert(alertBox, 'error', 'Could not check approval status. Retrying automatically.');
      scheduleApprovalCheck();
    }
  }

  function startApprovalPolling() {
    clearTimeout(approvalPollTimer);
    clearTimeout(approvalRedirectTimer);
    sessionStorage.setItem('approvalTracking', '1');
    checkApprovalStatus();
  }

  if (page === 'signup' && sessionStorage.getItem('approvalTracking') === '1') {
    checkApprovalStatus();
  }

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
        ? approvalWaitingMessage
        : r.message;
      showAlert(alertBox, 'ok', message);
      if (page === 'signup') startApprovalPolling();
    } catch (e) {
      const errors = e.data && e.data.errors;
      const shown = errors && Object.keys(errors).some((n) => form.querySelector('[name="' + n + '"]'));
      if (shown) fieldErrors(form, errors);
      else showAlert(alertBox, 'error', e.message);
    } finally { setLoading(btn, false); }
  });
})();
