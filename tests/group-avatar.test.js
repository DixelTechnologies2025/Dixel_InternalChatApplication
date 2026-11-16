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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-group-avatar-test-'));
const dbPath = path.join(tempDir, 'group-avatar-copy.db');
const domain = 'group-avatar-test.example';
const password = 'GroupAvatarUser123!';
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
    if (server.exitCode !== null) throw new Error('Temporary group-avatar server exited during startup.');
    try {
      if ((await fetch(base + '/login.html')).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for temporary group-avatar server.');
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

async function createEmployee(admin, client, name, email) {
  const signup = await client.request('POST', '/api/auth/signup', {
    fullName: name, email, employeeId: name, department: 'Engineering',
    password, confirmPassword: password,
  });
  const pending = (await admin.request('GET', '/api/admin/users?status=pending')).data.users;
  const user = pending.find((row) => row.email === email);
  const approved = user
    ? await admin.request('POST', `/api/admin/users/${user.id}/approve`, {})
    : { status: 0 };
  const login = await client.request('POST', '/api/auth/login', { email, password });
  return { signup, approved, login, id: login.data.user && login.data.user.id };
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
    ADMIN_PASSWORD: 'GroupAvatarAdmin123!',
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
  await db.execute('PRAGMA foreign_keys = ON');
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
  const aliceUser = await createEmployee(admin, alice, 'Group Alice', `alice-${suffix}@${domain}`);
  const bobUser = await createEmployee(admin, bob, 'Group Bob', `bob-${suffix}@${domain}`);
  check(adminLogin.status === 200, 'temporary copied-DB administrator signs in');
  check(aliceUser.signup.status === 202 && aliceUser.approved.status === 200 && aliceUser.login.status === 200 &&
    bobUser.signup.status === 202 && bobUser.approved.status === 200 && bobUser.login.status === 200,
  'group admin and member are created and sign in');

  const created = await alice.request('POST', '/api/groups', {
    name: 'Group Photo Test', memberIds: [bobUser.id],
  });
  const groupId = created.data.group.id;
  const aliceSocket = await alice.connect(), bobSocket = await bob.connect(), adminSocket = await admin.connect();
  await Promise.all([
    waitForEvent(aliceSocket, (event) => event.type === 'ready'),
    waitForEvent(bobSocket, (event) => event.type === 'ready'),
    waitForEvent(adminSocket, (event) => event.type === 'ready'),
  ]);
  const aliceBefore = (await alice.request('GET', '/api/groups')).data.groups
    .find((group) => group.id === groupId);
  const bobBefore = (await bob.request('GET', '/api/groups')).data.groups
    .find((group) => group.id === groupId);
  check(created.status === 201 && created.data.group.avatarVersion == null &&
    aliceBefore.avatarVersion == null && bobBefore.avatarVersion == null &&
    !Object.prototype.hasOwnProperty.call(aliceBefore, 'data'),
  'group list exposes only a nullable avatarVersion to its members');
  check((await anonymous.request('GET', `/api/groups/${groupId}/avatar`)).status === 401,
    'unauthenticated requests cannot read group photos');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r3cAAAAASUVORK5CYII=', 'base64');
  const messagesBefore = await db.execute('SELECT COUNT(*) AS n FROM group_messages');
  const upload = await alice.request('POST', `/api/groups/${groupId}/avatar`, png, 'image/png');
  const saved = await db.execute('SELECT mime, data, updated_at FROM group_avatars WHERE group_id = ?', [groupId]);
  const aliceAfter = (await alice.request('GET', '/api/groups')).data.groups.find((group) => group.id === groupId);
  const bobAfter = (await bob.request('GET', '/api/groups')).data.groups.find((group) => group.id === groupId);
  const memberDetails = await bob.request('GET', `/api/groups/${groupId}/members`);
  const emptyHistory = await bob.request('GET', `/api/groups/${groupId}/messages`);
  const event = await waitForEvent(bobSocket, (item) =>
    item.type === 'group_avatar_updated' && item.groupId === groupId);
  const outsiderEvent = await waitForEvent(adminSocket, (item) =>
    item.type === 'group_avatar_updated' && item.groupId === groupId, 250);
  const fetchPhoto = await bob.request('GET', `/api/groups/${groupId}/avatar?v=${upload.data.avatarVersion}`);
  const unauthorizedMemberPhoto = await admin.request('GET', `/api/groups/${groupId}/avatar`);
  const messagesAfter = await db.execute('SELECT COUNT(*) AS n FROM group_messages');
  check(upload.status === 200 && saved.rows.length === 1 && saved.rows[0].mime === 'image/png' &&
    Buffer.from(saved.rows[0].data).equals(png) && Number(saved.rows[0].updated_at) === upload.data.avatarVersion,
  'group admin upload is stored as a DB BLOB with a version');
  check(fetchPhoto.status === 200 && fetchPhoto.raw.equals(png) &&
    fetchPhoto.headers.get('etag') && fetchPhoto.headers.get('cache-control').includes('private') &&
    unauthorizedMemberPhoto.status === 403,
  'group members can fetch the photo but non-members receive 403');
  check(aliceAfter.avatarVersion === upload.data.avatarVersion &&
    bobAfter.avatarVersion === upload.data.avatarVersion,
  'avatarVersion changes in both group members’ list responses');
  check(memberDetails.data.group.avatarVersion === upload.data.avatarVersion &&
    emptyHistory.data.group.avatarVersion === upload.data.avatarVersion &&
    !Object.prototype.hasOwnProperty.call(memberDetails.data.group, 'data') &&
    !Object.prototype.hasOwnProperty.call(emptyHistory.data.group, 'data'),
  'members and message-history group objects expose only avatarVersion, never image data');
  check(!!event && event.avatarVersion === upload.data.avatarVersion &&
    Object.keys(event).sort().join(',') === 'avatarVersion,groupId,type' && !outsiderEvent &&
    Number(messagesBefore.rows[0].n) === Number(messagesAfter.rows[0].n) &&
    !bobSocket.events.some((item) => ['group_message', 'message_status'].includes(item.type)),
  'photo update reaches online group members only without messages, ticks, or read-status events');

  const etagResponse = await fetch(`${base}/api/groups/${groupId}/avatar`, {
    headers: { Cookie: bob.cookie, 'If-None-Match': fetchPhoto.headers.get('etag') },
  });
  check(etagResponse.status === 304, 'group photo GET honors conditional ETag requests');

  const memberUpload = await bob.request('POST', `/api/groups/${groupId}/avatar`, png, 'image/png');
  const memberRemove = await bob.request('DELETE', `/api/groups/${groupId}/avatar`);
  check(memberUpload.status === 403 && memberRemove.status === 403,
    'regular group members cannot upload or remove the group photo');

  const wrongType = await alice.request('POST', `/api/groups/${groupId}/avatar`,
    Buffer.from('GIF89a-fake-image'), 'image/gif');
  const fakeExtension = await alice.request('POST', `/api/groups/${groupId}/avatar?filename=photo.jpg`,
    Buffer.from('not really a jpeg'), 'image/jpeg');
  const tooLarge = await alice.request('POST', `/api/groups/${groupId}/avatar`,
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)]), 'image/jpeg');
  const unchanged = await db.execute('SELECT updated_at FROM group_avatars WHERE group_id = ?', [groupId]);
  check(wrongType.status === 415 && /JPEG, PNG, or WebP/.test(wrongType.data.message),
    'unsupported image type is rejected with a clear message');
  check(fakeExtension.status === 415 && /does not match/.test(fakeExtension.data.message),
    'fake JPEG extension and MIME are rejected by magic-byte validation');
  check(tooLarge.status === 413 && /300 KB/.test(tooLarge.data.message) &&
    Number(unchanged.rows[0].updated_at) === upload.data.avatarVersion,
  'uploads over 300 KB are rejected without replacing the saved photo');

  const remove = await alice.request('DELETE', `/api/groups/${groupId}/avatar`);
  const removedPhoto = await bob.request('GET', `/api/groups/${groupId}/avatar`);
  const aliceRemoved = (await alice.request('GET', '/api/groups')).data.groups
    .find((group) => group.id === groupId);
  const removalEvent = await waitForEvent(bobSocket, (item) =>
    item.type === 'group_avatar_updated' && item.groupId === groupId && item.avatarVersion === null);
  const audit = await db.execute(`SELECT action, target FROM audit_events
    WHERE actor_id = ? AND action IN ('group_avatar_uploaded','group_avatar_removed')`, [aliceUser.id]);
  check(remove.status === 200 && removedPhoto.status === 404 && aliceRemoved.avatarVersion == null &&
    !!removalEvent,
  'removing the photo restores the group icon and clears member avatarVersion values');
  check(audit.rows.some((row) => row.action === 'group_avatar_uploaded') &&
    audit.rows.some((row) => row.action === 'group_avatar_removed') &&
    audit.rows.every((row) => String(row.target) === String(groupId)),
  'group photo upload and removal are audited without image data');

  const secondUpload = await alice.request('POST', `/api/groups/${groupId}/avatar`, png, 'image/png');
  await db.execute('DELETE FROM groups WHERE id = ?', [groupId]);
  const cascade = await db.execute('SELECT COUNT(*) AS n FROM group_avatars WHERE group_id = ?', [groupId]);
  check(secondUpload.status === 200 && secondUpload.data.avatarVersion > upload.data.avatarVersion &&
    Number(cascade.rows[0].n) === 0,
  're-upload after removal gets a fresh version and deleting a group cascades to its photo row');

  [aliceSocket, bobSocket, adminSocket].forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });
  console.log(`\nGroup avatar tests: ${passed} passed, ${failed} failed.`);
  if (failed) throw new Error('Group avatar tests failed.');
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
