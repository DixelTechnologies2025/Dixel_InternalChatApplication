CREATE TABLE attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date     TEXT NOT NULL,
  check_in_at   INTEGER NOT NULL,
  check_out_at  INTEGER,
  check_in_ip   TEXT NOT NULL,
  check_out_ip  TEXT,
  UNIQUE (user_id, work_date)
);
CREATE INDEX idx_attendance_work_date ON attendance(work_date);
CREATE INDEX idx_attendance_user ON attendance(user_id);
