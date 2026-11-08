// End-to-end tests through the real HTTP API, acting as an admin, a leader and two members
// at the same time. Self-contained: it creates a temporary administrator directly in the
// database, creates everything else through the API, and removes ALL of it at the end
// (even if a test fails). It never touches existing data.
// Needs the app running (npm start).
// Usage: node tools/test-api.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3001}`;
const tag = Date.now().toString(36).toLowerCase().slice(-6);
const emailFor = (who) => `${who}.${tag}@apitest.test`;
const PASSWORD = 'Test-pass-123';
// 1×1 pixel PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// One simulated browser: keeps its own login cookie.
class Client {
  constructor() { this.cookie = ''; }
  async call(url, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (res.headers.get('content-type')?.startsWith('image/')) return { contentType: res.headers.get('content-type'), status: res.status };
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(data?.error || res.statusText); err.status = res.status; throw err; }
    return data;
  }
  get(url) { return this.call(url); }
  post(url, body) { return this.call(url, { method: 'POST', body: body || {} }); }
  put(url, body) { return this.call(url, { method: 'PUT', body }); }
  patch(url, body) { return this.call(url, { method: 'PATCH', body }); }
  del(url, body) { return this.call(url, { method: 'DELETE', body }); }
  login(email, password = PASSWORD) { this.cookie = ''; return this.post('/api/auth/login', { email, password }); }
}
const statusOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.status; } };

const results = [];
function check(area, name, pass, detail = '') {
  results.push({ area, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}

const created = { areas: [], categories: [] };

async function main() {
  // Temporary administrator, created straight in the database.
  await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('API Test Admin', ?, ?, 'admin')",
    [emailFor('admin'), await bcrypt.hash(PASSWORD, 10)]);
  const admin = new Client();
  await admin.login(emailFor('admin'));

  // ---------- Reference data (admin) ----------
  const ar1 = await admin.post('/api/areas', { name: `Test Ward A ${tag}`, description: 'Test area' });
  const ar2 = await admin.post('/api/areas', { name: `Test Ward B ${tag}` });
  created.areas.push(ar1.id, ar2.id);
  check('Areas', 'Create: admin adds areas', !!ar1.id && !!ar2.id);
  check('Areas', 'Create: duplicate area name rejected (409)', await statusOf(() => admin.post('/api/areas', { name: `Test Ward A ${tag}` })) === 409);
  await admin.put(`/api/areas/${ar1.id}`, { name: `Test Ward A ${tag}`, description: 'Renamed test area' });
  check('Areas', 'Update: area description changed', (await admin.get('/api/areas')).some((a) => a.id === ar1.id && a.description === 'Renamed test area'));
  const cat = await admin.post('/api/categories', { name: `Test Cat ${tag}` });
  const spare = await admin.post('/api/categories', { name: `Spare Cat ${tag}` });
  created.categories.push(cat.id, spare.id);
  check('Categories', 'Create: invalid name rejected (400)', await statusOf(() => admin.post('/api/categories', { name: 'x' })) === 400);
  await admin.put(`/api/categories/${spare.id}`, { name: `Spare Cat ${tag}`, isActive: false });
  check('Categories', 'Update: deactivated category hidden from the report form', !(await admin.get('/api/categories')).some((c) => c.id === spare.id));

  // ---------- Members sign up ----------
  const m1 = new Client();
  const m2 = new Client();
  const leader = new Client();
  check('Accounts', 'Sign-up: short password rejected (400)', await statusOf(() => m1.post('/api/auth/register', { fullName: 'Member One', email: emailFor('m1'), password: 'short' })) === 400);
  const reg = await m1.post('/api/auth/register', { fullName: 'Member One', email: emailFor('m1'), password: PASSWORD, areaId: ar1.id });
  check('Accounts', 'Create: member signs up with a home area', reg.role === 'member' && reg.areaId === ar1.id);
  check('Accounts', 'Sign-up: duplicate email rejected (409)', await statusOf(() => m2.post('/api/auth/register', { fullName: 'Someone Else', email: emailFor('m1'), password: PASSWORD })) === 409);
  await m2.post('/api/auth/register', { fullName: 'Member Two', email: emailFor('m2'), password: PASSWORD });
  const regL = await leader.post('/api/auth/register', { fullName: 'Leader Person', email: emailFor('leader'), password: PASSWORD });

  // ---------- Admin makes a leader ----------
  check('Admin', 'Members cannot open admin pages (403)', await statusOf(() => m1.get('/api/admin/users')) === 403);
  await admin.patch(`/api/admin/users/${regL.id}`, { role: 'leader' });
  await admin.put(`/api/admin/users/${regL.id}/areas`, { areaIds: [ar1.id] });
  const me = await leader.get('/api/auth/me');
  check('Admin', 'Promote member to leader and assign an area (takes effect immediately)', me.role === 'leader' && me.leaderAreas.length === 1 && me.leaderAreas[0].id === ar1.id);
  check('Admin', 'Areas can only be assigned to leaders (400)', await statusOf(() => admin.put(`/api/admin/users/${reg.id}/areas`, { areaIds: [ar1.id] })) === 400);

  // ---------- Reporting ----------
  const good = { title: 'Burst pipe on Main Road', description: 'Water has been running down the street since Monday.', location: 'Main Rd & 5th St', categoryId: cat.id, areaId: ar1.id };
  check('Issues', 'Create: title too short rejected (400)', await statusOf(() => m1.post('/api/issues', { ...good, title: 'Pipe' })) === 400);
  check('Issues', 'Create: inactive category rejected (400)', await statusOf(() => m1.post('/api/issues', { ...good, categoryId: spare.id })) === 400);
  check('Issues', 'Create: non-image photo rejected (400)', await statusOf(() => m1.post('/api/issues', { ...good, photos: [{ name: 'x.gif', type: 'image/gif', data: PNG }] })) === 400);
  check('Issues', 'Create: more than 3 photos rejected (400)', await statusOf(() => m1.post('/api/issues', { ...good, photos: Array(4).fill({ name: 'p.png', type: 'image/png', data: PNG }) })) === 400);
  const i1 = await m1.post('/api/issues', { ...good, photos: [{ name: 'pipe.png', type: 'image/png', data: PNG }] });
  let detail = await m1.get(`/api/issues/${i1.id}`);
  check('Issues', 'Create: issue with a photo, first timeline entry "reported"', detail.photos.length === 1 && detail.updates.length === 1 && detail.updates[0].new_status === 'reported');
  const photo = await m2.get(`/api/issues/${i1.id}/photos/${detail.photos[0].id}`);
  check('Issues', 'Read: photo served from the database as an image', photo.contentType === 'image/png');
  await m1.put(`/api/issues/${i1.id}`, { ...good, title: 'Burst water pipe on Main Road' });
  check('Issues', 'Update: reporter edits before a leader responds', (await m1.get(`/api/issues/${i1.id}`)).title === 'Burst water pipe on Main Road');
  check('Issues', "Update: someone else can't edit the report (403)", await statusOf(() => m2.put(`/api/issues/${i1.id}`, good)) === 403);
  const list = await m2.get(`/api/issues?search=${encodeURIComponent('water pipe')}&areaId=${ar1.id}`);
  check('Issues', 'Read: list with search and area filter', list.total === 1 && list.issues[0].id === i1.id && list.issues[0].first_photo_id);

  // ---------- Votes ----------
  check('Votes', "Reporter can't vote on their own issue (400)", await statusOf(() => m1.post(`/api/issues/${i1.id}/vote`)) === 400);
  await m2.post(`/api/issues/${i1.id}/vote`);
  const twice = await m2.post(`/api/issues/${i1.id}/vote`);
  check('Votes', 'Create: "me too" counted once per person', twice.votes === 1);
  const unvote = await m2.del(`/api/issues/${i1.id}/vote`);
  check('Votes', 'Delete: vote withdrawn', unvote.votes === 0);
  await m2.post(`/api/issues/${i1.id}/vote`);

  // ---------- Comments ----------
  const c1 = await m2.post(`/api/issues/${i1.id}/comments`, { body: 'Same problem outside number 12.' });
  await m1.post(`/api/issues/${i1.id}/comments`, { body: 'Thanks for confirming.' });
  check('Comments', 'Create: members comment', (await m1.get(`/api/issues/${i1.id}`)).comments.length === 2);
  check('Comments', 'Create: empty comment rejected (400)', await statusOf(() => m1.post(`/api/issues/${i1.id}/comments`, { body: '   ' })) === 400);
  await m2.put(`/api/comments/${c1.id}`, { body: 'Same problem outside number 12 and 14.' });
  detail = await m1.get(`/api/issues/${i1.id}`);
  check('Comments', 'Update: author edits own comment (marked edited)', detail.comments.find((c) => c.id === c1.id).edited_at !== null);
  check('Comments', "Update: can't edit someone else's comment (403)", await statusOf(() => m1.put(`/api/comments/${c1.id}`, { body: 'hacked' })) === 403);
  check('Comments', "Delete: members can't delete others' comments (403)", await statusOf(() => m1.del(`/api/comments/${c1.id}`)) === 403);

  // ---------- Leader workflow ----------
  detail = await leader.get(`/api/issues/${i1.id}`);
  check('Workflow', 'Leader of the area can manage the issue', detail.permissions.manage && detail.permissions.nextStatuses.includes('acknowledged'));
  check('Workflow', "Members can't post leader updates (403)", await statusOf(() => m2.post(`/api/issues/${i1.id}/updates`, { status: 'acknowledged' })) === 403);
  await leader.post(`/api/issues/${i1.id}/updates`, { status: 'acknowledged', message: 'Reported to the water department.', priority: 'high', assignedTo: regL.id });
  detail = await m1.get(`/api/issues/${i1.id}`);
  check('Workflow', 'Update: status, priority and assignee change, recorded in the timeline', detail.status === 'acknowledged' && detail.priority === 'high' && detail.assigned_to === regL.id && detail.updates.length === 2);
  check('Workflow', 'Invalid status jump rejected (acknowledged → resolved, 400)', await statusOf(() => leader.post(`/api/issues/${i1.id}/updates`, { status: 'resolved' })) === 400);
  check('Workflow', 'Rejecting needs a reason (400)', await statusOf(() => leader.post(`/api/issues/${i1.id}/updates`, { status: 'rejected' })) === 400);
  check('Workflow', 'Assigning to a member rejected (400)', await statusOf(() => leader.post(`/api/issues/${i1.id}/updates`, { assignedTo: reg.id })) === 400);
  check('Issues', 'Reporter can no longer edit after a leader responds (409)', await statusOf(() => m1.put(`/api/issues/${i1.id}`, good)) === 409);
  await leader.post(`/api/issues/${i1.id}/updates`, { status: 'in_progress', message: 'Team on site.' });
  await leader.post(`/api/issues/${i1.id}/updates`, { status: 'resolved', message: 'Pipe replaced.' });
  detail = await m1.get(`/api/issues/${i1.id}`);
  check('Workflow', 'Resolved: resolved_at set and reporter asked to confirm', detail.status === 'resolved' && detail.resolved_at && detail.permissions.confirm);

  // ---------- Reporter confirms ----------
  check('Confirm', 'Saying "not fixed" needs a reason (400)', await statusOf(() => m1.post(`/api/issues/${i1.id}/confirm`, { fixed: false })) === 400);
  await m1.post(`/api/issues/${i1.id}/confirm`, { fixed: false, message: 'Still leaking a little.' });
  detail = await m1.get(`/api/issues/${i1.id}`);
  check('Confirm', 'Not fixed: issue reopened (in progress), resolved_at cleared', detail.status === 'in_progress' && detail.resolved_at === null);
  await leader.post(`/api/issues/${i1.id}/updates`, { status: 'resolved', message: 'Joint resealed.' });
  await m1.post(`/api/issues/${i1.id}/confirm`, { fixed: true });
  detail = await m1.get(`/api/issues/${i1.id}`);
  check('Confirm', 'Fixed: issue closed, full timeline kept', detail.status === 'closed' && detail.resolved_at && detail.updates.length === 7);

  // ---------- Area responsibility ----------
  const i2 = await m2.post('/api/issues', { ...good, title: 'Street light out on Oak Avenue', areaId: ar2.id });
  check('Workflow', "A leader can't update issues outside their areas (403)", await statusOf(() => leader.post(`/api/issues/${i2.id}/updates`, { status: 'acknowledged' })) === 403);
  await admin.post(`/api/issues/${i2.id}/updates`, { status: 'acknowledged' });
  check('Workflow', 'The admin can update issues in any area', (await m2.get(`/api/issues/${i2.id}`)).status === 'acknowledged');
  const stats = await leader.get('/api/stats?scope=mine');
  check('Dashboard', "Leader's dashboard counts only their areas", stats.totals.all === 1 && (stats.byStatus.closed || 0) === 1);
  check('Dashboard', "Members can't see the dashboard (403)", await statusOf(() => m1.get('/api/stats')) === 403);

  // ---------- Moderation ----------
  await leader.del(`/api/comments/${c1.id}`);
  check('Comments', 'Delete: leader removes a comment (moderation)', !(await m1.get(`/api/issues/${i1.id}`)).comments.some((c) => c.id === c1.id));

  // ---------- Admin account management ----------
  await admin.patch(`/api/admin/users/${reg.id}`, { isActive: false });
  check('Admin', 'Deactivated member cannot log in (403)', await statusOf(() => new Client().login(emailFor('m1'))) === 403);
  check('Admin', "Deactivated member's open session ends (401)", await statusOf(() => m1.get('/api/issues')) === 401);
  await admin.patch(`/api/admin/users/${reg.id}`, { isActive: true });
  await m1.login(emailFor('m1'));
  const { tempPassword } = await admin.post(`/api/admin/users/${reg.id}/reset-password`);
  const temp = await new Client().login(emailFor('m1'), tempPassword);
  check('Admin', 'Password reset: temporary password must be changed', temp.mustChangePassword === true);
  await m1.login(emailFor('m1'), tempPassword);
  check('Admin', 'Nothing else works until the password is changed (403)', await statusOf(() => m1.get('/api/issues')) === 403);
  await m1.put('/api/auth/password', { currentPassword: tempPassword, newPassword: PASSWORD });
  const adminId = (await admin.get('/api/auth/me')).id;
  check('Admin', "Admin can't demote themselves (400)", await statusOf(() => admin.patch(`/api/admin/users/${adminId}`, { role: 'member' })) === 400);
  await admin.patch(`/api/admin/users/${regL.id}`, { role: 'member' });
  check('Admin', "Demoted leader loses their areas and can't manage issues (403)", await statusOf(() => leader.post(`/api/issues/${i1.id}/updates`, { message: 'Hi' })) === 403);

  // ---------- Referential integrity through the API ----------
  check('Integrity', 'An area with issues cannot be deleted (409, RESTRICT)', await statusOf(() => admin.del(`/api/areas/${ar1.id}`)) === 409);
  check('Integrity', 'A category in use cannot be deleted (409, RESTRICT)', await statusOf(() => admin.del(`/api/categories/${cat.id}`)) === 409);
  check('Categories', 'Delete: unused category deleted', await statusOf(() => admin.del(`/api/categories/${spare.id}`)) === 'ok');
  created.categories = created.categories.filter((id) => id !== spare.id);

  // ---------- Withdraw and delete ----------
  const i3 = await m2.post('/api/issues', { ...good, title: 'Pothole outside the school', areaId: ar1.id });
  await m2.del(`/api/issues/${i3.id}`);
  check('Issues', 'Delete: reporter withdraws their issue before a leader responds', await statusOf(() => m2.get(`/api/issues/${i3.id}`)) === 404);
  check('Issues', "Delete: reporter can't delete after a leader responded (403)", await statusOf(() => m2.del(`/api/issues/${i2.id}`)) === 403);

  // ---------- Records are kept when people leave ----------
  await m1.del('/api/auth/me', { password: PASSWORD });
  detail = await admin.get(`/api/issues/${i1.id}`);
  check('Records', 'Deleting an account keeps its issue and timeline ("former member")', detail.reporter_id === null && detail.updates.length === 7);
  await admin.del(`/api/issues/${i1.id}`);
  const [[left]] = await pool.query('SELECT (SELECT COUNT(*) FROM issue_photos WHERE issue_id = ?) + (SELECT COUNT(*) FROM issue_updates WHERE issue_id = ?) + (SELECT COUNT(*) FROM comments WHERE issue_id = ?) AS n', [i1.id, i1.id, i1.id]);
  check('Records', 'Delete: admin deletes an issue, photos/updates/comments cascade', left.n === 0);
}

// Removes everything this run created, straight from the database.
async function cleanUp() {
  const like = `%.${tag}@apitest.test`;
  if (created.areas.length) await pool.query('DELETE FROM issues WHERE area_id IN (?)', [created.areas]);
  await pool.query('DELETE FROM users WHERE email LIKE ?', [like]);
  if (created.areas.length) await pool.query('DELETE FROM areas WHERE id IN (?)', [created.areas]);
  if (created.categories.length) await pool.query('DELETE FROM categories WHERE id IN (?)', [created.categories]);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [like]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.message); process.exitCode = 1; })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} API tests passed.${clean ? ' All test accounts and data were removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
