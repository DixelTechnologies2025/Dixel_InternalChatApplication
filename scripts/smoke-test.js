// End-to-end check of the main workflow. Starts its own server with a throwaway database.
// Run: npm test
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');

const PORT = 3190, BASE = `http://localhost:${PORT}`, DOMAIN = 'dixeltechnologies.com';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-test-'));
const env = { ...process.env, PORT: String(PORT), APP_URL: BASE, DB_PATH: path.join(tmp, 'test.db'), ADMIN_EMAIL: `admin@${DOMAIN}`, ADMIN_PASSWORD: 'Str0ngPassw0rd!', SMTP_HOST: '', NODE_ENV: 'test', TRUST_PROXY: 'true' };
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
let nextClientIp = 1;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); };

class Client {
  constructor() { this.cookie = ''; this.ip = `198.51.100.${nextClientIp++}`; }
  async call(method, url, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': this.ip };
    if (!opts.noCsrf) headers['X-Requested-With'] = 'dixel';
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data, headers: r.headers };
  }
}
const mailTokens = () => {
  const log = fs.readFileSync(path.join(tmp, 'dev-mail.log'), 'utf8');
  return [...log.matchAll(/To: (\S+)[\s\S]*?(verify|reset)\.html\?token=(\S+)/g)].map((m) => ({ to: m[1], kind: m[2], token: m[3] }));
};
const lastToken = (to, kind) => mailTokens().filter((m) => m.to === to && m.kind === kind).pop().token;
const pw = 'Str0ngPassw0rd!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForEvent = async (ws, match, timeout = 1200) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (ws.events.some(match)) return true;
    await sleep(20);
  }
  return ws.events.some(match);
};
const waitForClose = (ws, timeout = 1200) => {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(ws.closeEvent);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
};
const wsOpen = (cookie) => new Promise((res) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie, Origin: BASE } });
  ws.events = []; ws.on('message', (d) => ws.events.push(JSON.parse(d)));
  ws.on('close', (code, reason) => { ws.closeEvent = { code, reason: reason.toString() }; });
  ws.on('open', () => res(ws)); ws.on('unexpected-response', () => res(null)); ws.on('error', () => res(null));
});

(async () => {
  const cli = spawnSync('node', ['scripts/create-admin.js', `cli-admin@${DOMAIN}`, 'CLI Admin', pw], { cwd: root, env });
  ok(cli.status === 0, 'create-admin script creates administrator');
  const server = spawn('node', ['src/server.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/login.html'); break; } catch (e) { await sleep(150); } }

  try {
    const anon = new Client();
    ok((await anon.call('GET', '/api/employees')).status === 401, 'unauthenticated API access is rejected');
    const page = await anon.call('GET', '/chat'); ok(page.status === 302 && page.headers.get('location') === '/login.html', 'unauthenticated /chat redirects to login');
    ok((await wsOpen('')) === null, 'unauthenticated WebSocket is rejected');

    const a = new Client(), b = new Client(), c = new Client(), d = new Client(), admin = new Client();
    const su = (cl, name, email, extra = {}) => cl.call('POST', '/api/auth/signup', { fullName: name, email, password: pw, confirmPassword: pw, ...extra });
    for (const bad of ['x@gmail.com', 'x@yahoo.com', 'x@outlook.com']) {
      const r = await su(anon, 'Bad Actor', bad); if (bad === 'x@gmail.com') ok(r.status === 400 && /dixeltechnologies/.test(r.data.errors.email), 'signup rejects Gmail with a clear message');
      else ok(r.status === 400, `signup rejects ${bad}`);
    }
    ok((await anon.call('POST', '/api/auth/login', { email: 'x@gmail.com', password: pw })).status === 400, 'login rejects public email domains');

    ok((await anon.call('POST', '/api/auth/signup', { fullName: 'Weak', email: `weak@${DOMAIN}`, password: 'abc', confirmPassword: 'abc' })).status === 400, 'weak password rejected');
    let signup = await su(a, 'Alice Anand', `alice@${DOMAIN}`, { employeeId: 'A-1', department: 'Engineering' });
    ok(signup.status === 202 && signup.data.message === 'Your request has been sent. You can sign in after an administrator approves your account.', 'signup with company email is immediately pending');
    ok((await su(b, 'Bob Bhatt', `bob@${DOMAIN}`, { department: 'Sales' })).status === 202, 'second employee signup accepted');
    ok(!fs.existsSync(path.join(tmp, 'dev-mail.log')), 'signup does not send verification email');
    const dup = await su(anon, 'Alice Again', `alice@${DOMAIN}`); ok(dup.status === 202, 'duplicate signup gives the same generic response');

    let r = await a.call('POST', '/api/auth/login', { email: `alice@${DOMAIN}`, password: pw });
    ok(r.status === 403 && r.data.status === 'pending' && r.data.message === 'Your account is waiting for administrator approval.', 'pending employee cannot sign in');
    ok((await anon.call('GET', '/verify.html')).status === 404, 'email verification page is removed');
    r = await a.call('POST', '/api/auth/login', { email: `alice@${DOMAIN}`, password: 'WrongPassw0rd!' });
    ok(r.status === 401 && r.data.message === 'Incorrect email or password.', 'wrong password gets a generic error');

    ok((await admin.call('POST', '/api/auth/login', { email: `admin@${DOMAIN}`, password: pw })).status === 200, 'admin signs in');
    ok((await admin.call('POST', '/api/auth/verify', { token: 'bogus' })).status === 404, 'email verification endpoint is removed');
    ok((await a.call('GET', '/api/admin/users')).status === 401, 'non-signed-in user cannot call admin API');
    const users = (await admin.call('GET', '/api/admin/users?status=pending')).data.users;
    ok(users.length === 2, 'admin sees pending employees');
    for (const u of users) await admin.call('POST', `/api/admin/users/${u.id}/approve`, {});
    ok((await admin.call('POST', '/api/admin/invites', { email: `carol@${DOMAIN}`, employeeId: 'C-3', department: 'HR' })).status === 201, 'admin creates invite');
    r = await su(c, 'Carol Chen', `carol@${DOMAIN}`, { employeeId: 'C-3' });
    ok(r.status === 202 && (await c.call('POST', '/api/auth/login', { email: `carol@${DOMAIN}`, password: pw })).status === 200, 'matching invited employee is activated immediately');
    ok((await admin.call('POST', '/api/admin/invites', { email: `dave@${DOMAIN}`, employeeId: 'D-4' })).status === 201, 'admin creates employee ID invite');
    await su(d, 'Dave Das', `dave@${DOMAIN}`, { employeeId: 'D-5' });
    const dave = (await admin.call('GET', '/api/admin/users?status=pending')).data.users.find((u) => u.email === `dave@${DOMAIN}`);
    ok(!!dave && dave.employeeId === 'D-5', 'invite with mismatched employee ID requires approval');

    ok((await a.call('POST', '/api/auth/login', { email: `alice@${DOMAIN}`, password: pw })).status === 200, 'approved employee signs in');
    ok((await b.call('POST', '/api/auth/login', { email: `bob@${DOMAIN}`, password: pw })).status === 200, 'second employee signs in');
    ok((await c.call('POST', '/api/auth/login', { email: `carol@${DOMAIN}`, password: pw })).status === 200, 'third active employee signs in');
    const pendingDave = (await admin.call('GET', '/api/admin/users?status=pending')).data.users.find((u) => u.email === `dave@${DOMAIN}`);
    ok((await a.call('POST', '/api/conversations', { userId: pendingDave.id })).status === 404, 'active employee cannot start a conversation with a pending employee');
    ok(!(await a.call('GET', '/api/employees?q=dave')).data.employees.length, 'pending employee is absent from the directory');
    ok((await admin.call('POST', `/api/admin/users/${dave.id}/reject`, {})).status === 200, 'admin can reject a pending signup');
    r = await d.call('POST', '/api/auth/login', { email: `dave@${DOMAIN}`, password: pw });
    ok(r.status === 403 && r.data.status === 'rejected' && r.data.message === 'Your registration was not approved. Contact your administrator.', 'rejected employee cannot sign in');
    ok((await d.call('GET', '/api/employees')).status === 401, 'rejected employee cannot access chat APIs');
    ok(!(await a.call('GET', '/api/employees?q=dave')).data.employees.length, 'rejected employee is absent from the directory');
    ok((await a.call('POST', '/api/conversations', { userId: pendingDave.id })).status === 404, 'active employee cannot start a conversation with a rejected employee');
    ok((await a.call('POST', '/api/auth/logout', null, { noCsrf: true })).status === 403, 'state-changing request without CSRF header rejected');
    ok((await a.call('GET', '/api/admin/users')).status === 403, 'regular employee cannot use admin API');

    const emp = (await a.call('GET', '/api/employees')).data.employees.map((e) => e.fullName);
    ok(emp.includes('Bob Bhatt') && emp.includes('Carol Chen') && !emp.includes('Alice Anand'), 'directory lists other approved employees');
    ok((await a.call('GET', '/api/employees?q=sales')).data.employees.length === 1, 'search by department works');
    ok((await a.call('GET', '/api/employees?q=bha')).data.employees[0].fullName === 'Bob Bhatt', 'search by name works');

    const bobId = (await a.call('GET', '/api/employees?q=bob')).data.employees[0].id;
    const conv = (await a.call('POST', '/api/conversations', { userId: bobId })).data.conversation;
    const conv2 = (await b.call('POST', '/api/conversations', { userId: (await b.call('GET', '/api/employees?q=alice')).data.employees[0].id })).data.conversation;
    ok(conv.id === conv2.id, 'one conversation per pair');

    let wsB = await wsOpen(b.cookie); let wsA = await wsOpen(a.cookie);
    const wsC = await wsOpen(c.cookie);
    const aliceId = (await a.call('GET', '/api/auth/me')).data.user.id;
    const carolId = (await c.call('GET', '/api/auth/me')).data.user.id;
    ok(!!wsA && !!wsB && !!wsC, 'authenticated WebSocket connects for simultaneous users');
    ok(await waitForEvent(wsA, (e) => e.type === 'ready') && await waitForEvent(wsB, (e) => e.type === 'ready'), 'WebSocket readiness confirms active sessions');
    ok(wsA.events.find((e) => e.type === 'ready').online.includes(bobId), 'online presence includes the other signed-in employee');
    ok(await waitForEvent(wsB, (e) => e.type === 'presence' && e.userId === aliceId && e.online), 'presence updates when a colleague comes online');
    const onlineEmployees = (await a.call('GET', '/api/employees')).data.employees;
    ok(onlineEmployees.find((e) => e.id === bobId).online, 'Employees API marks connected employees online');

    wsA.send(JSON.stringify({ type: 'typing', conversationId: conv.id, typing: true, recipientId: carolId }));
    ok(await waitForEvent(wsB, (e) => e.type === 'typing' && e.conversationId === conv.id && e.userId === aliceId && e.typing),
      'typing event reaches the conversation partner');
    ok(!wsA.events.some((e) => e.type === 'typing') && !wsC.events.some((e) => e.type === 'typing'),
      'typing event is not sent to its sender or an unrelated employee');
    wsA.send(JSON.stringify({ type: 'typing', conversationId: conv.id, typing: false }));
    ok(await waitForEvent(wsB, (e) => e.type === 'typing' && e.userId === aliceId && !e.typing), 'typing stop event reaches the partner');
    const typingCounts = [wsA, wsB, wsC].map((ws) => ws.events.filter((e) => e.type === 'typing').length);
    wsC.send(JSON.stringify({ type: 'typing', conversationId: conv.id, typing: true, recipientId: bobId }));
    await sleep(250);
    ok(wsA.events.filter((e) => e.type === 'typing').length === typingCounts[0] &&
      wsB.events.filter((e) => e.type === 'typing').length === typingCounts[1] &&
      wsC.events.filter((e) => e.type === 'typing').length === typingCounts[2],
    'non-participant cannot trigger typing or receive conversation typing events');

    const xss = '<img src=x onerror=alert(1)> hi';
    r = await a.call('POST', `/api/conversations/${conv.id}/messages`, { text: xss, clientId: 'c1' });
    ok(r.status === 201, 'message sent');
    ok((await a.call('POST', `/api/conversations/${conv.id}/messages`, { text: xss, clientId: 'c1' })).data.message.id === r.data.message.id, 'retry with same clientId does not duplicate');
    ok((await a.call('POST', `/api/conversations/${conv.id}/messages`, { text: '   ' })).status === 400, 'blank message rejected');
    await sleep(300);
    ok(wsB.events.some((e) => e.type === 'message' && e.message.text === xss), 'recipient receives message in real time');
    const reply = await b.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Hello Alice' });
    await b.call('POST', `/api/conversations/${conv.id}/read`, { lastReadMessageId: r.data.message.id });
    await sleep(300);
    ok(wsA.events.some((e) => e.type === 'read'), 'sender gets read receipt in real time');
    ok((await a.call('GET', '/api/conversations')).data.conversations[0].unread === 1, 'unread count and last message in conversation list');
    ok((await a.call('GET', `/api/conversations/${conv.id}/messages`)).data.firstUnreadMessageId === reply.data.message.id, 'history identifies the first unread message for initial scroll');

    const hist = await b.call('GET', `/api/conversations/${conv.id}/messages`);
    ok(hist.data.messages.length === 2 && hist.data.messages[0].text === xss, 'chat history returned in order (stored as plain text)');

    ok((await c.call('GET', `/api/conversations/${conv.id}/messages`)).status === 404, 'non-participant cannot read conversation');
    ok((await c.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'intrude' })).status === 404, 'non-participant cannot send into conversation');
    ok((await c.call('POST', `/api/conversations/${conv.id}/read`, { lastReadMessageId: 1 })).status === 404, 'non-participant cannot touch read state');
    ok((await c.call('GET', '/api/conversations')).data.conversations.length === 0, 'other users do not see the conversation');

    wsB.close();
    ok(await waitForEvent(wsA, (e) => e.type === 'presence' && e.userId === bobId && !e.online && e.lastSeenAt),
      'disconnect updates offline presence and last-seen time');
    const bobOffline = (await a.call('GET', '/api/employees?q=bob')).data.employees[0];
    ok(bobOffline && !bobOffline.online && bobOffline.lastSeenAt, 'Employees API returns offline status and last-seen time');
    wsB = await wsOpen(b.cookie);
    ok(!!wsB && await waitForEvent(wsA, (e) => e.type === 'presence' && e.userId === bobId && e.online),
      'presence returns online when the employee reconnects');

    await a.call('POST', '/api/auth/logout', {});
    const logoutClose = await waitForClose(wsA);
    ok((await a.call('GET', '/api/auth/me')).status === 401, 'logout invalidates session');
    ok(logoutClose && logoutClose.code === 4001, 'logout closes the employee WebSocket');
    ok((await wsOpen(a.cookie)) === null, 'WebSocket refused after logout');
    ok((await a.call('POST', '/api/auth/login', { email: `alice@${DOMAIN}`, password: pw })).status === 200, 'employee can sign in again');
    const persisted = await a.call('GET', `/api/conversations/${conv.id}/messages`);
    ok(persisted.data.messages.length === 2 && persisted.data.messages[1].text === 'Hello Alice', 'message history persists after re-login');
    wsA = await wsOpen(a.cookie);
    ok(!!wsA && await waitForEvent(wsA, (e) => e.type === 'ready'), 're-logged-in employee reconnects to real-time chat');

    const bobUser = (await admin.call('GET', '/api/admin/users')).data.users.find((u) => u.email === `bob@${DOMAIN}`);
    ok((await admin.call('POST', `/api/admin/users/${bobUser.id}/deactivate`, {})).status === 200, 'administrator deactivates an active employee');
    ok(await waitForEvent(wsA, (e) => e.type === 'employee_unavailable' && e.userId === bobId),
      'open conversation receives immediate employee-unavailable event');
    const bobClose = await waitForClose(wsB);
    ok(bobClose && bobClose.code === 4001, 'deactivation immediately closes the employee WebSocket');
    ok((await b.call('GET', '/api/auth/me')).status === 401, 'deactivated employee is signed out immediately');
    r = await b.call('POST', '/api/auth/login', { email: `bob@${DOMAIN}`, password: pw });
    ok(r.status === 403 && r.data.message === 'This account is deactivated. Contact your administrator.', 'deactivated employee cannot sign in');
    ok((await b.call('GET', `/api/conversations/${conv.id}/messages`)).status === 401, 'deactivated employee cannot read conversation history');
    ok((await b.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'blocked' })).status === 401, 'deactivated employee cannot send messages');
    ok((await a.call('POST', '/api/conversations', { userId: bobId })).status === 404, 'active employee cannot start a conversation with a deactivated employee');
    ok((await a.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'after deactivation' })).status === 404,
      'active employee cannot message through an existing conversation after deactivation');
    ok(!(await a.call('GET', '/api/employees?q=bob')).data.employees.length, 'deactivated employee is removed from the directory immediately');
    ok((await wsOpen(b.cookie)) === null, 'deactivated employee cannot reconnect to WebSocket');

    wsA.close(); wsC.close();
    await c.call('POST', '/api/auth/forgot', { email: `carol@${DOMAIN}` });
    ok((await c.call('POST', '/api/auth/reset', { token: lastToken(`carol@${DOMAIN}`, 'reset'), password: 'N3wStrongPassw0rd', confirmPassword: 'N3wStrongPassw0rd' })).status === 200, 'password reset works');
    ok((await c.call('POST', '/api/auth/login', { email: `carol@${DOMAIN}`, password: 'N3wStrongPassw0rd' })).status === 200, 'login with new password works');
  } catch (e) { fail++; console.error('TEST ERROR', e); }

  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
