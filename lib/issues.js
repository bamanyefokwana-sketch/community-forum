// Rules for issues: status workflow, permissions and photo validation.
const pool = require('../db/pool');

const STATUSES = ['reported', 'acknowledged', 'in_progress', 'resolved', 'closed', 'rejected'];
const OPEN_STATUSES = ['reported', 'acknowledged', 'in_progress'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Which status a leader may move an issue to next.
const TRANSITIONS = {
  reported: ['acknowledged', 'in_progress', 'rejected'],
  acknowledged: ['in_progress', 'rejected'],
  in_progress: ['resolved'],
  resolved: ['closed', 'in_progress'],
  rejected: ['acknowledged'],
  closed: [],
};

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_PHOTOS = 3;

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// resolved_at is set while an issue is resolved or closed, and cleared otherwise
// (chk_issues_resolved_at enforces this in the database).
function resolvedAtFor(newStatus, currentResolvedAt) {
  if (newStatus === 'resolved' || newStatus === 'closed') return currentResolvedAt || new Date();
  return null;
}

// Can this user manage (update status, priority, assignee) issues in this area?
async function canManageArea(user, areaId, conn = pool) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'leader') return false;
  const [[row]] = await conn.query('SELECT 1 AS ok FROM leader_areas WHERE leader_id = ? AND area_id = ?', [user.id, areaId]);
  return !!row;
}

// Checks and decodes photos sent as { name, type, data (base64) }. Returns { photos } or { error }.
function readPhotos(list, alreadyAttached = 0) {
  if (list == null) return { photos: [] };
  if (!Array.isArray(list)) return { error: 'Photos must be a list.' };
  if (list.length + alreadyAttached > MAX_PHOTOS) return { error: `An issue can have at most ${MAX_PHOTOS} photos.` };
  const photos = [];
  for (const p of list) {
    if (!PHOTO_TYPES.includes(p.type)) return { error: 'Photos must be JPEG, PNG or WebP images.' };
    const data = Buffer.from(String(p.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (data.length === 0) return { error: 'One of the photos is empty.' };
    if (data.length > MAX_PHOTO_BYTES) return { error: 'Each photo must be 2 MB or smaller.' };
    photos.push({ name: String(p.name || 'photo').slice(0, 200), type: p.type, data });
  }
  return { photos };
}

async function savePhotos(conn, issueId, photos) {
  for (const p of photos) {
    await conn.query(
      'INSERT INTO issue_photos (issue_id, file_name, mime_type, size_bytes, data) VALUES (?, ?, ?, ?, ?)',
      [issueId, p.name, p.type, p.data.length, p.data]);
  }
}

// Returns cleaned issue fields or { error }. Checks the category is active and the area exists.
async function readIssueFields(body, conn = pool) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const location = String(body.location || '').trim() || null;
  if (title.length < 5 || title.length > 150) return { error: 'The title must be 5–150 characters.' };
  if (description.length < 10 || description.length > 5000) return { error: 'Describe the issue in 10–5000 characters.' };
  if (location && location.length > 200) return { error: 'The location must be 200 characters or fewer.' };
  const [[category]] = await conn.query('SELECT id FROM categories WHERE id = ? AND is_active', [body.categoryId]);
  if (!category) return { error: 'Choose a category.' };
  const [[area]] = await conn.query('SELECT id FROM areas WHERE id = ?', [body.areaId]);
  if (!area) return { error: 'Choose the area where the issue is.' };
  return { title, description, location, categoryId: category.id, areaId: area.id };
}

module.exports = {
  STATUSES, OPEN_STATUSES, PRIORITIES, TRANSITIONS, MAX_PHOTOS,
  canTransition, resolvedAtFor, canManageArea, readPhotos, savePhotos, readIssueFields,
};
