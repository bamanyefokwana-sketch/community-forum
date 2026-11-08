// Helpers for user accounts shared by routes and admin tools.
const crypto = require('crypto');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['member', 'leader', 'admin'];

// No 0/O or 1/l/I, so a temporary password can be read out without confusion.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function makeTempPassword(length = 10) {
  return Array.from(crypto.randomBytes(length), (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

// Returns cleaned { fullName, email } or { error }.
function readNameAndEmail(body) {
  const fullName = String(body.fullName || '').trim().slice(0, 100);
  const email = String(body.email || '').trim().toLowerCase();
  if (fullName.length < 2) return { error: 'Enter your full name.' };
  if (!EMAIL_PATTERN.test(email)) return { error: 'Enter a valid email address.' };
  return { fullName, email };
}

function toSessionUser(row) {
  return {
    id: row.id, fullName: row.full_name, email: row.email, role: row.role,
    areaId: row.area_id ?? null, mustChangePassword: !!row.must_change_password,
  };
}

module.exports = { EMAIL_PATTERN, ROLES, makeTempPassword, readNameAndEmail, toSessionUser };
