// Takes screenshots of every main screen for the documentation.
// Self-contained: creates realistic, fictional sample data (people use the sample.test
// email domain), takes the screenshots, then deletes everything it created.
// Needs the app running (npm start).
// Usage: node tools/screenshots.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { launch, renderToPng } = require('./render');

const BASE = `http://localhost:${process.env.PORT || 3001}`;
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const PW = 'Sample-pass-123';
const created = { areas: [], emails: [] };

class Client {
  constructor() { this.cookie = ''; }
  async call(url, method = 'GET', body) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${data?.error}`);
    return data;
  }
  login(email) { this.cookie = ''; return this.call('/api/auth/login', 'POST', { email, password: PW }); }
}

// Simple illustrated "photos" so the screenshots show thumbnails (no real photos are used).
async function makePhoto(file, emoji, from, to, caption) {
  const html = `<html><body style="margin:0"><div style="width:640px;height:480px;background:linear-gradient(160deg,${from},${to});
    display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Segoe UI,Arial">
    <div style="font-size:170px">${emoji}</div><div style="color:white;font-size:30px;font-weight:600;opacity:.9">${caption}</div></div></body></html>`;
  await renderToPng(html, file, 640, 480, 1);
  return fs.readFileSync(file).toString('base64');
}

async function seed(tmp) {
  // Temporary administrator, straight in the database.
  created.emails.push('admin@sample.test');
  await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Nomsa Admin', 'admin@sample.test', ?, 'admin')", [await bcrypt.hash(PW, 10)]);
  const admin = new Client();
  await admin.login('admin@sample.test');

  const area = {};
  for (const [name, description] of [['Ward 12 – Mandela Park', 'Mandela Park and the taxi rank'], ['Ward 7 – Riverside', 'Riverside, including the school'], ['Ward 3 – Hillview', 'Hillview and the clinic']]) {
    area[name.split(' – ')[1]] = (await admin.call('/api/areas', 'POST', { name, description })).id;
  }
  created.areas.push(...Object.values(area));
  const cats = Object.fromEntries((await admin.call('/api/categories')).map((c) => [c.name, c.id]));

  const people = {};
  const signUp = async (key, name, areaId) => {
    const email = `${key}@sample.test`;
    created.emails.push(email);
    const c = new Client();
    const u = await c.call('/api/auth/register', 'POST', { fullName: name, email, password: PW, areaId });
    people[key] = { c, u, email };
  };
  await signUp('thandi', 'Thandi Mokoena', area['Mandela Park']);
  await signUp('sipho', 'Sipho Ndlovu', area['Mandela Park']);
  await signUp('ayesha', 'Ayesha Patel', area.Riverside);
  await signUp('johan', 'Johan van Wyk', area.Hillview);
  await signUp('zanele', 'Zanele Khumalo', area['Mandela Park']);
  await signUp('lindiwe', 'Lindiwe Dube', area['Mandela Park']);
  await signUp('peter', 'Peter Sithole', area.Riverside);
  for (const [key, areas] of [['lindiwe', [area['Mandela Park'], area.Hillview]], ['peter', [area.Riverside]]]) {
    await admin.call(`/api/admin/users/${people[key].u.id}`, 'PATCH', { role: 'leader' });
    await admin.call(`/api/admin/users/${people[key].u.id}/areas`, 'PUT', { areaIds: areas });
  }
  await people.lindiwe.c.login(people.lindiwe.email);
  await people.peter.c.login(people.peter.email);

  const pipe = await makePhoto(path.join(tmp, 'pipe.png'), '🚰', '#2563eb', '#0f172a', 'Burst pipe, Main Road');
  const light = await makePhoto(path.join(tmp, 'light.png'), '💡', '#1e1b4b', '#0f172a', 'Street light out');
  const waste = await makePhoto(path.join(tmp, 'waste.png'), '🗑️', '#65a30d', '#3f6212', 'Overflowing bins');
  const road = await makePhoto(path.join(tmp, 'road.png'), '🚧', '#b45309', '#78350f', 'Pothole');
  const photo = (name, data) => [{ name, type: 'image/png', data }];

  const report = (who, title, description, category, areaName, location, photos) => people[who].c.call('/api/issues', 'POST',
    { title, description, categoryId: cats[category], areaId: area[areaName], location, photos });
  const update = (who, id, body) => people[who].c.call(`/api/issues/${id}/updates`, 'POST', body);
  const comment = (who, id, body) => people[who].c.call(`/api/issues/${id}/comments`, 'POST', { body });
  const vote = (id, ...who) => Promise.all(who.map((w) => people[w].c.call(`/api/issues/${id}/vote`, 'POST')));

  const ids = {};
  ids.pipe = (await report('thandi', 'Burst water pipe on Main Road', 'Water has been gushing onto the road since Monday morning. The pavement is flooded and cars are splashing people waiting for taxis.', 'Water', 'Mandela Park', 'Main Road, outside the clinic', photo('pipe.png', pipe))).id;
  ids.lights = (await report('sipho', 'Four street lights out on Oak Avenue', 'The street lights between 3rd and 5th Street have been off for two weeks. It is very dark and unsafe walking home at night.', 'Electricity', 'Mandela Park', 'Oak Avenue, between 3rd and 5th Street', photo('light.png', light))).id;
  ids.waste = (await report('zanele', 'Refuse not collected at the taxi rank', 'The bins at the taxi rank have not been emptied for three weeks. They are overflowing and there are rats.', 'Waste', 'Mandela Park', 'Mandela Park taxi rank', photo('waste.png', waste))).id;
  ids.pothole = (await report('ayesha', 'Deep pothole outside Riverside Primary', 'A large pothole has opened right at the pedestrian crossing outside the school gate. Cars swerve around it.', 'Roads', 'Riverside', 'School Street, at the crossing', photo('road.png', road))).id;
  ids.drain = (await report('johan', 'Blocked storm-water drain', 'The drain on Hill Street is blocked with sand, so the road floods every time it rains.', 'Sanitation', 'Hillview', 'Hill Street near number 40')).id;
  ids.dumping = (await report('sipho', 'Illegal dumping in the open field', 'Builders keep dumping rubble and old furniture in the field behind the community hall.', 'Waste', 'Mandela Park', 'Field behind the community hall')).id;
  ids.duplicate = (await report('zanele', 'Water leak on Main Road', 'There is a lot of water on Main Road near the clinic.', 'Water', 'Mandela Park', 'Main Road')).id;
  ids.crossing = (await report('ayesha', 'Faded pedestrian crossing lines', 'The zebra crossing lines on River Road have faded completely and drivers do not stop.', 'Roads', 'Riverside', 'River Road at the shops')).id;

  await vote(ids.pipe, 'sipho', 'zanele', 'lindiwe', 'johan');
  await vote(ids.lights, 'thandi', 'zanele', 'ayesha');
  await vote(ids.waste, 'thandi', 'sipho');
  await vote(ids.pothole, 'peter', 'johan', 'thandi');
  await vote(ids.dumping, 'zanele');

  await comment('sipho', ids.pipe, 'Same outside number 14. It started on Sunday night already.');
  await update('lindiwe', ids.pipe, { status: 'acknowledged', message: 'Reported to the municipal water department, reference WD-2291.', priority: 'high', assignedTo: people.lindiwe.u.id });
  await comment('thandi', ids.pipe, 'Thank you! Will the water be switched off during the repair?');
  await comment('lindiwe', ids.pipe, 'Yes, for about two hours on Thursday morning. I will post the exact time here.');
  await update('lindiwe', ids.pipe, { status: 'in_progress', message: 'A repair team is booked for Thursday 08:00. Water will be off from 08:00 to 10:00.' });

  await update('lindiwe', ids.lights, { status: 'acknowledged', message: 'Logged with Eskom, reference EL-55120.', assignedTo: people.lindiwe.u.id });
  await update('lindiwe', ids.lights, { status: 'in_progress', message: 'Electricians are replacing the cables.' });
  await update('lindiwe', ids.lights, { status: 'resolved', message: 'All four lights were repaired on Tuesday evening. Please confirm they are working.' });

  await update('lindiwe', ids.waste, { status: 'acknowledged', message: 'The waste department will collect on Friday.', priority: 'urgent' });
  await update('lindiwe', ids.waste, { status: 'in_progress' });
  await update('lindiwe', ids.waste, { status: 'resolved', message: 'Collected on Friday.' });
  await people.zanele.c.call(`/api/issues/${ids.waste}/confirm`, 'POST', { fixed: true, message: 'Yes, all clean now. Thank you!' });

  await update('peter', ids.pothole, { status: 'acknowledged', message: 'Roads department notified. Cones placed around the hole in the meantime.', priority: 'high', assignedTo: people.peter.u.id });
  await update('lindiwe', ids.duplicate, { status: 'rejected', message: 'This is the same leak as "Burst water pipe on Main Road". Please follow that issue for updates.' });
  await update('lindiwe', ids.drain, { status: 'acknowledged', message: 'Scheduled for cleaning next week.' });
  await comment('johan', ids.drain, 'Thank you, it rained again last night and the road flooded.');
  return { ids, people };
}

async function cleanUp() {
  if (created.areas.length) await pool.query('DELETE FROM issues WHERE area_id IN (?)', [created.areas]);
  if (created.emails.length) await pool.query('DELETE FROM users WHERE email IN (?)', [created.emails]);
  if (created.areas.length) await pool.query('DELETE FROM areas WHERE id IN (?)', [created.areas]);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forum-shots-'));
  const { ids } = await seed(tmp);

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  page.on('dialog', (d) => d.accept());
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = (url, method = 'GET', body) => page.evaluate(async (url, method, body) => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return res.status === 204 ? null : res.json();
  }, url, method, body);

  async function login(email) {
    if (page.url().startsWith(BASE)) await api('/api/auth/logout', 'POST');
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.type('#login-email', email);
    await page.type('#login-password', PW);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#login-form button')]);
  }
  async function shot(name, url, prepare) {
    if (url) await page.goto(`${BASE}/${url}`, { waitUntil: 'networkidle0' });
    await pause(400);
    if (prepare) { await prepare(); await pause(400); }
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  ', name);
  }

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await shot('01-login', null);
    await shot('02-sign-up', null, () => page.click('#tab-register'));

    await login('thandi@sample.test');
    await shot('03-issues', 'issues.html');
    await shot('04-report', 'report.html', async () => {
      await page.type('#title', 'Broken swings in Mandela Park playground');
      await page.select('#category', String((await api('/api/categories')).find((c) => c.name === 'Safety').id));
      await page.type('#location', 'Playground next to the community hall');
      await page.type('#description', 'Two swings have broken chains and the metal edges are sharp. Children still play on them.');
    });
    await shot('05-issue-detail', `issue.html?id=${ids.pipe}`);
    await shot('06-issue-timeline', null, () => page.evaluate(() => document.getElementById('timeline').scrollIntoView({ block: 'start' })));

    await login('sipho@sample.test');
    await shot('07-confirm-fix', `issue.html?id=${ids.lights}`);

    await login('lindiwe@sample.test');
    await shot('08-leader-update', `issue.html?id=${ids.drain}`, async () => {
      await page.select('#m-status', 'in_progress');
      await page.type('#m-message', 'The cleaning team will be there on Monday morning.');
    });
    await shot('09-dashboard', 'dashboard.html');

    await login('admin@sample.test');
    await shot('10-admin-people', 'admin.html');
    await shot('11-admin-areas', 'admin.html', () => page.click('[data-tab="areas"]'));
    await shot('12-admin-categories', 'admin.html', () => page.click('[data-tab="categories"]'));
    await shot('13-profile', 'profile.html');
  } finally {
    await browser.close();
    await cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
    await pool.end();
  }
  console.log(`Screenshots saved to ${OUT}. Sample data removed.`);
}

main().catch(async (err) => { console.error(err); process.exit(1); });
