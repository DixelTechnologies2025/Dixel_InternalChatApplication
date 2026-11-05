(function () {
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dixel' },
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(data.message || 'Request failed.');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  function el(tag, props, children) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v);
    });
    (children || []).forEach((c) => n.append(c));
    return n;
  }
  function initials(name) {
    const p = String(name).trim().split(/\s+/);
    return ((p[0] || '')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function avatar(user, small, withDot) {
    const cls = 'avatar av' + (user.id % 6) + (small ? ' sm' : '');
    const a = el('span', { class: cls, 'aria-hidden': 'true', text: initials(user.fullName) });
    if (withDot) a.append(el('span', { class: 'dot' + (user.online ? ' on' : '') }));
    return a;
  }
  function setLoading(btn, on) { btn.disabled = on; btn.classList.toggle('loading', on); }
  function showAlert(box, kind, text) {
    box.className = 'alert ' + kind; box.textContent = text; box.classList.remove('hidden');
  }
  function clearFieldErrors(form) {
    form.querySelectorAll('.field').forEach((f) => {
      f.classList.remove('err');
      const input = f.querySelector('input, select');
      if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      const m = f.querySelector('.msg'); if (m) m.textContent = '';
    });
  }
  function fieldErrors(form, errors) {
    Object.entries(errors || {}).forEach(([name, msg]) => {
      const input = form.querySelector('[name="' + name + '"]'); if (!input) return;
      const f = input.closest('.field'), message = f.querySelector('.msg');
      f.classList.add('err'); message.textContent = msg;
      if (!message.id) message.id = name + 'Error';
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', message.id);
    });
  }
  document.querySelectorAll('.password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    });
  });
  window.D = { api, el, initials, avatar, setLoading, showAlert, clearFieldErrors, fieldErrors };
})();
