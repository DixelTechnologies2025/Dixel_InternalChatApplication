-- Backfill every active global administrator into every existing group.
-- The unique key on group_members makes this safe to run repeatedly.

-- 1) Audit entry first (counts admins who are not yet in a group)
INSERT INTO audit_events (actor_id, action, target, ip, created_at)
SELECT NULL, 'admin_group_auto_join', CAST(c AS TEXT), NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (
  SELECT COUNT(*) AS c
  FROM groups g
  CROSS JOIN users u
  WHERE u.role = 'admin' AND u.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = g.id AND gm.user_id = u.id
    )
)
WHERE c > 0;

-- 2) Add the admins to all groups
INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
SELECT g.id, u.id, 'admin', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM groups g
CROSS JOIN users u
WHERE u.role = 'admin' AND u.status = 'active';