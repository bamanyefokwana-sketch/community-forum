// Administration of user accounts: roles, leader areas, deactivation, password resets.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');
const { ROLES, makeTempPassword } = require('../lib/accounts');

const router = express.Router();
router.use(requireRole('admin'));

async function findUser(req, res) {
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) res.status(404).json({ error: 'User not found.' });
  return user;
}

// ?search= (name or email), ?role=
router.get('/users', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ?)');
    const like = `%${String(req.query.search).slice(0, 100)}%`;
    params.push(like, like);
  }
  if (ROLES.includes(req.query.role)) where.push('u.role = ?'), params.push(req.query.role);
  const [rows] = await pool.query(`
    SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.must_change_password, u.created_at,
           u.area_id, a.name AS area,
           (SELECT COUNT(*) FROM issues i WHERE i.reporter_id = u.id) AS issues_reported,
           (SELECT GROUP_CONCAT(la.area_id ORDER BY la.area_id) FROM leader_areas la WHERE la.leader_id = u.id) AS leader_area_ids
    FROM users u LEFT JOIN areas a ON a.id = u.area_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY FIELD(u.role, 'admin', 'leader', 'member'), u.full_name
    LIMIT 500`, params);
  res.json(rows.map((r) => ({
    ...r,
    is_active: !!r.is_active,
    must_change_password: !!r.must_change_password,
    leader_area_ids: r.leader_area_ids ? r.leader_area_ids.split(',').map(Number) : [],
  })));
});

// Change role and/or active state. Body: { role?, isActive? }
router.patch('/users/:id', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  if (user.id === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role or deactivate yourself.' });
  }
  const role = req.body.role ?? user.role;
  const isActive = req.body.isActive ?? !!user.is_active;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE users SET role = ?, is_active = ? WHERE id = ?', [role, !!isActive, user.id]);
    // Someone who is no longer a leader has no areas to look after.
    if (role !== 'leader') await conn.query('DELETE FROM leader_areas WHERE leader_id = ?', [user.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ id: user.id, role, is_active: !!isActive });
});

// Set the areas a leader is responsible for. Body: { areaIds: [] }
router.put('/users/:id/areas', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') return res.status(400).json({ error: 'Only leaders are assigned to areas. Make this user a leader first.' });
  const areaIds = [...new Set((req.body.areaIds || []).map(Number).filter(Boolean))];
  if (areaIds.length) {
    const [found] = await pool.query('SELECT id FROM areas WHERE id IN (?)', [areaIds]);
    if (found.length !== areaIds.length) return res.status(400).json({ error: 'One of the areas does not exist.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM leader_areas WHERE leader_id = ?', [user.id]);
    for (const areaId of areaIds) {
      await conn.query('INSERT INTO leader_areas (leader_id, area_id) VALUES (?, ?)', [user.id, areaId]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ id: user.id, areaIds });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  const tempPassword = makeTempPassword();
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?',
    [await bcrypt.hash(tempPassword, 10), user.id]);
  res.json({ tempPassword });
});

// Deleting a user keeps their issues, comments and updates (author becomes NULL).
router.delete('/users/:id', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  if (user.id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });
  await pool.query('DELETE FROM users WHERE id = ?', [user.id]);
  res.status(204).end();
});

module.exports = router;
