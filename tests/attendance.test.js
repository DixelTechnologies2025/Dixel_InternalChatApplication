const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient } = require('@libsql/client');
const WebSocket = require('ws');
const { workDateAt, isWorkDate } = require('../src/attendance-time');

const root = path.join(__dirname, '..');
const sourcePath = path.resolve(process.env.DEV_DB_PATH || path.join(root, 'data', 'chat.db'));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dixel-attendance-test-'));
const dbPath = path.join(tempDir, 'attendance-copy.db');
const domain = 'attendance-test.example';
const password = 'AttendanceUser123!';
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
  constructor(base) { this.base = base; this.cookies = new Map(); }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(method, url, body) {
    const headers = { 'X-Requested-With': 'dixel' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(this.base + url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    cookies.forEach((cookie) => {
      const [pair] = cookie.split(';'), index = pair.indexOf('=');
      const key = pair.slice(0, index), value = pair.slice(index + 1);
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
    const event = socket.events.find(predicate);
    if (event) return event;
    await sleep(20);
  }
  return socket.events.find(predicate) || null;
}

async function waitForServer(base) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Temporary attendance server exited during startup.');
    try { if ((await fetch(base + '/login.html')).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for temporary attendance server.');
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
  } finally { await source.close(); }
}

async function run() {
  const before = snapshotDevDatabase();
  const boundaryBefore = Date.parse('2026-11-12T18:29:59.999Z');
  const boundaryAfter = Date.parse('2026-11-12T18:30:00.000Z');
  check(workDateAt(boundaryBefore) === '2026-11-12' &&
    workDateAt(boundaryAfter) === '2026-11-13' &&
    isWorkDate('2026-02-28') && !isWorkDate('2026-02-30'),
  'injected server timestamps reset the Kolkata work date at midnight');

  const originalCounts = await before;
  const port = await getPort();
  const base = `http://127.0.0.1:${port}`;
  const suffix = `${Date.now()}-${process.pid}`;
  const env = {
    ...process.env,
    PORT: String(port), APP_URL: base, DB_PATH: dbPath,
    TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '',
    ADMIN_EMAIL: `admin-${suffix}@${domain}`, ADMIN_PASSWORD: 'AttendanceAdmin123!',
    COMPANY_DOMAIN: domain, SMTP_HOST: '', NODE_ENV: 'test', TRUST_PROXY: 'true',
  };
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data.toString(); });
  server.stderr.on('data', (data) => { output += data.toString(); });
  await waitForServer(base);
  db = createClient({ url: pathToFileURL(dbPath).href, intMode: 'number' });
  const counts = await db.execute(`SELECT
    (SELECT COUNT(*) FROM conversations) AS conversations,
    (SELECT COUNT(*) FROM messages) AS messages`);
  const schema = await db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_attendance_work_date','idx_attendance_user')");
  check(path.resolve(dbPath) !== sourcePath &&
    Number(counts.rows[0].conversations) === originalCounts.conversations &&
    Number(counts.rows[0].messages) === originalCounts.messages &&
    schema.rows.length === 2,
  'attendance migration runs on a temporary copy of the development database');

  const admin = new Client(base), employee = new Client(base), secondEmployee = new Client(base);
  const inactive = new Client(base), pending = new Client(base), rejected = new Client(base), anonymous = new Client(base);
  check((await admin.request('POST', '/api/auth/login', {
    email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD,
  })).status === 200, 'temporary copied-DB administrator signs in');
  check((await anonymous.request('GET', '/api/attendance/today')).status === 401,
    'unauthenticated users cannot read attendance');

  const people = [
    { client: employee, name: 'Attendance Alice', email: `alice-${suffix}@${domain}`, active: true },
    { client: secondEmployee, name: 'Attendance Bob', email: `bob-${suffix}@${domain}`, active: true },
    { client: inactive, name: 'Attendance Inactive', email: `inactive-${suffix}@${domain}`, active: true },
    { client: pending, name: 'Attendance Pending', email: `pending-${suffix}@${domain}`, active: false },
    { client: rejected, name: 'Attendance Rejected', email: `rejected-${suffix}@${domain}`, active: false },
  ];
  for (const person of people) {
    const signup = await person.client.request('POST', '/api/auth/signup', {
      fullName: person.name, email: person.email, employeeId: person.name,
      department: person.name.includes('Bob') ? 'Operations' : 'Engineering',
      password, confirmPassword: password,
    });
    check(signup.status === 202, `${person.name} signup accepted`);
  }
  const signups = (await admin.request('GET', '/api/admin/users?status=pending')).data.users;
  for (const person of people.filter((row) => row.active)) {
    const user = signups.find((row) => row.email === person.email);
    const approval = await admin.request('POST', `/api/admin/users/${user.id}/approve`, {});
    const login = await person.client.request('POST', '/api/auth/login', { email: person.email, password });
    person.id = login.data.user.id;
    person.client.id = person.id;
    check(approval.status === 200 && login.status === 200, `${person.name} approved and signs in`);
  }
  for (const person of people.filter((row) => !row.active)) {
    person.id = signups.find((row) => row.email === person.email).id;
    person.client.id = person.id;
  }
  await admin.request('POST', `/api/admin/users/${inactive.id}/deactivate`, {});
  await admin.request('POST', `/api/admin/users/${rejected.id}/reject`, {});

  const now = Date.now();
  const workDate = workDateAt(now);
  const afterLogin = await employee.request('GET', '/api/attendance/today');
  check(afterLogin.status === 200 && afterLogin.data.attendance === null,
    'signing in does not automatically check the employee in');
  const noCheckin = await secondEmployee.request('POST', '/api/attendance/check-out');
  check(noCheckin.status === 409 && /Check in before/.test(noCheckin.data.message),
    'check-out without check-in is rejected');

  const adminSocket = await admin.connect(), employeeSocket = await employee.connect();
  await waitForEvent(adminSocket, (event) => event.type === 'ready');
  await waitForEvent(employeeSocket, (event) => event.type === 'ready');

  const submittedFakeTime = 946684800000;
  const checkedIn = await employee.request('POST', '/api/attendance/check-in', {
    checkInAt: submittedFakeTime, workDate: '2000-01-01',
  });
  const storedIn = await db.execute('SELECT check_in_at, work_date, check_in_ip FROM attendance WHERE user_id = ?', [employee.id]);
  check(checkedIn.status === 201 && checkedIn.data.attendance.workDate === workDate &&
    Number(storedIn.rows[0].check_in_at) > submittedFakeTime &&
    Math.abs(Date.now() - Number(storedIn.rows[0].check_in_at)) < 10000 &&
    storedIn.rows[0].work_date === workDate && storedIn.rows[0].check_in_ip,
  'check-in works once and ignores client-supplied time in favor of the server clock');
  const duplicateIn = await employee.request('POST', '/api/attendance/check-in', {});
  check(duplicateIn.status === 409 && /already checked in/.test(duplicateIn.data.message),
    'second check-in is rejected');
  const adminInEvent = await waitForEvent(adminSocket, (event) =>
    event.type === 'attendance_updated' && event.userId === employee.id && event.workDate === workDate);
  await sleep(100);
  check(!!adminInEvent && !employeeSocket.events.some((event) => event.type === 'attendance_updated'),
    'attendance realtime updates go only to admin sockets');

  const secondSession = new Client(base);
  const secondEmail = people.find((person) => person.name === 'Attendance Bob').email;
  await secondSession.request('POST', '/api/auth/login', { email: secondEmail, password });
  const concurrentIns = await Promise.all([
    secondEmployee.request('POST', '/api/attendance/check-in', { time: submittedFakeTime }),
    secondSession.request('POST', '/api/attendance/check-in', { time: submittedFakeTime }),
  ]);
  check(concurrentIns.filter((result) => result.status === 201).length === 1 &&
    concurrentIns.filter((result) => result.status === 409).length === 1,
  `unique daily key prevents concurrent duplicate check-ins (${concurrentIns.map((result) => result.status).join(',')})`);
  await secondEmployee.request('POST', '/api/auth/logout');
  const bobLogin = await secondEmployee.request('POST', '/api/auth/login', { email: secondEmail, password });
  const bobAttendanceAfterLogin = await secondEmployee.request('GET', '/api/attendance/today');
  check(bobLogin.status === 200 && bobAttendanceAfterLogin.data.attendance.checkInAt &&
    bobAttendanceAfterLogin.data.attendance.checkOutAt === null,
  'signing out does not check the employee out and attendance persists after signing in again');

  const aliceSession = new Client(base);
  const aliceEmail = people.find((person) => person.name === 'Attendance Alice').email;
  const aliceSecondLogin = await aliceSession.request('POST', '/api/auth/login', { email: aliceEmail, password });
  const checkoutStarted = Date.now();
  const concurrentOuts = await Promise.all([
    employee.request('POST', '/api/attendance/check-out', { checkOutAt: submittedFakeTime }),
    aliceSession.request('POST', '/api/attendance/check-out'),
  ]);
  const storedOut = await db.execute('SELECT check_out_at, check_out_ip FROM attendance WHERE user_id = ?', [employee.id]);
  check(aliceSecondLogin.status === 200 &&
    concurrentOuts.filter((result) => result.status === 200).length === 1 &&
    concurrentOuts.filter((result) => result.status === 409).length === 1 &&
    Number(storedOut.rows[0].check_out_at) >= checkoutStarted &&
    Number(storedOut.rows[0].check_out_at) > Number(storedIn.rows[0].check_in_at) &&
    storedOut.rows[0].check_out_ip,
  'guarded concurrent check-outs record server time exactly once');
  const duplicateOut = await employee.request('POST', '/api/attendance/check-out');
  check(duplicateOut.status === 409 && /already checked out/.test(duplicateOut.data.message),
    'second check-out is rejected');

  const personal = await employee.request('GET', '/api/attendance/today');
  check(personal.status === 200 && personal.data.attendance.checkOutAt === Number(storedOut.rows[0].check_out_at) &&
    !Object.prototype.hasOwnProperty.call(personal.data, 'rows'),
  'employee attendance endpoint returns only the signed-in user’s record');
  await employee.request('POST', '/api/auth/logout');
  const aliceLogin = await employee.request('POST', '/api/auth/login', {
    email: people.find((person) => person.name === 'Attendance Alice').email, password,
  });
  const aliceAttendanceAfterLogin = await employee.request('GET', '/api/attendance/today');
  check(aliceLogin.status === 200 && aliceAttendanceAfterLogin.data.attendance.checkOutAt === personal.data.attendance.checkOutAt,
    'checked-out state persists through app sign-out and sign-in');
  const employeeAdminList = await employee.request('GET', '/api/admin/attendance');
  const employeeExport = await employee.request('GET', '/api/admin/attendance/export');
  check(employeeAdminList.status === 403 && employeeExport.status === 403,
    'employees receive 403 from both admin attendance endpoints');

  const report = await admin.request('GET', '/api/admin/attendance?date=' + encodeURIComponent(workDate));
  const reportRows = report.data.rows;
  const aliceRow = reportRows.find((row) => row.userId === employee.id);
  const bobRow = reportRows.find((row) => row.userId === secondEmployee.id);
  const adminId = (await db.execute("SELECT id FROM users WHERE email = ?", [env.ADMIN_EMAIL])).rows[0].id;
  const inactiveExcluded = !reportRows.some((row) =>
    [inactive.id, pending.id, rejected.id].includes(row.userId));
  check(report.status === 200 && aliceRow.status === 'Present' && bobRow.status === 'Working' &&
    reportRows.some((row) => row.userId === adminId && row.status === 'Absent') &&
    !reportRows.some((row) => row.userId === people.find((person) => person.name === 'Attendance Inactive').id) &&
    inactiveExcluded,
  'admin report shows Present, Working and active-only Absent rows including the admin');
  check(report.data.summary.present === 2 && report.data.summary.currentlyWorking === 1 &&
    report.data.summary.checkedOut === 1,
  'admin daily summary counts present, working and checked-out employees');
  const notCheckedOutDate = new Date(Date.parse(`${workDate}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
  await db.execute(`INSERT INTO attendance (user_id, work_date, check_in_at, check_in_ip)
    VALUES (?, ?, ?, ?)`, [employee.id, notCheckedOutDate, Date.now() - 86400000, '127.0.0.1']);
  const pastReport = await admin.request('GET', '/api/admin/attendance?date=' + notCheckedOutDate);
  check(pastReport.data.rows.find((row) => row.userId === employee.id).status === 'Not checked out',
    'past check-in without checkout is labeled Not checked out');

  const search = await admin.request('GET',
    '/api/admin/attendance?date=' + workDate + '&search=Operations');
  check(search.data.rows.length === 1 && search.data.rows[0].userId === secondEmployee.id,
    'admin report searches employee department');
  const range = await admin.request('GET',
    `/api/admin/attendance?from=${notCheckedOutDate}&to=${workDate}&search=Alice`);
  check(range.status === 200 && range.data.rows.length === 2 &&
    range.data.rows.every((row) => row.userId === employee.id),
  'admin date-range and employee-name filters return matching daily rows');

  const csv = await admin.request('GET', `/api/admin/attendance/export?date=${workDate}`);
  const csvText = csv.raw.toString('utf8').replace(/^\uFEFF/, '');
  check(csv.status === 200 && csv.headers.get('content-type').includes('text/csv') &&
    csvText.includes('"Employee name","Employee ID","Department","Date"') &&
    csvText.includes('"Attendance Alice"') && csvText.includes('"Present"') &&
    csvText.includes('"Attendance Bob"') && csvText.includes('"Working"') &&
    !csvText.includes('"Attendance Inactive"') && csv.headers.get('content-disposition').includes('.csv'),
  'CSV export includes the selected date, expected rows and statuses, and excludes inactive accounts');

  const monthly = await admin.request('GET',
    `/api/admin/attendance?view=monthly&month=${workDate.slice(0, 7)}&search=Alice`);
  check(monthly.status === 200 && monthly.data.employees.length === 1 &&
    monthly.data.employees[0].daysPresent === 2 &&
    monthly.data.employees[0].totalHours >= 0,
  'monthly summary reports days present and total attendance hours');

  const audit = await db.execute(`SELECT action FROM audit_events WHERE actor_id = ?
    AND action IN ('attendance_check_in','attendance_check_out')`, [employee.id]);
  check(audit.rows.filter((row) => row.action === 'attendance_check_in').length === 1 &&
    audit.rows.filter((row) => row.action === 'attendance_check_out').length === 1,
  'successful check-in and check-out actions are audited once');
  const adminCheckIn = await admin.request('POST', '/api/attendance/check-in');
  const adminCheckOut = await admin.request('POST', '/api/attendance/check-out');
  check(adminCheckIn.status === 201 && adminCheckOut.status === 200,
    'active administrators can also check in and check out');

  if (adminSocket.readyState === WebSocket.OPEN) adminSocket.close();
  if (employeeSocket.readyState === WebSocket.OPEN) employeeSocket.close();
  console.log(`\nAttendance tests: ${passed} passed, ${failed} failed.`);
  if (failed) throw new Error('Attendance tests failed.');
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
      try { fs.rmSync(${JSON.stringify(tempDir)}, { recursive: true, force: true }); }
      catch (error) {
        if (++attempts >= 30) { console.error(error); process.exitCode = 1; return; }
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
