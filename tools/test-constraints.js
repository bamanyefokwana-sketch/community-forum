// Proves the database itself enforces integrity. It creates a small set of its own rows,
// then tries statements that break a rule and checks MySQL rejects each one. Everything
// runs inside one transaction that is rolled back, so no data is left behind.
// Usage: node tools/test-constraints.js
const pool = require('../db/pool');

async function createFixtures(conn) {
  const tag = Date.now().toString(36).slice(-6);
  const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const f = { tag };
  f.area = await ins('INSERT INTO areas (name) VALUES (?)', [`Constraint Area ${tag}`]);
  f.category = await ins('INSERT INTO categories (name) VALUES (?)', [`Constraint Cat ${tag}`]);
  f.email = `member.${tag}@constraint.test`;
  f.member = await ins("INSERT INTO users (full_name, email, password_hash, area_id) VALUES ('Test Member', ?, 'x', ?)", [f.email, f.area]);
  f.leader = await ins("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Test Leader', ?, 'x', 'leader')", [`leader.${tag}@constraint.test`]);
  await conn.query('INSERT INTO leader_areas (leader_id, area_id) VALUES (?, ?)', [f.leader, f.area]);
  f.issue = await ins(`INSERT INTO issues (reporter_id, category_id, area_id, title, description)
    VALUES (?, ?, ?, 'Test issue title', 'A long enough description.')`, [f.member, f.category, f.area]);
  f.photo = await ins("INSERT INTO issue_photos (issue_id, file_name, mime_type, size_bytes, data) VALUES (?, 'a.png', 'image/png', 3, 'abc')", [f.issue]);
  f.update = await ins("INSERT INTO issue_updates (issue_id, author_id, old_status, new_status) VALUES (?, ?, NULL, 'reported')", [f.issue, f.member]);
  f.comment = await ins("INSERT INTO comments (issue_id, author_id, body) VALUES (?, ?, 'Hello')", [f.issue, f.member]);
  await conn.query('INSERT INTO issue_votes (issue_id, user_id) VALUES (?, ?)', [f.issue, f.leader]);
  return f;
}

// [description, SQL that must fail, expected MySQL error code]
const cases = (f) => [
  ['UQ: duplicate email (uq_users_email)', `INSERT INTO users (full_name, email, password_hash) VALUES ('Dup', '${f.email}', 'x')`, 'ER_DUP_ENTRY'],
  ['UQ: duplicate area name (uq_areas_name)', `INSERT INTO areas (name) VALUES ('Constraint Area ${f.tag}')`, 'ER_DUP_ENTRY'],
  ['UQ: leader assigned to the same area twice (uq_leader_areas_leader_area)', `INSERT INTO leader_areas (leader_id, area_id) VALUES (${f.leader}, ${f.area})`, 'ER_DUP_ENTRY'],
  ['UQ: second "me too" vote by the same person (uq_issue_votes_issue_user)', `INSERT INTO issue_votes (issue_id, user_id) VALUES (${f.issue}, ${f.leader})`, 'ER_DUP_ENTRY'],
  ['FK: issue in an area that does not exist (fk_issues_area)', `UPDATE issues SET area_id = 99999999 WHERE id = ${f.issue}`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK: comment on an issue that does not exist (fk_comments_issue)', `INSERT INTO comments (issue_id, body) VALUES (99999999, 'x')`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK RESTRICT: delete an area that has issues (fk_issues_area)', `DELETE FROM areas WHERE id = ${f.area}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete a category that has issues (fk_issues_category)', `DELETE FROM categories WHERE id = ${f.category}`, 'ER_ROW_IS_REFERENCED_2'],
  ['CHECK: title shorter than 5 characters (chk_issues_title)', `UPDATE issues SET title = 'Pipe' WHERE id = ${f.issue}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: description shorter than 10 characters (chk_issues_description)', `UPDATE issues SET description = 'Short' WHERE id = ${f.issue}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: resolved without a resolved date (chk_issues_resolved_at)', `UPDATE issues SET status = 'resolved' WHERE id = ${f.issue}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: resolved date on an open issue (chk_issues_resolved_at)', `UPDATE issues SET resolved_at = NOW() WHERE id = ${f.issue}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: photo that is not JPEG/PNG/WebP (chk_issue_photos_mime)', `UPDATE issue_photos SET mime_type = 'image/gif' WHERE id = ${f.photo}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: photo larger than 2 MB (chk_issue_photos_size)', `UPDATE issue_photos SET size_bytes = 3000000 WHERE id = ${f.photo}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: update that changes nothing and says nothing (chk_issue_updates_content)', `INSERT INTO issue_updates (issue_id, old_status, new_status) VALUES (${f.issue}, 'reported', 'reported')`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: blank comment (chk_comments_body)', `UPDATE comments SET body = '   ' WHERE id = ${f.comment}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: invalid email (chk_users_email)', `UPDATE users SET email = 'not-an-email' WHERE id = ${f.member}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: one-letter area name (chk_areas_name)', "INSERT INTO areas (name) VALUES ('A')", 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['ENUM: unknown status', `UPDATE issues SET status = 'lost' WHERE id = ${f.issue}`, 'WARN_DATA_TRUNCATED'],
  ['ENUM: unknown role', `UPDATE users SET role = 'mayor' WHERE id = ${f.member}`, 'WARN_DATA_TRUNCATED'],
  ['NOT NULL: issue without a category', `INSERT INTO issues (area_id, title, description) VALUES (${f.area}, 'Missing category', 'No category given.')`, 'ER_NO_DEFAULT_FOR_FIELD'],
];

async function main() {
  const conn = await pool.getConnection();
  let passed = 0;
  let total = 0;
  const record = (ok, text) => { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };
  try {
    await conn.beginTransaction();
    const f = await createFixtures(conn);

    for (const [name, sql, expected] of cases(f)) {
      await conn.query('SAVEPOINT test_case');
      let got = 'no error (row accepted)';
      try { await conn.query(sql); } catch (err) { got = err.code; }
      await conn.query('ROLLBACK TO SAVEPOINT test_case');
      record(got === expected, `${name}  ->  ${got}`);
    }

    // ON DELETE SET NULL: deleting a member keeps their issue, update and comment.
    await conn.query('SAVEPOINT test_case');
    await conn.query('DELETE FROM users WHERE id = ?', [f.member]);
    const [[kept]] = await conn.query(`
      SELECT (SELECT reporter_id FROM issues WHERE id = ?) AS reporter,
             (SELECT COUNT(*) FROM issues WHERE id = ?) + (SELECT COUNT(*) FROM comments WHERE id = ?) + (SELECT COUNT(*) FROM issue_updates WHERE id = ?) AS rows_kept`,
    [f.issue, f.issue, f.comment, f.update]);
    await conn.query('ROLLBACK TO SAVEPOINT test_case');
    record(kept.reporter === null && kept.rows_kept === 3, `FK SET NULL: deleting a member keeps their issue, comment and update  ->  ${kept.reporter === null ? 'KEPT' : 'LOST'}`);

    // ON DELETE CASCADE: deleting an issue deletes its photos, updates, comments and votes.
    await conn.query('DELETE FROM issues WHERE id = ?', [f.issue]);
    const [[left]] = await conn.query(`
      SELECT (SELECT COUNT(*) FROM issue_photos WHERE issue_id = ?) + (SELECT COUNT(*) FROM issue_updates WHERE issue_id = ?)
           + (SELECT COUNT(*) FROM comments WHERE issue_id = ?) + (SELECT COUNT(*) FROM issue_votes WHERE issue_id = ?) AS n`,
    [f.issue, f.issue, f.issue, f.issue]);
    record(left.n === 0, `FK CASCADE: deleting an issue deletes its photos, updates, comments and votes  ->  ${left.n === 0 ? 'CASCADED' : 'ROWS_LEFT'}`);
  } finally {
    await conn.rollback(); // removes every row this test created
    conn.release();
    await pool.end();
  }
  console.log(`\n${passed}/${total} integrity rules enforced by MySQL (all test rows rolled back).`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
