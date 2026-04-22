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
  getReports: (m,y) => apiFetch(`/reports?month=${m}&year=${y}`)
};
