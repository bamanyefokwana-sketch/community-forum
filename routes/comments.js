const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');

const router = express.Router();
router.use(requireLogin);

async function findComment(req, res) {
  const [[comment]] = await pool.query('SELECT * FROM comments WHERE id = ?', [req.params.id]);
  if (!comment) res.status(404).json({ error: 'Comment not found.' });
  return comment;
}

// Authors can edit their own comments.
router.put('/:id', async (req, res) => {
  const comment = await findComment(req, res);
  if (!comment) return;
  if (comment.author_id !== req.session.user.id) return res.status(403).json({ error: 'You can only edit your own comments.' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'A comment cannot be empty.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Comments must be 2000 characters or fewer.' });
  await pool.query('UPDATE comments SET body = ?, edited_at = NOW() WHERE id = ?', [body, comment.id]);
  res.json({ id: comment.id });
});

// Authors can delete their own comments; leaders and admins can remove any (moderation).
router.delete('/:id', async (req, res) => {
  const comment = await findComment(req, res);
  if (!comment) return;
  const user = req.session.user;
  if (comment.author_id !== user.id && !['leader', 'admin'].includes(user.role)) {
    return res.status(403).json({ error: 'You can only delete your own comments.' });
  }
  await pool.query('DELETE FROM comments WHERE id = ?', [comment.id]);
  res.status(204).end();
});

module.exports = router;
