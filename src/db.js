const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const cfg = require('./config');
const { hashPassword } = require('./passwords');

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!!databaseUrl !== !!authToken) {
  throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set, or both be omitted.');
}

const isRemote = !!databaseUrl;
if (!isRemote) fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });

const client = createClient(isRemote
  ? { url: databaseUrl, authToken, intMode: 'number' }
  : { url: pathToFileURL(cfg.dbPath).href, intMode: 'number' });

function normalizeValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowsAsObjects(result) {
  return result.rows.map((row) => Object.fromEntries(
    result.columns.map((column, index) => [column, normalizeValue(row[index])]),
  ));
}

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let state = 'normal';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'line-comment') {
      if (ch === '\n') state = 'normal';
    } else if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'normal'; i++; }
    } else if (state === 'single' || state === 'double' || state === 'backtick') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (ch === quote && next === quote) i++;
      else if (ch === quote) state = 'normal';
    } else if (state === 'bracket') {
      if (ch === ']') state = 'normal';
    } else if (ch === '-' && next === '-') {
      state = 'line-comment'; i++;
    } else if (ch === '/' && next === '*') {
      state = 'block-comment'; i++;
    } else if (ch === "'") {
      state = 'single';
    } else if (ch === '"') {
      state = 'double';
    } else if (ch === '`') {
      state = 'backtick';
    } else if (ch === '[') {
      state = 'bracket';
    } else if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = sql.slice(start).trim();
  if (trailing && !/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+$/.test(trailing)) {
    statements.push(trailing);
  }
  return statements;
}

function createDatabaseFacade(execute) {
  const facade = {
    prepare(sql) {
      return {
        async get(...args) {
          const result = await execute(sql, args);
          return rowsAsObjects(result)[0];
        },
        async all(...args) {
          return rowsAsObjects(await execute(sql, args));
        },
        async run(...args) {
          const result = await execute(sql, args);
          return {
            changes: result.rowsAffected,
            lastInsertRowid: normalizeValue(result.lastInsertRowid),
          };
        },
      };
    },
    async exec(sql) {
      for (const statement of splitStatements(sql)) await execute(statement, []);
    },
    async audit(actorId, action, target, ip) {
      await facade.prepare('INSERT INTO audit_events (actor_id, action, target, ip, created_at) VALUES (?,?,?,?,?)')
        .run(actorId || null, action, target == null ? null : String(target), ip || null, Date.now());
    },
  };
  return facade;
}

let initialization;

const db = createDatabaseFacade(async (sql, args) => {
  await initialize();
  return client.execute({ sql, args });
});

async function runTransaction(callback) {
  const transaction = await client.transaction('write');
  const tx = createDatabaseFacade((sql, args) => transaction.execute({ sql, args }));
  try {
    const result = await callback(tx);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      console.error('[db] transaction rollback failed:', rollbackError);
    }
    throw error;
  }
}

async function initialize() {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!isRemote) {
      await client.execute('PRAGMA foreign_keys = ON');
      console.log(`[db] using local SQLite file ${cfg.dbPath}`);
    } else {
      console.log('[db] using Turso database');
    }

    await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const appliedRows = await client.execute('SELECT name FROM schema_migrations');
    const applied = new Set(rowsAsObjects(appliedRows).map((row) => row.name));
    const dir = path.join(cfg.root, 'migrations');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const statements = splitStatements(fs.readFileSync(path.join(dir, file), 'utf8'));
      await runTransaction(async (tx) => {
        for (const statement of statements) await tx.exec(statement);
        await tx.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(file, Date.now());
      });
      console.log(`[db] applied migration ${file}`);
    }
  })();
  return initialization;
}

db.initialize = initialize;
db.transaction = async (callback) => {
  await initialize();
  return runTransaction(callback);
};
db.seedAdmin = async function seedAdmin() {
  await initialize();
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return false;
  if (!email || !password) {
    throw new Error('Both ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed an administrator.');
  }
  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    console.log(`[setup] Administrator ${email} already exists; skipping seed.`);
    return false;
  }

  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const info = await db.prepare(`INSERT INTO users
    (full_name, email, password_hash, role, status, email_verified_at, created_at)
    VALUES ('Administrator', ?, ?, 'admin', 'active', ?, ?)
    ON CONFLICT(email) DO NOTHING`).run(email, passwordHash, now, now);
  if (!info.changes) {
    console.log(`[setup] Administrator ${email} already exists; skipping seed.`);
    return false;
  }
  console.log(`[setup] Created administrator ${email}.`);
  const { ensureAdminsInAllGroups } = require('./group-admins');
  await ensureAdminsInAllGroups();
  return true;
};

module.exports = db;
