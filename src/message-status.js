const db = require('./db');

async function markDirectDelivered(userId, messageId) {
  const message = await db.prepare(`SELECT m.id, m.conversation_id, m.sender_id, m.delivered_at, m.read_at
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND m.sender_id != ? AND (c.user_a = ? OR c.user_b = ?)`)
    .get(messageId, userId, userId, userId);
  if (!message) return null;
  const deliveredAt = Date.now();
  await db.prepare('UPDATE messages SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?')
    .run(deliveredAt, message.id);
  const status = await db.prepare('SELECT delivered_at, read_at FROM messages WHERE id = ?').get(message.id);
  return { ...message, delivered_at: status.delivered_at, read_at: status.read_at };
}

async function markGroupDelivered(userId, messageId) {
  const receipt = await db.prepare(`SELECT r.message_id, r.delivered_at, gm.group_id, gm.sender_id
    FROM group_message_receipts r JOIN group_messages gm ON gm.id = r.message_id
    JOIN group_members mine ON mine.group_id = gm.group_id AND mine.user_id = ?
    WHERE r.message_id = ? AND r.user_id = ?`)
    .get(userId, messageId, userId);
  if (!receipt) return null;
  const deliveredAt = Date.now();
  await db.prepare(`UPDATE group_message_receipts SET delivered_at = COALESCE(delivered_at, ?)
    WHERE message_id = ? AND user_id = ?`).run(deliveredAt, messageId, userId);
  return refreshGroupMessageStatus(messageId, receipt.group_id, receipt.sender_id);
}

async function refreshGroupMessageStatus(messageId, groupId, senderId) {
  await db.prepare(`UPDATE group_messages
    SET delivered_at = CASE
          WHEN EXISTS (SELECT 1 FROM group_message_receipts WHERE message_id = ?)
            AND NOT EXISTS (SELECT 1 FROM group_message_receipts WHERE message_id = ? AND delivered_at IS NULL)
          THEN COALESCE(delivered_at, ?)
          ELSE delivered_at
        END,
        read_at = CASE
          WHEN EXISTS (SELECT 1 FROM group_message_receipts WHERE message_id = ?)
            AND NOT EXISTS (SELECT 1 FROM group_message_receipts WHERE message_id = ? AND read_at IS NULL)
          THEN COALESCE(read_at, ?)
          ELSE read_at
        END
    WHERE id = ?`).run(messageId, messageId, Date.now(), messageId, messageId, Date.now(), messageId);
  const status = await db.prepare('SELECT delivered_at, read_at FROM group_messages WHERE id = ?').get(messageId);
  return status ? { messageId, groupId, senderId, deliveredAt: status.delivered_at, readAt: status.read_at } : null;
}

async function markGroupRead(userId, groupId, throughId) {
  const rows = await db.prepare(`SELECT r.message_id, gm.sender_id
    FROM group_message_receipts r JOIN group_messages gm ON gm.id = r.message_id
    WHERE r.user_id = ? AND gm.group_id = ? AND r.message_id <= ? AND r.read_at IS NULL`)
    .all(userId, groupId, throughId);
  if (!rows.length) return [];
  const now = Date.now();
  await db.prepare(`UPDATE group_message_receipts SET delivered_at = COALESCE(delivered_at, ?), read_at = ?
    WHERE user_id = ? AND message_id IN (${rows.map(() => '?').join(',')})`)
    .run(now, now, userId, ...rows.map((row) => row.message_id));
  const updates = [];
  for (const row of rows) {
    const status = await refreshGroupMessageStatus(row.message_id, groupId, row.sender_id);
    if (status) updates.push(status);
  }
  return updates;
}

module.exports = { markDirectDelivered, markGroupDelivered, markGroupRead };
