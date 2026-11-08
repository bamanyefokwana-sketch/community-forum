const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const {
  STATUSES, OPEN_STATUSES, PRIORITIES, TRANSITIONS,
  canTransition, resolvedAtFor, canManageArea, readPhotos, savePhotos, readIssueFields,
} = require('../lib/issues');

const router = express.Router();
router.use(requireLogin);

const PAGE_SIZE = 20;
const SORTS = {
  new: 'i.created_at DESC',
  oldest: 'i.created_at ASC',
  updated: 'i.updated_at DESC',
  votes: 'votes DESC, i.created_at DESC',
  priority: "FIELD(i.priority, 'urgent', 'high', 'medium', 'low'), i.created_at ASC",
};

// Loads one issue (without photos, updates or comments), or sends 404.
async function findIssue(req, res, conn = pool) {
  const [[issue]] = await conn.query('SELECT * FROM issues WHERE id = ?', [req.params.id]);
  if (!issue) res.status(404).json({ error: 'Issue not found.' });
  return issue;
}

// Runs fn inside a transaction on one connection.
async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------- list
// Filters: status (a status or "open"), categoryId, areaId, search, mine=1,
// assigned=me, myAreas=1 (leaders). sort: new | oldest | updated | votes | priority. page.
router.get('/', async (req, res) => {
  const user = req.session.user;
  const where = [];
  const params = [user.id];
  const q = req.query;

  if (q.status === 'open') where.push(`i.status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`), params.push(...OPEN_STATUSES);
  else if (STATUSES.includes(q.status)) where.push('i.status = ?'), params.push(q.status);
  if (q.categoryId) where.push('i.category_id = ?'), params.push(q.categoryId);
  if (q.areaId) where.push('i.area_id = ?'), params.push(q.areaId);
  if (q.mine === '1') where.push('i.reporter_id = ?'), params.push(user.id);
  if (q.assigned === 'me') where.push('i.assigned_to = ?'), params.push(user.id);
  if (q.myAreas === '1') where.push('i.area_id IN (SELECT area_id FROM leader_areas WHERE leader_id = ?)'), params.push(user.id);
  if (q.search) {
    where.push('(i.title LIKE ? OR i.description LIKE ? OR i.location LIKE ?)');
    const like = `%${String(q.search).slice(0, 100)}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[q.sort] || SORTS.new;
  const page = Math.max(1, Number(q.page) || 1);

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM issues i ${whereSql}`, params.slice(1));
  const [rows] = await pool.query(`
    SELECT i.id, i.title, i.status, i.priority, i.location, i.created_at, i.updated_at,
           i.category_id, c.name AS category, i.area_id, a.name AS area,
           i.reporter_id, r.full_name AS reporter_name, i.assigned_to, al.full_name AS assigned_name,
           (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id) AS votes,
           (SELECT COUNT(*) FROM comments cm WHERE cm.issue_id = i.id) AS comment_count,
           (SELECT MIN(p.id) FROM issue_photos p WHERE p.issue_id = i.id) AS first_photo_id,
           EXISTS (SELECT 1 FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = ?) AS has_voted
    FROM issues i
    JOIN categories c ON c.id = i.category_id
    JOIN areas a ON a.id = i.area_id
    LEFT JOIN users r ON r.id = i.reporter_id
    LEFT JOIN users al ON al.id = i.assigned_to
    ${whereSql}
    ORDER BY ${order}
    LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE]);

  res.json({
    issues: rows.map((r) => ({ ...r, has_voted: !!r.has_voted })),
    page, pageSize: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

// ---------------------------------------------------------------- detail
router.get('/:id', async (req, res) => {
  const user = req.session.user;
  const [[issue]] = await pool.query(`
    SELECT i.*, c.name AS category, a.name AS area,
           r.full_name AS reporter_name, al.full_name AS assigned_name,
           (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id) AS votes,
           EXISTS (SELECT 1 FROM issue_votes v WHERE v.issue_id = i.id AND v.user_id = ?) AS has_voted
    FROM issues i
    JOIN categories c ON c.id = i.category_id
    JOIN areas a ON a.id = i.area_id
    LEFT JOIN users r ON r.id = i.reporter_id
    LEFT JOIN users al ON al.id = i.assigned_to
    WHERE i.id = ?`, [user.id, req.params.id]);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });

  const [photos] = await pool.query(
    'SELECT id, file_name, mime_type, size_bytes, uploaded_at FROM issue_photos WHERE issue_id = ? ORDER BY id', [issue.id]);
  const [updates] = await pool.query(`
    SELECT u.id, u.old_status, u.new_status, u.message, u.created_at, u.author_id,
           au.full_name AS author_name, au.role AS author_role
    FROM issue_updates u LEFT JOIN users au ON au.id = u.author_id
    WHERE u.issue_id = ? ORDER BY u.created_at, u.id`, [issue.id]);
  const [comments] = await pool.query(`
    SELECT cm.id, cm.body, cm.created_at, cm.edited_at, cm.author_id,
           au.full_name AS author_name, au.role AS author_role
    FROM comments cm LEFT JOIN users au ON au.id = cm.author_id
    WHERE cm.issue_id = ? ORDER BY cm.created_at, cm.id`, [issue.id]);

  const canManage = await canManageArea(user, issue.area_id);
  const isReporter = issue.reporter_id === user.id;
  let leaders = [];
  if (canManage) {
    // People who can be assigned: leaders of this area and administrators.
    [leaders] = await pool.query(`
      SELECT u.id, u.full_name, u.role FROM users u
      WHERE u.is_active AND (u.role = 'admin'
        OR (u.role = 'leader' AND EXISTS (SELECT 1 FROM leader_areas la WHERE la.leader_id = u.id AND la.area_id = ?)))
      ORDER BY u.role = 'admin', u.full_name`, [issue.area_id]);
  }

  res.json({
    ...issue,
    has_voted: !!issue.has_voted,
    photos, updates, comments, leaders,
    permissions: {
      edit: isReporter && issue.status === 'reported',
      delete: (isReporter && issue.status === 'reported') || user.role === 'admin',
      manage: canManage,
      confirm: isReporter && issue.status === 'resolved',
      vote: !isReporter,
      moderate: user.role === 'leader' || user.role === 'admin',
      nextStatuses: canManage ? TRANSITIONS[issue.status] : [],
    },
  });
});

// ---------------------------------------------------------------- report / edit / delete
router.post('/', async (req, res) => {
  const fields = await readIssueFields(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  const { photos, error } = readPhotos(req.body.photos);
  if (error) return res.status(400).json({ error });

  const id = await inTransaction(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO issues (reporter_id, category_id, area_id, title, description, location)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.user.id, fields.categoryId, fields.areaId, fields.title, fields.description, fields.location]);
    await savePhotos(conn, r.insertId, photos);
    // First entry in the progress timeline.
    await conn.query("INSERT INTO issue_updates (issue_id, author_id, old_status, new_status) VALUES (?, ?, NULL, 'reported')",
      [r.insertId, req.session.user.id]);
    return r.insertId;
  });
  res.status(201).json({ id });
});

// The reporter can edit their issue until a leader has acted on it.
router.put('/:id', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  if (issue.reporter_id !== req.session.user.id) return res.status(403).json({ error: 'Only the person who reported this issue can edit it.' });
  if (issue.status !== 'reported') return res.status(409).json({ error: 'A leader has already responded, so this issue can no longer be edited. Add a comment instead.' });
  const fields = await readIssueFields(req.body);
  if (fields.error) return res.status(400).json({ error: fields.error });
  await pool.query('UPDATE issues SET title = ?, description = ?, location = ?, category_id = ?, area_id = ? WHERE id = ?',
    [fields.title, fields.description, fields.location, fields.categoryId, fields.areaId, issue.id]);
  res.json({ id: issue.id });
});

// The reporter can withdraw an issue until a leader acts on it; an admin can delete any issue.
router.delete('/:id', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  const isReporter = issue.reporter_id === req.session.user.id;
  if (!(req.session.user.role === 'admin' || (isReporter && issue.status === 'reported'))) {
    return res.status(403).json({ error: 'Only the reporter (before a leader responds) or an administrator can delete this issue.' });
  }
  await pool.query('DELETE FROM issues WHERE id = ?', [issue.id]);
  res.status(204).end();
});

// ---------------------------------------------------------------- photos
router.get('/:id/photos/:photoId', async (req, res) => {
  const [[photo]] = await pool.query(
    'SELECT mime_type, data FROM issue_photos WHERE id = ? AND issue_id = ?', [req.params.photoId, req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(photo.mime_type).send(photo.data);
});

router.post('/:id/photos', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  if (issue.reporter_id !== req.session.user.id || issue.status !== 'reported') {
    return res.status(403).json({ error: 'Photos can only be added by the reporter before a leader responds.' });
  }
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM issue_photos WHERE issue_id = ?', [issue.id]);
  const { photos, error } = readPhotos(req.body.photos, n);
  if (error) return res.status(400).json({ error });
  await savePhotos(pool, issue.id, photos);
  res.status(201).json({ added: photos.length });
});

router.delete('/:id/photos/:photoId', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  const allowed = req.session.user.role === 'admin' || (issue.reporter_id === req.session.user.id && issue.status === 'reported');
  if (!allowed) return res.status(403).json({ error: 'You cannot remove this photo.' });
  const [r] = await pool.query('DELETE FROM issue_photos WHERE id = ? AND issue_id = ?', [req.params.photoId, issue.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Photo not found.' });
  res.status(204).end();
});

// ---------------------------------------------------------------- leader updates
// Body: { status?, message?, priority?, assignedTo? }. Every change is recorded in the timeline.
router.post('/:id/updates', async (req, res) => {
  const user = req.session.user;
  const result = await inTransaction(async (conn) => {
    const [[issue]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!issue) return { status: 404, error: 'Issue not found.' };
    if (!await canManageArea(user, issue.area_id, conn)) {
      return { status: 403, error: 'Only leaders of this area or an administrator can update this issue.' };
    }

    const notes = [];
    const message = String(req.body.message || '').trim();
    if (message.length > 2000) return { status: 400, error: 'The message must be 2000 characters or fewer.' };

    let newStatus = issue.status;
    if (req.body.status && req.body.status !== issue.status) {
      if (!canTransition(issue.status, req.body.status)) {
        return { status: 400, error: `An issue that is "${issue.status.replace('_', ' ')}" cannot be changed to "${String(req.body.status).replace('_', ' ')}".` };
      }
      if (req.body.status === 'rejected' && !message) return { status: 400, error: 'Explain why the issue is being rejected.' };
      newStatus = req.body.status;
    }

    let priority = issue.priority;
    if (req.body.priority && req.body.priority !== issue.priority) {
      if (!PRIORITIES.includes(req.body.priority)) return { status: 400, error: 'Unknown priority.' };
      priority = req.body.priority;
      notes.push(`Priority set to ${priority}.`);
    }

    let assignedTo = issue.assigned_to;
    if (req.body.assignedTo !== undefined && Number(req.body.assignedTo || 0) !== Number(issue.assigned_to || 0)) {
      if (!req.body.assignedTo) {
        assignedTo = null;
        notes.push('Unassigned.');
      } else {
        const [[person]] = await conn.query('SELECT id, full_name, role, is_active FROM users WHERE id = ?', [req.body.assignedTo]);
        const eligible = person && person.is_active && await canManageArea(person, issue.area_id, conn);
        if (!eligible) return { status: 400, error: 'Issues can only be assigned to a leader of this area or an administrator.' };
        assignedTo = person.id;
        notes.push(`Assigned to ${person.full_name}.`);
      }
    }

    const fullMessage = [message, ...notes].filter(Boolean).join(' ') || null;
    if (newStatus === issue.status && !fullMessage) return { status: 400, error: 'Nothing to update.' };

    await conn.query('UPDATE issues SET status = ?, priority = ?, assigned_to = ?, resolved_at = ? WHERE id = ?',
      [newStatus, priority, assignedTo, resolvedAtFor(newStatus, issue.resolved_at), issue.id]);
    await conn.query('INSERT INTO issue_updates (issue_id, author_id, old_status, new_status, message) VALUES (?, ?, ?, ?, ?)',
      [issue.id, user.id, issue.status, newStatus, fullMessage]);
    return { status: 201, body: { status: newStatus } };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.body);
});

// The reporter confirms a resolved issue is fixed (-> closed) or says it isn't (-> in_progress).
// Body: { fixed: true|false, message }
router.post('/:id/confirm', async (req, res) => {
  const user = req.session.user;
  const result = await inTransaction(async (conn) => {
    const [[issue]] = await conn.query('SELECT * FROM issues WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!issue) return { status: 404, error: 'Issue not found.' };
    if (issue.reporter_id !== user.id) return { status: 403, error: 'Only the person who reported this issue can confirm it.' };
    if (issue.status !== 'resolved') return { status: 409, error: 'Only a resolved issue can be confirmed.' };
    const fixed = !!req.body.fixed;
    const message = String(req.body.message || '').trim().slice(0, 2000) || null;
    if (!fixed && !message) return { status: 400, error: 'Tell the leaders what is still wrong.' };
    const newStatus = fixed ? 'closed' : 'in_progress';
    await conn.query('UPDATE issues SET status = ?, resolved_at = ? WHERE id = ?',
      [newStatus, resolvedAtFor(newStatus, issue.resolved_at), issue.id]);
    await conn.query('INSERT INTO issue_updates (issue_id, author_id, old_status, new_status, message) VALUES (?, ?, ?, ?, ?)',
      [issue.id, user.id, issue.status, newStatus, message || 'Reporter confirmed the issue is fixed.']);
    return { status: 201, body: { status: newStatus } };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.body);
});

// ---------------------------------------------------------------- votes
router.post('/:id/vote', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  if (issue.reporter_id === req.session.user.id) return res.status(400).json({ error: 'You reported this issue, so it already counts for you.' });
  await pool.query('INSERT IGNORE INTO issue_votes (issue_id, user_id) VALUES (?, ?)', [issue.id, req.session.user.id]);
  const [[{ votes }]] = await pool.query('SELECT COUNT(*) AS votes FROM issue_votes WHERE issue_id = ?', [issue.id]);
  res.json({ votes, has_voted: true });
});

router.delete('/:id/vote', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  await pool.query('DELETE FROM issue_votes WHERE issue_id = ? AND user_id = ?', [issue.id, req.session.user.id]);
  const [[{ votes }]] = await pool.query('SELECT COUNT(*) AS votes FROM issue_votes WHERE issue_id = ?', [issue.id]);
  res.json({ votes, has_voted: false });
});

// ---------------------------------------------------------------- comments
router.post('/:id/comments', async (req, res) => {
  const issue = await findIssue(req, res);
  if (!issue) return;
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a comment first.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Comments must be 2000 characters or fewer.' });
  const [r] = await pool.query('INSERT INTO comments (issue_id, author_id, body) VALUES (?, ?, ?)',
    [issue.id, req.session.user.id, body]);
  res.status(201).json({ id: r.insertId });
});

module.exports = router;
