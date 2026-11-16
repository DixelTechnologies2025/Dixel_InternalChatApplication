CREATE TABLE conversations_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (user_a <= user_b),
  UNIQUE (user_a, user_b)
);
INSERT INTO conversations_new (id, user_a, user_b, created_at)
  SELECT id, user_a, user_b, created_at FROM conversations;

CREATE TABLE messages_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       TEXT,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  read_at         INTEGER,
  edited_at       INTEGER,
  deleted_at      INTEGER
);
INSERT INTO messages_new
  (id, conversation_id, sender_id, client_id, body, created_at, delivered_at, read_at, edited_at, deleted_at)
  SELECT id, conversation_id, sender_id, client_id, body, created_at, delivered_at, read_at, edited_at, deleted_at
  FROM messages;

CREATE TABLE conversation_reads_new (
  conversation_id      INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
INSERT INTO conversation_reads_new (conversation_id, user_id, last_read_message_id)
  SELECT conversation_id, user_id, last_read_message_id FROM conversation_reads;

CREATE TABLE conversation_clears_new (
  conversation_id    INTEGER NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleared_through_id INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
INSERT INTO conversation_clears_new (conversation_id, user_id, cleared_through_id)
  SELECT conversation_id, user_id, cleared_through_id FROM conversation_clears;

CREATE TABLE message_hides_new (
  message_id INTEGER NOT NULL REFERENCES messages_new(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
INSERT INTO message_hides_new (message_id, user_id, hidden_at)
  SELECT message_id, user_id, hidden_at FROM message_hides;

DROP TABLE message_hides;
DROP TABLE conversation_clears;
DROP TABLE conversation_reads;
DROP TABLE messages;
DROP TABLE conversations;

ALTER TABLE conversations_new RENAME TO conversations;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE conversation_reads_new RENAME TO conversation_reads;
ALTER TABLE conversation_clears_new RENAME TO conversation_clears;
ALTER TABLE message_hides_new RENAME TO message_hides;

CREATE INDEX idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE UNIQUE INDEX idx_messages_idem ON messages(conversation_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;
