CREATE TABLE direct_message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_direct_reactions_message ON direct_message_reactions(message_id);
CREATE INDEX idx_direct_reactions_user ON direct_message_reactions(user_id, message_id);

CREATE TABLE group_message_reactions (
  message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_group_reactions_message ON group_message_reactions(message_id);
CREATE INDEX idx_group_reactions_user ON group_message_reactions(user_id, message_id);
