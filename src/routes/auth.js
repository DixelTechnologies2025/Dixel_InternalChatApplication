const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const db = require('../db');
const { sendMail } = require('../mailer');
const rt = require('../realtime');
const S = require('../security');

const router = express.Router();
const BCRYPT_COST = 12;
const dummyHash = bcrypt.hashSync('not-a-real-password', BCRYPT_COST); // equalises timing for unknown emails

const limiter = (max, minutes) => rateLimit({
  windowMs: minutes * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a few minutes and try again.' },
});

function issueToken(userId, kind, hours) {
  const raw = S.newToken();
  db.prepare("UPDATE tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL").run(Date.now(), userId, kind);
  db.prepare('INSERT INTO tokens (user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)')
    .run(userId, kind, S.sha256(raw), Date.now() + hours * 3600 * 1000);
  return raw;
}

router.post('/signup', limiter(10, 60), async (req, res) => {
  const b = req.body || {};
  const fullName = String(b.fullName || '').trim().replace(/\s+/g, ' ');
  const email = S.normEmail(b.email);
  const employeeId = String(b.employeeId || '').trim().slice(0, 40) || null;
  const department = String(b.department || '').trim().slice(0, 80) || null;

  const errors = {};
  if (fullName.length < 2 || fullName.length > 120) errors.fullName = 'Enter your full name.';
  const ep = S.emailProblem(email); if (ep) errors.email = ep;
  const pp = S.passwordProblem(b.password); if (pp) errors.password = pp;
  else if (b.password !== b.confirmPassword) errors.confirmPassword = 'Passwords do not match.';
  if (Object.keys(errors).length) return res.status(400).json({ message: 'Fix the highlighted fields.', errors });

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) {
    const hash = await bcrypt.hash(b.password, BCRYPT_COST);
    const invite = db.prepare('SELECT * FROM invites WHERE email = ?').get(email);
    const invited = !!invite && (!invite.employee_id || invite.employee_id === employeeId);
    const status = invited && cfg.autoApproveInvited ? 'active' : 'pending';
    const now = Date.now();
    const info = db.prepare(`INSERT INTO users (full_name, email, employee_id, department, password_hash, status, email_verified_at, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(fullName, email, employeeId, department || invite?.department || null, hash, status, now, now);
    db.audit(info.lastInsertRowid, 'signup', email, req.ip);
  }
  // Same response whether or not the account existed (prevents email enumeration).
  res.status(202).json({ message: 'Your request has been sent. You can sign in after an administrator approves your account.' });
});

router.post('/login', limiter(10, 15), async (req, res) => {
  const email = S.normEmail((req.body || {}).email);
  const password = String((req.body || {}).password || '');
  const ep = S.emailProblem(email);
  if (ep) return res.status(400).json({ message: ep, errors: { email: ep } });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
  if (!user || !ok) {
    db.audit(user && user.id, 'login_failed', email, req.ip);
    return res.status(401).json({ message: 'Incorrect email or password.' });
  }
  const blocked = {
    pending: 'Your account is waiting for administrator approval.',
    rejected: 'Your registration was not approved. Contact your administrator.',
    inactive: 'This account is deactivated. Contact your administrator.',
  }[user.status];
  if (user.status !== 'active') {
    return res.status(403).json({ message: blocked || 'Your account is not active. Contact your administrator.', status: user.status });
  }

  const raw = S.createSession(user.id);
  db.audit(user.id, 'login', email, req.ip);
  res.cookie(S.COOKIE, raw, S.cookieOptions());
  res.json({ user: S.publicUser(user) });
});

router.post('/logout', (req, res) => {
  const raw = req.cookies[S.COOKIE];
  if (raw) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(S.sha256(raw));
    rt.disconnectToken(raw);
  }
  res.clearCookie(S.COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', S.requireAuth, (req, res) => res.json({ user: S.publicUser(req.user) }));

router.post('/forgot', limiter(5, 15), async (req, res) => {
  const email = S.normEmail((req.body || {}).email);
  if (!S.emailProblem(email)) {
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(email);
    if (user) {
      const token = issueToken(user.id, 'reset', 1);
      await sendMail({
        to: user.email,
        subject: 'Reset your Dixel Pulse password',
        text: `Dixel Pulse password reset\n\nHi ${user.full_name},\n\nChoose a new password here:\n${cfg.appUrl}/reset.html?token=${token}\n\nThe link works once and expires in 1 hour. If you did not ask for this, ignore this email.\n`,
      });
      db.audit(user.id, 'password_reset_requested', email, req.ip);
    }
  }
  res.status(202).json({ message: 'If that address belongs to an active account, a reset link is on its way.' });
});

router.post('/reset', limiter(10, 15), async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  const pp = S.passwordProblem(password);
  if (pp) return res.status(400).json({ message: pp, errors: { password: pp } });
  if (password !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match.', errors: { confirmPassword: 'Passwords do not match.' } });
  const row = db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'reset'").get(S.sha256(String(token || '')));
  if (!row || row.used_at || row.expires_at < Date.now()) {
    return res.status(400).json({ message: 'This reset link is invalid or has expired. Request a new one.' });
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
    db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  })();
  rt.disconnectUser(row.user_id);
  db.audit(row.user_id, 'password_reset', null, req.ip);
  res.json({ message: 'Password updated. Sign in with your new password.' });
});

module.exports = router;
