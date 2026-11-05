const express = require('express');
const db = require('../db');
const rt = require('../realtime');
const S = require('../security');

const router = express.Router();

const row = (u) => ({
  id: u.id, fullName: u.full_name, email: u.email, employeeId: u.employee_id, department: u.department,
  role: u.role, status: u.status, createdAt: u.created_at, verified: !!u.email_verified_at,
});

router.get('/users', (req, res) => {
  const status = String(req.query.status || '');
  const rows = status
    ? db.prepare('SELECT * FROM users WHERE status = ? ORDER BY created_at DESC LIMIT 500').all(status)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
  res.json({ users: rows.map(row) });
});

function setStatus(allowedFrom, to, action) {
  return (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ message: 'Employee not found.' });
    if (u.id === req.user.id) return res.status(400).json({ message: 'You cannot change your own account status.' });
    if (!allowedFrom.includes(u.status)) return res.status(409).json({ message: `Account is currently ${u.status}.` });
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(to, id);
    if (to !== 'active') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      rt.broadcast({ type: 'employee_unavailable', userId: id });
      rt.disconnectUser(id);
    }
    db.audit(req.user.id, action, u.email, req.ip);
    res.json({ user: row({ ...u, status: to }) });
  };
}
router.post('/users/:id/approve', setStatus(['pending', 'rejected'], 'active', 'admin_approve'));
router.post('/users/:id/reject', setStatus(['pending'], 'rejected', 'admin_reject'));
router.post('/users/:id/deactivate', setStatus(['active'], 'inactive', 'admin_deactivate'));
router.post('/users/:id/reactivate', setStatus(['inactive'], 'active', 'admin_reactivate'));

router.get('/invites', (req, res) => {
  const rows = db.prepare(`SELECT i.*, (SELECT 1 FROM users u WHERE u.email = i.email) AS registered
    FROM invites i ORDER BY created_at DESC LIMIT 500`).all();
  res.json({ invites: rows.map((i) => ({ email: i.email, employeeId: i.employee_id, department: i.department, createdAt: i.created_at, registered: !!i.registered })) });
});

router.post('/invites', (req, res) => {
  const email = S.normEmail((req.body || {}).email);
  const ep = S.emailProblem(email);
  if (ep) return res.status(400).json({ message: ep });
  const employeeId = String((req.body || {}).employeeId || '').trim().slice(0, 40) || null;
  const department = String((req.body || {}).department || '').trim().slice(0, 80) || null;
  db.prepare(`INSERT INTO invites (email, employee_id, department, created_by, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET employee_id = excluded.employee_id, department = excluded.department`)
    .run(email, employeeId, department, req.user.id, Date.now());
  db.audit(req.user.id, 'admin_invite', email, req.ip);
  res.status(201).json({ ok: true });
});

router.delete('/invites/:email', (req, res) => {
  db.prepare('DELETE FROM invites WHERE email = ?').run(S.normEmail(req.params.email));
  db.audit(req.user.id, 'admin_invite_removed', req.params.email, req.ip);
  res.json({ ok: true });
});

module.exports = router;
