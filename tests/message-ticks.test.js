const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-ticks-test-'));
const dbPath = path.join(tempDir, 'ticks.db');
const domain = 'ticks-test.example';
const password = 'TickUserPass123!';
let server;
let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) passed++;
  else failed++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
}

function findPort() {
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

  async request(method, url, body) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Requested-With': 'dixel',
    };
    if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(this.base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    setCookies.forEach((cookie) => {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    });
    let data = {};
    try { data = await response.json(); } catch {}
    return { status: response.status, data };
  }

  connectWebSocket() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws', {
        headers: { Cookie: this.cookie, Origin: this.base },
      });
      socket.events = [];
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        socket.events.push(event);
        if (event.type === 'message') {
          socket.send(JSON.stringify({ type: 'delivered', messageId: event.message.id }));
        }
      });
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
  throw new Error('Timed out waiting for temporary chat server.');
}

async function run() {
  const port = await findPort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    APP_URL: base,
    DB_PATH: dbPath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    ADMIN_EMAIL: `admin@${domain}`,
    ADMIN_PASSWORD: 'TickAdminPass123!',
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

  const admin = new Client(base);
  const alice = new Client(base);
  const bob = new Client(base);
  const adminLogin = await admin.request('POST', '/api/auth/login', {
    email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
  });
  check(adminLogin.status === 200, 'temporary administrator signs in');

  const users = [
    { client: alice, fullName: 'Tick Alice', email: `alice@${domain}` },
    { client: bob, fullName: 'Tick Bob', email: `bob@${domain}` },
  ];
  for (const user of users) {
    const signup = await user.client.request('POST', '/api/auth/signup', {
      fullName: user.fullName, email: user.email, password, confirmPassword: password,
    });
    check(signup.status === 202, `${user.fullName} signup accepted`);
  }

  let pending = await admin.request('GET', '/api/admin/users?status=pending');
  for (const user of users) {
    const account = pending.data.users.find((item) => item.email === user.email);
    const approval = await admin.request('POST', `/api/admin/users/${account.id}/approve`, {});
    check(approval.status === 200, `${user.fullName} approved`);
    const login = await user.client.request('POST', '/api/auth/login', {
      email: user.email, password,
    });
    check(login.status === 200, `${user.fullName} signs in`);
    user.client.id = login.data.user.id;
  }

  const conversation = await alice.request('POST', '/api/conversations', { userId: bob.id });
  const conversationId = conversation.data.conversation.id;
  const wsAlice = await alice.connectWebSocket();
  const send = await alice.request('POST', `/api/conversations/${conversationId}/messages`, {
    text: 'Tick status check',
  });
  const messageId = send.data.message.id;
  const saved = await alice.request('GET', `/api/conversations/${conversationId}/messages`);
  const sentMessage = saved.data.messages.find((message) => message.id === messageId);
  check(send.status === 201 && sentMessage.deliveredAt == null && sentMessage.readAt == null,
    'sent state is one grey tick while Bob is offline');
  const styles = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  const chatHtml = fs.readFileSync(path.join(root, 'views', 'chat.html'), 'utf8');
  const chatScript = fs.readFileSync(path.join(root, 'public', 'js', 'chat.js'), 'utf8');
  check(
    chatHtml.includes('/css/app.css?v=') && chatHtml.includes('/js/chat.js?v=') &&
    chatScript.includes("class: 'tick'") && styles.includes('.bub .tick {') &&
    styles.includes('width: 16px; height: 16px') && styles.includes('color: #8696a0') &&
    styles.includes('.bub .tick.read { color: #34b7f1;') &&
    styles.includes('.bub .tick::before, .bub .tick::after') &&
    styles.includes('.message-menu-toggle::before') &&
    chatScript.includes("event.key !== 'Escape'") &&
    chatScript.includes("event.target.closest('.message-actions')"),
    'browser assets are cache-busted and ticks and message-menu controls have visible styles and dismissal handling',
  );

  const wsBob = await bob.connectWebSocket();
  const deliveredEvent = await waitForEvent(wsAlice, (event) => event.type === 'message_status' &&
    event.scope === 'direct' && event.conversationId === conversationId &&
    event.updates.some((update) => update.messageId === messageId && update.deliveredAt));
  const deliveredHistory = await alice.request('GET', `/api/conversations/${conversationId}/messages`);
  const deliveredMessage = deliveredHistory.data.messages.find((message) => message.id === messageId);
  check(!!deliveredEvent && !!deliveredMessage.deliveredAt && !deliveredMessage.readAt,
    'message_status updates the sender to double grey after Bob reconnects and receives it');

  const readResponse = await bob.request('POST', `/api/conversations/${conversationId}/read`, {
    lastReadMessageId: messageId,
  });
  const seenEvent = await waitForEvent(wsAlice, (event) => event.type === 'message_status' &&
    event.scope === 'direct' && event.conversationId === conversationId &&
    event.updates.some((update) => update.messageId === messageId && update.readAt));
  const seenHistory = await alice.request('GET', `/api/conversations/${conversationId}/messages`);
  const seenMessage = seenHistory.data.messages.find((message) => message.id === messageId);
  check(readResponse.status === 200 && !!seenEvent && !!seenMessage.readAt,
    'message_status updates the sender to double blue after Bob opens and reads the chat');

  wsAlice.close();
  wsBob.close();
  await Promise.all([
    new Promise((resolve) => wsAlice.once('close', resolve)),
    new Promise((resolve) => wsBob.once('close', resolve)),
  ]);
  check(failed === 0, `tick test summary (${passed} passed, ${failed} failed)`);
  if (failed) throw new Error(`${failed} tick assertion(s) failed.\n${serverOutput}`);
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
