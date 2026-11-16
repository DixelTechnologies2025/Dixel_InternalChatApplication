CREATE TABLE groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('admin','member')),
  joined_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id, group_id);

CREATE TABLE group_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_group_messages_group ON group_messages(group_id, id);
CREATE INDEX idx_group_messages_created ON group_messages(created_at);

CREATE TABLE group_reads (
  group_id              INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);
