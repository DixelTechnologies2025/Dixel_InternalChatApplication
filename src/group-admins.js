const db = require('./db');

// Returns the memberships created by this repair so callers can publish the
// existing group realtime event to the affected groups.
async function ensureAdminsInAllGroups() {
  const added = await db.transaction(async (tx) => {
    const admins = await tx.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
    const groups = await tx.prepare('SELECT id FROM groups').all();
    const insert = tx.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
      VALUES (?, ?, 'admin', ?)`);
    const now = Date.now();
    const changes = [];
    for (const group of groups) {
      for (const admin of admins) {
        if ((await insert.run(group.id, admin.id, now)).changes) changes.push({ groupId: group.id, userId: admin.id });
      }
    }
    if (changes.length) await tx.audit(null, 'admin_group_auto_join', changes.length);
    return changes;
  });
  return added;
}

module.exports = { ensureAdminsInAllGroups };
