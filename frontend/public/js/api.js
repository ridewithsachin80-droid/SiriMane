// js/api.js
const API_BASE = '/api';
// Sprint 19 (D-17-1): the login is an HttpOnly cookie the server sets — no
// page script can read it. 'sm_user' (name and role, not a secret) only tells
// the app someone is logged in on this browser; the server decides.
const APP_HEADER = { 'X-Requested-With': 'sirimane' };   // writes must carry it (anti-forgery)
try { localStorage.removeItem('sm_token'); } catch (_) {}  // tokens stored by the old app
function getToken() { try { return localStorage.getItem('sm_user') ? 'cookie' : null; } catch (_) { return null; } }
function setToken() { /* the server set the cookie */ }
// Review S19-3: a login cookie must never outlive what the screen shows — if
// this browser shows nobody logged in, end any cookie session first. Logins
// wait for this so a slow reply can't clear a fresh cookie.
const staleCookieCleared = (function () {
  try { if (localStorage.getItem('sm_user')) return Promise.resolve(); } catch (_) {}
  return fetch('/api/auth/logout', { method: 'POST', headers: APP_HEADER, credentials: 'same-origin' }).then(() => {}, () => {});
})();
function clearAuth() {
  try { localStorage.removeItem('sm_token'); localStorage.removeItem('sm_user'); } catch (_) {}
  const go = () => { window.location.href = '/management.html'; };
  fetch('/api/auth/logout', { method: 'POST', headers: APP_HEADER, credentials: 'same-origin' }).then(go, go);
}

// Turns any HTTP response into JSON safely. A non-JSON body (e.g. an HTML
// error page from the proxy, or an empty 502) becomes a readable message
// instead of "Unexpected token '<'".
async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: res.ok ? 'Unexpected response from server' : `Server error (${res.status})` }; }
}

async function apiFetch(endpoint, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json', ...APP_HEADER },   // Sprint 19: the cookie travels by itself
    credentials: 'same-origin',
    ...options
  };
  if (options.body && typeof options.body === 'object') config.body = JSON.stringify(options.body);
  let res;
  try { res = await fetch(`${API_BASE}${endpoint}`, config); }
  catch { const e = new Error('No connection. Check your internet and try again.'); e.status = 0; throw e; }
  const data = await readJson(res);
  if (res.status === 401) {
    // A wrong password on these two is an answer, not a lost session (review S19-7)
    // …but only the wrong-password answer: an expired or turned-off login on
    // change-password still logs out (Sprint 20, from the 19 review).
    if (endpoint === '/auth/login' || (endpoint === '/auth/change-password' && /current password/i.test(data.error || ''))) {
      throw new Error(data.error || 'Invalid credentials');
    }
    clearAuth();
    return;
  }
  if (res.status === 429) { const e = new Error(data.error || 'Too many requests. Please wait a minute and try again.'); e.status = 429; throw e; }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }   // status lets callers tell 'refused' (4xx) from 'unknown' (0 / 5xx)
  return data;
}

const API = {
  login: (u,p) => staleCookieCleared.then(() => apiFetch('/auth/login', { method:'POST', body:{username:u,password:p} })),
  changePassword: (c,n) => apiFetch('/auth/change-password', { method:'POST', body:{currentPassword:c,newPassword:n} }),
  setUserPassword: (id, pw) => apiFetch(`/users/${id}/password`, { method:'POST', body:{ password: pw } }),   // Sprint 16.3
  renameUser: (id, name) => apiFetch(`/users/${id}/username`, { method:'PUT', body:{ username: name } }),
  resetGuestLogin: (id) => apiFetch(`/guests/${id}/reset-login`, { method:'POST' }),
  me: () => apiFetch('/auth/me'),
  dashboard: () => apiFetch('/dashboard'),
  getRooms: () => apiFetch('/rooms'),
  createRoom: d => apiFetch('/rooms', { method:'POST', body:d }),
  updateRoom: (id,d) => apiFetch(`/rooms/${id}`, { method:'PUT', body:d }),
  deleteRoom: id => apiFetch(`/rooms/${id}`, { method:'DELETE' }),
  getGuests: (p='') => apiFetch(`/guests${p}`),
  getGuest: id => apiFetch(`/guests/${id}`),
  createGuest: d => apiFetch('/guests', { method:'POST', body:d }),
  updateGuest: (id,d) => apiFetch(`/guests/${id}`, { method:'PUT', body:d }),
  approveRentVariance: id => apiFetch(`/guests/${id}/approve-rent`, { method:'PUT' }),
  checkoutGuest: id => apiFetch(`/guests/${id}`, { method:'DELETE' }),
  checkoutGuestWithRefund: (id,d) => apiFetch(`/guests/${id}/checkout`, { method:'POST', body:d }),
  getUsers: () => apiFetch('/users'),
  createUser: d => apiFetch('/users', { method:'POST', body:d }),
  deleteUser: id => apiFetch(`/users/${id}`, { method:'DELETE' }),
  disableUser: id => apiFetch(`/users/${id}/disable`, { method:'POST' }),   // S17-1
  enableUser: id => apiFetch(`/users/${id}/enable`, { method:'POST' }),
  getRentDue: () => apiFetch('/rent-due'),
  getGuestLedger: id => apiFetch(`/guests/${id}/ledger`),
  getRentHistory: id => apiFetch(`/guests/${id}/rent-history`),
  addRentHistory: (id,d) => apiFetch(`/guests/${id}/rent-history`, { method:'POST', body:d }),
  getActivityLog: (limit) => apiFetch(`/activity-log${limit?`?limit=${limit}`:''}`),
  getDepositRefunds: () => apiFetch('/deposit-refunds'),
  deleteDepositRefund: id => apiFetch(`/deposit-refunds/${id}`, { method:'DELETE' }),
  getSettings: () => apiFetch('/settings'),
  updateSettings: d => apiFetch('/settings', { method:'PUT', body:d }),
  confirmCollection: id => apiFetch(`/collections/${id}/confirm`, { method:'PUT' }),
  getCollections: (p='') => apiFetch(`/collections${p}`),
  createCollection: d => apiFetch('/collections', { method:'POST', body:d }),
  deleteCollection: id => apiFetch(`/collections/${id}`, { method:'DELETE' }),
  getPurchases: (p='') => apiFetch(`/purchases${p}`),
  createPurchase: d => apiFetch('/purchases', { method:'POST', body:d }),
  deletePurchase: id => apiFetch(`/purchases/${id}`, { method:'DELETE' }),
  getMenu: () => apiFetch('/menu'),
  saveMenu: d => apiFetch('/menu', { method:'POST', body:d }),
  deleteMenu: id => apiFetch(`/menu/${id}`, { method:'DELETE' }),
  getAnnouncements: () => apiFetch('/announcements'),
  createAnnouncement: d => apiFetch('/announcements', { method:'POST', body:d }),
  deleteAnnouncement: id => apiFetch(`/announcements/${id}`, { method:'DELETE' }),
  getInbox: () => apiFetch('/inbox'),
  markRead: id => apiFetch(`/inbox/${id}/read`, { method:'PUT' }),
  replyInbox: (id,r) => apiFetch(`/inbox/${id}/reply`, { method:'PUT', body:{reply:r} }),
  deleteInbox: id => apiFetch(`/inbox/${id}`, { method:'DELETE' }),
  getReports: (m,y) => apiFetch(`/reports?month=${m}&year=${y}`),
  getReportsRange: (from,to) => apiFetch(`/reports?from=${from}&to=${to}`),
  getReportsTrend: (months) => apiFetch(`/reports/trend?months=${months}`),
  confirmPurchase: id => apiFetch(`/purchases/${id}/confirm`, { method:'PUT' }),
  getFixedAssets: () => apiFetch('/fixed-assets'),
  createFixedAsset: d => apiFetch('/fixed-assets', { method:'POST', body:d }),
  deleteFixedAsset: id => apiFetch(`/fixed-assets/${id}`, { method:'DELETE' }),
  getCapitalTransactions: () => apiFetch('/capital-transactions'),
  createCapitalTransaction: d => apiFetch('/capital-transactions', { method:'POST', body:d }),
  deleteCapitalTransaction: id => apiFetch(`/capital-transactions/${id}`, { method:'DELETE' }),
  getBalanceSheet: (asOf) => apiFetch(`/balance-sheet${asOf?`?asOf=${asOf}`:''}`),
  getChecklist: (date) => apiFetch(`/checklist?date=${date}`),
  toggleChecklistItem: (itemId,date,checked) => apiFetch(`/checklist/${itemId}`, { method:'PUT', body:{date,checked} }),
  getChecklistSummary: (opts) => apiFetch(`/checklist/summary?${typeof opts==='object' && opts.month ? 'month='+opts.month : 'days='+((typeof opts==='number'?opts:30))}`),
  getChecklistItems: () => apiFetch('/checklist-items'),
  createChecklistItem: d => apiFetch('/checklist-items', { method:'POST', body:d }),
  updateChecklistItem: (id,d) => apiFetch(`/checklist-items/${id}`, { method:'PUT', body:d }),
  deleteChecklistItem: id => apiFetch(`/checklist-items/${id}`, { method:'DELETE' }),
  getComplaints: (status) => apiFetch(`/complaints${status && status!=='all' ? '?status='+status : ''}`),
  createComplaint: d => apiFetch('/complaints', { method:'POST', body:d }),
  updateComplaint: (id,d) => apiFetch(`/complaints/${id}`, { method:'PUT', body:d }),
  deleteComplaint: id => apiFetch(`/complaints/${id}`, { method:'DELETE' }),
  getRoomHistory: (guestId) => apiFetch(`/guests/${guestId}/room-history`),
  shiftGuestRoom: (guestId,d) => apiFetch(`/guests/${guestId}/shift-room`, { method:'POST', body:d })
};

// Export downloads are fetched as a blob and saved by hand (the login cookie
// travels with same-origin fetches — Sprint 19).
API.downloadExport = async function(path, filename) {
  const res = await fetch('/api' + path, { headers: APP_HEADER, credentials: 'same-origin' });
  if (!res.ok) {
    const err = await readJson(res).catch(()=>({error:'Export failed'}));
    throw new Error(err.error || 'Export failed');
  }
  // Guard against a non-PDF/CSV body being saved with a .pdf name (this is
  // exactly what happened when the receipt route was missing).
  const ct = res.headers.get('content-type') || '';
  if (/text\/html/i.test(ct)) throw new Error('Server returned a web page instead of a file');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
