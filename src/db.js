const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { hashPassword } = require('./passwords');

fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Minimal migration runner: applies migrations/*.sql once, in filename order.
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
const dir = path.join(cfg.root, 'migrations');
const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) continue;
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
  })();
  console.log(`[db] applied migration ${file}`);
}

function audit(actorId, action, target, ip) {
  db.prepare('INSERT INTO audit_events (actor_id, action, target, ip, created_at) VALUES (?,?,?,?,?)')
    .run(actorId || null, action, target == null ? null : String(target), ip || null, Date.now());
}

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return false;
  if (!email || !password) {
    throw new Error('Both ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed an administrator.');
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    console.log(`[setup] Administrator ${email} already exists; skipping seed.`);
    return false;
  }

  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const info = db.prepare(`INSERT INTO users
    (full_name, email, password_hash, role, status, email_verified_at, created_at)
    VALUES ('Administrator', ?, ?, 'admin', 'active', ?, ?)
    ON CONFLICT(email) DO NOTHING`).run(email, passwordHash, now, now);
  if (!info.changes) {
    console.log(`[setup] Administrator ${email} already exists; skipping seed.`);
    return false;
  }
  console.log(`[setup] Created administrator ${email}.`);
  return true;
}

module.exports = db;
module.exports.audit = audit;
module.exports.seedAdmin = seedAdmin;
