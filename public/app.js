'use strict';

let apiKey = '';
const $ = (id) => document.getElementById(id);

const apiKeyInput  = $('apiKey');
const keyPill      = $('keyPill');
const longUrlInput = $('longUrl');
const slugInput    = $('customSlug');
const ttlInput     = $('ttlSeconds');
const pwInput      = $('password');
const createBtn    = $('createBtn');
const clearBtn     = $('clearBtn');
const refreshBtn   = $('refreshBtn');
const resultBox    = $('result');
const resultUrl    = $('resultUrl');
const resultMeta   = $('resultMeta');
const tableCard    = $('tableCard');
const toastEl      = $('toast');

let toastTimer;
function toast(msg, type = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `show toast-${type}`;
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3000);
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers ?? {}) },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

apiKeyInput.addEventListener('input', () => {
  apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setPill('idle', 'not set');
    renderEmpty('🔑', 'Enter your <strong>API key</strong> above<br>to load your links.');
    return;
  }
  setPill('idle', 'checking…');
  loadLinks();
});

function setPill(state, text) {
  keyPill.className = `key-pill ${state}`;
  keyPill.textContent = text;
}

createBtn.addEventListener('click', createLink);
longUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createLink(); });

async function createLink() {
  if (!apiKey) { toast('Set your API key first', 'error'); return; }

  const longUrl  = longUrlInput.value.trim();
  const slug     = slugInput.value.trim();
  const ttl      = ttlInput.value.trim();
  const password = pwInput.value;

  if (!longUrl) { toast('Destination URL is required', 'error'); return; }

  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';

  try {
    const body = { longUrl };
    if (slug)     body.slug       = slug;
    if (ttl)      body.ttlSeconds = Number(ttl);
    if (password) body.password   = password;

    const { ok, data } = await apiFetch('/api/links', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!ok) { toast(data.error ?? 'Something went wrong', 'error'); return; }

    resultUrl.textContent = data.shortUrl;
    const meta = [];
    if (data.expiresAt)         meta.push('Expires ' + new Date(data.expiresAt).toLocaleString());
    if (data.passwordProtected) meta.push('🔒 Password protected');
    resultMeta.textContent = meta.join('  ·  ');
    resultBox.className = 'show';

    toast('Link created — click to copy');
    loadLinks();
  } catch (err) {
    toast('Network error', 'error');
    console.error(err);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Shorten →';
  }
}

resultUrl.addEventListener('click', () => {
  navigator.clipboard.writeText(resultUrl.textContent)
    .then(() => toast('Copied to clipboard'))
    .catch(() => toast('Could not copy', 'error'));
});

clearBtn.addEventListener('click', () => {
  [longUrlInput, slugInput, ttlInput, pwInput].forEach((el) => (el.value = ''));
  resultBox.className = '';
});

refreshBtn.addEventListener('click', loadLinks);

async function loadLinks() {
  if (!apiKey) return;

  renderLoading();

  try {
    const { ok, status, data } = await apiFetch('/api/links');

    if (status === 401) {
      setPill('invalid', '✕ invalid key');
      renderEmpty('Invalid API key.<br>Check the key and try again.');
      return;
    }

    if (!ok) {
      renderEmpty('Failed to load links.');
      return;
    }

    setPill('valid', '✓ valid');
    renderTable(data);
  } catch (err) {
    renderEmpty('Network error — is the Worker running?');
    console.error(err);
  }
}

function renderLoading() {
  tableCard.innerHTML = `
    <div class="empty">
      <div class="empty-icon" style="animation:spin 1s linear infinite;display:inline-block">⏳</div>
      <p>Loading…</p>
    </div>`;
}

function renderEmpty(icon, msg) {
  tableCard.innerHTML = `
    <div class="empty">
      <div class="empty-icon">${icon}</div>
      <p>${msg}</p>
    </div>`;
}

function renderTable(links) {
  if (!links.length) {
    renderEmpty('✂️', 'No links yet.<br>Create your first one above.');
    return;
  }

  links.sort((a, b) => b.createdAt - a.createdAt);

  const rows = links.map((l) => {
    const expired = l.expiresAt && Date.now() > l.expiresAt;
    const badge = expired
      ? `<span class="badge badge-expired">expired</span>`
      : l.passwordProtected
        ? `<span class="badge badge-locked"> locked</span>`
        : `<span class="badge badge-active">active</span>`;

    const exp = l.expiresAt
      ? new Date(l.expiresAt).toLocaleDateString()
      : '—';

    const safeSlug = escHtml(l.slug);
    const safeLong = escHtml(l.longUrl);

    return `<tr>
      <td class="slug-cell"><a href="/${safeSlug}" target="_blank" rel="noopener">/${safeSlug}</a></td>
      <td class="url-cell" title="${safeLong}">${safeLong}</td>
      <td class="clicks-cell">${l.clicks}</td>
      <td style="font-size:13px;color:var(--muted)">${exp}</td>
      <td>${badge}</td>
      <td>
        <button class="del-btn" data-slug="${safeSlug}" title="Delete /${safeSlug}">✕</button>
      </td>
    </tr>`;
  }).join('');

  tableCard.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Slug</th>
          <th>Destination</th>
          <th>Clicks</th>
          <th>Expires</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  tableCard.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteLink(btn.dataset.slug));
  });
}

async function deleteLink(slug) {
  if (!confirm(`Delete /${slug}? This cannot be undone.`)) return;
  try {
    const { ok, data } = await apiFetch(`/api/links/${slug}`, { method: 'DELETE' });
    if (ok) { toast(`Deleted /${slug}`); loadLinks(); }
    else    toast(data.error ?? 'Delete failed', 'error');
  } catch {
    toast('Network error', 'error');
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);