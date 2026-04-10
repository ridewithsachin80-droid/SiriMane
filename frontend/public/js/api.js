// js/api.js — Centralized API calls

const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('sm_token');
}

function setToken(token) {
  localStorage.setItem('sm_token', token);
}

function clearAuth() {
  localStorage.removeItem('sm_token');
  localStorage.removeItem('sm_user');
  window.location.href = '/';
}

async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...options
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_BASE}${endpoint}`, config);

  if (res.status === 401) {
    clearAuth();
    return;
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const API = {
  // Auth
  login: (username, password) =>
    apiFetch('/auth/login', { method: 'POST', body: { username, password } }),
  changePassword: (currentPassword, newPassword) =>
    apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  me: () => apiFetch('/auth/me'),

  // Dashboard
  dashboard: () => apiFetch('/dashboard'),

  // Guests
  getGuests: (params = '') => apiFetch(`/guests${params}`),
  getGuest: (id) => apiFetch(`/guests/${id}`),
  createGuest: (data) => apiFetch('/guests', { method: 'POST', body: data }),
  updateGuest: (id, data) => apiFetch(`/guests/${id}`, { method: 'PUT', body: data }),
  checkoutGuest: (id) => apiFetch(`/guests/${id}`, { method: 'DELETE' }),

  // Rooms
  getRooms: () => apiFetch('/rooms'),
  createRoom: (data) => apiFetch('/rooms', { method: 'POST', body: data }),
  updateRoom: (id, data) => apiFetch(`/rooms/${id}`, { method: 'PUT', body: data }),
  deleteRoom: (id) => apiFetch(`/rooms/${id}`, { method: 'DELETE' }),

  // Payments
  getPayments: (params = '') => apiFetch(`/payments${params}`),
  createPayment: (data) => apiFetch('/payments', { method: 'POST', body: data }),
  deletePayment: (id) => apiFetch(`/payments/${id}`, { method: 'DELETE' }),

  // Expenses
  getExpenses: (params = '') => apiFetch(`/expenses${params}`),
  createExpense: (data) => apiFetch('/expenses', { method: 'POST', body: data }),
  deleteExpense: (id) => apiFetch(`/expenses/${id}`, { method: 'DELETE' })
};
