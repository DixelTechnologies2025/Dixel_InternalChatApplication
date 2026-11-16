const express = require('express');
const db = require('../db');
const { workDateAt, isWorkDate } = require('../attendance-time');

const router = express.Router();
const MAX_RANGE_DAYS = 366;

function dateDistance(from, to) {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000;
}

function requestedRange(query) {
  const today = workDateAt(Date.now());
  if (query.from !== undefined || query.to !== undefined) {
    const from = String(query.from || ''), to = String(query.to || '');
    if (!isWorkDate(from) || !isWorkDate(to) || from > to) {
      return { error: 'Choose a valid date range with From on or before To.' };
    }
    if (dateDistance(from, to) >= MAX_RANGE_DAYS) {
      return { error: `Date ranges must be ${MAX_RANGE_DAYS} days or fewer.` };
    }
    return { from, to };
  }
  const date = query.date === undefined ? today : String(query.date);
  if (!isWorkDate(date)) return { error: 'Choose a valid date.' };
  return { from: date, to: date };
}

function searchValue(query) {
  const search = String(query.search || '').trim();
  return search.length <= 100 ? search : null;
}

function statusFor(row, today) {
  if (!row.checkInAt) return 'Absent';
  if (row.checkOutAt) return 'Present';
  return row.workDate === today && row.userStatus === 'active' ? 'Working' : 'Not checked out';
}

function totalMinutes(row, now) {
  if (!row.checkInAt) return null;
  if (row.checkOutAt) return Math.max(0, Math.floor((row.checkOutAt - row.checkInAt) / 60000));
  if (row.workDate === workDateAt(now) && row.userStatus === 'active') {
    return Math.max(0, Math.floor((now - row.checkInAt) / 60000));
  }
  return null;
}

async function dailyRows(from, to, search, now = Date.now()) {
  const rows = await db.prepare(`WITH RECURSIVE dates(work_date) AS (
      SELECT ?
      UNION ALL SELECT date(work_date, '+1 day') FROM dates WHERE work_date < ?
    )
    SELECT u.id AS user_id, u.full_name, u.employee_id, u.department, u.status AS user_status, d.work_date,
      a.check_in_at, a.check_out_at
    FROM dates d
    CROSS JOIN users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.work_date = d.work_date
    WHERE (u.status = 'active' OR a.id IS NOT NULL)
      AND (? = '' OR u.full_name LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(u.department, '') LIKE '%' || ? || '%' COLLATE NOCASE
        OR COALESCE(u.employee_id, '') LIKE '%' || ? || '%' COLLATE NOCASE)
    ORDER BY u.full_name COLLATE NOCASE, d.work_date`)
    .all(from, to, search, search, search, search);
  const today = workDateAt(now);
  return rows.map((row) => {
    const item = {
      userId: row.user_id,
      fullName: row.full_name,
      employeeId: row.employee_id,
      department: row.department,
      userStatus: row.user_status,
      workDate: row.work_date,
      checkInAt: row.check_in_at,
      checkOutAt: row.check_out_at,
    };
    item.totalMinutes = totalMinutes(item, now);
    item.status = statusFor(item, today);
    return item;
  });
}

function dailySummary(rows) {
  return {
    present: rows.filter((row) => row.checkInAt != null).length,
    notCheckedInYet: rows.filter((row) => row.status === 'Absent').length,
    currentlyWorking: rows.filter((row) => row.status === 'Working').length,
    checkedOut: rows.filter((row) => row.checkOutAt != null).length,
  };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvTime(timestamp) {
  return timestamp == null ? '' : new Date(timestamp).toISOString();
}

function csvHours(minutes) {
  return minutes == null ? '' : (minutes / 60).toFixed(2);
}

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const range = requestedRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const search = searchValue(req.query);
  if (search === null) return res.status(400).json({ message: 'Search must be 100 characters or fewer.' });
  const now = Date.now();
  if (req.query.view === 'monthly') {
    const month = String(req.query.month || workDateAt(now).slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month) || !isWorkDate(`${month}-01`)) {
      return res.status(400).json({ message: 'Choose a valid month.' });
    }
    const from = `${month}-01`;
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
      .toISOString().slice(0, 10);
    const rows = await db.prepare(`SELECT u.id AS user_id, u.full_name, u.employee_id, u.department,
        COUNT(a.check_in_at) AS days_present,
        COALESCE(SUM(CASE
          WHEN a.check_out_at IS NOT NULL THEN a.check_out_at - a.check_in_at
          WHEN a.work_date = ? AND u.status = 'active' THEN ? - a.check_in_at
          ELSE 0 END), 0) AS total_duration_ms
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.work_date BETWEEN ? AND ?
      WHERE (u.status = 'active' OR a.id IS NOT NULL)
        AND (? = '' OR u.full_name LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(u.department, '') LIKE '%' || ? || '%' COLLATE NOCASE
          OR COALESCE(u.employee_id, '') LIKE '%' || ? || '%' COLLATE NOCASE)
      GROUP BY u.id
      ORDER BY u.full_name COLLATE NOCASE`)
      .all(workDateAt(now), now, from, lastDay, search, search, search, search);
    return res.json({
      view: 'monthly',
      month,
      employees: rows.map((row) => ({
        userId: row.user_id,
        fullName: row.full_name,
        employeeId: row.employee_id,
        department: row.department,
        daysPresent: row.days_present,
        totalHours: Math.round(Number(row.total_duration_ms) / 36000) / 100,
      })),
    });
  }
  const rows = await dailyRows(range.from, range.to, search, now);
  res.json({
    view: 'daily',
    from: range.from,
    to: range.to,
    workDate: workDateAt(now),
    summary: range.from === range.to ? dailySummary(rows) : null,
    rows,
  });
});

router.get('/export', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const range = requestedRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const search = searchValue(req.query);
  if (search === null) return res.status(400).json({ message: 'Search must be 100 characters or fewer.' });
  const rows = await dailyRows(range.from, range.to, search, Date.now());
  const headers = ['Employee name', 'Employee ID', 'Department', 'Date', 'Entry time (UTC)', 'Leaving time (UTC)', 'Total hours', 'Status'];
  const lines = [headers, ...rows.map((row) => [
    row.fullName, row.employeeId, row.department, row.workDate,
    csvTime(row.checkInAt), csvTime(row.checkOutAt), csvHours(row.totalMinutes), row.status,
  ])].map((line) => line.map(csvCell).join(','));
  const filename = range.from === range.to
    ? `attendance-${range.from}.csv`
    : `attendance-${range.from}-to-${range.to}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
});

module.exports = router;
