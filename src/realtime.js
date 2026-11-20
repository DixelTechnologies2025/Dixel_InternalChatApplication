const { WebSocketServer } = require('ws');
const db = require('./db');
const { COOKIE, authFromToken } = require('./security');
const { markDirectDelivered, markGroupDelivered } = require('./message-status');
const { loadReactions } = require('./reactions');

// Tiny Cookie-header parser (avoids depending on a library API that changed between major versions).
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('='); if (i < 0) return;
    const k = part.slice(0, i).trim(); let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    if (!(k in out)) out[k] = v;
  });
  return out;
}

const clients = new Map(); // userId -> Set<{ ws, tokenRaw }>

const isOnline = (userId) => clients.has(userId) && clients.get(userId).size > 0;
const onlineIds = () => [...clients.keys()];

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
function sendToUser(userId, payload) {
  for (const c of clients.get(userId) || []) send(c.ws, payload);
}
async function sendToGroupMembers(groupId, payload) {
  const members = await db.prepare(`SELECT gm.user_id FROM group_members gm
    JOIN users u ON u.id = gm.user_id AND u.status = 'active'
    WHERE gm.group_id = ?`).all(groupId);
  members.forEach((member) => sendToUser(member.user_id, payload));
}
async function broadcastToAdmins(payload) {
  const admins = await db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
  admins.forEach((admin) => sendToUser(admin.id, payload));
}
function broadcast(payload) {
  for (const set of clients.values()) for (const c of set) send(c.ws, payload);
}
function disconnectUser(userId) {
  for (const c of [...(clients.get(userId) || [])]) c.ws.close(4001, 'signed out');
}
function disconnectToken(tokenRaw) {
  for (const set of clients.values()) for (const c of set) if (c.tokenRaw === tokenRaw) c.ws.close(4001, 'signed out');
}

function attach(server, cfg) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const reject = (code) => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return reject('400 Bad Request'); }
    if (url.pathname !== '/ws') return reject('404 Not Found');

    // Block cross-site WebSocket hijacking: Origin must match this server's host.
    const origin = req.headers.origin;
    if (origin) {
      let oh; try { oh = new URL(origin).host; } catch { return reject('403 Forbidden'); }
      if (oh !== req.headers.host) return reject('403 Forbidden');
    }
    const tokenRaw = parseCookies(req.headers.cookie)[COOKIE];
    let user;
    try {
      user = await authFromToken(tokenRaw);
    } catch (error) {
      console.error('[realtime] WebSocket authentication failed:', error);
      return reject('500 Internal Server Error');
    }
    if (!user) return reject('401 Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user, tokenRaw));
  });

  function onConnect(ws, user, tokenRaw) {
    const entry = { ws, tokenRaw };
    const first = !isOnline(user.id);
    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(entry);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!event || !['typing', 'delivered', 'group_delivered'].includes(event.type)) return;
      if (event.type === 'typing' && (!Number.isInteger(event.conversationId) || typeof event.typing !== 'boolean')) return;
      if (event.type !== 'typing' && (!Number.isSafeInteger(event.messageId) || event.messageId < 1)) return;

      let current;
      try {
        current = await authFromToken(tokenRaw);
      } catch (error) {
        console.error('[realtime] WebSocket session validation failed:', error);
        return ws.close(1011, 'server error');
      }
      if (!current || current.id !== user.id) return ws.close(4001, 'session ended');
      if (event.type === 'delivered') {
        try {
          const status = await markDirectDelivered(user.id, event.messageId);
          if (status) sendToUser(status.sender_id, {
            type: 'message_status', scope: 'direct', conversationId: status.conversation_id,
            updates: [{ messageId: status.id, deliveredAt: status.delivered_at, readAt: status.read_at }],
          });
        } catch (error) {
          console.error('[realtime] Failed to record message delivery:', error);
          return ws.close(1011, 'server error');
        }
        return;
      }
      if (event.type === 'group_delivered') {
        try {
          const status = await markGroupDelivered(user.id, event.messageId);
          if (status) sendToUser(status.senderId, { type: 'message_status', scope: 'group', ...status });
        } catch (error) {
          console.error('[realtime] Failed to record group message delivery:', error);
          return ws.close(1011, 'server error');
        }
        return;
      }
      let conversation;
      try {
        conversation = await db.prepare(`SELECT c.user_a, c.user_b FROM conversations c
        JOIN users a ON a.id = c.user_a AND a.status = 'active'
        JOIN users b ON b.id = c.user_b AND b.status = 'active'
        WHERE c.id = ? AND (c.user_a = ? OR c.user_b = ?)`)
        .get(event.conversationId, user.id, user.id);
      } catch (error) {
        console.error('[realtime] WebSocket conversation lookup failed:', error);
        return ws.close(1011, 'server error');
      }
      if (!conversation) return;
      if (conversation.user_a === user.id && conversation.user_b === user.id) return;

      const recipientId = conversation.user_a === user.id ? conversation.user_b : conversation.user_a;
      sendToUser(recipientId, {
        type: 'typing',
        conversationId: event.conversationId,
        userId: user.id,
        typing: event.typing,
      });
    });
    ws.on('error', () => {});
    send(ws, { type: 'ready', online: onlineIds() });
    if (first) broadcast({ type: 'presence', userId: user.id, online: true });
    deliverPendingMessages(ws, user.id).catch((error) => {
      console.error('[realtime] Failed to deliver pending messages:', error);
      ws.close(1011, 'server error');
    });

    ws.on('close', () => {
      const set = clients.get(user.id);
      if (set) { set.delete(entry); if (!set.size) clients.delete(user.id); }
      if (!isOnline(user.id)) {
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id)
          .catch((error) => console.error('[realtime] Failed to update last-seen time:', error));
        broadcast({ type: 'presence', userId: user.id, online: false, lastSeenAt: Date.now() });
      }
    });
  }

  // Heartbeat + re-validate sessions so expired/revoked/deactivated users are dropped.
  setInterval(async () => {
    for (const set of clients.values()) {
      for (const c of set) {
        let current;
        try {
          current = await authFromToken(c.tokenRaw);
        } catch (error) {
          console.error('[realtime] WebSocket heartbeat session check failed:', error);
          c.ws.close(1011, 'server error');
          continue;
        }
        if (!current) { c.ws.close(4001, 'session ended'); continue; }
        if (!c.ws.isAlive) { c.ws.terminate(); continue; }
        c.ws.isAlive = false;
        c.ws.ping();
      }
    }
  }, 30000).unref();
}

async function deliverPendingMessages(ws, userId) {
  const direct = await db.prepare(`SELECT m.*, u.full_name FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN message_hides h ON h.message_id = m.id AND h.user_id = ?
    LEFT JOIN conversation_clears cc ON cc.conversation_id = m.conversation_id AND cc.user_id = ?
    WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id != ? AND m.delivered_at IS NULL
      AND m.deleted_at IS NULL AND h.message_id IS NULL
      AND m.id > COALESCE(cc.cleared_through_id, 0)
    ORDER BY m.id`)
    .all(userId, userId, userId, userId, userId);
  const directReactions = await loadReactions(direct.map((m) => m.id), 'direct');
  direct.forEach((m) => send(ws, {
    type: 'message',
    message: {
      id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
      senderName: m.full_name, text: m.body, createdAt: m.created_at,
      deliveredAt: m.delivered_at, readAt: m.read_at, editedAt: m.edited_at,
      deleted: !!m.deleted_at,
      reactions: directReactions.get(Number(m.id)) || [],
    },
  }));

  const groups = await db.prepare(`SELECT gm.*, u.full_name AS sender_name, ua.updated_at AS avatar_version
    FROM group_message_receipts r
    JOIN group_messages gm ON gm.id = r.message_id
    JOIN group_members mine ON mine.group_id = gm.group_id AND mine.user_id = r.user_id
    JOIN users u ON u.id = gm.sender_id
    LEFT JOIN user_avatars ua ON ua.user_id = u.id
    LEFT JOIN group_message_hides h ON h.message_id = gm.id AND h.user_id = r.user_id
    LEFT JOIN group_clears gc ON gc.group_id = gm.group_id AND gc.user_id = r.user_id
    WHERE r.user_id = ? AND r.delivered_at IS NULL AND gm.deleted_at IS NULL
      AND h.message_id IS NULL AND gm.id > COALESCE(gc.cleared_through_id, 0)
    ORDER BY gm.id`).all(userId);
  const groupReactions = await loadReactions(groups.map((m) => m.id), 'group');
  groups.forEach((m) => send(ws, {
    type: 'group_message',
    message: {
      id: m.id, groupId: m.group_id, senderId: m.sender_id,
      senderName: m.sender_name, avatarVersion: m.avatar_version, text: m.body, createdAt: m.created_at,
      deliveredAt: m.delivered_at, readAt: m.read_at, editedAt: m.edited_at,
      deleted: !!m.deleted_at,
      reactions: groupReactions.get(Number(m.id)) || [],
    },
  }));
}

module.exports = { attach, sendToUser, sendToGroupMembers, broadcastToAdmins, broadcast, isOnline, onlineIds, disconnectUser, disconnectToken };
