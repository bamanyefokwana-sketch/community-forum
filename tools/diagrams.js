// Draws the system architecture and "3 layers of validation" diagrams as PNGs.
// Counts of tables and constraints are read from the live database.
// Usage: node tools/diagrams.js  -> docs/diagrams/*.png
const fs = require('fs');
const path = require('path');
const { renderToPng } = require('./render');

const OUT = path.join(__dirname, '..', 'docs', 'diagrams');

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff; color: #1c1f2e; padding: 28px; }
  .row { display: flex; align-items: stretch; }
  .tier { flex: 1; border: 2px solid #3f3aa8; border-radius: 14px; overflow: hidden; background: #fff; }
  .tier h2 { background: #3f3aa8; color: #fff; font-size: 21px; padding: 12px 16px; }
  .tier h2 small { display: block; font-size: 13px; font-weight: 400; opacity: .85; }
  .tier ul { list-style: none; padding: 12px 16px; font-size: 14.5px; line-height: 1.55; }
  .tier li::before { content: '•'; color: #3f3aa8; font-weight: 700; margin-right: 7px; }
  .tier.db { border-color: #c2410c; } .tier.db h2 { background: #c2410c; }
  .arrow { width: 130px; display: flex; flex-direction: column; justify-content: center; align-items: center; font-size: 13px; color: #475569; text-align: center; padding: 0 6px; }
  .arrow .line { width: 100%; height: 2px; background: #334155; position: relative; margin: 8px 0; }
  .arrow .line::after { content: ''; position: absolute; right: -2px; top: -6px; border: 7px solid transparent; border-left: 11px solid #334155; }
  .arrow .line.back::after { right: auto; left: -2px; border-left: 7px solid transparent; border-right: 11px solid #334155; }
  .note { margin-top: 18px; font-size: 14px; color: #475569; text-align: center; }
`;

const architecture = (n) => `
<div class="row">
  <div class="tier"><h2>Presentation tier<small>Web browser: HTML, CSS, JavaScript</small></h2><ul>
    <li>Log in and sign up</li><li>Issues list, issue page, report form (photos)</li>
    <li>Leader dashboard, admin pages, profile</li><li>Photos shrunk before upload</li><li>Checks forms before sending</li></ul></div>
  <div class="arrow">HTTP requests<br>JSON (fetch)<div class="line"></div><div class="line back"></div>JSON / images</div>
  <div class="tier"><h2>Application tier<small>Node.js + Express REST API</small></h2><ul>
    <li>Sessions; roles member / leader / admin</li><li>Status workflow and area permissions</li>
    <li>Validation of every request</li><li>Transactions for multi-row saves</li><li>Passwords hashed with bcrypt</li></ul></div>
  <div class="arrow">Parameterised SQL<br>(mysql2 pool)<div class="line"></div><div class="line back"></div>Result rows</div>
  <div class="tier db"><h2>Data tier<small>MySQL 8.4 (InnoDB)</small></h2><ul>
    <li>${n.tables} tables + schema_migrations</li><li>${n.fks} foreign keys</li>
    <li>${n.checks} CHECK constraints, ${n.uniques} unique keys</li><li>Photos stored as MEDIUMBLOB</li><li>Versioned migration scripts</li></ul></div>
</div>
<p class="note">Community Forum three-tier architecture: every layer validates data, and the database has the final say.</p>`;

const validation = `
<div class="row">
  <div class="tier"><h2>1 · Browser<small>Fast feedback while typing</small></h2><ul>
    <li>Required fields, lengths</li><li>Photo type, count, automatic resizing</li><li>Confirm before deleting</li></ul></div>
  <div class="arrow">if it passes<div class="line"></div></div>
  <div class="tier"><h2>2 · Server<small>Business rules (cannot be bypassed)</small></h2><ul>
    <li>Role and area checks</li><li>Allowed status changes only</li><li>Reporter edits only before a response</li><li>Photo type and 2 MB limit</li></ul></div>
  <div class="arrow">if it passes<div class="line"></div></div>
  <div class="tier db"><h2>3 · Database<small>Last line of defence</small></h2><ul>
    <li>PK, FK, UNIQUE, NOT NULL</li><li>CHECK constraints</li><li>ENUM value lists</li><li>ON DELETE CASCADE / SET NULL / RESTRICT</li></ul></div>
</div>`;

async function countObjects() {
  const pool = require('../db/pool');
  const db = process.env.DB_NAME || 'community_forum';
  const [[n]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations') AS tables,
      (SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?) AS fks,
      (SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?) AS checks,
      (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'UNIQUE') AS uniques`,
  [db, db, db, db]);
  await pool.end();
  return n;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const n = await countObjects();
  console.log('Database objects:', n);
  for (const [name, body, w, h] of [['architecture', architecture(n), 1400, 345], ['validation-layers', validation, 1400, 260]]) {
    const file = path.join(OUT, `${name}.png`);
    await renderToPng(`<html><head><style>${CSS}</style></head><body>${body}</body></html>`, file, w, h);
    console.log('Wrote', file);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
