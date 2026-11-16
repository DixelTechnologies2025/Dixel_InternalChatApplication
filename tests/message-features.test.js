const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-message-test-'));
const dbPath = path.join(tempDir, 'test.db');
const domain = 'feature-test.example';
const password = 'TestUserPass123!';
let server;
let db;
let passed = 0;
let failed = 0;
let sequence = 1;

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
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    let data = {};
    try { data = await response.json(); } catch {}
    return { status: response.status, data };
  }

  socket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws', {
        headers: { Cookie: this.cookie, Origin: this.base },
      });
      ws.events = [];
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        ws.events.push(event);
        if (event.type === 'message') ws.send(JSON.stringify({ type: 'delivered', messageId: event.message.id }));
        if (event.type === 'group_message') ws.send(JSON.stringify({ type: 'group_delivered', messageId: event.message.id }));
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEvent(ws, predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const event = ws.events.find(predicate);
    if (event) return event;
    await sleep(20);
  }
  return ws.events.find(predicate) || null;
}

async function waitForServer(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Test server exited during startup.');
    try {
      const response = await fetch(base + '/login.html');
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for isolated test server.');
}

async function signUp(client, fullName, email) {
  const result = await client.call('POST', '/api/auth/signup', {
    fullName, email, password, confirmPassword: password,
  });
  check(result.status === 202, `${fullName} signup accepted`);
}

async function approveAndLogin(admin, client, email) {
  const pending = await admin.call('GET', '/api/admin/users?status=pending');
  const user = pending.data.users.find((item) => item.email === email);
  check(!!user, `${email} is pending approval`);
  const approval = await admin.call('POST', `/api/admin/users/${user.id}/approve`, {});
  check(approval.status === 200, `${email} approved`);
  const login = await client.call('POST', '/api/auth/login', { email, password });
  check(login.status === 200, `${email} signed in`);
  return login.data.user;
}

async function run() {
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
    ADMIN_PASSWORD: 'TestAdminPass123!',
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

  const admin = new Client(base);
  const a = new Client(base);
  const b = new Client(base);
  const outsider = new Client(base);
  const adminLogin = await admin.call('POST', '/api/auth/login', {
    email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
  });
  check(adminLogin.status === 200, 'isolated administrator signed in');

  const emails = {
    a: `alice${sequence++}@${domain}`,
    b: `bob${sequence++}@${domain}`,
    outsider: `carol${sequence++}@${domain}`,
  };
  await signUp(a, 'Alice Feature', emails.a);
  await signUp(b, 'Bob Feature', emails.b);
  await signUp(outsider, 'Carol Feature', emails.outsider);
  const userA = await approveAndLogin(admin, a, emails.a);
  const userB = await approveAndLogin(admin, b, emails.b);
  const outsiderPending = await admin.call('GET', '/api/admin/users?status=pending');
  const outsiderRow = outsiderPending.data.users.find((item) => item.email === emails.outsider);
  const outsiderApproval = await admin.call('POST', `/api/admin/users/${outsiderRow.id}/approve`, {});
  check(outsiderApproval.status === 200, 'non-member account approved');
  const outsiderLogin = await outsider.call('POST', '/api/auth/login', { email: emails.outsider, password });
  check(outsiderLogin.status === 200, 'non-member account signed in');

  const conversationResult = await a.call('POST', '/api/conversations', { userId: userB.id });
  check(conversationResult.status === 200, 'direct conversation route is mounted');
  const conversationId = conversationResult.data.conversation.id;

  const offlineSend = await a.call('POST', `/api/conversations/${conversationId}/messages`, { text: 'Offline first' });
  const offlineId = offlineSend.data.message.id;
  const initialHistory = await a.call('GET', `/api/conversations/${conversationId}/messages`);
  check(offlineSend.status === 201 && initialHistory.data.messages.find((message) => message.id === offlineId).deliveredAt == null,
    'message remains sent while recipient is offline');

  const wsA = await a.socket();
  const wsB = await b.socket();
  const deliveredEvent = await waitForEvent(wsA, (event) => event.type === 'message_status' &&
    event.scope === 'direct' && event.updates && event.updates.some((update) => update.messageId === offlineId && update.deliveredAt));
  check(!!deliveredEvent && !!(await waitForEvent(wsB, (event) => event.type === 'message' && event.message.id === offlineId)),
    'offline message becomes delivered after recipient connects');
  const readResult = await b.call('POST', `/api/conversations/${conversationId}/read`, { lastReadMessageId: offlineId });
  const seenEvent = await waitForEvent(wsA, (event) => event.type === 'message_status' && event.scope === 'direct' &&
    event.updates && event.updates.some((update) => update.messageId === offlineId && update.readAt));
  const readerEvent = await waitForEvent(wsB, (event) => event.type === 'message_status' &&
    event.readByUserId === userB.id && event.conversationId === conversationId);
  check(readResult.status === 200 && !!seenEvent && !!readerEvent, 'seen status reaches sender and recipient tabs live');

  const editable = (await a.call('POST', `/api/conversations/${conversationId}/messages`, { text: 'Edit me' })).data.message;
  const selfWsEvent = await waitForEvent(wsA, (event) => event.type === 'message' && event.message.id === editable.id);
  check(!!selfWsEvent && Number(selfWsEvent.message.senderId) === Number(userA.id), 'server response and WebSocket use the saved message ID');
  const editResponse = await a.call('PATCH', `/api/conversations/${conversationId}/messages/${editable.id}`, { text: 'Edited live' });
  const editEvent = await waitForEvent(wsB, (event) => event.type === 'message_edited' && event.message.id === editable.id);
  check(editResponse.status === 200 && !!editEvent && editEvent.message.text === 'Edited live',
    'edit endpoint updates text and broadcasts message_edited');

  const forbiddenEdit = await b.call('PATCH', `/api/conversations/${conversationId}/messages/${editable.id}`, { text: 'No' });
  const forbiddenDelete = await b.call('POST', `/api/conversations/${conversationId}/messages/${editable.id}/delete`, { mode: 'everyone' });
  check(forbiddenEdit.status === 403 && forbiddenDelete.status === 403, 'non-sender cannot edit or delete for everyone');
  const outsiderEdit = await outsider.call('PATCH', `/api/conversations/${conversationId}/messages/${editable.id}`, { text: 'No' });
  const missingMessage = await a.call('PATCH', `/api/conversations/${conversationId}/messages/999999`, { text: 'No' });
  const invalidDelete = await a.call('POST', `/api/conversations/${conversationId}/messages/${editable.id}/delete`, { mode: 'invalid' });
  check(outsiderEdit.status === 403 && missingMessage.status === 404 && invalidDelete.status === 400,
    'message actions distinguish forbidden, missing, and invalid requests');

  const hideResponse = await a.call('POST', `/api/conversations/${conversationId}/messages/${editable.id}/delete`, { mode: 'me' });
  const aHistoryAfterHide = await a.call('GET', `/api/conversations/${conversationId}/messages`);
  const bHistoryAfterHide = await b.call('GET', `/api/conversations/${conversationId}/messages`);
  const hideEvent = await waitForEvent(wsA, (event) => event.type === 'message_hidden' && event.messageId === editable.id);
  check(hideResponse.status === 200 && !!hideEvent &&
    !aHistoryAfterHide.data.messages.some((message) => message.id === editable.id) &&
    bHistoryAfterHide.data.messages.some((message) => message.id === editable.id),
  'delete for me persists only for requesting user and updates their tabs');

  const deletable = (await a.call('POST', `/api/conversations/${conversationId}/messages`, { text: 'Original secret' })).data.message;
  const deletedResponse = await a.call('POST', `/api/conversations/${conversationId}/messages/${deletable.id}/delete`, { mode: 'everyone' });
  const deletedEvent = await waitForEvent(wsB, (event) => event.type === 'message_deleted' && event.message.id === deletable.id);
  const deletedBody = await db.execute({ sql: 'SELECT body FROM messages WHERE id = ?', args: [deletable.id] });
  check(deletedResponse.status === 200 && !!deletedEvent &&
    deletedEvent.message.text === 'This message was deleted' &&
    deletedBody.rows[0][0] === 'This message was deleted',
  'delete for everyone broadcasts and overwrites the original database body');

  const clearResponse = await a.call('POST', `/api/conversations/${conversationId}/clear`, {});
  const clearedEvent = await waitForEvent(wsA, (event) => event.type === 'chat_cleared' && event.conversationId === conversationId);
  const peerClearEvent = await waitForEvent(wsB, (event) => event.type === 'chat_cleared' &&
    event.conversationId === conversationId && event.userId === userA.id);
  const aHistoryAfterClear = await a.call('GET', `/api/conversations/${conversationId}/messages`);
  const bHistoryAfterClear = await b.call('GET', `/api/conversations/${conversationId}/messages`);
  check(clearResponse.status === 200 && !!clearedEvent && !!peerClearEvent && aHistoryAfterClear.data.messages.length === 0 &&
    bHistoryAfterClear.data.messages.some((message) => message.id === deletable.id),
  'clear chat updates own tabs and leaves the other participant history intact');

  const groupResponse = await a.call('POST', '/api/groups', { name: 'Feature Test Group', memberIds: [userB.id] });
  const groupId = groupResponse.data.group.id;
  const groupMessage = await a.call('POST', `/api/groups/${groupId}/messages`, { text: 'Group message' });
  const groupMessageId = groupMessage.data.message.id;
  const outsiderRead = await outsider.call('GET', `/api/groups/${groupId}/messages`);
  check(groupResponse.status === 201 && groupMessage.status === 201 && outsiderRead.status === 403,
    'non-member is explicitly forbidden from group message history');
  const groupEdit = await a.call('PATCH', `/api/groups/${groupId}/messages/${groupMessageId}`, { text: 'Group edited' });
  const groupEditEvent = await waitForEvent(wsB, (event) => event.type === 'message_edited' &&
    event.scope === 'group' && event.message.id === groupMessageId);
  check(groupEdit.status === 200 && !!groupEditEvent, 'group edit route and live event work');
  const groupHide = await a.call('POST', `/api/groups/${groupId}/messages/${groupMessageId}/delete`, { mode: 'me' });
  check(groupHide.status === 200, 'group delete-for-me route is mounted');
  const groupDelete = await a.call('POST', `/api/groups/${groupId}/messages/${groupMessageId}/delete`, { mode: 'everyone' });
  const groupDeleteEvent = await waitForEvent(wsB, (event) => event.type === 'message_deleted' &&
    event.scope === 'group' && event.message.id === groupMessageId);
  check(groupDelete.status === 200 && !!groupDeleteEvent, 'group delete-for-everyone broadcasts live');
  const groupClear = await a.call('POST', `/api/groups/${groupId}/clear`, {});
  const groupClearEvent = await waitForEvent(wsA, (event) => event.type === 'chat_cleared' && event.groupId === groupId);
  check(groupClear.status === 200 && !!groupClearEvent, 'group clear route and cross-tab event work');
  const outsiderGroupEdit = await outsider.call('PATCH', `/api/groups/${groupId}/messages/${groupMessageId}`, { text: 'No' });
  check(outsiderGroupEdit.status === 403, 'non-member cannot edit group messages');

  const routes = [
    ['GET', `/api/conversations/${conversationId}/messages`],
    ['POST', `/api/conversations/${conversationId}/messages`],
    ['PATCH', `/api/conversations/${conversationId}/messages/${offlineId}`],
    ['POST', `/api/conversations/${conversationId}/messages/${offlineId}/delete`],
    ['POST', `/api/conversations/${conversationId}/clear`],
    ['POST', `/api/conversations/${conversationId}/read`],
    ['GET', `/api/groups/${groupId}/messages`],
    ['POST', `/api/groups/${groupId}/messages`],
    ['PATCH', `/api/groups/${groupId}/messages/${groupMessageId}`],
    ['POST', `/api/groups/${groupId}/messages/${groupMessageId}/delete`],
    ['POST', `/api/groups/${groupId}/clear`],
    ['POST', `/api/groups/${groupId}/read`],
  ];
  let routesMounted = true;
  for (const [method, url] of routes) {
    let body;
    if (url.endsWith('/read')) body = { lastReadMessageId: groupMessageId };
    else if (method === 'POST' && url.endsWith('/messages')) body = { text: 'Route check' };
    else if (url.endsWith('/delete')) body = { mode: 'me' };
    else if (method === 'PATCH') body = { text: 'Route check' };
    const response = await a.call(method, url, body);
    if (response.status === 404) routesMounted = false;
  }
  check(routesMounted, 'all direct and group frontend message-feature URLs avoid route-level 404');

  wsA.close();
  wsB.close();
  await Promise.all([
    new Promise((resolve) => wsA.once('close', resolve)),
    new Promise((resolve) => wsB.once('close', resolve)),
  ]);
  check(failed === 0, `feature suite summary (${passed} passed, ${failed} failed)`);
  if (failed) throw new Error(`${failed} message feature assertion(s) failed.\n${serverOutput}`);
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
  if (db) await db.close();
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
