const express = require('express');
const db = require('../db');
const rt = require('../realtime');
const { workDateAt } = require('../attendance-time');

const router = express.Router();

function attendanceView(row) {
  if (!row) return null;
  return {
    workDate: row.work_date,
    checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at,
  };
}

async function publishUpdate(userId, workDate) {
  await rt.broadcastToAdmins({
    type: 'attendance_updated',
    userId,
    workDate,
  });
}

router.get('/attendance/today', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const workDate = workDateAt(Date.now());
  const row = await db.prepare(`SELECT work_date, check_in_at, check_out_at
    FROM attendance WHERE user_id = ? AND work_date = ?`).get(req.user.id, workDate);
  res.json({ workDate, attendance: attendanceView(row) });
});

router.post('/attendance/check-in', async (req, res) => {
  const now = Date.now();
  const workDate = workDateAt(now);
  const result = await db.transaction(async (tx) => {
    const inserted = await tx.prepare(`INSERT INTO attendance
      (user_id, work_date, check_in_at, check_in_ip)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, work_date) DO NOTHING`)
      .run(req.user.id, workDate, now, req.ip);
    if (!inserted.changes) return false;
    await tx.audit(req.user.id, 'attendance_check_in', `${req.user.id}:${workDate}`, req.ip);
    return true;
  });
  if (!result) return res.status(409).json({ message: 'You have already checked in today.' });
  await publishUpdate(req.user.id, workDate);
  const row = await db.prepare(`SELECT work_date, check_in_at, check_out_at
    FROM attendance WHERE user_id = ? AND work_date = ?`).get(req.user.id, workDate);
  res.status(201).json({ attendance: attendanceView(row) });
});

router.post('/attendance/check-out', async (req, res) => {
  const now = Date.now();
  const workDate = workDateAt(now);
  const result = await db.transaction(async (tx) => {
    const updated = await tx.prepare(`UPDATE attendance
      SET check_out_at = ?, check_out_ip = ?
      WHERE user_id = ? AND work_date = ? AND check_out_at IS NULL`)
      .run(now, req.ip, req.user.id, workDate);
    if (!updated.changes) {
      const current = await tx.prepare(`SELECT check_in_at, check_out_at
        FROM attendance WHERE user_id = ? AND work_date = ?`).get(req.user.id, workDate);
      return { changed: false, checkedIn: !!current, checkedOut: !!(current && current.check_out_at) };
    }
    await tx.audit(req.user.id, 'attendance_check_out', `${req.user.id}:${workDate}`, req.ip);
    return { changed: true };
  });
  if (!result.changed) {
    const message = result.checkedOut
      ? 'You have already checked out today.'
      : 'Check in before checking out.';
    return res.status(409).json({ message });
  }
  await publishUpdate(req.user.id, workDate);
  const row = await db.prepare(`SELECT work_date, check_in_at, check_out_at
    FROM attendance WHERE user_id = ? AND work_date = ?`).get(req.user.id, workDate);
  res.json({ attendance: attendanceView(row) });
});

module.exports = router;
