const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireSession, requireLogin } = require('../lib/middleware');
const { readNameAndEmail, toSessionUser } = require('../lib/accounts');

const router = express.Router();

// Starts a fresh session for the user (prevents session fixation).
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = user;
      resolve();
    });
  });
}

// An optional home area; returns the area id, null, or undefined if it doesn't exist.
async function readArea(areaId) {
  if (areaId === '' || areaId == null) return null;
  const [[area]] = await pool.query('SELECT id FROM areas WHERE id = ?', [areaId]);
  return area ? area.id : undefined;
}

// Community members sign up themselves. Leaders are promoted by an administrator.
router.post('/register', async (req, res) => {
  const details = readNameAndEmail(req.body);
  if (details.error) return res.status(400).json({ error: details.error });
  if (!req.body.password || req.body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const areaId = await readArea(req.body.areaId);
  if (areaId === undefined) return res.status(400).json({ error: 'Choose a valid area.' });

  const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [details.email]);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const hash = await bcrypt.hash(req.body.password, 10);
  const [result] = await pool.query(
    "INSERT INTO users (full_name, email, password_hash, role, area_id) VALUES (?, ?, ?, 'member', ?)",
    [details.fullName, details.email, hash, areaId]);
  const user = toSessionUser({ id: result.insertId, full_name: details.fullName, email: details.email, role: 'member', area_id: areaId });
  await logIn(req, user);
  res.status(201).json(user);
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const [[row]] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const ok = row && await bcrypt.compare(String(req.body.password || ''), row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
  if (!row.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact the administrator.' });

  const user = toSessionUser(row);
  await logIn(req, user);
  res.json(user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

// The logged-in user; leaders also get the areas they look after.
router.get('/me', requireSession, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'leader') return res.json(user);
  const [areas] = await pool.query(`
    SELECT a.id, a.name FROM leader_areas la JOIN areas a ON a.id = la.area_id
    WHERE la.leader_id = ? ORDER BY a.name`, [user.id]);
  res.json({ ...user, leaderAreas: areas });
});

async function passwordMatches(userId, password) {
  const [[row]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return !!row && bcrypt.compare(String(password || ''), row.password_hash);
}

// Update own name, email and home area.
router.put('/me', requireLogin, async (req, res) => {
  const details = readNameAndEmail(req.body);
  if (details.error) return res.status(400).json({ error: details.error });
  const areaId = await readArea(req.body.areaId);
  if (areaId === undefined) return res.status(400).json({ error: 'Choose a valid area.' });
  try {
    await pool.query('UPDATE users SET full_name = ?, email = ?, area_id = ? WHERE id = ?',
      [details.fullName, details.email, areaId, req.session.user.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Another account already uses this email.' });
    throw err;
  }
  req.session.user = { ...req.session.user, ...details, areaId };
  res.json(req.session.user);
});

// Change password. Also how someone replaces a temporary password, so it only needs a session.
router.put('/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!await passwordMatches(req.session.user.id, currentPassword)) {
    return res.status(403).json({ error: 'Your current password is wrong.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'Choose a password that is different from the current one.' });
  }
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?',
    [await bcrypt.hash(newPassword, 10), req.session.user.id]);
  req.session.user = { ...req.session.user, mustChangePassword: false };
  res.json(req.session.user);
});

// Delete own account. Issues, comments and updates stay for the community's records
// (their author becomes NULL, shown as "former member"); votes are removed.
router.delete('/me', requireLogin, async (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.status(403).json({ error: 'Administrators cannot delete their own account. Ask another administrator.' });
  }
  if (!await passwordMatches(req.session.user.id, req.body.password)) {
    return res.status(403).json({ error: 'Your password is wrong.' });
  }
  await pool.query('DELETE FROM users WHERE id = ?', [req.session.user.id]);
  req.session.destroy(() => res.status(204).end());
});

module.exports = router;
