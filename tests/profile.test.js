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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-profile-test-'));
const dbPath = path.join(tempDir, 'profile-copy.db');
const domain = 'profile-test.example';
const password = 'ProfileUser123!';
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
  async request(method, url, body, contentType) {
    const headers = { 'X-Requested-With': 'dixel' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = contentType || 'application/json';
    const response = await fetch(this.base + url, {
      method,
      headers,
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    setCookies.forEach((cookie) => {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      const key = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    });
    const raw = Buffer.from(await response.arrayBuffer());
    let data = {};
    try { data = JSON.parse(raw.toString('utf8')); } catch {}
    return { status: response.status, data, raw, headers: response.headers };
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

async function waitForEvent(socket, predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = socket.events.find(predicate);
    if (found) return found;
    await sleep(20);
  }
  return socket.events.find(predicate) || null;
}

async function waitForServer(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Temporary profile server exited during startup.');
    try {
      if ((await fetch(base + '/login.html')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for temporary profile server.');
}

async function snapshotDevDatabase() {
  if (!fs.existsSync(sourcePath)) throw new Error(`Development DB copy source not found: ${sourcePath}`);
  const source = createClient({ url: pathToFileURL(sourcePath).href, intMode: 'number' });
  try {
    const counts = await source.execute(`SELECT
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM messages) AS messages`);
    await source.execute(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
    return {
      conversations: Number(counts.rows[0].conversations),
      messages: Number(counts.rows[0].messages),
    };
  } finally {
    await source.close();
  }
}

async function run() {
  const originalCounts = await snapshotDevDatabase();
  const port = await getPort();
  const base = `http://127.0.0.1:${port}`;
  const suffix = `${Date.now()}-${process.pid}`;
  const env = {
    ...process.env,
    PORT: String(port),
    APP_URL: base,
    DB_PATH: dbPath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: '',
    ADMIN_EMAIL: `admin-${suffix}@${domain}`,
    ADMIN_PASSWORD: 'ProfileAdmin123!',
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

  for (const [asset, marker] of [
    ['/js/chat.js', 'profile-edit-button'],
    ['/css/app.css', '.profile-edit-button svg'],
  ]) {
    const response = await fetch(base + asset);
    const body = await response.text();
    check(response.ok && response.headers.get('cache-control') === 'no-store' &&
      body.includes(marker),
    `development server serves fresh profile editor asset ${asset}`);
  }

  const counts = await db.execute(`SELECT
    (SELECT COUNT(*) FROM conversations) AS conversations,
    (SELECT COUNT(*) FROM messages) AS messages`);
  check(path.resolve(dbPath) !== sourcePath &&
    Number(counts.rows[0].conversations) === originalCounts.conversations &&
    Number(counts.rows[0].messages) === originalCounts.messages,
  'test server migrated and ran on a temporary copy of the development DB');

  const admin = new Client(base), alice = new Client(base), bob = new Client(base), anonymous = new Client(base);
  const adminLogin = await admin.request('POST', '/api/auth/login', {
    email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
  });
  check(adminLogin.status === 200, 'temporary copied-DB administrator signs in');

  const employees = [
    { client: alice, name: 'Profile Alice', email: `alice-${suffix}@${domain}` },
    { client: bob, name: 'Profile Bob', email: `bob-${suffix}@${domain}` },
  ];
  for (const employee of employees) {
    const signup = await employee.client.request('POST', '/api/auth/signup', {
      fullName: employee.name, email: employee.email, employeeId: employee.name,
      department: 'Engineering', password, confirmPassword: password,
    });
    check(signup.status === 202, `${employee.name} signup accepted`);
  }
  const pending = (await admin.request('GET', '/api/admin/users?status=pending')).data.users;
  for (const employee of employees) {
    const user = pending.find((row) => row.email === employee.email);
    const approved = await admin.request('POST', `/api/admin/users/${user.id}/approve`, {});
    const login = await employee.client.request('POST', '/api/auth/login', {
      email: employee.email, password,
    });
    employee.id = login.data.user.id;
    check(approved.status === 200 && login.status === 200, `${employee.name} approved and signs in`);
  }
  const bobSocket = await bob.connect();
  await waitForEvent(bobSocket, (event) => event.type === 'ready');
  const onlineList = await alice.request('GET', '/api/employees');
  check(onlineList.data.employees.some((employee) => employee.id === employees[1].id && employee.online),
    'avatarVersion user fields preserve existing employee online presence');

  const profile = await alice.request('GET', '/api/me/profile');
  check(profile.status === 200 && profile.data.profile.fullName === 'Profile Alice' &&
    profile.data.profile.email === employees[0].email &&
    profile.data.profile.employeeId === 'Profile Alice' &&
    profile.data.profile.department === 'Engineering' &&
    profile.data.profile.role === 'employee',
  'profile endpoint returns only the signed-in user’s details');
  const privateRoute = await bob.request('GET', `/api/users/${employees[0].id}/profile`);
  check(privateRoute.status === 404, 'no endpoint exposes another user’s profile details');

  const missingAuthPatch = await anonymous.request('PATCH', '/api/me/profile', { fullName: 'Unauthorized Name' });
  check(missingAuthPatch.status === 401, 'profile updates require an authenticated active user');

  const beforeRejectedPatch = await db.execute(
    'SELECT full_name, email, employee_id, department, role, status FROM users WHERE id = ?',
    [employees[0].id],
  );
  const rejectedPatch = await alice.request('PATCH', '/api/me/profile', {
    fullName: 'Should Not Persist', department: 'Should Not Persist',
    email: `changed-${suffix}@${domain}`, employeeId: 'changed', employee_id: 'changed',
    role: 'admin', status: 'inactive',
  });
  const afterRejectedPatch = await db.execute(
    'SELECT full_name, email, employee_id, department, role, status FROM users WHERE id = ?',
    [employees[0].id],
  );
  const protectedFields = ['full_name', 'email', 'employee_id', 'department', 'role', 'status'];
  check(rejectedPatch.status === 400 &&
    protectedFields.every((field) => afterRejectedPatch.rows[0][field] === beforeRejectedPatch.rows[0][field]),
  'profile patch rejects protected email, employee ID, role, and status fields without changing any data');

  for (const [invalidName, label] of [
    ['', 'empty'],
    ['A', 'one-character'],
    ['N'.repeat(61), '61-character'],
    ['N'.repeat(100), '100-character'],
    ['Profile <b>HTML</b>', 'HTML-tag'],
  ]) {
    const invalid = await alice.request('PATCH', '/api/me/profile', { fullName: invalidName });
    check(invalid.status === 400 && !!invalid.data.errors.fullName,
      `${label} full names are rejected with an inline field error`);
  }
  const invalidDepartment = await alice.request('PATCH', '/api/me/profile', { department: '<b>HTML</b>' });
  check(invalidDepartment.status === 400 && !!invalidDepartment.data.errors.department,
    'department HTML is rejected with an inline field error');
  const tooLongDepartment = await alice.request('PATCH', '/api/me/profile', { department: 'D'.repeat(81) });
  check(tooLongDepartment.status === 400 && !!tooLongDepartment.data.errors.department,
    'departments longer than 80 characters are rejected with an inline field error');

  const eventsBeforeProfileUpdate = bobSocket.events.length;
  const changedProfile = await alice.request('PATCH', '/api/me/profile', {
    fullName: '  Alice Updated  ', department: '  People Operations  ',
  });
  const liveProfileEvent = await waitForEvent(bobSocket, (event) =>
    event.type === 'user_profile_updated' && event.userId === employees[0].id);
  const updatedFields = await db.execute(
    'SELECT full_name, department FROM users WHERE id = ?',
    [employees[0].id],
  );
  const profileAudit = await db.execute(
    "SELECT action, target FROM audit_events WHERE actor_id = ? AND action = 'profile_update' ORDER BY id DESC LIMIT 1",
    [employees[0].id],
  );
  check(changedProfile.status === 200 && changedProfile.data.profile.fullName === 'Alice Updated' &&
    changedProfile.data.profile.department === 'People Operations' &&
    updatedFields.rows[0].full_name === 'Alice Updated' &&
    updatedFields.rows[0].department === 'People Operations',
  'profile patch trims and updates only the signed-in user name and department');
  check(!!liveProfileEvent && liveProfileEvent.fullName === 'Alice Updated' &&
    liveProfileEvent.department === 'People Operations' &&
    Object.keys(liveProfileEvent).sort().join(',') === 'department,fullName,type,userId',
  'profile changes broadcast a small live update to the other user');
  check(profileAudit.rows.length === 1 && profileAudit.rows[0].target === 'full_name,department',
    'profile audit records only the changed field names, never their values');
  check(!bobSocket.events.slice(eventsBeforeProfileUpdate).some((event) =>
    ['message', 'group_message', 'message_status'].includes(event.type)),
  'profile update does not broadcast messages, delivery ticks, or read-status events');

  const attemptedOtherProfile = await bob.request('PATCH', `/api/users/${employees[0].id}/profile`, {
    fullName: 'Unauthorized Other Name',
  });
  const unchangedAliceName = await db.execute('SELECT full_name FROM users WHERE id = ?', [employees[0].id]);
  check(attemptedOtherProfile.status === 404 && unchangedAliceName.rows[0].full_name === 'Alice Updated',
    'a user cannot update another employee through a targeted profile route');

  const clearedDepartment = await alice.request('PATCH', '/api/me/profile', { department: '   ' });
  const clearedDepartmentRow = await db.execute('SELECT department FROM users WHERE id = ?', [employees[0].id]);
  check(clearedDepartment.status === 200 && clearedDepartment.data.profile.department === null &&
    clearedDepartmentRow.rows[0].department === null,
  'an empty trimmed department is stored as NULL');

  const unauthorized = await anonymous.request('GET', `/api/users/${employees[0].id}/avatar`);
  check(unauthorized.status === 401, 'unauthenticated requests cannot read profile pictures');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r3cAAAAASUVORK5CYII=', 'base64');
  const messagesBeforeAvatar = await db.execute('SELECT COUNT(*) AS n FROM messages');
  const upload = await alice.request('POST', '/api/me/avatar', png, 'image/png');
  const saved = await db.execute('SELECT mime, data, updated_at FROM user_avatars WHERE user_id = ?', [employees[0].id]);
  const messagesAfterAvatar = await db.execute('SELECT COUNT(*) AS n FROM messages');
  check(upload.status === 200 && saved.rows.length === 1 &&
    saved.rows[0].mime === 'image/png' &&
    Buffer.from(saved.rows[0].data).equals(png) &&
    Number(saved.rows[0].updated_at) === upload.data.avatarVersion,
  'valid image is stored as a DB BLOB with its avatar version');

  const liveEvent = await waitForEvent(bobSocket, (event) =>
    event.type === 'user_avatar_updated' && event.userId === employees[0].id);
  check(!!liveEvent && liveEvent.avatarVersion === upload.data.avatarVersion &&
    Object.keys(liveEvent).sort().join(',') === 'avatarVersion,type,userId' &&
    Number(messagesBeforeAvatar.rows[0].n) === Number(messagesAfterAvatar.rows[0].n) &&
    !bobSocket.events.some((event) => ['message', 'group_message', 'message_status'].includes(event.type)),
  'avatar broadcast is small and does not create messages, ticks, or read-status events');

  const fetched = await bob.request('GET', `/api/users/${employees[0].id}/avatar?v=${upload.data.avatarVersion}`);
  check(fetched.status === 200 && fetched.raw.equals(png) &&
    fetched.headers.get('content-type').startsWith('image/png') &&
    fetched.headers.get('etag') && fetched.headers.get('cache-control').includes('private'),
  'authenticated avatar endpoint serves the stored image with ETag and private cache headers');
  const revalidated = await fetch(`${base}/api/users/${employees[0].id}/avatar`, {
    headers: { Cookie: bob.cookie, 'If-None-Match': fetched.headers.get('etag') },
  });
  check(revalidated.status === 304, 'avatar endpoint honors conditional ETag requests');

  const bobEmployees = await bob.request('GET', '/api/employees');
  const aliceCard = bobEmployees.data.employees.find((employee) => employee.id === employees[0].id);
  check(aliceCard.avatarVersion === upload.data.avatarVersion &&
    !Object.prototype.hasOwnProperty.call(aliceCard, 'data'),
  'other user list exposes avatarVersion but never the image data');

  const groupCreate = await alice.request('POST', '/api/groups', {
    name: 'Profile Avatar Group', memberIds: [employees[1].id],
  });
  const groupId = groupCreate.data.group.id;
  const members = await bob.request('GET', `/api/groups/${groupId}/members`);
  const aliceMember = members.data.members.find((member) => member.id === employees[0].id);
  const groupMessage = await alice.request('POST', `/api/groups/${groupId}/messages`, { text: 'Avatar sender test' });
  const groupHistory = await bob.request('GET', `/api/groups/${groupId}/messages`);
  check(groupCreate.status === 201 && aliceMember.avatarVersion === upload.data.avatarVersion,
    'group members expose avatarVersion without exposing private profile fields');
  check(groupMessage.status === 201 && groupMessage.data.message.avatarVersion === upload.data.avatarVersion &&
    groupHistory.data.messages.some((message) => message.avatarVersion === upload.data.avatarVersion),
  'group sender avatarVersion is present in live and historical message data');

  const wrongType = await alice.request('POST', '/api/me/avatar', Buffer.from('GIF89a-fake-image'), 'image/gif');
  const fakeImage = await alice.request('POST', '/api/me/avatar', Buffer.from('not really a jpeg'), 'image/jpeg');
  const tooLarge = await alice.request('POST', '/api/me/avatar',
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)]), 'image/jpeg');
  const unchanged = await db.execute('SELECT data, updated_at FROM user_avatars WHERE user_id = ?', [employees[0].id]);
  check(wrongType.status === 415 && /JPEG, PNG, or WebP/.test(wrongType.data.message),
    'wrong image MIME type is rejected with a clear message');
  check(fakeImage.status === 415 && /does not match/.test(fakeImage.data.message),
    'fake image content with a JPEG type is rejected by signature validation');
  check(tooLarge.status === 413 && /300 KB/.test(tooLarge.data.message) &&
    Number(unchanged.rows[0].updated_at) === upload.data.avatarVersion,
  'images larger than 300 KB are rejected without replacing the stored avatar');

  const attemptedTargetedWrite = await bob.request('POST',
    `/api/users/${employees[0].id}/avatar?userId=${employees[0].id}`, png, 'image/png');
  const stillAlice = await db.execute('SELECT data FROM user_avatars WHERE user_id = ?', [employees[0].id]);
  const bobUpload = await bob.request('POST', '/api/me/avatar?userId=' + employees[0].id, png, 'image/png');
  const ownBob = await db.execute('SELECT data FROM user_avatars WHERE user_id = ?', [employees[1].id]);
  check(attemptedTargetedWrite.status === 404 && stillAlice.rows.length === 1 &&
    Buffer.from(stillAlice.rows[0].data).equals(png) &&
    bobUpload.status === 200 && ownBob.rows.length === 1,
  'another user cannot target or alter Alice’s avatar; /me always writes only Bob’s row');

  const aliceRemove = await alice.request('DELETE', '/api/me/avatar');
  const missingImage = await bob.request('GET', `/api/users/${employees[0].id}/avatar`);
  const listAfterRemove = await bob.request('GET', '/api/employees');
  const aliceAfterRemove = listAfterRemove.data.employees.find((employee) => employee.id === employees[0].id);
  const audit = await db.execute(`SELECT action, target FROM audit_events
    WHERE actor_id = ? AND action IN ('avatar_uploaded','avatar_removed') ORDER BY id`, [employees[0].id]);
  check(aliceRemove.status === 200 && missingImage.status === 404 &&
    aliceAfterRemove.avatarVersion == null,
  'removing a photo restores the initials-avatar state and clears avatarVersion');
  check(audit.rows.some((row) => row.action === 'avatar_uploaded') &&
    audit.rows.some((row) => row.action === 'avatar_removed') &&
    audit.rows.every((row) => String(row.target) === String(employees[0].id)),
  'upload and remove are audited without recording image data');
  const removeEvent = await waitForEvent(bobSocket, (event) =>
    event.type === 'user_avatar_updated' && event.userId === employees[0].id && event.avatarVersion === null);
  check(!!removeEvent, 'photo removal is broadcast to other active users');

  const row = await db.execute('SELECT COUNT(*) AS n FROM user_avatars WHERE user_id = ?', [employees[0].id]);
  check(Number(row.rows[0].n) === 0, 'removed avatar BLOB is deleted from the temporary DB');

  await admin.request('POST', `/api/admin/users/${employees[0].id}/deactivate`, {});
  const inactivePatch = await alice.request('PATCH', '/api/me/profile', { fullName: 'Inactive Edit' });
  check(inactivePatch.status === 401, 'inactive users cannot update profile fields');

  if (bobSocket.readyState === WebSocket.OPEN) bobSocket.close();
  console.log(`\nProfile tests: ${passed} passed, ${failed} failed.`);
  if (failed) throw new Error('Profile tests failed.');
}

run().catch((error) => {
  console.error(error);
  if (server && server.exitCode === null) server.kill();
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
