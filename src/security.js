const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const COOKIE = 'dixel_sid';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const normEmail = (e) => String(e || '').trim().toLowerCase();

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
function emailProblem(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Enter a valid email address.';
  if (email.split('@')[1] !== cfg.companyDomain) {
    return `Only official @${cfg.companyDomain} email addresses can be used.`;
  }
  return null;
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be 128 characters or fewer.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password needs an uppercase letter, a lowercase letter and a number.';
  }
  return null;
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/', maxAge: cfg.sessionHours * 3600 * 1000 };
}

function createSession(userId) {
  const raw = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?)')
    .run(userId, sha256(raw), now, now + cfg.sessionHours * 3600 * 1000);
  return raw;
}

const publicUser = (u) => ({
  id: u.id, fullName: u.full_name, email: u.email, employeeId: u.employee_id,
  department: u.department, role: u.role,
});

function authFromToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const row = db.prepare(`
    SELECT u.*, s.id AS session_id, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`).get(sha256(raw), Date.now());
  return row || null;
}

function requireAuth(req, res, next) {
  const user = authFromToken(req.cookies && req.cookies[COOKIE]);
  if (!user) return res.status(401).json({ message: 'Sign in to continue.' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Administrator access required.' });
  next();
}

// CSRF defence in depth: SameSite=Strict cookie + a custom header that cross-site forms cannot send.
function requireCustomHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'dixel') return res.status(403).json({ message: 'Request rejected.' });
  next();
}

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7G3nQ2yq0bV4n5pQ1vWk3m2dQ6yq9oa';

module.exports = {
  COOKIE, sha256, newToken, normEmail, emailProblem, passwordProblem, cookieOptions,
  createSession, authFromToken, publicUser, requireAuth, requireAdmin, requireCustomHeader, DUMMY_HASH,
};
