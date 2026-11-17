-- Backfill every active global administrator into every existing group.
-- The unique key on group_members makes this safe to run repeatedly.
CREATE TEMP TABLE _admin_group_backfill AS
SELECT g.id AS group_id, u.id AS user_id,
  CASE WHEN gm.group_id IS NULL THEN 1 ELSE 0 END AS was_added
FROM groups g
CROSS JOIN users u
LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = u.id
WHERE u.role = 'admin' AND u.status = 'active';

INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
SELECT group_id, user_id, 'admin', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM _admin_group_backfill;

INSERT INTO audit_events (actor_id, action, target, ip, created_at)
SELECT NULL, 'admin_group_auto_join', CAST(COUNT(*) AS TEXT), NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM _admin_group_backfill
WHERE was_added = 1
HAVING COUNT(*) > 0;

DROP TABLE _admin_group_backfill;
