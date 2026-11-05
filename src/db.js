const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

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

module.exports = db;
module.exports.audit = audit;
