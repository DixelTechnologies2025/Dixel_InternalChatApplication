CREATE TABLE user_avatars (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
