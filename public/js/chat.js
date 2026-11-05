(function () {
  const { api, el, avatar, initials } = D;
  const $ = (id) => document.getElementById(id);
  const state = {
    me: null, tab: 'chats', convs: [], people: [], active: null, // active: {id, other}
    messages: [], hasMore: false, otherRead: 0, firstUnreadId: null, ws: null, retry: 0, online: new Set(),
    typingTimer: 0, otherTypingTimer: 0, isTyping: false, otherTyping: false,
  };

  // ---------- helpers ----------
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function dayLabel(t) {
    const d = new Date(t), n = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (same(d, n)) return 'Today'; if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function listTime(t) {
    const d = new Date(t);
    return d.toDateString() === new Date().toDateString() ? fmtTime(t) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function toast(msg) {
    const t = el('div', { class: 'toast', role: 'status', text: msg }); document.body.append(t); setTimeout(() => t.remove(), 3500);
  }
  const withPresence = (u) => Object.assign(u, { online: state.online.has(u.id) });
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };

  // ---------- sidebar ----------
  function renderTotals() {
    const n = state.convs.reduce((s, c) => s + c.unread, 0);
    const b = $('totalUnread'); b.textContent = n; b.classList.toggle('hidden', !n);
    document.title = (n ? '(' + n + ') ' : '') + 'Dixel Chat';
  }
  function renderList() {
    const list = $('list'); list.replaceChildren(); renderTotals();
    const q = $('q').value.trim().toLowerCase();
    if (state.tab === 'chats') {
      const items = state.convs.filter((c) => !q || (c.other.fullName + ' ' + (c.other.department || '')).toLowerCase().includes(q));
      items.sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt || b.lastMessage.id - a.lastMessage.id);
      if (!items.length) {
        list.append(el('li', { class: 'empty' }, [el('b', { text: q ? 'No chats match your search' : 'No conversations yet' }),
          document.createTextNode(q ? 'Try the Employees tab to find a colleague.' : 'Open the Employees tab and pick a colleague to say hello.')]));
        return;
      }
      items.forEach((c) => {
        const mine = c.lastMessage.senderId === state.me.id;
        const btn = el('button', { class: 'item' + (c.unread ? ' unread' : ''), type: 'button', 'aria-current': String(!!state.active && state.active.id === c.id), onclick: () => openChat(c.other, c.id) }, [
          avatar(c.other, false, true),
          el('div', { class: 'meta' }, [
            el('div', { class: 'top' }, [el('span', { class: 'name', text: c.other.fullName }), el('span', { class: 'time', text: listTime(c.lastMessage.createdAt) })]),
            el('div', { class: 'prev' }, [el('span', { text: (mine ? 'You: ' : '') + c.lastMessage.text.replace(/\s+/g, ' ') }),
              c.unread ? el('span', { class: 'badge', text: c.unread }) : document.createTextNode('')]),
          ]),
        ]);
        list.append(el('li', {}, [btn]));
      });
    } else {
      if (!state.people.length) {
        list.append(el('li', { class: 'empty' }, [el('b', { text: q ? 'No employees found' : 'No colleagues registered yet' }),
          document.createTextNode(q ? 'Check the spelling or search by department.' : 'Approved employees will appear here.')]));
        return;
      }
      state.people.sort((a, b) => Number(b.online) - Number(a.online) || a.fullName.localeCompare(b.fullName));
      state.people.forEach((p) => {
        withPresence(p);
        const btn = el('button', { class: 'item', type: 'button', onclick: () => openChat(p) }, [
          avatar(p, false, true),
          el('div', { class: 'meta' }, [el('div', { class: 'name', text: p.fullName }),
            el('div', { class: 'prev' }, [
              el('span', { text: p.department || 'No department' }),
              p.online ? el('span', { class: 'person-online', text: 'Online' }) : document.createTextNode(''),
            ])]),
        ]);
        list.append(el('li', {}, [btn]));
      });
    }
  }
  async function loadConvs() { state.convs = (await api('/conversations')).conversations; state.convs.forEach((c) => withPresence(c.other)); }
  async function loadPeople() {
    const q = $('q').value.trim();
    state.people = (await api('/employees?q=' + encodeURIComponent(q))).employees;
  }
  async function refreshSide() {
    try { if (state.tab === 'chats') await loadConvs(); else await loadPeople(); renderList(); }
    catch (e) { handleErr(e); }
  }
  function setTab(t) {
    state.tab = t;
    $('tabChats').setAttribute('aria-selected', String(t === 'chats'));
    $('tabPeople').setAttribute('aria-selected', String(t === 'people'));
    refreshSide();
  }
  function handleErr(e) {
    if (e.status === 401) return location.replace('/login.html');
    toast(e.message || 'Something went wrong.');
  }

  // ---------- conversation pane ----------
  function buildPane(other) {
    const view = $('chatView'); view.replaceChildren();
    const head = el('div', { class: 'pane-head' }, [
      el('button', { class: 'back', type: 'button', 'aria-label': 'Back to conversations', onclick: closeChat }, [
        el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [el('path', { d: 'm14 5-7 7 7 7M7 12h14' })]),
      ]),
      avatar(other, true, false),
      el('div', { class: 't' }, [el('b', { text: other.fullName }), el('span', { id: 'subtitle' })]),
    ]);
    const conn = el('div', { class: 'conn hidden', id: 'conn', role: 'status', text: 'Reconnecting…' });
    const unavailable = el('div', { class: 'availability hidden', id: 'unavailable', role: 'status', text: 'This employee is no longer available' });
    const msgs = el('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' });
    const ta = el('textarea', { id: 'composerText', rows: '1', maxlength: '4000', placeholder: 'Type a message', 'aria-label': 'Message' });
    const send = el('button', { class: 'btn', id: 'sendBtn', type: 'button', 'aria-label': 'Send message' }, [
      el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        el('path', { d: 'm22 2-7 20-4-9-9-4Z' }),
        el('path', { d: 'M22 2 11 13' }),
      ]),
      el('span', { class: 'send-label', text: 'Send' }),
    ]);
    const composer = el('div', { class: 'composer' }, [ta, send]);
    view.append(head, unavailable, conn, msgs, composer);
    view.className = 'chatview';
    $('paneEmpty').classList.add('hidden');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    ta.addEventListener('input', onTyping);
    send.addEventListener('click', sendMessage);
    updateSubtitle();
  }
  function updateSubtitle() {
    const s = $('subtitle'); if (!s || !state.active) return;
    const o = state.active.other;
    const online = state.online.has(o.id);
    s.textContent = state.otherTyping ? 'typing…' : o.available === false ? 'This employee is no longer available' :
      (o.department ? o.department + ' · ' : '') + (online ? 'Online' : o.lastSeenAt ? 'Last seen ' + dayLabel(o.lastSeenAt).toLowerCase() + ' ' + fmtTime(o.lastSeenAt) : 'Offline');
  }
  function closeChat() {
    stopTyping();
    clearTimeout(state.otherTypingTimer);
    state.otherTyping = false;
    state.active = null; state.messages = [];
    $('app').classList.remove('chat-open'); $('chatView').classList.add('hidden'); $('paneEmpty').classList.remove('hidden');
    renderList();
  }
  async function openChat(other, convId) {
    try {
      stopTyping();
      clearTimeout(state.otherTypingTimer);
      state.otherTyping = false;
      if (!convId) convId = (await api('/conversations', { method: 'POST', body: { userId: other.id } })).conversation.id;
      state.active = { id: convId, other: withPresence(other) };
      buildPane(other);
      $('app').classList.add('chat-open');
      await loadMessages();
      markRead(); renderList();
      $('composerText').focus({ preventScroll: true });
    } catch (e) { handleErr(e); }
  }
  async function loadMessages() {
    if (!state.active) return;
    const r = await api('/conversations/' + state.active.id + '/messages?limit=50');
    state.messages = r.messages; state.hasMore = r.hasMore; state.otherRead = r.otherLastReadId;
    state.firstUnreadId = r.firstUnreadMessageId;
    Object.assign(state.active.other, { lastSeenAt: r.other.lastSeenAt });
    renderMessages(true); updateSubtitle();
  }
  async function loadOlder() {
    const first = state.messages[0]; if (!first) return;
    const box = $('msgs'), prevH = box.scrollHeight;
    const r = await api('/conversations/' + state.active.id + '/messages?limit=50&before=' + first.id);
    state.messages = r.messages.concat(state.messages); state.hasMore = r.hasMore;
    renderMessages(false); box.scrollTop = box.scrollHeight - prevH;
  }
  function renderMessages(stick) {
    const box = $('msgs'); if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.replaceChildren();
    if (state.hasMore) box.append(el('button', { class: 'btn ghost sm older', type: 'button', text: 'Load earlier messages', onclick: () => loadOlder().catch(handleErr) }));
    if (!state.messages.length) box.append(el('div', { class: 'empty' }, [el('b', { text: 'No messages yet' }), document.createTextNode('Say hello to ' + state.active.other.fullName.split(' ')[0] + '.')]));
    let lastDay = '';
    state.messages.forEach((m) => {
      const d = dayLabel(m.createdAt);
      if (d !== lastDay) { box.append(el('div', { class: 'day', text: d })); lastDay = d; }
      const mine = m.senderId === state.me.id;
      const ts = el('span', { class: 'ts', text: fmtTime(m.createdAt) });
      if (mine) {
        const read = m.id <= state.otherRead;
        const tickPaths = [el('path', { d: 'm4 12 4 4L16 8' })];
        if (read) tickPaths.push(el('path', { d: 'm9 12 4 4 7-8' }));
        ts.append(el('span', { class: 'tick' + (read ? ' read' : ''), 'aria-label': read ? 'Read' : 'Sent' }, [
          el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, tickPaths),
        ]));
      }
      // textContent only: message text is never interpreted as HTML
      box.append(el('div', { class: 'bub' + (mine ? ' me' : ''), 'data-message-id': m.id }, [document.createTextNode(m.text), ts]));
    });
    if (stick && state.firstUnreadId) {
      const firstUnread = box.querySelector('[data-message-id="' + state.firstUnreadId + '"]');
      if (firstUnread) box.scrollTop = firstUnread.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
      else box.scrollTop = box.scrollHeight;
      state.firstUnreadId = null;
    } else if (stick || nearBottom) box.scrollTop = box.scrollHeight;
  }
  async function sendMessage() {
    const ta = $('composerText'), btn = $('sendBtn');
    const text = ta.value.trim(); if (!text || !state.active) return;
    stopTyping();
    btn.disabled = true;
    try {
      const clientId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()).toString();
      const r = await api('/conversations/' + state.active.id + '/messages', { method: 'POST', body: { text, clientId } });
      ta.value = '';
      addMessage(r.message);
    } catch (e) { handleErr(e); } finally { btn.disabled = false; ta.focus(); }
  }
  function sendTyping(typing) {
    if (!state.active || state.active.other.available === false || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type: 'typing', conversationId: state.active.id, typing }));
  }
  function onTyping() {
    if (!state.active || state.active.other.available === false) return;
    if (!state.isTyping) { state.isTyping = true; sendTyping(true); }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      state.isTyping = false;
      sendTyping(false);
    }, 3000);
  }
  function stopTyping() {
    clearTimeout(state.typingTimer);
    if (state.isTyping) sendTyping(false);
    state.isTyping = false;
  }
  function updateOtherTyping(typing) {
    clearTimeout(state.otherTypingTimer);
    state.otherTyping = typing;
    if (typing) state.otherTypingTimer = setTimeout(() => updateOtherTyping(false), 3500);
    updateSubtitle();
  }
  function markUnavailable(userId) {
    state.online.delete(userId);
    state.people = state.people.filter((p) => p.id !== userId);
    state.convs = state.convs.filter((c) => c.other.id !== userId);
    if (state.active && state.active.other.id === userId) {
      state.active.other.available = false;
      stopTyping();
      updateOtherTyping(false);
      $('unavailable').classList.remove('hidden');
      $('composerText').disabled = true;
      $('composerText').placeholder = 'This employee is no longer available';
      $('sendBtn').disabled = true;
    }
    renderList();
  }
  function addMessage(m) {
    if (state.active && m.conversationId === state.active.id && !state.messages.some((x) => x.id === m.id)) {
      state.messages.push(m); state.messages.sort((a, b) => a.id - b.id); renderMessages(m.senderId === state.me.id);
      if (m.senderId !== state.me.id) markRead();
    }
    upsertConv(m);
  }
  function upsertConv(m) {
    let c = state.convs.find((x) => x.id === m.conversationId);
    const viewing = state.active && state.active.id === m.conversationId && !document.hidden;
    if (!c) { loadConvs().then(renderList).catch(() => {}); return; }
    if (!c.lastMessage || m.id >= c.lastMessage.id) c.lastMessage = m;
    if (m.senderId !== state.me.id && !viewing) c.unread += 1;
    state.convs.sort((a, b) => b.lastMessage.id - a.lastMessage.id);
    if (state.tab === 'chats') renderList(); else renderTotals();
  }
  const markRead = debounce(async () => {
    if (!state.active || state.active.other.available === false || document.hidden) return;
    const last = [...state.messages].reverse().find((m) => m.senderId !== state.me.id); if (!last) return;
    try {
      await api('/conversations/' + state.active.id + '/read', { method: 'POST', body: { lastReadMessageId: last.id } });
      const c = state.convs.find((x) => x.id === state.active.id); if (c) { c.unread = 0; if (state.tab === 'chats') renderList(); else renderTotals(); }
    } catch (e) { /* non-fatal */ }
  }, 250);

  // ---------- realtime ----------
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    state.ws = ws;
    ws.onopen = () => { const wasDown = state.retry > 0; state.retry = 0; const c = $('conn'); if (c) c.classList.add('hidden'); if (wasDown) resync(); };
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.type === 'ready') { state.online = new Set(d.online); refreshPresence(); }
      else if (d.type === 'presence') {
        d.online ? state.online.add(d.userId) : state.online.delete(d.userId);
        if (state.active && state.active.other.id === d.userId && d.lastSeenAt) state.active.other.lastSeenAt = d.lastSeenAt;
        refreshPresence();
      } else if (d.type === 'message') addMessage(d.message);
      else if (d.type === 'read' && state.active && state.active.id === d.conversationId) { state.otherRead = Math.max(state.otherRead, d.lastReadMessageId); renderMessages(false); }
      else if (d.type === 'typing' && state.active && state.active.id === d.conversationId && d.userId === state.active.other.id) updateOtherTyping(d.typing === true);
      else if (d.type === 'employee_unavailable') markUnavailable(d.userId);
    };
    ws.onclose = (ev) => {
      if (ev.code === 4001) return location.replace('/login.html');
      clearTimeout(state.typingTimer);
      state.isTyping = false;
      updateOtherTyping(false);
      const c = $('conn'); if (c) c.classList.remove('hidden');
      state.retry += 1; setTimeout(connect, Math.min(1000 * 2 ** state.retry, 15000));
    };
  }
  function refreshPresence() {
    state.convs.forEach((c) => withPresence(c.other)); state.people.forEach(withPresence);
    if (state.active) withPresence(state.active.other);
    renderList(); updateSubtitle();
  }
  async function resync() { // recover anything missed while disconnected
    try { await loadConvs(); renderList(); if (state.active) await loadMessages(); markRead(); } catch (e) { handleErr(e); }
  }

  // ---------- init ----------
  async function init() {
    try { state.me = (await api('/auth/me')).user; } catch (e) { return location.replace('/login.html'); }
    $('meName').textContent = state.me.fullName;
    $('meDept').textContent = state.me.department || state.me.email;
    $('meAvatar').className = 'avatar av' + (state.me.id % 6) + ' account-avatar';
    $('meAvatar').textContent = initials(state.me.fullName);
    if (state.me.role === 'admin') $('adminLink').classList.remove('hidden');
    $('tabChats').addEventListener('click', () => setTab('chats'));
    $('tabPeople').addEventListener('click', () => setTab('people'));
    $('q').addEventListener('input', debounce(() => { if (state.tab === 'people') refreshSide(); else renderList(); }, 200));
    $('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } finally { location.replace('/login.html'); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });
    await refreshSide();
    connect();
  }
  init();
})();
