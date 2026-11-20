const express = require('express');
const db = require('../db');
const rt = require('../realtime');
const { isOneEmoji, loadReactions, attachReactions } = require('../reactions');

const router = express.Router();
const MAX_LEN = 4000;

const userCard = (u, self = false) => ({
  id: u.id, fullName: u.full_name, department: u.department,
  avatarVersion: u.avatar_version || null,
  online: !self && rt.isOnline(u.id), lastSeenAt: self ? null : u.last_seen_at || null,
});
const msgOut = (m) => ({
  id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, text: m.body,
  createdAt: m.created_at, deliveredAt: m.delivered_at, readAt: m.read_at,
  editedAt: m.edited_at, deleted: !!m.deleted_at, reactions: [],
});

async function enrichMessage(message) {
  return attachReactions([message], await loadReactions([message.id], 'direct'))[0];
}

async function reactionRows(messageId) {
  return (await loadReactions([messageId], 'direct')).get(Number(messageId)) || [];
}

function reactionEvent(conversation, userId, messageId, reactions) {
  return { type: 'message_reaction', scope: 'direct', conversationId: conversation.id, messageId, reactions };
}

// Returns the conversation only if the signed-in user is a participant. Anything else looks like "not found".
async function getConversation(id, userId) {
  const c = await db.prepare('SELECT * FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)').get(Number(id), userId, userId);
  if (!c) return null;
  const self = c.user_a === userId && c.user_b === userId;
  const otherId = self ? userId : c.user_a === userId ? c.user_b : c.user_a;
  const other = await db.prepare(`SELECT u.*,
    (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_version
    FROM users u WHERE u.id = ? AND u.status = 'active'`).get(otherId);
  return other ? { conv: c, other, self } : null;
}

function sendConversationEvent(conversation, userId, event) {
  const otherId = conversation.user_a === userId ? conversation.user_b : conversation.user_a;
  if (otherId !== userId) rt.sendToUser(otherId, event);
  rt.sendToUser(userId, event);
}

router.get('/employees', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await db.prepare(`SELECT u.*,
    (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_version
    FROM users u WHERE status = 'active' AND role != 'admin' AND id != ?
    AND (? = '' OR lower(full_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(department,'')) LIKE ? ESCAPE '\\')
    ORDER BY full_name COLLATE NOCASE LIMIT 200`).all(req.user.id, q, like, like);
  res.json({ employees: rows.map((user) => userCard(user)) });
});

router.get('/conversations', async (req, res) => {
  const me = req.user.id;
  await db.prepare('INSERT OR IGNORE INTO conversations (user_a, user_b, created_at) VALUES (?,?,?)')
    .run(me, me, Date.now());
  const convs = await db.prepare(`SELECT * FROM conversations WHERE user_a = ? OR user_b = ?`).all(me, me);
  const out = [];
  for (const c of convs) {
    const self = c.user_a === me && c.user_b === me;
    const otherId = self ? me : c.user_a === me ? c.user_b : c.user_a;
    const other = await db.prepare(`SELECT u.*,
      (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_version
      FROM users u WHERE id = ? AND status = 'active'`).get(otherId);
    if (!other) continue;
    const last = await db.prepare(`SELECT m.* FROM messages m
      LEFT JOIN message_hides h ON h.message_id = m.id AND h.user_id = ?
      LEFT JOIN conversation_clears cc ON cc.conversation_id = m.conversation_id AND cc.user_id = ?
      WHERE m.conversation_id = ? AND h.message_id IS NULL AND m.id > COALESCE(cc.cleared_through_id, 0)
      ORDER BY m.id DESC LIMIT 1`).get(me, me, c.id);
    if (!last && !self) continue;
    if (self) {
      out.push({ id: c.id, other: userCard(other, true), lastMessage: last ? msgOut(last) : null, unread: 0, self: true });
      continue;
    }
    const read = await db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(c.id, me);
    const unread = (await db.prepare(`SELECT COUNT(*) AS n FROM messages m
      LEFT JOIN message_hides h ON h.message_id = m.id AND h.user_id = ?
      LEFT JOIN conversation_clears cc ON cc.conversation_id = m.conversation_id AND cc.user_id = ?
      WHERE m.conversation_id = ? AND m.sender_id != ? AND m.id > ?
        AND h.message_id IS NULL AND m.id > COALESCE(cc.cleared_through_id, 0)`)
      .get(me, me, c.id, me, read ? read.r : 0)).n;
    out.push({ id: c.id, other: userCard(other), lastMessage: msgOut(last), unread, self: false });
  }
  out.sort((a, b) => (b.lastMessage ? b.lastMessage.id : 0) - (a.lastMessage ? a.lastMessage.id : 0));
  const lastMessages = out.filter((conversation) => conversation.lastMessage).map((conversation) => conversation.lastMessage);
  const reactions = await loadReactions(lastMessages.map((message) => message.id), 'direct');
  lastMessages.forEach((message) => { message.reactions = reactions.get(Number(message.id)) || []; });
  res.json({ conversations: out });
});

router.post('/conversations', async (req, res) => {
  const otherId = Number((req.body || {}).userId);
  const me = req.user.id;
  if (!Number.isInteger(otherId) || otherId === me) return res.status(400).json({ message: 'Choose a colleague to message.' });
  const other = await db.prepare(`SELECT u.*,
    (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_version
    FROM users u WHERE u.id = ? AND u.status = 'active'`).get(otherId);
  if (!other) return res.status(404).json({ message: 'That employee is not available.' });
  const [a, b] = me < otherId ? [me, otherId] : [otherId, me];
  await db.prepare('INSERT OR IGNORE INTO conversations (user_a, user_b, created_at) VALUES (?,?,?)').run(a, b, Date.now());
  const c = await db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b);
  res.json({ conversation: { id: c.id, other: userCard(other) } });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const ctx = await getConversation(req.params.id, req.user.id);
  if (!ctx) return res.status(404).json({ message: 'Conversation not found.' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
  const rows = await db.prepare(`SELECT m.* FROM messages m
    LEFT JOIN message_hides h ON h.message_id = m.id AND h.user_id = ?
    LEFT JOIN conversation_clears cc ON cc.conversation_id = m.conversation_id AND cc.user_id = ?
    WHERE m.conversation_id = ? AND m.id < ? AND h.message_id IS NULL
      AND m.id > COALESCE(cc.cleared_through_id, 0)
    ORDER BY m.id DESC LIMIT ?`).all(req.user.id, req.user.id, ctx.conv.id, before, limit + 1);
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit).reverse();
  const page = attachReactions(selected.map(msgOut), await loadReactions(selected.map((message) => message.id), 'direct'));
  const otherRead = ctx.self ? null :
    await db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(ctx.conv.id, ctx.other.id);
  const myRead = await db.prepare('SELECT last_read_message_id AS r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?').get(ctx.conv.id, req.user.id);
  const firstUnread = await db.prepare(`SELECT m.id FROM messages m
    LEFT JOIN message_hides h ON h.message_id = m.id AND h.user_id = ?
    LEFT JOIN conversation_clears cc ON cc.conversation_id = m.conversation_id AND cc.user_id = ?
    WHERE m.conversation_id = ? AND m.sender_id != ? AND m.id > ?
      AND h.message_id IS NULL AND m.id > COALESCE(cc.cleared_through_id, 0)
    ORDER BY m.id ASC LIMIT 1`)
    .get(req.user.id, req.user.id, ctx.conv.id, req.user.id, myRead ? myRead.r : 0);
  res.json({
    messages: page,
    hasMore,
    otherLastReadId: otherRead ? otherRead.r : 0,
    firstUnreadMessageId: firstUnread ? firstUnread.id : null,
    other: userCard(ctx.other, ctx.self),
  });
});

router.post('/conversations/:id/messages', async (req, res) => {
  const ctx = await getConversation(req.params.id, req.user.id);
  if (!ctx) return res.status(404).json({ message: 'Conversation not found.' });
  const text = String((req.body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return res.status(400).json({ message: 'Write a message before sending.' });
  if (text.length > MAX_LEN) return res.status(400).json({ message: `Messages can be up to ${MAX_LEN} characters.` });
  const clientId = String((req.body || {}).clientId || '').slice(0, 64) || null;

  if (clientId) {
    const dup = await db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?').get(ctx.conv.id, req.user.id, clientId);
    if (dup) return res.status(200).json({ message: msgOut(dup) });
  }
  const info = await db.prepare('INSERT INTO messages (conversation_id, sender_id, client_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(ctx.conv.id, req.user.id, clientId, text, Date.now());
  const msg = msgOut(await db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
  // Recipients are derived from the conversation row on the server, never from client input.
  const event = { type: 'message', message: msg };
  sendConversationEvent(ctx.conv, req.user.id, event);
  res.status(201).json({ message: msg });
});

router.patch('/conversations/:id/messages/:messageId', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  const messageId = Number(req.params.messageId);
  if (!conversation) return res.status(404).json({ message: 'Message not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  const message = await db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversation.id);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only edit your own messages.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Deleted messages cannot be edited.' });
  if (Date.now() - message.created_at > 15 * 60 * 1000) return res.status(409).json({ message: 'Messages can only be edited within 15 minutes.' });
  const text = String((req.body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return res.status(400).json({ message: 'Message cannot be empty.' });
  if (text.length > MAX_LEN) return res.status(400).json({ message: `Messages can be up to ${MAX_LEN} characters.` });
  const editedAt = Date.now();
  const updatedCount = await db.prepare(`UPDATE messages SET body = ?, edited_at = ?
    WHERE id = ? AND sender_id = ? AND deleted_at IS NULL AND created_at >= ?`)
    .run(text, editedAt, messageId, req.user.id, editedAt - 15 * 60 * 1000);
  if (!updatedCount.changes) return res.status(409).json({ message: 'Messages can only be edited within 15 minutes.' });
  const updated = await enrichMessage(msgOut(await db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)));
  const event = { type: 'message_edited', scope: 'direct', message: updated };
  sendConversationEvent(conversation, req.user.id, event);
  res.json({ message: updated });
});

router.post('/conversations/:id/messages/:messageId/delete', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  const messageId = Number(req.params.messageId);
  const mode = (req.body || {}).mode;
  if (!conversation) return res.status(404).json({ message: 'Message not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  if (!['me', 'everyone'].includes(mode)) return res.status(400).json({ message: 'Choose a valid delete option.' });
  const message = await db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(messageId, conversation.id);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (mode === 'me') {
    await db.prepare(`INSERT INTO message_hides (message_id, user_id, hidden_at) VALUES (?,?,?)
      ON CONFLICT(message_id, user_id) DO NOTHING`).run(messageId, req.user.id, Date.now());
    rt.sendToUser(req.user.id, {
      type: 'message_hidden', scope: 'direct', conversationId: conversation.id,
      messageId, userId: req.user.id,
    });
    return res.json({ ok: true });
  }
  if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own message for everyone.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Message is already deleted.' });
  if (Date.now() - message.created_at > 60 * 60 * 1000) return res.status(409).json({ message: 'Messages can only be deleted for everyone within 1 hour.' });
  const deletedAt = Date.now();
  const deletedCount = await db.transaction(async (tx) => {
    const result = await tx.prepare(`UPDATE messages SET body = 'This message was deleted', deleted_at = ?, edited_at = NULL
      WHERE id = ? AND sender_id = ? AND deleted_at IS NULL AND created_at >= ?`)
      .run(deletedAt, messageId, req.user.id, deletedAt - 60 * 60 * 1000);
    if (result.changes) await tx.prepare('DELETE FROM direct_message_reactions WHERE message_id = ?').run(messageId);
    return result;
  });
  if (!deletedCount.changes) return res.status(409).json({ message: 'Messages can only be deleted for everyone within 1 hour.' });
  const updated = await enrichMessage(msgOut(await db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)));
  const event = { type: 'message_deleted', scope: 'direct', message: updated };
  sendConversationEvent(conversation, req.user.id, event);
  res.json({ ok: true, message: updated });
});

router.put('/conversations/:id/messages/:messageId/reaction', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  const messageId = Number(req.params.messageId);
  if (!conversation) return res.status(404).json({ message: 'Message not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  const message = await db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversation.id);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Deleted messages cannot be reacted to.' });
  const emoji = (req.body || {}).emoji;
  if (!isOneEmoji(emoji)) return res.status(400).json({ message: 'Choose exactly one emoji.' });
  const existing = await db.prepare('SELECT emoji FROM direct_message_reactions WHERE message_id = ? AND user_id = ?').get(messageId, req.user.id);
  if (existing && existing.emoji === emoji) {
    await db.prepare('DELETE FROM direct_message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.user.id);
  } else {
    await db.prepare(`INSERT INTO direct_message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`)
      .run(messageId, req.user.id, emoji, Date.now());
  }
  const reactions = await reactionRows(messageId);
  sendConversationEvent(conversation, req.user.id, reactionEvent(conversation, req.user.id, messageId, reactions));
  res.json({ reactions });
});

router.delete('/conversations/:id/messages/:messageId/reaction', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  const messageId = Number(req.params.messageId);
  if (!conversation) return res.status(404).json({ message: 'Message not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  const message = await db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversation.id);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Deleted messages cannot be reacted to.' });
  await db.prepare('DELETE FROM direct_message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.user.id);
  const reactions = await reactionRows(messageId);
  sendConversationEvent(conversation, req.user.id, reactionEvent(conversation, req.user.id, messageId, reactions));
  res.json({ reactions });
});

router.post('/conversations/:id/clear', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  const last = await db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversation.id);
  await db.prepare(`INSERT INTO conversation_clears (conversation_id, user_id, cleared_through_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET cleared_through_id = MAX(cleared_through_id, excluded.cleared_through_id)`)
    .run(conversation.id, req.user.id, last.id || 0);
  const clearEvent = {
    type: 'chat_cleared', scope: 'direct', conversationId: conversation.id, userId: req.user.id,
  };
  sendConversationEvent(conversation, req.user.id, clearEvent);
  res.json({ ok: true });
});

router.post('/conversations/:id/read', async (req, res) => {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (conversation.user_a !== req.user.id && conversation.user_b !== req.user.id) {
    return res.status(403).json({ message: 'You are not a participant in this conversation.' });
  }
  if (conversation.user_a === req.user.id && conversation.user_b === req.user.id) {
    return res.json({ ok: true });
  }
  const otherId = conversation.user_a === req.user.id ? conversation.user_b : conversation.user_a;
  const upTo = parseInt((req.body || {}).lastReadMessageId, 10);
  if (!Number.isInteger(upTo) || upTo < 0) return res.status(400).json({ message: 'Invalid read marker.' });
  const valid = (await db.prepare('SELECT MAX(id) AS m FROM messages WHERE conversation_id = ? AND id <= ?').get(conversation.id, upTo)).m || 0;
  const readAt = Date.now();
  await db.prepare(`UPDATE messages SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?)
    WHERE conversation_id = ? AND sender_id = ? AND id <= ?`)
    .run(readAt, readAt, conversation.id, otherId, valid);
  await db.prepare(`INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?,?,?)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`)
    .run(conversation.id, req.user.id, valid);
  const updates = await db.prepare(`SELECT id AS messageId, delivered_at AS deliveredAt, read_at AS readAt
    FROM messages WHERE conversation_id = ? AND sender_id = ? AND id <= ?`)
    .all(conversation.id, otherId, valid);
  const statusEvent = {
    type: 'message_status', scope: 'direct', conversationId: conversation.id,
    readByUserId: req.user.id, lastReadMessageId: valid, updates,
  };
  rt.sendToUser(otherId, statusEvent);
  rt.sendToUser(req.user.id, statusEvent);
  res.json({ ok: true });
});

module.exports = router;
