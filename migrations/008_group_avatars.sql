ALTER TABLE groups ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE group_avatars (
  group_id   INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
