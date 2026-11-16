ALTER TABLE messages ADD COLUMN delivered_at INTEGER;
ALTER TABLE messages ADD COLUMN read_at INTEGER;
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE group_messages ADD COLUMN delivered_at INTEGER;
ALTER TABLE group_messages ADD COLUMN read_at INTEGER;
ALTER TABLE group_messages ADD COLUMN edited_at INTEGER;
ALTER TABLE group_messages ADD COLUMN deleted_at INTEGER;

UPDATE messages
SET read_at = created_at, delivered_at = created_at
WHERE EXISTS (
  SELECT 1 FROM conversation_reads cr
  WHERE cr.conversation_id = messages.conversation_id
    AND cr.user_id != messages.sender_id
    AND messages.id <= cr.last_read_message_id
);

CREATE TABLE message_hides (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE group_message_hides (
  message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE conversation_clears (
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleared_through_id INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE group_clears (
  group_id           INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cleared_through_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE group_message_receipts (
  message_id   INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at INTEGER,
  read_at      INTEGER,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_group_receipts_user ON group_message_receipts(user_id, message_id);
