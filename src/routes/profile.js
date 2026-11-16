const express = require('express');
const db = require('../db');
const rt = require('../realtime');

const router = express.Router();
const MAX_AVATAR_BYTES = 300 * 1024;
const MAX_AVATAR_PREVIEW_AGE = 24 * 60 * 60;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROFILE_FIELDS = new Set(['fullName', 'department']);
const FULL_NAME_RE = /^[\p{L}\p{M} .'-]+$/u;

const parseAvatarBody = express.raw({ type: () => true, limit: MAX_AVATAR_BYTES });

function readAvatar(req, res, next) {
  parseAvatarBody(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ message: 'Profile pictures must be 300 KB or smaller.' });
    }
    return next(error);
  });
}

function signatureMime(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

router.get('/me/profile', (req, res) => {
  res.json({ profile: {
    fullName: req.user.full_name,
    email: req.user.email,
    employeeId: req.user.employee_id,
    department: req.user.department,
    role: req.user.role,
  } });
});

router.patch('/me/profile', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ message: 'Provide profile fields to update.' });
  }
  const supplied = Object.keys(body);
  if (supplied.some((field) => !PROFILE_FIELDS.has(field))) {
    return res.status(400).json({ message: 'Only full name and department can be updated.' });
  }
  if (!supplied.length) return res.status(400).json({ message: 'Provide profile fields to update.' });

  const errors = {};
  let fullName;
  let department;
  if (Object.prototype.hasOwnProperty.call(body, 'fullName')) {
    if (typeof body.fullName !== 'string') {
      errors.fullName = 'Enter a valid full name.';
    } else {
      fullName = body.fullName.trim().normalize('NFC');
      const length = Array.from(fullName).length;
      if (length < 2 || length > 60 || !FULL_NAME_RE.test(fullName)) {
        errors.fullName = 'Use 2 to 60 letters, spaces, dots, hyphens, or apostrophes.';
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'department')) {
    if (body.department === null) {
      department = null;
    } else if (typeof body.department !== 'string') {
      errors.department = 'Enter a valid department.';
    } else {
      department = body.department.trim().normalize('NFC');
      if (Array.from(department).length > 80 || /[<>]/.test(department)) {
        errors.department = 'Department must be 80 characters or fewer and cannot contain HTML.';
      }
      if (!department) department = null;
    }
  }
  if (Object.keys(errors).length) {
    return res.status(400).json({ message: 'Please correct the highlighted fields.', errors });
  }

  const result = await db.transaction(async (tx) => {
    const user = await tx.prepare('SELECT full_name, email, employee_id, department, role, status FROM users WHERE id = ?')
      .get(req.user.id);
    if (!user || user.status !== 'active') return { inactive: true };

    const changedFields = [];
    if (fullName !== undefined && fullName !== user.full_name) changedFields.push('fullName');
    if (department !== undefined && department !== user.department) changedFields.push('department');
    if (changedFields.length) {
      const assignments = [];
      const values = [];
      if (changedFields.includes('fullName')) {
        assignments.push('full_name = ?');
        values.push(fullName);
      }
      if (changedFields.includes('department')) {
        assignments.push('department = ?');
        values.push(department);
      }
      values.push(req.user.id);
      const update = await tx.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ? AND status = 'active'`)
        .run(...values);
      if (!update.changes) return { inactive: true };
      const auditFields = changedFields.map((field) => field === 'fullName' ? 'full_name' : field);
      await tx.audit(req.user.id, 'profile_update', auditFields.join(','), req.ip);
    }
    return {
      profile: {
        fullName: changedFields.includes('fullName') ? fullName : user.full_name,
        email: user.email,
        employeeId: user.employee_id,
        department: changedFields.includes('department') ? department : user.department,
        role: user.role,
      },
      changedFields,
    };
  });
  if (result.inactive) return res.status(401).json({ message: 'Sign in to continue.' });
  if (result.changedFields.length) {
    rt.broadcast({
      type: 'user_profile_updated',
      userId: req.user.id,
      fullName: result.profile.fullName,
      department: result.profile.department,
    });
  }
  res.json({ ok: true, ...result });
});

router.post('/me/avatar', readAvatar, async (req, res) => {
  const mime = req.get('Content-Type');
  if (!ALLOWED_MIME.has(mime)) {
    return res.status(415).json({ message: 'Choose a JPEG, PNG, or WebP image.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ message: 'Choose an image to upload.' });
  }
  if (req.body.length > MAX_AVATAR_BYTES) {
    return res.status(413).json({ message: 'Profile pictures must be 300 KB or smaller.' });
  }
  if (signatureMime(req.body) !== mime) {
    return res.status(415).json({ message: 'The image content does not match its file type.' });
  }

  const avatarVersion = await db.transaction(async (tx) => {
    const previous = await tx.prepare('SELECT updated_at FROM user_avatars WHERE user_id = ?').get(req.user.id);
    const version = Math.max(Date.now(), (previous ? previous.updated_at : 0) + 1);
    await tx.prepare(`INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
      .run(req.user.id, mime, new Uint8Array(req.body), version);
    await tx.audit(req.user.id, 'avatar_uploaded', req.user.id, req.ip);
    return version;
  });
  rt.broadcast({ type: 'user_avatar_updated', userId: req.user.id, avatarVersion });
  res.json({ ok: true, avatarVersion });
});

router.delete('/me/avatar', async (req, res) => {
  const removed = await db.transaction(async (tx) => {
    const result = await tx.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(req.user.id);
    if (result.changes) await tx.audit(req.user.id, 'avatar_removed', req.user.id, req.ip);
    return result.changes;
  });
  if (removed) {
    rt.broadcast({ type: 'user_avatar_updated', userId: req.user.id, avatarVersion: null });
  }
  res.json({ ok: true, avatarVersion: null });
});

router.get('/users/:id/avatar', async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(404).json({ message: 'Profile picture not found.' });
  }
  const row = await db.prepare(`SELECT a.mime, a.data, a.updated_at FROM user_avatars a
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE a.user_id = ?`).get(userId);
  if (!row) return res.status(404).json({ message: 'Profile picture not found.' });

  const etag = `"avatar-${userId}-${row.updated_at}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', `private, max-age=${MAX_AVATAR_PREVIEW_AGE}, must-revalidate`);
  res.type(row.mime);
  const ifNoneMatch = req.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === '*' || candidate === etag || candidate === `W/${etag}`;
  })) return res.status(304).end();
  res.status(200).send(Buffer.from(row.data));
});

module.exports = router;
