// Reverse-engineers the ERD from the live MySQL database.
// Tables, columns, types, keys and relationships are all read from information_schema,
// so the diagram always matches what is built. Only the layout is fixed here.
//
// Usage: node tools/erd.js
// Writes docs/erd/community-forum-erd-physical.{svg,png} and ...-conceptual.{svg,png}
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { renderToPng } = require('./render');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'erd');
const DB = process.env.DB_NAME || 'community_forum';
const SCHEMA_VERSION = require('../package.json').version.split('.').slice(0, 2).join('.');

// Grid position of each table: [column, row]
const LAYOUT = {
  categories: [0, 0], areas: [1, 0], leader_areas: [2, 0],
  issue_photos: [0, 1], issues: [1, 1], users: [3, 1],
  issue_votes: [0, 2], issue_updates: [1, 2], comments: [2, 2],
};
// Tables from the Phase 1 plan (core) and tables added during design (extension).
const EXTENSION_TABLES = ['areas', 'categories', 'leader_areas', 'issue_photos', 'issue_votes'];

// Verb phrase for each foreign key, read parent -> child.
const LABELS = {
  fk_users_area: 'is home to',
  fk_leader_areas_leader: 'looks after',
  fk_leader_areas_area: 'has leaders',
  fk_issues_category: 'classifies',
  fk_issues_area: 'contains',
  fk_issues_reporter: 'reports',
  fk_issues_assigned: 'is assigned',
  fk_issue_photos_issue: 'has photos',
  fk_issue_updates_issue: 'has timeline',
  fk_issue_updates_author: 'posts',
  fk_comments_issue: 'has',
  fk_comments_author: 'writes',
  fk_issue_votes_issue: 'receives',
  fk_issue_votes_user: 'votes',
};

const COLORS = {
  core: '#3f3aa8', extension: '#c2410c', line: '#334155', text: '#1c1f2e',
  muted: '#64748b', rowAlt: '#f3f3fa', label: '#475569',
};

async function readSchema() {
  const [columns] = await pool.query(`
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS col_key
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'
    ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DB]);
  const [fks] = await pool.query(`
    SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS col,
           k.REFERENCED_TABLE_NAME AS parent, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ?`, [DB]);
  const [uniques] = await pool.query(`
    SELECT s.TABLE_NAME AS tbl, s.COLUMN_NAME AS col,
           (SELECT COUNT(*) FROM information_schema.STATISTICS s2
            WHERE s2.TABLE_SCHEMA = s.TABLE_SCHEMA AND s2.TABLE_NAME = s.TABLE_NAME AND s2.INDEX_NAME = s.INDEX_NAME) AS size
    FROM information_schema.STATISTICS s
    WHERE s.TABLE_SCHEMA = ? AND s.NON_UNIQUE = 0 AND s.INDEX_NAME <> 'PRIMARY'`, [DB]);

  const tables = {};
  for (const c of columns) {
    (tables[c.tbl] ||= { name: c.tbl, columns: [] }).columns.push({
      name: c.name,
      type: c.type.startsWith('enum') ? 'enum' : c.type.replace('tinyint(1)', 'boolean'),
      nullable: !!c.nullable,
      pk: c.col_key === 'PRI',
      fk: fks.some((f) => f.child === c.tbl && f.col === c.name),
      uq: uniques.some((u) => u.tbl === c.tbl && u.col === c.name && u.size === 1),
      uc: uniques.some((u) => u.tbl === c.tbl && u.col === c.name && u.size > 1),
    });
  }
  const missing = Object.keys(tables).filter((t) => !LAYOUT[t]);
  if (missing.length) throw new Error(`No layout position for table(s): ${missing.join(', ')}`);
  return { tables, fks };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function build({ tables, fks }, detailed) {
  const BOX_W = detailed ? 270 : 180;
  const HEAD = detailed ? 34 : 46;
  const ROW = 21;
  const GAP_X = 120;
  const GAP_Y = detailed ? 96 : 100;
  const MARGIN_X = 40;
  const MARGIN_TOP = 70;

  const heightOf = (t) => (detailed ? HEAD + t.columns.length * ROW + 6 : HEAD);
  const rowHeights = [0, 1, 2].map((r) => Math.max(...Object.values(tables).filter((t) => LAYOUT[t.name][1] === r).map(heightOf)));
  const rowY = [MARGIN_TOP];
  rowY[1] = rowY[0] + rowHeights[0] + GAP_Y;
  rowY[2] = rowY[1] + rowHeights[1] + GAP_Y;

  const box = {};
  for (const t of Object.values(tables)) {
    const [c, r] = LAYOUT[t.name];
    // Row 1 tables are vertically centred on the tallest one (issues), except issues itself.
    box[t.name] = { x: MARGIN_X + c * (BOX_W + GAP_X), y: rowY[r], w: BOX_W, h: heightOf(t), table: t };
  }
  const width = MARGIN_X * 2 + 4 * BOX_W + 3 * GAP_X;
  const row2Bottom = rowY[2] + rowHeights[2];

  const colY = (tbl, col) => {
    const b = box[tbl];
    if (!detailed) return b.y + b.h / 2;
    const i = b.table.columns.findIndex((c) => c.name === col);
    if (i < 0) throw new Error(`No column ${tbl}.${col}`);
    return b.y + HEAD + i * ROW + ROW / 2 + 3;
  };
  const left = (t) => box[t].x;
  const right = (t) => box[t].x + box[t].w;
  const top = (t) => box[t].y;
  const bottom = (t) => box[t].y + box[t].h;
  const xAt = (t, f) => box[t].x + box[t].w * f;
  const gapX = (col) => MARGIN_X + col * (BOX_W + GAP_X) + BOX_W + GAP_X / 2; // middle of the gap right of a column
  const conceptualOffset = detailed ? 0 : 1;

  // Side-to-side link through a vertical segment at x.
  const hElbow = (x1, y1, x2, y2, xm = (x1 + x2) / 2) => [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
  const channel01 = rowY[1] - GAP_Y / 2;
  const channel12 = rowY[2] - GAP_Y / 2;

  // Routes run from the PARENT end to the CHILD end.
  const routes = {
    fk_issues_area: [[xAt('areas', 0.5), bottom('areas')], [xAt('areas', 0.5), top('issues')]],
    fk_issues_category: [[right('categories'), colY('categories', 'id')], [gapX(0) - 20, colY('categories', 'id')], [gapX(0) - 20, channel01], [xAt('issues', 0.2), channel01], [xAt('issues', 0.2), top('issues')]],
    fk_leader_areas_area: hElbow(right('areas'), colY('areas', 'id'), left('leader_areas'), colY('leader_areas', 'area_id')),
    fk_leader_areas_leader: [[xAt('users', 0.3), top('users')], [xAt('users', 0.3), colY('leader_areas', 'leader_id')], [right('leader_areas'), colY('leader_areas', 'leader_id')]],
    fk_users_area: [[xAt('areas', 0.8), top('areas')], [xAt('areas', 0.8), 30], [xAt('users', 0.75), 30], [xAt('users', 0.75), top('users')]],
    fk_issue_photos_issue: hElbow(left('issues'), colY('issues', 'id'), right('issue_photos'), colY('issue_photos', 'issue_id')),
    // Two issue–user links run through the empty middle column (column 2), side by side.
    fk_issues_reporter: hElbow(left('users'), colY('users', 'id') - (detailed ? 0 : 8), right('issues'), colY('issues', 'reporter_id') - (detailed ? 0 : 8), gapX(1) + GAP_X / 2 + BOX_W * 0.3),
    fk_issues_assigned: hElbow(left('users'), colY('users', 'full_name') + (detailed ? 0 : 8), right('issues'), colY('issues', 'assigned_to') + (detailed ? 0 : 8), gapX(1) + GAP_X / 2 + BOX_W * 0.7),
    fk_issue_updates_issue: [[xAt('issues', 0.5), bottom('issues')], [xAt('issues', 0.5), top('issue_updates')]],
    fk_comments_issue: [[xAt('issues', 0.8), bottom('issues')], [xAt('issues', 0.8), channel12], [xAt('comments', 0.35), channel12], [xAt('comments', 0.35), top('comments')]],
    fk_issue_votes_issue: [[xAt('issues', 0.2), bottom('issues')], [xAt('issues', 0.2), channel12], [xAt('issue_votes', 0.6), channel12], [xAt('issue_votes', 0.6), top('issue_votes')]],
    fk_comments_author: [[xAt('users', 0.3), bottom('users')], [xAt('users', 0.3), colY('comments', 'author_id') + conceptualOffset * 8], [right('comments'), colY('comments', 'author_id') + conceptualOffset * 8]],
    fk_issue_updates_author: [[xAt('users', 0.55), bottom('users')], [xAt('users', 0.55), row2Bottom + 28], [xAt('issue_updates', 0.5), row2Bottom + 28], [xAt('issue_updates', 0.5), bottom('issue_updates')]],
    fk_issue_votes_user: [[xAt('users', 0.8), bottom('users')], [xAt('users', 0.8), row2Bottom + 52], [xAt('issue_votes', 0.5), row2Bottom + 52], [xAt('issue_votes', 0.5), bottom('issue_votes')]],
  };

  const out = [];
  const markerLines = [];
  function marker([x, y], [dx, dy], kind) {
    const px = -dy, py = dx;
    const at = (d) => [x + dx * d, y + dy * d];
    const bar = (d) => { const [cx, cy] = at(d); markerLines.push(`<line x1="${cx + px * 7}" y1="${cy + py * 7}" x2="${cx - px * 7}" y2="${cy - py * 7}"/>`); };
    const circle = (d) => { const [cx, cy] = at(d); markerLines.push(`<circle cx="${cx}" cy="${cy}" r="4.5" fill="#fff"/>`); };
    if (kind === 'one') { bar(7); bar(13); }
    if (kind === 'zeroOrOne') { bar(7); circle(17); }
    if (kind === 'many') {
      const [tx, ty] = at(15);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x + px * 8}" y2="${y + py * 8}"/>`);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x}" y2="${y}"/>`);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x - px * 8}" y2="${y - py * 8}"/>`);
      circle(21);
    }
  }
  const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };

  const lines = [];
  const labels = [];
  for (const fk of fks) {
    const pts = routes[fk.name];
    if (!pts) throw new Error(`No route for foreign key ${fk.name}`);
    lines.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${COLORS.line}" stroke-width="1.6"/>`);
    const optionalParent = tables[fk.child].columns.find((c) => c.name === fk.col).nullable;
    marker(pts[0], unit(pts[0], pts[1]), optionalParent ? 'zeroOrOne' : 'one');
    marker(pts[pts.length - 1], unit(pts[pts.length - 1], pts[pts.length - 2]), 'many');

    // Label: middle of the vertical segment for side-to-side links, else the longest segment.
    let mx, my;
    const sideToSide = pts.length === 4 && pts[0][1] === pts[1][1] && pts[2][1] === pts[3][1];
    if (sideToSide) {
      mx = pts[1][0];
      my = (pts[1][1] + pts[2][1]) / 2;
    } else {
      let best = 0, bi = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        if (l > best) { best = l; bi = i; }
      }
      mx = (pts[bi][0] + pts[bi + 1][0]) / 2;
      my = (pts[bi][1] + pts[bi + 1][1]) / 2;
    }
    const text = LABELS[fk.name] || '';
    const tw = text.length * 6.4 + 10;
    labels.push(`<rect x="${mx - tw / 2}" y="${my - 9}" width="${tw}" height="18" rx="4" fill="#ffffff" stroke="#e2e8f0"/>` +
      `<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11.5" font-style="italic" fill="${COLORS.label}">${esc(text)}</text>`);
  }
  out.push(...lines);
  out.push(`<g stroke="${COLORS.line}" stroke-width="1.6" fill="none">${markerLines.join('')}</g>`);

  for (const b of Object.values(box)) {
    const color = EXTENSION_TABLES.includes(b.table.name) ? COLORS.extension : COLORS.core;
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="7" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>`);
    out.push(`<path d="M${b.x} ${b.y + 7} a7 7 0 0 1 7 -7 h${b.w - 14} a7 7 0 0 1 7 7 v${HEAD - 7} h${-b.w} z" fill="${color}"/>`);
    out.push(`<text x="${b.x + b.w / 2}" y="${b.y + (detailed ? 22 : 29)}" text-anchor="middle" font-size="${detailed ? 15 : 15}" font-weight="700" fill="#ffffff">${esc(detailed ? b.table.name : b.table.name.toUpperCase().replace('_', ' '))}</text>`);
    if (detailed) {
      b.table.columns.forEach((c, i) => {
        const y = b.y + HEAD + i * ROW;
        if (i % 2 === 1) out.push(`<rect x="${b.x + 1}" y="${y}" width="${b.w - 2}" height="${ROW}" fill="${COLORS.rowAlt}"/>`);
        const keys = [c.pk && 'PK', c.fk && 'FK', c.uq && !c.pk && 'UQ', c.uc && 'UC'].filter(Boolean).join(' ');
        out.push(`<text x="${b.x + 8}" y="${y + 15}" font-size="10.5" font-weight="700" fill="${c.pk ? COLORS.extension : c.fk ? COLORS.core : COLORS.muted}">${keys}</text>`);
        out.push(`<text x="${b.x + 50}" y="${y + 15}" font-size="12.5" fill="${COLORS.text}" ${c.pk ? 'font-weight="700" text-decoration="underline"' : ''} ${c.nullable ? 'font-style="italic"' : ''}>${esc(c.name)}</text>`);
        out.push(`<text x="${b.x + b.w - 8}" y="${y + 15}" text-anchor="end" font-size="11" fill="${COLORS.muted}">${esc(c.type)}${c.nullable ? ' · null' : ''}</text>`);
      });
    }
  }
  out.push(...labels);

  // Title and legend in a strip along the bottom.
  const ly = row2Bottom + 95;
  const legend = [];
  legend.push(`<text x="${MARGIN_X}" y="${ly}" font-size="19" font-weight="700">Community Forum ${detailed ? 'physical' : 'conceptual'} ERD</text>`);
  legend.push(`<text x="${MARGIN_X}" y="${ly + 22}" fill="${COLORS.muted}" font-size="12.5">Schema v${SCHEMA_VERSION} · reverse-engineered from MySQL 8.4</text>`);
  let x = MARGIN_X + 380;
  const item = (draw, text, w) => { legend.push(draw(x, ly - 4)); legend.push(`<text x="${x + 58}" y="${ly}" font-size="12.5">${text}</text>`); x += w; };
  item((lx, y) => `<rect x="${lx}" y="${y - 8}" width="46" height="16" rx="3" fill="${COLORS.core}"/>`, 'Core table (Phase 1 plan)', 230);
  item((lx, y) => `<rect x="${lx}" y="${y - 8}" width="46" height="16" rx="3" fill="${COLORS.extension}"/>`, 'Extension table', 190);
  const sample = (kind) => (lx, y) => {
    markerLines.length = 0;
    marker([lx, y], [1, 0], kind);
    marker([lx + 46, y], [-1, 0], 'many');
    return `<line x1="${lx}" y1="${y}" x2="${lx + 46}" y2="${y}" stroke="${COLORS.line}" stroke-width="1.6"/><g stroke="${COLORS.line}" stroke-width="1.6" fill="none">${markerLines.join('')}</g>`;
  };
  item(sample('one'), 'exactly one to zero or many', 260);
  item(sample('zeroOrOne'), 'zero or one to zero or many', 260);
  if (detailed) {
    legend.push(`<text x="${MARGIN_X + 380}" y="${ly + 26}" font-size="12.5" fill="${COLORS.muted}"><tspan font-weight="700" fill="${COLORS.extension}">PK</tspan> primary key   <tspan font-weight="700" fill="${COLORS.core}">FK</tspan> foreign key   <tspan font-weight="700">UQ</tspan> unique   <tspan font-weight="700">UC</tspan> unique together with the other UC column   <tspan font-style="italic">italic · null</tspan> = optional</text>`);
  }
  out.push(`<g fill="${COLORS.text}">${legend.join('')}</g>`);

  const height = ly + 50;
  const finalW = Math.max(width, x + 20);
  out.unshift(`<svg xmlns="http://www.w3.org/2000/svg" width="${finalW}" height="${height}" viewBox="0 0 ${finalW} ${height}" font-family="Segoe UI, Arial, sans-serif"><rect width="100%" height="100%" fill="#ffffff"/>`);
  out.push('</svg>');
  return { svg: out.join('\n'), width: finalW, height };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const schema = await readSchema();
  await pool.end();
  for (const [name, detailed] of [['physical', true], ['conceptual', false]]) {
    const { svg, width, height } = build(schema, detailed);
    const base = path.join(OUT_DIR, `community-forum-erd-${name}`);
    fs.writeFileSync(`${base}.svg`, svg);
    await renderToPng(`<html><body style="margin:0">${svg}</body></html>`, `${base}.png`, width, height);
    console.log(`Wrote ${base}.svg and .png (${width}x${height})`);
  }
  console.log(`${Object.keys(schema.tables).length} tables, ${schema.fks.length} relationships read from "${DB}".`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
