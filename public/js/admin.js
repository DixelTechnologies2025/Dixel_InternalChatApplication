(function () {
  const { api, el, showAlert } = D;
  const $ = (id) => document.getElementById(id);
  const date = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const td = (t) => el('td', { text: t == null || t === '' ? '—' : t });
  const attendanceState = { view: 'daily', rows: [], summary: null, sort: 'name', direction: 1, socket: null, retry: 0 };
  const attendanceTime = (timestamp) => timestamp == null ? '—' : new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
  const attendanceHours = (minutes) => minutes == null
    ? '—'
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

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

  function attendanceQuery(exporting) {
    const params = new URLSearchParams();
    params.set('search', $('attendanceSearch').value.trim());
    if (attendanceState.view === 'monthly' && !exporting) {
      params.set('view', 'monthly');
      params.set('month', $('attendanceMonth').value);
    } else {
      const from = $('attendanceFrom').value, to = $('attendanceTo').value;
      if (from || to) {
        if (!from || !to) throw new Error('Choose both a From and To date.');
        params.set('from', from);
        params.set('to', to);
      } else if ($('attendanceDate').value) params.set('date', $('attendanceDate').value);
    }
    return params;
  }
  function renderAttendanceSummary(summary) {
    $('attendanceSummaryCards').classList.toggle('hidden', !summary);
    if (!summary) return;
    $('attendancePresent').textContent = summary.present;
    $('attendanceNotCheckedIn').textContent = summary.notCheckedInYet;
    $('attendanceWorking').textContent = summary.currentlyWorking;
    $('attendanceCheckedOut').textContent = summary.checkedOut;
  }
  function renderDailyAttendance(data) {
    $('attendanceDailyTable').classList.remove('hidden');
    $('attendanceMonthlyTable').classList.add('hidden');
    $('attendanceDate').value = data.from;
    renderAttendanceSummary(data.summary);
    attendanceState.summary = data.summary;
    const rows = [...data.rows];
    rows.sort((a, b) => {
      let order = attendanceState.sort === 'entry'
        ? (a.checkInAt == null ? 1 : b.checkInAt == null ? -1 : a.checkInAt - b.checkInAt)
        : a.fullName.localeCompare(b.fullName);
      if (!order) order = a.workDate.localeCompare(b.workDate) || a.fullName.localeCompare(b.fullName);
      return order * attendanceState.direction;
    });
    $('attendanceRows').replaceChildren(...(rows.length ? rows.map((row) => {
      const status = row.status.toLowerCase().replace(/\s+/g, '-');
      return el('tr', {}, [
        td(row.fullName), td(row.employeeId), td(row.department), td(row.workDate),
        td(attendanceTime(row.checkInAt)), td(attendanceTime(row.checkOutAt)),
        td(attendanceHours(row.totalMinutes)),
        el('td', {}, [el('span', { class: 'pill attendance-status status-' + status, text: row.status })]),
      ]);
    }) : [emptyRow(8, 'No active employees match these filters.')]));
  }
  function renderMonthlyAttendance(data) {
    $('attendanceDailyTable').classList.add('hidden');
    $('attendanceMonthlyTable').classList.remove('hidden');
    $('attendanceSummaryCards').classList.add('hidden');
    $('attendanceMonth').value = data.month;
    $('attendanceMonthlyRows').replaceChildren(...(data.employees.length ? data.employees.map((employee) => el('tr', {}, [
      td(employee.fullName), td(employee.employeeId), td(employee.department), td(employee.daysPresent),
      td(employee.totalHours.toFixed(2)),
    ])) : [emptyRow(5, 'No active employees match these filters.')]));
  }
  async function loadAttendance() {
    try {
      const params = attendanceQuery(false);
      const data = await api('/admin/attendance?' + params.toString());
      attendanceState.view = data.view;
      if (data.view === 'monthly') {
        renderMonthlyAttendance(data);
        if (!$('attendanceDate').value) $('attendanceDate').value = data.month + '-01';
      } else {
        if (!$('attendanceDate').value) $('attendanceDate').value = data.workDate;
        if (!$('attendanceMonth').value) $('attendanceMonth').value = data.workDate.slice(0, 7);
        attendanceState.rows = data.rows;
        renderDailyAttendance(data);
      }
    } catch (e) {
      if (e.status === 401) location.replace('/login.html');
      else if (e.status === 403) location.replace('/chat');
      else note('error', e.message);
    }
  }
  async function exportAttendance() {
    try {
      const params = attendanceQuery(true);
      const response = await fetch('/api/admin/attendance/export?' + params.toString(), {
        headers: { 'X-Requested-With': 'dixel' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        let error = {};
        try { error = await response.json(); } catch {}
        throw Object.assign(new Error(error.message || 'Could not export attendance.'), { status: response.status });
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'attendance.csv' });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) { note('error', e.message); }
  }
  function connectAttendanceSocket() {
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    attendanceState.socket = socket;
    socket.onopen = () => { attendanceState.retry = 0; };
    socket.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'attendance_updated') loadAttendance();
      else if (data.type === 'user_profile_updated') {
        load();
        loadAttendance();
      }
    };
    socket.onclose = (event) => {
      if (event.code === 4001) return location.replace('/login.html');
      attendanceState.retry += 1;
      setTimeout(connectAttendanceSocket, Math.min(1000 * 2 ** attendanceState.retry, 15000));
    };
  }
  $('attendanceView').addEventListener('change', () => {
    const monthly = $('attendanceView').value === 'monthly';
    document.querySelectorAll('.attendance-daily-filter, .attendance-range-filter')
      .forEach((field) => field.classList.toggle('hidden', monthly));
    $('attendanceMonth').closest('.field').classList.toggle('hidden', !monthly);
    $('exportAttendance').classList.toggle('hidden', monthly);
    attendanceState.view = monthly ? 'monthly' : 'daily';
    $('attendanceSummaryCards').classList.toggle('hidden', monthly);
  });
  $('loadAttendance').addEventListener('click', loadAttendance);
  $('exportAttendance').addEventListener('click', exportAttendance);
  $('attendanceDate').addEventListener('change', () => {
    $('attendanceFrom').value = '';
    $('attendanceTo').value = '';
  });
  ['attendanceFrom', 'attendanceTo'].forEach((id) => $(id).addEventListener('change', () => {
    $('attendanceDate').value = '';
  }));
  $('attendanceSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadAttendance();
  });
  document.querySelectorAll('.attendance-sort').forEach((button) => button.addEventListener('click', () => {
    const sort = button.dataset.sort;
    if (attendanceState.sort === sort) attendanceState.direction *= -1;
    else { attendanceState.sort = sort; attendanceState.direction = 1; }
    renderDailyAttendance({
      from: attendanceState.rows[0]?.workDate || $('attendanceDate').value,
      summary: attendanceState.summary,
      rows: attendanceState.rows,
    });
  }));
  $('inviteForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/admin/invites', { method: 'POST', body: { email: $('iEmail').value, employeeId: $('iEmp').value, department: $('iDept').value } });
      ev.target.reset(); note('ok', 'Invite saved.'); load();
    } catch (e) { note('error', e.message); }
  });
  $('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } finally { location.replace('/login.html'); } });
  load();
  loadAttendance();
  connectAttendanceSocket();
})();
