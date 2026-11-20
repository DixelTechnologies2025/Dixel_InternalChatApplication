const db = require('./db');

const EMOJI_PART = /[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/u;
const EMOJI_CORE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

function isOneEmoji(value) {
  if (typeof value !== 'string' || !value || value.includes('<') || value.includes('>')) return false;
  const emojiPayload = [...value].filter((char) => !/[\u200d\ufe0f\u20e3]/u.test(char)).join('');
  if (Buffer.byteLength(emojiPayload, 'utf8') > 16) return false;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  if (segments.length !== 1 || !EMOJI_CORE.test(value)) return false;
  for (const char of value) {
    if (!EMOJI_PART.test(char)) return false;
  }
  return true;
}

async function loadReactions(messageIds, scope) {
  const ids = [...new Set(messageIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const table = scope === 'group' ? 'group_message_reactions' : 'direct_message_reactions';
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT r.message_id, r.user_id, u.full_name, r.emoji
    FROM ${table} r JOIN users u ON u.id = r.user_id
    WHERE r.message_id IN (${placeholders}) ORDER BY r.message_id, r.created_at, r.user_id`).all(...ids);
  rows.forEach((row) => out.get(row.message_id).push({ userId: row.user_id, fullName: row.full_name, emoji: row.emoji }));
  return out;
}

function attachReactions(messages, reactions) {
  return messages.map((message) => Object.assign(message, { reactions: reactions.get(Number(message.id)) || [] }));
}

module.exports = { isOneEmoji, loadReactions, attachReactions };
