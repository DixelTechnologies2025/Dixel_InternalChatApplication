const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const sourcePath = path.resolve(process.env.DEV_DB_PATH || path.join(root, 'data', 'chat.db'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-self-chat-test-'));
const dbPath = path.join(tempDir, 'self-chat.db');
const domain = 'self-chat-test.example';
const password = 'SelfChatUser123!';
let server;
let db;
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) passed++;
  else failed++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
}

function getPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  get cookie() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async call(method, url, body) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'dixel' };
    if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(this.base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    cookies.forEach((cookie) => {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    });
    let data = {};
    try { data = await response.json(); } catch {}
    return { status: response.status, data };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws', {
        headers: { Cookie: this.cookie, Origin: this.base },
      });
      socket.events = [];
      socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEvent(socket, predicate, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const event = socket.events.find(predicate);
    if (event) return event;
    await sleep(20);
  }
  return socket.events.find(predicate) || null;
}

async function waitForServer(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Temporary chat server exited during startup.');
    try {
      if ((await fetch(base + '/login.html')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for the temporary chat server.');
}

async function snapshotDevDatabase() {
  if (!fs.existsSync(sourcePath)) throw new Error(`Development DB copy source not found: ${sourcePath}`);
  const source = createClient({ url: pathToFileURL(sourcePath).href, intMode: 'number' });
  try {
    const counts = await source.execute(`SELECT
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM messages) AS messages`);
    const output = path.join(tempDir, 'self-chat.db');
    await source.execute(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
    return {
      conversations: Number(counts.rows[0].conversations),
      messages: Number(counts.rows[0].messages),
    };
  } finally {
    source.close();
  }
}

async function run() {
  const originalCounts = await snapshotDevDatabase();
  const port = await getPort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    APP_URL: base,
    DB_PATH: dbPath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    ADMIN_EMAIL: `admin@${domain}`,
    ADMIN_PASSWORD: 'SelfChatAdmin123!',
    COMPANY_DOMAIN: domain,
    SMTP_HOST: '',
    NODE_ENV: 'test',
    TRUST_PROXY: 'true',
  };
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (data) => { serverOutput += data.toString(); });
  server.stderr.on('data', (data) => { serverOutput += data.toString(); });
  await waitForServer(base);
  db = createClient({ url: pathToFileURL(dbPath).href, intMode: 'number' });

  const migratedCounts = await db.execute(`SELECT
    (SELECT COUNT(*) FROM conversations) AS conversations,
    (SELECT COUNT(*) FROM messages) AS messages`);
  check(Number(migratedCounts.rows[0].conversations) === originalCounts.conversations &&
    Number(migratedCounts.rows[0].messages) === originalCounts.messages,
  'new migration preserves existing conversations and messages');

  const admin = new Client(base);
  const alice = new Client(base);
  const bob = new Client(base);
  const adminLogin = await admin.call('POST', '/api/auth/login', {
    email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
  });
  check(adminLogin.status === 200, 'temporary copied-DB administrator signs in');

  const users = [
    { client: alice, name: 'Self Chat Alice', email: `alice@${domain}` },
    { client: bob, name: 'Self Chat Bob', email: `bob@${domain}` },
  ];
  for (const user of users) {
    const signup = await user.client.call('POST', '/api/auth/signup', {
      fullName: user.name, email: user.email, password, confirmPassword: password,
    });
    check(signup.status === 202, `${user.name} signup accepted`);
  }
  const pending = (await admin.call('GET', '/api/admin/users?status=pending')).data.users;
  for (const user of users) {
    const account = pending.find((item) => item.email === user.email);
    const approval = await admin.call('POST', `/api/admin/users/${account.id}/approve`, {});
    check(approval.status === 200, `${user.name} approved`);
    const login = await user.client.call('POST', '/api/auth/login', { email: user.email, password });
    check(login.status === 200, `${user.name} signs in`);
    user.id = login.data.user.id;
  }

  const aliceConversations = (await alice.call('GET', '/api/conversations')).data.conversations;
  const bobConversations = (await bob.call('GET', '/api/conversations')).data.conversations;
  const aliceSelf = aliceConversations.find((conversation) => conversation.self);
  const bobSelf = bobConversations.find((conversation) => conversation.self);
  check(!!aliceSelf && !aliceSelf.lastMessage && aliceSelf.unread === 0 &&
    aliceSelf.other.id === users[0].id && aliceSelf.other.lastSeenAt == null,
  'empty private self chat is created lazily with no unread or presence metadata');
  check(!!bobSelf && bobSelf.id !== aliceSelf.id &&
    !bobConversations.some((conversation) => conversation.id === aliceSelf.id),
  'each user gets a separate self chat and B has no entry for A’s self chat');

  const aliceTab1 = await alice.connect();
  const aliceTab2 = await alice.connect();
  const bobSocket = await bob.connect();
  const send = await alice.call('POST', `/api/conversations/${aliceSelf.id}/messages`, { text: 'Private note' });
  const messageId = send.data.message.id;
  const event1 = await waitForEvent(aliceTab1, (event) => event.type === 'message' && event.message.id === messageId);
  const event2 = await waitForEvent(aliceTab2, (event) => event.type === 'message' && event.message.id === messageId);
  await sleep(100);
  const aliceHistory = await alice.call('GET', `/api/conversations/${aliceSelf.id}/messages`);
  const bobHistory = await bob.call('GET', `/api/conversations/${bobSelf.id}/messages`);
  check(send.status === 201 && !!event1 && !!event2 &&
    aliceTab1.events.filter((event) => event.type === 'message' && event.message.id === messageId).length === 1 &&
    aliceTab2.events.filter((event) => event.type === 'message' && event.message.id === messageId).length === 1,
  'self message reaches each of A’s tabs exactly once');
  check(aliceHistory.data.messages.some((message) => message.id === messageId) &&
    !bobHistory.data.messages.some((message) => message.id === messageId) &&
    !bobSocket.events.some((event) => event.type === 'message' && event.message.id === messageId),
  'only A can read the self message; B receives no event and no history entry');

  await alice.call('POST', `/api/conversations/${aliceSelf.id}/read`, { lastReadMessageId: messageId });
  const untouched = await db.execute('SELECT delivered_at, read_at FROM messages WHERE id = ?', [messageId]);
  check(untouched.rows[0].delivered_at == null && untouched.rows[0].read_at == null &&
    !aliceTab1.events.some((event) => event.type === 'message_status' && event.conversationId === aliceSelf.id) &&
    aliceConversations.find((conversation) => conversation.self).unread === 0,
  'self chat has no delivered/seen receipts, status events, or unread count');

  const edited = await alice.call('PATCH', `/api/conversations/${aliceSelf.id}/messages/${messageId}`, { text: 'Edited private note' });
  const editEvent = await waitForEvent(aliceTab2, (event) => event.type === 'message_edited' && event.message.id === messageId);
  check(edited.status === 200 && edited.data.message.text === 'Edited private note' && !!editEvent &&
    aliceTab2.events.filter((event) => event.type === 'message_edited' && event.message.id === messageId).length === 1,
  'edit persists and broadcasts once to the other tab');

  const hidden = await alice.call('POST', `/api/conversations/${aliceSelf.id}/messages/${messageId}/delete`, { mode: 'me' });
  const hiddenHistory = await alice.call('GET', `/api/conversations/${aliceSelf.id}/messages`);
  const hiddenAgain = await alice.call('GET', `/api/conversations/${aliceSelf.id}/messages`);
  check(hidden.status === 200 && !hiddenHistory.data.messages.some((message) => message.id === messageId) &&
    !hiddenAgain.data.messages.some((message) => message.id === messageId),
  'delete for me hides the message and persists after history re-fetch');

  const everyoneSend = await alice.call('POST', `/api/conversations/${aliceSelf.id}/messages`, { text: 'Erase this text' });
  const everyoneId = everyoneSend.data.message.id;
  const deleted = await alice.call('POST', `/api/conversations/${aliceSelf.id}/messages/${everyoneId}/delete`, { mode: 'everyone' });
  const deleteEvent = await waitForEvent(aliceTab2, (event) => event.type === 'message_deleted' && event.message.id === everyoneId);
  const wiped = await db.execute('SELECT body, deleted_at FROM messages WHERE id = ?', [everyoneId]);
  check(deleted.status === 200 && deleted.data.message.text === 'This message was deleted' &&
    !!deleteEvent && wiped.rows[0].body === 'This message was deleted' && !!wiped.rows[0].deleted_at,
  'delete for everyone replaces and wipes the original message body and updates the other tab');

  const clearSend = await alice.call('POST', `/api/conversations/${aliceSelf.id}/messages`, { text: 'Clear this chat' });
  const cleared = await alice.call('POST', `/api/conversations/${aliceSelf.id}/clear`, {});
  const clearEvent = await waitForEvent(aliceTab2, (event) => event.type === 'chat_cleared' && event.conversationId === aliceSelf.id);
  const afterClear = await alice.call('GET', `/api/conversations/${aliceSelf.id}/messages`);
  check(clearSend.status === 201 && cleared.status === 200 && !!clearEvent && afterClear.data.messages.length === 0,
  'clear chat hides all self messages and broadcasts to the other tab');

  const employees = await bob.call('GET', `/api/employees?q=${encodeURIComponent(users[0].name.toLowerCase())}`);
  check(employees.status === 200 && !employees.data.employees.some((employee) => employee.self),
    'employee search exposes no self-chat record');

  aliceTab1.close();
  aliceTab2.close();
  bobSocket.close();
  await Promise.all([aliceTab1, aliceTab2, bobSocket].map((socket) => new Promise((resolve) => socket.once('close', resolve))));
  check(failed === 0, `self-chat test summary (${passed} passed, ${failed} failed)`);
  if (failed) throw new Error(`${failed} self-chat assertion(s) failed.\n${serverOutput}`);
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('close', resolve));
  }
  if (db) await db.close();
  await sleep(250);
  const cleanupScript = `
    const fs = require('fs');
    let attempts = 0;
    function remove() {
      try {
        fs.rmSync(${JSON.stringify(tempDir)}, { recursive: true, force: true });
      } catch (error) {
        if (++attempts >= 30) {
          console.error(error);
          process.exitCode = 1;
          return;
        }
        return setTimeout(remove, 500);
      }
    }
    setTimeout(remove, 1000);
  `;
  const cleanup = spawn(process.execPath, ['-e', cleanupScript], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    cleanup.once('error', reject);
    cleanup.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Temporary directory cleanup failed with exit code ${code}`)));
  });
});
