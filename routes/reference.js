// Areas and categories: everyone can read them (the sign-up form needs areas);
// only administrators can change them.
const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');

const router = express.Router();

function readName(body, max) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim() || null;
  if (name.length < 2 || name.length > max) return { error: `The name must be 2–${max} characters.` };
  if (description && description.length > 255) return { error: 'The description must be 255 characters or fewer.' };
  return { name, description };
}

// ---------------------------------------------------------------- areas
router.get('/areas', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT a.id, a.name, a.description,
           (SELECT COUNT(*) FROM issues i WHERE i.area_id = a.id) AS issue_count,
           (SELECT COUNT(*) FROM leader_areas la WHERE la.area_id = a.id) AS leader_count
    FROM areas a ORDER BY a.name`);
  res.json(rows);
});

router.post('/areas', requireRole('admin'), async (req, res) => {
  const d = readName(req.body, 100);
  if (d.error) return res.status(400).json({ error: d.error });
  try {
    const [r] = await pool.query('INSERT INTO areas (name, description) VALUES (?, ?)', [d.name, d.description]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An area with this name already exists.' });
    throw err;
  }
});

router.put('/areas/:id', requireRole('admin'), async (req, res) => {
  const d = readName(req.body, 100);
  if (d.error) return res.status(400).json({ error: d.error });
  try {
    const [r] = await pool.query('UPDATE areas SET name = ?, description = ? WHERE id = ?', [d.name, d.description, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Area not found.' });
    res.json({ id: Number(req.params.id) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An area with this name already exists.' });
    throw err;
  }
});

// fk_issues_area is ON DELETE RESTRICT: an area with issues can't be deleted.
router.delete('/areas/:id', requireRole('admin'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM areas WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Area not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'Issues have been reported in this area, so it cannot be deleted. You can rename it instead.' });
    }
    throw err;
  }
});

// ---------------------------------------------------------------- categories
// ?all=1 includes inactive categories (for the admin screen).
router.get('/categories', async (req, res) => {
  const all = req.query.all === '1';
  const [rows] = await pool.query(`
    SELECT c.id, c.name, c.description, c.is_active,
           (SELECT COUNT(*) FROM issues i WHERE i.category_id = c.id) AS issue_count
    FROM categories c ${all ? '' : 'WHERE c.is_active'} ORDER BY c.name = 'Other', c.name`);
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active })));
});

router.post('/categories', requireRole('admin'), async (req, res) => {
  const d = readName(req.body, 60);
  if (d.error) return res.status(400).json({ error: d.error });
  try {
    const [r] = await pool.query('INSERT INTO categories (name, description) VALUES (?, ?)', [d.name, d.description]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A category with this name already exists.' });
    throw err;
  }
});

router.put('/categories/:id', requireRole('admin'), async (req, res) => {
  const d = readName(req.body, 60);
  if (d.error) return res.status(400).json({ error: d.error });
  const isActive = req.body.isActive === undefined ? true : !!req.body.isActive;
  try {
    const [r] = await pool.query('UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?',
      [d.name, d.description, isActive, req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Category not found.' });
    res.json({ id: Number(req.params.id) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A category with this name already exists.' });
    throw err;
  }
});

// fk_issues_category is ON DELETE RESTRICT: a used category can only be deactivated.
router.delete('/categories/:id', requireRole('admin'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Category not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'Issues use this category, so it cannot be deleted. Deactivate it instead.' });
    }
    throw err;
  }
});

module.exports = router;
