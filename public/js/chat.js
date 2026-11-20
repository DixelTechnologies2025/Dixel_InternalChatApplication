(function () {
  const { api, el, avatar, initials, updateAvatar } = D;
  const $ = (id) => document.getElementById(id);
  const state = {
    me: null, tab: 'chats', convs: [], selfChat: null, groups: [], people: [], active: null,
    messages: [], hasMore: false, otherRead: 0, firstUnreadId: null, ws: null, retry: 0, online: new Set(),
    typingTimer: 0, otherTypingTimer: 0, isTyping: false, otherTyping: false,
    profilePhotoReady: false, profileDraft: null, profileEditing: new Set(), profileErrors: {},
    groupPhotoReady: false, groupPhotoAdmin: false,
    attendance: null, attendanceBusy: false,
  };

  let emojiPicker = null;
  let emojiPickerTrigger = null;
  let reactionBar = null;
  let reactionPopover = null;
  let pickerTarget = null;
  let pickerPick = null;
  let pickerCategory = 'Recent';
  let pickerQuery = '';
  const recentEmojiKey = 'dixel-recent-emojis';

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
  function emojiCategories() { return window.EMOJI_DATA || []; }
  function readRecentEmojis() {
    try {
      const value = JSON.parse(localStorage.getItem(recentEmojiKey) || '[]');
      return Array.isArray(value) ? value.filter((emoji) => typeof emoji === 'string').slice(0, 24) : [];
    } catch (e) { return []; }
  }
  function rememberEmoji(emoji) {
    try {
      const recent = [emoji, ...readRecentEmojis().filter((item) => item !== emoji)].slice(0, 24);
      localStorage.setItem(recentEmojiKey, JSON.stringify(recent));
    } catch (e) { /* private browsing/storage-disabled is harmless */ }
  }
  function closeEmojiUi() {
    if (emojiPicker) emojiPicker.remove();
    if (reactionBar) reactionBar.remove();
    if (reactionPopover) reactionPopover.remove();
    emojiPicker = null; emojiPickerTrigger = null; reactionBar = null; reactionPopover = null;
    pickerTarget = null; pickerPick = null;
  }
  function floatingPosition(node, anchor, mode) {
    const rect = anchor.getBoundingClientRect();
    const width = mode === 'picker' ? Math.min(350, window.innerWidth - 16) : node.offsetWidth;
    const height = node.offsetHeight;
    let left = mode === 'composer' ? rect.left : rect.right + 8;
    let top = mode === 'composer' ? rect.top - height - 8 : rect.bottom + 8;
    if (mode !== 'composer' && left + width > window.innerWidth - 8) left = rect.left - width - 8;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 8;
    if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8);
    node.style.left = Math.max(8, Math.min(left, window.innerWidth - width - 8)) + 'px';
    node.style.top = Math.max(8, top) + 'px';
  }
  function pickerItems() {
    const all = emojiCategories().flatMap((group) => group.items.map(([emoji, name, keywords]) => ({ emoji, name, keywords, category: group.category })));
    if (pickerCategory === 'Recent') {
      const recent = readRecentEmojis();
      return recent.map((emoji) => all.find((item) => item.emoji === emoji) || { emoji, name: emoji, keywords: '', category: 'Recent' });
    }
    const group = emojiCategories().find((item) => item.category === pickerCategory);
    return group ? group.items.map(([emoji, name, keywords]) => ({ emoji, name, keywords, category: group.category })) : all;
  }
  function renderPickerGrid() {
    if (!emojiPicker) return;
    const grid = emojiPicker.querySelector('.emoji-grid');
    const query = pickerQuery.trim().toLowerCase();
    const items = pickerItems().filter((item) => !query || (item.name + ' ' + item.keywords).toLowerCase().includes(query));
    grid.replaceChildren();
    if (!items.length) { grid.append(el('div', { class: 'emoji-empty', text: 'No emoji found' })); return; }
    items.forEach((item) => {
      const button = el('button', { class: 'emoji-item', type: 'button', text: item.emoji, 'aria-label': item.name, title: item.name });
      button.addEventListener('click', () => {
        rememberEmoji(item.emoji);
        if (pickerPick) pickerPick(item.emoji);
        else if (pickerTarget) {
          const start = pickerTarget.selectionStart == null ? pickerTarget.value.length : pickerTarget.selectionStart;
          const end = pickerTarget.selectionEnd == null ? start : pickerTarget.selectionEnd;
          const next = pickerTarget.value.slice(0, start) + item.emoji + pickerTarget.value.slice(end);
          if (next.length <= 4000) {
            pickerTarget.value = next;
            const caret = start + item.emoji.length;
            pickerTarget.setSelectionRange(caret, caret);
            pickerTarget.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      });
      grid.append(button);
    });
  }
  function openEmojiPicker(trigger, anchor, target, onPick) {
    if (emojiPicker && emojiPickerTrigger === trigger) { closeEmojiUi(); return; }
    closeEmojiUi();
    emojiPickerTrigger = trigger; pickerTarget = target; pickerPick = onPick || null; pickerCategory = 'Recent'; pickerQuery = '';
    emojiPicker = el('div', { class: 'emoji-picker', role: 'dialog', 'aria-label': 'Emoji picker' });
    const tabs = el('div', { class: 'emoji-tabs' });
    ['Recent', ...emojiCategories().map((group) => group.category)].forEach((category) => {
      const tab = el('button', { class: 'emoji-tab' + (category === pickerCategory ? ' active' : ''), type: 'button', text: category, title: category });
      tab.addEventListener('click', () => {
        pickerCategory = category;
        tabs.querySelectorAll('.emoji-tab').forEach((item) => item.classList.toggle('active', item === tab));
        renderPickerGrid();
      });
      tabs.append(tab);
    });
    const search = el('input', { class: 'emoji-search', type: 'search', placeholder: 'Search emoji', 'aria-label': 'Search emoji' });
    search.addEventListener('input', () => { pickerQuery = search.value; renderPickerGrid(); });
    emojiPicker.append(tabs, search, el('div', { class: 'emoji-grid' }));
    emojiPicker.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(emojiPicker);
    renderPickerGrid();
    floatingPosition(emojiPicker, anchor, target ? 'composer' : 'picker');
  }
  function composerEmojiButton(textarea) {
    const button = el('button', { class: 'emoji-trigger', type: 'button', 'aria-label': 'Emoji', 'aria-haspopup': 'dialog', text: '☺' });
    button.addEventListener('click', (event) => { event.stopPropagation(); openEmojiPicker(button, button, textarea); });
    return button;
  }
  function reactionPath(message) {
    return state.active.kind === 'group'
      ? '/groups/' + state.active.id + '/messages/' + message.id + '/reaction'
      : '/conversations/' + state.active.id + '/messages/' + message.id + '/reaction';
  }
  function reactionCounts(message) {
    const counts = new Map();
    (message.reactions || []).forEach((reaction) => {
      const current = counts.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, users: [] };
      current.count += 1; current.users.push(reaction); counts.set(reaction.emoji, current);
    });
    return [...counts.values()];
  }
  function updateReactionDom(message) {
    const bubble = document.querySelector('.bub[data-message-id="' + message.id + '"]');
    if (!bubble) return;
    bubble.querySelector('.reaction-chips')?.remove();
    const counts = reactionCounts(message);
    bubble.classList.toggle('has-reactions', counts.length > 0);
    if (!counts.length) return;
    const chips = el('div', { class: 'reaction-chips' });
    counts.forEach((item) => {
      const chip = el('button', { class: 'reaction-chip', type: 'button', text: item.emoji + (item.count > 1 ? ' ' + item.count : ''), 'aria-label': item.emoji + ' reaction' });
      chip.addEventListener('click', (event) => { event.stopPropagation(); openReactionPopover(message, chip); });
      chips.append(chip);
    });
    bubble.append(chips);
  }
  function openReactionPopover(message, anchor) {
    closeEmojiUi();
    reactionPopover = el('div', { class: 'reaction-popover', role: 'dialog', 'aria-label': 'Reaction details' });
    (message.reactions || []).forEach((reaction) => {
      const entry = el('button', { class: 'reaction-entry', type: 'button', text: reaction.fullName + ' ' + reaction.emoji });
      if (Number(reaction.userId) === Number(state.me.id)) entry.title = 'Remove your reaction';
      entry.addEventListener('click', async () => {
        if (Number(reaction.userId) !== Number(state.me.id)) return;
        try { await updateReaction(message, null, true); } catch (e) { toast(e.message); }
      });
      reactionPopover.append(entry);
    });
    document.body.append(reactionPopover);
    floatingPosition(reactionPopover, anchor, 'popover');
  }
  async function updateReaction(message, emoji, remove) {
    const result = await api(reactionPath(message), { method: remove ? 'DELETE' : 'PUT', body: remove ? undefined : { emoji } });
    message.reactions = result.reactions || [];
    updateReactionDom(message);
    closeEmojiUi();
  }
  function openReactionBar(message, bubble, trigger) {
    closeEmojiUi();
    reactionBar = el('div', { class: 'reaction-bar', role: 'toolbar', 'aria-label': 'Add reaction' });
    ['👍', '❤️', '😂', '😮', '😢', '🙏'].forEach((emoji) => {
      const button = el('button', { class: 'quick-reaction' + ((message.reactions || []).some((item) => Number(item.userId) === Number(state.me.id) && item.emoji === emoji) ? ' active' : ''), type: 'button', text: emoji, 'aria-label': emoji });
      button.addEventListener('click', () => updateReaction(message, emoji, false).catch((e) => toast(e.message)));
      reactionBar.append(button);
    });
    const more = el('button', { class: 'quick-reaction more', type: 'button', text: '+', 'aria-label': 'More reactions' });
    more.addEventListener('click', (event) => { event.stopPropagation(); openEmojiPicker(more, bubble, null, (emoji) => updateReaction(message, emoji, false).catch((e) => toast(e.message))); });
    reactionBar.append(more);
    reactionBar.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(reactionBar);
    floatingPosition(reactionBar, trigger, 'bar');
  }
  function reactionTrigger(message, bubble) {
    const button = el('button', { class: 'reaction-trigger', type: 'button', text: '☺', 'aria-label': 'React to message' });
    button.addEventListener('click', (event) => { event.stopPropagation(); openReactionBar(message, bubble, button); });
    return button;
  }
  function closeFloatingOnOutside(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest('.emoji-picker, .reaction-bar, .reaction-popover, .emoji-trigger, .reaction-trigger, .reaction-chip'))) return;
    closeEmojiUi();
  }
  function groupIcon(className) {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(namespace, 'circle');
    circle.setAttribute('cx', '9');
    circle.setAttribute('cy', '8');
    circle.setAttribute('r', '3');
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', 'M3.5 19c.5-3 2.4-4.5 5.5-4.5s5 1.5 5.5 4.5M16 8a3 3 0 0 1 0 5.8M17 15c2.2.5 3.4 1.8 3.7 4');
    svg.append(circle, path);
    return svg;
  }
  function groupAvatar(group, size, id) {
    const node = el('span', {
      class: 'avatar av' + (group.id % 6) + ' group-avatar' + (size === 'sm' ? ' sm' : '') +
        (size === 'large' ? ' group-profile-photo' : ''),
      'aria-hidden': 'true',
      'data-group-id': group.id,
    }, [groupIcon('group-avatar-icon')]);
    if (id) node.id = id;
    updateGroupAvatar(node, group);
    return node;
  }
  function updateGroupAvatar(node, group) {
    const version = group.avatarVersion || null;
    node.dataset.groupId = String(group.id);
    node.dataset.avatarVersion = version == null ? '' : String(version);
    let image = node.querySelector('.avatar-photo');
    if (!version) {
      if (image) image.remove();
      node.classList.remove('has-photo');
      return;
    }
    if (!image) {
      image = el('img', { class: 'avatar-photo', alt: '', 'aria-hidden': 'true' });
      node.append(image);
    }
    node.classList.add('has-photo');
    const src = '/api/groups/' + encodeURIComponent(group.id) + '/avatar?v=' + encodeURIComponent(version);
    if (image.dataset.avatarVersion !== String(version)) {
      image.dataset.avatarVersion = String(version);
      image.onerror = () => {
        if (node.dataset.avatarVersion === String(version)) {
          image.remove();
          node.classList.remove('has-photo');
        }
      };
      image.src = src;
    }
  }
  function groupMemberPreview(members) {
    const names = (members || []).map((member) => Number(member.id) === Number(state.me.id) ? 'You' : member.fullName);
    const shown = names.slice(0, 3);
    if (names.length > shown.length) shown.push('+' + (names.length - shown.length));
    return shown.join(', ');
  }
  function senderColorClass(userId) {
    const paletteSize = 6;
    const id = Number(userId) || 0;
    return 'group-sender-color-' + ((Math.abs(id) % paletteSize));
  }
    // ---------- shared photo cropper (drag + zoom) ----------
  let profileCropper = null, groupCropper = null;
  function makeCropper(canvas, slider) {
    const size = canvas.width;
    const ctx = canvas.getContext('2d');
    let img = null, w = 0, h = 0, base = 1, zoom = 1, x = 0, y = 0;
    const pointers = new Map();
    let pinchStart = null;
    const ratio = () => size / (canvas.getBoundingClientRect().width || size);
    const clamp = () => {
      x = Math.min(0, Math.max(size - w * base * zoom, x));
      y = Math.min(0, Math.max(size - h * base * zoom, y));
    };
    const draw = () => {
      if (!img) return;
      clamp();
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, x, y, w * base * zoom, h * base * zoom);
    };
    const setZoom = (next, cx = size / 2, cy = size / 2) => {
      next = Math.min(4, Math.max(1, next));
      const factor = next / zoom;
      x = cx - (cx - x) * factor;
      y = cy - (cy - y) * factor;
      zoom = next;
      slider.value = String(zoom);
      draw();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!img) return;
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev || !img) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const r = ratio();
        x += (e.clientX - prev.x) * r;
        y += (e.clientY - prev.y) * r;
        draw();
      } else if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist));
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      if (!img) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect(), r = ratio();
      setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), (e.clientX - rect.left) * r, (e.clientY - rect.top) * r);
    }, { passive: false });
    slider.addEventListener('input', () => { if (img) setZoom(Number(slider.value)); });
    const release = () => {
      if (img && typeof img.close === 'function') img.close();
      img = null;
      pointers.clear();
      pinchStart = null;
      ctx.clearRect(0, 0, size, size);
    };
    const load = (source) => {
      release();
      img = source;
      w = source.width || source.naturalWidth;
      h = source.height || source.naturalHeight;
      base = Math.max(size / w, size / h);
      zoom = 1;
      x = (size - w * base) / 2;
      y = (size - h * base) / 2;
      slider.value = '1';
      draw();
    };
    return { load, release };
  }
  function toast(msg) {
    const t = el('div', { class: 'toast', role: 'status', text: msg }); document.body.append(t); setTimeout(() => t.remove(), 3500);
  }
  const attendanceTime = (timestamp) => new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
  function attendanceDuration(start, end) {
    const minutes = Math.max(0, Math.floor((end - start) / 60000));
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  function renderAttendance() {
    const button = $('attendanceAction');
    const summary = $('attendanceSummary');
    const row = state.attendance;
    button.className = 'btn sm attendance-button';
    button.disabled = state.attendanceBusy || !state.me;
    if (!row) {
      button.textContent = 'Check In';
      button.classList.add('check-in');
      summary.textContent = '';
    } else if (row.checkOutAt) {
      button.textContent = 'Checked Out';
      button.classList.add('checked-out');
      button.disabled = true;
      summary.textContent = `In ${attendanceTime(row.checkInAt)} - Out ${attendanceTime(row.checkOutAt)} · ${attendanceDuration(row.checkInAt, row.checkOutAt)}`;
    } else {
      button.textContent = 'Check Out';
      button.classList.add('check-out');
      summary.textContent = `In: ${attendanceTime(row.checkInAt)}`;
    }
  }
  async function loadTodayAttendance(force) {
    if ((state.attendanceBusy && !force) || !state.me) return;
    try {
      state.attendance = (await api('/attendance/today')).attendance;
      renderAttendance();
    } catch (e) {
      if (e.status === 401) return location.replace('/login.html');
      toast(e.message || 'Could not load today’s attendance.');
    }
  }
  async function changeAttendance() {
    if (state.attendanceBusy) return;
    const checkingOut = !!state.attendance && !state.attendance.checkOutAt;
    if (checkingOut && !confirm('Are you sure you want to check out? You cannot check in again today.')) return;
    state.attendanceBusy = true;
    renderAttendance();
    try {
      const result = await api('/attendance/' + (checkingOut ? 'check-out' : 'check-in'), { method: 'POST', body: {} });
      state.attendance = result.attendance;
      toast(checkingOut ? 'Checked out.' : 'Checked in.');
    } catch (e) {
      if (e.status === 401) return location.replace('/login.html');
      if (e.status === 409) await loadTodayAttendance(true);
      toast(e.message || 'Could not update attendance.');
    } finally {
      state.attendanceBusy = false;
      renderAttendance();
    }
  }
  const withPresence = (u) => Object.assign(u, { online: state.online.has(u.id) });
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  function acknowledgeMessages(messages, kind) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    messages.forEach((message) => {
      if (message.senderId !== state.me.id) {
        state.ws.send(JSON.stringify({
          type: kind === 'group' ? 'group_delivered' : 'delivered',
          messageId: message.id,
        }));
      }
    });
  }

  // ---------- sidebar ----------
  function renderTotals() {
    const n = state.convs.reduce((s, c) => s + c.unread, 0) + state.groups.reduce((s, g) => s + g.unread, 0);
    const b = $('totalUnread'); b.textContent = n; b.classList.toggle('hidden', !n);
    document.title = (n ? '(' + n + ') ' : '') + 'Dixel Chat';
  }
  function renderList() {
    const list = $('list'); list.replaceChildren(); renderTotals();
    const q = $('q').value.trim().toLowerCase();
    if (state.tab === 'chats') {
      const items = [
        ...state.convs.filter((c) => !c.self && (!q || (c.other.fullName + ' ' + (c.other.department || '')).toLowerCase().includes(q)))
          .map((conversation) => ({ kind: 'direct', conversation, time: conversation.lastMessage.createdAt, sortId: conversation.lastMessage.id })),
        ...state.groups.filter((g) => !q || g.name.toLowerCase().includes(q))
          .map((group) => ({ kind: 'group', group, time: group.lastMessage ? group.lastMessage.createdAt : group.createdAt, sortId: group.lastMessage ? group.lastMessage.id : group.id })),
      ].sort((a, b) => b.time - a.time || b.sortId - a.sortId);
      const selfMatches = !q || ('you me ' + state.me.fullName).toLowerCase().includes(q);
      if (selfMatches && state.selfChat) {
        const c = state.selfChat;
        const name = el('span', { class: 'name' }, [document.createTextNode('You '), el('small', { text: '(Me)' })]);
        const button = el('button', {
          class: 'item', type: 'button',
          'aria-current': String(!!state.active && state.active.kind === 'direct' && state.active.self),
          onclick: () => openChat(c.other, c.id, true),
        }, [
          avatar(state.me, false, false),
          el('div', { class: 'meta' }, [
            el('div', { class: 'top' }, [name, el('span', { class: 'time', text: c.lastMessage ? listTime(c.lastMessage.createdAt) : '' })]),
            el('div', { class: 'prev' }, [el('span', { text: c.lastMessage ? 'You: ' + c.lastMessage.text.replace(/\s+/g, ' ') : 'Message yourself' })]),
          ]),
        ]);
        list.append(el('li', {}, [button]));
      }
      if (!items.length && !(selfMatches && state.selfChat)) {
        list.append(el('li', { class: 'empty' }, [el('b', { text: q ? 'No chats match your search' : 'No conversations yet' }),
          document.createTextNode(q ? 'Try the Employees tab to find a colleague.' : 'Open the Employees tab and pick a colleague to say hello.')]));
        return;
      }
      items.forEach((item) => {
        if (item.kind === 'group') {
          const g = item.group, last = g.lastMessage;
          const mine = last && last.senderId === state.me.id;
          const button = el('button', {
            class: 'item' + (g.unread ? ' unread' : ''), type: 'button',
            'aria-current': String(!!state.active && state.active.kind === 'group' && state.active.id === g.id),
            onclick: () => openGroup(g.id),
          }, [
            groupAvatar(g, 'list'),
            el('div', { class: 'meta' }, [
              el('div', { class: 'top' }, [
                el('span', { class: 'group-list-name' }, [
                  groupIcon('group-list-icon'),
                  el('span', { class: 'name', text: g.name }),
                ]),
                el('span', { class: 'time', text: listTime(last ? last.createdAt : g.createdAt) }),
              ]),
              el('div', { class: 'prev' }, [
                el('span', { text: last ? ((mine ? 'You: ' : (last.senderName + ': ')) + last.text.replace(/\s+/g, ' ')) : (g.memberCount + ' Members') }),
                g.unread ? el('span', { class: 'badge', text: g.unread }) : document.createTextNode(''),
              ]),
            ]),
          ]);
          list.append(el('li', {}, [button]));
          return;
        }
        const c = item.conversation;
        const mine = c.lastMessage.senderId === state.me.id;
        const btn = el('button', { class: 'item' + (c.unread ? ' unread' : ''), type: 'button', 'aria-current': String(!!state.active && state.active.kind === 'direct' && state.active.id === c.id), onclick: () => openChat(c.other, c.id) }, [
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
      const selfMatches = !!q && ('you ' + state.me.fullName).toLowerCase().includes(q);
      if (!state.people.length && !selfMatches) {
        list.append(el('li', { class: 'empty' }, [el('b', { text: q ? 'No employees found' : 'No colleagues registered yet' }),
          document.createTextNode(q ? 'Check the spelling or search by department.' : 'Approved employees will appear here.')]));
        return;
      }
      if (selfMatches && state.selfChat) {
        const name = el('span', { class: 'name' }, [document.createTextNode('You '), el('small', { text: '(Me)' })]);
        list.append(el('li', {}, [el('button', {
          class: 'item', type: 'button', onclick: () => openChat(state.selfChat.other, state.selfChat.id, true),
        }, [
          avatar(state.me, false, false),
          el('div', { class: 'meta' }, [name, el('div', { class: 'prev' }, [el('span', { text: 'Message yourself' })])]),
        ])]));
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
  async function loadConvs() {
    state.convs = (await api('/conversations')).conversations;
    state.selfChat = state.convs.find((c) => c.self) || null;
    state.convs.forEach((c) => { if (!c.self) withPresence(c.other); });
  }
  async function loadGroups() { state.groups = (await api('/groups')).groups; }
  async function loadPeople() {
    const q = $('q').value.trim();
    state.people = (await api('/employees?q=' + encodeURIComponent(q))).employees;
  }
  async function refreshSide() {
    try { if (state.tab === 'chats') await Promise.all([loadConvs(), loadGroups()]); else await loadPeople(); renderList(); }
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

  // ---------- profile ----------
  function renderProfileAvatar() {
    const node = $('profileAvatar');
    node.className = 'avatar av' + (state.me.id % 6) + ' profile-photo';
    node.textContent = initials(state.me.fullName);
    updateAvatar(node, state.me);
    $('chooseProfilePhoto').textContent = state.me.avatarVersion ? 'Change photo' : 'Upload photo';
    $('removeProfilePhoto').classList.toggle('hidden', !state.me.avatarVersion);
  }
  async function openProfile() {
    try {
      state.profile = (await api('/me/profile')).profile;
      state.profileDraft = { fullName: state.profile.fullName, department: state.profile.department || '' };
      state.profileEditing.clear();
      state.profileErrors = {};
      $('profileTitle').textContent = 'Profile';
      $('profileHome').classList.remove('hidden');
      $('profileCrop').classList.add('hidden');
      $('profilePhotoMenu').classList.add('hidden');
      $('profileCamera').setAttribute('aria-expanded', 'false');
      renderProfileAvatar();
      renderProfileDetails();
      if (!$('profileDialog').open) $('profileDialog').showModal();
    } catch (e) { handleErr(e); }
  }
  function profileLength(value) {
    return Array.from(value).length;
  }
  function validateProfileDraft() {
    const errors = {};
    const fullName = state.profileDraft.fullName.trim().normalize('NFC');
    const nameLength = profileLength(fullName);
    if (nameLength < 2 || nameLength > 60 || !/^[\p{L}\p{M} .'-]+$/u.test(fullName)) {
      errors.fullName = 'Use 2 to 60 letters, spaces, dots, hyphens, or apostrophes.';
    }
    const department = state.profileDraft.department.trim();
    if (profileLength(department) > 80 || /[<>]/.test(department)) {
      errors.department = 'Department must be 80 characters or fewer and cannot contain HTML.';
    }
    state.profileErrors = errors;
    ['fullName', 'department'].forEach((field) => {
      const message = $('profile' + field[0].toUpperCase() + field.slice(1) + 'Error');
      if (message) message.textContent = errors[field] || '';
      const input = $('profile' + field[0].toUpperCase() + field.slice(1));
      if (input) {
        if (errors[field]) {
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', message.id);
        } else {
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
        }
      }
    });
    updateProfileActions();
    return errors;
  }
  function profileHasChanges() {
    return !!state.profileDraft && (
      state.profileDraft.fullName.trim().normalize('NFC') !== state.profile.fullName ||
      (state.profileDraft.department.trim().normalize('NFC') || '') !== (state.profile.department || '')
    );
  }
  function updateProfileActions() {
    $('profileEditActions').classList.toggle('hidden', !profileHasChanges());
  }
  function profileEditButton(field, label) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm14 5 5 5M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z');
    icon.append(path);
    return el('button', { class: 'profile-edit-button', type: 'button', 'aria-label': 'Edit ' + label, title: 'Edit ' + label,
      onclick: () => {
        state.profileEditing.add(field);
        renderProfileDetails();
        $('profile' + field[0].toUpperCase() + field.slice(1)).focus();
      } }, [icon]);
  }
  function renderProfileDetails() {
    if (!state.profile) return;
    const rows = [
      { field: 'fullName', label: 'Full name', editable: true, value: state.profile.fullName },
      { field: 'email', label: 'Email', value: state.profile.email },
      { field: 'employeeId', label: 'Employee ID', value: state.profile.employeeId || '-' },
      { field: 'department', label: 'Department', editable: true, value: state.profile.department || '-' },
    ];
    $('profileDetails').replaceChildren(...rows.map((row) => {
      const editing = row.editable && state.profileEditing.has(row.field);
      const value = editing
        ? el('input', {
          class: 'profile-edit-input', id: 'profile' + row.field[0].toUpperCase() + row.field.slice(1),
          'aria-label': row.label,
          type: 'text', maxlength: row.field === 'fullName' ? '60' : '80',
          value: state.profileDraft[row.field],
          oninput: (event) => {
            state.profileDraft[row.field] = event.target.value;
            validateProfileDraft();
          },
        })
        : el('span', { class: row.editable ? 'profile-value' : 'profile-value profile-readonly', text: row.value });
      const error = editing ? el('div', {
        class: 'profile-detail-error', id: 'profile' + row.field[0].toUpperCase() + row.field.slice(1) + 'Error',
        role: 'alert', text: state.profileErrors[row.field] || '',
      }) : null;
      const valueRow = el('dd', {}, [value]);
      if (row.editable) {
        if (!editing) valueRow.append(profileEditButton(row.field, row.label));
      }
      const detail = el('dl', { class: 'profile-detail' }, [el('dt', { text: row.label }), valueRow]);
      if (error) detail.append(error);
      return detail;
    }));
    updateProfileActions();
  }
  async function saveProfileDetails() {
    const errors = validateProfileDraft();
    if (Object.keys(errors).length) return;
    const changes = {};
    const fullName = state.profileDraft.fullName.trim().normalize('NFC');
    if (fullName !== state.profile.fullName) changes.fullName = fullName;
    const department = state.profileDraft.department.trim().normalize('NFC');
    if (department !== (state.profile.department || '')) changes.department = department;
    if (!Object.keys(changes).length) return;
    const button = $('saveProfileEdit');
    button.disabled = true;
    try {
      const result = await api('/me/profile', { method: 'PATCH', body: changes });
      state.profile = result.profile;
      state.profileDraft = { fullName: result.profile.fullName, department: result.profile.department || '' };
      state.profileEditing.clear();
      state.profileErrors = {};
      applyProfileUpdate(state.me.id, result.profile.fullName, result.profile.department);
      renderProfileDetails();
      toast('Profile updated');
    } catch (e) {
      if (e.data && e.data.errors) {
        state.profileErrors = e.data.errors;
        validateProfileDraft();
      } else handleErr(e);
    } finally { button.disabled = false; }
  }
  function cancelProfileEdit() {
    state.profileDraft = { fullName: state.profile.fullName, department: state.profile.department || '' };
    state.profileEditing.clear();
    state.profileErrors = {};
    renderProfileDetails();
  }
  function applyProfileUpdate(userId, fullName, department) {
    userId = Number(userId);
    const update = (user) => {
      if (user && Number(user.id) === userId) {
        user.fullName = fullName;
        user.department = department;
      }
    };
    update(state.me);
    state.people.forEach(update);
    state.convs.forEach((conversation) => update(conversation.other));
    if (state.selfChat) update(state.selfChat.other);
    if (state.active && state.active.kind === 'direct') update(state.active.other);
    if (state.active && state.active.kind === 'group') {
      (state.active.group.members || []).forEach(update);
    }
    state.groups.forEach((group) => {
      if (group.lastMessage && Number(group.lastMessage.senderId) === userId) group.lastMessage.senderName = fullName;
    });
    document.querySelectorAll('.avatar[data-user-id]').forEach((node) => {
      if (Number(node.dataset.userId) !== userId) return;
      const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.nodeValue = initials(fullName);
    });
    state.messages.forEach((message) => {
      if (Number(message.senderId) === userId && message.senderName !== undefined) message.senderName = fullName;
    });
    if (Number(state.me.id) === userId) {
      $('meName').textContent = fullName;
      $('meDept').textContent = department || state.me.email;
      $('meAvatar').textContent = initials(fullName);
      if (state.profile) {
        state.profile.fullName = fullName;
        state.profile.department = department;
        if (!state.profileEditing.size) state.profileDraft = { fullName, department: department || '' };
      }
    }
    if (state.active && state.active.kind === 'direct' && !state.active.self && Number(state.active.other.id) === userId) {
      const title = document.querySelector('.pane-head .t b');
      if (title) title.textContent = fullName;
      updateSubtitle();
    }
    if (state.tab === 'people') loadPeople().then(renderList).catch(handleErr);
    else if (state.tab === 'chats') renderList();
    if (state.active && state.active.kind === 'group') renderMessages(false);
    if (state.memberDialogGroupId && $('groupMembersDialog').open) openGroupMembers();
    if (Number(state.me.id) === userId && $('profileDialog').open) renderProfileDetails();
  }
  function loadProfileImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image.')); };
      image.src = url;
    });
  }
    async function readProfileFile(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    try {
      const bitmap = typeof createImageBitmap === 'function'
        ? await createImageBitmap(file) : await loadProfileImage(file);
      profileCropper.load(bitmap);
      state.profilePhotoReady = true;
      $('profilePhotoMenu').classList.add('hidden');
      $('profileCamera').setAttribute('aria-expanded', 'false');
      $('profileCrop').classList.remove('hidden');
    } catch (e) {
      toast('This image could not be opened. Choose another image.');
    }
  }
  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare the image.')), 'image/jpeg', quality);
    });
  }
  async function compressProfilePhoto() {
    const preview = $('profileCropCanvas');
    for (const size of [256, 224, 192, 160, 128]) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.getContext('2d').drawImage(preview, 0, 0, size, size);
      for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size < 150 * 1024) return blob;
      }
    }
    throw new Error('This image could not be compressed below 150 KB.');
  }
  async function saveProfilePhoto() {
    if (!state.profilePhotoReady) return;
    const button = $('saveProfilePhoto');
    button.disabled = true;
    try {
      const blob = await compressProfilePhoto();
      const response = await fetch('/api/me/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Requested-With': 'dixel' },
        credentials: 'same-origin',
        body: blob,
      });
      let result = {};
      try { result = await response.json(); } catch (e) { /* non-JSON */ }
      if (!response.ok) throw new Error(result.message || 'Profile picture upload failed.');
      applyAvatarUpdate(state.me.id, result.avatarVersion);
      cancelProfileCrop();
      $('profilePhotoMenu').classList.add('hidden');
      toast('Profile picture updated.');
    } catch (e) { toast(e.message || 'Profile picture upload failed.'); }
    finally { button.disabled = false; }
  }
    function cancelProfileCrop() {
    state.profilePhotoReady = false;
    profileCropper.release();
    $('profileCrop').classList.add('hidden');
    $('profilePhotoInput').value = '';
  }
  async function removeProfilePhoto() {
    try {
      const result = await api('/me/avatar', { method: 'DELETE' });
      applyAvatarUpdate(state.me.id, result.avatarVersion);
      $('profilePhotoMenu').classList.add('hidden');
      $('profileCamera').setAttribute('aria-expanded', 'false');
      toast('Profile picture removed.');
    } catch (e) { handleErr(e); }
  }
  function applyAvatarUpdate(userId, avatarVersion) {
    userId = Number(userId);
    const update = (user) => {
      if (user && Number(user.id) === userId) user.avatarVersion = avatarVersion || null;
    };
    update(state.me);
    state.people.forEach(update);
    state.convs.forEach((conversation) => update(conversation.other));
    if (state.selfChat) update(state.selfChat.other);
    if (state.active && state.active.kind === 'direct') update(state.active.other);
    if (state.active && state.active.kind === 'group') {
      (state.active.group.members || []).forEach(update);
    }
    state.messages.forEach((message) => {
      if (Number(message.senderId) === userId) message.avatarVersion = avatarVersion || null;
    });
    document.querySelectorAll('.avatar[data-user-id]').forEach((node) => {
      if (Number(node.dataset.userId) === userId) updateAvatar(node, { id: userId, avatarVersion });
    });
    if (state.tab === 'chats' || state.tab === 'people') renderList();
    if (state.active && state.active.kind === 'group') renderMessages(false);
    if ($('profileDialog').open) renderProfileAvatar();
  }

  // ---------- conversation pane ----------
  function buildPane(other, self = false) {
    const view = $('chatView'); view.replaceChildren();
    const head = el('div', { class: 'pane-head' }, [
      el('button', { class: 'back', type: 'button', 'aria-label': 'Back to conversations', onclick: closeChat }, [
        el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [el('path', { d: 'm14 5-7 7 7 7M7 12h14' })]),
      ]),
      avatar(other, true, false),
      el('div', { class: 't' }, [el('b', { text: self ? 'You' : other.fullName }), el('span', { id: 'subtitle' })]),
      headerMenu(),
    ]);
    const conn = el('div', { class: 'conn hidden', id: 'conn', role: 'status', text: 'Reconnecting…' });
    const unavailable = el('div', { class: 'availability hidden', id: 'unavailable', role: 'status', text: 'This employee is no longer available' });
    const msgs = el('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' });
    const ta = el('textarea', { id: 'composerText', rows: '1', maxlength: '4000', placeholder: 'Type a message', 'aria-label': 'Message' });
    const send = el('button', { class: 'btn send-button', id: 'sendBtn', type: 'button', 'aria-label': 'Send message' }, [
      el('img', { class: 'send-icon', src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23fff' d='M2.01 21 23 12 2.01 3 2 10l15 2-15 2z'/%3E%3C/svg%3E", alt: '' }),
      el('span', { class: 'send-label sr', text: 'Send' }),
    ]);
    const composer = el('div', { class: 'composer' }, [composerEmojiButton(ta), ta, send]);
    view.append(head, unavailable, conn, msgs, composer);
    view.className = 'chatview';
    $('paneEmpty').classList.add('hidden');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    ta.addEventListener('input', onTyping);
    send.addEventListener('click', sendMessage);
    updateSubtitle();
  }
  function updateSubtitle() {
    const s = $('subtitle'); if (!s || !state.active || state.active.kind !== 'direct') return;
    if (state.active.self) { s.textContent = 'Message yourself'; return; }
    const o = state.active.other;
    const online = state.online.has(o.id);
    s.textContent = state.otherTyping ? 'typing…' : o.available === false ? 'This employee is no longer available' :
      (o.department ? o.department + ' · ' : '') + (online ? 'Online' : o.lastSeenAt ? 'Last seen ' + dayLabel(o.lastSeenAt).toLowerCase() + ' ' + fmtTime(o.lastSeenAt) : 'Offline');
  }
  function closeChat() {
    closeEmojiUi();
    stopTyping();
    clearTimeout(state.otherTypingTimer);
    state.otherTyping = false;
    state.active = null; state.messages = [];
    $('app').classList.remove('chat-open'); $('chatView').classList.add('hidden'); $('paneEmpty').classList.remove('hidden');
    renderList();
  }
  async function openChat(other, convId, self = false) {
    try {
      closeEmojiUi();
      stopTyping();
      clearTimeout(state.otherTypingTimer);
      state.otherTyping = false;
      if (!convId) convId = (await api('/conversations', { method: 'POST', body: { userId: other.id } })).conversation.id;
      const activeOther = self ? Object.assign({}, other, { online: false, lastSeenAt: null, available: true }) : withPresence(other);
      state.active = { kind: 'direct', id: convId, other: activeOther, self };
      buildPane(activeOther, self);
      $('app').classList.add('chat-open');
      await loadMessages();
      if (!self) markRead();
      renderList();
      $('composerText').focus({ preventScroll: true });
    } catch (e) { handleErr(e); }
  }
  function buildGroupPane(group) {
    const view = $('chatView'); view.replaceChildren();
    const head = el('div', { class: 'pane-head' }, [
      el('button', { class: 'back', type: 'button', 'aria-label': 'Back to conversations', onclick: closeChat }, [
        el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [el('path', { d: 'm14 5-7 7 7 7M7 12h14' })]),
      ]),
      groupAvatar(group, 'sm'),
      el('div', { class: 't' }, [
        el('b', { text: group.name }),
        el('span', { id: 'groupSubtitle', text: (group.members ? group.members.length : group.memberCount) + ' Members' }),
        el('span', { class: 'group-preview', id: 'groupPreview', text: groupMemberPreview(group.members) }),
      ]),
      el('button', { class: 'iconbtn', id: 'groupMembersButton', type: 'button', onclick: openGroupMembers }, ['Members']),
      headerMenu(),
    ]);
    const conn = el('div', { class: 'conn hidden', id: 'conn', role: 'status', text: 'Reconnecting…' });
    const msgs = el('div', { class: 'msgs', id: 'msgs', 'aria-live': 'polite' });
    const ta = el('textarea', { id: 'composerText', rows: '1', maxlength: '4000', placeholder: 'Type a message', 'aria-label': 'Message' });
    const send = el('button', { class: 'btn send-button', id: 'sendBtn', type: 'button', 'aria-label': 'Send message' }, [
      el('img', { class: 'send-icon', src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23fff' d='M2.01 21 23 12 2.01 3 2 10l15 2-15 2z'/%3E%3C/svg%3E", alt: '' }),
      el('span', { class: 'send-label sr', text: 'Send' }),
    ]);
    view.append(head, conn, msgs, el('div', { class: 'composer' }, [composerEmojiButton(ta), ta, send]));
    view.className = 'chatview';
    $('paneEmpty').classList.add('hidden');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    ta.addEventListener('input', onTyping);
    send.addEventListener('click', sendMessage);
  }
  async function openGroup(groupId) {
    try {
      closeEmojiUi();
      stopTyping();
      clearTimeout(state.otherTypingTimer);
      state.otherTyping = false;
      const group = state.groups.find((g) => g.id === groupId);
      if (!group) {
        await loadGroups();
        const found = state.groups.find((g) => g.id === groupId);
        if (!found) return toast('This group is no longer available.');
        return openGroup(groupId);
      }
      state.active = { kind: 'group', id: groupId, group };
      state.messages = [];
      buildGroupPane(group);
      $('app').classList.add('chat-open');
      await loadGroupMessages();
      markRead();
      renderList();
      $('composerText').focus({ preventScroll: true });
    } catch (e) { handleErr(e); }
  }
  async function loadMessages() {
    if (!state.active) return;
    const r = await api('/conversations/' + state.active.id + '/messages?limit=50');
    state.messages = r.messages; state.hasMore = r.hasMore; state.otherRead = r.otherLastReadId;
    acknowledgeMessages(r.messages, 'direct');
    state.firstUnreadId = r.firstUnreadMessageId;
    Object.assign(state.active.other, { lastSeenAt: r.other.lastSeenAt });
    renderMessages(true); updateSubtitle();
  }
  async function loadGroupMessages() {
    if (!state.active || state.active.kind !== 'group') return;
    const r = await api('/groups/' + state.active.id + '/messages?limit=50');
    state.messages = r.messages;
    acknowledgeMessages(r.messages, 'group');
    state.hasMore = r.hasMore;
    state.firstUnreadId = r.firstUnreadMessageId;
    state.active.group = Object.assign(state.active.group, r.group);
    const listGroup = state.groups.find((g) => g.id === state.active.id);
    if (listGroup) {
      listGroup.memberCount = r.group.members.length;
      listGroup.avatarVersion = r.group.avatarVersion;
    }
    $('groupSubtitle').textContent = r.group.members.length + ' Members';
    $('groupPreview').textContent = groupMemberPreview(r.group.members);
    const headerAvatar = document.querySelector('.pane-head .group-avatar');
    if (headerAvatar) updateGroupAvatar(headerAvatar, state.active.group);
    renderMessages(true);
  }
  async function loadOlder() {
    const first = state.messages[0]; if (!first) return;
    const box = $('msgs'), prevH = box.scrollHeight;
    const path = state.active.kind === 'group' ? '/groups/' + state.active.id + '/messages' : '/conversations/' + state.active.id + '/messages';
    const r = await api(path + '?limit=50&before=' + first.id);
    acknowledgeMessages(r.messages, state.active.kind);
    state.messages = r.messages.concat(state.messages); state.hasMore = r.hasMore;
    renderMessages(false); box.scrollTop = box.scrollHeight - prevH;
  }
  function renderMessages(stick) {
    const box = $('msgs'); if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.replaceChildren();
    if (state.hasMore) box.append(el('button', { class: 'btn ghost sm older', type: 'button', text: 'Load earlier messages', onclick: () => loadOlder().catch(handleErr) }));
    if (!state.messages.length) box.append(el('div', { class: 'empty' }, [el('b', { text: 'No messages yet' }), document.createTextNode(state.active.kind === 'group' ? 'Send the first message to ' + state.active.group.name + '.' : state.active.self ? 'Write a note to yourself.' : 'Say hello to ' + state.active.other.fullName.split(' ')[0] + '.')]));
    let lastDay = '';
    state.messages.forEach((m) => {
      const d = dayLabel(m.createdAt);
      if (d !== lastDay) { box.append(el('div', { class: 'day', text: d })); lastDay = d; }
      const mine = Number(m.senderId) === Number(state.me.id);
      const ts = el('span', { class: 'ts', text: fmtTime(m.createdAt) });
      if (m.editedAt && !m.deleted) ts.append(el('span', { class: 'edited', text: 'edited' }));
      if (mine && state.active.kind === 'direct' && state.active.self && !m.deleted) {
        ts.append(el('span', { class: 'tick read', 'aria-label': 'Seen' }, [
          el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
            el('path', { d: 'm4 12 4 4L16 8' }),
            el('path', { d: 'm9 12 4 4 7-8' }),
          ]),
        ]));
      } else if (mine && state.active.kind === 'direct' && !state.active.self && state.active.other.id !== state.me.id) {
        const read = !!m.readAt || m.id <= state.otherRead;
        const delivered = read || !!m.deliveredAt;
        const tickPaths = [el('path', { d: 'm4 12 4 4L16 8' })];
        if (delivered) tickPaths.push(el('path', { d: 'm9 12 4 4 7-8' }));
        ts.append(el('span', { class: 'tick' + (read ? ' read' : ''), 'aria-label': read ? 'Seen' : delivered ? 'Delivered' : 'Sent' }, [
          el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, tickPaths),
        ]));
      } else if (mine && state.active.kind === 'group') {
        const delivered = !!m.deliveredAt, read = !!m.readAt;
        const tickPaths = [el('path', { d: 'm4 12 4 4L16 8' })];
        if (delivered) tickPaths.push(el('path', { d: 'm9 12 4 4 7-8' }));
        ts.append(el('span', { class: 'tick' + (read ? ' read' : ''), 'aria-label': read ? 'Seen by all' : delivered ? 'Delivered to all' : 'Sent' }, [
          el('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, tickPaths),
        ]));
      }
      // textContent only: message text is never interpreted as HTML
      const content = [];
      if (state.active.kind === 'group') {
        const sender = { id: m.senderId, fullName: m.senderName || (mine ? state.me.fullName : 'Employee'), avatarVersion: m.avatarVersion };
        content.push(el('span', { class: 'group-sender' }, [
          avatar(sender, true, false),
          el('b', { class: senderColorClass(sender.id), text: mine ? 'You' : sender.fullName }),
        ]));
      }
      content.push(document.createTextNode(m.text), ts);
      const bubble = el('div', { class: 'bub' + (mine ? ' me' : '') + (m.deleted ? ' deleted' : ''), 'data-message-id': m.id }, content);
      bubble.append(messageActions(m, mine, state.active.kind));
      if (!m.deleted) {
        bubble.append(reactionTrigger(m, bubble));
      }
      box.append(bubble);
      if (!m.deleted) updateReactionDom(m);
    });
    if (stick && state.firstUnreadId) {
      const firstUnread = box.querySelector('[data-message-id="' + state.firstUnreadId + '"]');
      if (firstUnread) box.scrollTop = firstUnread.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
      else box.scrollTop = box.scrollHeight;
      state.firstUnreadId = null;
    } else if (stick || nearBottom) box.scrollTop = box.scrollHeight;
  }
  function headerMenu(kind) {
    const wrap = el('div', { class: 'header-menu-wrap' });
    const toggle = el('button', { class: 'iconbtn', type: 'button', text: 'More', 'aria-label': 'Chat options', 'aria-expanded': 'false' });
    const menu = el('div', { class: 'message-menu header-menu hidden' });
    toggle.addEventListener('click', () => {
      const open = menu.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
    });
    const clear = el('button', { type: 'button', text: 'Clear chat' });
    clear.addEventListener('click', async () => {
      menu.classList.add('hidden');
      if (!state.active || !confirm('Clear messages from this chat for you? This cannot be undone.')) return;
      const active = state.active;
      try {
        await api(active.kind === 'group' ? '/groups/' + active.id + '/clear' : '/conversations/' + active.id + '/clear', { method: 'POST', body: {} });
        state.messages = [];
        state.hasMore = false;
        renderMessages(true);
        await refreshSide();
      } catch (e) { handleErr(e); }
    });
    menu.append(clear);
    wrap.append(toggle, menu);
    return wrap;
  }
    function messageActions(message, mine, kind) {
    const wrap = el('div', { class: 'message-actions' });
    const toggle = el('button', { class: 'message-menu-toggle', type: 'button', 'aria-label': 'Message actions', 'aria-expanded': 'false' }, [
      el('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [el('path', { d: 'm4 6 4 4 4-4' })]),
    ]);
    const menu = el('div', { class: 'message-menu hidden' });
    const path = kind === 'group'
      ? '/groups/' + state.active.id + '/messages/' + message.id
      : '/conversations/' + state.active.id + '/messages/' + message.id;
    const close = () => { menu.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); };
    const showMenu = () => {
      menu.classList.remove('hidden');
      toggle.setAttribute('aria-expanded', 'true');
    };
    const addAction = (label, action) => {
      const button = el('button', { type: 'button', text: label });
      button.addEventListener('click', async () => { close(); await action(); });
      menu.append(button);
    };

    // Main view: always built fresh (Edit + Delete)
    const buildMainMenu = () => {
      menu.replaceChildren();
      if (mine && !message.deleted && Date.now() - message.createdAt <= 15 * 60 * 1000) {
        addAction('Edit', async () => {
          const text = prompt('Edit message', message.text);
          if (text == null || !text.trim()) return;
          try {
            const result = await api(path, { method: 'PATCH', body: { text } });
            applyMessageChange(result.message, kind);
          } catch (e) { toast(e.message); }
        });
      }
      addAction('Delete', showDeleteChoices);
    };

    // Delete view: Delete for me / Delete for everyone / Cancel
    const showDeleteChoices = () => {
      const canDeleteEveryone = mine && !message.deleted && Date.now() - message.createdAt <= 60 * 60 * 1000;
      menu.replaceChildren();
      addAction('Delete for me', async () => {
        try {
          await api(path + '/delete', { method: 'POST', body: { mode: 'me' } });
          state.messages = state.messages.filter((item) => item.id !== message.id);
          renderMessages(false);
          await refreshSide();
        } catch (e) { toast(e.message); }
      });
      if (canDeleteEveryone) {
        addAction('Delete for everyone', async () => {
          if (!confirm('Delete this message for everyone?')) return;
          try {
            const result = await api(path + '/delete', { method: 'POST', body: { mode: 'everyone' } });
            applyMessageChange(result.message, kind);
          } catch (e) { toast(e.message); }
        });
      }
      addAction('Cancel', async () => { buildMainMenu(); }); // reset to Edit + Delete
      showMenu();
    };

    buildMainMenu();

    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      if (willOpen) buildMainMenu(); // every time the menu opens, start from Edit + Delete
      menu.classList.toggle('hidden', !willOpen);
      toggle.setAttribute('aria-expanded', String(willOpen));
    });
    wrap.append(toggle, menu);
    return wrap;
  }
  function applyMessageChange(message, kind) {
    const activeMatches = state.active && state.active.kind === kind &&
      state.active.id === (kind === 'group' ? message.groupId : message.conversationId);
    if (activeMatches) {
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) state.messages[index] = message;
    }
    if (kind === 'group') {
      const group = state.groups.find((item) => item.id === message.groupId);
      if (group && group.lastMessage && group.lastMessage.id === message.id) group.lastMessage = message;
    } else {
      const conv = state.convs.find((item) => item.id === message.conversationId);
      if (conv && conv.lastMessage && conv.lastMessage.id === message.id) conv.lastMessage = message;
    }
    if (activeMatches) renderMessages(false);
    renderList();
  }
  function applyMessageStatus(event) {
    if (event.scope === 'group') {
      const activeMatches = state.active && state.active.kind === 'group' && state.active.id === event.groupId;
      if (activeMatches) {
        const message = state.messages.find((item) => item.id === event.messageId);
        if (message) {
          message.deliveredAt = event.deliveredAt;
          message.readAt = event.readAt;
        }
      }
      const group = state.groups.find((item) => item.id === event.groupId);
      if (group && group.lastMessage && group.lastMessage.id === event.messageId) {
        group.lastMessage.deliveredAt = event.deliveredAt;
        group.lastMessage.readAt = event.readAt;
      }
      if (event.readByUserId === state.me.id && group) group.unread = 0;
      if (activeMatches) renderMessages(false);
    } else {
      const activeMatches = state.active && state.active.kind === 'direct' && state.active.id === event.conversationId;
      (event.updates || []).forEach((update) => {
        if (activeMatches) {
          const message = state.messages.find((item) => item.id === update.messageId);
          if (message) Object.assign(message, update);
        }
        const conversation = state.convs.find((item) => item.id === event.conversationId);
        if (conversation && conversation.lastMessage.id === update.messageId) Object.assign(conversation.lastMessage, update);
      });
      if (event.readByUserId === state.me.id) {
        const conversation = state.convs.find((item) => item.id === event.conversationId);
        if (conversation) conversation.unread = 0;
      }
      if (activeMatches) renderMessages(false);
    }
    renderList();
  }
  function applyMessageHidden(event) {
    if (event.userId !== state.me.id) return;
    const activeMatches = state.active &&
      ((event.scope === 'group' && state.active.kind === 'group' && state.active.id === event.groupId) ||
       (event.scope !== 'group' && state.active.kind === 'direct' && state.active.id === event.conversationId));
    if (activeMatches) {
      state.messages = state.messages.filter((message) => message.id !== event.messageId);
      renderMessages(false);
    }
    refreshSide();
  }
  function applyMessageReaction(event) {
    const activeMatches = state.active &&
      ((event.scope === 'group' && state.active.kind === 'group' && state.active.id === event.groupId) ||
       (event.scope === 'direct' && state.active.kind === 'direct' && state.active.id === event.conversationId));
    if (!activeMatches) return;
    const message = state.messages.find((item) => Number(item.id) === Number(event.messageId));
    if (!message || message.deleted) return;
    message.reactions = event.reactions || [];
    updateReactionDom(message);
  }
  function applyChatCleared(event) {
    if (event.userId !== state.me.id) return;
    const activeMatches = state.active &&
      ((event.scope === 'group' && state.active.kind === 'group' && state.active.id === event.groupId) ||
       (event.scope !== 'group' && state.active.kind === 'direct' && state.active.id === event.conversationId));
    if (activeMatches) {
      state.messages = [];
      state.hasMore = false;
      renderMessages(true);
    }
    refreshSide();
  }
  async function sendMessage() {
    const ta = $('composerText'), btn = $('sendBtn');
    const text = ta.value.trim(); if (!text || !state.active) return;
    closeEmojiUi();
    const active = state.active;
    stopTyping();
    btn.disabled = true;
    try {
      const clientId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()).toString();
      const path = active.kind === 'group' ? '/groups/' + active.id + '/messages' : '/conversations/' + active.id + '/messages';
      const r = await api(path, { method: 'POST', body: active.kind === 'group' ? { text } : { text, clientId } });
      ta.value = '';
      if (active.kind === 'group') addGroupMessage(r.message); else addMessage(r.message);
    } catch (e) { handleErr(e); } finally { btn.disabled = false; ta.focus(); }
  }
  function sendTyping(typing) {
    if (!state.active || state.active.kind !== 'direct' || state.active.self || state.active.other.available === false || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type: 'typing', conversationId: state.active.id, typing }));
  }
  function onTyping() {
    if (!state.active || state.active.kind !== 'direct' || state.active.other.available === false) return;
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
    state.convs = state.convs.filter((c) => c.self || c.other.id !== userId);
    if (state.active && state.active.kind === 'direct' && !state.active.self && state.active.other.id === userId) {
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
    if (m.senderId !== state.me.id && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'delivered', messageId: m.id }));
    }
    if (state.active && state.active.kind === 'direct' && m.conversationId === state.active.id && !state.messages.some((x) => x.id === m.id)) {
      state.messages.push(m); state.messages.sort((a, b) => a.id - b.id); renderMessages(m.senderId === state.me.id);
      if (m.senderId !== state.me.id) markRead();
    }
    upsertConv(m);
  }
  function addGroupMessage(m) {
    if (m.senderId !== state.me.id && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'group_delivered', messageId: m.id }));
    }
    if (state.active && state.active.kind === 'group' && m.groupId === state.active.id && !state.messages.some((x) => x.id === m.id)) {
      state.messages.push(m);
      state.messages.sort((a, b) => a.id - b.id);
      renderMessages(m.senderId === state.me.id);
      if (m.senderId !== state.me.id) markRead();
    }
    upsertGroup(m);
  }
  function upsertConv(m) {
    let c = state.convs.find((x) => x.id === m.conversationId);
    const viewing = state.active && state.active.kind === 'direct' && state.active.id === m.conversationId && !document.hidden;
    if (!c) { loadConvs().then(renderList).catch(() => {}); return; }
    if (!c.lastMessage || m.id >= c.lastMessage.id) c.lastMessage = m;
    if (!c.self && m.senderId !== state.me.id && !viewing) c.unread += 1;
    state.convs.sort((a, b) => (b.lastMessage ? b.lastMessage.id : 0) - (a.lastMessage ? a.lastMessage.id : 0));
    if (state.tab === 'chats') renderList(); else renderTotals();
  }
  function upsertGroup(m) {
    const g = state.groups.find((x) => x.id === m.groupId);
    const viewing = state.active && state.active.kind === 'group' && state.active.id === m.groupId && !document.hidden;
    if (!g) {
      loadGroups().then(renderList).catch(handleErr);
      return;
    }
    if (!g.lastMessage || m.id >= g.lastMessage.id) g.lastMessage = m;
    if (m.senderId !== state.me.id && !viewing) g.unread += 1;
    state.groups.sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : b.createdAt) - (a.lastMessage ? a.lastMessage.createdAt : a.createdAt));
    if (state.tab === 'chats') renderList(); else renderTotals();
  }
  const markRead = debounce(async () => {
    if (!state.active || state.active.self || document.hidden) return;
    const last = [...state.messages].reverse().find((m) => m.senderId !== state.me.id); if (!last) return;
    try {
      if (state.active.kind === 'group') {
        await api('/groups/' + state.active.id + '/read', { method: 'POST', body: { lastReadMessageId: last.id } });
        const group = state.groups.find((g) => g.id === state.active.id);
        if (group) group.unread = 0;
        if (state.tab === 'chats') renderList(); else renderTotals();
        return;
      }
      if (state.active.other.available === false) return;
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
      if (d.type === 'user_avatar_updated') applyAvatarUpdate(d.userId, d.avatarVersion);
      else if (d.type === 'user_profile_updated') applyProfileUpdate(d.userId, d.fullName, d.department);
      else if (d.type === 'group_avatar_updated') applyGroupAvatarUpdate(d.groupId, d.avatarVersion);
      else if (d.type === 'ready') { state.online = new Set(d.online); refreshPresence(); }
      else if (d.type === 'presence') {
        d.online ? state.online.add(d.userId) : state.online.delete(d.userId);
        if (state.active && state.active.kind === 'direct' && state.active.other.id === d.userId && d.lastSeenAt) state.active.other.lastSeenAt = d.lastSeenAt;
        refreshPresence();
      } else if (d.type === 'message') addMessage(d.message);
      else if (d.type === 'group_message') addGroupMessage(d.message);
      else if (d.type === 'message_status') applyMessageStatus(d);
      else if (d.type === 'message_edited') applyMessageChange(d.message, d.scope === 'group' ? 'group' : 'direct');
      else if (d.type === 'message_deleted') applyMessageChange(d.message, d.scope === 'group' ? 'group' : 'direct');
      else if (d.type === 'message_reaction') applyMessageReaction(d);
      else if (d.type === 'message_hidden') applyMessageHidden(d);
      else if (d.type === 'chat_cleared') applyChatCleared(d);
      else if (d.type === 'group_created') {
        loadGroups().then(renderList).catch(handleErr);
      } else if (d.type === 'group_member_added') {
        loadGroups().then(() => {
          renderList();
          if (state.active && state.active.kind === 'group' && state.active.id === d.groupId) openGroupMembers();
        }).catch(handleErr);
      } else if (d.type === 'group_member_removed') {
        if (d.userId === state.me.id) {
          state.groups = state.groups.filter((g) => g.id !== d.groupId);
          if (state.active && state.active.kind === 'group' && state.active.id === d.groupId) closeChat();
          const dialog = $('groupMembersDialog');
          if (dialog.open && state.memberDialogGroupId === d.groupId) dialog.close();
          renderList();
        } else {
          loadGroups().then(() => {
            renderList();
            if (state.active && state.active.kind === 'group' && state.active.id === d.groupId) openGroupMembers();
          }).catch(handleErr);
        }
      } else if (d.type === 'group_deleted') {
        const deletedId = Number(d.groupId);
        state.groups = state.groups.filter((g) => Number(g.id) !== deletedId);
        const dialog = $('groupMembersDialog');
        if (dialog.open && Number(state.memberDialogGroupId) === deletedId) dialog.close();
        if (state.active && state.active.kind === 'group' && Number(state.active.id) === deletedId) closeChat();
        renderList();
        toast('This group was deleted by the administrator.');
      }
      else if (d.type === 'typing' && state.active && state.active.kind === 'direct' && state.active.id === d.conversationId && d.userId === state.active.other.id) updateOtherTyping(d.typing === true);
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
    state.convs.forEach((c) => { if (!c.self) withPresence(c.other); }); state.people.forEach(withPresence);
    if (state.active && state.active.kind === 'direct' && !state.active.self) withPresence(state.active.other);
    renderList(); updateSubtitle();
  }
  async function resync() { // recover anything missed while disconnected
    try {
      await Promise.all([loadConvs(), loadGroups()]);
      renderList();
      if (state.active) {
        if (state.active.kind === 'group') await loadGroupMessages();
        else await loadMessages();
      }
      markRead();
    } catch (e) { handleErr(e); }
  }

  async function fillEmployeeSelect(search, select, excludedIds) {
    const selected = new Set([...select.selectedOptions].map((o) => o.value));
    const employees = (await api('/employees?q=' + encodeURIComponent(search.value.trim()))).employees;
    select.replaceChildren();
    employees.filter((employee) => !excludedIds.has(employee.id)).forEach((employee) => {
      const option = document.createElement('option');
      option.value = employee.id;
      option.textContent = employee.fullName + (employee.department ? ' · ' + employee.department : '');
      option.selected = selected.has(String(employee.id));
      select.append(option);
    });
  }
  async function openCreateGroup() {
    $('groupCreateError').classList.add('hidden');
    $('groupName').value = '';
    $('groupEmployeeSearch').value = '';
    try {
      await fillEmployeeSelect($('groupEmployeeSearch'), $('groupEmployeeSelect'), new Set([state.me.id]));
      $('createGroupDialog').showModal();
      $('groupName').focus();
    } catch (e) { handleErr(e); }
  }
  async function createGroup(e) {
    e.preventDefault();
    const name = $('groupName').value.trim();
    const memberIds = [...$('groupEmployeeSelect').selectedOptions].map((option) => Number(option.value));
    const submit = $('createGroupForm').querySelector('[type="submit"]');
    submit.disabled = true;
    $('groupCreateError').classList.add('hidden');
    try {
      const result = await api('/groups', { method: 'POST', body: { name, memberIds } });
      $('createGroupDialog').close();
      await loadGroups();
      renderList();
      await openGroup(result.group.id);
    } catch (e2) {
      if (e2.status === 401) return location.replace('/login.html');
      const error = $('groupCreateError');
      error.textContent = e2.message || 'Could not create the group.';
      error.classList.remove('hidden');
    } finally { submit.disabled = false; }
  }
  function renderGroupPhoto(group, isAdmin) {
    const current = $('groupPhotoAvatar');
    const photo = groupAvatar(group, 'large', 'groupPhotoAvatar');
    if (current) current.replaceWith(photo);
    state.groupPhotoAdmin = isAdmin;
    $('groupPhotoCamera').classList.toggle('hidden', !isAdmin);
    $('groupPhotoCamera').setAttribute('aria-expanded', 'false');
    $('groupPhotoMenu').classList.add('hidden');
    $('chooseGroupPhoto').textContent = group.avatarVersion ? 'Change photo' : 'Upload photo';
    $('removeGroupPhoto').classList.toggle('hidden', !group.avatarVersion);
    $('groupPhotoCrop').classList.add('hidden');
    $('groupPhotoInput').value = '';
    state.groupPhotoReady = false;
  }
    async function readGroupPhoto(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    try {
      const bitmap = typeof createImageBitmap === 'function'
        ? await createImageBitmap(file) : await loadProfileImage(file);
      groupCropper.load(bitmap);
      state.groupPhotoReady = true;
      $('groupPhotoMenu').classList.add('hidden');
      $('groupPhotoCamera').setAttribute('aria-expanded', 'false');
      $('groupPhotoCamera').classList.add('hidden');
      $('groupPhotoCrop').classList.remove('hidden');
    } catch (e) {
      toast('This image could not be opened. Choose another image.');
    }
  }
  async function compressGroupPhoto() {
    const preview = $('groupPhotoCropCanvas');
    for (const size of [256, 224, 192, 160, 128]) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.getContext('2d').drawImage(preview, 0, 0, size, size);
      for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size < 150 * 1024) return blob;
      }
    }
    throw new Error('This image could not be compressed below 150 KB.');
  }
    function cancelGroupPhotoCrop() {
    state.groupPhotoReady = false;
    groupCropper.release();
    $('groupPhotoCrop').classList.add('hidden');
    $('groupPhotoCamera').classList.toggle('hidden', !state.groupPhotoAdmin);
    $('groupPhotoInput').value = '';
  }
  async function saveGroupPhoto() {
    if (!state.groupPhotoReady || !state.active || state.active.kind !== 'group') return;
    const button = $('saveGroupPhoto'), groupId = state.active.id;
    button.disabled = true;
    try {
      const blob = await compressGroupPhoto();
      const response = await fetch('/api/groups/' + groupId + '/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Requested-With': 'dixel' },
        credentials: 'same-origin',
        body: blob,
      });
      let result = {};
      try { result = await response.json(); } catch (e) { /* non-JSON */ }
      if (!response.ok) throw new Error(result.message || 'Group photo upload failed.');
      applyGroupAvatarUpdate(groupId, result.avatarVersion);
      cancelGroupPhotoCrop();
      $('groupPhotoMenu').classList.add('hidden');
      $('groupPhotoCamera').setAttribute('aria-expanded', 'false');
      toast('Group photo updated.');
    } catch (e) { toast(e.message || 'Group photo upload failed.'); }
    finally { button.disabled = false; }
  }
  async function removeGroupPhoto() {
    if (!state.active || state.active.kind !== 'group') return;
    const groupId = state.active.id;
    try {
      const result = await api('/groups/' + groupId + '/avatar', { method: 'DELETE' });
      applyGroupAvatarUpdate(groupId, result.avatarVersion);
      $('groupPhotoMenu').classList.add('hidden');
      $('groupPhotoCamera').setAttribute('aria-expanded', 'false');
      toast('Group photo removed.');
    } catch (e) { handleErr(e); }
  }
  function applyGroupAvatarUpdate(groupId, avatarVersion) {
    groupId = Number(groupId);
    const update = (group) => {
      if (group && Number(group.id) === groupId) group.avatarVersion = avatarVersion || null;
    };
    state.groups.forEach(update);
    if (state.active && state.active.kind === 'group') update(state.active.group);
    document.querySelectorAll('.group-avatar[data-group-id]').forEach((node) => {
      if (Number(node.dataset.groupId) === groupId) updateGroupAvatar(node, { id: groupId, avatarVersion });
    });
    if (state.memberDialogGroupId === groupId && $('groupMembersDialog').open) {
      $('chooseGroupPhoto').textContent = avatarVersion ? 'Change photo' : 'Upload photo';
      $('removeGroupPhoto').classList.toggle('hidden', !avatarVersion);
    }
    if (state.tab === 'chats') renderList();
  }
  async function openGroupMembers() {
    if (!state.active || state.active.kind !== 'group') return;
    const groupId = state.active.id;
    try {
      const result = await api('/groups/' + groupId + '/members');
      if (!state.active || state.active.kind !== 'group' || state.active.id !== groupId) return;
      state.active.group = Object.assign(state.active.group, result.group, { members: result.members });
      state.memberDialogGroupId = groupId;
      $('groupMembersTitle').textContent = result.group.name;
      $('groupMembersSubtitle').textContent = result.members.length + ' members';
      $('groupPreview').textContent = groupMemberPreview(result.members);
      $('groupMembersError').classList.add('hidden');
      renderGroupPhoto(state.active.group, result.group.role === 'admin');
      const list = $('groupMemberList');
      list.replaceChildren();
      result.members.forEach((member) => {
        const content = [
          avatar(member, false, false),
        el('span', { class: 'meta' }, [
            el('span', { class: 'name', text: member.fullName }),
            el('span', { class: 'prev', text: member.globalRole === 'admin' ? 'Administrator' : member.role === 'admin' ? 'Admin' : 'Member' }),
          ]),
        ];
        if (result.group.role === 'admin' && member.id !== state.me.id && member.globalRole !== 'admin') {
          content.push(el('button', { class: 'btn danger sm', type: 'button', text: 'Remove', onclick: () => removeGroupMember(groupId, member.id) }));
        }
        list.append(el('li', {}, [el('div', { class: 'item' }, content)]));
      });
      const isAdmin = result.group.role === 'admin';
      $('groupAddField').classList.toggle('hidden', !isAdmin);
      $('groupAddSelectField').classList.toggle('hidden', !isAdmin);
      $('addGroupMembers').classList.toggle('hidden', !isAdmin);
      $('leaveGroup').classList.toggle('hidden', state.me.role === 'admin');
      $('deleteGroup').classList.toggle('hidden', state.me.role !== 'admin');
      $('groupMemberSearch').value = '';
      $('groupMemberSelect').replaceChildren();
      if (isAdmin) {
        const excluded = new Set(result.members.map((member) => member.id));
        excluded.add(state.me.id);
        await fillEmployeeSelect($('groupMemberSearch'), $('groupMemberSelect'), excluded);
      }
      if (!$('groupMembersDialog').open) $('groupMembersDialog').showModal();
    } catch (e) { handleErr(e); }
  }
  async function removeGroupMember(groupId, userId) {
    try {
      await api('/groups/' + groupId + '/members/' + userId, { method: 'DELETE' });
      await Promise.all([loadGroups(), openGroupMembers()]);
      renderList();
    } catch (e) {
      $('groupMembersError').textContent = e.message || 'Could not remove the group member.';
      $('groupMembersError').classList.remove('hidden');
    }
  }
  async function addGroupMembers() {
    if (!state.active || state.active.kind !== 'group') return;
    const groupId = state.active.id;
    const memberIds = [...$('groupMemberSelect').selectedOptions].map((option) => Number(option.value));
    try {
      await api('/groups/' + groupId + '/members', { method: 'POST', body: { memberIds } });
      await Promise.all([loadGroups(), openGroupMembers()]);
      renderList();
    } catch (e) {
      $('groupMembersError').textContent = e.message || 'Could not add group members.';
      $('groupMembersError').classList.remove('hidden');
    }
  }
  async function leaveGroup() {
    if (!state.active || state.active.kind !== 'group') return;
    const groupId = state.active.id;
    try {
      await api('/groups/' + groupId + '/members/' + state.me.id, { method: 'DELETE' });
      $('groupMembersDialog').close();
      state.groups = state.groups.filter((g) => g.id !== groupId);
      closeChat();
      renderList();
    } catch (e) {
      $('groupMembersError').textContent = e.message || 'Could not leave the group.';
      $('groupMembersError').classList.remove('hidden');
    }
  }
  function openDeleteGroup() {
    if (!state.active || state.active.kind !== 'group' || state.me.role !== 'admin') return;
    $('deleteGroupDialog').showModal();
  }
  async function deleteGroup() {
    if (!state.active || state.active.kind !== 'group') return;
    const groupId = state.active.id;
    try {
      await api('/groups/' + groupId, { method: 'DELETE' });
      $('deleteGroupDialog').close();
      $('groupMembersDialog').close();
      state.groups = state.groups.filter((g) => g.id !== groupId);
      closeChat();
      toast('Group deleted.');
    } catch (e) {
      $('groupMembersError').textContent = e.message || 'Could not delete the group.';
      $('groupMembersError').classList.remove('hidden');
    }
  }

  async function openMostRecentChat() {
    const recent = [
      ...state.convs.filter((conversation) => !conversation.self && conversation.lastMessage).map((conversation) => ({
        kind: 'direct', item: conversation, time: conversation.lastMessage.createdAt,
      })),
      ...state.groups.filter((group) => group.lastMessage).map((group) => ({
        kind: 'group', item: group, time: group.lastMessage.createdAt,
      })),
    ].sort((a, b) => b.time - a.time);
    if (recent.length) {
      if (recent[0].kind === 'group') await openGroup(recent[0].item.id);
      else await openChat(recent[0].item.other, recent[0].item.id);
    } else if (state.selfChat) {
      await openChat(state.selfChat.other, state.selfChat.id, true);
    }
  }

  // ---------- init ----------
  async function init() {
    try { state.me = (await api('/auth/me')).user; } catch (e) { return location.replace('/login.html'); }
    const dismissMessageMenus = (except) => {
      document.querySelectorAll('.message-actions .message-menu:not(.hidden)').forEach((menu) => {
        if (except && menu.parentElement === except) return;
        menu.classList.add('hidden');
        const toggle = menu.parentElement.querySelector('.message-menu-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    };
    document.addEventListener('click', closeFloatingOnOutside, true);
    document.addEventListener('click', (event) => {
      const actions = event.target instanceof Element ? event.target.closest('.message-actions') : null;
      dismissMessageMenus(actions);
    }, true);

    // Close header dropdown when clicking outside
    document.addEventListener('click', (event) => {
      const clickedInside = event.target instanceof Element
        ? event.target.closest('.header-menu-wrap')
        : null;

      if (clickedInside) return;

      document.querySelectorAll('.header-menu-wrap .header-menu:not(.hidden)')
        .forEach((menu) => {
          menu.classList.add('hidden');

          const toggle = menu.parentElement.querySelector('button[aria-expanded]');
          if (toggle) toggle.setAttribute('aria-expanded', 'false');
        });
    }, true);

    // Close header dropdown on Escape
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;

      document.querySelectorAll('.header-menu-wrap .header-menu:not(.hidden)')
        .forEach((menu) => {
          menu.classList.add('hidden');

          const toggle = menu.parentElement.querySelector('button[aria-expanded]');
          if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
            toggle.focus();
          }
        });
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      
      const openMenu = document.querySelector('.message-actions .message-menu:not(.hidden)');
      if (openMenu) {
        const toggle = openMenu.parentElement.querySelector('.message-menu-toggle');
        dismissMessageMenus(null);
        if (toggle) toggle.focus();
      }
    }, true);
        // Close the profile / group photo menus when clicking outside them
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      [
        { menu: 'profilePhotoMenu', button: 'profileCamera' },
        { menu: 'groupPhotoMenu', button: 'groupPhotoCamera' },
      ].forEach(({ menu, button }) => {
        const m = $(menu), b = $(button);
        if (!m || m.classList.contains('hidden')) return;
        if (target && (m.contains(target) || (b && b.contains(target)))) return; // click inside the menu or on the camera button
        m.classList.add('hidden');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    }, true);
    $('meName').textContent = state.me.fullName;
    $('meDept').textContent = state.me.department || state.me.email;
    $('meAvatar').className = 'avatar av' + (state.me.id % 6) + ' account-avatar';
    $('meAvatar').textContent = initials(state.me.fullName);
    updateAvatar($('meAvatar'), state.me);
    $('attendanceAction').addEventListener('click', changeAttendance);
    await loadTodayAttendance();
    window.setInterval(loadTodayAttendance, 60000);
    profileCropper = makeCropper($('profileCropCanvas'), $('profileCropZoom'));
    groupCropper = makeCropper($('groupPhotoCropCanvas'), $('groupPhotoCropZoom'));
    $('openProfile').addEventListener('click', openProfile);
    $('openProfile').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfile(); }
    });
    $('closeProfile').addEventListener('click', () => $('profileDialog').close());
    $('profileCamera').addEventListener('click', () => {
      const menu = $('profilePhotoMenu');
      const open = menu.classList.toggle('hidden') === false;
      $('profileCamera').setAttribute('aria-expanded', String(open));
    });
    $('chooseProfilePhoto').addEventListener('click', () => $('profilePhotoInput').click());
    $('profilePhotoInput').addEventListener('change', () => {
      const file = $('profilePhotoInput').files[0];
      readProfileFile(file);
    });
    $('removeProfilePhoto').addEventListener('click', removeProfilePhoto);
    $('saveProfilePhoto').addEventListener('click', saveProfilePhoto);
    $('cancelProfileCrop').addEventListener('click', cancelProfileCrop);
    $('cancelProfileEdit').addEventListener('click', cancelProfileEdit);
    $('saveProfileEdit').addEventListener('click', saveProfileDetails);
    if (state.me.role === 'admin') $('adminLink').classList.remove('hidden');
    $('tabChats').addEventListener('click', () => setTab('chats'));
    $('tabPeople').addEventListener('click', () => setTab('people'));
    $('newGroup').addEventListener('click', openCreateGroup);
    $('createGroupForm').addEventListener('submit', createGroup);
    $('cancelGroupCreate').addEventListener('click', () => $('createGroupDialog').close());
    $('groupEmployeeSearch').addEventListener('input', debounce(() => fillEmployeeSelect($('groupEmployeeSearch'), $('groupEmployeeSelect'), new Set([state.me.id])).catch(handleErr), 200));
    $('groupMemberSearch').addEventListener('input', debounce(() => {
      const group = state.active && state.active.kind === 'group' ? state.active.group : null;
      const excluded = new Set((group && group.members || []).map((member) => member.id));
      excluded.add(state.me.id);
      fillEmployeeSelect($('groupMemberSearch'), $('groupMemberSelect'), excluded).catch(handleErr);
    }, 200));
    $('groupPhotoCamera').addEventListener('click', () => {
      const menu = $('groupPhotoMenu');
      const open = menu.classList.toggle('hidden') === false;
      $('groupPhotoCamera').setAttribute('aria-expanded', String(open));
    });
    $('chooseGroupPhoto').addEventListener('click', () => $('groupPhotoInput').click());
    $('groupPhotoInput').addEventListener('change', () => readGroupPhoto($('groupPhotoInput').files[0]));
    $('removeGroupPhoto').addEventListener('click', removeGroupPhoto);
    $('saveGroupPhoto').addEventListener('click', saveGroupPhoto);
    $('cancelGroupPhotoCrop').addEventListener('click', cancelGroupPhotoCrop);
    $('closeGroupMembers').addEventListener('click', () => $('groupMembersDialog').close());
    $('addGroupMembers').addEventListener('click', addGroupMembers);
    $('leaveGroup').addEventListener('click', leaveGroup);
    $('deleteGroup').addEventListener('click', openDeleteGroup);
    $('cancelDeleteGroup').addEventListener('click', () => $('deleteGroupDialog').close());
    $('confirmDeleteGroup').addEventListener('click', deleteGroup);
    $('q').addEventListener('input', debounce(() => { if (state.tab === 'people') refreshSide(); else renderList(); }, 200));
    $('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } finally { location.replace('/login.html'); } });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { markRead(); loadTodayAttendance(); }
    });
    await refreshSide();
    connect();
    await openMostRecentChat();
  }
  init();
})();
