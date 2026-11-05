const { WebSocketServer } = require('ws');
const db = require('./db');
const { COOKIE, authFromToken } = require('./security');

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

  server.on('upgrade', (req, socket, head) => {
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
    const user = authFromToken(tokenRaw);
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
    ws.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!event || event.type !== 'typing' || !Number.isInteger(event.conversationId) || typeof event.typing !== 'boolean') return;

      const current = authFromToken(tokenRaw);
      if (!current || current.id !== user.id) return ws.close(4001, 'session ended');
      const conversation = db.prepare(`SELECT c.user_a, c.user_b FROM conversations c
        JOIN users a ON a.id = c.user_a AND a.status = 'active'
        JOIN users b ON b.id = c.user_b AND b.status = 'active'
        WHERE c.id = ? AND (c.user_a = ? OR c.user_b = ?)`)
        .get(event.conversationId, user.id, user.id);
      if (!conversation) return;

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

    ws.on('close', () => {
      const set = clients.get(user.id);
      if (set) { set.delete(entry); if (!set.size) clients.delete(user.id); }
      if (!isOnline(user.id)) {
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), user.id);
        broadcast({ type: 'presence', userId: user.id, online: false, lastSeenAt: Date.now() });
      }
    });
  }

  // Heartbeat + re-validate sessions so expired/revoked/deactivated users are dropped.
  setInterval(() => {
    for (const set of clients.values()) {
      for (const c of set) {
        if (!authFromToken(c.tokenRaw)) { c.ws.close(4001, 'session ended'); continue; }
        if (!c.ws.isAlive) { c.ws.terminate(); continue; }
        c.ws.isAlive = false;
        c.ws.ping();
      }
    }
  }, 30000).unref();
}

module.exports = { attach, sendToUser, broadcast, isOnline, onlineIds, disconnectUser, disconnectToken };
