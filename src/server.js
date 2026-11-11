const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cfg = require('./config');
const db = require('./db');
const S = require('./security');
const rt = require('./realtime');
const { smtpConfigured } = require('./mailer');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': cfg.cookieSecure ? [] : null,
    },
  },
  hsts: cfg.cookieSecure,
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// ---- API ----
app.use('/api', S.requireCustomHeader);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', S.requireAuth, S.requireAdmin, require('./routes/admin'));
app.use('/api', S.requireAuth, require('./routes/chat'));
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));

// ---- Pages ----
const signedIn = (req) => S.authFromToken(req.cookies[S.COOKIE]);
app.get('/', (req, res) => res.redirect(signedIn(req) ? '/chat' : '/login.html'));
app.get('/chat', (req, res) => {
  if (!signedIn(req)) return res.redirect('/login.html');
  res.set('Cache-Control', 'no-store').sendFile(path.join(cfg.root, 'views', 'chat.html'));
});
app.get('/admin', (req, res) => {
  const u = signedIn(req);
  if (!u) return res.redirect('/login.html');
  if (u.role !== 'admin') return res.redirect('/chat');
  res.set('Cache-Control', 'no-store').sendFile(path.join(cfg.root, 'views', 'admin.html'));
});
app.use(express.static(path.join(cfg.root, 'public'), { index: false, dotfiles: 'ignore' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request.' });
  console.error('[error]', err);
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

const server = http.createServer(app);
rt.attach(server, cfg);

// ---- Housekeeping: expired sessions/tokens and message retention ----
function housekeeping() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now - 7 * 864e5);
  if (cfg.retentionDays > 0) {
    const n = db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - cfg.retentionDays * 864e5).changes;
    if (n) console.log(`[retention] deleted ${n} message(s) older than ${cfg.retentionDays} days`);
  }
}
housekeeping();
setInterval(housekeeping, 3600 * 1000).unref();

if (require.main === module) {
  db.seedAdmin().then(() => {
    server.listen(cfg.port, () => {
      console.log(`${cfg.companyName} chat running at ${cfg.appUrl} (port ${cfg.port})`);
      if (!smtpConfigured) console.log('[mail] SMTP not configured: password reset links print here and in data/dev-mail.log');
      const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n;
      if (!admins) console.log('[setup] No administrator yet. Set ADMIN_EMAIL and ADMIN_PASSWORD or run: npm run create-admin -- you@' + cfg.companyDomain + ' "Your Name"');
    });
  }).catch((err) => {
    console.error('[setup] Failed to seed administrator:', err);
    process.exitCode = 1;
  });
}
module.exports = { app, server };
