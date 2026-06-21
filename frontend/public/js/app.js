// js/app.js

// ── INIT ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (getToken()) { showApp(); navigate('dashboard'); loadInboxCount(); }
  else showLogin();
  setupLogin();
  setupNav();
  document.getElementById('logout-btn').addEventListener('click', () => { if(confirm('Logout?')) clearAuth(); });
  document.getElementById('menu-toggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
});

function showLogin() {
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const u = JSON.parse(localStorage.getItem('sm_user') || '{}');
  document.getElementById('topbar-user').textContent = u.username ? `👤 ${u.username}` : '';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', u.role !== 'admin'));
}

function setupLogin() {
  const btn = document.getElementById('login-btn');
  const doLogin = async () => {
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value;
    const al = document.getElementById('login-alert');
    if (!u||!p) { showAlert(al,'Enter username and password'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const d = await API.login(u, p);
      setToken(d.token);
      localStorage.setItem('sm_user', JSON.stringify(d.user));
      showApp(); navigate('dashboard'); loadInboxCount();
    } catch(e) { showAlert(al, e.message||'Login failed'); }
    finally { btn.disabled=false; btn.innerHTML='🔐 Login'; }
  };
  btn.addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keypress', e => { if(e.key==='Enter') doLogin(); });
}

function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
}

let currentPage = null;

function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page===page));
  const titles = { dashboard:'Dashboard', rooms:'Rooms', guests:'Guests', 'daily-menu':'Daily Menu', payments:'Payments', 'guest-messages':'Guest Messages', inbox:'Inbox', purchases:'Purchases', collections:'Collections', 'rent-due':'Rent Due', reports:'Reports', 'balance-sheet':'Balance Sheet', admin:'Admin' };
  document.getElementById('page-title').textContent = titles[page]||page;
  document.getElementById('topbar-actions').innerHTML = '';
  document.getElementById('sidebar').classList.remove('open');
  const pages = { dashboard:pgDashboard, rooms:pgRooms, guests:pgGuests, 'daily-menu':pgMenu, payments:pgPayments, 'guest-messages':pgAnnouncements, inbox:pgInbox, purchases:pgPurchases, collections:pgCollections, 'rent-due':pgRentDue, reports:pgReports, 'balance-sheet':pgBalanceSheet, admin:pgAdmin };
  if(pages[page]) pages[page]();
}

async function loadInboxCount() {
  try {
    const msgs = await API.getInbox();
    const unread = msgs.filter(m => !m.is_read).length;
    const badge = document.getElementById('inbox-badge');
    if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch {}
}

// ── HELPERS ───────────────────────────────────────
function setContent(html) { document.getElementById('page-content').innerHTML = html; }
function isAdmin() { return (JSON.parse(localStorage.getItem('sm_user') || '{}')).role === 'admin'; }
function showAlert(el, msg, type='danger') {
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
function fmt(n) { return '₹' + parseFloat(n||0).toLocaleString('en-IN', {minimumFractionDigits:0}); }
function fmtDate(d) { if(!d) return '—'; return new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}); }
function fmtMonth(d) { if(!d) return '—'; return new Date(d).toLocaleDateString('en-IN', {month:'short',year:'numeric'}); }
function openModal(html) {
  document.getElementById('modal-container').innerHTML = `<div class="modal-overlay" id="modal-overlay">${html}</div>`;
  document.getElementById('modal-overlay').addEventListener('click', e => { if(e.target.id==='modal-overlay') closeModal(); });
}
function closeModal() { stopPurchaseVoice(); document.getElementById('modal-container').innerHTML = ''; }
function loading() { setContent('<div class="loading-center"><div class="spinner"></div></div>'); }

// Generic CSV export for any already-loaded array of objects — columns is
// [{ label, get: (row) => value }]. Builds the file entirely client-side,
// no backend round trip needed since the data's already on screen.
function exportArrayToCsv(filename, columns, rows) {
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return (str.includes(',') || str.includes('"') || str.includes('\n'))
      ? '"' + str.replace(/"/g, '""') + '"'
      : str;
  };
  const lines = [columns.map(c => escapeCsv(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => escapeCsv(c.get(row))).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function nowDate() { return new Date().toISOString().split('T')[0]; }
function monthPicker(month, year, onChangeFn) {
  const n = new Date();
  const m = month || (n.getMonth()+1);
  const y = year || n.getFullYear();
  const val = `${y}-${String(m).padStart(2,'0')}`;
  return `<input type="month" id="month-picker" value="${val}" onchange="${onChangeFn}(this.value)" style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;cursor:pointer">`;
}

function onPurchasesMonthChange(value) {
  const [y, m] = value.split('-').map(Number);
  pgPurchases(m, y);
}
function onCollectionsMonthChange(value) {
  const [y, m] = value.split('-').map(Number);
  pgCollections(m, y);
}
function onReportsMonthChange(value) {
  const [y, m] = value.split('-').map(Number);
  pgReports(m, y);
}

// ── DASHBOARD ─────────────────────────────────────
async function pgDashboard() {
  loading();
  try {
    const d = await API.dashboard();
    setContent(`
      <div class="page-header"><h1>Dashboard</h1><p>Welcome to Siri Mane PG Management</p></div>
      <div class="stat-grid mb-6">
        <div class="stat-card">
          <div class="s-label">Total Guests</div>
          <div class="s-value">${d.totalGuests}</div>
          <div class="s-sub" style="color:var(--green)">Active residents</div>
        </div>
        <div class="stat-card">
          <div class="s-label">Rooms</div>
          <div class="s-value">${d.totalRooms}</div>
          <div class="s-sub" style="color:var(--blue)">${d.occupancyPercent}% occupancy</div>
        </div>
        <div class="stat-card">
          <div class="s-label">Monthly Revenue</div>
          <div class="s-value">${fmt(d.monthlyIncome)}</div>
          <div class="s-sub" style="color:var(--green)">From active guests</div>
        </div>
        <div class="stat-card">
          <div class="s-label">Available Beds</div>
          <div class="s-value">${d.availableBeds}</div>
          <div class="s-sub" style="color:var(--blue)">Beds free</div>
        </div>
      </div>
      <div class="stat-grid mb-6">
        <div class="stat-card green">
          <div class="s-label">This Month Income</div>
          <div class="s-value">${fmt(d.monthlyIncome)}</div>
          <div class="s-sub">Collections</div>
        </div>
        <div class="stat-card red">
          <div class="s-label">This Month Expense</div>
          <div class="s-value">${fmt(d.monthlyExpenses)}</div>
          <div class="s-sub">Purchases</div>
        </div>
        <div class="stat-card ${d.netProfit>=0?'green':'red'}">
          <div class="s-label">Net Profit</div>
          <div class="s-value">${fmt(d.netProfit)}</div>
          <div class="s-sub">This month</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>Recent Guests</h3>
          <button class="btn btn-primary btn-sm" onclick="navigate('guests')">View All</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>NAME</th><th>ROOM</th><th>CHECK-IN</th><th>STATUS</th></tr></thead>
            <tbody>
              ${d.recentGuests.length===0
                ? `<tr class="empty-row"><td colspan="4">No guests yet</td></tr>`
                : d.recentGuests.map(g=>`
                <tr>
                  <td><strong>${g.name}</strong><br><span class="text-muted">${g.phone||''}</span></td>
                  <td>${g.room_number?'Room '+g.room_number:'—'}</td>
                  <td>${fmtDate(g.join_date)}</td>
                  <td><span class="badge badge-green">Active</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

// ── ROOMS ─────────────────────────────────────────
async function pgRooms() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="roomModal()">+ Add Room</button>`;
  try {
    const list = await API.getRooms();
    setContent(`
      <div class="page-header"><h1>Rooms</h1><p>Manage rooms including bunk beds</p></div>
      <div class="card">
        <div class="card-header"><h3>All Rooms</h3><button class="btn btn-primary btn-sm" onclick="roomModal()">+ Add Room</button></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ROOM NO.</th><th>FLOOR</th><th>TYPE</th><th>CAPACITY</th><th>OCCUPIED</th><th>RENT</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="8">No rooms yet. Click Add Room to get started.</td></tr>`
                : list.map(r=>{
                  const occ = parseInt(r.occupied_beds)||0;
                  const full = occ >= r.total_beds;
                  return `<tr>
                    <td><strong>${r.room_number}</strong></td>
                    <td>Floor ${r.floor}</td>
                    <td style="text-transform:capitalize">${r.room_type}</td>
                    <td>${r.total_beds} beds</td>
                    <td>${occ}/${r.total_beds}</td>
                    <td>${fmt(r.monthly_rent)}/bed</td>
                    <td><span class="badge ${full?'badge-red':occ>0?'badge-amber':'badge-green'}">${full?'Full':occ>0?'Partial':'Available'}</span></td>
                    <td>
                      <div class="flex gap-2">
                        <button class="btn btn-outline btn-sm" onclick="roomModal(${JSON.stringify(r).replace(/"/g,'&quot;')})">Edit</button>
                        ${isAdmin()?`<button class="btn btn-danger btn-sm" onclick="delRoom(${r.id},'${r.room_number}')">Delete</button>`:''}
                      </div>
                    </td>
                  </tr>`;
                }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function roomModal(r={}) {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>${r.id?'Edit Room':'Add New Room'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="rm-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group"><label>Room Number *</label><input id="rm-num" value="${r.room_number||''}" placeholder="e.g. 101"/></div>
          <div class="form-group"><label>Floor</label><input id="rm-floor" type="number" value="${r.floor||1}" min="0"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Total Beds *</label><input id="rm-beds" type="number" value="${r.total_beds||1}" min="1"/></div>
          <div class="form-group"><label>Room Type</label>
            <select id="rm-type">${['shared','single','double','bunk','dormitory'].map(t=>`<option value="${t}" ${r.room_type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-group"><label>Monthly Rent per Bed (₹)</label><input id="rm-rent" type="number" value="${r.monthly_rent||''}" placeholder="e.g. 5000"/></div>
        <div class="form-group"><label>Description</label><textarea id="rm-desc" rows="2">${r.description||''}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveRoom(${r.id||'null'})">${r.id?'Save':'Add Room'}</button>
      </div>
    </div>`);
}

async function saveRoom(id) {
  const al = document.getElementById('rm-alert');
  const d = { room_number:document.getElementById('rm-num').value.trim(), floor:document.getElementById('rm-floor').value, total_beds:document.getElementById('rm-beds').value, room_type:document.getElementById('rm-type').value, monthly_rent:document.getElementById('rm-rent').value||0, description:document.getElementById('rm-desc').value };
  if(!d.room_number) { showAlert(al,'Room number required'); return; }
  try { if(id) await API.updateRoom(id,d); else await API.createRoom(d); closeModal(); pgRooms(); }
  catch(e) { showAlert(al,e.message); }
}

async function delRoom(id,num) {
  if(!confirm(`Delete Room ${num}?`)) return;
  try { await API.deleteRoom(id); pgRooms(); } catch(e) { alert(e.message); }
}

// ── GUESTS ────────────────────────────────────────
async function pgGuests() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="guestModal()">+ Add Guest</button>`;
  try {
    const list = await API.getGuests();
    const hasVariance = (g) => g.room_id && g.room_rent !== null && g.room_rent !== undefined && parseFloat(g.monthly_rent) !== parseFloat(g.room_rent);
    const pendingCount = list.filter(g => hasVariance(g) && !g.rent_variance_approved).length;
    setContent(`
      <div class="page-header"><h1>Guests</h1><p>Register and manage PG residents</p></div>
      ${pendingCount>0?`<div class="alert" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;margin-bottom:16px">⏳ ${pendingCount} guest${pendingCount>1?'s have':' has'} a rent that differs from their room's standard rate and ${pendingCount>1?'need':'needs'} your approval — look for the amber "Variance" badge below.</div>`:''}
      <div class="card">
        <div class="card-header">
          <h3>All Guests</h3>
          <div class="flex gap-2">
            <input type="text" placeholder="🔍 Search..." style="width:200px;margin:0" oninput="filterTable(this.value,'guests-tb')" />
            <button class="btn btn-primary btn-sm" onclick="guestModal()">+ Add Guest</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>NAME</th><th>PHONE</th><th>ROOM / BERTH</th><th>CHECK-IN</th><th>RENT</th><th>DEPOSIT</th><th>STATUS</th><th>DOCS</th><th>ACTIONS</th></tr></thead>
            <tbody id="guests-tb">
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="9">No guests yet. Click Add Guest to register.</td></tr>`
                : list.map(g=>{
                  const variance = hasVariance(g);
                  const needsApproval = variance && !g.rent_variance_approved;
                  return `
                <tr data-search="${g.name.toLowerCase()} ${g.phone||''}">
                  <td><strong>${g.name}</strong><br><span class="text-muted">${g.email||''}</span></td>
                  <td>${g.phone||'—'}</td>
                  <td>${g.room_number?'Room '+g.room_number+(g.bed_number?' / Bed '+g.bed_number:''):'-'}</td>
                  <td>${fmtDate(g.join_date)}</td>
                  <td>${fmt(g.monthly_rent)}/mo ${variance?`<span class="badge ${needsApproval?'badge-amber':'badge-blue'}" title="Room rate is ${fmt(g.room_rent)}">${needsApproval?'Pending Approval':'Variance'}</span>`:''}</td>
                  <td>${fmt(g.deposit_amount)}</td>
                  <td><span class="badge ${g.is_active?'badge-green':'badge-red'}">${g.is_active?'Active':'Left'}</span></td>
                  <td><span class="badge badge-gray">${g.id_proof_type||'—'}</span></td>
                  <td>
                    <div class="flex gap-2">
                      <button class="btn btn-outline btn-sm" onclick="viewGuest(${g.id})">View</button>
                      <button class="btn btn-primary btn-sm" onclick="guestModal(null,${g.id})">Edit</button>
                      ${needsApproval && isAdmin()?`<button class="btn btn-success btn-sm" onclick="approveRentVariance(${g.id})">Approve Rent</button>`:''}
                      ${g.is_active && isAdmin()?`<button class="btn btn-danger btn-sm" onclick="checkoutModal(${g.id})">Checkout</button>`:''}
                    </div>
                  </td>
                </tr>`;}).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function approveRentVariance(id) {
  if (!confirm('Approve this rent rate even though it differs from the room\'s standard rate?')) return;
  try { await API.approveRentVariance(id); pgGuests(); } catch(e) { alert(e.message); }
}

function filterTable(q, tbId) {
  document.querySelectorAll(`#${tbId} tr[data-search]`).forEach(tr => {
    tr.style.display = tr.dataset.search.includes(q.toLowerCase()) ? '' : 'none';
  });
}

async function guestModal(gData=null, id=null) {
  let g = gData || {};
  if(id) { try { g = await API.getGuest(id); } catch {} }
  let rooms = [];
  try { rooms = await API.getRooms(); } catch {}
  openModal(`
    <div class="modal modal-lg">
      <div class="modal-header"><h3>${g.id?'Edit Guest':'Add New Guest'}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="gf-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group"><label>Full Name *</label><input id="gf-name" value="${g.name||''}" placeholder="Full name"/></div>
          <div class="form-group"><label>Phone</label><input id="gf-phone" value="${g.phone||''}" placeholder="Mobile"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Email</label><input id="gf-email" type="email" value="${g.email||''}" placeholder="Email"/></div>
          <div class="form-group"><label>Emergency Contact</label><input id="gf-emg" value="${g.emergency_contact||''}" placeholder="Emergency phone"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Room</label>
            <select id="gf-room" onchange="checkRentVariance()">
              <option value="">— Select Room —</option>
              ${rooms.map(r=>`<option value="${r.id}" data-rent="${r.monthly_rent}" ${g.room_id==r.id?'selected':''}>Room ${r.room_number} (${r.available_beds} beds free)</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Bed / Berth Number</label><input id="gf-bed" type="number" value="${g.bed_number||''}" placeholder="1, 2..."/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Check-in Date *</label><input id="gf-join" type="date" value="${g.join_date?g.join_date.split('T')[0]:nowDate()}"/></div>
          <div class="form-group"><label>Monthly Rent (₹)</label><input id="gf-rent" type="number" value="${g.monthly_rent||''}" data-original="${g.monthly_rent||0}" placeholder="e.g. 5000" oninput="toggleRentEffectiveField();checkRentVariance()"/></div>
        </div>
        <div id="gf-rent-variance-warning" class="hidden" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:12px"></div>
        ${g.id ? `<div class="form-group" id="gf-rent-effective-wrap" style="display:none">
          <label>New rate effective from</label>
          <input id="gf-rent-effective" type="date" value="${nowDate()}"/>
          <p class="text-muted" style="font-size:11px;margin-top:4px">Only matters since you changed the rent above. Past months in their ledger keep using the old rate; only this date onward uses the new one.</p>
        </div>` : ''}
        <div class="form-row">
          <div class="form-group"><label>Deposit (₹)</label><input id="gf-dep" type="number" value="${g.deposit_amount||''}" placeholder="e.g. 5000"/></div>
          <div class="form-group"><label>ID Proof</label>
            <select id="gf-idtype">${['','Aadhaar','PAN Card','Passport','Driving License','Voter ID'].map(t=>`<option value="${t}" ${g.id_proof_type===t?'selected':''}>${t||'— Select —'}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-group"><label>Notes</label><textarea id="gf-notes" rows="2">${g.notes||''}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveGuest(${g.id||'null'})">${g.id?'Save Changes':'Add Guest'}</button>
      </div>
    </div>`);
  checkRentVariance();
}

function checkRentVariance() {
  const roomSel = document.getElementById('gf-room');
  const rentInput = document.getElementById('gf-rent');
  const warning = document.getElementById('gf-rent-variance-warning');
  if (!roomSel || !rentInput || !warning) return;
  const selectedOption = roomSel.options[roomSel.selectedIndex];
  const roomRent = selectedOption ? parseFloat(selectedOption.dataset.rent) : NaN;
  const guestRent = parseFloat(rentInput.value) || 0;
  if (roomSel.value && !isNaN(roomRent) && roomRent !== guestRent) {
    warning.textContent = `⚠️ This differs from this room's standard rate of ${fmt(roomRent)}/bed by ${fmt(Math.abs(roomRent - guestRent))}. ${isAdmin() ? 'You can save this — as admin, it\'s automatically approved.' : 'You can still save this, but it will be flagged for admin review until approved.'}`;
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }
}

function toggleRentEffectiveField() {
  const wrap = document.getElementById('gf-rent-effective-wrap');
  if (!wrap) return;
  const input = document.getElementById('gf-rent');
  const newVal = parseFloat(input.value) || 0;
  const orig = parseFloat(input.dataset.original) || 0;
  wrap.style.display = (newVal !== orig) ? 'block' : 'none';
}

async function saveGuest(id) {
  const al = document.getElementById('gf-alert');
  const rentEffectiveEl = document.getElementById('gf-rent-effective');
  const d = {
    name:document.getElementById('gf-name').value.trim(),
    phone:document.getElementById('gf-phone').value.trim(),
    email:document.getElementById('gf-email').value.trim(),
    emergency_contact:document.getElementById('gf-emg').value.trim(),
    room_id:document.getElementById('gf-room').value||null,
    bed_number:document.getElementById('gf-bed').value||null,
    join_date:document.getElementById('gf-join').value,
    monthly_rent:document.getElementById('gf-rent').value||0,
    deposit_amount:document.getElementById('gf-dep').value||0,
    id_proof_type:document.getElementById('gf-idtype').value,
    notes:document.getElementById('gf-notes').value,
    rent_effective_from: rentEffectiveEl ? rentEffectiveEl.value : null
  };
  if(!d.name) { showAlert(al,'Name is required'); return; }
  if(!d.join_date) { showAlert(al,'Check-in date required'); return; }
  try { if(id) await API.updateGuest(id,d); else await API.createGuest(d); closeModal(); pgGuests(); }
  catch(e) { showAlert(al,e.message); }
}

async function viewGuest(id) {
  try {
    const [g, ledgerData, history] = await Promise.all([
      API.getGuest(id),
      API.getGuestLedger(id).catch(()=>null),
      API.getRentHistory(id).catch(()=>[])
    ]);
    const balance = ledgerData ? parseFloat(ledgerData.current_balance) : null;
    const balanceLabel = balance===null ? '' : balance < -0.5 ? `${fmt(Math.abs(balance))} due` : balance > 0.5 ? `${fmt(balance)} credit` : 'Settled';
    const balanceClass = balance===null ? '' : balance < -0.5 ? 'text-red' : balance > 0.5 ? 'text-green' : 'text-muted';
    openModal(`
      <div class="modal modal-lg">
        <div class="modal-header"><h3>👤 ${g.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
            ${[['Phone',g.phone],['Email',g.email],['Room',g.room_number?'Room '+g.room_number:'—'],['Bed',g.bed_number||'—'],['Check-in',fmtDate(g.join_date)],['Rent',fmt(g.monthly_rent)+'/mo'],['Deposit',fmt(g.deposit_amount)],['Emergency',g.emergency_contact||'—']].map(([l,v])=>`
            <div style="background:#F8FAFC;padding:10px 12px;border-radius:8px;border:1px solid var(--border)">
              <div style="font-size:11px;color:var(--text-muted);font-weight:600">${l}</div>
              <div style="font-size:14px;font-weight:500;margin-top:2px">${v||'—'}</div>
            </div>`).join('')}
          </div>

          <div class="flex justify-between items-center mb-4">
            <h4 style="font-size:14px;margin:0">Rent Ledger</h4>
            ${balanceLabel?`<span class="fw-600 ${balanceClass}">Current balance: ${balanceLabel}</span>`:''}
          </div>
          ${!ledgerData
            ? '<p class="text-muted">Could not load ledger.</p>'
            : ledgerData.ledger.length===0
              ? '<p class="text-muted">No rent ledger yet — needs a join date and a monthly rent set.</p>'
              : `<div class="table-wrap mb-5"><table><thead><tr><th>MONTH</th><th>RENT DUE</th><th>RENT PAID</th><th>BALANCE</th></tr></thead><tbody>
                ${ledgerData.ledger.map(m=>`<tr>
                  <td>${m.label}</td>
                  <td>${fmt(m.rent_due)}</td>
                  <td class="text-green">${fmt(m.rent_paid)}</td>
                  <td class="${m.running_balance<-0.5?'text-red fw-600':m.running_balance>0.5?'text-green fw-600':''}">${m.running_balance<-0.5?fmt(Math.abs(m.running_balance))+' due':m.running_balance>0.5?fmt(m.running_balance)+' credit':'Settled'}</td>
                </tr>`).join('')}
                </tbody></table></div>
                <p class="text-muted" style="font-size:11px;margin-top:-12px;margin-bottom:18px">Based on payment dates, not the "For Month" text field — so an early or late payment is counted toward the month it was actually paid in.</p>`}

          <div class="flex justify-between items-center mb-4">
            <h4 style="font-size:14px;margin:0">Rent Rate History</h4>
            ${isAdmin()?`<button class="btn btn-outline btn-sm" onclick="rentHistoryModal(${g.id},'${g.name.replace(/'/g,"\\'")}')">+ Backfill a past change</button>`:''}
          </div>
          ${history.length===0
            ? '<p class="text-muted mb-5">No rate history recorded.</p>'
            : `<table class="mb-5"><thead><tr><th>EFFECTIVE FROM</th><th>RATE</th><th>SET BY</th><th>NOTE</th></tr></thead><tbody>
              ${history.map(h=>`<tr><td>${fmtDate(h.effective_from)}</td><td class="fw-600">${fmt(h.monthly_rent)}</td><td>${h.username||'—'}</td><td class="text-muted">${h.note||'—'}</td></tr>`).join('')}
              </tbody></table>`}

          <h4 style="margin-bottom:10px;font-size:14px">All Transactions</h4>
          ${g.payments.length===0
            ? '<p class="text-muted">No payments recorded</p>'
            : `<table><thead><tr><th>Date</th><th>Amount</th><th>Type</th><th>Mode</th></tr></thead><tbody>
              ${g.payments.map(p=>`<tr><td>${fmtDate(p.collection_date)}</td><td class="text-green fw-600">${fmt(p.amount)}</td><td>${p.collection_type}</td><td>${p.payment_mode}</td></tr>`).join('')}
              </tbody></table>`}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeModal()">Close</button>
          <button class="btn btn-primary" onclick="closeModal();guestModal(null,${g.id})">Edit</button>
          <button class="btn btn-success" onclick="closeModal();collectionModal(${g.id},'${g.name}')">Add Payment</button>
        </div>
      </div>`);
  } catch(e) { alert(e.message); }
}

function rentHistoryModal(guestId, guestName) {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>Backfill Past Rate — ${guestName}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="rh-alert" class="alert alert-danger hidden"></div>
        <p class="text-muted" style="font-size:12px;margin-bottom:14px">Use this only for a rent change that actually happened in the past, before this history feature existed. This will recalculate this guest's ledger for all months from the effective date onward.</p>
        <div class="form-group"><label>Rent Amount (₹) *</label><input id="rh-amt" type="number" placeholder="e.g. 6000"/></div>
        <div class="form-group"><label>Effective From *</label><input id="rh-date" type="date"/></div>
        <div class="form-group"><label>Note</label><input id="rh-note" placeholder="e.g. Increased after AC installed"/></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveRentHistory(${guestId})">Save</button>
      </div>
    </div>`);
}

async function saveRentHistory(guestId) {
  const al = document.getElementById('rh-alert');
  const d = {
    monthly_rent: document.getElementById('rh-amt').value,
    effective_from: document.getElementById('rh-date').value,
    note: document.getElementById('rh-note').value
  };
  if (!d.monthly_rent || !d.effective_from) { showAlert(al, 'Rent amount and effective date are both required'); return; }
  try { await API.addRentHistory(guestId, d); closeModal(); viewGuest(guestId); }
  catch(e) { showAlert(al, e.message); }
}

async function checkoutModal(id) {
  let g;
  try { g = await API.getGuest(id); } catch(e) { alert(e.message); return; }
  const deposit = parseFloat(g.deposit_amount) || 0;
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🚪 Checkout ${g.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="co-alert" class="alert alert-danger hidden"></div>
        <div style="background:#F8FAFC;padding:10px 12px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">DEPOSIT PAID</div>
          <div style="font-size:18px;font-weight:600">${fmt(deposit)}</div>
        </div>
        <div class="form-group"><label>Deductions (₹)</label><input id="co-deduct" type="number" placeholder="0" value="0" oninput="updateRefundPreview(${deposit})"/></div>
        <div class="form-group"><label>Deduction Reason</label><textarea id="co-notes" rows="2" placeholder="e.g. room damage, unpaid dues, cleaning charges"></textarea></div>
        <div class="form-group"><label>Refund Mode</label>
          <select id="co-mode">${['Cash','UPI','Bank Transfer','Cheque'].map(m=>`<option>${m}</option>`).join('')}</select>
        </div>
        <div style="background:var(--primary-light);padding:10px 12px;border-radius:8px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">REFUND TO PAY</div>
          <div id="co-refund-preview" style="font-size:18px;font-weight:600;color:var(--primary-dark)">${fmt(deposit)}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitCheckout(${id})">Confirm Checkout</button>
      </div>
    </div>`);
}

function updateRefundPreview(deposit) {
  const deduct = parseFloat(document.getElementById('co-deduct').value) || 0;
  const refund = deposit - deduct;
  const el = document.getElementById('co-refund-preview');
  el.textContent = fmt(refund);
  el.style.color = refund < 0 ? 'var(--red)' : 'var(--primary-dark)';
  if (refund < 0) el.textContent += ' (guest owes this)';
}

async function submitCheckout(id) {
  const al = document.getElementById('co-alert');
  const d = {
    deductions: document.getElementById('co-deduct').value || 0,
    deduction_notes: document.getElementById('co-notes').value,
    refund_mode: document.getElementById('co-mode').value
  };
  if (!confirm('This will check the guest out and finalize the deposit refund. Continue?')) return;
  try {
    await API.checkoutGuestWithRefund(id, d);
    closeModal();
    pgGuests();
  } catch(e) { showAlert(al, e.message); }
}

// ── DAILY MENU ────────────────────────────────────
async function pgMenu() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="menuModal()">+ Add Menu</button>`;
  try {
    const items = await API.getMenu();
    const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const meals = ['Breakfast','Lunch','Dinner'];
    const byDay = {};
    days.forEach(d => { byDay[d] = {}; });
    items.forEach(i => { if(byDay[i.day_of_week]) byDay[i.day_of_week][i.meal_type] = i; });

    setContent(`
      <div class="page-header flex justify-between items-center mb-5">
        <div><h1>Daily Menu</h1><p>Set daily food menu for guests</p></div>
        <button class="btn btn-primary btn-sm" onclick="menuModal()">+ Add Menu</button>
      </div>
      <div class="card">
        <div class="card-header"><h3>Weekly Menu</h3></div>
        ${items.length===0
          ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">🍽️<br><br>No menu added yet.</div>'
          : `<div style="overflow-x:auto">
            <table>
              <thead><tr><th>DAY</th>${meals.map(m=>`<th>${m.toUpperCase()}</th>`).join('')}<th>ACTIONS</th></tr></thead>
              <tbody>
                ${days.map(day => `<tr>
                  <td><strong>${day}</strong></td>
                  ${meals.map(meal => {
                    const item = byDay[day][meal];
                    return `<td>${item ? `<span style="font-size:13px">${item.items}</span>` : '<span class="text-muted">—</span>'}</td>`;
                  }).join('')}
                  <td>
                    <button class="btn btn-outline btn-sm" onclick="menuModal('${day}')">Edit</button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>`}
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function menuModal(preDay='') {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const meals = ['Breakfast','Lunch','Dinner','Snacks'];
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🍽️ Add / Edit Menu</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="mn-alert" class="alert alert-danger hidden"></div>
        <div class="form-row">
          <div class="form-group"><label>Day *</label>
            <select id="mn-day">${days.map(d=>`<option value="${d}" ${d===preDay?'selected':''}>${d}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Meal Type *</label>
            <select id="mn-meal">${meals.map(m=>`<option value="${m}">${m}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-group"><label>Menu Items *</label><textarea id="mn-items" rows="3" placeholder="e.g. Idli, Sambar, Chutney, Coffee"></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveMenu()">Save</button>
      </div>
    </div>`);
}

async function saveMenu() {
  const al = document.getElementById('mn-alert');
  const d = { day_of_week:document.getElementById('mn-day').value, meal_type:document.getElementById('mn-meal').value, items:document.getElementById('mn-items').value.trim() };
  if(!d.items) { showAlert(al,'Enter menu items'); return; }
  try { await API.saveMenu(d); closeModal(); pgMenu(); } catch(e) { showAlert(al,e.message); }
}

// ── PAYMENTS (same as collections) ───────────────
let paymentsCurrentMonth = null;
let paymentsCurrentYear = null;

async function pgPayments(month, year) {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Record Payment</button>`;
  try {
    const now = new Date();
    const m = month || (now.getMonth()+1);
    const y = year || now.getFullYear();
    paymentsCurrentMonth = m;
    paymentsCurrentYear = y;
    const list = await API.getCollections(`?month=${m}&year=${y}`);
    const total = list.reduce((s,c)=>s+parseFloat(c.amount),0);
    setContent(`
      <div class="page-header flex justify-between items-center">
        <div><h1>Payments</h1><p>Track rent payments</p></div>
        <div class="flex items-center gap-2">
          <span style="font-size:13px;color:var(--text-muted)">Showing</span>
          ${monthPicker(m, y, 'onPaymentsMonthChange')}
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>Payment Records — ${fmt(total)} total</h3>
          <button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Record Payment</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>GUEST</th><th>MONTH</th><th>AMOUNT</th><th>DATE</th><th>MODE</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="7">No payments for this month.</td></tr>`
                : list.map(c=>`<tr>
                  <td><strong>${c.guest_name||c.guest_name||'—'}</strong></td>
                  <td>${c.collection_month||fmtMonth(c.collection_date)}</td>
                  <td class="text-green fw-600">${fmt(c.amount)}</td>
                  <td>${fmtDate(c.collection_date)}</td>
                  <td><span class="badge badge-blue">${c.payment_mode}</span></td>
                  <td><span class="badge ${c.status&&c.status.startsWith('pending')?'badge-amber':'badge-green'}">${c.status==='pending_verification'?'Pending Verification':c.status==='pending_approval'?'Pending Approval':'Received'}</span></td>
                  <td>${isAdmin()?`<button class="btn btn-danger btn-sm btn-icon" onclick="delCollectionFromPayments(${c.id})">✕</button>`:'—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function onPaymentsMonthChange(value) {
  const [y, m] = value.split('-').map(Number);
  pgPayments(m, y);
}

async function delCollectionFromPayments(id) {
  if(!confirm('Delete this record?')) return;
  try { await API.deleteCollection(id); pgPayments(paymentsCurrentMonth, paymentsCurrentYear); } catch(e) { alert(e.message); }
}

// ── GUEST MESSAGES (Announcements) ───────────────
async function pgAnnouncements() {
  loading();
  document.getElementById('topbar-actions').innerHTML = isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="announcementModal()">📢 Post Message</button>` : '';
  try {
    const list = await API.getAnnouncements();
    setContent(`
      <div class="page-header"><h1>Guest Messages</h1><p>Post announcements and notices to all guests</p></div>
      <div class="card">
        <div class="card-header"><h3>Posted Messages</h3>${isAdmin()?`<button class="btn btn-primary btn-sm" onclick="announcementModal()">📢 Post Message</button>`:''}</div>
        ${list.length===0
          ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">📢<br><br>No messages posted yet. Click Post Message.</div>'
          : `<div>
            ${list.map(a=>`
            <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
              <div class="flex justify-between items-center mb-4">
                <div class="flex items-center gap-2">
                  <span class="badge ${a.priority==='urgent'?'badge-red':a.priority==='important'?'badge-amber':'badge-blue'}">${a.priority}</span>
                  <strong style="font-size:14px">${a.title}</strong>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-muted" style="font-size:12px">${fmtDate(a.created_at)}</span>
                  ${isAdmin()?`<button class="btn btn-danger btn-sm btn-icon" onclick="delAnnouncement(${a.id})">✕</button>`:''}
                </div>
              </div>
              <p style="font-size:13px;color:var(--text-muted)">${a.message}</p>
            </div>`).join('')}
          </div>`}
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function announcementModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>📢 Post Message to Guests</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="an-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Title *</label><input id="an-title" placeholder="e.g. Water supply maintenance"/></div>
        <div class="form-group"><label>Priority</label>
          <select id="an-priority">
            <option value="normal">Normal</option>
            <option value="important">Important</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <div class="form-group"><label>Message *</label><textarea id="an-msg" rows="4" placeholder="Write your announcement here..."></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveAnnouncement()">Post Message</button>
      </div>
    </div>`);
}

async function saveAnnouncement() {
  const al = document.getElementById('an-alert');
  const d = { title:document.getElementById('an-title').value.trim(), message:document.getElementById('an-msg').value.trim(), priority:document.getElementById('an-priority').value };
  if(!d.title||!d.message) { showAlert(al,'Title and message required'); return; }
  try { await API.createAnnouncement(d); closeModal(); pgAnnouncements(); } catch(e) { showAlert(al,e.message); }
}

async function delAnnouncement(id) {
  if(!confirm('Delete this message?')) return;
  try { await API.deleteAnnouncement(id); pgAnnouncements(); } catch(e) { alert(e.message); }
}

// ── INBOX ─────────────────────────────────────────
async function pgInbox() {
  loading();
  try {
    const msgs = await API.getInbox();
    const unread = msgs.filter(m=>!m.is_read).length;
    loadInboxCount();
    setContent(`
      <div class="page-header"><h1>Guest Inbox</h1><p>Messages sent by guests — reply directly from here</p></div>
      <div class="card">
        <div class="card-header">
          <h3>All Messages from Guests ${unread>0?`<span class="badge badge-red" style="margin-left:6px">${unread} unread</span>`:''}</h3>
          <button class="btn btn-outline btn-sm" onclick="pgInbox()">🔄 Refresh</button>
        </div>
        ${msgs.length===0
          ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">📭<br><br>No messages from guests yet.</div>'
          : msgs.map(m=>`
          <div class="inbox-item ${!m.is_read?'unread':''}" onclick="viewInboxMsg(${JSON.stringify(m).replace(/"/g,'&quot;')})">
            <div class="flex justify-between items-center">
              <div>
                <strong style="font-size:14px">${m.guest_name}</strong>
                ${m.room_number?`<span class="text-muted"> · Room ${m.room_number}</span>`:''}
                ${!m.is_read?'<span class="unread-dot"></span>':''}
              </div>
              <span class="text-muted" style="font-size:12px">${fmtDate(m.created_at)}</span>
            </div>
            <div style="font-size:13px;font-weight:500;margin:4px 0">${m.subject||'No subject'}</div>
            <div class="text-muted" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.message}</div>
            ${m.reply?`<div style="margin-top:6px;padding:6px 10px;background:var(--green-light);border-radius:6px;font-size:12px;color:#065F46">✅ Replied</div>`:''}
          </div>`).join('')}
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function viewInboxMsg(m) {
  if(!m.is_read) { try { await API.markRead(m.id); } catch {} }
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>💬 Message from ${m.guest_name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div style="background:#F8FAFC;padding:14px;border-radius:8px;margin-bottom:16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${fmtDate(m.created_at)} · ${m.guest_phone||''} · ${m.room_number?'Room '+m.room_number:''}</div>
          <strong style="font-size:14px">${m.subject||'No subject'}</strong>
          <p style="margin-top:8px;font-size:14px">${m.message}</p>
        </div>
        ${m.reply?`<div style="background:var(--green-light);padding:12px;border-radius:8px;margin-bottom:14px"><div style="font-size:11px;color:#065F46;font-weight:600;margin-bottom:4px">YOUR REPLY</div><p style="font-size:13px;color:#065F46">${m.reply}</p></div>`:''}
        <div id="ib-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>${m.reply?'Update Reply':'Reply'}</label><textarea id="ib-reply" rows="3" placeholder="Type your reply...">${m.reply||''}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" onclick="replyMsg(${m.id})">Send Reply</button>
        <button class="btn btn-danger" onclick="delInboxMsg(${m.id})">Delete</button>
      </div>
    </div>`);
}

async function replyMsg(id) {
  const reply = document.getElementById('ib-reply').value.trim();
  if(!reply) { showAlert(document.getElementById('ib-alert'),'Write a reply'); return; }
  try { await API.replyInbox(id,reply); closeModal(); pgInbox(); } catch(e) { showAlert(document.getElementById('ib-alert'),e.message); }
}

async function delInboxMsg(id) {
  if(!confirm('Delete this message?')) return;
  try { await API.deleteInbox(id); closeModal(); pgInbox(); } catch(e) { alert(e.message); }
}

// ── PURCHASES (Expenses) ──────────────────────────
const PURCHASE_CATEGORIES = ['Groceries','Maintenance','Electricity','Water','Internet','Cleaning','Salary','Furniture','Repairs','Other'];
const PURCHASE_PAYMENT_MODES = ['Cash','UPI','Bank Transfer','Cheque'];

// Extra spoken phrases that map to a category/mode beyond its own name.
// Keep entries lowercase; longer/more specific phrases first so they match before shorter ones.
const PURCHASE_CATEGORY_SYNONYMS = {
  Groceries: ['vegetables','vegetable','veggies','ration','provisions','grocery'],
  Electricity: ['current bill','power bill','bescom','electric bill'],
  Water: ['water bill'],
  Internet: ['wifi','wi-fi','broadband'],
  Cleaning: ['cleaning supplies','housekeeping','sweeper','detergent'],
  Salary: ['wages','staff pay','payroll'],
  Furniture: ['sofa','mattress'],
  Repairs: ['repair','plumber','plumbing','electrician']
};
const PURCHASE_MODE_SYNONYMS = {
  UPI: ['gpay','google pay','phonepe','paytm'],
  'Bank Transfer': ['neft','imps','rtgs','bank'],
  Cheque: ['check']
};
const PURCHASE_VOICE_FILLER_WORDS = new Set(['rupees','rupee','rs','paid','to','for','the','a','an','of','and','by','via','in','using','bill','amount','is']);

let purchaseRecognition = null;
let purchaseListening = false;

let purchasesListCache = [];
let purchasesCurrentMonth = null;
let purchasesCurrentYear = null;

async function pgPurchases(month, year) {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="purchaseModal()">+ Add Purchase</button>`;
  try {
    const now = new Date();
    const m = month || (now.getMonth()+1);
    const y = year || now.getFullYear();
    purchasesCurrentMonth = m;
    purchasesCurrentYear = y;
    const list = await API.getPurchases(`?month=${m}&year=${y}`);
    purchasesListCache = list;
    const confirmedList = list.filter(p => p.status !== 'pending_approval');
    const total = confirmedList.reduce((s,p)=>s+parseFloat(p.amount),0);
    const byCat = {};
    confirmedList.forEach(p => { byCat[p.category]=(byCat[p.category]||0)+parseFloat(p.amount); });
    const pendingCount = list.filter(p => p.status === 'pending_approval').length;
    setContent(`
      <div class="page-header"><h1>🛒 Purchases</h1><p>Track all PG expenses and purchases</p></div>
      ${pendingCount>0?`<div class="alert" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;margin-bottom:16px">⏳ ${pendingCount} staff-entered purchase${pendingCount>1?'s':''} awaiting your approval below.</div>`:''}
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportPurchasesCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportPurchasesPdf()">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-5">
        <div class="stat-card red"><div class="s-label">This Month (Confirmed)</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${new Date(y,m-1,1).toLocaleString('en-IN',{month:'long',year:'numeric'})}</div></div>
        <div class="stat-card"><div class="s-label">Groceries</div><div class="s-value">${fmt(byCat['Groceries']||0)}</div><div class="s-sub" style="color:var(--green)">Food &amp; vegetables</div></div>
        <div class="stat-card"><div class="s-label">Maintenance</div><div class="s-value">${fmt(byCat['Maintenance']||0)}</div><div class="s-sub" style="color:var(--amber)">Repairs &amp; upkeep</div></div>
        <div class="stat-card"><div class="s-label">Utilities</div><div class="s-value">${fmt((byCat['Electricity']||0)+(byCat['Water']||0)+(byCat['Internet']||0))}</div><div class="s-sub" style="color:var(--blue)">Bills &amp; services</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Purchases</h3>
          <div class="flex gap-2 items-center">
            ${monthPicker(m, y, 'onPurchasesMonthChange')}
            <select id="cat-filter" style="margin:0" onchange="filterPurchases()">
              <option value="">All Categories</option>
              ${['Groceries','Maintenance','Electricity','Water','Internet','Cleaning','Salary','Other'].map(c=>`<option>${c}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="purchaseModal()">+ Add Purchase</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>CATEGORY</th><th>DESCRIPTION</th><th>AMOUNT</th><th>PAID TO</th><th>MODE</th><th>ACTIONS</th></tr></thead>
            <tbody id="purchases-tb">${renderPurchaseRows(list)}</tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function purchaseModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🛒 Add Purchase</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="pu-alert" class="alert alert-danger hidden"></div>
        <div class="voice-row">
          <button type="button" id="pu-mic-btn" class="mic-btn" onclick="togglePurchaseVoice()" title="Speak to fill this form" aria-label="Fill purchase by voice">🎤</button>
          <span id="pu-voice-status" class="voice-status">Tap the mic and say something like "500 rupees groceries paid to Ramesh cash"</span>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Amount (₹) *</label><input id="pu-amt" type="number" placeholder="e.g. 500"/></div>
          <div class="form-group"><label>Date</label><input id="pu-date" type="date" value="${nowDate()}"/></div>
        </div>
        <div class="form-group"><label>Category *</label>
          <select id="pu-cat">
            ${PURCHASE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Description</label><textarea id="pu-desc" rows="2" placeholder="What was purchased?"></textarea></div>
        <div class="form-row">
          <div class="form-group"><label>Paid To</label><input id="pu-paid" placeholder="Vendor name"/></div>
          <div class="form-group"><label>Payment Mode</label>
            <select id="pu-mode">${PURCHASE_PAYMENT_MODES.map(m=>`<option>${m}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="savePurchase()">Add Purchase</button>
      </div>
    </div>`);
  if (!getSpeechRecognitionCtor()) {
    const micBtn = document.getElementById('pu-mic-btn');
    const statusEl = document.getElementById('pu-voice-status');
    if (micBtn) micBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Voice input isn\'t supported in this browser. Try Chrome.';
  }
}

function renderPurchaseRows(list) {
  return list.length===0
    ? `<tr class="empty-row"><td colspan="7">No purchases found for this filter.</td></tr>`
    : list.map(p=>{
      const pending = p.status === 'pending_approval';
      return `<tr ${pending?'style="background:#FFFBEB"':''}>
      <td>${fmtDate(p.purchase_date)}</td>
      <td><span class="badge badge-amber">${p.category}</span> ${pending?'<span class="badge badge-amber">Pending</span>':''}</td>
      <td>${p.description||'—'}</td>
      <td class="text-red fw-600">${fmt(p.amount)}</td>
      <td>${p.paid_to||'—'}</td>
      <td>${p.payment_mode}</td>
      <td>${pending && isAdmin()
        ? `<div class="flex gap-2"><button class="btn btn-primary btn-sm" onclick="confirmPendingPurchase(${p.id})">Approve</button><button class="btn btn-danger btn-sm btn-icon" onclick="delPurchase(${p.id})">✕</button></div>`
        : isAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" onclick="delPurchase(${p.id})">✕</button>` : '—'}</td>
    </tr>`;}).join('');
}

function filterPurchases() {
  const cat = document.getElementById('cat-filter').value;
  const filtered = cat ? purchasesListCache.filter(p => p.category === cat) : purchasesListCache;
  document.getElementById('purchases-tb').innerHTML = renderPurchaseRows(filtered);
}

function exportPurchasesCsv() {
  exportArrayToCsv(
    `sirimane-purchases-${purchasesCurrentMonth}-${purchasesCurrentYear}.csv`,
    [
      { label: 'Date', get: p => fmtDate(p.purchase_date) },
      { label: 'Category', get: p => p.category },
      { label: 'Description', get: p => p.description },
      { label: 'Amount', get: p => p.amount },
      { label: 'Paid To', get: p => p.paid_to },
      { label: 'Mode', get: p => p.payment_mode },
      { label: 'Status', get: p => p.status }
    ],
    purchasesListCache
  );
}

async function exportPurchasesPdf() {
  try { await API.downloadExport(`/purchases/export/pdf?month=${purchasesCurrentMonth}&year=${purchasesCurrentYear}`, `sirimane-purchases-${purchasesCurrentMonth}-${purchasesCurrentYear}.pdf`); }
  catch(e) { alert('Export failed: ' + e.message); }
}

async function confirmPendingPurchase(id) {
  if(!confirm('Approve this purchase as confirmed spend?')) return;
  try { await API.confirmPurchase(id); pgPurchases(purchasesCurrentMonth, purchasesCurrentYear); } catch(e) { alert(e.message); }
}

async function savePurchase() {
  const al = document.getElementById('pu-alert');
  const d = { amount:document.getElementById('pu-amt').value, purchase_date:document.getElementById('pu-date').value, category:document.getElementById('pu-cat').value, description:document.getElementById('pu-desc').value, paid_to:document.getElementById('pu-paid').value, payment_mode:document.getElementById('pu-mode').value };
  if(!d.amount) { showAlert(al,'Amount required'); return; }
  try {
    await API.createPurchase(d);
    closeModal();
    // Jump to whichever month the purchase was actually dated, so it's
    // immediately visible instead of vanishing into a different month's view.
    const dt = d.purchase_date ? new Date(d.purchase_date) : new Date();
    pgPurchases(dt.getMonth()+1, dt.getFullYear());
  } catch(e) { showAlert(al,e.message); }
}

async function delPurchase(id) {
  if(!confirm('Delete?')) return;
  try { await API.deletePurchase(id); pgPurchases(purchasesCurrentMonth, purchasesCurrentYear); } catch(e) { alert(e.message); }
}

// ── VOICE INPUT FOR PURCHASES ──────────────────────
function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function togglePurchaseVoice() {
  if (purchaseListening) stopPurchaseVoice();
  else startPurchaseVoice();
}

function startPurchaseVoice() {
  const Ctor = getSpeechRecognitionCtor();
  const micBtn = document.getElementById('pu-mic-btn');
  const statusEl = document.getElementById('pu-voice-status');
  if (!Ctor) {
    if (statusEl) { statusEl.textContent = 'Voice input isn\'t supported in this browser. Try Chrome.'; statusEl.classList.add('voice-error'); }
    return;
  }
  if (!micBtn || !statusEl) return; // modal isn't open

  stopPurchaseVoice(); // make sure no stale instance is still running

  try {
    const rec = new Ctor();
    purchaseRecognition = rec;
    rec.lang = 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      purchaseListening = true;
      micBtn.classList.add('listening');
      micBtn.textContent = '⏹';
      statusEl.classList.remove('voice-error');
      statusEl.textContent = 'Listening… speak now';
    };

    rec.onresult = (e) => {
      try {
        const transcript = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
        if (!transcript) {
          statusEl.textContent = 'Didn\'t catch that, tap the mic and try again';
          statusEl.classList.add('voice-error');
          return;
        }
        statusEl.classList.remove('voice-error');
        statusEl.textContent = `Heard: "${transcript}"`;
        parsePurchaseVoiceText(transcript);
      } catch (err) {
        statusEl.textContent = 'Couldn\'t process that, please fill the form manually';
        statusEl.classList.add('voice-error');
      }
    };

    rec.onerror = (e) => {
      const messages = {
        'no-speech': 'Didn\'t hear anything, tap the mic and try again',
        'audio-capture': 'No microphone found on this device',
        'not-allowed': 'Microphone permission denied, allow it in your browser settings',
        'network': 'Network error, check your connection and try again',
        'aborted': ''
      };
      const msg = e && e.error in messages ? messages[e.error] : 'Voice input failed, please fill the form manually';
      if (msg) { statusEl.textContent = msg; statusEl.classList.add('voice-error'); }
    };

    rec.onend = () => {
      purchaseListening = false;
      purchaseRecognition = null;
      micBtn.classList.remove('listening');
      micBtn.textContent = '🎤';
    };

    rec.start();
  } catch (err) {
    purchaseListening = false;
    purchaseRecognition = null;
    statusEl.textContent = 'Could not start voice input on this device';
    statusEl.classList.add('voice-error');
  }
}

function stopPurchaseVoice() {
  if (purchaseRecognition) {
    try { purchaseRecognition.stop(); } catch (err) { /* already stopped, ignore */ }
  }
  purchaseRecognition = null;
  purchaseListening = false;
  const micBtn = document.getElementById('pu-mic-btn');
  if (micBtn) { micBtn.classList.remove('listening'); micBtn.textContent = '🎤'; }
}

function setVoicePurchaseField(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === '') return;
  el.value = value;
  el.classList.add('voice-filled');
  setTimeout(() => el.classList.remove('voice-filled'), 900);
}

function parsePurchaseVoiceText(rawText) {
  try {
    const text = (rawText || '').trim();
    if (!text) return;
    let lower = text.toLowerCase();

    // Amount: first number in the phrase (supports decimals like "499.50")
    const amtMatch = lower.match(/\d+(\.\d+)?/);
    if (amtMatch) {
      setVoicePurchaseField('pu-amt', amtMatch[0]);
      lower = lower.replace(amtMatch[0], ' ');
    }

    // Category: check longer synonym phrases before the bare category name
    let matchedCategory = null;
    for (const cat of PURCHASE_CATEGORIES) {
      const candidates = (PURCHASE_CATEGORY_SYNONYMS[cat] || []).concat([cat.toLowerCase()]);
      const hit = candidates.find(phrase => lower.includes(phrase));
      if (hit) { matchedCategory = cat; lower = lower.replace(hit, ' '); break; }
    }
    if (matchedCategory) setVoicePurchaseField('pu-cat', matchedCategory);

    // Payment mode: check synonyms before the bare mode name
    let matchedMode = null;
    for (const mode of PURCHASE_PAYMENT_MODES) {
      const candidates = (PURCHASE_MODE_SYNONYMS[mode] || []).concat([mode.toLowerCase()]);
      const hit = candidates.find(phrase => lower.includes(phrase));
      if (hit) { matchedMode = mode; lower = lower.replace(hit, ' '); break; }
    }
    if (matchedMode) setVoicePurchaseField('pu-mode', matchedMode);

    // Vendor: look for "paid to X" or "to X" in the original (non-lowercased) text
    let vendor = null;
    const paidToMatch = text.match(/paid\s+to\s+([a-zA-Z][a-zA-Z\s]{0,30}?)(?:\s+(?:by|via|in|using|cash|upi|bank|cheque|check)\b|$)/i);
    const toMatch = !paidToMatch ? text.match(/\bto\s+([a-zA-Z][a-zA-Z\s]{0,30}?)(?:\s+(?:by|via|in|using|cash|upi|bank|cheque|check)\b|$)/i) : null;
    const vendorMatch = paidToMatch || toMatch;
    if (vendorMatch) {
      vendor = vendorMatch[1].trim().replace(/\s+/g, ' ');
      if (vendor) {
        vendor = vendor.charAt(0).toUpperCase() + vendor.slice(1);
        setVoicePurchaseField('pu-paid', vendor);
        lower = lower.replace(vendor.toLowerCase(), ' ');
      }
    }

    // Description: whatever's left, with filler/connector words stripped out
    const leftoverWords = lower
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !PURCHASE_VOICE_FILLER_WORDS.has(w));
    const description = leftoverWords.join(' ').trim();
    if (description) {
      setVoicePurchaseField('pu-desc', description.charAt(0).toUpperCase() + description.slice(1));
    }
  } catch (err) {
    const statusEl = document.getElementById('pu-voice-status');
    if (statusEl) { statusEl.textContent = 'Couldn\'t fully parse that, please check the fields'; statusEl.classList.add('voice-error'); }
  }
}

// ── COLLECTIONS (Income) ──────────────────────────
let collectionsListCache = [];
let collectionsCurrentMonth = null;
let collectionsCurrentYear = null;

async function pgCollections(month, year) {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Add Collection</button>`;
  try {
    const now = new Date();
    const m = month || (now.getMonth()+1);
    const y = year || now.getFullYear();
    collectionsCurrentMonth = m;
    collectionsCurrentYear = y;
    const list = await API.getCollections(`?month=${m}&year=${y}`);
    collectionsListCache = list;
    const confirmedList = list.filter(c => c.status === 'confirmed' || !c.status);
    const total = confirmedList.reduce((s,c)=>s+parseFloat(c.amount),0);
    const byType = {};
    confirmedList.forEach(c => { byType[c.collection_type]=(byType[c.collection_type]||0)+parseFloat(c.amount); });
    const pendingVerificationCount = list.filter(c => c.status === 'pending_verification').length;
    const pendingApprovalCount = list.filter(c => c.status === 'pending_approval').length;
    setContent(`
      <div class="page-header"><h1>💵 Collections</h1><p>Track all income — rent, deposits, and extra charges</p></div>
      ${pendingVerificationCount>0?`<div class="alert" style="background:var(--amber-light,#FFFBEB);border:1px solid var(--amber,#F59E0B);color:#92400E;margin-bottom:10px">⏳ ${pendingVerificationCount} resident-reported UPI payment${pendingVerificationCount>1?'s':''} awaiting your confirmation below — check your bank/UPI app, then confirm or reject.</div>`:''}
      ${pendingApprovalCount>0?`<div class="alert" style="background:var(--amber-light,#FFFBEB);border:1px solid var(--amber,#F59E0B);color:#92400E;margin-bottom:16px">⏳ ${pendingApprovalCount} staff-entered collection${pendingApprovalCount>1?'s':''} awaiting your approval below.</div>`:''}
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportCollectionsCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportCollectionsPdf()">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-5">
        <div class="stat-card green"><div class="s-label">This Month (Confirmed)</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${new Date(y,m-1,1).toLocaleString('en-IN',{month:'long',year:'numeric'})}</div></div>
        <div class="stat-card"><div class="s-label">Rent</div><div class="s-value">${fmt(byType['rent']||0)}</div><div class="s-sub" style="color:var(--green)">Monthly rent</div></div>
        <div class="stat-card"><div class="s-label">Deposits</div><div class="s-value">${fmt(byType['deposit']||0)}</div><div class="s-sub" style="color:var(--blue)">Security deposits</div></div>
        <div class="stat-card"><div class="s-label">Extra Charges</div><div class="s-value">${fmt(byType['extra']||byType['other']||0)}</div><div class="s-sub" style="color:var(--amber)">Laundry, food, etc.</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Collections</h3>
          <div class="flex gap-2 items-center">
            ${monthPicker(m, y, 'onCollectionsMonthChange')}
            <select id="coll-type-filter" style="margin:0" onchange="filterCollections()">
              <option value="">All Types</option>
              <option value="rent">Rent</option><option value="deposit">Deposit</option><option value="extra">Extra</option>
            </select>
            <button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Add Collection</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>TYPE</th><th>GUEST / FROM</th><th>DESCRIPTION</th><th>AMOUNT</th><th>MODE</th><th>ACTIONS</th></tr></thead>
            <tbody id="collections-tb">${renderCollectionRows(list)}</tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function renderCollectionRows(list) {
  return list.length===0
    ? `<tr class="empty-row"><td colspan="7">No collections found for this filter.</td></tr>`
    : list.map(c=>{
      const pendingVerification = c.status === 'pending_verification';
      const pendingApproval = c.status === 'pending_approval';
      const pending = pendingVerification || pendingApproval;
      return `<tr ${pending?'style="background:#FFFBEB"':''}>
      <td>${fmtDate(c.collection_date)}</td>
      <td><span class="badge badge-green" style="text-transform:capitalize">${c.collection_type}</span> ${pendingVerification?'<span class="badge badge-amber">Pending Verification</span>':pendingApproval?'<span class="badge badge-amber">Pending Approval</span>':''}</td>
      <td>${c.guest_name||'—'}</td>
      <td>${c.description||c.collection_month||'—'}</td>
      <td class="text-green fw-600">${fmt(c.amount)}</td>
      <td>${c.payment_mode}</td>
      <td>${pending && isAdmin()
        ? `<div class="flex gap-2"><button class="btn btn-primary btn-sm" onclick="confirmPendingCollection(${c.id})">${pendingApproval?'Approve':'Confirm'}</button><button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button></div>`
        : isAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button>` : '—'}</td>
    </tr>`;}).join('');
}

function filterCollections() {
  const type = document.getElementById('coll-type-filter').value;
  const filtered = type ? collectionsListCache.filter(c => c.collection_type === type) : collectionsListCache;
  document.getElementById('collections-tb').innerHTML = renderCollectionRows(filtered);
}

function exportCollectionsCsv() {
  exportArrayToCsv(
    `sirimane-collections-${collectionsCurrentMonth}-${collectionsCurrentYear}.csv`,
    [
      { label: 'Date', get: c => fmtDate(c.collection_date) },
      { label: 'Type', get: c => c.collection_type },
      { label: 'Guest / From', get: c => c.guest_name },
      { label: 'Description', get: c => c.description || c.collection_month },
      { label: 'Amount', get: c => c.amount },
      { label: 'Mode', get: c => c.payment_mode },
      { label: 'Status', get: c => c.status }
    ],
    collectionsListCache
  );
}

async function exportCollectionsPdf() {
  try { await API.downloadExport(`/collections/export/pdf?month=${collectionsCurrentMonth}&year=${collectionsCurrentYear}`, `sirimane-collections-${collectionsCurrentMonth}-${collectionsCurrentYear}.pdf`); }
  catch(e) { alert('Export failed: ' + e.message); }
}

let collectionModalGuestId = null;

async function collectionModal(guestId=null, guestName='') {
  collectionModalGuestId = guestId;
  let guests = [];
  try { guests = await API.getGuests(); } catch {}
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>💵 Add Collection</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="cl-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Guest</label>
          <select id="cl-guest">
            <option value="">— Walk-in / Other —</option>
            ${guests.map(g=>`<option value="${g.id}" ${g.id==guestId?'selected':''}>${g.name}${g.room_number?' (Room '+g.room_number+')':''}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Amount (₹) *</label><input id="cl-amt" type="number" placeholder="e.g. 5000"/></div>
          <div class="form-group"><label>Date</label><input id="cl-date" type="date" value="${nowDate()}"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Type</label>
            <select id="cl-type">
              <option value="rent">Rent</option>
              <option value="deposit">Deposit</option>
              <option value="advance">Advance</option>
              <option value="extra">Extra Charges</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group"><label>Mode</label>
            <select id="cl-mode">${['Cash','UPI','Bank Transfer','Cheque','Card'].map(m=>`<option>${m}</option>`).join('')}</select>
          </div>
        </div>
        <div class="form-group"><label>For Month</label><input id="cl-month" placeholder="e.g. April 2024"/></div>
        <div class="form-group"><label>Description</label><textarea id="cl-desc" rows="2" placeholder="Notes..."></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-success" onclick="saveCollection()">Add Collection</button>
      </div>
    </div>`);
}

async function saveCollection() {
  const al = document.getElementById('cl-alert');
  const guestSel = document.getElementById('cl-guest');
  const guestId = guestSel.value;
  const guestName = guestId ? guestSel.options[guestSel.selectedIndex].text : '';
  const d = { guest_id:guestId||null, guest_name:guestName, amount:document.getElementById('cl-amt').value, collection_date:document.getElementById('cl-date').value, collection_type:document.getElementById('cl-type').value, payment_mode:document.getElementById('cl-mode').value, collection_month:document.getElementById('cl-month').value, description:document.getElementById('cl-desc').value };
  if(!d.amount) { showAlert(al,'Amount required'); return; }
  try {
    await API.createCollection(d);
    closeModal();
    // Jump to whichever month this was actually dated, so it's immediately
    // visible instead of vanishing into a different month's view. Return to
    // wherever the modal was actually opened from.
    const dt = d.collection_date ? new Date(d.collection_date) : new Date();
    if (collectionModalGuestId) viewGuest(collectionModalGuestId);
    else if (currentPage === 'payments') pgPayments(dt.getMonth()+1, dt.getFullYear());
    else pgCollections(dt.getMonth()+1, dt.getFullYear());
  } catch(e) { showAlert(al,e.message); }
}

async function delCollection(id) {
  if(!confirm('Delete this record?')) return;
  try { await API.deleteCollection(id); pgCollections(collectionsCurrentMonth, collectionsCurrentYear); } catch(e) { alert(e.message); }
}

async function confirmPendingCollection(id) {
  if(!confirm('Confirm this payment actually arrived in your bank/UPI app?')) return;
  try { await API.confirmCollection(id); pgCollections(collectionsCurrentMonth, collectionsCurrentYear); } catch(e) { alert(e.message); }
}

// ── RENT DUE TRACKER ──────────────────────────────
let rentDueListCache = [];

async function pgRentDue() {
  loading();
  document.getElementById('topbar-actions').innerHTML = '';
  try {
    const list = await API.getRentDue();
    rentDueListCache = list;
    const totalDue = list.reduce((s,g) => s + parseFloat(g.amount_due), 0);
    const fullyPaidCount = list.filter(g => parseFloat(g.amount_due) <= 0).length;
    setContent(`
      <div class="page-header"><h1>📅 Rent Due</h1><p>Running balance for each guest, carried forward across months — not just this month's snapshot</p></div>
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportRentDueCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportRentDuePdf()">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-5">
        <div class="stat-card red"><div class="s-label">Total Outstanding</div><div class="s-value">${fmt(totalDue)}</div><div class="s-sub">Across all guests</div></div>
        <div class="stat-card"><div class="s-label">Settled or Ahead</div><div class="s-value">${fullyPaidCount} / ${list.length}</div><div class="s-sub" style="color:var(--green)">Guests</div></div>
      </div>
      <div class="card">
        <div class="card-header"><h3>All Active Guests</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>NAME</th><th>ROOM</th><th>PHONE</th><th>MONTHLY RENT</th><th>BALANCE</th><th>STATUS</th></tr></thead>
            <tbody>
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="6">No guests with rent configured.</td></tr>`
                : list.map(g=>{
                  const due = parseFloat(g.amount_due);
                  const credit = parseFloat(g.credit);
                  return `<tr>
                  <td><strong>${g.name}</strong></td>
                  <td>${g.room_number?'Room '+g.room_number:'—'}</td>
                  <td>${g.phone||'—'}</td>
                  <td>${fmt(g.monthly_rent)}</td>
                  <td class="${due>0?'text-red fw-600':credit>0?'text-green fw-600':''}">${due>0?fmt(due)+' due':credit>0?fmt(credit)+' credit':'Settled'}</td>
                  <td><span class="badge ${due>0?'badge-red':'badge-green'}">${due>0?'Pending':credit>0?'Ahead':'Settled'}</span></td>
                </tr>`;}).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function exportRentDueCsv() {
  exportArrayToCsv(
    `sirimane-rent-due-${nowDate()}.csv`,
    [
      { label: 'Name', get: g => g.name },
      { label: 'Room', get: g => g.room_number },
      { label: 'Phone', get: g => g.phone },
      { label: 'Monthly Rent', get: g => g.monthly_rent },
      { label: 'Amount Due', get: g => g.amount_due },
      { label: 'Credit', get: g => g.credit }
    ],
    rentDueListCache
  );
}

async function exportRentDuePdf() {
  try { await API.downloadExport('/rent-due/export/pdf', `sirimane-rent-due-${nowDate()}.pdf`); }
  catch(e) { alert('Export failed: ' + e.message); }
}

// ── REPORTS ───────────────────────────────────────
let reportsMode = 'month';
let reportsRangeFrom = null;
let reportsRangeTo = null;

async function pgReports(month, year) {
  reportsMode = 'month';
  loading();
  const now = new Date();
  const m = month || (now.getMonth()+1); const y = year || now.getFullYear();
  try {
    const r = await API.getReports(m,y);
    const controls = `
      <span style="font-size:13px;color:var(--text-muted)">Select Month</span>
      ${monthPicker(m, y, 'onReportsMonthChange')}
      <button class="btn btn-outline btn-sm" onclick="switchReportsToRange()">Custom Range</button>`;
    setContent(renderReportsPage(r, controls));
    loadTrendChart();
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function pgReportsRange(from, to) {
  reportsMode = 'range';
  reportsRangeFrom = from;
  reportsRangeTo = to;
  loading();
  try {
    const r = await API.getReportsRange(from, to);
    const controls = `
      <input type="date" id="rep-from" value="${from}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
      <span style="font-size:13px;color:var(--text-muted)">to</span>
      <input type="date" id="rep-to" value="${to}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
      <button class="btn btn-primary btn-sm" onclick="applyReportsRange()">Apply</button>
      <button class="btn btn-outline btn-sm" onclick="switchReportsToMonth()">By Month</button>`;
    setContent(renderReportsPage(r, controls));
    loadTrendChart();
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function switchReportsToRange() {
  const now = new Date();
  const defaultFrom = reportsRangeFrom || new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
  const defaultTo = reportsRangeTo || now.toISOString().split('T')[0];
  pgReportsRange(defaultFrom, defaultTo);
}

function switchReportsToMonth() {
  pgReports();
}

function applyReportsRange() {
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  if (!from || !to) { alert('Pick both a from and to date'); return; }
  if (from > to) { alert('The "from" date has to be before the "to" date'); return; }
  pgReportsRange(from, to);
}

function renderReportsPage(r, controlsHtml) {
  return `
      <div class="page-header flex justify-between items-center">
        <div><h1>📋 Reports</h1><p>Profit &amp; Loss summary</p></div>
        <div class="flex items-center gap-2">${controlsHtml}</div>
      </div>
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportReport('csv','${r.dateFrom}','${r.dateTo}')">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportReport('pdf','${r.dateFrom}','${r.dateTo}')">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-6">
        <div class="stat-card" style="border-left:4px solid var(--green)">
          <div class="s-label">Total Income</div>
          <div class="s-value text-green">${fmt(r.totalIncome)}</div>
          <div class="s-sub" style="color:var(--green)">Collections</div>
        </div>
        <div class="stat-card" style="border-left:4px solid var(--red)">
          <div class="s-label">Total Expenses</div>
          <div class="s-value text-red">${fmt(r.totalExpenses)}</div>
          <div class="s-sub" style="color:var(--red)">Purchases</div>
        </div>
        <div class="stat-card" style="border-left:4px solid ${r.netProfit>=0?'var(--green)':'var(--red)'}">
          <div class="s-label">Net Profit / Loss</div>
          <div class="s-value ${r.netProfit>=0?'text-green':'text-red'}">${fmt(r.netProfit)}</div>
          <div class="s-sub ${r.netProfit>=0?'':'text-red'}">✅ ${r.netProfit>=0?'Profit':'Loss'}</div>
        </div>
      </div>
      <div class="two-col mb-6">
        <div class="card">
          <div class="card-header"><h3>💵 Income Breakdown</h3></div>
          <div class="card-body">
            ${r.incomeBreakdown.length===0
              ? '<div style="text-align:center;padding:32px;color:var(--text-muted)">💵<br><br>No collections in this period</div>'
              : r.incomeBreakdown.map(i=>`
              <div class="flex justify-between items-center" style="padding:10px 0;border-bottom:1px solid var(--border)">
                <span style="text-transform:capitalize;font-size:14px">${i.collection_type}</span>
                <strong class="text-green">${fmt(i.total)}</strong>
              </div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>🛒 Expense Breakdown</h3></div>
          <div class="card-body">
            ${r.expenseBreakdown.length===0
              ? '<div style="text-align:center;padding:32px;color:var(--text-muted)">🛒<br><br>No purchases in this period</div>'
              : r.expenseBreakdown.map(e=>`
              <div class="flex justify-between items-center" style="padding:10px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:14px">${e.category}</span>
                <strong class="text-red">${fmt(e.total)}</strong>
              </div>`).join('')}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>📈 Trend (Last 6 Months)</h3></div>
        <div class="card-body" id="trend-chart-wrap"><div class="loading-center"><div class="spinner"></div></div></div>
      </div>`;
}

async function exportReport(type, from, to) {
  try {
    if (type === 'csv') await API.downloadExport(`/reports/export/csv?from=${from}&to=${to}`, `sirimane-transactions-${from}-to-${to}.csv`);
    else await API.downloadExport(`/reports/export/pdf?from=${from}&to=${to}`, `sirimane-report-${from}-to-${to}.pdf`);
  } catch(e) { alert('Export failed: ' + e.message); }
}

async function loadTrendChart() {
  const wrap = document.getElementById('trend-chart-wrap');
  if (!wrap) return;
  try {
    const trend = await API.getReportsTrend(6);
    wrap.innerHTML = renderTrendChart(trend);
  } catch(e) {
    wrap.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}

function renderTrendChart(trend) {
  if (!trend.length) return '<div style="text-align:center;padding:32px;color:var(--text-muted)">No data yet</div>';
  const maxVal = Math.max(1, ...trend.map(t => Math.max(t.income, t.expenses)));
  const groupWidth = 90;
  const chartHeight = 180;
  const barMaxHeight = 130;
  const width = trend.length * groupWidth;

  const bars = trend.map((t, i) => {
    const x = i * groupWidth;
    const incH = (t.income / maxVal) * barMaxHeight;
    const expH = (t.expenses / maxVal) * barMaxHeight;
    const baseY = barMaxHeight + 10;
    return `
      <g>
        <rect x="${x+15}" y="${baseY-incH}" width="22" height="${incH}" fill="var(--green)" rx="2"><title>${t.label} Income: ${fmt(t.income)}</title></rect>
        <rect x="${x+45}" y="${baseY-expH}" width="22" height="${expH}" fill="var(--red)" rx="2"><title>${t.label} Expenses: ${fmt(t.expenses)}</title></rect>
        <text x="${x+45}" y="${baseY+18}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${t.label.split(' ')[0]}</text>
      </g>`;
  }).join('');

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${width} ${chartHeight}" width="${width}" height="${chartHeight}" style="min-width:${width}px">
        ${bars}
      </svg>
    </div>
    <div class="flex gap-4 mt-3" style="font-size:12px">
      <span><span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;margin-right:5px"></span>Income</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:var(--red);border-radius:2px;margin-right:5px"></span>Expenses</span>
    </div>`;
}

// ── BALANCE SHEET ──────────────────────────────────
let balanceSheetAsOf = null;

let balanceSheetAssetsCache = [];

async function pgBalanceSheet(asOf) {
  loading();
  document.getElementById('topbar-actions').innerHTML = '';
  const date = asOf || balanceSheetAsOf || nowDate();
  balanceSheetAsOf = date;
  try {
    const [bs, assets, capital] = await Promise.all([
      API.getBalanceSheet(date),
      API.getFixedAssets(),
      API.getCapitalTransactions()
    ]);
    balanceSheetAssetsCache = assets;
    const hasGap = Math.abs(bs.reconciliationDiff) > 0.5;
    setContent(`
      <div class="page-header flex justify-between items-center">
        <div><h1>⚖️ Balance Sheet</h1><p>What the business owns vs. owes, as of a point in time</p></div>
        <div class="flex items-center gap-2">
          <span style="font-size:13px;color:var(--text-muted)">As of</span>
          <input type="date" value="${date}" onchange="pgBalanceSheet(this.value)" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit"/>
        </div>
      </div>

      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportBalanceSheetPdf()">⬇ Export PDF</button>
        <button class="btn btn-outline btn-sm" onclick="exportFixedAssetsCsv()">⬇ Export Fixed Assets CSV</button>
      </div>`:''}

      ${hasGap?`<div class="alert" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;margin-bottom:16px">
        ⚠️ Reconciliation gap of ${fmt(Math.abs(bs.reconciliationDiff))}: deposits collected-minus-refunded don't match what's currently held per guest records. This usually means a deposit was collected but never logged as a Collection (or vice versa) — worth checking guest deposit amounts against the Collections history. This isn't a bug in the calculation; it's flagging a real data gap.
      </div>`:''}

      <div class="stat-grid mb-6" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-card" style="border-left:4px solid var(--blue)">
          <div class="s-label">Total Assets</div>
          <div class="s-value" style="color:var(--blue)">${fmt(bs.assets.total)}</div>
          <div class="s-sub">Cash + Fixed Assets</div>
        </div>
        <div class="stat-card" style="border-left:4px solid var(--red)">
          <div class="s-label">Total Liabilities</div>
          <div class="s-value text-red">${fmt(bs.liabilities.total)}</div>
          <div class="s-sub">Deposits held</div>
        </div>
        <div class="stat-card" style="border-left:4px solid var(--green)">
          <div class="s-label">Total Equity</div>
          <div class="s-value text-green">${fmt(bs.equity.total)}</div>
          <div class="s-sub">Capital + Retained Earnings</div>
        </div>
      </div>

      <div class="two-col mb-6">
        <div class="card">
          <div class="card-header"><h3>Assets</h3></div>
          <div class="card-body">
            <div class="flex justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>Cash Position</span><strong>${fmt(bs.assets.cashPosition)}</strong></div>
            <div class="flex justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>Fixed Assets (at cost)</span><strong>${fmt(bs.assets.fixedAssets)}</strong></div>
            <div class="flex justify-between" style="padding:10px 0;font-weight:600"><span>Total Assets</span><span>${fmt(bs.assets.total)}</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>Liabilities &amp; Equity</h3></div>
          <div class="card-body">
            <div class="flex justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>Security Deposits Held</span><strong>${fmt(bs.liabilities.depositsHeld)}</strong></div>
            <div class="flex justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>Capital (net)</span><strong>${fmt(bs.equity.capitalNet)}</strong></div>
            <div class="flex justify-between" style="padding:10px 0;border-bottom:1px solid var(--border)"><span>Retained Earnings</span><strong>${fmt(bs.equity.retainedEarnings)}</strong></div>
            <div class="flex justify-between" style="padding:10px 0;font-weight:600"><span>Total</span><span>${fmt(bs.liabilities.total + bs.equity.total)}</span></div>
          </div>
        </div>
      </div>

      <div class="card mb-6">
        <div class="card-header"><h3>🏠 Fixed Assets</h3><button class="btn btn-primary btn-sm" onclick="fixedAssetModal()">+ Add Asset</button></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>NAME</th><th>CATEGORY</th><th>VALUE</th><th>NOTES</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${assets.length===0
                ? `<tr class="empty-row"><td colspan="6">No fixed assets added yet.</td></tr>`
                : assets.map(a=>`<tr>
                  <td>${fmtDate(a.purchase_date)}</td>
                  <td><strong>${a.name}</strong></td>
                  <td><span class="badge badge-blue">${a.category}</span></td>
                  <td class="fw-600">${fmt(a.value)}</td>
                  <td class="text-muted">${a.notes||'—'}</td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delFixedAsset(${a.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>💰 Capital Transactions</h3><button class="btn btn-primary btn-sm" onclick="capitalModal()">+ Add Entry</button></div>
        <p class="text-muted" style="font-size:12px;padding:0 20px 12px">Money you've put into the business (positive) or taken out (negative) — separate from day-to-day rent and purchases.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>AMOUNT</th><th>NOTE</th><th>BY</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${capital.length===0
                ? `<tr class="empty-row"><td colspan="5">No capital transactions yet.</td></tr>`
                : capital.map(c=>`<tr>
                  <td>${fmtDate(c.transaction_date)}</td>
                  <td class="fw-600 ${parseFloat(c.amount)<0?'text-red':'text-green'}">${fmt(c.amount)}</td>
                  <td class="text-muted">${c.note||'—'}</td>
                  <td>${c.username||'—'}</td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delCapitalTransaction(${c.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function exportBalanceSheetPdf() {
  try { await API.downloadExport(`/balance-sheet/export/pdf?asOf=${balanceSheetAsOf}`, `sirimane-balance-sheet-${balanceSheetAsOf}.pdf`); }
  catch(e) { alert('Export failed: ' + e.message); }
}

function exportFixedAssetsCsv() {
  exportArrayToCsv(
    `sirimane-fixed-assets-${balanceSheetAsOf}.csv`,
    [
      { label: 'Date', get: a => fmtDate(a.purchase_date) },
      { label: 'Name', get: a => a.name },
      { label: 'Category', get: a => a.category },
      { label: 'Value', get: a => a.value },
      { label: 'Notes', get: a => a.notes }
    ],
    balanceSheetAssetsCache
  );
}

function fixedAssetModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🏠 Add Fixed Asset</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="fa-alert" class="alert alert-danger hidden"></div>
        <p class="text-muted" style="font-size:12px;margin-bottom:14px">If this purchase was already logged in Purchases as an expense, adding it here too will double-count it on the balance sheet. Use this only for assets you haven't separately expensed.</p>
        <div class="form-group"><label>Asset Name *</label><input id="fa-name" placeholder="e.g. Refrigerator"/></div>
        <div class="form-row">
          <div class="form-group"><label>Value (₹) *</label><input id="fa-value" type="number" placeholder="e.g. 15000"/></div>
          <div class="form-group"><label>Purchase Date *</label><input id="fa-date" type="date" value="${nowDate()}"/></div>
        </div>
        <div class="form-group"><label>Category</label>
          <select id="fa-cat"><option>Furniture</option><option>Appliances</option><option>Electronics</option><option>Vehicle</option><option>Other</option></select>
        </div>
        <div class="form-group"><label>Notes</label><textarea id="fa-notes" rows="2" placeholder="Optional"></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveFixedAsset()">Add Asset</button>
      </div>
    </div>`);
}

async function saveFixedAsset() {
  const al = document.getElementById('fa-alert');
  const d = {
    name: document.getElementById('fa-name').value.trim(),
    value: document.getElementById('fa-value').value,
    purchase_date: document.getElementById('fa-date').value,
    category: document.getElementById('fa-cat').value,
    notes: document.getElementById('fa-notes').value
  };
  if (!d.name || !d.value || !d.purchase_date) { showAlert(al, 'Name, value, and date are required'); return; }
  try { await API.createFixedAsset(d); closeModal(); pgBalanceSheet(balanceSheetAsOf); }
  catch(e) { showAlert(al, e.message); }
}

async function delFixedAsset(id) {
  if (!confirm('Remove this fixed asset?')) return;
  try { await API.deleteFixedAsset(id); pgBalanceSheet(balanceSheetAsOf); } catch(e) { alert(e.message); }
}

function capitalModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>💰 Add Capital Transaction</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="cap-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Amount (₹) *</label><input id="cap-amt" type="number" placeholder="Positive = put in, negative = took out"/></div>
        <div class="form-group"><label>Date *</label><input id="cap-date" type="date" value="${nowDate()}"/></div>
        <div class="form-group"><label>Note</label><input id="cap-note" placeholder="e.g. Initial investment"/></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveCapitalTransaction()">Add Entry</button>
      </div>
    </div>`);
}

async function saveCapitalTransaction() {
  const al = document.getElementById('cap-alert');
  const d = {
    amount: document.getElementById('cap-amt').value,
    transaction_date: document.getElementById('cap-date').value,
    note: document.getElementById('cap-note').value
  };
  if (!d.amount || !d.transaction_date) { showAlert(al, 'Amount and date are required'); return; }
  try { await API.createCapitalTransaction(d); closeModal(); pgBalanceSheet(balanceSheetAsOf); }
  catch(e) { showAlert(al, e.message); }
}

async function delCapitalTransaction(id) {
  if (!confirm('Remove this capital transaction?')) return;
  try { await API.deleteCapitalTransaction(id); pgBalanceSheet(balanceSheetAsOf); } catch(e) { alert(e.message); }
}

// ── ADMIN (Staff / Audit Log / Deposit Refunds) ───
let adminActiveTab = 'staff';

async function pgAdmin() {
  loading();
  document.getElementById('topbar-actions').innerHTML = '';
  renderAdminPage();
}

function renderAdminPage() {
  setContent(`
    <div class="page-header"><h1>🔐 Admin</h1><p>Staff accounts, audit trail, deposit refunds, and app settings</p></div>
    <div class="flex gap-2 mb-5">
      <button class="btn ${adminActiveTab==='staff'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('staff')">Staff Users</button>
      <button class="btn ${adminActiveTab==='audit'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('audit')">Audit Log</button>
      <button class="btn ${adminActiveTab==='refunds'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('refunds')">Deposit Refunds</button>
      <button class="btn ${adminActiveTab==='settings'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('settings')">Settings</button>
    </div>
    <div id="admin-tab-content"><div class="loading-center"><div class="spinner"></div></div></div>`);
  if (adminActiveTab === 'staff') renderAdminStaffTab();
  else if (adminActiveTab === 'audit') renderAdminAuditTab();
  else if (adminActiveTab === 'refunds') renderAdminRefundsTab();
  else renderAdminSettingsTab();
}

function switchAdminTab(tab) {
  adminActiveTab = tab;
  renderAdminPage();
}

async function renderAdminSettingsTab() {
  try {
    const settings = await API.getSettings();
    document.getElementById('admin-tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><h3>UPI Payment Settings</h3></div>
        <div style="padding:20px;max-width:480px">
          <div id="settings-alert" class="alert alert-danger hidden"></div>
          <p class="text-muted" style="font-size:12px;margin-bottom:16px">This is the UPI ID residents will pay rent to from their portal. It can be your existing personal or business UPI ID — no separate gateway or sign-up needed, and there's no fee since payments go directly to your bank.</p>
          <div class="form-group"><label>UPI ID (VPA)</label><input id="set-upi-vpa" placeholder="e.g. yourname@upi" value="${settings.upi_vpa||''}"/></div>
          <div class="form-group"><label>Display Name</label><input id="set-upi-name" placeholder="e.g. Siri Mane PG" value="${settings.upi_name||''}"/></div>
          <button class="btn btn-primary" onclick="saveAdminSettings()">Save Settings</button>
        </div>
      </div>`;
  } catch(e) { document.getElementById('admin-tab-content').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function saveAdminSettings() {
  const al = document.getElementById('settings-alert');
  const d = {
    upi_vpa: document.getElementById('set-upi-vpa').value.trim(),
    upi_name: document.getElementById('set-upi-name').value.trim()
  };
  try { await API.updateSettings(d); renderAdminSettingsTab(); }
  catch(e) { showAlert(al, e.message); }
}

async function renderAdminStaffTab() {
  try {
    const users = await API.getUsers();
    document.getElementById('admin-tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Staff &amp; Admin Accounts</h3><button class="btn btn-primary btn-sm" onclick="staffModal()">+ Add Staff</button></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>USERNAME</th><th>ROLE</th><th>CREATED</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${users.map(u=>`<tr>
                <td><strong>${u.username}</strong></td>
                <td><span class="badge ${u.role==='admin'?'badge-purple':'badge-blue'}">${u.role}</span></td>
                <td>${fmtDate(u.created_at)}</td>
                <td>${u.username!==JSON.parse(localStorage.getItem('sm_user')||'{}').username?`<button class="btn btn-danger btn-sm btn-icon" onclick="delStaffUser(${u.id},'${u.username}')">✕</button>`:'<span class="text-muted">You</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch(e) { document.getElementById('admin-tab-content').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

function staffModal() {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>+ Add Staff Account</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="st-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Username *</label><input id="st-username" placeholder="e.g. warden1"/></div>
        <div class="form-group"><label>Password *</label><input id="st-password" type="password" placeholder="At least 6 characters"/></div>
        <div class="form-group"><label>Role</label>
          <select id="st-role"><option value="staff">Staff (can't delete records or manage users)</option><option value="admin">Admin (full access)</option></select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveStaffUser()">Add Account</button>
      </div>
    </div>`);
}

async function saveStaffUser() {
  const al = document.getElementById('st-alert');
  const d = {
    username: document.getElementById('st-username').value.trim(),
    password: document.getElementById('st-password').value,
    role: document.getElementById('st-role').value
  };
  if (!d.username || !d.password) { showAlert(al, 'Username and password required'); return; }
  try { await API.createUser(d); closeModal(); renderAdminPage(); }
  catch(e) { showAlert(al, e.message); }
}

async function delStaffUser(id, username) {
  if (!confirm(`Remove staff account "${username}"? They will no longer be able to log in.`)) return;
  try { await API.deleteUser(id); renderAdminPage(); } catch(e) { alert(e.message); }
}

async function renderAdminAuditTab() {
  try {
    const log = await API.getActivityLog();
    document.getElementById('admin-tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Recent Activity</h3></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>WHEN</th><th>USER</th><th>ACTION</th><th>DETAILS</th></tr></thead>
            <tbody>
              ${log.length===0
                ? `<tr class="empty-row"><td colspan="4">No activity recorded yet.</td></tr>`
                : log.map(a=>`<tr>
                  <td style="white-space:nowrap">${new Date(a.created_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                  <td>${a.username||'—'}</td>
                  <td><span class="badge badge-gray">${a.action}</span></td>
                  <td>${a.details||'—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch(e) { document.getElementById('admin-tab-content').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function renderAdminRefundsTab() {
  try {
    const refunds = await API.getDepositRefunds();
    document.getElementById('admin-tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><h3>Deposit Refund History</h3></div>
        <p class="text-muted" style="font-size:12px;padding:0 20px 12px">Real checkouts shouldn't normally need deleting — this is here mainly for cleaning up test or mistaken entries.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>GUEST</th><th>ROOM</th><th>DEPOSIT</th><th>DEDUCTIONS</th><th>REFUNDED</th><th>MODE</th><th>BY</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${refunds.length===0
                ? `<tr class="empty-row"><td colspan="9">No checkouts processed yet.</td></tr>`
                : refunds.map(r=>`<tr>
                  <td>${fmtDate(r.created_at)}</td>
                  <td><strong>${r.guest_name}</strong></td>
                  <td>${r.room_number||'—'}</td>
                  <td>${fmt(r.deposit_amount)}</td>
                  <td class="text-red">${fmt(r.deductions)}${r.deduction_notes?` <span class="text-muted" style="font-size:11px">(${r.deduction_notes})</span>`:''}</td>
                  <td class="${parseFloat(r.refund_amount)<0?'text-red':'text-green'} fw-600">${fmt(r.refund_amount)}</td>
                  <td>${r.refund_mode}</td>
                  <td>${r.processed_by_username||'—'}</td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delDepositRefund(${r.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch(e) { document.getElementById('admin-tab-content').innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function delDepositRefund(id) {
  if (!confirm('Delete this refund record? This should only be used to clean up test or mistaken entries, not real checkouts.')) return;
  try { await API.deleteDepositRefund(id); renderAdminRefundsTab(); } catch(e) { alert(e.message); }
}
