const express = require('express');
const db = require('../db');
const rt = require('../realtime');
const { markGroupRead } = require('../message-status');
const { ensureAdminsInAllGroups } = require('../group-admins');

const router = express.Router();
const MAX_LEN = 4000;
const MAX_MEMBERS = 200;
const MAX_AVATAR_BYTES = 300 * 1024;
const MAX_AVATAR_PREVIEW_AGE = 24 * 60 * 60;
const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const readGroupAvatar = express.raw({ type: () => true, limit: MAX_AVATAR_BYTES });

function parseGroupAvatar(req, res, next) {
  readGroupAvatar(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ message: 'Group photos must be 300 KB or smaller.' });
    }
    return next(error);
  });
}

function signatureMime(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const groupMessageOut = (m) => ({
  id: m.id,
  groupId: m.group_id,
  senderId: m.sender_id,
  senderName: m.sender_name,
  avatarVersion: m.avatar_version || null,
  text: m.body,
  createdAt: m.created_at,
  deliveredAt: m.delivered_at,
  readAt: m.read_at,
  editedAt: m.edited_at,
  deleted: !!m.deleted_at,
});

async function groupMembership(groupId, userId) {
  return db.prepare(`SELECT g.id, g.name, g.created_by, g.created_at, gm.role,
      (SELECT updated_at FROM group_avatars WHERE group_id = g.id) AS avatar_version
    FROM groups g JOIN group_members gm ON gm.group_id = g.id
    WHERE g.id = ? AND gm.user_id = ?`).get(groupId, userId);
}

async function requireGroupMember(groupId, userId, res) {
  const membership = await groupMembership(groupId, userId);
  if (membership) return membership;
  const group = await db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!group) res.status(404).json({ message: 'Group not found.' });
  else res.status(403).json({ message: 'You are not a member of this group.' });
  return null;
}

function parseIds(value) {
  if (!Array.isArray(value) || value.length > MAX_MEMBERS) return null;
  if (value.some((id) => typeof id !== 'number' && (typeof id !== 'string' || !/^\d+$/.test(id)))) return null;
  const ids = [...new Set(value.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return null;
  return ids;
}

async function groupMemberRows(groupId) {
  return db.prepare(`SELECT u.id, u.full_name AS fullName, gm.role, u.role AS globalRole,
      (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatarVersion
    FROM group_members gm JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? AND u.status = 'active'
    ORDER BY CASE gm.role WHEN 'admin' THEN 0 ELSE 1 END, u.full_name COLLATE NOCASE`).all(groupId);
}

router.post('/groups', async (req, res) => {
  const body = req.body || {};
  if (typeof body.name !== 'string') return res.status(400).json({ message: 'Group name is required and must be 60 characters or fewer.' });
  const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return res.status(400).json({ message: 'Group name is required and must be 60 characters or fewer.' });
  const memberIds = parseIds(body.memberIds);
  if (!memberIds || memberIds.includes(req.user.id)) {
    return res.status(400).json({ message: 'Choose valid employees to add to the group.' });
  }
  if (!memberIds.length) return res.status(400).json({ message: 'Choose at least one employee for the group.' });
  const placeholders = memberIds.map(() => '?').join(',');
  const available = await db.prepare(`SELECT id FROM users WHERE status = 'active' AND role != 'admin' AND id IN (${placeholders})`).all(...memberIds);
  if (available.length !== memberIds.length) return res.status(400).json({ message: 'One or more selected employees are not available.' });

  const now = Date.now();
  const groupId = await db.transaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO groups (name, created_by, created_at) VALUES (?,?,?)')
      .run(name, req.user.id, now);
    const groupId = Number(info.lastInsertRowid);
    const addMember = tx.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)');
    await addMember.run(groupId, req.user.id, 'admin', now);
    for (const id of memberIds) await addMember.run(groupId, id, 'member', now);
    await tx.audit(req.user.id, 'group_created', groupId, req.ip);
    return groupId;
  });
  const repaired = await ensureAdminsInAllGroups();
  const memberCount = (await db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(groupId)).n;
  const group = { id: groupId, name, createdAt: now, memberCount, avatarVersion: null };
  await rt.sendToGroupMembers(groupId, { type: 'group_created', group });
  if (repaired.some((item) => item.groupId === groupId)) {
    await rt.sendToGroupMembers(groupId, { type: 'group_member_added', groupId });
  }
  res.status(201).json({ group });
});

router.get('/groups', async (req, res) => {
  const rows = await db.prepare(`SELECT g.id, g.name, g.created_at,
      (SELECT updated_at FROM group_avatars WHERE group_id = g.id) AS avatar_version,
      (SELECT COUNT(*) FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = g.id AND u.status = 'active') AS member_count,
      (SELECT gm.role FROM group_members gm WHERE gm.group_id = g.id AND gm.user_id = ?) AS role,
      (SELECT gm2.id FROM group_messages gm2
        LEFT JOIN group_message_hides h ON h.message_id = gm2.id AND h.user_id = ?
        LEFT JOIN group_clears gc ON gc.group_id = gm2.group_id AND gc.user_id = ?
        WHERE gm2.group_id = g.id AND h.message_id IS NULL AND gm2.id > COALESCE(gc.cleared_through_id, 0)
        ORDER BY gm2.id DESC LIMIT 1) AS last_id,
      (SELECT gm2.sender_id FROM group_messages gm2
        LEFT JOIN group_message_hides h ON h.message_id = gm2.id AND h.user_id = ?
        LEFT JOIN group_clears gc ON gc.group_id = gm2.group_id AND gc.user_id = ?
        WHERE gm2.group_id = g.id AND h.message_id IS NULL AND gm2.id > COALESCE(gc.cleared_through_id, 0)
        ORDER BY gm2.id DESC LIMIT 1) AS last_sender_id,
      (SELECT u.full_name FROM group_messages gm2 JOIN users u ON u.id = gm2.sender_id
        LEFT JOIN group_message_hides h ON h.message_id = gm2.id AND h.user_id = ?
        LEFT JOIN group_clears gc ON gc.group_id = gm2.group_id AND gc.user_id = ?
        WHERE gm2.group_id = g.id AND h.message_id IS NULL AND gm2.id > COALESCE(gc.cleared_through_id, 0)
        ORDER BY gm2.id DESC LIMIT 1) AS last_sender_name,
      (SELECT gm2.body FROM group_messages gm2
        LEFT JOIN group_message_hides h ON h.message_id = gm2.id AND h.user_id = ?
        LEFT JOIN group_clears gc ON gc.group_id = gm2.group_id AND gc.user_id = ?
        WHERE gm2.group_id = g.id AND h.message_id IS NULL AND gm2.id > COALESCE(gc.cleared_through_id, 0)
        ORDER BY gm2.id DESC LIMIT 1) AS last_body,
      (SELECT gm2.created_at FROM group_messages gm2
        LEFT JOIN group_message_hides h ON h.message_id = gm2.id AND h.user_id = ?
        LEFT JOIN group_clears gc ON gc.group_id = gm2.group_id AND gc.user_id = ?
        WHERE gm2.group_id = g.id AND h.message_id IS NULL AND gm2.id > COALESCE(gc.cleared_through_id, 0)
        ORDER BY gm2.id DESC LIMIT 1) AS last_created_at,
      (SELECT COUNT(*) FROM group_messages gm2
        WHERE gm2.group_id = g.id AND gm2.sender_id != ?
          AND NOT EXISTS (SELECT 1 FROM group_message_hides gh WHERE gh.message_id = gm2.id AND gh.user_id = ?)
          AND gm2.id > COALESCE((SELECT gc.cleared_through_id FROM group_clears gc WHERE gc.group_id = g.id AND gc.user_id = ?), 0)
          AND gm2.id > COALESCE((SELECT gr.last_read_message_id FROM group_reads gr
            WHERE gr.group_id = g.id AND gr.user_id = ?), 0)) AS unread
    FROM groups g JOIN group_members mine ON mine.group_id = g.id AND mine.user_id = ?
    ORDER BY COALESCE(last_created_at, g.created_at) DESC, g.id DESC`)
    .all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id,
      req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id,
      req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ groups: rows.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.created_at,
    avatarVersion: g.avatar_version || null,
    memberCount: g.member_count,
    role: g.role,
    lastMessage: g.last_id == null ? null : {
      id: g.last_id,
      groupId: g.id,
      senderId: g.last_sender_id,
      senderName: g.last_sender_name,
      text: g.last_body,
      createdAt: g.last_created_at,
    },
    unread: g.unread,
  })) });
});

router.get('/groups/:id/members', async (req, res) => {
  const groupId = Number(req.params.id);
  const membership = await groupMembership(groupId, req.user.id);
  if (!membership) return res.status(404).json({ message: 'Group not found.' });
  const members = await groupMemberRows(groupId);
  res.json({
    group: {
      id: membership.id, name: membership.name, role: membership.role,
      memberCount: members.length,
      avatarVersion: membership.avatar_version || null,
    },
    members,
  });
});

router.get('/groups/:id/messages', async (req, res) => {
  const groupId = Number(req.params.id);
  const membership = await requireGroupMember(groupId, req.user.id, res);
  if (!membership) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
  const rows = await db.prepare(`SELECT gm.*, u.full_name AS sender_name, ua.updated_at AS avatar_version
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    LEFT JOIN user_avatars ua ON ua.user_id = u.id
    LEFT JOIN group_message_hides h ON h.message_id = gm.id AND h.user_id = ?
    LEFT JOIN group_clears gc ON gc.group_id = gm.group_id AND gc.user_id = ?
    WHERE gm.group_id = ? AND gm.id < ? AND h.message_id IS NULL
      AND gm.id > COALESCE(gc.cleared_through_id, 0)
    ORDER BY gm.id DESC LIMIT ?`)
    .all(req.user.id, req.user.id, groupId, before, limit + 1);
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit).reverse();
  const page = selected.map(groupMessageOut);
  const read = await db.prepare('SELECT last_read_message_id AS r FROM group_reads WHERE group_id = ? AND user_id = ?')
    .get(groupId, req.user.id);
  const firstUnread = await db.prepare(`SELECT gm.id FROM group_messages gm
    LEFT JOIN group_message_hides h ON h.message_id = gm.id AND h.user_id = ?
    LEFT JOIN group_clears gc ON gc.group_id = gm.group_id AND gc.user_id = ?
    WHERE gm.group_id = ? AND gm.sender_id != ? AND gm.id > ?
      AND h.message_id IS NULL AND gm.id > COALESCE(gc.cleared_through_id, 0)
    ORDER BY gm.id ASC LIMIT 1`)
    .get(req.user.id, req.user.id, groupId, req.user.id, read ? read.r : 0);
  res.json({
    messages: page,
    hasMore,
    firstUnreadMessageId: firstUnread ? firstUnread.id : null,
    group: {
      id: membership.id, name: membership.name, role: membership.role,
      avatarVersion: membership.avatar_version || null,
      members: await groupMemberRows(groupId),
    },
  });
});

router.get('/groups/:id/avatar', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId) || groupId < 1) {
    return res.status(404).json({ message: 'Group photo not found.' });
  }
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  const row = await db.prepare('SELECT mime, data, updated_at FROM group_avatars WHERE group_id = ?')
    .get(groupId);
  if (!row) return res.status(404).json({ message: 'Group photo not found.' });

  const etag = `"group-avatar-${groupId}-${row.updated_at}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', `private, max-age=${MAX_AVATAR_PREVIEW_AGE}, must-revalidate`);
  res.type(row.mime);
  const ifNoneMatch = req.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === '*' || candidate === etag || candidate === `W/${etag}`;
  })) return res.status(304).end();
  res.status(200).send(Buffer.from(row.data));
});

router.post('/groups/:id/avatar', parseGroupAvatar, async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId) || groupId < 1) {
    return res.status(404).json({ message: 'Group not found.' });
  }
  const membership = await requireGroupMember(groupId, req.user.id, res);
  if (!membership) return;
  if (membership.role !== 'admin') {
    return res.status(403).json({ message: 'Only group admins can change the group photo.' });
  }
  const mime = req.get('Content-Type');
  if (!ALLOWED_AVATAR_MIME.has(mime)) {
    return res.status(415).json({ message: 'Choose a JPEG, PNG, or WebP image.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ message: 'Choose an image to upload.' });
  }
  if (req.body.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ message: 'Group photos must be 300 KB or smaller.' });
  }
  if (signatureMime(req.body) !== mime) {
    return res.status(415).json({ message: 'The image content does not match its file type.' });
  }

  const avatarVersion = await db.transaction(async (tx) => {
    const previous = await tx.prepare('SELECT updated_at FROM group_avatars WHERE group_id = ?').get(groupId);
    const group = await tx.prepare('SELECT avatar_version FROM groups WHERE id = ?').get(groupId);
    const version = Math.max(Date.now(), (previous ? previous.updated_at : 0) + 1, group.avatar_version + 1);
    await tx.prepare(`INSERT INTO group_avatars (group_id, mime, data, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(group_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
      .run(groupId, mime, new Uint8Array(req.body), version);
    await tx.prepare('UPDATE groups SET avatar_version = ? WHERE id = ?').run(version, groupId);
    await tx.audit(req.user.id, 'group_avatar_uploaded', groupId, req.ip);
    return version;
  });
  await rt.sendToGroupMembers(groupId, { type: 'group_avatar_updated', groupId, avatarVersion });
  res.json({ ok: true, avatarVersion });
});

router.delete('/groups/:id/avatar', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId) || groupId < 1) {
    return res.status(404).json({ message: 'Group not found.' });
  }
  const membership = await requireGroupMember(groupId, req.user.id, res);
  if (!membership) return;
  if (membership.role !== 'admin') {
    return res.status(403).json({ message: 'Only group admins can change the group photo.' });
  }

  const removed = await db.transaction(async (tx) => {
    const result = await tx.prepare('DELETE FROM group_avatars WHERE group_id = ?').run(groupId);
    if (result.changes) {
      await tx.prepare('UPDATE groups SET avatar_version = MAX(avatar_version + 1, ?) WHERE id = ?')
        .run(Date.now(), groupId);
      await tx.audit(req.user.id, 'group_avatar_removed', groupId, req.ip);
    }
    return result.changes;
  });
  if (removed) {
    await rt.sendToGroupMembers(groupId, { type: 'group_avatar_updated', groupId, avatarVersion: null });
  }
  res.json({ ok: true, avatarVersion: null });
});

router.post('/groups/:id/messages', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  const text = String((req.body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return res.status(400).json({ message: 'Write a message before sending.' });
  if (text.length > MAX_LEN) return res.status(400).json({ message: `Messages can be up to ${MAX_LEN} characters.` });
  const now = Date.now();
  const info = await db.transaction(async (tx) => {
    const result = await tx.prepare('INSERT INTO group_messages (group_id, sender_id, body, created_at) VALUES (?,?,?,?)')
      .run(groupId, req.user.id, text, now);
    await tx.prepare(`INSERT INTO group_message_receipts (message_id, user_id)
      SELECT ?, gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id AND u.status = 'active'
      WHERE gm.group_id = ? AND gm.user_id != ?`)
      .run(result.lastInsertRowid, groupId, req.user.id);
    return result;
  });
  const row = await db.prepare(`SELECT gm.*, u.full_name AS sender_name, ua.updated_at AS avatar_version
    FROM group_messages gm JOIN users u ON u.id = gm.sender_id
    LEFT JOIN user_avatars ua ON ua.user_id = u.id WHERE gm.id = ?`).get(info.lastInsertRowid);
  const message = groupMessageOut(row);
  await rt.sendToGroupMembers(groupId, { type: 'group_message', message });
  await db.audit(req.user.id, 'group_message', groupId, req.ip);
  res.status(201).json({ message });
});

router.patch('/groups/:id/messages/:messageId', async (req, res) => {
  const groupId = Number(req.params.id), messageId = Number(req.params.messageId);
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  const message = await db.prepare('SELECT * FROM group_messages WHERE id = ? AND group_id = ?').get(messageId, groupId);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only edit your own messages.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Deleted messages cannot be edited.' });
  if (Date.now() - message.created_at > 15 * 60 * 1000) return res.status(409).json({ message: 'Messages can only be edited within 15 minutes.' });
  const text = String((req.body || {}).text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return res.status(400).json({ message: 'Message cannot be empty.' });
  if (text.length > MAX_LEN) return res.status(400).json({ message: `Messages can be up to ${MAX_LEN} characters.` });
  const editedAt = Date.now();
  const updatedCount = await db.prepare(`UPDATE group_messages SET body = ?, edited_at = ?
    WHERE id = ? AND sender_id = ? AND deleted_at IS NULL AND created_at >= ?`)
    .run(text, editedAt, messageId, req.user.id, editedAt - 15 * 60 * 1000);
  if (!updatedCount.changes) return res.status(409).json({ message: 'Messages can only be edited within 15 minutes.' });
  const updatedRow = await db.prepare(`SELECT gm.*, u.full_name AS sender_name, ua.updated_at AS avatar_version
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    LEFT JOIN user_avatars ua ON ua.user_id = u.id WHERE gm.id = ?`).get(messageId);
  const updated = groupMessageOut(updatedRow);
  await rt.sendToGroupMembers(groupId, { type: 'message_edited', scope: 'group', message: updated });
  res.json({ message: updated });
});

router.post('/groups/:id/messages/:messageId/delete', async (req, res) => {
  const groupId = Number(req.params.id), messageId = Number(req.params.messageId);
  const mode = (req.body || {}).mode;
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  if (!Number.isSafeInteger(messageId) || messageId < 1) return res.status(400).json({ message: 'Invalid message ID.' });
  if (!['me', 'everyone'].includes(mode)) return res.status(400).json({ message: 'Choose a valid delete option.' });
  const message = await db.prepare('SELECT * FROM group_messages WHERE id = ? AND group_id = ?').get(messageId, groupId);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (mode === 'me') {
    await db.prepare(`INSERT INTO group_message_hides (message_id, user_id, hidden_at) VALUES (?,?,?)
      ON CONFLICT(message_id, user_id) DO NOTHING`).run(messageId, req.user.id, Date.now());
    rt.sendToUser(req.user.id, {
      type: 'message_hidden', scope: 'group', groupId, messageId, userId: req.user.id,
    });
    return res.json({ ok: true });
  }
  if (message.sender_id !== req.user.id) return res.status(403).json({ message: 'You can only delete your own message for everyone.' });
  if (message.deleted_at) return res.status(409).json({ message: 'Message is already deleted.' });
  if (Date.now() - message.created_at > 60 * 60 * 1000) return res.status(409).json({ message: 'Messages can only be deleted for everyone within 1 hour.' });
  const deletedAt = Date.now();
  const deletedCount = await db.prepare(`UPDATE group_messages SET body = 'This message was deleted', deleted_at = ?, edited_at = NULL
    WHERE id = ? AND sender_id = ? AND deleted_at IS NULL AND created_at >= ?`)
    .run(deletedAt, messageId, req.user.id, deletedAt - 60 * 60 * 1000);
  if (!deletedCount.changes) return res.status(409).json({ message: 'Messages can only be deleted for everyone within 1 hour.' });
  const updatedRow = await db.prepare(`SELECT gm.*, u.full_name AS sender_name, ua.updated_at AS avatar_version
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    LEFT JOIN user_avatars ua ON ua.user_id = u.id WHERE gm.id = ?`).get(messageId);
  const updated = groupMessageOut(updatedRow);
  await rt.sendToGroupMembers(groupId, { type: 'message_deleted', scope: 'group', message: updated });
  res.json({ ok: true, message: updated });
});

router.post('/groups/:id/clear', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  const last = await db.prepare('SELECT MAX(id) AS id FROM group_messages WHERE group_id = ?').get(groupId);
  await db.prepare(`INSERT INTO group_clears (group_id, user_id, cleared_through_id) VALUES (?,?,?)
    ON CONFLICT(group_id, user_id) DO UPDATE SET cleared_through_id = MAX(cleared_through_id, excluded.cleared_through_id)`)
    .run(groupId, req.user.id, last.id || 0);
  await rt.sendToGroupMembers(groupId, {
    type: 'chat_cleared', scope: 'group', groupId, userId: req.user.id,
  });
  res.json({ ok: true });
});

router.post('/groups/:id/members', async (req, res) => {
  const groupId = Number(req.params.id);
  const membership = await groupMembership(groupId, req.user.id);
  if (!membership) return res.status(404).json({ message: 'Group not found.' });
  if (membership.role !== 'admin') return res.status(403).json({ message: 'Only group admins can add members.' });
  const memberIds = parseIds((req.body || {}).memberIds);
  if (!memberIds || memberIds.includes(req.user.id) || !memberIds.length) {
    return res.status(400).json({ message: 'Choose valid employees to add to the group.' });
  }
  const placeholders = memberIds.map(() => '?').join(',');
  const available = await db.prepare(`SELECT id FROM users WHERE status = 'active' AND role != 'admin' AND id IN (${placeholders})`).all(...memberIds);
  if (available.length !== memberIds.length) return res.status(400).json({ message: 'One or more selected employees are not available.' });
  const now = Date.now();
  const added = await db.transaction(async (tx) => {
    const insert = tx.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
      VALUES (?,?,'member',?)`);
    const added = [];
    for (const id of memberIds) {
      if ((await insert.run(groupId, id, now)).changes) added.push(id);
    }
    if (added.length) await tx.audit(req.user.id, 'group_members_added', `${groupId}:${added.join(',')}`, req.ip);
    return added;
  });
  if (added.length) await rt.sendToGroupMembers(groupId, { type: 'group_member_added', groupId, userIds: added });
  res.status(201).json({ added });
});

router.delete('/groups/:id/members/:userId', async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = Number(req.params.userId);
  const membership = await groupMembership(groupId, req.user.id);
  if (!membership) return res.status(404).json({ message: 'Group not found.' });
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ message: 'Invalid employee.' });
  if (userId !== req.user.id && membership.role !== 'admin') {
    return res.status(403).json({ message: 'Only group admins can remove other members.' });
  }
  const target = await db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!target) return res.status(404).json({ message: 'Group member not found.' });
  const globalTarget = await db.prepare("SELECT role FROM users WHERE id = ? AND status = 'active'").get(userId);
  if (globalTarget && globalTarget.role === 'admin') {
    return res.status(403).json({ message: 'The administrator cannot be removed from a group' });
  }
  await db.transaction(async (tx) => {
    if (target.role === 'admin' && userId === req.user.id) {
      const activeAdmins = (await tx.prepare(`SELECT COUNT(*) AS n FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND gm.user_id != ? AND gm.role = 'admin' AND u.status = 'active'`).get(groupId, userId)).n;
      const nextAdmin = activeAdmins ? null : await tx.prepare(`SELECT gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND gm.user_id != ? AND u.status = 'active'
        ORDER BY gm.joined_at, gm.user_id LIMIT 1`).get(groupId, userId);
      if (nextAdmin) {
        await tx.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?")
          .run(groupId, nextAdmin.user_id);
      }
    }
    await tx.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    await tx.prepare('DELETE FROM group_reads WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    const remaining = (await tx.prepare(`SELECT COUNT(*) AS n FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? AND u.status = 'active'`).get(groupId)).n;
    if (!remaining) await tx.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    await tx.audit(req.user.id, userId === req.user.id ? 'group_left' : 'group_member_removed', `${groupId}:${userId}`, req.ip);
  });
  const event = { type: 'group_member_removed', groupId, userId, removedUserId: userId };
  await rt.sendToGroupMembers(groupId, event);
  rt.sendToUser(userId, event);
  res.json({ ok: true });
});

router.delete('/groups/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Only the administrator can delete a group.' });
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId) || groupId < 1) return res.status(400).json({ message: 'Invalid group.' });
  const group = await db.prepare('SELECT id, name FROM groups WHERE id = ?').get(groupId);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  const members = await db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
  const memberIds = members.map((member) => member.user_id);
  await Promise.all(memberIds.map((userId) => rt.sendToUser(userId, { type: 'group_deleted', groupId })));
  await db.transaction(async (tx) => {
    await tx.prepare('DELETE FROM group_message_receipts WHERE message_id IN (SELECT id FROM group_messages WHERE group_id = ?)').run(groupId);
    await tx.prepare('DELETE FROM group_message_hides WHERE message_id IN (SELECT id FROM group_messages WHERE group_id = ?)').run(groupId);
    await tx.prepare('DELETE FROM group_clears WHERE group_id = ?').run(groupId);
    await tx.prepare('DELETE FROM group_reads WHERE group_id = ?').run(groupId);
    await tx.prepare('DELETE FROM group_messages WHERE group_id = ?').run(groupId);
    await tx.prepare('DELETE FROM group_avatars WHERE group_id = ?').run(groupId);
    await tx.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
    await tx.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
    await tx.audit(req.user.id, 'group_deleted', JSON.stringify({ groupId, name: group.name, memberCount: memberIds.length }), req.ip);
  });
  res.json({ ok: true });
});

router.post('/groups/:id/read', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!await requireGroupMember(groupId, req.user.id, res)) return;
  const upTo = parseInt((req.body || {}).lastReadMessageId, 10);
  if (!Number.isInteger(upTo) || upTo < 0) return res.status(400).json({ message: 'Invalid read marker.' });
  const valid = (await db.prepare('SELECT MAX(id) AS m FROM group_messages WHERE group_id = ? AND id <= ?').get(groupId, upTo)).m || 0;
  const statusUpdates = await markGroupRead(req.user.id, groupId, valid);
  statusUpdates.forEach((status) => rt.sendToUser(status.senderId, {
    type: 'message_status', scope: 'group', ...status,
  }));
  await db.prepare(`INSERT INTO group_reads (group_id, user_id, last_read_message_id) VALUES (?,?,?)
    ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`)
    .run(groupId, req.user.id, valid);
  rt.sendToUser(req.user.id, {
    type: 'message_status', scope: 'group', groupId, readByUserId: req.user.id,
    lastReadMessageId: valid,
  });
  res.json({ ok: true });
});

module.exports = router;
