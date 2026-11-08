// Helpers shared by every page.

// Calls the API and returns the JSON body. Throws an Error with the server's message on failure.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.endsWith('/') && !location.pathname.endsWith('/index.html')) {
      location.href = '/';
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function param(name) {
  return new URLSearchParams(location.search).get(name);
}

function homeFor(user) {
  if (user.mustChangePassword) return '/profile.html';
  return user.role === 'member' ? '/issues.html' : '/dashboard.html';
}

// Makes sure someone is logged in (optionally with one of the given roles) and draws the header.
async function requireUser(...roles) {
  let user;
  try {
    user = await api('/api/auth/me');
  } catch {
    location.href = '/';
    return new Promise(() => {});
  }
  if (user.mustChangePassword && !location.pathname.endsWith('/profile.html')) {
    location.href = '/profile.html';
    return new Promise(() => {});
  }
  if (roles.length && !roles.includes(user.role)) {
    location.href = homeFor(user);
    return new Promise(() => {});
  }
  renderHeader(user);
  return user;
}

function navLinks(user) {
  const links = [['issues.html', 'Issues'], ['report.html', 'Report an issue']];
  if (user.role !== 'member') links.push(['dashboard.html', 'Dashboard']);
  if (user.role === 'admin') links.push(['admin.html', 'Admin']);
  links.push(['profile.html', 'Profile']);
  return links;
}

function renderHeader(user) {
  const inner = document.querySelector('header .inner');
  const current = location.pathname.split('/').pop();
  const links = user.mustChangePassword ? '' : navLinks(user).map(([href, label]) =>
    `<a href="${href}" class="${current === href ? 'active' : ''}">${label}</a>`).join('');
  inner.innerHTML = `
    <a class="brand" href="${homeFor(user)}"><span class="logo">C</span>Community Forum</a>
    <nav class="nav">${links}</nav>
    <span class="who">${esc(user.fullName)} <span class="role">${esc(user.role)}</span></span>
    <button class="ghost" id="logout">Log out</button>`;
  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  };
}

const STATUS_LABELS = {
  reported: 'Reported',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
  rejected: 'Rejected',
};
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

function statusBadge(status) {
  return `<span class="badge status-${status}">${STATUS_LABELS[status] || esc(status)}</span>`;
}
function priorityBadge(priority) {
  return priority === 'medium' ? '' : `<span class="badge priority-${priority}">${PRIORITY_LABELS[priority]} priority</span>`;
}
function roleBadge(role) {
  return role && role !== 'member' ? ` <span class="badge role-${role}">${esc(role)}</span>` : '';
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function timeAgo(value) {
  const seconds = Math.round((Date.now() - new Date(value)) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

// Shows a one-time temporary password.
function tempPasswordNotice(name, email, password) {
  return `<div class="success">
    <strong>New login details for ${esc(name)}:</strong><br>
    Email: <strong>${esc(email)}</strong><br>
    Temporary password: <span class="temp-password">${esc(password)}</span><br>
    <span class="small">They will choose their own password when they next log in. This password won't be shown again.</span>
  </div>`;
}

// Fills a <select> with areas or categories.
function optionsHtml(items, selectedId, placeholder) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    items.map((i) => `<option value="${i.id}" ${Number(selectedId) === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
}
