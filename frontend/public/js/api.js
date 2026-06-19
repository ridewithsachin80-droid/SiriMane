// js/api.js
const API_BASE = '/api';
function getToken() { return localStorage.getItem('sm_token'); }
function setToken(t) { localStorage.setItem('sm_token', t); }
function clearAuth() { localStorage.removeItem('sm_token'); localStorage.removeItem('sm_user'); window.location.href = '/index.html'; }

async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const config = {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...options
  };
  if (options.body && typeof options.body === 'object') config.body = JSON.stringify(options.body);
  const res = await fetch(`${API_BASE}${endpoint}`, config);
  const data = await res.json();
  if (res.status === 401) {
    if (endpoint === '/auth/login') {
      throw new Error(data.error || 'Invalid credentials');
    }
    clearAuth();
    return;
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const API = {
  login: (u,p) => apiFetch('/auth/login', { method:'POST', body:{username:u,password:p} }),
  changePassword: (c,n) => apiFetch('/auth/change-password', { method:'POST', body:{currentPassword:c,newPassword:n} }),
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
  checkoutGuest: id => apiFetch(`/guests/${id}`, { method:'DELETE' }),
  checkoutGuestWithRefund: (id,d) => apiFetch(`/guests/${id}/checkout`, { method:'POST', body:d }),
  getUsers: () => apiFetch('/users'),
  createUser: d => apiFetch('/users', { method:'POST', body:d }),
  deleteUser: id => apiFetch(`/users/${id}`, { method:'DELETE' }),
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
  getBalanceSheet: (asOf) => apiFetch(`/balance-sheet${asOf?`?asOf=${asOf}`:''}`)
};

// Export downloads need the auth header, so a plain <a href> won't work —
// fetch as a blob and trigger the download manually instead.
API.downloadExport = async function(path, filename) {
  const res = await fetch('/api' + path, { headers: { 'Authorization': 'Bearer ' + getToken() } });
  if (!res.ok) {
    const err = await res.json().catch(()=>({error:'Export failed'}));
    throw new Error(err.error || 'Export failed');
  }
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
