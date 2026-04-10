// js/app.js — Main application logic

// ── INIT ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  if (token) {
    showApp();
    navigate('dashboard');
  } else {
    showLogin();
  }
  setupLoginForm();
  setupNavigation();
  setupMobileMenu();
  setupLogout();
});

function showLogin() {
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const user = JSON.parse(localStorage.getItem('sm_user') || '{}');
  document.getElementById('topbar-user').textContent = `👤 ${user.username || 'Admin'}`;
}

// ── LOGIN ────────────────────────────────────────
function setupLoginForm() {
  const btn = document.getElementById('login-btn');
  const alert = document.getElementById('login-alert');

  const doLogin = async () => {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) { showAlert(alert, 'Please enter username and password'); return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      const data = await API.login(username, password);
      setToken(data.token);
      localStorage.setItem('sm_user', JSON.stringify(data.user));
      alert.classList.add('hidden');
      showApp();
      navigate('dashboard');
    } catch (err) {
      showAlert(alert, err.message || 'Login failed');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🔐 Login';
    }
  };

  btn.addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keypress', e => {
    if (e.key === 'Enter') doLogin();
  });
}

// ── NAVIGATION ───────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });
}

function setupLogout() {
  document.getElementById('logout-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to logout?')) clearAuth();
  });
}

function setupMobileMenu() {
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

function navigate(page) {
  // Update active nav
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  const titles = {
    dashboard: 'Dashboard', guests: 'Guests',
    rooms: 'Rooms', payments: 'Payments',
    expenses: 'Expenses', reports: 'Reports'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  document.getElementById('topbar-actions').innerHTML = '';

  const pages = { dashboard, guests, rooms, payments, expenses, reports };
  if (pages[page]) pages[page]();
}

// ── HELPERS ──────────────────────────────────────
function showAlert(el, msg, type = 'danger') {
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function formatCurrency(n) {
  return '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0 });
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function openModal(html) {
  document.getElementById('modal-container').innerHTML = `
    <div class="modal-overlay" id="modal-overlay">${html}</div>`;
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
}

function closeModal() {
  document.getElementById('modal-container').innerHTML = '';
}

function setContent(html) {
  document.getElementById('page-content').innerHTML = html;
}

// ── DASHBOARD ────────────────────────────────────
async function dashboard() {
  setContent('<div style="text-align:center;padding:60px"><div class="spinner"></div></div>');
  try {
    const d = await API.dashboard();
    setContent(`
      <div class="stat-grid">
        <div class="stat-card amber">
          <div class="label">Total Guests</div>
          <div class="value">${d.totalGuests}</div>
          <div class="sub">Active residents</div>
        </div>
        <div class="stat-card blue">
          <div class="label">Rooms</div>
          <div class="value">${d.totalRooms}</div>
          <div class="sub">${d.occupancyPercent}% occupancy</div>
        </div>
        <div class="stat-card blue">
          <div class="label">Available Beds</div>
          <div class="value">${d.availableBeds}</div>
          <div class="sub">of ${d.totalBeds} total</div>
        </div>
        <div class="stat-card green">
          <div class="label">Monthly Income</div>
          <div class="value">${formatCurrency(d.monthlyIncome)}</div>
          <div class="sub">This month</div>
        </div>
        <div class="stat-card red">
          <div class="label">Monthly Expenses</div>
          <div class="value">${formatCurrency(d.monthlyExpenses)}</div>
          <div class="sub">This month</div>
        </div>
        <div class="stat-card ${d.netProfit >= 0 ? 'green' : 'red'}">
          <div class="label">Net Profit</div>
          <div class="value">${formatCurrency(d.netProfit)}</div>
          <div class="sub">This month</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;flex-wrap:wrap">
        <div class="card">
          <div class="flex justify-between items-center mb-4">
            <h3 style="font-size:15px;font-weight:600">Recent Guests</h3>
            <button class="btn btn-outline btn-sm" onclick="navigate('guests')">View All</button>
          </div>
          ${d.recentGuests.length === 0
            ? '<div class="empty-state"><div class="icon">👩</div><p>No guests yet</p></div>'
            : `<div class="table-wrap"><table>
              <tr><th>Name</th><th>Room</th><th>Rent</th></tr>
              ${d.recentGuests.map(g => `
                <tr>
                  <td><strong>${g.name}</strong><br><small style="color:#6B7280">${g.phone||''}</small></td>
                  <td>${g.room_number || '—'}</td>
                  <td>${formatCurrency(g.monthly_rent)}</td>
                </tr>`).join('')}
            </table></div>`}
        </div>

        <div class="card">
          <div class="flex justify-between items-center mb-4">
            <h3 style="font-size:15px;font-weight:600">Recent Payments</h3>
            <button class="btn btn-outline btn-sm" onclick="navigate('payments')">View All</button>
          </div>
          ${d.recentPayments.length === 0
            ? '<div class="empty-state"><div class="icon">💰</div><p>No payments yet</p></div>'
            : `<div class="table-wrap"><table>
              <tr><th>Guest</th><th>Amount</th><th>Date</th></tr>
              ${d.recentPayments.map(p => `
                <tr>
                  <td>${p.guest_name}</td>
                  <td style="color:#10B981;font-weight:600">${formatCurrency(p.amount)}</td>
                  <td>${formatDate(p.payment_date)}</td>
                </tr>`).join('')}
            </table></div>`}
        </div>
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}

// ── GUESTS ───────────────────────────────────────
async function guests() {
  setContent('<div style="text-align:center;padding:60px"><div class="spinner"></div></div>');

  document.getElementById('topbar-actions').innerHTML =
    `<button class="btn btn-primary" onclick="addGuestModal()">+ Add Guest</button>`;

  try {
    const list = await API.getGuests();
    setContent(`
      <div class="card">
        <div class="flex justify-between items-center mb-4">
          <input type="text" id="guest-search" placeholder="🔍  Search by name or phone..." style="max-width:280px;margin:0" oninput="filterGuests(this.value)" />
          <span style="font-size:13px;color:#6B7280">${list.length} guests</span>
        </div>
        <div class="table-wrap">
          <table id="guests-table">
            <thead>
              <tr>
                <th>Name</th><th>Room</th><th>Phone</th>
                <th>Join Date</th><th>Monthly Rent</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.length === 0
                ? `<tr><td colspan="6"><div class="empty-state"><div class="icon">👩</div><p>No guests yet. Add your first guest!</p></div></td></tr>`
                : list.map(g => `
                <tr data-name="${g.name.toLowerCase()}" data-phone="${g.phone||''}">
                  <td>
                    <strong>${g.name}</strong><br>
                    <small style="color:#6B7280">${g.email||''}</small>
                  </td>
                  <td>${g.room_number ? `Room ${g.room_number}` : '<span style="color:#9CA3AF">Not assigned</span>'}</td>
                  <td>${g.phone || '—'}</td>
                  <td>${formatDate(g.join_date)}</td>
                  <td><strong>${formatCurrency(g.monthly_rent)}</strong>/mo</td>
                  <td>
                    <div class="flex gap-2">
                      <button class="btn btn-outline btn-sm" onclick="viewGuest(${g.id})">View</button>
                      <button class="btn btn-danger btn-sm" onclick="checkoutGuest(${g.id},'${g.name}')">Checkout</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}

function filterGuests(q) {
  document.querySelectorAll('#guests-table tbody tr[data-name]').forEach(tr => {
    const match = tr.dataset.name.includes(q.toLowerCase()) || tr.dataset.phone.includes(q);
    tr.style.display = match ? '' : 'none';
  });
}

async function addGuestModal(guestData = null) {
  let rooms = [];
  try { rooms = await API.getRooms(); } catch {}

  const g = guestData || {};
  openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>${g.id ? 'Edit Guest' : 'Add New Guest'}</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="guest-form-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group">
            <label>Full Name *</label>
            <input id="gf-name" value="${g.name||''}" placeholder="Enter full name" />
          </div>
          <div class="form-group">
            <label>Phone</label>
            <input id="gf-phone" value="${g.phone||''}" placeholder="Mobile number" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Email</label>
            <input id="gf-email" type="email" value="${g.email||''}" placeholder="Email address" />
          </div>
          <div class="form-group">
            <label>Emergency Contact</label>
            <input id="gf-emergency" value="${g.emergency_contact||''}" placeholder="Emergency phone" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Room</label>
            <select id="gf-room">
              <option value="">— Select Room —</option>
              ${rooms.map(r => `<option value="${r.id}" ${g.room_id==r.id?'selected':''}>
                Room ${r.room_number} (${r.available_beds} beds free)
              </option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Bed Number</label>
            <input id="gf-bed" type="number" value="${g.bed_number||''}" placeholder="e.g. 1, 2, 3" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Join Date *</label>
            <input id="gf-join" type="date" value="${g.join_date ? g.join_date.split('T')[0] : new Date().toISOString().split('T')[0]}" />
          </div>
          <div class="form-group">
            <label>Monthly Rent (₹)</label>
            <input id="gf-rent" type="number" value="${g.monthly_rent||''}" placeholder="e.g. 5000" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Deposit Amount (₹)</label>
            <input id="gf-deposit" type="number" value="${g.deposit_amount||''}" placeholder="e.g. 5000" />
          </div>
          <div class="form-group">
            <label>ID Proof Type</label>
            <select id="gf-idtype">
              <option value="">— Select —</option>
              ${['Aadhaar','PAN Card','Passport','Driving License','Voter ID'].map(t =>
                `<option value="${t}" ${g.id_proof_type==t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Notes</label>
          <textarea id="gf-notes" rows="2" placeholder="Any additional notes...">${g.notes||''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveGuest(${g.id||'null'})">
          ${g.id ? 'Save Changes' : 'Add Guest'}
        </button>
      </div>
    </div>
  `);
}

async function saveGuest(id) {
  const alert = document.getElementById('guest-form-alert');
  const data = {
    name: document.getElementById('gf-name').value.trim(),
    phone: document.getElementById('gf-phone').value.trim(),
    email: document.getElementById('gf-email').value.trim(),
    emergency_contact: document.getElementById('gf-emergency').value.trim(),
    room_id: document.getElementById('gf-room').value || null,
    bed_number: document.getElementById('gf-bed').value || null,
    join_date: document.getElementById('gf-join').value,
    monthly_rent: document.getElementById('gf-rent').value || 0,
    deposit_amount: document.getElementById('gf-deposit').value || 0,
    id_proof_type: document.getElementById('gf-idtype').value,
    notes: document.getElementById('gf-notes').value
  };

  if (!data.name) { showAlert(alert, 'Name is required'); return; }
  if (!data.join_date) { showAlert(alert, 'Join date is required'); return; }

  try {
    if (id) await API.updateGuest(id, data);
    else await API.createGuest(data);
    closeModal();
    guests();
  } catch (err) {
    showAlert(alert, err.message);
  }
}

async function viewGuest(id) {
  try {
    const g = await API.getGuest(id);
    openModal(`
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <h3>👩 ${g.name}</h3>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
            <div><small style="color:#6B7280">Phone</small><br><strong>${g.phone||'—'}</strong></div>
            <div><small style="color:#6B7280">Email</small><br><strong>${g.email||'—'}</strong></div>
            <div><small style="color:#6B7280">Room</small><br><strong>${g.room_number ? 'Room '+g.room_number : '—'}</strong></div>
            <div><small style="color:#6B7280">Bed</small><br><strong>${g.bed_number||'—'}</strong></div>
            <div><small style="color:#6B7280">Join Date</small><br><strong>${formatDate(g.join_date)}</strong></div>
            <div><small style="color:#6B7280">Monthly Rent</small><br><strong style="color:#10B981">${formatCurrency(g.monthly_rent)}</strong></div>
            <div><small style="color:#6B7280">Deposit</small><br><strong>${formatCurrency(g.deposit_amount)}</strong></div>
            <div><small style="color:#6B7280">Emergency</small><br><strong>${g.emergency_contact||'—'}</strong></div>
          </div>
          <h4 style="margin-bottom:12px">Payment History</h4>
          ${g.payments.length === 0
            ? '<p style="color:#9CA3AF;font-size:14px">No payments recorded</p>'
            : `<div class="table-wrap"><table>
              <tr><th>Date</th><th>Amount</th><th>Mode</th><th>Type</th></tr>
              ${g.payments.map(p => `
                <tr>
                  <td>${formatDate(p.payment_date)}</td>
                  <td style="color:#10B981;font-weight:600">${formatCurrency(p.amount)}</td>
                  <td>${p.payment_mode}</td>
                  <td>${p.payment_type}</td>
                </tr>`).join('')}
            </table></div>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeModal()">Close</button>
          <button class="btn btn-primary" onclick="closeModal();addGuestModal(${JSON.stringify(g).replace(/"/g,'&quot;')})">Edit</button>
          <button class="btn btn-success" onclick="closeModal();addPaymentModal(${g.id},'${g.name}')">Add Payment</button>
        </div>
      </div>
    `);
  } catch (err) {
    alert(err.message);
  }
}

async function checkoutGuest(id, name) {
  if (!confirm(`Checkout ${name}? This will mark them as inactive.`)) return;
  try {
    await API.checkoutGuest(id);
    guests();
  } catch (err) { alert(err.message); }
}

// ── ROOMS ────────────────────────────────────────
async function rooms() {
  setContent('<div style="text-align:center;padding:60px"><div class="spinner"></div></div>');
  document.getElementById('topbar-actions').innerHTML =
    `<button class="btn btn-primary" onclick="addRoomModal()">+ Add Room</button>`;

  try {
    const list = await API.getRooms();
    setContent(`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px">
        ${list.length === 0
          ? `<div class="empty-state" style="grid-column:1/-1">
              <div class="icon">🛏️</div><p>No rooms yet. Add your first room!</p>
             </div>`
          : list.map(r => {
            const pct = r.total_beds > 0 ? Math.round((r.occupied_beds / r.total_beds) * 100) : 0;
            const color = pct === 100 ? '#EF4444' : pct > 50 ? '#F59E0B' : '#10B981';
            return `
            <div class="card">
              <div class="flex justify-between items-center mb-4">
                <div>
                  <h3 style="font-size:18px;font-weight:700">Room ${r.room_number}</h3>
                  <p style="font-size:12px;color:#6B7280;text-transform:capitalize">${r.room_type} · Floor ${r.floor}</p>
                </div>
                <span class="badge ${pct===100?'badge-red':pct>50?'badge-amber':'badge-green'}">
                  ${pct}% Full
                </span>
              </div>
              <div style="background:#F3F4F6;border-radius:8px;padding:12px;margin-bottom:16px">
                <div class="flex justify-between mb-4">
                  <span style="font-size:13px">Beds</span>
                  <strong>${r.occupied_beds}/${r.total_beds} occupied</strong>
                </div>
                <div style="background:#E5E7EB;border-radius:4px;height:8px">
                  <div style="background:${color};border-radius:4px;height:8px;width:${pct}%;transition:width 0.3s"></div>
                </div>
              </div>
              <div class="flex justify-between items-center">
                <strong style="color:#10B981">${formatCurrency(r.monthly_rent)}/bed</strong>
                <div class="flex gap-2">
                  <button class="btn btn-outline btn-sm" onclick="editRoomModal(${JSON.stringify(r).replace(/"/g,'&quot;')})">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteRoom(${r.id},'${r.room_number}')">Delete</button>
                </div>
              </div>
              ${(r.guests||[]).length > 0 ? `
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid #E5E7EB">
                  <p style="font-size:12px;font-weight:600;color:#6B7280;margin-bottom:8px">GUESTS</p>
                  ${r.guests.map(g => `
                    <div style="font-size:13px;padding:4px 0">👩 ${g.name}${g.bed_number?' (Bed '+g.bed_number+')':''}</div>
                  `).join('')}
                </div>` : ''}
            </div>`;
          }).join('')}
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}

function addRoomModal(r = {}) {
  openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>${r.id ? 'Edit Room' : 'Add New Room'}</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="room-form-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group">
            <label>Room Number *</label>
            <input id="rf-num" value="${r.room_number||''}" placeholder="e.g. 101, A1" />
          </div>
          <div class="form-group">
            <label>Floor</label>
            <input id="rf-floor" type="number" value="${r.floor||1}" min="0" max="20" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Total Beds *</label>
            <input id="rf-beds" type="number" value="${r.total_beds||1}" min="1" max="20" />
          </div>
          <div class="form-group">
            <label>Room Type</label>
            <select id="rf-type">
              ${['shared','single','double','bunk','dormitory'].map(t =>
                `<option value="${t}" ${r.room_type==t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Monthly Rent per Bed (₹)</label>
          <input id="rf-rent" type="number" value="${r.monthly_rent||''}" placeholder="e.g. 5000" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="rf-desc" rows="2" placeholder="e.g. AC room with attached bathroom">${r.description||''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveRoom(${r.id||'null'})">${r.id ? 'Save Changes' : 'Add Room'}</button>
      </div>
    </div>
  `);
}

function editRoomModal(r) { addRoomModal(r); }

async function saveRoom(id) {
  const alert = document.getElementById('room-form-alert');
  const data = {
    room_number: document.getElementById('rf-num').value.trim(),
    floor: document.getElementById('rf-floor').value,
    total_beds: document.getElementById('rf-beds').value,
    room_type: document.getElementById('rf-type').value,
    monthly_rent: document.getElementById('rf-rent').value || 0,
    description: document.getElementById('rf-desc').value
  };
  if (!data.room_number) { showAlert(alert, 'Room number required'); return; }
  try {
    if (id) await API.updateRoom(id, data);
    else await API.createRoom(data);
    closeModal();
    rooms();
  } catch (err) { showAlert(alert, err.message); }
}

async function deleteRoom(id, num) {
  if (!confirm(`Delete Room ${num}?`)) return;
  try { await API.deleteRoom(id); rooms(); }
  catch (err) { alert(err.message); }
}

// ── PAYMENTS ─────────────────────────────────────
async function payments() {
  setContent('<div style="text-align:center;padding:60px"><div class="spinner"></div></div>');
  document.getElementById('topbar-actions').innerHTML =
    `<button class="btn btn-primary" onclick="addPaymentModal()">+ Add Payment</button>`;

  try {
    const list = await API.getPayments();
    const total = list.reduce((s, p) => s + parseFloat(p.amount), 0);
    setContent(`
      <div class="stat-grid" style="margin-bottom:20px">
        <div class="stat-card green">
          <div class="label">Total Collected</div>
          <div class="value">${formatCurrency(total)}</div>
          <div class="sub">${list.length} payments</div>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Guest</th><th>Room</th><th>Amount</th><th>Mode</th><th>Type</th><th></th></tr>
            </thead>
            <tbody>
              ${list.length === 0
                ? `<tr><td colspan="7"><div class="empty-state"><div class="icon">💰</div><p>No payments recorded</p></div></td></tr>`
                : list.map(p => `
                <tr>
                  <td>${formatDate(p.payment_date)}</td>
                  <td><strong>${p.guest_name}</strong></td>
                  <td>${p.room_number||'—'}</td>
                  <td style="color:#10B981;font-weight:700">${formatCurrency(p.amount)}</td>
                  <td><span class="badge badge-blue">${p.payment_mode}</span></td>
                  <td>${p.payment_type}</td>
                  <td><button class="btn btn-danger btn-sm" onclick="deletePayment(${p.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}

async function addPaymentModal(guestId = null, guestName = '') {
  let guestList = [];
  try { guestList = await API.getGuests(); } catch {}

  openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>💰 Record Payment</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="pay-form-alert" class="alert alert-danger hidden"></div>
        <div class="form-group">
          <label>Guest *</label>
          <select id="pf-guest">
            <option value="">— Select Guest —</option>
            ${guestList.map(g => `<option value="${g.id}" ${g.id==guestId?'selected':''}>${g.name} ${g.room_number?'(Room '+g.room_number+')':''}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount (₹) *</label>
            <input id="pf-amount" type="number" placeholder="e.g. 5000" />
          </div>
          <div class="form-group">
            <label>Payment Date</label>
            <input id="pf-date" type="date" value="${new Date().toISOString().split('T')[0]}" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Payment Mode</label>
            <select id="pf-mode">
              ${['Cash','UPI','Bank Transfer','Cheque','Card'].map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Payment Type</label>
            <select id="pf-type">
              ${['Rent','Deposit','Advance','Other'].map(t => `<option value="${t.toLowerCase()}">${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>For Month</label>
          <input id="pf-month" placeholder="e.g. April 2024" />
        </div>
        <div class="form-group">
          <label>Notes</label>
          <textarea id="pf-notes" rows="2" placeholder="Any notes..."></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-success" onclick="savePayment()">Record Payment</button>
      </div>
    </div>
  `);
}

async function savePayment() {
  const alert = document.getElementById('pay-form-alert');
  const data = {
    guest_id: document.getElementById('pf-guest').value,
    amount: document.getElementById('pf-amount').value,
    payment_date: document.getElementById('pf-date').value,
    payment_mode: document.getElementById('pf-mode').value,
    payment_type: document.getElementById('pf-type').value,
    payment_for_month: document.getElementById('pf-month').value,
    notes: document.getElementById('pf-notes').value
  };
  if (!data.guest_id) { showAlert(alert, 'Please select a guest'); return; }
  if (!data.amount) { showAlert(alert, 'Please enter amount'); return; }
  try {
    await API.createPayment(data);
    closeModal();
    payments();
  } catch (err) { showAlert(alert, err.message); }
}

async function deletePayment(id) {
  if (!confirm('Delete this payment record?')) return;
  try { await API.deletePayment(id); payments(); }
  catch (err) { alert(err.message); }
}

// ── EXPENSES ─────────────────────────────────────
async function expenses() {
  setContent('<div style="text-align:center;padding:60px"><div class="spinner"></div></div>');
  document.getElementById('topbar-actions').innerHTML =
    `<button class="btn btn-primary" onclick="addExpenseModal()">+ Add Expense</button>`;

  try {
    const list = await API.getExpenses();
    const total = list.reduce((s, e) => s + parseFloat(e.amount), 0);
    setContent(`
      <div class="stat-grid" style="margin-bottom:20px">
        <div class="stat-card red">
          <div class="label">Total Expenses</div>
          <div class="value">${formatCurrency(total)}</div>
          <div class="sub">${list.length} records</div>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Paid To</th><th></th></tr>
            </thead>
            <tbody>
              ${list.length === 0
                ? `<tr><td colspan="6"><div class="empty-state"><div class="icon">🧾</div><p>No expenses recorded</p></div></td></tr>`
                : list.map(e => `
                <tr>
                  <td>${formatDate(e.expense_date)}</td>
                  <td><span class="badge badge-amber">${e.category}</span></td>
                  <td>${e.description||'—'}</td>
                  <td style="color:#EF4444;font-weight:700">${formatCurrency(e.amount)}</td>
                  <td>${e.paid_to||'—'}</td>
                  <td><button class="btn btn-danger btn-sm" onclick="deleteExpense(${e.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}

function addExpenseModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>🧾 Add Expense</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div id="exp-form-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group">
            <label>Amount (₹) *</label>
            <input id="ef-amount" type="number" placeholder="e.g. 2000" />
          </div>
          <div class="form-group">
            <label>Date</label>
            <input id="ef-date" type="date" value="${new Date().toISOString().split('T')[0]}" />
          </div>
        </div>
        <div class="form-group">
          <label>Category *</label>
          <select id="ef-cat">
            ${['Maintenance','Electricity','Water','Internet','Cleaning','Grocery','Furniture','Repairs','Salary','Other']
              .map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="ef-desc" rows="2" placeholder="What was this expense for?"></textarea>
        </div>
        <div class="form-group">
          <label>Paid To</label>
          <input id="ef-paid" placeholder="Vendor / person name" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="saveExpense()">Add Expense</button>
      </div>
    </div>
  `);
}

async function saveExpense() {
  const alert = document.getElementById('exp-form-alert');
  const data = {
    amount: document.getElementById('ef-amount').value,
    expense_date: document.getElementById('ef-date').value,
    category: document.getElementById('ef-cat').value,
    description: document.getElementById('ef-desc').value,
    paid_to: document.getElementById('ef-paid').value
  };
  if (!data.amount) { showAlert(alert, 'Amount required'); return; }
  try {
    await API.createExpense(data);
    closeModal();
    expenses();
  } catch (err) { showAlert(alert, err.message); }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  try { await API.deleteExpense(id); expenses(); }
  catch (err) { alert(err.message); }
}

// ── REPORTS ──────────────────────────────────────
async function reports() {
  document.getElementById('topbar-actions').innerHTML = '';
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  try {
    const [pays, exps, guestList] = await Promise.all([
      API.getPayments(`?month=${month}&year=${year}`),
      API.getExpenses(`?month=${month}&year=${year}`),
      API.getGuests()
    ]);

    const income = pays.reduce((s, p) => s + parseFloat(p.amount), 0);
    const expense = exps.reduce((s, e) => s + parseFloat(e.amount), 0);
    const profit = income - expense;

    // Category breakdown
    const cats = {};
    exps.forEach(e => { cats[e.category] = (cats[e.category]||0) + parseFloat(e.amount); });

    // Pending rent guests
    const paidGuestIds = new Set(pays.filter(p=>p.payment_type==='rent').map(p=>p.guest_id));
    const pendingGuests = guestList.filter(g => !paidGuestIds.has(g.id));

    setContent(`
      <h2 style="margin-bottom:20px;font-size:17px">📈 Report — ${now.toLocaleString('en-IN',{month:'long',year:'numeric'})}</h2>
      <div class="stat-grid mb-6">
        <div class="stat-card green">
          <div class="label">Income</div>
          <div class="value">${formatCurrency(income)}</div>
        </div>
        <div class="stat-card red">
          <div class="label">Expenses</div>
          <div class="value">${formatCurrency(expense)}</div>
        </div>
        <div class="stat-card ${profit>=0?'green':'red'}">
          <div class="label">Net Profit</div>
          <div class="value">${formatCurrency(profit)}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <h3 style="margin-bottom:16px;font-size:15px">Expense by Category</h3>
          ${Object.keys(cats).length === 0
            ? '<p style="color:#9CA3AF;font-size:14px">No expenses this month</p>'
            : Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([cat,amt]) => `
              <div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid #F3F4F6">
                <span style="font-size:14px">${cat}</span>
                <strong style="color:#EF4444">${formatCurrency(amt)}</strong>
              </div>`).join('')}
        </div>

        <div class="card">
          <h3 style="margin-bottom:16px;font-size:15px">🔴 Rent Pending (${pendingGuests.length})</h3>
          ${pendingGuests.length === 0
            ? '<p style="color:#10B981;font-size:14px">✅ All guests paid this month!</p>'
            : pendingGuests.map(g => `
              <div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid #F3F4F6">
                <div>
                  <strong style="font-size:14px">${g.name}</strong><br>
                  <small style="color:#6B7280">${g.phone||''} · ${g.room_number?'Room '+g.room_number:''}</small>
                </div>
                <span style="color:#EF4444;font-weight:600">${formatCurrency(g.monthly_rent)}</span>
              </div>`).join('')}
        </div>
      </div>
    `);
  } catch (err) {
    setContent(`<div class="alert alert-danger">${err.message}</div>`);
  }
}
