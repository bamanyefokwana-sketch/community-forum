// Dashboard figures for leaders and administrators.
// ?scope=mine limits a leader's figures to the areas they look after.
const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');

const router = express.Router();

router.get('/', requireRole('leader', 'admin'), async (req, res) => {
  const user = req.session.user;
  const mine = req.query.scope === 'mine';
  const scope = mine ? 'WHERE i.area_id IN (SELECT area_id FROM leader_areas WHERE leader_id = ?)' : '';
  const scopeAnd = mine ? 'AND i.area_id IN (SELECT area_id FROM leader_areas WHERE leader_id = ?)' : '';
  const p = mine ? [user.id] : [];

  const [byStatus] = await pool.query(`SELECT i.status, COUNT(*) AS n FROM issues i ${scope} GROUP BY i.status`, p);
  const [byCategory] = await pool.query(`
    SELECT c.name, COUNT(i.id) AS total,
           SUM(i.status IN ('reported', 'acknowledged', 'in_progress')) AS open
    FROM issues i JOIN categories c ON c.id = i.category_id ${scope}
    GROUP BY c.id, c.name ORDER BY total DESC`, p);
  const [byArea] = await pool.query(`
    SELECT a.name, COUNT(i.id) AS total,
           SUM(i.status IN ('reported', 'acknowledged', 'in_progress')) AS open
    FROM issues i JOIN areas a ON a.id = i.area_id ${scope}
    GROUP BY a.id, a.name ORDER BY open DESC, total DESC`, p);
  const [[resolution]] = await pool.query(`
    SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, i.created_at, i.resolved_at)) / 24, 1) AS avg_days,
           COUNT(i.resolved_at) AS resolved_count
    FROM issues i WHERE i.resolved_at IS NOT NULL ${scopeAnd}`, p);
  const [[{ unassigned }]] = await pool.query(`
    SELECT COUNT(*) AS unassigned FROM issues i
    WHERE i.assigned_to IS NULL AND i.status IN ('reported', 'acknowledged', 'in_progress') ${scopeAnd}`, p);
  const [oldestOpen] = await pool.query(`
    SELECT i.id, i.title, i.status, i.priority, i.created_at, a.name AS area,
           (SELECT COUNT(*) FROM issue_votes v WHERE v.issue_id = i.id) AS votes
    FROM issues i JOIN areas a ON a.id = i.area_id
    WHERE i.status IN ('reported', 'acknowledged', 'in_progress') ${scopeAnd}
    ORDER BY i.created_at ASC LIMIT 5`, p);
  const [mostVoted] = await pool.query(`
    SELECT i.id, i.title, i.status, a.name AS area, COUNT(v.id) AS votes
    FROM issues i JOIN areas a ON a.id = i.area_id JOIN issue_votes v ON v.issue_id = i.id
    WHERE i.status IN ('reported', 'acknowledged', 'in_progress') ${scopeAnd}
    GROUP BY i.id, i.title, i.status, a.name ORDER BY votes DESC LIMIT 5`, p);

  const status = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  res.json({
    scope: mine ? 'mine' : 'all',
    totals: {
      all: byStatus.reduce((s, r) => s + r.n, 0),
      open: (status.reported || 0) + (status.acknowledged || 0) + (status.in_progress || 0),
      unassigned,
      resolvedCount: resolution.resolved_count,
      avgDaysToResolve: resolution.avg_days,
    },
    byStatus: status, byCategory, byArea, oldestOpen, mostVoted,
  });
});

module.exports = router;
