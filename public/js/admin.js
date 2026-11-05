(function () {
  const { api, el, showAlert } = D;
  const $ = (id) => document.getElementById(id);
  const date = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const td = (t) => el('td', { text: t == null || t === '' ? '—' : t });

  function note(kind, msg) { showAlert($('alert'), kind, msg); setTimeout(() => $('alert').classList.add('hidden'), 4000); }
  async function act(path, label, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try { await api(path, { method: 'POST', body: {} }); note('ok', label); load(); } catch (e) { note('error', e.message); }
  }
  const emptyRow = (cols, text) => el('tr', {}, [el('td', { colspan: cols, text, class: 'hint' })]);

  async function load() {
    try {
      const [{ users }, { invites }] = await Promise.all([api('/admin/users'), api('/admin/invites')]);
      const pend = users.filter((u) => u.status === 'pending');
      $('pending').replaceChildren(...(pend.length ? pend.map((u) => el('tr', {}, [
        td(u.fullName), td(u.email), td(u.employeeId), td(u.department), td(date(u.createdAt)),
        el('td', {}, [el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', type: 'button', text: 'Approve', onclick: () => act('/admin/users/' + u.id + '/approve', u.fullName + ' approved.') }),
          el('button', { class: 'btn sm danger', type: 'button', text: 'Reject', onclick: () => act('/admin/users/' + u.id + '/reject', u.fullName + ' rejected.', 'Reject ' + u.fullName + '?') }),
        ])]),
      ])) : [emptyRow(6, 'Nobody is waiting for approval.')]));

      $('invites').replaceChildren(...(invites.length ? invites.map((i) => el('tr', {}, [
        td(i.email), td(i.employeeId), td(i.department),
        el('td', {}, [el('span', { class: 'pill' + (i.registered ? ' active' : ''), text: i.registered ? 'Registered' : 'Not registered yet' })]),
        el('td', {}, [el('button', { class: 'btn sm danger', type: 'button', text: 'Remove', onclick: async () => {
          try { await api('/admin/invites/' + encodeURIComponent(i.email), { method: 'DELETE' }); load(); } catch (e) { note('error', e.message); }
        } })]),
      ])) : [emptyRow(5, 'No invites yet.')]));

      $('users').replaceChildren(...(users.length ? users.map((u) => {
        const actions = [];
        if (u.status === 'active') actions.push(el('button', { class: 'btn sm danger', type: 'button', text: 'Deactivate', onclick: () => act('/admin/users/' + u.id + '/deactivate', u.fullName + ' deactivated.', 'Deactivate ' + u.fullName + '? They will be signed out immediately.') }));
        if (u.status === 'inactive') actions.push(el('button', { class: 'btn sm ghost', type: 'button', text: 'Reactivate', onclick: () => act('/admin/users/' + u.id + '/reactivate', u.fullName + ' reactivated.') }));
        if (u.status === 'rejected') actions.push(el('button', { class: 'btn sm ghost', type: 'button', text: 'Approve', onclick: () => act('/admin/users/' + u.id + '/approve', u.fullName + ' approved.') }));
        return el('tr', {}, [td(u.fullName), td(u.email), td(u.department), td(u.role),
          el('td', {}, [el('span', { class: 'pill ' + u.status, text: u.status })]),
          el('td', {}, [el('div', { class: 'actions' }, actions)])]);
      }) : [emptyRow(6, 'No employees yet.')]));
    } catch (e) { if (e.status === 401) location.replace('/login.html'); else if (e.status === 403) location.replace('/chat'); else note('error', e.message); }
  }

  $('inviteForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/admin/invites', { method: 'POST', body: { email: $('iEmail').value, employeeId: $('iEmp').value, department: $('iDept').value } });
      ev.target.reset(); note('ok', 'Invite saved.'); load();
    } catch (e) { note('error', e.message); }
  });
  $('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } finally { location.replace('/login.html'); } });
  load();
})();
