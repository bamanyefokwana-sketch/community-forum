const pool = require('../db/pool');
const { toSessionUser } = require('./accounts');

// Re-reads the logged-in user from the database on every request, so a promotion,
// demotion or deactivation by the admin takes effect immediately.
async function loadUser(req, res, next) {
  if (!req.session.user) return next();
  const [[row]] = await pool.query(
    'SELECT id, full_name, email, role, area_id, must_change_password, is_active FROM users WHERE id = ?',
    [req.session.user.id]);
  if (!row || !row.is_active) {
    return req.session.destroy(() => res.status(401).json({ error: 'Your session has ended. Please log in again.' }));
  }
  req.session.user = toSessionUser(row);
  next();
}

// Logged in at all (used by the routes needed to change a temporary password).
function requireSession(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

// Logged in, and not still using a temporary password.
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.session.user.mustChangePassword) {
    return res.status(403).json({ error: 'Please choose a new password first.', mustChangePassword: true });
  }
  next();
}

// Logged in with one of the given roles.
function requireRole(...roles) {
  return (req, res, next) => requireLogin(req, res, () => {
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You are not allowed to do this.' });
    }
    next();
  });
}

module.exports = { loadUser, requireSession, requireLogin, requireRole };
