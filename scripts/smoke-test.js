// End-to-end check of the main workflow. Starts its own server with a throwaway database.
// Run: npm test
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');

const PORT = 3190, BASE = `http://localhost:${PORT}`, DOMAIN = 'dixeltechnologies.com';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-test-'));
const env = { ...process.env, PORT: String(PORT), APP_URL: BASE, DB_PATH: path.join(tmp, 'test.db'), TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '', ADMIN_EMAIL: `admin@${DOMAIN}`, ADMIN_PASSWORD: 'Str0ngPassw0rd!', SMTP_HOST: '', NODE_ENV: 'test', TRUST_PROXY: 'true' };
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
let nextClientIp = 1;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); };

class Client {
  constructor() { this.cookies = new Map(); this.ip = `198.51.100.${nextClientIp++}`; }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async call(method, url, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': this.ip };
    if (!opts.noCsrf) headers['X-Requested-With'] = 'dixel';
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setCookies = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : (r.headers.get('set-cookie') || '').split(/, (?=[^;,]+=)/);
    for (const setCookie of setCookies) {
      const [key, ...parts] = setCookie.split(';')[0].split('=');
      const value = parts.join('=');
      if (!value) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
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
  ws.events = []; ws.on('message', (d) => {
    const event = JSON.parse(d);
    ws.events.push(event);
    if (event.type === 'message') ws.send(JSON.stringify({ type: 'delivered', messageId: event.message.id }));
    if (event.type === 'group_message') ws.send(JSON.stringify({ type: 'group_delivered', messageId: event.message.id }));
  });
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
    ok((await anon.call('GET', '/api/auth/approval-status?email=alice@' + DOMAIN)).status === 401,
      'approval status cannot be queried by email without its private tracking cookie');
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
    ok((await a.call('GET', '/api/auth/approval-status')).data.status === 'pending',
      'new pending employee can check only their own approval status');
    for (const u of users) {
      const approval = await admin.call('POST', `/api/admin/users/${u.id}/approve`, {});
      if (u.email === `alice@${DOMAIN}`) {
        ok(approval.status === 200, 'admin approval action keeps its existing successful response');
        ok((await a.call('GET', '/api/auth/approval-status')).data.status === 'active',
          'approval status updates for the user who requested it');
      }
    }
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
    ok((await d.call('GET', '/api/auth/approval-status')).data.status === 'rejected',
      'rejection status updates for the user who requested it');
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

    const groupResult = await a.call('POST', '/api/groups', { name: 'Project Chat', memberIds: [bobId] });
    const group = groupResult.data.group;
    ok(groupResult.status === 201 && group.memberCount === 2, 'group creation stores group and members transactionally');
    ok((await a.call('GET', '/api/groups')).data.groups.some((item) => item.id === group.id),
      'group list respects per-user visibility filters');
    const groupMessage = await a.call('POST', `/api/groups/${group.id}/messages`, { text: 'Group hello' });
    ok(groupMessage.status === 201 && groupMessage.data.message.text === 'Group hello', 'group message is stored and returned');
    ok(await waitForEvent(wsB, (e) => e.type === 'group_message' && e.message.text === 'Group hello'), 'group message is delivered to members');
    ok(await waitForEvent(wsA, (e) => e.type === 'message_status' && e.scope === 'group' && e.messageId === groupMessage.data.message.id && e.deliveredAt),
      'group delivery status updates after a recipient client acknowledges delivery');
    ok((await b.call('POST', `/api/groups/${group.id}/read`, { lastReadMessageId: groupMessage.data.message.id })).status === 200,
      'group read marker is stored');
    ok(await waitForEvent(wsA, (e) => e.type === 'message_status' && e.scope === 'group' && e.messageId === groupMessage.data.message.id && e.readAt),
      'group seen status updates after a member opens the chat');
    const groupEdit = await a.call('PATCH', `/api/groups/${group.id}/messages/${groupMessage.data.message.id}`, { text: 'Edited group hello' });
    ok(groupEdit.status === 200 && groupEdit.data.message.editedAt, 'group sender can edit their own recent message');
    ok(await waitForEvent(wsB, (e) => e.type === 'message_edited' && e.message.id === groupMessage.data.message.id && e.message.text === 'Edited group hello'),
      'group message edits are delivered live to members');
    const groupDelete = await a.call('POST', `/api/groups/${group.id}/messages/${groupMessage.data.message.id}/delete`, { mode: 'everyone' });
    ok(groupDelete.status === 200 && groupDelete.data.message.text === 'This message was deleted',
      'group sender can delete a recent message for everyone');
    ok(await waitForEvent(wsB, (e) => e.type === 'message_deleted' && e.message.id === groupMessage.data.message.id && e.message.deleted),
      'group message deletion is delivered live to members');
    const privateGroupMessage = (await a.call('POST', `/api/groups/${group.id}/messages`, { text: 'Private group copy' })).data.message;
    ok((await b.call('POST', `/api/groups/${group.id}/messages/${privateGroupMessage.id}/delete`, { mode: 'me' })).status === 200 &&
      !(await b.call('GET', `/api/groups/${group.id}/messages`)).data.messages.some((m) => m.id === privateGroupMessage.id) &&
      (await a.call('GET', `/api/groups/${group.id}/messages`)).data.messages.some((m) => m.id === privateGroupMessage.id),
    'delete for me hides a group message only for the requesting member');
    ok((await b.call('POST', `/api/groups/${group.id}/clear`, {})).status === 200 &&
      !(await b.call('GET', `/api/groups/${group.id}/messages`)).data.messages.length &&
      (await a.call('GET', `/api/groups/${group.id}/messages`)).data.messages.length > 0,
    'clear group chat hides existing messages only for the requesting member');
    ok((await a.call('POST', `/api/groups/${group.id}/members`, { memberIds: [carolId] })).status === 201,
      'group members can be added transactionally');
    ok((await c.call('GET', `/api/groups/${group.id}/members`)).data.members.length === 3,
      'new group member can read group membership');
    ok((await a.call('DELETE', `/api/groups/${group.id}/members/${carolId}`)).status === 200,
      'group members can be removed transactionally');

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
    ok(wsA.events.some((e) => e.type === 'message_status' && e.scope === 'direct' &&
      e.updates.some((u) => u.messageId === r.data.message.id && u.readAt)), 'sender gets read receipt in real time');
    ok((await a.call('GET', '/api/conversations')).data.conversations[0].unread === 1, 'unread count and last message in conversation list');
    ok((await a.call('GET', `/api/conversations/${conv.id}/messages`)).data.firstUnreadMessageId === reply.data.message.id, 'history identifies the first unread message for initial scroll');

    const hist = await b.call('GET', `/api/conversations/${conv.id}/messages`);
    ok(hist.data.messages.length === 2 && hist.data.messages[0].text === xss, 'chat history returned in order (stored as plain text)');

    const carolConv = (await a.call('POST', '/api/conversations', { userId: carolId })).data.conversation;
    const editable = (await a.call('POST', `/api/conversations/${carolConv.id}/messages`, { text: 'Original secret' })).data.message;
    ok(await waitForEvent(wsC, (e) => e.type === 'message' && e.message.id === editable.id),
      'direct message is delivered to the online recipient');
    ok(await waitForEvent(wsA, (e) => e.type === 'message_status' && e.scope === 'direct' &&
      e.updates.some((u) => u.messageId === editable.id && u.deliveredAt)),
      'direct delivery tick updates after the recipient acknowledges receipt');
    ok((await c.call('PATCH', `/api/conversations/${carolConv.id}/messages/${editable.id}`, { text: 'Unauthorized edit' })).status === 403,
      'a recipient cannot edit another user message');
    const edited = await a.call('PATCH', `/api/conversations/${carolConv.id}/messages/${editable.id}`, { text: 'Edited secret' });
    ok(edited.status === 200 && edited.data.message.editedAt && edited.data.message.text === 'Edited secret',
      'sender can edit their own recent message');
    ok(await waitForEvent(wsC, (e) => e.type === 'message_edited' && e.message.id === editable.id && e.message.text === 'Edited secret'),
      'message edits are delivered live to the other user');
    const deleted = await a.call('POST', `/api/conversations/${carolConv.id}/messages/${editable.id}/delete`, { mode: 'everyone' });
    ok(deleted.status === 200 && deleted.data.message.text === 'This message was deleted',
      'sender can delete a recent message for everyone');
    ok(await waitForEvent(wsC, (e) => e.type === 'message_deleted' && e.message.id === editable.id && e.message.deleted),
      'message deletion is delivered live');
    const carolHistory = await c.call('GET', `/api/conversations/${carolConv.id}/messages`);
    ok(carolHistory.data.messages.some((m) => m.id === editable.id && m.text === 'This message was deleted') &&
      !carolHistory.data.messages.some((m) => m.text === 'Original secret' || m.text === 'Edited secret'),
    'deleted message history contains only the replacement text');
    ok((await a.call('PATCH', `/api/conversations/${carolConv.id}/messages/${editable.id}`, { text: 'Restore secret' })).status === 409,
      'deleted messages cannot be edited');

    const privateMessage = (await a.call('POST', `/api/conversations/${carolConv.id}/messages`, { text: 'Private copy' })).data.message;
    ok((await c.call('POST', `/api/conversations/${carolConv.id}/messages/${privateMessage.id}/delete`, { mode: 'me' })).status === 200,
      'recipient can hide a message only for themselves');
    ok(!(await c.call('GET', `/api/conversations/${carolConv.id}/messages`)).data.messages.some((m) => m.id === privateMessage.id) &&
      (await a.call('GET', `/api/conversations/${carolConv.id}/messages`)).data.messages.some((m) => m.id === privateMessage.id),
    'delete for me leaves the other user copy visible');
    ok((await a.call('POST', `/api/conversations/${carolConv.id}/clear`, {})).status === 200,
      'a user can clear their own conversation history');
    ok(!(await a.call('GET', `/api/conversations/${carolConv.id}/messages`)).data.messages.length &&
      (await c.call('GET', `/api/conversations/${carolConv.id}/messages`)).data.messages.some((m) => m.id === editable.id),
    'clear chat hides old messages only for the requesting user');
    const afterClear = await a.call('POST', `/api/conversations/${carolConv.id}/messages`, { text: 'After clear' });
    ok(afterClear.status === 201 && (await a.call('GET', `/api/conversations/${carolConv.id}/messages`)).data.messages.length === 1,
      'messages sent after clearing remain visible');
    wsC.close();
    await waitForClose(wsC);
    const offlineMessage = (await a.call('POST', `/api/conversations/${carolConv.id}/messages`, { text: 'Sent while offline' })).data.message;
    const sentHistory = await a.call('GET', `/api/conversations/${carolConv.id}/messages`);
    ok(sentHistory.data.messages.find((m) => m.id === offlineMessage.id).deliveredAt == null,
      'offline recipient leaves message at sent status');
    const wsCReconnect = await wsOpen(c.cookie);
    ok(!!wsCReconnect && await waitForEvent(wsA, (e) => e.type === 'message_status' && e.scope === 'direct' &&
      e.updates.some((u) => u.messageId === offlineMessage.id && u.deliveredAt)),
    'pending message becomes delivered when recipient reconnects and receives it');

    ok((await c.call('GET', `/api/conversations/${conv.id}/messages`)).status === 404, 'non-participant cannot read conversation');
    ok((await c.call('POST', `/api/conversations/${conv.id}/messages`, { text: 'intrude' })).status === 404, 'non-participant cannot send into conversation');
    ok((await c.call('POST', `/api/conversations/${conv.id}/read`, { lastReadMessageId: 1 })).status === 403, 'non-participant cannot touch read state');
    ok(!(await c.call('GET', '/api/conversations')).data.conversations.some((item) => item.id === conv.id),
      'other users do not see the conversation');

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

    wsA.close(); wsCReconnect.close();
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
