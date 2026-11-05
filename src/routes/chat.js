const express = require('express');
const db = require('../db');
const rt = require('../realtime');

const router = express.Router();
const MAX_LEN = 4000;

const userCard = (u) => ({
  id: u.id, fullName: u.full_name, department: u.department,
  online: rt.isOnline(u.id), lastSeenAt: u.last_seen_at || null,
});
const msgOut = (m) => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, text: m.body, createdAt: m.created_at });

// Returns the conversation only if the signed-in user is a participant. Anything else looks like "not found".
function getConversation(id, userId) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)').get(Number(id), userId, userId);
  if (!c) return null;
  const otherId = c.user_a === userId ? c.user_b : c.user_a;
  const other = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(otherId);
  return other ? { conv: c, other } : null;
}

router.get('/employees', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = db.prepare(`SELECT * FROM users WHERE status = 'active' AND id != ?
    AND (? = '' OR lower(full_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(department,'')) LIKE ? ESCAPE '\\')
    ORDER BY full_name COLLATE NOCASE LIMIT 200`).all(req.user.id, q, like, like);
  res.json({ employees: rows.map(userCard) });
});

router.get('/conversations', (req, res) => {
  const me = req.user.id;
  const convs = db.prepare(`SELECT * FROM conversations WHERE user_a = ? OR user_b = ?`).all(me, me);
  const out = [];
  for (const c of convs) {
    const other = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(c.user_a === me ? c.user_b : c.user_a);
    if (!other) continue;
    const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
    if (!last) continue;
    const read = db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(c.id, me);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND id > ?').get(c.id, me, read ? read.r : 0).n;
    out.push({ id: c.id, other: userCard(other), lastMessage: msgOut(last), unread });
  }
  out.sort((a, b) => b.lastMessage.id - a.lastMessage.id);
  res.json({ conversations: out });
});

router.post('/conversations', (req, res) => {
  const otherId = Number((req.body || {}).userId);
  const me = req.user.id;
  if (!Number.isInteger(otherId) || otherId === me) return res.status(400).json({ message: 'Choose a colleague to message.' });
  const other = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(otherId);
  if (!other) return res.status(404).json({ message: 'That employee is not available.' });
  const [a, b] = me < otherId ? [me, otherId] : [otherId, me];
  db.prepare('INSERT OR IGNORE INTO conversations (user_a, user_b, created_at) VALUES (?,?,?)').run(a, b, Date.now());
  const c = db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b);
  res.json({ conversation: { id: c.id, other: userCard(other) } });
});

router.get('/conversations/:id/messages', (req, res) => {
  const ctx = getConversation(req.params.id, req.user.id);
  if (!ctx) return res.status(404).json({ message: 'Conversation not found.' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(ctx.conv.id, before, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse().map(msgOut);
  const otherRead = db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(ctx.conv.id, ctx.other.id);
  const myRead = db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(ctx.conv.id, req.user.id);
  const firstUnread = db.prepare(`SELECT id FROM messages WHERE conversation_id = ? AND sender_id != ? AND id > ?
    ORDER BY id ASC LIMIT 1`).get(ctx.conv.id, req.user.id, myRead ? myRead.r : 0);
  res.json({
    messages: page,
    hasMore,
    otherLastReadId: otherRead ? otherRead.r : 0,
    firstUnreadMessageId: firstUnread ? firstUnread.id : null,
    other: userCard(ctx.other),
  });
});

router.post('/conversations/:id/messages', (req, res) => {
  const ctx = getConversation(req.params.id, req.user.id);
  if (!ctx) return res.status(404).json({ message: 'Conversation not found.' });
  const text = String((req.body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return res.status(400).json({ message: 'Write a message before sending.' });
  if (text.length > MAX_LEN) return res.status(400).json({ message: `Messages can be up to ${MAX_LEN} characters.` });
  const clientId = String((req.body || {}).clientId || '').slice(0, 64) || null;

  if (clientId) {
    const dup = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?').get(ctx.conv.id, req.user.id, clientId);
    if (dup) return res.status(200).json({ message: msgOut(dup) });
  }
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, client_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(ctx.conv.id, req.user.id, clientId, text, Date.now());
  const msg = msgOut(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  // Recipients are derived from the conversation row on the server, never from client input.
  const event = { type: 'message', message: msg };
  rt.sendToUser(req.user.id, event);
  rt.sendToUser(ctx.other.id, event);
  res.status(201).json({ message: msg });
});

router.post('/conversations/:id/read', (req, res) => {
  const ctx = getConversation(req.params.id, req.user.id);
  if (!ctx) return res.status(404).json({ message: 'Conversation not found.' });
  const upTo = parseInt((req.body || {}).lastReadMessageId, 10);
  if (!Number.isInteger(upTo) || upTo < 0) return res.status(400).json({ message: 'Invalid read marker.' });
  const valid = db.prepare('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ? AND id <= ?').get(ctx.conv.id, upTo).m || 0;
  db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`)
    .run(ctx.conv.id, req.user.id, valid);
  rt.sendToUser(ctx.other.id, { type: 'read', conversationId: ctx.conv.id, userId: req.user.id, lastReadMessageId: valid });
  res.json({ ok: true });
});

module.exports = router;
