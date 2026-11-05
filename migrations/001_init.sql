-- Employees
CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name        TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  employee_id      TEXT,
  department       TEXT,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
  -- unverified: email not yet confirmed | pending: waiting for admin approval
  -- active: may use chat | rejected / inactive: blocked
  status           TEXT NOT NULL DEFAULT 'unverified'
                   CHECK (status IN ('unverified','pending','active','rejected','inactive')),
  email_verified_at INTEGER,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER
);
CREATE INDEX idx_users_status ON users(status);

-- Admin-managed list of genuine employees allowed to skip manual approval
CREATE TABLE invites (
  email       TEXT PRIMARY KEY,
  employee_id TEXT,
  department  TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

-- Server-side sessions (only a SHA-256 hash of the cookie value is stored)
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One-time tokens for email verification and password reset
CREATE TABLE tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Private one-to-one conversations (user_a < user_b keeps each pair unique)
CREATE TABLE conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE UNIQUE INDEX idx_messages_idem ON messages(conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE conversation_reads (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  target     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
