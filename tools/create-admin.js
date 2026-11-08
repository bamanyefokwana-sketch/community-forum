// Creates an administrator account (or promotes an existing member) with a temporary
// password that must be changed at first login.
// Usage: npm run admin:create -- "Full Name" admin@example.com
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { makeTempPassword, readNameAndEmail } = require('../lib/accounts');

async function main() {
  const details = readNameAndEmail({ fullName: process.argv[2], email: process.argv[3] });
  if (details.error) {
    console.log('Usage: npm run admin:create -- "Full Name" admin@example.com');
    console.log(details.error);
    process.exitCode = 1;
    return;
  }
  const temp = makeTempPassword();
  const hash = await bcrypt.hash(temp, 10);
  const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [details.email]);
  if (existing) {
    await pool.query(
      "UPDATE users SET role = 'admin', is_active = TRUE, password_hash = ?, must_change_password = TRUE WHERE id = ?",
      [hash, existing.id]);
    console.log(`${details.email} already had an account; it is now an administrator.`);
  } else {
    await pool.query(
      "INSERT INTO users (full_name, email, password_hash, must_change_password, role) VALUES (?, ?, ?, TRUE, 'admin')",
      [details.fullName, details.email, hash]);
    console.log(`Administrator account created for ${details.fullName}.`);
  }
  console.log(`Email: ${details.email}`);
  console.log(`Temporary password: ${temp}`);
  console.log('Log in and choose a new password. This password is not shown again.');
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
