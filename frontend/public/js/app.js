// js/app.js

// ── INIT ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (getToken()) { showApp(); initPhoneChrome(); navigate('dashboard'); loadInboxCount(); loadComplaintsCount(); }
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
      showApp(); initPhoneChrome(); navigate('dashboard'); loadInboxCount(); loadComplaintsCount();
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
  const titles = { dashboard:'Home', rooms:'Rooms', guests:'Residents', 'daily-menu':'Daily Menu', 'daily-checklist':'Daily Checklist', complaints:'Maintenance & Requests', payments:'Payments', 'guest-messages':'Announcements', inbox:'Inbox', purchases:'Purchases', collections:'Collections', 'rent-due':'Rent Due', reports:'Reports', 'balance-sheet':'Owner & Assets', admin:'Admin', collect:'Collect Rent', reminders:'Rent Reminders', finance:'Finance', operations:'Operations', 'finance-overview':'Finance', visitors:'Visitors', feedback:'Feedback', outbox:'Outbox', maintenance:'Recurring maintenance' };
  document.getElementById('page-title').textContent = titles[page]||page;
  document.getElementById('topbar-actions').innerHTML = '';
  document.getElementById('sidebar').classList.remove('open');
  if (typeof syncChrome === 'function') syncChrome(page);
  if (typeof bulkReset === 'function') bulkReset();
  highlightNav(page);
  if (typeof smSetContext === 'function') smSetContext({ page, resident_id: null, resident_name: null, room_number: null });
  // An answer belongs to the screen it was asked on; leaving the screen clears
  // it (a stale "48 reminders drafted" was riding along to every page). The one
  // exception is the refresh that follows a confirmed action — the result of
  // that action must stay on screen.
  if (window.__copilotKeep) { window.__copilotKeep = false; }
  else {
    const cOut = document.getElementById('copilot-out');
    if (cOut) { cOut.classList.add('hidden'); cOut.innerHTML = ''; }
    const cQ = document.getElementById('copilot-q');
    if (cQ) cQ.value = '';
  }
  const pages = { dashboard:pgHome, rooms:pgRoomMap, 'rooms-table':pgRooms, guests:pgGuests, 'daily-menu':pgMenu, 'daily-checklist':pgChecklist, complaints:pgComplaints, payments:pgPayments, 'guest-messages':pgAnnouncements, inbox:pgInbox, purchases:pgPurchases, collections:pgCollections, 'rent-due':pgRentDue, reports:pgReports, 'balance-sheet':pgBalanceSheet, admin:pgAdmin, collect:pgCollect, reminders:pgReminders, finance:pgFinance, operations:pgOperations, 'finance-overview':pgFinanceOverview, visitors:pgVisitors, feedback:pgFeedback, outbox:pgOutbox, maintenance:pgMaintenance };
  if(!pages[page]) return;
  // Error boundary: a thrown error inside any screen shows a retry card
  // instead of a blank page.
  Promise.resolve().then(() => pages[page]()).then(() => { try { injectSubtabs(page); } catch (e) { console.error(e); } }).catch(e => {
    console.error(e);
    setContent(`<div class="card" style="padding:32px;text-align:center">
      <div style="font-size:32px">⚠️</div>
      <h3 style="margin:10px 0 6px">This screen could not load</h3>
      <p class="text-muted" style="margin-bottom:16px">${(e && e.message) ? e.message : 'Unexpected error'}</p>
      <button class="btn btn-primary" onclick="navigate('${page}')">↻ Retry</button>
    </div>`);
  });
}

// Small bottom toast for errors that happen outside a screen's own try/catch
// (background badge refreshes, unhandled promise rejections, etc.).
let toastTimer = null;
function toast(msg, type='error') {
  let el = document.getElementById('sm-toast');
  if (!el) { el = document.createElement('div'); el.id = 'sm-toast'; document.body.appendChild(el); }
  el.className = 'sm-toast sm-toast-' + type;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
window.addEventListener('unhandledrejection', e => {
  const msg = e.reason && e.reason.message ? e.reason.message : 'Something went wrong';
  toast(msg);
});
window.addEventListener('offline', () => toast('You are offline — changes will not save until the connection returns'));
window.addEventListener('online', () => toast('Back online', 'ok'));

async function loadInboxCount() {
  try {
    const msgs = await API.getInbox();
    const unread = msgs.filter(m => !m.is_read).length;
    const badge = document.getElementById('inbox-badge');
    if (unread > 0) { badge.textContent = unread; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch {}
}

async function loadComplaintsCount() {
  try {
    const list = await API.getComplaints('all');
    const open = list.filter(c => c.status !== 'resolved').length;
    const badge = document.getElementById('complaints-badge');
    if (open > 0) { badge.textContent = open; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch {}
}

// ── HELPERS ───────────────────────────────────────
function setContent(html) {
  const el = document.getElementById('page-content');
  el.innerHTML = html;
  // Card up any table in the same tick, so a wide table never flashes on a
  // phone before the observer catches up.
  if (typeof mobilizeTables === 'function') { try { mobilizeTables(el); } catch (e) { console.error(e); } }
}
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
function closeModal() { stopPurchaseVoice(); document.getElementById('modal-container').innerHTML = ''; smSetContext({ resident_id: null, resident_name: null, room_number: null }); }
// Skeleton placeholders read as "content is coming" far better than a bare
// spinner on a slow 4G connection. Same call site as before.
function loading() {
  setContent('<div class="sm-skel"><div class="sm-skel-line" style="width:44%;height:22px"></div>'
    + '<div class="sm-skel-card"></div>'.repeat(4) + '</div>');
}

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
      <div class="card mb-6" id="brief-card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <h3 id="brief-greeting">☀️ Siri's Brief</h3>
          <div class="flex items-center gap-2">
            <span id="health-pill" class="health-pill hidden" title="Property health"></span>
            <button class="btn btn-outline btn-sm" onclick="loadBrief(true)" title="Recompute">↻</button>
          </div>
        </div>
        <div style="padding:14px 16px">
          <div id="brief-body"><div class="sm-skel"><div class="sm-skel-line" style="width:60%"></div><div class="sm-skel-line"></div><div class="sm-skel-line" style="width:80%"></div></div></div>
          <div class="flex gap-2" style="flex-wrap:wrap;margin-top:12px">
            <button class="btn btn-success btn-sm" id="brief-wa" onclick="shareBrief()">💬 WhatsApp</button>
            <button class="btn btn-outline btn-sm" onclick="copyBrief()">📋 Copy</button>
            <button class="btn btn-outline btn-sm" onclick="showEvening()">🌙 Evening summary</button>
          </div>
          <div id="brief-meta" class="text-muted" style="font-size:11px;margin-top:8px"></div>
        </div>
      </div>
      ${isAdmin() ? `<div class="card mb-6 hidden" id="attention-card">
        <div class="card-header"><h3>🚩 Needs attention</h3></div>
        <div id="attention-list" style="padding:6px 16px 10px"></div>
      </div>` : ''}
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
      ${d.pendingVariance.length>0 ? `
      <div class="card mb-6">
        <div class="card-header">
          <h3>⏳ Rent Approvals Pending</h3>
          <span class="badge badge-amber">${d.pendingVariance.length}</span>
        </div>
        <div style="padding:4px 20px 16px">
          ${d.pendingVariance.map(g => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface-2)">
              <span style="font-size:13px"><strong>${g.name}</strong>${g.room_number?' · Room '+g.room_number:''} — charging ${fmt(g.monthly_rent)}/mo (room rate ${fmt(g.room_rent)}/mo)</span>
              <button class="btn btn-success btn-sm" onclick="approveRentVariance(${g.id}, pgDashboard)">Approve</button>
            </div>`).join('')}
        </div>
      </div>` : ''}
      <div class="card mb-6" style="cursor:pointer" onclick="navigate('daily-checklist')">
        <div class="card-header">
          <h3>✅ Today's Warden Checklist</h3>
          <span class="text-muted" style="font-size:13px">${d.todayChecklist.checked} / ${d.todayChecklist.total} done</span>
        </div>
        <div style="padding:0 20px 16px">
          <div style="background:var(--border,var(--border));border-radius:8px;height:10px;overflow:hidden">
            <div style="background:${d.todayChecklist.percent>=100?'var(--green,#16A34A)':'var(--blue,#4F46E5)'};height:100%;width:${d.todayChecklist.percent}%;transition:width .3s"></div>
          </div>
          <div style="margin-top:6px;font-size:13px;color:var(--text-muted)">${d.todayChecklist.percent}% complete for today — tap to open</div>
        </div>
      </div>
      <div class="card mb-6" style="cursor:pointer" onclick="navigate('complaints')">
        <div class="card-header">
          <h3>🛠️ Complaint / Maintenance Register</h3>
          <span class="badge ${d.openComplaints>0?'badge-red':'badge-green'}">${d.openComplaints} open</span>
        </div>
        <div style="padding:0 20px 16px;font-size:13px;color:var(--text-muted)">${d.openComplaints>0?`${d.openComplaints} issue(s) still open — tap to review and update status`:'No open issues right now — tap to view history'}</div>
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
      loadBrief(false);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

// ── ROOMS ─────────────────────────────────────────
let roomsListCache = [];

async function pgRooms() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="roomModal()">+ Add Room</button>`;
  try {
    const list = await API.getRooms();
    roomsListCache = list;
    const floors = [...new Set(list.map(r => r.floor))].sort((a,b)=>a-b);
    setContent(`
      <div class="page-header"><h1>Rooms</h1><p>Manage rooms including bunk beds</p></div>
      <div class="card">
        <div class="card-header">
          <h3>All Rooms</h3>
          <div class="flex gap-2" style="flex-wrap:wrap">
            <select id="room-floor-filter" style="margin:0" onchange="filterRooms()">
              <option value="">All Floors</option>
              ${floors.map(f=>`<option value="${f}">Floor ${f}</option>`).join('')}
            </select>
            <select id="room-status-filter" style="margin:0" onchange="filterRooms()">
              <option value="">All Status</option>
              <option value="available">Available</option>
              <option value="partial">Partial</option>
              <option value="full">Full</option>
            </select>
            <input type="text" id="room-search" placeholder="🔍 Search room, floor, type..." style="width:200px;margin:0" oninput="filterRooms()" />
            <button class="btn btn-primary btn-sm" onclick="roomModal()">+ Add Room</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ROOM NO.</th><th>FLOOR</th><th>TYPE</th><th>CAPACITY</th><th>OCCUPIED</th><th>RENT</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
            <tbody id="rooms-tb">${renderRoomRows(list)}</tbody>
          </table>
        </div>
      </div>
    `);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function renderRoomRows(list) {
  if (list.length === 0) return `<tr class="empty-row"><td colspan="8">No rooms match.</td></tr>`;
  return list.map(r=>{
    const occ = parseInt(r.occupied_beds)||0;
    const full = occ >= r.total_beds;
    return `<tr data-search="${r.room_number.toLowerCase()} floor ${r.floor} ${r.room_type.toLowerCase()}">
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
  }).join('');
}

function filterRooms() {
  const floor = document.getElementById('room-floor-filter')?.value || '';
  const status = document.getElementById('room-status-filter')?.value || '';
  const q = (document.getElementById('room-search')?.value || '').toLowerCase().trim();
  let rows = roomsListCache;
  if (floor) rows = rows.filter(r => String(r.floor) === floor);
  if (status) rows = rows.filter(r => {
    const occ = parseInt(r.occupied_beds)||0;
    const full = occ >= r.total_beds;
    const s = full ? 'full' : occ>0 ? 'partial' : 'available';
    return s === status;
  });
  if (q) rows = rows.filter(r => `${r.room_number} floor ${r.floor} ${r.room_type}`.toLowerCase().includes(q));
  document.getElementById('rooms-tb').innerHTML = renderRoomRows(rows);
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
let guestsCurrentFilter = 'active';
let guestsListCache = [];

async function pgGuests(filter) {
  loading();
  const f = filter || guestsCurrentFilter;
  guestsCurrentFilter = f;
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="moveInWizard()">+ Add resident</button>`;
  try {
    const list = await API.getGuests('?active=all');
    guestsListCache = list;
    const filtered = f === 'active' ? list.filter(g=>g.is_active) : f === 'left' ? list.filter(g=>!g.is_active) : list;
    const hasVariance = (g) => g.room_id && g.room_rent !== null && g.room_rent !== undefined && parseFloat(g.monthly_rent) !== parseFloat(g.room_rent);
    const pendingCount = list.filter(g => hasVariance(g) && !g.rent_variance_approved).length;
    const leftCount = list.filter(g=>!g.is_active).length;
  const leavingCount = guestsListCache.filter(g => g.is_active && g.expected_checkout && new Date(g.expected_checkout) <= new Date(Date.now() + 30 * 86400000)).length;
    const rooms = [...new Set(list.filter(g=>g.room_number).map(g => g.room_number))].sort();
    setContent(`
      <div class="page-header"><h1>Residents</h1><p>Register and manage the people living here</p></div>
      ${pendingCount>0?`<div class="alert" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;margin-bottom:16px">⏳ ${pendingCount} guest${pendingCount>1?'s have':' has'} a rent that differs from their room's standard rate and ${pendingCount>1?'need':'needs'} your approval — look for the amber "Variance" badge below.</div>`:''}
      <div class="flex gap-2 mb-4" style="flex-wrap:wrap">
        <button class="btn ${f==='active'?'btn-primary':'btn-outline'} btn-sm" onclick="pgGuests('active')">Active</button>
        <button class="btn ${f==='leaving'?'btn-primary':'btn-outline'} btn-sm" onclick="pgGuests('leaving')">Leaving soon (${leavingCount})</button>
        <button class="btn ${f==='left'?'btn-primary':'btn-outline'} btn-sm" onclick="pgGuests('left')">Left (${leftCount})</button>
        <button class="btn ${f==='all'?'btn-primary':'btn-outline'} btn-sm" onclick="pgGuests('all')">All</button>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All residents</h3>
          <div class="flex gap-2" style="flex-wrap:wrap">
            <select id="guest-room-filter" style="margin:0" onchange="filterGuests()">
              <option value="">All Rooms</option>
              ${rooms.map(r=>`<option value="${r}">Room ${r}</option>`).join('')}
            </select>
            <select id="guest-docs-filter" style="margin:0" onchange="filterGuests()">
              <option value="">All Docs</option>
              <option value="present">Docs on File</option>
              <option value="missing">Docs Missing</option>
            </select>
            <input type="text" id="guest-search" placeholder="🔍 Search..." style="width:200px;margin:0" oninput="filterGuests()" />
            <button class="btn btn-primary btn-sm" onclick="moveInWizard()">+ Add resident</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th class="bulk-th" scope="col"><span class="sr-only">Select</span></th><th scope="col">NAME</th><th scope="col">PHONE</th><th scope="col">ROOM / BERTH</th><th scope="col">CHECK-IN</th><th scope="col">RENT</th><th scope="col">DEPOSIT</th><th scope="col">STATUS</th><th scope="col">DOCS</th><th scope="col">ACTIONS</th></tr></thead>
            <tbody id="guests-tb">${renderGuestRows(filtered, f)}</tbody>
          </table>
        </div>
      </div>`);
    bulkSetup('guests', [
      { action: 'announcement', label: 'Post notice', icon: 'megaphone' },
      { action: 'documents', label: 'Mark documents', icon: 'receipt' }
    ]);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function renderGuestRows(filtered, f) {
  if (filtered.length === 0) return `<tr class="empty-row"><td colspan="10">${f==='left'?'Nobody has checked out yet.':'No resident matches.'}</td></tr>`;
  const hasVariance = (g) => g.room_id && g.room_rent !== null && g.room_rent !== undefined && parseFloat(g.monthly_rent) !== parseFloat(g.room_rent);
  return filtered.map(g=>{
    const variance = hasVariance(g);
    const needsApproval = variance && !g.rent_variance_approved;
    return `
    <tr data-search="${g.name.toLowerCase()} ${g.phone||''}" style="${!g.is_active?'opacity:0.55':''}">
      <td class="bulk-td">${bulkCb(g.id, g.name)}</td>
      <td><strong style="${!g.is_active?'text-decoration:line-through':''}">${g.name}</strong><br><span class="text-muted">${g.email||''}</span></td>
      <td style="${!g.is_active?'text-decoration:line-through':''}">${g.phone||'—'}</td>
      <td style="${!g.is_active?'text-decoration:line-through':''}">${g.room_number?'Room '+g.room_number+(g.bed_number?' / Bed '+g.bed_number:''):'-'}</td>
      <td>${fmtDate(g.join_date)}${!g.is_active && g.leave_date ? `<br><span class="text-muted" style="font-size:11px">→ ${fmtDate(g.leave_date)}</span>` : ''}</td>
      <td style="${!g.is_active?'text-decoration:line-through':''}">${fmt(g.monthly_rent)}/mo ${variance?`<span class="badge ${needsApproval?'badge-amber':'badge-blue'}" title="Room rate is ${fmt(g.room_rent)}">${needsApproval?'Pending Approval':'Variance'}</span>`:''}</td>
      <td style="${!g.is_active?'text-decoration:line-through':''}">${fmt(g.deposit_amount)}</td>
      <td><span class="badge ${g.is_active?'badge-green':'badge-red'}">${g.is_active?'Active':'Left'}</span></td>
      <td><span class="badge badge-gray">${g.id_proof_type||'—'}</span></td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="residentProfile(${g.id})">View</button>
          <button class="btn btn-primary btn-sm" onclick="guestModal(null,${g.id})">Edit</button>
          ${needsApproval && isAdmin()?`<button class="btn btn-success btn-sm" onclick="approveRentVariance(${g.id})">Approve Rent</button>`:''}
          ${g.is_active && isAdmin()?`<button class="btn btn-outline btn-sm" onclick="roomShiftModal(${g.id},'${g.name.replace(/'/g,"\\'")}')">Shift Room</button>`:''}
          ${g.is_active && isAdmin()?`<button class="btn btn-danger btn-sm" onclick="checkoutWizard(${g.id})">Checkout</button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function filterGuests() {
  const room = document.getElementById('guest-room-filter')?.value || '';
  const docs = document.getElementById('guest-docs-filter')?.value || '';
  const q = (document.getElementById('guest-search')?.value || '').toLowerCase().trim();
  const f = guestsCurrentFilter;
  let rows = f === 'active' ? guestsListCache.filter(g=>g.is_active)
    : f === 'left' ? guestsListCache.filter(g=>!g.is_active)
    // "Leaving soon" = still here, with an expected checkout inside 30 days.
    : f === 'leaving' ? guestsListCache.filter(g => g.is_active && g.expected_checkout && new Date(g.expected_checkout) <= new Date(Date.now() + 30 * 86400000))
    : guestsListCache;
  if (room) rows = rows.filter(g => g.room_number === room);
  if (docs === 'present') rows = rows.filter(g => !!g.id_proof_type);
  else if (docs === 'missing') rows = rows.filter(g => !g.id_proof_type);
  if (q) rows = rows.filter(g => `${g.name} ${g.phone||''}`.toLowerCase().includes(q));
  document.getElementById('guests-tb').innerHTML = renderGuestRows(rows, f);
  if (typeof bulkSyncBoxes === 'function') bulkSyncBoxes();
}

async function approveRentVariance(id, refresh) {
  if (!confirm('Approve this rent rate even though it differs from the room\'s standard rate?')) return;
  try { await API.approveRentVariance(id); (refresh || pgGuests)(); } catch(e) { alert(e.message); }
}

function filterTable(q, containerId) {
  document.querySelectorAll(`#${containerId} [data-search]`).forEach(el => {
    el.style.display = el.dataset.search.includes(q.toLowerCase()) ? '' : 'none';
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
        <div class="voice-row">
          <button type="button" id="gf-scan-btn" class="mic-btn" style="background:var(--amber)" onclick="guestScanId()" title="Photograph the ID proof" aria-label="Scan ID">📷</button>
          <span id="gf-scan-status" class="voice-status">Tap 📷 to photograph her Aadhaar / ID — name, address and ID number fill in for you to check. The photo is never stored.</span>
        </div>
        <div id="gf-preview" class="hidden"></div>
        <div class="form-row">
          <div class="form-group"><label>Full Name *</label><input id="gf-name" value="${g.name||''}" placeholder="Full name"/></div>
          <div class="form-group"><label>Phone</label><input id="gf-phone" value="${g.phone||''}" placeholder="Mobile"/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Email</label><input id="gf-email" type="email" value="${g.email||''}" placeholder="Email"/></div>
          <div class="form-group"><label>Emergency Contact</label><input id="gf-emg" value="${g.emergency_contact||''}" placeholder="Emergency phone"/></div>
        </div>
        <div class="form-group"><label>Home / Permanent Address</label><textarea id="gf-address" rows="2" placeholder="e.g. House no, street, city, state, pincode">${g.address||''}</textarea></div>
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
        <div class="form-group"><label>ID Proof Number</label><input id="gf-idnum" value="${g.id_proof_number||''}" placeholder="As printed on the document" autocomplete="off"/></div>
        <div class="form-group"><label>Notes</label><textarea id="gf-notes" rows="2">${g.notes||''}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveGuest(${g.id||'null'})">${g.id?'Save changes':'Add resident'}</button>
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
    address:document.getElementById('gf-address').value.trim(),
    emergency_contact:document.getElementById('gf-emg').value.trim(),
    room_id:document.getElementById('gf-room').value||null,
    bed_number:document.getElementById('gf-bed').value||null,
    join_date:document.getElementById('gf-join').value,
    monthly_rent:document.getElementById('gf-rent').value||0,
    deposit_amount:document.getElementById('gf-dep').value||0,
    id_proof_type:document.getElementById('gf-idtype').value,
    id_proof_number:document.getElementById('gf-idnum').value.trim(),
    notes:document.getElementById('gf-notes').value,
    rent_effective_from: rentEffectiveEl ? rentEffectiveEl.value : null
  };
  if(!d.name) { showAlert(al,'Name is required'); return; }
  if(!d.join_date) { showAlert(al,'Check-in date required'); return; }
  try { if(id) await API.updateGuest(id,d); else await API.createGuest(d); closeModal(); pgGuests(); }
  catch(e) { showAlert(al,e.message); }
}

async function viewGuest(id) {
  smSetContext({ resident_id: id });
  try {
    const [g, ledgerData, history, roomHistory] = await Promise.all([
      API.getGuest(id),
      API.getGuestLedger(id).catch(()=>null),
      API.getRentHistory(id).catch(()=>[]),
      API.getRoomHistory(id).catch(()=>[])
    ]);
    smSetContext({ resident_id: id, resident_name: g.name, room_number: g.room_number || null });
    const balance = ledgerData ? parseFloat(ledgerData.current_balance) : null;
    const balanceLabel = balance===null ? '' : balance < -0.5 ? `${fmt(Math.abs(balance))} due` : balance > 0.5 ? `${fmt(balance)} credit` : 'Settled';
    const balanceClass = balance===null ? '' : balance < -0.5 ? 'text-red' : balance > 0.5 ? 'text-green' : 'text-muted';
    openModal(`
      <div class="modal modal-lg">
        <div class="modal-header"><h3>👤 ${g.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
            ${[['Phone',g.phone],['Email',g.email],['Room',g.room_number?'Room '+g.room_number:'—'],['Bed',g.bed_number||'—'],['Check-in',fmtDate(g.join_date)],['Rent',fmt(g.monthly_rent)+'/mo'],['Deposit',fmt(g.deposit_amount)],['Emergency',g.emergency_contact||'—'],['Address',g.address||'—']].map(([l,v])=>`
            <div style="background:var(--surface-2);padding:10px 12px;border-radius:8px;border:1px solid var(--border)">
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

          <div class="flex justify-between items-center mb-4">
            <h4 style="font-size:14px;margin:0">Room Shift History</h4>
            ${isAdmin()?`<button class="btn btn-outline btn-sm" onclick="roomShiftModal(${g.id},'${g.name.replace(/'/g,"\\'")}')">+ Shift Room</button>`:''}
          </div>
          ${roomHistory.length===0
            ? '<p class="text-muted mb-5">No internal room shifts recorded.</p>'
            : `<table class="mb-5"><thead><tr><th>EFFECTIVE FROM</th><th>MOVE</th><th>BY</th><th>NOTE</th></tr></thead><tbody>
              ${roomHistory.map(h=>`<tr><td>${fmtDate(h.effective_from)}</td><td>${h.from_room_number?'Room '+h.from_room_number:'—'} → Room ${h.to_room_number}${h.to_bed_number?' / Bed '+h.to_bed_number:''}</td><td>${h.username||'—'}</td><td class="text-muted">${h.note||'—'}</td></tr>`).join('')}
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

async function roomShiftModal(guestId, guestName) {
  let g, rooms = [];
  try {
    [g, rooms] = await Promise.all([API.getGuest(guestId), API.getRooms()]);
  } catch(e) { alert(e.message); return; }
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🔀 Shift Room — ${guestName}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="rs-alert" class="alert alert-danger hidden"></div>
        <p class="text-muted" style="font-size:12px;margin-bottom:14px">Moves this guest to a different room/bed within the PG. Not a checkout — their rent, deposit, and ledger stay attached to them.</p>
        <div style="background:var(--surface-2);padding:8px 12px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px;font-size:13px">
          <strong>Current:</strong> ${g.room_number?'Room '+g.room_number+(g.bed_number?' / Bed '+g.bed_number:''):'No room assigned'}
        </div>
        <div class="form-row">
          <div class="form-group"><label>New Room *</label>
            <select id="rs-room">
              <option value="">— Select Room —</option>
              ${rooms.map(r=>`<option value="${r.id}" ${g.room_id==r.id?'disabled':''}>Room ${r.room_number} (${r.available_beds} beds free)</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>New Bed / Berth</label><input id="rs-bed" type="number" placeholder="1, 2..."/></div>
        </div>
        <div class="form-group"><label>Effective From *</label><input id="rs-date" type="date" value="${nowDate()}" max="${nowDate()}" ${g.join_date?`min="${g.join_date.split('T')[0]}"`:''}/>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Backdate this if the shift already happened and just wasn't logged then.</p>
        </div>
        <div class="form-group"><label>Note</label><input id="rs-note" placeholder="e.g. requested a window bed"/></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveRoomShift(${guestId})">Confirm Shift</button>
      </div>
    </div>`);
}

async function saveRoomShift(guestId) {
  const al = document.getElementById('rs-alert');
  const d = {
    room_id: document.getElementById('rs-room').value,
    bed_number: document.getElementById('rs-bed').value || null,
    effective_from: document.getElementById('rs-date').value,
    note: document.getElementById('rs-note').value
  };
  if (!d.room_id) { showAlert(al, 'Select the new room'); return; }
  if (!d.effective_from) { showAlert(al, 'Effective date is required'); return; }
  try { await API.shiftGuestRoom(guestId, d); closeModal(); pgGuests(); }
  catch(e) { showAlert(al, e.message); }
}

async function checkoutModal(id) {
  let g;
  try { g = await API.getGuest(id); } catch(e) { alert(e.message); return; }
  const deposit = parseFloat(g.deposit_amount) || 0;
  const minDate = g.join_date ? new Date(g.join_date).toISOString().split('T')[0] : '';
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🚪 Checkout ${g.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="co-alert" class="alert alert-danger hidden"></div>
        <div style="background:var(--surface-2);padding:10px 12px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px">
          <div style="font-size:11px;color:var(--text-muted);font-weight:600">DEPOSIT PAID</div>
          <div style="font-size:18px;font-weight:600">${fmt(deposit)}</div>
        </div>
        <div class="form-group"><label>Checkout Date</label><input id="co-date" type="date" value="${nowDate()}" max="${nowDate()}" ${minDate?`min="${minDate}"`:''}/>
          <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Backdate this if the guest actually moved out earlier and it wasn't logged then.</p>
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
    leave_date: document.getElementById('co-date').value,
    deductions: document.getElementById('co-deduct').value || 0,
    deduction_notes: document.getElementById('co-notes').value,
    refund_mode: document.getElementById('co-mode').value
  };
  if (!d.leave_date) { showAlert(al, 'Select a checkout date'); return; }
  if (!confirm(`This will check the guest out effective ${fmtDate(d.leave_date)} and finalize the deposit refund. Continue?`)) return;
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

// ── DAILY CHECKLIST ───────────────────────────────
let checklistCurrentDate = null;

async function pgChecklist(date) {
  loading();
  const d = date || checklistCurrentDate || nowDate();
  checklistCurrentDate = d;
  const isToday = d === nowDate();
  document.getElementById('topbar-actions').innerHTML = isAdmin()
    ? `<button class="btn btn-outline btn-sm" onclick="checklistHistoryModal()">📊 History</button> <button class="btn btn-outline btn-sm" onclick="checklistManageModal()">⚙️ Manage Items</button>`
    : '';
  try {
    const data = await API.getChecklist(d);
    setContent(`
      <div class="page-header flex justify-between items-center mb-5">
        <div><h1>Daily Checklist</h1><p>Owner-cum-Warden routine — tick off as you complete each task</p></div>
      </div>
      <div class="card mb-6">
        <div class="card-header flex justify-between items-center">
          <input type="date" id="cl-date" value="${d}" max="${nowDate()}" onchange="pgChecklist(this.value)" style="max-width:180px"/>
          <span style="font-weight:600">${data.summary.checked} / ${data.summary.total} done (${data.summary.percent}%)</span>
        </div>
        <div style="padding:0 20px 16px">
          <div style="background:var(--border);border-radius:8px;height:10px;overflow:hidden">
            <div style="background:${data.summary.percent>=100?'#16A34A':'#4F46E5'};height:100%;width:${data.summary.percent}%;transition:width .3s"></div>
          </div>
        </div>
      </div>
      ${data.sections.map(sec => `
        <div class="card mb-6">
          <div class="card-header"><h3>${sec.label}</h3></div>
          <div style="padding:4px 20px 16px">
            ${sec.items.length===0 ? '<div class="text-muted" style="padding:12px 0">No tasks in this section</div>' : sec.items.map(item => `
              <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--surface-2);cursor:pointer">
                <input type="checkbox" ${item.is_checked?'checked':''} onchange="toggleChecklistItem(${item.id}, this.checked)" style="margin-top:3px;width:18px;height:18px;flex-shrink:0"/>
                <span style="flex:1">
                  <span style="${item.is_checked?'text-decoration:line-through;color:var(--text-muted)':''}">${item.time_label && item.time_label!=='—' ? `<strong>${item.time_label}</strong> — `:''}${item.task}</span>
                  ${/complaint|maintenance register/i.test(item.task) ? ` <button class="btn btn-outline btn-sm" style="padding:2px 8px;font-size:11px" onclick="event.preventDefault();navigate('complaints')">Open Register →</button>` : ''}
                  ${item.is_checked && item.checked_by_username ? `<br><span class="text-muted" style="font-size:12px">✔ ${item.checked_by_username}${item.checked_at?' at '+new Date(item.checked_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):''}</span>` : ''}
                </span>
              </label>
            `).join('')}
          </div>
        </div>
      `).join('')}
    `);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function toggleChecklistItem(itemId, checked) {
  try { await API.toggleChecklistItem(itemId, checklistCurrentDate, checked); pgChecklist(checklistCurrentDate); }
  catch(e) { alert(e.message); pgChecklist(checklistCurrentDate); }
}

function currentYearMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

function shiftYearMonth(ym, delta) {
  let [y,m] = ym.split('-').map(Number);
  m += delta;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2,'0')}`;
}

async function checklistHistoryModal(month) {
  const ym = month || currentYearMonth();
  openModal(`<div class="modal" style="max-width:520px"><div class="modal-header"><h3>📊 Checklist History</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="loading-center"><div class="spinner"></div></div></div></div>`);
  await renderChecklistHistory(ym);
}

async function renderChecklistHistory(ym) {
  const body = document.querySelector('#modal-container .modal-body');
  const monthLabel = new Date(ym+'-01T00:00:00').toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  const isCurrentMonth = ym === currentYearMonth();
  try {
    const rows = await API.getChecklistSummary({ month: ym });
    body.innerHTML = `
      <div class="flex justify-between items-center mb-3">
        <button class="btn btn-outline btn-sm" onclick="renderChecklistHistory('${shiftYearMonth(ym,-1)}')">← Prev</button>
        <strong>${monthLabel}</strong>
        <button class="btn btn-outline btn-sm" onclick="renderChecklistHistory('${shiftYearMonth(ym,1)}')" ${isCurrentMonth?'disabled':''}>Next →</button>
      </div>
      ${rows.length===0 ? '<p class="text-muted" style="text-align:center;padding:20px">No data for this month</p>' : `
      <div style="max-height:380px;overflow-y:auto">
        <table>
          <thead><tr><th>DATE</th><th>DONE</th><th>%</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr onclick="closeModal();pgChecklist('${r.date}')" style="cursor:pointer">
              <td>${fmtDate(r.date)}</td>
              <td>${r.checked} / ${r.total}</td>
              <td><span class="badge ${r.percent>=100?'badge-green':r.percent>=50?'badge-blue':'badge-red'}">${r.percent}%</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    `;
  } catch(e) { body.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function checklistManageModal() {
  openModal(`<div class="modal" style="max-width:600px"><div class="modal-header"><h3>⚙️ Manage Checklist Tasks</h3><button class="modal-close" onclick="closeModal()">×</button></div><div class="modal-body" id="cl-manage-body"><div class="loading-center"><div class="spinner"></div></div></div></div>`);
  await renderChecklistManage();
}

async function renderChecklistManage(editItem) {
  const body = document.getElementById('cl-manage-body');
  try {
    const items = await API.getChecklistItems();
    const sections = ['Morning','Mid-Day','Evening','Night','Closing'];
    const isEditing = !!editItem;
    body.innerHTML = `
      <div id="cl-manage-alert" class="alert alert-danger hidden"></div>
      <div style="max-height:300px;overflow-y:auto;margin-bottom:14px">
        ${items.length===0 ? '<div class="text-muted">No tasks yet</div>' : items.map(i => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface-2);gap:8px">
            <span style="font-size:13px"><strong>${i.section}</strong>${i.time_label && i.time_label!=='—' ? ' · '+i.time_label:''} — ${i.task}</span>
            <span style="flex-shrink:0;display:flex;gap:6px">
              <button class="btn btn-outline btn-sm" onclick='renderChecklistManage(${JSON.stringify(i).replace(/'/g,"&#39;")})'>Edit</button>
              <button class="btn btn-outline btn-sm" onclick="removeChecklistItem(${i.id})">Remove</button>
            </span>
          </div>`).join('')}
      </div>
      <h4 style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">${isEditing ? 'Edit Task' : 'Add New Task'}</h4>
      <div class="form-row">
        <div class="form-group"><label>Section</label>
          <select id="cl-new-section">${sections.map(s=>`<option value="${s}" ${isEditing&&editItem.section===s?'selected':''}>${s}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Time (optional)</label><input type="text" id="cl-new-time" placeholder="e.g. 7:00 AM" value="${isEditing && editItem.time_label!=='—' ? editItem.time_label : ''}"/></div>
      </div>
      <div class="form-group"><label>Task</label><input type="text" id="cl-new-task" placeholder="e.g. Check water tank level" value="${isEditing ? editItem.task.replace(/"/g,'&quot;') : ''}"/></div>
      <div class="flex gap-2">
        <button class="btn btn-primary" onclick="${isEditing ? `saveEditedChecklistItem(${editItem.id})` : 'addChecklistItem()'}">${isEditing ? 'Save Changes' : '+ Add Task'}</button>
        ${isEditing ? `<button class="btn btn-outline" onclick="renderChecklistManage()">Cancel</button>` : ''}
      </div>
    `;
  } catch(e) { body.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function saveEditedChecklistItem(id) {
  const al = document.getElementById('cl-manage-alert');
  const task = document.getElementById('cl-new-task').value.trim();
  if (!task) { showAlert(al, 'Enter a task'); return; }
  try {
    await API.updateChecklistItem(id, { section: document.getElementById('cl-new-section').value, time_label: document.getElementById('cl-new-time').value.trim() || '—', task });
    await renderChecklistManage();
  } catch(e) { showAlert(al, e.message); }
}

async function addChecklistItem() {
  const al = document.getElementById('cl-manage-alert');
  const task = document.getElementById('cl-new-task').value.trim();
  if (!task) { showAlert(al, 'Enter a task'); return; }
  try {
    await API.createChecklistItem({ section: document.getElementById('cl-new-section').value, time_label: document.getElementById('cl-new-time').value.trim() || '—', task });
    await renderChecklistManage();
  } catch(e) { showAlert(al, e.message); }
}

async function removeChecklistItem(id) {
  if (!confirm('Remove this task from the daily checklist?')) return;
  try { await API.deleteChecklistItem(id); await renderChecklistManage(); }
  catch(e) { alert(e.message); }
}

// ── COMPLAINT / MAINTENANCE REGISTER ──────────────
let complaintsCurrentFilter = 'all';
const COMPLAINT_CATEGORIES = ['Electrical','Water','Wifi/Internet','Cleaning','Furniture','Security','Food/Mess','Other'];

async function pgComplaints(filter) {
  loading();
  const f = filter || complaintsCurrentFilter;
  complaintsCurrentFilter = f;
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="complaintModal()">+ Log Issue</button>`;
  try {
    const list = await API.getComplaints(f);
    const tabs = [['all','All'],['open','Open'],['in_progress','In Progress'],['resolved','Resolved']];
    setContent(`
      <div class="page-header flex justify-between items-center mb-5">
        <div><h1>Complaint / Maintenance Register</h1><p>Issues raised by guests or logged on rounds — kept in sync between warden and admin</p></div>
        <button class="btn btn-primary btn-sm" onclick="complaintModal()">+ Log Issue</button>
      </div>
      <div class="flex gap-2 mb-4" style="flex-wrap:wrap;justify-content:space-between">
        <div class="flex gap-2" style="flex-wrap:wrap">
          ${tabs.map(([val,label]) => `<button class="btn ${f===val?'btn-primary':'btn-outline'} btn-sm" onclick="pgComplaints('${val}')">${label}</button>`).join('')}
        </div>
        <input type="text" placeholder="🔍 Search issue, category, guest..." style="width:220px;margin:0" oninput="filterTable(this.value,'complaints-tb')" />
      </div>
      <div class="card">
        ${list.length===0 ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">🛠️<br><br>No issues here.</div>' : `
        <div class="table-wrap">
          <table>
            <thead><tr><th class="bulk-th" scope="col"><span class="sr-only">Select</span></th><th scope="col">DATE</th><th scope="col">CATEGORY</th><th scope="col">ISSUE</th><th scope="col">FROM</th><th scope="col">PRIORITY</th><th scope="col">STATUS</th><th scope="col">ACTIONS</th></tr></thead>
            <tbody id="complaints-tb">
              ${list.map(c => `
                <tr data-search="${c.category.toLowerCase()} ${c.description.toLowerCase()} ${(c.guest_name||'').toLowerCase()} ${(c.room_number||'').toLowerCase()}">
                  <td class="bulk-td">${bulkCb(c.id, c.category + (c.room_number ? ' Room ' + c.room_number : ''))}</td>
                  <td>${fmtDate(c.created_at)}</td>
                  <td>${c.category}</td>
                  <td style="max-width:260px">${c.description}${c.resolution_notes?`<br><span class="text-muted" style="font-size:12px">✔ ${c.resolution_notes}</span>`:''}</td>
                  <td>${c.guest_name || (c.raised_by==='guest'?'Guest':'Staff')}${c.room_number?' · Room '+c.room_number:''}</td>
                  <td>${priorityBadge(c.priority)}${c.priority_why ? whyBtn(c.priority_why, 'Why this priority?') : ''}</td>
                  <td><span class="badge ${c.status==='resolved'?'badge-green':c.status==='in_progress'?'badge-blue':'badge-red'}">${c.status.replace('_',' ')}</span></td>
                  <td>
                    <button class="btn btn-outline btn-sm" onclick="requestSheet(${c.id})">Open</button>
                    ${isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="deleteComplaint(${c.id})">Delete</button>` : ''}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
      </div>
    `);
    bulkSetup('complaints', [{ action: 'assign', label: 'Assign to staff', icon: 'users' }]);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function complaintModal() {
  window.complaintSource = 'manual';
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🛠️ Log an Issue</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="cp-alert" class="alert alert-danger hidden"></div>
        <div class="voice-row">
          <button type="button" id="cp-mic" class="mic-btn" onclick="complaintVoiceToggle()" aria-label="Describe by voice">🎤</button>
          <button type="button" id="cp-cam" class="mic-btn" style="background:var(--amber)" onclick="complaintScanFault()" aria-label="Photograph the fault">${icon('camera')}</button>
          <span id="cp-voice-status" class="voice-status">Say the problem, or photograph it — Siri suggests the category and how urgent it is.</span>
        </div>
        <div id="cp-preview" class="hidden"></div>
        <div class="form-row">
          <div class="form-group"><label>Category</label>
            <select id="cp-category">${COMPLAINT_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Room / Guest (optional)</label><input id="cp-room" placeholder="e.g. Room 12 or guest name"/></div>
        </div>
        <div class="form-group"><label>Description *</label><textarea id="cp-desc" rows="3" placeholder="What's the issue?"></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveComplaint()">Save</button>
      </div>
    </div>`);
}

async function saveComplaint() {
  const al = document.getElementById('cp-alert');
  const description = document.getElementById('cp-desc').value.trim();
  if (!description) { showAlert(al, 'Enter a description'); return; }
  try {
    await API.createComplaint({ category: document.getElementById('cp-category').value, guest_name: document.getElementById('cp-room').value.trim() || null, description, source: window.complaintSource || 'manual',
      priority: window.complaintPriority || undefined, likely_issue: window.complaintLikely || undefined });
    window.complaintSource = 'manual'; window.complaintPriority = undefined; window.complaintLikely = undefined;
    closeModal(); pgComplaints(complaintsCurrentFilter); loadComplaintsCount();
  } catch(e) { showAlert(al, e.message); }
}

function complaintStatusModal(id, currentStatus) {
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>Update Status</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="cps-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Status</label>
          <select id="cps-status">
            <option value="open" ${currentStatus==='open'?'selected':''}>Open</option>
            <option value="in_progress" ${currentStatus==='in_progress'?'selected':''}>In Progress</option>
            <option value="resolved" ${currentStatus==='resolved'?'selected':''}>Resolved</option>
          </select>
        </div>
        <div class="form-group"><label>Resolution Notes (optional)</label><textarea id="cps-notes" rows="2" placeholder="What was done?"></textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveComplaintStatus(${id})">Save</button>
      </div>
    </div>`);
}

async function saveComplaintStatus(id) {
  const al = document.getElementById('cps-alert');
  try {
    await API.updateComplaint(id, { status: document.getElementById('cps-status').value, resolution_notes: document.getElementById('cps-notes').value.trim() || null });
    closeModal(); pgComplaints(complaintsCurrentFilter); loadComplaintsCount();
  } catch(e) { showAlert(al, e.message); }
}

async function deleteComplaint(id) {
  if (!confirm('Delete this complaint record?')) return;
  try { await API.deleteComplaint(id); pgComplaints(complaintsCurrentFilter); loadComplaintsCount(); }
  catch(e) { alert(e.message); }
}

// ── PAYMENTS (same as collections) ───────────────
let paymentsCurrentMonth = null;
let paymentsCurrentYear = null;
let paymentsListCache = [];

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
    paymentsListCache = list;
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
          <div class="flex gap-2" style="flex-wrap:wrap">
            <select id="pay-mode-filter" style="margin:0" onchange="filterPayments()">
              <option value="">All Modes</option>
              ${PURCHASE_PAYMENT_MODES.map(m=>`<option>${m}</option>`).join('')}
            </select>
            <select id="pay-status-filter" style="margin:0" onchange="filterPayments()">
              <option value="">All Status</option>
              <option value="confirmed">Received</option>
              <option value="pending_verification">Pending Verification</option>
              <option value="pending_approval">Pending Approval</option>
            </select>
            <input type="text" id="pay-search" placeholder="🔍 Search resident…" style="width:200px;margin:0" oninput="filterPayments()" />
            <button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Record Payment</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>GUEST</th><th>MONTH</th><th>AMOUNT</th><th>DATE</th><th>MODE</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
            <tbody id="payments-tb">${renderPaymentRows(list)}</tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

function renderPaymentRows(list) {
  if (list.length === 0) return `<tr class="empty-row"><td colspan="7">No payments match.</td></tr>`;
  return list.map(c=>`<tr data-search="${(c.guest_name||'').toLowerCase()}">
      <td><strong>${c.guest_name||'—'}</strong></td>
      <td>${c.collection_month||fmtMonth(c.collection_date)}</td>
      <td class="text-green fw-600">${fmt(c.amount)}</td>
      <td>${fmtDate(c.collection_date)}</td>
      <td><span class="badge badge-blue">${c.payment_mode}</span></td>
      <td><span class="badge ${c.status&&c.status.startsWith('pending')?'badge-amber':'badge-green'}">${c.status==='pending_verification'?'Pending Verification':c.status==='pending_approval'?'Pending Approval':'Received'}</span></td>
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="downloadReceipt(${c.id})" title="Download receipt">🧾</button>
          ${isAdmin()?`<button class="btn btn-danger btn-sm btn-icon" onclick="delCollectionFromPayments(${c.id})">✕</button>`:''}
        </div>
      </td>
    </tr>`).join('');
}

function filterPayments() {
  const mode = document.getElementById('pay-mode-filter')?.value || '';
  const status = document.getElementById('pay-status-filter')?.value || '';
  const q = (document.getElementById('pay-search')?.value || '').toLowerCase().trim();
  let rows = paymentsListCache;
  if (mode) rows = rows.filter(c => (c.payment_mode||'').toLowerCase() === mode.toLowerCase());
  if (status) rows = rows.filter(c => status === 'confirmed' ? (!c.status || c.status === 'confirmed') : c.status === status);
  if (q) rows = rows.filter(c => (c.guest_name||'').toLowerCase().includes(q));
  document.getElementById('payments-tb').innerHTML = renderPaymentRows(rows);
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
  document.getElementById('topbar-actions').innerHTML = isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="announcementModal()">${icon('megaphone')} Post Message</button>` : '';
  try {
    const list = await API.getAnnouncements();
    setContent(`
      <div class="page-header"><h1>Announcements</h1><p>Notices posted to every resident's portal</p></div>
      <div class="card">
        <div class="card-header">
          <h3>Posted Messages</h3>
          <div class="flex gap-2">
            ${list.length>0?`<input type="text" placeholder="🔍 Search title, message..." style="width:200px;margin:0" oninput="filterTable(this.value,'ann-list')" />`:''}
            ${isAdmin()?`<button class="btn btn-primary btn-sm" onclick="announcementModal()">${icon('megaphone')} Post Message</button>`:''}
          </div>
        </div>
        ${list.length===0
          ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">📢<br><br>No messages posted yet. Click Post Message.</div>'
          : `<div id="ann-list">
            ${list.map(a=>`
            <div data-search="${a.title.toLowerCase()} ${a.message.toLowerCase()}" style="padding:16px 20px;border-bottom:1px solid var(--border)">
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
      <div class="modal-header"><h3>${icon('megaphone')} Post Message to Guests</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="an-alert" class="alert alert-danger hidden"></div>
        <div class="form-group"><label>Title *</label><input id="an-title" placeholder="e.g. Water supply maintenance"/></div>
        <div class="form-row">
          <div class="form-group"><label>Who is this for?</label>
            <select id="an-target-type" onchange="document.getElementById('an-target-value').classList.toggle('hidden', this.value==='all')">
              <option value="all">Everyone</option><option value="floor">One floor</option><option value="room">One room</option>
            </select>
          </div>
          <div class="form-group"><label>Which one?</label><input id="an-target-value" class="hidden" placeholder="e.g. 2 or 204"/></div>
        </div>
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
  const tt = document.getElementById('an-target-type')?.value || 'all';
  const d = { title:document.getElementById('an-title').value.trim(), message:document.getElementById('an-msg').value.trim(), priority:document.getElementById('an-priority').value,
    target_type: tt, target_value: tt === 'all' ? null : (document.getElementById('an-target-value')?.value || '').trim() };
  if (tt !== 'all' && !d.target_value) { showAlert(al, 'Say which floor or room this is for'); return; }
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
      <div class="page-header"><h1>Messages</h1><p>Sent by residents — reply directly from here</p></div>
      <div class="card">
        <div class="card-header">
          <h3>All Messages from Guests ${unread>0?`<span class="badge badge-red" style="margin-left:6px">${unread} unread</span>`:''}</h3>
          <div class="flex gap-2">
            ${msgs.length>0?`<input type="text" placeholder="🔍 Search guest, subject..." style="width:200px;margin:0" oninput="filterTable(this.value,'inbox-list')" />`:''}
            <button class="btn btn-outline btn-sm" onclick="pgInbox()">🔄 Refresh</button>
          </div>
        </div>
        <div id="inbox-list">
        ${msgs.length===0
          ? '<div style="text-align:center;padding:48px;color:var(--text-muted)">📭<br><br>No messages from guests yet.</div>'
          : msgs.map(m=>`
          <div data-search="${(m.guest_name||'').toLowerCase()} ${(m.subject||'').toLowerCase()} ${(m.message||'').toLowerCase()} ${(m.room_number||'').toLowerCase()}" class="inbox-item ${!m.is_read?'unread':''}" onclick="viewInboxMsg(${JSON.stringify(m).replace(/"/g,'&quot;')})">
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
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function viewInboxMsg(m) {
  if(!m.is_read) { try { await API.markRead(m.id); } catch {} }
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>💬 Message from ${m.guest_name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div style="background:var(--surface-2);padding:14px;border-radius:8px;margin-bottom:16px">
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
const PURCHASE_CATEGORIES = ['Groceries','Maintenance','Electricity','Water','Internet','Cleaning','Salary','Building Rent','Furniture','Repairs','Other'];
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
  'Building Rent': ['building rent','shop rent','landlord rent','house rent','property rent'],
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

let purchasesFromDate = null;
let purchasesToDate = null;

async function pgPurchases(month, year, from, to) {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="purchaseModal()">+ Add Purchase</button>`;
  try {
    const useRange = !!(from && to);
    let m = null, y = null;
    if (useRange) {
      purchasesFromDate = from; purchasesToDate = to;
      purchasesCurrentMonth = null; purchasesCurrentYear = null;
    } else {
      const now = new Date();
      m = month || (now.getMonth()+1);
      y = year || now.getFullYear();
      purchasesCurrentMonth = m; purchasesCurrentYear = y;
      purchasesFromDate = null; purchasesToDate = null;
    }
    const query = useRange ? `?from=${from}&to=${to}` : `?month=${m}&year=${y}`;
    const list = await API.getPurchases(query);
    purchasesListCache = list;
    const confirmedList = list.filter(p => p.status !== 'pending_approval');
    const total = confirmedList.reduce((s,p)=>s+parseFloat(p.amount),0);
    const byCat = {};
    confirmedList.forEach(p => { byCat[p.category]=(byCat[p.category]||0)+parseFloat(p.amount); });
    const pendingCount = list.filter(p => p.status === 'pending_approval').length;
    const periodLabel = useRange
      ? `${fmtDate(from)} – ${fmtDate(to)}`
      : new Date(y,m-1,1).toLocaleString('en-IN',{month:'long',year:'numeric'});
    setContent(`
      <div class="page-header"><h1>Purchases</h1><p>Track all PG expenses and purchases</p></div>
      ${pendingCount>0?`<div class="alert" style="background:#FFFBEB;border:1px solid var(--amber);color:#92400E;margin-bottom:16px">⏳ ${pendingCount} staff-entered purchase${pendingCount>1?'s':''} awaiting your approval below.</div>`:''}
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportPurchasesCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportPurchasesPdf()">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-5">
        <div class="stat-card red"><div class="s-label">This Period (Confirmed)</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${periodLabel}</div></div>
        <div class="stat-card"><div class="s-label">Groceries</div><div class="s-value">${fmt(byCat['Groceries']||0)}</div><div class="s-sub" style="color:var(--green)">Food &amp; vegetables</div></div>
        <div class="stat-card"><div class="s-label">Maintenance</div><div class="s-value">${fmt(byCat['Maintenance']||0)}</div><div class="s-sub" style="color:var(--amber)">Repairs &amp; upkeep</div></div>
        <div class="stat-card"><div class="s-label">Utilities</div><div class="s-value">${fmt((byCat['Electricity']||0)+(byCat['Water']||0)+(byCat['Internet']||0))}</div><div class="s-sub" style="color:var(--blue)">Bills &amp; services</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Purchases</h3>
          <div class="flex gap-2 items-center" style="flex-wrap:wrap">
            ${monthPicker(m, y, 'onPurchasesMonthChange')}
            <span style="color:var(--text-muted,#888);font-size:13px">or</span>
            <input type="date" id="pu-from" value="${from||''}" onchange="onPurchasesRangeChange()" style="margin:0" title="From date" />
            <span style="color:var(--text-muted,#888);font-size:13px">to</span>
            <input type="date" id="pu-to" value="${to||''}" onchange="onPurchasesRangeChange()" style="margin:0" title="To date" />
            ${useRange?`<button class="btn btn-outline btn-sm" onclick="pgPurchases()">✕ Clear range</button>`:''}
            <select id="cat-filter" style="margin:0" onchange="filterPurchases()">
              <option value="">All Categories</option>
              ${PURCHASE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}
            </select>
            <select id="mode-filter" style="margin:0" onchange="filterPurchases()">
              <option value="">All Modes</option>
              ${PURCHASE_PAYMENT_MODES.map(m=>`<option>${m}</option>`).join('')}
            </select>
            <input type="text" id="pu-search" placeholder="🔍 Search description, paid to..." style="width:200px;margin:0" oninput="filterPurchases()" />
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

function onPurchasesRangeChange() {
  const from = document.getElementById('pu-from')?.value;
  const to = document.getElementById('pu-to')?.value;
  if (from && to) pgPurchases(null, null, from, to);
}

function purchaseModal() {
  window.purchaseSource = 'manual';
  openModal(`
    <div class="modal">
      <div class="modal-header"><h3>🛒 Add Purchase</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div id="pu-alert" class="alert alert-danger hidden"></div>
        <div class="voice-row">
          <button type="button" id="pu-mic-btn" class="mic-btn" onclick="togglePurchaseVoice()" title="Speak to fill this form" aria-label="Fill purchase by voice">🎤</button>
          <button type="button" id="pu-scan-btn" class="mic-btn" style="background:var(--amber)" onclick="purchaseScanBill()" title="Photograph the bill" aria-label="Scan bill">📷</button>
          <span id="pu-voice-status" class="voice-status">Tap 🎤 and say "500 rupees groceries paid to Ramesh cash", or 📷 to photograph the bill</span>
        </div>
        <div id="pu-preview" class="hidden"></div>
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
  const mode = document.getElementById('mode-filter')?.value || '';
  const q = (document.getElementById('pu-search')?.value || '').toLowerCase().trim();
  let filtered = cat ? purchasesListCache.filter(p => p.category === cat) : purchasesListCache;
  if (mode) filtered = filtered.filter(p => (p.payment_mode||'').toLowerCase() === mode.toLowerCase());
  if (q) filtered = filtered.filter(p => `${p.description||''} ${p.paid_to||''} ${p.category||''}`.toLowerCase().includes(q));
  document.getElementById('purchases-tb').innerHTML = renderPurchaseRows(filtered);
}

function exportPurchasesCsv() {
  const cat = document.getElementById('cat-filter')?.value || '';
  const mode = document.getElementById('mode-filter')?.value || '';
  let rows = purchasesListCache;
  if (cat) rows = rows.filter(p => p.category === cat);
  if (mode) rows = rows.filter(p => (p.payment_mode||'').toLowerCase() === mode.toLowerCase());
  const periodSuffix = purchasesFromDate && purchasesToDate
    ? `${purchasesFromDate}_to_${purchasesToDate}`
    : `${purchasesCurrentMonth}-${purchasesCurrentYear}`;
  exportArrayToCsv(
    `sirimane-purchases-${cat||'all'}-${periodSuffix}.csv`,
    [
      { label: 'Date', get: p => fmtDate(p.purchase_date) },
      { label: 'Category', get: p => p.category },
      { label: 'Description', get: p => p.description },
      { label: 'Amount', get: p => p.amount },
      { label: 'Paid To', get: p => p.paid_to },
      { label: 'Mode', get: p => p.payment_mode },
      { label: 'Status', get: p => p.status }
    ],
    rows
  );
}

async function exportPurchasesPdf() {
  const cat = document.getElementById('cat-filter')?.value || '';
  const mode = document.getElementById('mode-filter')?.value || '';
  const periodSuffix = purchasesFromDate && purchasesToDate
    ? `${purchasesFromDate}_to_${purchasesToDate}`
    : `${purchasesCurrentMonth}-${purchasesCurrentYear}`;
  const periodQuery = purchasesFromDate && purchasesToDate
    ? `from=${purchasesFromDate}&to=${purchasesToDate}`
    : `month=${purchasesCurrentMonth}&year=${purchasesCurrentYear}`;
  const catQuery = cat ? `&category=${encodeURIComponent(cat)}` : '';
  const modeQuery = mode ? `&mode=${encodeURIComponent(mode)}` : '';
  try { await API.downloadExport(`/purchases/export/pdf?${periodQuery}${catQuery}${modeQuery}`, `sirimane-purchases-${cat||'all'}-${periodSuffix}.pdf`); }
  catch(e) { alert('Export failed: ' + e.message); }
}

async function confirmPendingPurchase(id) {
  if(!confirm('Approve this purchase as confirmed spend?')) return;
  try { await API.confirmPurchase(id); pgPurchases(purchasesCurrentMonth, purchasesCurrentYear); } catch(e) { alert(e.message); }
}

async function savePurchase() {
  const al = document.getElementById('pu-alert');
  const d = { amount:document.getElementById('pu-amt').value, purchase_date:document.getElementById('pu-date').value, category:document.getElementById('pu-cat').value, description:document.getElementById('pu-desc').value, paid_to:document.getElementById('pu-paid').value, payment_mode:document.getElementById('pu-mode').value, source: window.purchaseSource || 'manual' };
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
let collectionsFromDate = null;
let collectionsToDate = null;

async function pgCollections(month, year, from, to) {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Add Collection</button>`;
  try {
    const useRange = !!(from && to);
    let m = null, y = null;
    if (useRange) {
      collectionsFromDate = from;
      collectionsToDate = to;
      collectionsCurrentMonth = null;
      collectionsCurrentYear = null;
    } else {
      const now = new Date();
      m = month || (now.getMonth()+1);
      y = year || now.getFullYear();
      collectionsCurrentMonth = m;
      collectionsCurrentYear = y;
      collectionsFromDate = null;
      collectionsToDate = null;
    }
    const query = useRange ? `?from=${from}&to=${to}` : `?month=${m}&year=${y}`;
    const list = await API.getCollections(query);
    collectionsListCache = list;
    const confirmedList = list.filter(c => c.status === 'confirmed' || !c.status);
    const total = confirmedList.reduce((s,c)=>s+parseFloat(c.amount),0);
    const byType = {};
    confirmedList.forEach(c => { byType[c.collection_type]=(byType[c.collection_type]||0)+parseFloat(c.amount); });
    const pendingVerificationCount = list.filter(c => c.status === 'pending_verification').length;
    const pendingApprovalCount = list.filter(c => c.status === 'pending_approval').length;
    const periodLabel = useRange
      ? `${fmtDate(from)} – ${fmtDate(to)}`
      : new Date(y,m-1,1).toLocaleString('en-IN',{month:'long',year:'numeric'});
    setContent(`
      <div class="page-header"><h1>${icon('rupee')} Collections</h1><p>Track all income — rent, deposits, and extra charges</p></div>
      ${pendingVerificationCount>0?`<div class="alert" style="background:var(--amber-light,#FFFBEB);border:1px solid var(--amber,#F59E0B);color:#92400E;margin-bottom:10px">⏳ ${pendingVerificationCount} resident-reported UPI payment${pendingVerificationCount>1?'s':''} awaiting your confirmation below — check your bank/UPI app, then confirm or reject.</div>`:''}
      ${pendingApprovalCount>0?`<div class="alert" style="background:var(--amber-light,#FFFBEB);border:1px solid var(--amber,#F59E0B);color:#92400E;margin-bottom:16px">⏳ ${pendingApprovalCount} staff-entered collection${pendingApprovalCount>1?'s':''} awaiting your approval below.</div>`:''}
      ${isAdmin()?`<div class="flex gap-2 mb-5">
        <button class="btn btn-outline btn-sm" onclick="exportCollectionsCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportCollectionsPdf()">⬇ Export PDF</button>
      </div>`:''}
      <div class="stat-grid mb-5">
        <div class="stat-card green"><div class="s-label">This Period (Confirmed)</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${periodLabel}</div></div>
        <div class="stat-card"><div class="s-label">Rent</div><div class="s-value">${fmt(byType['rent']||0)}</div><div class="s-sub" style="color:var(--green)">Monthly rent</div></div>
        <div class="stat-card"><div class="s-label">Deposits</div><div class="s-value">${fmt(byType['deposit']||0)}</div><div class="s-sub" style="color:var(--blue)">Security deposits</div></div>
        <div class="stat-card"><div class="s-label">Extra Charges</div><div class="s-value">${fmt(byType['extra']||byType['other']||0)}</div><div class="s-sub" style="color:var(--amber)">Laundry, food, etc.</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Collections</h3>
          <div class="flex gap-2 items-center" style="flex-wrap:wrap">
            ${monthPicker(m, y, 'onCollectionsMonthChange')}
            <span style="color:var(--text-muted,#888);font-size:13px">or</span>
            <input type="date" id="coll-from" value="${from||''}" onchange="onCollectionsRangeChange()" style="margin:0" title="From date" />
            <span style="color:var(--text-muted,#888);font-size:13px">to</span>
            <input type="date" id="coll-to" value="${to||''}" onchange="onCollectionsRangeChange()" style="margin:0" title="To date" />
            ${useRange?`<button class="btn btn-outline btn-sm" onclick="clearCollectionsRange()">✕ Clear range</button>`:''}
            <select id="coll-type-filter" style="margin:0" onchange="filterCollections()">
              <option value="">All Types</option>
              <option value="rent">Rent</option><option value="deposit">Deposit</option><option value="advance">Advance</option><option value="extra">Extra</option>
            </select>
            <select id="coll-mode-filter" style="margin:0" onchange="filterCollections()">
              <option value="">All Modes</option>
              ${PURCHASE_PAYMENT_MODES.map(m=>`<option>${m}</option>`).join('')}
            </select>
            <input type="text" id="coll-search" placeholder="🔍 Search guest, description..." style="width:200px;margin:0" oninput="filterCollections()" />
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

// Triggered when either the From or To date input changes. Only applies the
// range once both ends are filled in — a single date on its own isn't a
// usable range, so we just wait for the second one instead of erroring.
function onCollectionsRangeChange() {
  const from = document.getElementById('coll-from')?.value;
  const to = document.getElementById('coll-to')?.value;
  if (from && to) pgCollections(null, null, from, to);
}

function clearCollectionsRange() {
  pgCollections();
}

function renderCollectionRows(list) {
  return list.length===0
    ? `<tr class="empty-row"><td colspan="7">No collections match this filter.</td></tr>`
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
      <td>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-sm" onclick="downloadReceipt(${c.id})" title="Download receipt">🧾</button>
          ${pending && isAdmin()
            ? `<button class="btn btn-primary btn-sm" onclick="confirmPendingCollection(${c.id})">${pendingApproval?'Approve':'Confirm'}</button><button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button>`
            : isAdmin() ? `<button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button>` : ''}
        </div>
      </td>
    </tr>`;}).join('');
}

function downloadReceipt(id) {
  API.downloadExport(`/collections/${id}/receipt/pdf`, `receipt-SM-${String(id).padStart(5,'0')}.pdf`)
    .catch(e => alert('Could not generate receipt: ' + e.message));
}

function filterCollections() {
  const type = document.getElementById('coll-type-filter').value;
  const mode = document.getElementById('coll-mode-filter')?.value || '';
  const q = (document.getElementById('coll-search')?.value || '').toLowerCase().trim();
  let filtered = type ? collectionsListCache.filter(c => c.collection_type === type) : collectionsListCache;
  if (mode) filtered = filtered.filter(c => (c.payment_mode||'').toLowerCase() === mode.toLowerCase());
  if (q) filtered = filtered.filter(c => `${c.guest_name||''} ${c.description||''} ${c.collection_month||''}`.toLowerCase().includes(q));
  document.getElementById('collections-tb').innerHTML = renderCollectionRows(filtered);
}

function exportCollectionsCsv() {
  const type = document.getElementById('coll-type-filter')?.value || '';
  const mode = document.getElementById('coll-mode-filter')?.value || '';
  let rows = type ? collectionsListCache.filter(c => c.collection_type === type) : collectionsListCache;
  if (mode) rows = rows.filter(c => (c.payment_mode||'').toLowerCase() === mode.toLowerCase());
  const periodSuffix = collectionsFromDate && collectionsToDate
    ? `${collectionsFromDate}_to_${collectionsToDate}`
    : `${collectionsCurrentMonth}-${collectionsCurrentYear}`;
  exportArrayToCsv(
    `sirimane-collections-${type||'all'}-${periodSuffix}.csv`,
    [
      { label: 'Date', get: c => fmtDate(c.collection_date) },
      { label: 'Type', get: c => c.collection_type },
      { label: 'Guest / From', get: c => c.guest_name },
      { label: 'Description', get: c => c.description || c.collection_month },
      { label: 'Amount', get: c => c.amount },
      { label: 'Mode', get: c => c.payment_mode },
      { label: 'Status', get: c => c.status }
    ],
    rows
  );
}

async function exportCollectionsPdf() {
  const type = document.getElementById('coll-type-filter')?.value || '';
  const periodSuffix = collectionsFromDate && collectionsToDate
    ? `${collectionsFromDate}_to_${collectionsToDate}`
    : `${collectionsCurrentMonth}-${collectionsCurrentYear}`;
  const periodQuery = collectionsFromDate && collectionsToDate
    ? `from=${collectionsFromDate}&to=${collectionsToDate}`
    : `month=${collectionsCurrentMonth}&year=${collectionsCurrentYear}`;
  const typeQuery = type ? `&type=${type}` : '';
  try { await API.downloadExport(`/collections/export/pdf?${periodQuery}${typeQuery}`, `sirimane-collections-${type||'all'}-${periodSuffix}.pdf`); }
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
    // Default order is "who do I chase first" — biggest total payable on top.
    if (!rentDueSort.key) { rentDueSort.key = 'total_payable'; rentDueSort.dir = 'desc'; }
    rentDueListCache = list;
    const totalDue = list.reduce((s,g) => s + parseFloat(g.amount_due), 0);
    const totalDepositPending = list.reduce((s,g) => s + parseFloat(g.deposit_pending||0), 0);
    const fullyPaidCount = list.filter(g => parseFloat(g.amount_due) <= 0).length;
    const pendingCount = list.filter(g => parseFloat(g.amount_due) > 0 || parseFloat(g.deposit_pending||0) > 0).length;
    setContent(`
      <div class="page-header"><h1>Rent Due <span class="sm-kn" style="font-size:15px">ಬಾಕಿ</span></h1><p>Running balance for each resident, carried forward across months — not just this month's snapshot</p></div>
      <div class="flex gap-2 mb-5" style="flex-wrap:wrap">
        ${isAdmin()?`<button class="btn btn-outline btn-sm" onclick="exportRentDueCsv()">⬇ Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="exportRentDuePdf()">⬇ Export PDF</button>`:''}
        ${pendingCount>0?`<button class="btn btn-primary btn-sm" onclick="openRentRemindersModal()">💬 Send Reminders (${pendingCount})</button>`:''}
      </div>
      <div class="stat-grid mb-5">
        <div class="stat-card red"><div class="s-label">Total Outstanding</div><div class="s-value">${fmt(totalDue)}</div><div class="s-sub">Across all guests</div></div>
        ${totalDepositPending>0?`<div class="stat-card"><div class="s-label">Deposit Pending</div><div class="s-value">${fmt(totalDepositPending)}</div><div class="s-sub" style="color:var(--amber)">Not yet collected</div></div>`:''}
        <div class="stat-card"><div class="s-label">Settled or Ahead</div><div class="s-value">${fullyPaidCount} / ${list.length}</div><div class="s-sub" style="color:var(--green)">Guests</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Active Guests</h3>
          <div class="flex gap-2 items-center" style="flex-wrap:wrap">
            <select id="rentdue-filter" style="margin:0" onchange="filterRentDueList()">
              <option value="all">Show: all residents</option>
              <option value="rent">Rent Due Only</option>
              <option value="deposit">Deposit Pending Only</option>
              <option value="either">Rent Due or Deposit Pending</option>
            </select>
            <input type="text" id="rentdue-search" placeholder="🔍 Search name, room, phone..." style="width:200px;margin:0" oninput="filterRentDueList()" />
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th class="bulk-th" scope="col"><span class="sr-only">Select</span></th>
              ${rentDueSortHeader('name','NAME')}
              ${rentDueSortHeader('room_number','ROOM')}
              <th>PHONE</th>
              ${rentDueSortHeader('monthly_rent','MONTHLY RENT')}
              ${rentDueSortHeader('amount_due','RENT PENDING')}
              ${rentDueSortHeader('deposit_pending','DEPOSIT PENDING')}
              ${rentDueSortHeader('total_payable','TOTAL PAYABLE')}
              <th>STATUS</th>
              <th>PAYS</th><th>ACTION</th>
            </tr></thead>
            <tbody id="rentdue-tb">${renderRentDueRows(sortRentDueRows(list))}</tbody>
          </table>
        </div>
      </div>`);
    loadReliability();
    bulkSetup('rent-due', [{ action: 'reminders', label: 'Draft reminders', icon: 'whatsapp' }]);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

let rentDueSort = { key: null, dir: 'asc' };

function rentDueSortHeader(key, label) {
  const active = rentDueSort.key === key;
  const arrow = active ? (rentDueSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="sortRentDueList('${key}')" title="Click to sort">${label}${arrow}</th>`;
}

function sortRentDueList(key) {
  if (rentDueSort.key === key) {
    rentDueSort.dir = rentDueSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    // Text columns default to A-Z; numeric "pending" columns are more useful
    // starting high-to-low, since that's who you'd chase first.
    rentDueSort.key = key;
    rentDueSort.dir = (key === 'name' || key === 'room_number') ? 'asc' : 'desc';
  }
  filterRentDueList();
}

// Shared sorter so the first paint uses the same order as filterRentDueList().
function sortRentDueRows(rows) {
  if (!rentDueSort.key) return rows;
  const { key, dir } = rentDueSort;
  return [...rows].sort((a,b) => {
    let av, bv;
    if (key === 'total_payable') { av = parseFloat(a.amount_due)+parseFloat(a.deposit_pending||0); bv = parseFloat(b.amount_due)+parseFloat(b.deposit_pending||0); }
    else if (key === 'name' || key === 'room_number') { av = (a[key]||'').toString().toLowerCase(); bv = (b[key]||'').toString().toLowerCase(); }
    else { av = parseFloat(a[key])||0; bv = parseFloat(b[key])||0; }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function renderRentDueRows(list) {
  if (list.length === 0) return `<tr class="empty-row"><td colspan="11">No resident matches.</td></tr>`;
  return list.map(g=>{
    const due = parseFloat(g.amount_due);
    const credit = parseFloat(g.credit);
    const depPending = parseFloat(g.deposit_pending||0);
    const totalPayable = due + depPending;
    const anyPending = due>0 || depPending>0;
    return `<tr data-search="${g.name.toLowerCase()} ${(g.room_number||'').toLowerCase()} ${(g.phone||'').toLowerCase()}">
      <td class="bulk-td">${bulkCb(g.id, g.name)}</td>
      <td><strong>${g.name}</strong></td>
      <td>${g.room_number?'Room '+g.room_number:'—'}</td>
      <td>${g.phone||'—'}</td>
      <td>${fmt(g.monthly_rent)}</td>
      <td class="${due>0?'text-red fw-600':credit>0?'text-green fw-600':''}">${due>0?fmt(due)+' due':credit>0?fmt(credit)+' credit':'Settled'}</td>
      <td class="${depPending>0?'text-red fw-600':''}">${depPending>0?fmt(depPending):'—'}</td>
      <td class="${totalPayable>0?'text-red fw-600':''}">${totalPayable>0?fmt(totalPayable):'—'}</td>
      <td><span class="badge ${anyPending?'badge-red':'badge-green'}">${anyPending?'Pending':credit>0?'Ahead':'Settled'}</span></td>
      <td><span data-rel-for="${g.id}"></span></td>
      <td><div class="flex gap-2">
        ${anyPending ? `<button class="btn btn-primary btn-sm" onclick="collectFrom(${g.id})" title="Collect payment">${icon('rupee')} Collect</button>` : ''}
        ${anyPending
          ? (g.phone
              ? `<button class="btn btn-outline btn-sm" onclick="sendOneRentReminder(${g.id})" title="Send WhatsApp reminder">${icon('whatsapp')} Remind</button>`
              : `<span style="font-size:11px;color:var(--text-muted,#999)">No phone</span>`)
          : ''}
      </div></td>
    </tr>`;
  }).join('');
}

function filterRentDueList() {
  const mode = document.getElementById('rentdue-filter')?.value || 'all';
  const search = (document.getElementById('rentdue-search')?.value || '').toLowerCase().trim();
  let rows = rentDueListCache;
  if (mode === 'rent') rows = rows.filter(g => parseFloat(g.amount_due) > 0);
  else if (mode === 'deposit') rows = rows.filter(g => parseFloat(g.deposit_pending||0) > 0);
  else if (mode === 'either') rows = rows.filter(g => parseFloat(g.amount_due) > 0 || parseFloat(g.deposit_pending||0) > 0);
  if (search) rows = rows.filter(g =>
    g.name.toLowerCase().includes(search) ||
    (g.room_number||'').toLowerCase().includes(search) ||
    (g.phone||'').toLowerCase().includes(search)
  );
  rows = sortRentDueRows(rows);
  document.getElementById('rentdue-tb').innerHTML = renderRentDueRows(rows);
  if (typeof bulkSyncBoxes === 'function') bulkSyncBoxes();
  loadReliability();
}

// Turns a phone number into WhatsApp's expected format: digits only, with
// the 91 country code prepended for bare 10-digit Indian numbers. Returns
// null when there's nothing usable, so callers can skip/alert instead of
// opening a broken wa.me link.
function cleanPhoneForWhatsapp(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits.length >= 11 ? digits : null;
}

function buildWhatsappUrl(phone, message) {
  const digits = cleanPhoneForWhatsapp(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

const RENT_REMINDER_DEFAULT_TEMPLATE = `Hi {name}, this is a reminder from Siri Mane PG that your account currently shows a pending balance.

Room: {room}
{pending_lines}

Please make the payment at your earliest convenience. Thank you!`;

function fillRentReminderTemplate(tpl, g) {
  const due = parseFloat(g.amount_due) || 0;
  const depPending = parseFloat(g.deposit_pending) || 0;
  const lines = [];
  if (due > 0) lines.push(`Rent Due: ${fmt(due)}`);
  if (depPending > 0) lines.push(`Deposit Pending: ${fmt(depPending)}`);
  return tpl
    .replace(/\{name\}/g, g.name)
    .replace(/\{room\}/g, g.room_number ? ('Room '+g.room_number) : '—')
    .replace(/\{amount\}/g, fmt(due))
    .replace(/\{pending_lines\}/g, lines.join('\n'));
}

// Bulk reminders modal — browsers block firing off several wa.me tabs at
// once without a click each, so this lists every pending resident with
// their own "send" button rather than pretending to auto-blast them all.
function openRentRemindersModal() {
  const pending = rentDueListCache.filter(g => parseFloat(g.amount_due) > 0 || parseFloat(g.deposit_pending||0) > 0);
  if (pending.length === 0) { alert('No residents currently have rent or deposit pending.'); return; }
  const noPhoneCount = pending.filter(g => !g.phone).length;
  openModal(`
    <div class="modal" style="max-width:660px">
      <div class="modal-header"><h3>💬 Send Reminders</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-muted,#666);margin-bottom:10px">${pending.length} resident${pending.length>1?'s':''} with rent and/or deposit pending${noPhoneCount?` (${noPhoneCount} missing a phone number)`:''}. Each button opens WhatsApp with the message ready — you just hit send there. Placeholders: {name}, {room}, {amount}, {pending_lines}.</p>
        <div class="form-group"><label>Message template</label><textarea id="rr-template" rows="7">${RENT_REMINDER_DEFAULT_TEMPLATE}</textarea></div>
        <div class="table-wrap" style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:8px">
          <table>
            <thead><tr><th>Name</th><th>Room</th><th>Rent Due</th><th>Deposit Pending</th><th>Phone</th><th></th></tr></thead>
            <tbody>
              ${pending.map(g => `<tr>
                  <td>${g.name}</td>
                  <td>${g.room_number?'Room '+g.room_number:'—'}</td>
                  <td class="${parseFloat(g.amount_due)>0?'text-red fw-600':''}">${parseFloat(g.amount_due)>0?fmt(g.amount_due):'—'}</td>
                  <td class="${parseFloat(g.deposit_pending||0)>0?'text-red fw-600':''}">${parseFloat(g.deposit_pending||0)>0?fmt(g.deposit_pending):'—'}</td>
                  <td>${g.phone||'—'}</td>
                  <td>${g.phone
                    ? `<button class="btn btn-outline btn-sm" onclick="sendOneRentReminder(${g.id})">💬 WhatsApp</button>`
                    : `<span style="font-size:12px;color:var(--text-muted,#999)">No phone</span>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Close</button>
      </div>
    </div>`);
}

function sendOneRentReminder(guestId) {
  const g = rentDueListCache.find(x => x.id === guestId);
  if (!g) return;
  const tpl = document.getElementById('rr-template')?.value || RENT_REMINDER_DEFAULT_TEMPLATE;
  const message = fillRentReminderTemplate(tpl, g);
  const url = buildWhatsappUrl(g.phone, message);
  if (!url) { alert(`No valid phone number for ${g.name}.`); return; }
  window.open(url, '_blank');
}

function exportRentDueCsv() {
  exportArrayToCsv(
    `sirimane-rent-due-${nowDate()}.csv`,
    [
      { label: 'Name', get: g => g.name },
      { label: 'Room', get: g => g.room_number },
      { label: 'Phone', get: g => g.phone },
      { label: 'Monthly Rent', get: g => g.monthly_rent },
      { label: 'Rent Pending', get: g => g.amount_due },
      { label: 'Credit', get: g => g.credit },
      { label: 'Deposit Pending', get: g => g.deposit_pending || 0 },
      { label: 'Total Payable', get: g => parseFloat(g.amount_due||0) + parseFloat(g.deposit_pending||0) }
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
    if (isAdmin()) loadOwnerReport();
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
        <div><h1>Reports</h1><p>Profit &amp; Loss summary</p></div>
        <div class="flex items-center gap-2">${controlsHtml}</div>
      </div>
      ${isAdmin()?`<div class="card mb-6" id="owner-card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h3>📈 Owner report</h3>
          <div class="flex items-center gap-2" style="flex-wrap:wrap">
            <input type="month" id="owner-month" value="${new Date().toISOString().slice(0,7)}" max="${new Date().toISOString().slice(0,7)}" style="margin:0;min-height:40px" onchange="loadOwnerReport()"/>
            <button class="btn btn-outline btn-sm" onclick="loadOwnerReport(true)" title="Recompute">↻</button>
          </div>
        </div>
        <div style="padding:14px 16px">
          <pre id="owner-summary" style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55;margin:0 0 12px">Loading…</pre>
          <div id="owner-forecast" style="font-size:13px;color:var(--text-muted,var(--text-muted));margin-bottom:12px"></div>
          <div class="flex gap-2" style="flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="downloadOwnerPdf()">${icon('receipt')} Download PDF</button>
            <button class="btn btn-outline btn-sm" onclick="shareOwnerSummary()">${icon('whatsapp')} WhatsApp summary</button>
            <button class="btn btn-outline btn-sm" onclick="downloadAccountantZip()">${icon('copy')} Export CSVs (ZIP)</button>
          </div>
          <div id="owner-meta" class="text-muted" style="font-size:11px;margin-top:8px"></div>
        </div>
      </div>
      <div class="flex gap-2 mb-5">
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
        <div class="card-header">
          <h3>📈 Trend</h3>
          <select id="trend-range" style="margin:0" onchange="loadTrendChart(this.value)">
            <option value="6">Last 6 Months</option>
            <option value="12">Last 1 Year</option>
            <option value="24">Last 2 Years</option>
          </select>
        </div>
        <div class="card-body" id="trend-chart-wrap"><div class="loading-center"><div class="spinner"></div></div></div>
      </div>`;
}

async function exportReport(type, from, to) {
  try {
    if (type === 'csv') await API.downloadExport(`/reports/export/csv?from=${from}&to=${to}`, `sirimane-transactions-${from}-to-${to}.csv`);
    else await API.downloadExport(`/reports/export/pdf?from=${from}&to=${to}`, `sirimane-report-${from}-to-${to}.pdf`);
  } catch(e) { alert('Export failed: ' + e.message); }
}

async function loadTrendChart(months) {
  const wrap = document.getElementById('trend-chart-wrap');
  if (!wrap) return;
  months = parseInt(months) || parseInt(document.getElementById('trend-range')?.value) || 6;
  wrap.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const trend = await API.getReportsTrend(months);
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
  const showYear = trend.length > 12;

  const bars = trend.map((t, i) => {
    const x = i * groupWidth;
    const incH = (t.income / maxVal) * barMaxHeight;
    const expH = (t.expenses / maxVal) * barMaxHeight;
    const baseY = barMaxHeight + 10;
    const parts = t.label.split(' '); // e.g. ["Jul","2026"]
    const xLabel = showYear ? `${parts[0]} '${(parts[1]||'').slice(-2)}` : parts[0];
    return `
      <g>
        <rect x="${x+15}" y="${baseY-incH}" width="22" height="${incH}" fill="var(--green)" rx="2"><title>${t.label} Income: ${fmt(t.income)}</title></rect>
        <rect x="${x+45}" y="${baseY-expH}" width="22" height="${expH}" fill="var(--red)" rx="2"><title>${t.label} Expenses: ${fmt(t.expenses)}</title></rect>
        <text x="${x+45}" y="${baseY+18}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${xLabel}</text>
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
        <div><h1>Balance Sheet</h1><p>What the business owns vs. owes, as of a point in time</p></div>
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
        <div class="card-header">
          <h3>🏠 Fixed Assets</h3>
          <div class="flex gap-2">
            ${assets.length>0?`<input type="text" placeholder="🔍 Search..." style="width:180px;margin:0" oninput="filterTable(this.value,'assets-tb')" />`:''}
            <button class="btn btn-primary btn-sm" onclick="fixedAssetModal()">+ Add Asset</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>NAME</th><th>CATEGORY</th><th>VALUE</th><th>NOTES</th><th>ACTIONS</th></tr></thead>
            <tbody id="assets-tb">
              ${assets.length===0
                ? `<tr class="empty-row"><td colspan="6">${emptyState('bed', 'No assets recorded', 'Beds, geysers, furniture — anything the PG owns.', '<button class="btn btn-primary btn-sm" onclick="fixedAssetModal()">Add asset</button>')}</td></tr>`
                : assets.map(a=>`<tr data-search="${a.name.toLowerCase()} ${a.category.toLowerCase()} ${(a.notes||'').toLowerCase()}">
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
        <div class="card-header">
          <h3>💰 Capital Transactions</h3>
          <div class="flex gap-2">
            ${capital.length>0?`<input type="text" placeholder="🔍 Search note, by..." style="width:180px;margin:0" oninput="filterTable(this.value,'capital-tb')" />`:''}
            <button class="btn btn-primary btn-sm" onclick="capitalModal()">+ Add Entry</button>
          </div>
        </div>
        <p class="text-muted" style="font-size:12px;padding:0 20px 12px">Money you've put into the business (positive) or taken out (negative) — separate from day-to-day rent and purchases.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>AMOUNT</th><th>NOTE</th><th>BY</th><th>ACTIONS</th></tr></thead>
            <tbody id="capital-tb">
              ${capital.length===0
                ? `<tr class="empty-row"><td colspan="5">${emptyState('wallet', 'No capital recorded', 'Money the owner has put in or taken out.', '<button class="btn btn-primary btn-sm" onclick="capitalModal()">Add transaction</button>')}</td></tr>`
                : capital.map(c=>`<tr data-search="${(c.note||'').toLowerCase()} ${(c.username||'').toLowerCase()}">
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
let adminRenderSeq = 0;
// Returns the element to write into, or null if the user has moved on.
function adminHost(seq) { return seq === adminRenderSeq ? document.getElementById('admin-tab-content') : null; }

async function pgAdmin() {
  loading();
  document.getElementById('topbar-actions').innerHTML = '';
  renderAdminPage();
  loadSchemaBanner();
}

function renderAdminPage() {
  setContent(`
    <div class="page-header"><h1>Admin</h1><p>Staff accounts, audit trail, deposit refunds, and app settings</p></div>
    <div id="schema-banner"></div>
    <div class="flex gap-2 mb-5">
      <button class="btn ${adminActiveTab==='staff'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('staff')">Staff Users</button>
      <button class="btn ${adminActiveTab==='audit'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('audit')">Audit Log</button>
      <button class="btn ${adminActiveTab==='refunds'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('refunds')">Deposit Refunds</button>
      <button class="btn ${adminActiveTab==='settings'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('settings')">Settings</button>
      <button class="btn ${adminActiveTab==='copilot'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('copilot')">Copilot log</button>
      <button class="btn ${adminActiveTab==='ai'?'btn-primary':'btn-outline'} btn-sm" onclick="switchAdminTab('ai')">AI impact</button>
    </div>
    <div id="admin-tab-content"><div class="loading-center"><div class="spinner"></div></div></div>`);
  if (adminActiveTab === 'ai') renderAdminAiTab();
  else if (adminActiveTab === 'copilot') renderAdminCopilotTab();
  else if (adminActiveTab === 'staff') renderAdminStaffTab();
  else if (adminActiveTab === 'audit') renderAdminAuditTab();
  else if (adminActiveTab === 'refunds') renderAdminRefundsTab();
  else renderAdminSettingsTab();
}

function switchAdminTab(tab) {
  adminActiveTab = tab;
  adminRenderSeq++;
  renderAdminPage();
}

async function renderAdminSettingsTab() {
  const __seq = adminRenderSeq;
  try {
    const settings = await API.getSettings();
    (adminHost(__seq) || {}).innerHTML = `
      <div class="card mb-6">
        <div class="card-header"><h3>AI inputs</h3></div>
        <div style="padding:16px 20px">
          <p style="font-size:13px;color:var(--text-muted,var(--text-muted));margin-bottom:10px">
            Photo scanning (bills, ID proof): <strong>${aiStatus.vision ? 'enabled' : 'not enabled — set GEMINI_API_KEY on Railway'}</strong> ·
            Voice fallback: <strong>${aiStatus.text ? 'enabled' : 'not enabled — set GROQ_API_KEY on Railway'}</strong>
          </p>
          <button class="btn btn-outline btn-sm" id="ai-probe-btn" onclick="runAiProbe()">${icon('sparkle')} Test AI connection</button>
          <div id="ai-probe-result" style="font-size:13px;margin-top:10px"></div>
        </div>
      </div>
      <div class="card mb-6">
        <div class="card-header"><h3>PG Details (used on printed receipts)</h3></div>
        <div style="padding:20px;max-width:480px">
          <div id="pg-settings-alert" class="alert alert-danger hidden"></div>
          <div class="form-group"><label>PG Name</label><input id="set-pg-name" placeholder="e.g. Siri Mane" value="${settings.pg_name||''}"/></div>
          <div class="form-group"><label>Address</label><textarea id="set-pg-address" rows="2" placeholder="e.g. 5th cross, Gangothri Road,&#10;SIT Ext, Tumakuru.">${settings.pg_address||''}</textarea></div>
          <div class="form-group"><label>Phone</label><input id="set-pg-phone" placeholder="e.g. 9880217627" value="${settings.pg_phone||''}"/></div>
          <div class="form-row">
            <div class="form-group"><label>Morning brief time (IST)</label><input id="set-brief-time" type="time" value="${settings.brief_time||'07:00'}"/></div>
            <div class="form-group"><label>Evening summary time (IST)</label><input id="set-evening-time" type="time" value="${settings.evening_time||'20:00'}"/></div>
            <div class="form-group"><label>Send brief to (WhatsApp)</label><input id="set-owner-phone" placeholder="Owner's number" value="${settings.owner_phone||''}"/></div>
          </div>
          <div class="form-group"><label>Reminder language</label>
            <select id="set-reminder-lang"><option value="en" ${(settings.reminder_lang||'en')==='en'?'selected':''}>English</option><option value="kn" ${settings.reminder_lang==='kn'?'selected':''}>ಕನ್ನಡ</option></select>
          </div>
          <button class="btn btn-primary" onclick="savePgSettings()">Save PG Details</button>
        </div>
      </div>
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
  } catch(e) { (adminHost(__seq) || {}).innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function savePgSettings() {
  const al = document.getElementById('pg-settings-alert');
  const d = {
    pg_name: document.getElementById('set-pg-name').value.trim(),
    pg_address: document.getElementById('set-pg-address').value.trim(),
    pg_phone: document.getElementById('set-pg-phone').value.trim(),
    brief_time: document.getElementById('set-brief-time').value || '07:00',
    evening_time: document.getElementById('set-evening-time').value || '20:00',
    owner_phone: document.getElementById('set-owner-phone').value.trim(),
    reminder_lang: document.getElementById('set-reminder-lang').value
  };
  try { await API.updateSettings(d); renderAdminSettingsTab(); }
  catch(e) { showAlert(al, e.message); }
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
  const __seq = adminRenderSeq;
  try {
    const users = await API.getUsers();
    (adminHost(__seq) || {}).innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Staff &amp; Admin Accounts</h3>
          <div class="flex gap-2">
            ${users.length>0?`<input type="text" placeholder="🔍 Search username..." style="width:180px;margin:0" oninput="filterTable(this.value,'staff-tb')" />`:''}
            <button class="btn btn-primary btn-sm" onclick="staffModal()">+ Add Staff</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>USERNAME</th><th>ROLE</th><th>CREATED</th><th>ACTIONS</th></tr></thead>
            <tbody id="staff-tb">
              ${users.map(u=>`<tr data-search="${u.username.toLowerCase()} ${u.role.toLowerCase()}">
                <td><strong>${u.username}</strong></td>
                <td><span class="badge ${u.role==='admin'?'badge-purple':'badge-blue'}">${u.role}</span></td>
                <td>${fmtDate(u.created_at)}</td>
                <td>${u.username!==JSON.parse(localStorage.getItem('sm_user')||'{}').username?`<button class="btn btn-danger btn-sm btn-icon" onclick="delStaffUser(${u.id},'${u.username}')">✕</button>`:'<span class="text-muted">You</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch(e) { (adminHost(__seq) || {}).innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
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
  const __seq = adminRenderSeq;
  try {
    const log = await API.getActivityLog();
    (adminHost(__seq) || {}).innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Recent Activity</h3>
          ${log.length>0?`<input type="text" placeholder="🔍 Search user, action, details..." style="width:220px;margin:0" oninput="filterTable(this.value,'audit-tb')" />`:''}
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>WHEN</th><th>USER</th><th>PAYS</th><th>ACTION</th><th>DETAILS</th></tr></thead>
            <tbody id="audit-tb">
              ${log.length===0
                ? `<tr class="empty-row"><td colspan="4">${emptyState('calendar', 'No activity yet', 'Actions taken in the app will be listed here.', '')}</td></tr>`
                : log.map(a=>`<tr data-search="${(a.username||'').toLowerCase()} ${a.action.toLowerCase()} ${(a.details||'').toLowerCase()}">
                  <td style="white-space:nowrap">${new Date(a.created_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                  <td>${a.username||'—'}</td>
                  <td><span class="badge badge-gray">${a.action}</span></td>
                  <td>${a.details||'—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch(e) { (adminHost(__seq) || {}).innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function renderAdminRefundsTab() {
  const __seq = adminRenderSeq;
  try {
    const refunds = await API.getDepositRefunds();
    (adminHost(__seq) || {}).innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3>Deposit Refund History</h3>
          ${refunds.length>0?`<input type="text" placeholder="🔍 Search guest, room..." style="width:200px;margin:0" oninput="filterTable(this.value,'refunds-tb')" />`:''}
        </div>
        <p class="text-muted" style="font-size:12px;padding:0 20px 12px">Real checkouts shouldn't normally need deleting — this is here mainly for cleaning up test or mistaken entries.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>GUEST</th><th>ROOM</th><th>DEPOSIT</th><th>DEDUCTIONS</th><th>REFUNDED</th><th>MODE</th><th>BY</th><th>ACTIONS</th></tr></thead>
            <tbody id="refunds-tb">
              ${refunds.length===0
                ? `<tr class="empty-row"><td colspan="9">${emptyState('logout', 'No checkouts yet', 'Deposit refunds appear here once a resident checks out.', '')}</td></tr>`
                : refunds.map(r=>`<tr data-search="${r.guest_name.toLowerCase()} ${(r.room_number||'').toLowerCase()}">
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
  } catch(e) { (adminHost(__seq) || {}).innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}

async function delDepositRefund(id) {
  if (!confirm('Delete this refund record? This should only be used to clean up test or mistaken entries, not real checkouts.')) return;
  try { await API.deleteDepositRefund(id); renderAdminRefundsTab(); } catch(e) { alert(e.message); }
}

/* ═══════════════════════════════════════════════════════════════
   SPRINT 1 — phone-first warden UX
   ═══════════════════════════════════════════════════════════════ */

const SM_PHONE = () => window.matchMedia('(max-width: 640px)').matches;

// One entry point for all the phone chrome added in Sprint 1. Safe to call
// twice — every piece checks whether it already exists.
function initPhoneChrome() {
  try { initTabBar(); initTopbarMore(); initMobileCards(); initCopilotBar(); initTopbarTools(); initBell(); } catch (e) { console.error(e); }
  loadIconSprite();
  loadAiStatus();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sm_theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) { btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 'ic ic-lg'); btn.title = theme === 'dark' ? 'Switch to light' : 'Switch to dark'; }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F1115' : '#F7F7F5');
}
function toggleTheme() { applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

function initTopbarTools() {
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn && !themeBtn.dataset.wired) { themeBtn.dataset.wired = '1'; themeBtn.onclick = toggleTheme; }
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  const search = document.getElementById('topbar-search');
  const add = document.getElementById('topbar-add');
  if (search && !search.dataset.wired) { search.dataset.wired = '1'; search.onclick = openSearch; }
  if (add && !add.dataset.wired) { add.dataset.wired = '1'; add.onclick = openQuickActions; }
  const chip = document.getElementById('today-chip');
  if (chip) { chip.textContent = 'Today · ' + new Date(Date.now() + 5.5 * 3600 * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }); chip.style.display = ''; }
  if (!window.__smKeys) {
    window.__smKeys = true;
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
      if (e.key === 'Escape') { closeSearch(); closeQuickActions(); }
    });
  }
}

// ── Tables → cards on phones ────────────────────────────────────
// Every list screen renders a <table> with a <thead>. Rather than rewriting
// ten row renderers, this copies each column's heading onto the matching cell
// as data-label and lets CSS stack them into cards. It runs after any change
// to #page-content, so screens that repaint only their <tbody> (filterGuests,
// filterRentDueList, …) are covered too.
function mobilizeTables(root) {
  // Callable with any element; defaults to the whole page body.
  const scope = root || document.getElementById('page-content');
  if (!scope) return;
  scope.querySelectorAll('table').forEach(table => {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
    if (!heads.length) return;
    table.classList.add('sm-cards');
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = [...tr.children];
      cells.forEach((td, i) => {
        if (td.colSpan > 1) { td.setAttribute('data-label', ''); return; }
        const label = heads[i] || '';
        td.setAttribute('data-label', label);
        const text = td.textContent.trim();
        // The first column is the card headline; a cell holding buttons is
        // the action footer; visually empty cells are dropped on phones.
        if (i === 0) td.classList.add('sm-card-title');
        else if (td.querySelector('button, a.btn')) td.classList.add('sm-card-actions');
        else if (!text || text === '—' || text === '-') td.classList.add('sm-empty');
        else td.classList.remove('sm-empty');
      });
    });
  });
}

let smMobilizeQueued = false;
function queueMobilize() {
  if (smMobilizeQueued) return;
  smMobilizeQueued = true;
  requestAnimationFrame(() => { smMobilizeQueued = false; try { mobilizeTables(); } catch (e) { console.error(e); } });
}

function initMobileCards() {
  const target = document.getElementById('page-content');
  if (!target) return;
  new MutationObserver(queueMobilize).observe(target, { childList: true, subtree: true });
  queueMobilize();
}

// ── Skeleton loading + empty states ─────────────────────────────
function skeleton(kind) {
  const cards = `<div class="sm-skel">${'<div class="sm-skel-card"></div>'.repeat(4)}</div>`;
  const lines = `<div class="sm-skel"><div class="sm-skel-line" style="width:40%;height:22px"></div>${'<div class="sm-skel-line"></div>'.repeat(6)}</div>`;
  setContent(kind === 'lines' ? lines : cards);
}

function emptyState(name, title, text, actionHtml) {
  const glyph = /^[a-z-]+$/.test(name) ? icon(name, 'ic ic-lg') : name;
  return `<div class="sm-empty-state">
    <span class="sm-empty-icon">${glyph}</span>
    <h4>${title}</h4>
    <p>${text || ''}</p>
    ${actionHtml || ''}
  </div>`;
}

// ── Topbar "more" menu on phones ────────────────────────────────
function initTopbarMore() {
  const right = document.getElementById('topbar-right');
  const actions = document.getElementById('topbar-actions');
  if (!right || !actions || document.getElementById('sm-topbar-more')) return;
  const btn = document.createElement('button');
  btn.id = 'sm-topbar-more';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'More actions');
  btn.textContent = '⋯';
  btn.onclick = (e) => { e.stopPropagation(); actions.classList.toggle('sm-open'); };
  right.appendChild(btn);
  document.addEventListener('click', () => actions.classList.remove('sm-open'));
  // A screen with no actions shouldn't show a dead "⋯".
  const sync = () => { btn.style.visibility = actions.children.length ? 'visible' : 'hidden'; };
  new MutationObserver(sync).observe(actions, { childList: true });
  sync();
}

// ── Bottom tab bar + Collect FAB ────────────────────────────────
const SM_TABS = [
  { page: 'dashboard', ic: 'home',   label: 'Home' },
  { page: 'guests',    ic: 'users',  label: 'Residents' },
  { page: 'rooms',     ic: 'bed',    label: 'Rooms' },
  { page: 'finance',   ic: 'wallet', label: 'Finance' },
  { page: '__more',    ic: 'more',   label: 'More' }
];
// Screens where "collect rent" is the obvious next action.
// The ＋ quick action in the topbar covers every screen, so the FAB stays
// only where collecting rent is the single obvious next step.
const SM_FAB_PAGES = ['rent-due'];

function initTabBar() {
  if (document.getElementById('sm-tabbar')) return;
  const bar = document.createElement('nav');
  bar.id = 'sm-tabbar';
  bar.className = 'sm-tabbar';
  bar.innerHTML = SM_TABS.map(t => `
    <button class="sm-tab" data-tab="${t.page}" type="button">
      <span class="sm-tab-icon">${icon(t.ic, 'ic ic-lg')}</span>${t.label}
    </button>`).join('');
  document.getElementById('app').appendChild(bar);
  bar.querySelectorAll('.sm-tab').forEach(b => {
    b.onclick = () => {
      const page = b.dataset.tab;
      if (page === '__more') { document.getElementById('sidebar').classList.toggle('open'); return; }
      document.getElementById('sidebar').classList.remove('open');
      navigate(page);
    };
  });

  const fab = document.createElement('button');
  fab.id = 'sm-fab';
  fab.className = 'sm-fab';
  fab.type = 'button';
  fab.innerHTML = icon('plus', 'ic ic-lg') + ' Collect';
  fab.onclick = () => navigate('collect');
  document.getElementById('app').appendChild(fab);
  syncChrome(currentPage);
}

function syncChrome(page) {
  const group = (typeof PAGE_GROUP !== 'undefined' && PAGE_GROUP[page]) || page;
  document.querySelectorAll('.sm-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === page || b.dataset.tab === group));
  const fab = document.getElementById('sm-fab');
  if (fab) fab.classList.toggle('sm-fab-on', SM_FAB_PAGES.includes(page));
  const actions = document.getElementById('topbar-actions');
  if (actions) actions.classList.remove('sm-open');
}

// ── COLLECT: rent in one screen ─────────────────────────────────
// Flow: pick resident (sorted by who owes most) → amount pre-filled from the
// running balance → mode → Save. Uses the existing POST /collections with the
// same fields as the old modal; no money logic is duplicated here.
const SM_MODES = ['Cash', 'UPI', 'Bank Transfer'];
let collectState = { guest: null, mode: 'Cash', type: 'rent', list: [] };

function monthLabelForCollect(d) {
  return new Date(d).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

async function pgCollect() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = '';
  const list = await API.getRentDue();
  // Who to chase first: biggest total payable at the top, settled at the bottom.
  collectState.list = [...list].sort((a, b) =>
    ((parseFloat(b.amount_due) || 0) + (parseFloat(b.deposit_pending) || 0)) -
    ((parseFloat(a.amount_due) || 0) + (parseFloat(a.deposit_pending) || 0)));
  collectState.guest = null;
  collectState.mode = 'Cash';
  collectState.type = 'rent';
  collectState.source = 'manual';
  collectState.voiceProposal = null;
  setContent(`
    <div class="page-header"><h1>${icon('rupee')} Collect</h1><p>Rent · <span class="sm-kn">ಬಾಡಿಗೆ ಸಂಗ್ರಹ</span></p></div>
    <div class="card" style="padding:16px">
      ${collectVoiceRow()}
      <div class="sm-collect-step">
        <h4>1 · Who is paying? <span class="sm-kn">ಯಾರು</span></h4>
        <input type="text" id="collect-search" placeholder="🔍 Search name, room or phone…" oninput="renderCollectPeople()" autocomplete="off"/>
        <div id="collect-people" style="max-height:46vh;overflow:auto;margin-top:10px"></div>
      </div>
      <div id="collect-rest" class="hidden"></div>
    </div>`);
  renderCollectPeople();
}

function renderCollectPeople() {
  const q = (document.getElementById('collect-search')?.value || '').toLowerCase().trim();
  let rows = collectState.list;
  if (q) rows = rows.filter(g => `${g.name} ${g.room_number || ''} ${g.phone || ''}`.toLowerCase().includes(q));
  const box = document.getElementById('collect-people');
  if (!box) return;
  if (!rows.length) { box.innerHTML = emptyState('🔍', 'No resident matches', 'Try a different name or room number.'); return; }
  box.innerHTML = rows.slice(0, 60).map(g => {
    const due = parseFloat(g.amount_due) || 0;
    const dep = parseFloat(g.deposit_pending) || 0;
    const total = due + dep;
    return `<button type="button" class="sm-person ${collectState.guest?.id === g.id ? 'selected' : ''}" onclick="selectCollectGuest(${g.id})">
      <span>
        <span class="sm-person-name">${g.name}</span><br>
        <span class="sm-person-sub">${g.room_number ? 'Room ' + g.room_number : 'No room'} · ${fmt(g.monthly_rent)}/mo</span>
      </span>
      <span class="sm-person-due ${total > 0 ? 'text-red' : 'text-green'}">${total > 0 ? fmt(total) : 'Settled'}</span>
    </button>`;
  }).join('');
}

function selectCollectGuest(id) {
  const g = collectState.list.find(x => String(x.id) === String(id));
  if (!g) return;
  collectState.guest = g;
  const due = parseFloat(g.amount_due) || 0;
  const dep = parseFloat(g.deposit_pending) || 0;
  // Pre-fill with what's actually outstanding; if nothing is due, fall back to
  // one month's rent. The warden can always overwrite it.
  const prefill = due > 0 ? due : (dep > 0 ? dep : parseFloat(g.monthly_rent) || 0);
  collectState.type = (due <= 0 && dep > 0) ? 'deposit' : 'rent';
  renderCollectPeople();
  const rest = document.getElementById('collect-rest');
  rest.classList.remove('hidden');
  rest.innerHTML = `
    <div class="sm-collect-step" style="margin-top:20px">
      <h4>2 · How much? <span class="sm-kn">ಎಷ್ಟು</span></h4>
      <input type="number" inputmode="numeric" id="collect-amount" class="sm-amount-input" value="${prefill || ''}"/>
      <div style="font-size:12px;color:var(--text-muted,var(--text-muted));margin-top:6px">
        ${due > 0 ? `Rent pending <span class="sm-kn">ಬಾಕಿ</span>: <strong class="text-red">${fmt(due)}</strong>` : 'No rent pending'}
        ${dep > 0 ? ` · Deposit <span class="sm-kn">ಠೇವಣಿ</span>: <strong class="text-red">${fmt(dep)}</strong>` : ''}
      </div>
      <div class="sm-chip-row" style="margin-top:10px">
        ${due > 0 ? `<button type="button" class="sm-chip" onclick="setCollectAmount(${due},'rent')">Full rent ${fmt(due)}</button>` : ''}
        ${dep > 0 ? `<button type="button" class="sm-chip" onclick="setCollectAmount(${dep},'deposit')">Deposit ${fmt(dep)}</button>` : ''}
        <button type="button" class="sm-chip" onclick="setCollectAmount(${parseFloat(g.monthly_rent) || 0},'rent')">1 month ${fmt(g.monthly_rent)}</button>
      </div>
    </div>
    <div class="sm-collect-step">
      <h4>3 · Paid how? <span class="sm-kn">ಹೇಗೆ</span></h4>
      <div class="sm-chip-row" id="collect-modes">
        ${SM_MODES.map(m => `<button type="button" class="sm-chip ${m === collectState.mode ? 'selected' : ''}" data-mode="${m}" onclick="setCollectMode('${m}')">${m}</button>`).join('')}
      </div>
    </div>
    <div class="sm-collect-step">
      <div class="form-row">
        <div class="form-group"><label>Date</label><input type="date" id="collect-date" value="${nowDate()}"/></div>
        <div class="form-group"><label>For month</label><input type="text" id="collect-month" value="${monthLabelForCollect(new Date())}"/></div>
      </div>
    </div>
    <div id="collect-alert" class="alert alert-danger hidden"></div>
    <button class="btn btn-success" id="collect-save" style="width:100%;justify-content:center;font-size:16px;padding:14px" onclick="saveCollectEntry()">✓ Save payment</button>`;
  rest.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setCollectAmount(v, type) {
  const el = document.getElementById('collect-amount');
  if (el) el.value = v;
  if (type) collectState.type = type;
}

function setCollectMode(m) {
  collectState.mode = m;
  document.querySelectorAll('#collect-modes .sm-chip').forEach(c => c.classList.toggle('selected', c.dataset.mode === m));
}

async function saveCollectEntry() {
  const al = document.getElementById('collect-alert');
  const btn = document.getElementById('collect-save');
  const g = collectState.guest;
  const amount = parseFloat(document.getElementById('collect-amount').value);
  if (!g) { showAlert(al, 'Pick a resident first'); return; }
  if (!amount || amount <= 0) { showAlert(al, 'Enter an amount'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const saved = await API.createCollection({
      guest_id: g.id,
      guest_name: g.name,
      amount,
      collection_date: document.getElementById('collect-date').value || nowDate(),
      collection_type: collectState.type,
      payment_mode: collectState.mode,
      collection_month: document.getElementById('collect-month').value || '',
      description: '',
      source: collectState.source || 'manual'
    });
    showCollectDone(g, amount, saved);
  } catch (e) {
    btn.disabled = false; btn.textContent = '✓ Save payment';
    showAlert(al, e.message);
  }
}

function showCollectDone(g, amount, saved) {
  const pending = saved && saved.status && saved.status !== 'confirmed';
  const msg = `Hi ${g.name}, we have received ${fmt(amount)} towards ${collectState.type === 'deposit' ? 'your deposit' : 'rent'} at Siri Mane PG. Thank you!`;
  const wa = buildWhatsappUrl(g.phone, msg);
  setContent(`
    <div class="card sm-done-card">
      <div class="sm-done-tick">✅</div>
      <h3 style="margin:8px 0 4px">${fmt(amount)} recorded</h3>
      <p class="text-muted" style="margin-bottom:6px">${g.name}${g.room_number ? ' · Room ' + g.room_number : ''}</p>
      ${pending ? `<p style="font-size:13px;color:var(--amber)">Waiting for admin confirmation before it counts as income.</p>` : ''}
      <div style="display:grid;gap:10px;max-width:320px;margin:18px auto 0">
        ${wa ? `<a class="btn btn-success" style="justify-content:center" href="${wa}" target="_blank" rel="noopener">${icon('whatsapp')} Send receipt on WhatsApp</a>` : `<span class="text-muted" style="font-size:13px">No phone number on file for WhatsApp</span>`}
        ${(saved && saved.id && !pending) ? `<button class="btn btn-outline" onclick="downloadReceipt(${saved.id})">${icon('receipt')} Download receipt</button>` : ''}
        <button class="btn btn-primary" onclick="navigate('collect')">${icon('plus')} Collect from someone else</button>
        <button class="btn btn-outline" onclick="navigate('rent-due')">${icon('calendar')} Back to Rent Due</button>
      </div>
    </div>`);
}

// Entry point from Rent Due's per-resident "Collect" button.
async function collectFrom(guestId) {
  await pgCollect();
  selectCollectGuest(guestId);
}

/* ═══════════════════════════════════════════════════════════════
   SPRINT 3 — AI-first inputs: voice + photo, always preview → confirm
   Nothing in this block writes to the server. It only fills forms; the
   existing Save buttons do the writing, exactly as if the warden typed.
   ═══════════════════════════════════════════════════════════════ */

let aiStatus = { vision: false, text: false };
async function loadAiStatus() {
  try { aiStatus = await apiFetch('/ai/status'); } catch { aiStatus = { vision: false, text: false }; }
}

// ── Generic on-device voice engine (Web Speech API) ─────────────
// One engine for Collect and Complaints; the Purchase modal keeps its own
// (older) copy untouched.
let smRec = null;
function smVoice(btnId, statusId, onText, hint) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const btn = document.getElementById(btnId);
  const status = document.getElementById(statusId);
  if (!btn || !status) return;
  const say = (msg, err) => { status.textContent = msg; status.classList.toggle('voice-error', !!err); };
  if (!Ctor) { say('Voice needs Chrome on Android. Please type instead.', true); return; }
  if (smRec) { try { smRec.stop(); } catch {} smRec = null; return; }
  try {
    const rec = new Ctor();
    smRec = rec;
    rec.lang = 'en-IN'; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onstart = () => { btn.classList.add('listening'); btn.textContent = '⏹'; say('Listening… ' + (hint || 'speak now')); };
    rec.onresult = e => {
      const t = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
      if (!t) { say('Didn\'t catch that — tap the mic and try again', true); return; }
      say(`Heard: "${t}"`);
      try { onText(t); } catch (err) { console.error(err); say('Couldn\'t understand that — please fill the form', true); }
    };
    rec.onerror = e => {
      const m = { 'no-speech': 'Didn\'t hear anything — tap the mic and try again', 'audio-capture': 'No microphone found', 'not-allowed': 'Microphone permission denied — allow it in Chrome settings', 'network': 'Network error — check your signal', 'aborted': '' };
      const msg = e && e.error in m ? m[e.error] : 'Voice input failed — please fill the form';
      if (msg) say(msg, true);
    };
    rec.onend = () => { smRec = null; btn.classList.remove('listening'); btn.textContent = '🎤'; };
    rec.start();
  } catch { smRec = null; say('Could not start voice on this device', true); }
}

// ── Camera capture → downscaled JPEG data URL ───────────────────
// Phones produce 3–8 MB photos; a bill is perfectly readable at 1280px and
// ~200 kB, which matters on 4G and keeps us well under the server's limit.
function smPickPhoto() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.style.display = 'none';
    input.onchange = () => { const f = input.files && input.files[0]; input.remove(); resolve(f || null); };
    document.body.appendChild(input);
    input.click();
  });
}
function smDownscale(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}
async function smScan(kind, statusEl) {
  const file = await smPickPhoto();
  if (!file) return null;
  if (statusEl) statusEl.textContent = 'Reading the photo…';
  const image = await smDownscale(file);
  // The image goes to the server for one request and is discarded there.
  return apiFetch('/ai/vision', { method: 'POST', body: { kind, image } });
}

// Small helper: fill a field and flash it so the warden sees what changed.
function smFill(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === '') return false;
  el.value = value;
  el.classList.add('voice-filled');
  setTimeout(() => el.classList.remove('voice-filled'), 1200);
  return true;
}

// ── COLLECT by voice ─────────────────────────────────────────────
function collectVoiceRow() {
  return `
    <div class="voice-row" style="margin-bottom:12px">
      <button type="button" id="collect-mic" class="mic-btn" onclick="collectVoiceToggle()" aria-label="Fill by voice">🎤</button>
      <span id="collect-voice-status" class="voice-status">Tap the mic and say e.g. "Priya room 12 six thousand UPI" · <span class="sm-kn">ಹೇಳಿ</span></span>
    </div>
    <div id="collect-preview" class="hidden"></div>`;
}
function collectVoiceToggle() {
  smVoice('collect-mic', 'collect-voice-status', collectApplyVoice, 'name, room, amount, mode');
}
async function collectApplyVoice(text) {
  const residents = collectState.list.map(g => ({ id: g.id, name: g.name, room_number: g.room_number }));
  let p = SMParse.parseCollection(text, residents);
  // The on-device parser handles almost everything; only fall back to the
  // server (Groq) when it could not identify the resident.
  if (!p.guest && aiStatus.text) {
    try {
      const r = await apiFetch('/ai/parse', { method: 'POST', body: { kind: 'collection', text } });
      if (r.guest_id) p.guest = collectState.list.find(g => g.id === r.guest_id) || null;
      if (!p.amount && r.amount) p.amount = r.amount;
      if (!p.mode && r.mode) p.mode = r.mode;
      if (r.type) p.type = r.type;
    } catch { /* stay with local result */ }
  }
  showCollectPreview(text, p);
}
function showCollectPreview(text, p) {
  const box = document.getElementById('collect-preview');
  if (!box) return;
  box.classList.remove('hidden');
  if (!p.guest) {
    box.innerHTML = `<div class="alert alert-warning" style="display:block">I heard <em>"${text}"</em> but couldn't tell which resident. Tap her name below, then say it again or type the amount.</div>`;
    return;
  }
  const due = parseFloat(p.guest.amount_due) || 0;
  box.innerHTML = `
    <div class="card" style="padding:14px;border:2px solid var(--primary);background:var(--accent-soft)">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,var(--text-muted))">AI heard — please check</div>
      <div style="font-size:16px;font-weight:700;margin:6px 0 2px">${p.guest.name}${p.guest.room_number ? ' · Room ' + p.guest.room_number : ''}</div>
      <div style="font-size:14px">${p.amount ? '<strong>' + fmt(p.amount) + '</strong>' : '<span class="text-red">amount not heard</span>'} · ${p.mode || 'mode not heard'} · ${p.type}</div>
      ${p.amount && due > 0 && Math.abs(p.amount - due) > 0.5 ? `<div style="font-size:12px;color:var(--amber);margin-top:4px">Her running balance is ${fmt(due)} — different from what was said.</div>` : ''}
      <div class="flex gap-2" style="margin-top:10px">
        <button class="btn btn-primary btn-sm" onclick="collectUseVoice()">✓ Use this</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('collect-preview').classList.add('hidden')">✗ Ignore</button>
      </div>
    </div>`;
  collectState.voiceProposal = p;
}
function collectUseVoice() {
  const p = collectState.voiceProposal;
  if (!p || !p.guest) return;
  selectCollectGuest(p.guest.id);
  if (p.amount) setCollectAmount(p.amount, p.type);
  else collectState.type = p.type;
  if (p.mode) setCollectMode(p.mode);
  collectState.source = 'voice';
  document.getElementById('collect-preview').classList.add('hidden');
  const btn = document.getElementById('collect-save');
  if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── COMPLAINT by voice ───────────────────────────────────────────
function complaintVoiceToggle() {
  smVoice('cp-mic', 'cp-voice-status', complaintApplyVoice, 'describe the problem');
}
async function complaintApplyVoice(text) {
  const p = SMParse.parseComplaint(text);
  let category = p.category, description = p.description;
  if (category === 'Other' && aiStatus.text) {
    try { const r = await apiFetch('/ai/parse', { method: 'POST', body: { kind: 'complaint', text } }); if (r.category) category = r.category; } catch {}
  }
  const box = document.getElementById('cp-preview');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="card" style="padding:12px;border:2px solid var(--primary);background:var(--accent-soft);margin-bottom:12px">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,var(--text-muted))">AI heard — please check</div>
      <div style="font-size:14px;margin:6px 0"><strong>${category}</strong>${p.room ? ' · Room ' + p.room : ''}<br>${description}</div>
      <div class="flex gap-2">
        <button class="btn btn-primary btn-sm" onclick="complaintUseVoice(${JSON.stringify({ category, description, room: p.room }).replace(/"/g, '&quot;')})">✓ Use this</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('cp-preview').classList.add('hidden')">✗ Ignore</button>
      </div>
    </div>`;
}
function complaintUseVoice(p) {
  const sel = document.getElementById('cp-category');
  if (sel && [...sel.options].some(o => o.value === p.category)) smFill('cp-category', p.category);
  smFill('cp-desc', p.description);
  if (p.room) smFill('cp-room', 'Room ' + p.room);
  window.complaintSource = 'voice';
  document.getElementById('cp-preview').classList.add('hidden');
}

// ── PURCHASE from a bill photo ───────────────────────────────────
async function purchaseScanBill() {
  const status = document.getElementById('pu-voice-status');
  try {
    const r = await smScan('bill', status);
    if (!r) return;
    const f = r.fields;
    const box = document.getElementById('pu-preview');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="card" style="padding:12px;border:2px solid var(--primary);background:var(--accent-soft);margin-bottom:12px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,var(--text-muted))">Read from the bill (${f.confidence} confidence) — please check</div>
        <div style="font-size:14px;margin:6px 0">
          <strong>${f.amount ? fmt(f.amount) : 'amount not found'}</strong>${f.paid_to ? ' · ' + f.paid_to : ''}${f.purchase_date ? ' · ' + fmtDate(f.purchase_date) : ''}<br>
          ${f.category || 'category?'}${f.description ? ' — ' + f.description : ''}${f.payment_mode ? ' · ' + f.payment_mode : ''}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick='purchaseUseScan(${JSON.stringify(f).replace(/'/g, "&#39;")})'>✓ Use this</button>
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('pu-preview').classList.add('hidden')">✗ Ignore</button>
        </div>
      </div>`;
    if (status) status.textContent = 'Bill read. Check the preview and tap "Use this".';
  } catch (e) {
    if (status) { status.textContent = e.message; status.classList.add('voice-error'); }
  }
}
function purchaseUseScan(f) {
  smFill('pu-amt', f.amount); smFill('pu-paid', f.paid_to); smFill('pu-date', f.purchase_date);
  smFill('pu-desc', f.description);
  const cat = document.getElementById('pu-cat');
  if (cat && f.category && [...cat.options].some(o => o.value === f.category)) smFill('pu-cat', f.category);
  const mode = document.getElementById('pu-mode');
  if (mode && f.payment_mode && [...mode.options].some(o => o.value === f.payment_mode)) smFill('pu-mode', f.payment_mode);
  window.purchaseSource = 'photo';
  document.getElementById('pu-preview').classList.add('hidden');
}

// ── GUEST fields from an ID photo ────────────────────────────────
async function guestScanId() {
  const status = document.getElementById('gf-scan-status');
  if (!confirm('The ID photo is sent once to the AI reader to fill the form, then discarded. It is never stored. Continue?')) return;
  try {
    const r = await smScan('id', status);
    if (!r) return;
    const f = r.fields;
    const box = document.getElementById('gf-preview');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="card" style="padding:12px;border:2px solid var(--primary);background:var(--accent-soft);margin-bottom:12px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,var(--text-muted))">Read from the ID (${f.confidence} confidence) — please check</div>
        <div style="font-size:14px;margin:6px 0">
          <strong>${f.name || 'name not found'}</strong>${f.id_proof_type ? ' · ' + f.id_proof_type : ''}${f.id_proof_number ? ' · ' + f.id_proof_number.replace(/.(?=.{4})/g, '•') : ''}<br>
          <span style="font-size:13px;color:var(--text-muted,var(--text-muted))">${f.address || 'address not found'}</span>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick='guestUseScan(${JSON.stringify(f).replace(/'/g, "&#39;")})'>✓ Use this</button>
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('gf-preview').classList.add('hidden')">✗ Ignore</button>
        </div>
      </div>`;
    if (status) status.textContent = 'ID read. Check the preview and tap "Use this".';
  } catch (e) {
    if (status) { status.textContent = e.message; status.classList.add('voice-error'); }
  }
}
const ID_TYPE_MAP = { 'Aadhaar': 'Aadhaar', 'PAN': 'PAN Card', 'Passport': 'Passport', 'Driving Licence': 'Driving License', 'Voter ID': 'Voter ID' };
function guestUseScan(f) {
  smFill('gf-name', f.name); smFill('gf-address', f.address); smFill('gf-idnum', f.id_proof_number);
  const t = ID_TYPE_MAP[f.id_proof_type];
  if (t) smFill('gf-idtype', t);
  document.getElementById('gf-preview').classList.add('hidden');
}

// Admin → Settings → "Test AI connection": one live call to each provider so a
// wrong key or a retired model name shows up here, not in the warden's hands.
async function runAiProbe() {
  const btn = document.getElementById('ai-probe-btn');
  const out = document.getElementById('ai-probe-result');
  btn.disabled = true; out.textContent = 'Testing…';
  try {
    const r = await apiFetch('/ai/probe');
    const line = (name, x) => `${x.ok ? '✅' : '❌'} ${name} <code>${x.model}</code>${x.ok ? ` — ${x.ms} ms` : ` — ${x.error || 'unexpected reply: ' + (x.reply || '')}`}`;
    out.innerHTML = line('Gemini', r.gemini) + '<br>' + line('Groq', r.groq);
  } catch (e) { out.textContent = e.message; }
  finally { btn.disabled = false; }
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 4 — the warden's assistant: brief, reminders, priority, ask
   ═══════════════════════════════════════════════════════════════ */
let briefCache = null;
let appSettingsCache = null;
async function getAppSettings() {
  if (appSettingsCache) return appSettingsCache;
  try { appSettingsCache = isAdmin() ? await API.getSettings() : {}; } catch { appSettingsCache = {}; }
  return appSettingsCache;
}

async function loadAttention() {
  const card = document.getElementById('attention-card');
  if (!card) return;
  try {
    const flags = await apiFetch('/owner/anomalies');
    if (!flags.length) { card.classList.add('hidden'); return; }
    const color = { high: 'var(--red)', medium: 'var(--amber)', low: 'var(--text-muted,var(--text-muted))' };
    document.getElementById('attention-list').innerHTML = flags.slice(0, 6).map(f => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="flex:0 0 8px;height:8px;border-radius:50%;background:${color[f.level]};margin-top:6px"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600">${f.title}${f.why ? whyBtn(f.why, 'Why is this flagged?') : ''}</div>
          <div style="font-size:12px;color:var(--text-muted,var(--text-muted))">${f.detail}</div>
        </div>
        ${f.action ? `<button class="btn btn-outline btn-sm" style="min-height:36px" onclick="navigate('${f.action}')">Open</button>` : ''}
      </div>`).join('') + (flags.length > 6 ? `<div class="text-muted" style="font-size:12px;padding-top:8px">…and ${flags.length - 6} more in the owner report</div>` : '');
    card.classList.remove('hidden');
  } catch (e) { card.classList.add('hidden'); }
}

async function loadBrief(force) {
  const body = document.getElementById('brief-body');
  if (!body) return;
  try {
    briefCache = await apiFetch('/copilot/brief' + (force ? '?force=1' : ''));
    const b = briefCache;
    document.getElementById('brief-greeting').textContent = `☀️ ${b.greeting}`;
    const pill = document.getElementById('health-pill');
    pill.textContent = `Health ${b.health.overall}`;
    pill.className = 'health-pill ' + (b.health.overall >= 80 ? 'good' : b.health.overall >= 60 ? 'ok' : 'low');
    pill.onclick = () => showHealthDetail(b.health);
    const level = (arr, dot) => arr.map(l => `<div class="brief-line">${dot} ${l}</div>`).join('');
    body.innerHTML = `
      <div class="brief-date">${b.dateLabel}</div>
      <div class="brief-section"><div class="brief-h">What changed</div>${b.changed.map(l => `<div class="brief-line">• ${l}</div>`).join('')}</div>
      <div class="brief-section"><div class="brief-h">Needs attention</div>
        ${level(b.attention.high, '🔴')}${level(b.attention.medium, '🟠')}${level(b.attention.low, '🟢')}
        ${!b.attention.high.length && !b.attention.medium.length && !b.attention.low.length ? '<div class="brief-line">✅ Nothing needs attention</div>' : ''}
      </div>
      <div class="brief-section"><div class="brief-h">Siri recommends</div>
        ${b.recommendations.map((r, i) => `<div class="brief-rec"><span>${i + 1}. ${r.text}</span>
          <button class="btn btn-primary btn-sm" onclick='${r.action.navigate ? `navigate("${r.action.navigate}")` : `copilotAsk(${JSON.stringify(r.action.ask)})`}'>${r.action.label}</button></div>`).join('')}
      </div>`;
    const when = new Date(b.computed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('brief-meta').textContent = `Computed ${when}${b.cached ? ' · tap ↻ for fresh numbers' : ''}`;
  } catch (e) { body.textContent = 'Could not load the brief: ' + e.message; }
}
function showHealthDetail(h) {
  const rows = Object.entries(h.components).map(([k, c]) => `
    <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div><div style="font-weight:600;text-transform:capitalize">${k}</div><div style="font-size:12px;color:var(--text-muted,var(--text-muted))">${c.why}</div></div>
      <div style="font-size:18px;font-weight:700;white-space:nowrap">${c.score == null ? '—' : c.score}</div>
    </div>`).join('');
  openModal(`<div class="modal"><div class="modal-header"><h3>Property health · ${h.overall}/100</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><p class="text-muted" style="font-size:12px;margin-bottom:8px">Each part is a plain rule you can check; the overall is their average. Resident experience joins once residents start rating meals.</p>${rows}</div></div>`);
}
async function showEvening() {
  try {
    const e = await apiFetch('/copilot/evening');
    openModal(`<div class="modal"><div class="modal-header"><h3>🌙 Evening summary</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55">${e.text}</pre>
      <div class="flex gap-2" style="margin-top:12px"><a class="btn btn-success btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(e.text)}">💬 WhatsApp</a><button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText(${JSON.stringify('')} + document.querySelector('.modal-body pre').textContent).then(()=>toast('Copied','ok'))">📋 Copy</button></div></div></div>`);
  } catch (err) { toast(err.message); }
}
async function shareBrief() {
  if (!briefCache) return;
  const settings = await getAppSettings();
  const to = settings.owner_phone || settings.pg_phone || '';
  const url = to ? buildWhatsappUrl(to, briefCache.text) : null;
  if (url) window.open(url, '_blank', 'noopener');
  else if (navigator.share) navigator.share({ text: briefCache.text }).catch(() => {});
  else copyBrief();
}
function copyBrief() {
  if (!briefCache) return;
  navigator.clipboard?.writeText(briefCache.text).then(() => toast('Brief copied', 'ok')).catch(() => toast('Copy not available on this browser'));
}
async function askSiriMane() { const q = document.getElementById('ask-q')?.value; if (q) copilotAsk(q); }
function priorityBadge(p) {
  const map = { high: ['badge-red', '🔴 High'], medium: ['badge-amber', '🟡 Medium'], low: ['badge-gray', '⚪ Low'] };
  const [cls, label] = map[p] || map.medium;
  return `<span class="badge ${cls}">${label}</span>`;
}

// ── Rent reminders: AI-drafted, warden reviews, sends one by one ────────
let reminderState = { lang: 'en', list: [] };
async function pgReminders() {
  loading();
  document.getElementById('topbar-actions').innerHTML = '';
  const settings = await getAppSettings();
  reminderState.lang = settings.reminder_lang === 'kn' ? 'kn' : (reminderState.lang || 'en');
  await renderReminders();
}
async function renderReminders() {
  const list = await apiFetch('/assistant/reminders?lang=' + reminderState.lang);
  reminderState.list = list;
  const total = list.reduce((t, g) => t + (parseFloat(g.amount_due) || 0), 0);
  setContent(`
    <div class="page-header"><h1>Rent Reminders <span class="sm-kn" style="font-size:15px">ಜ್ಞಾಪನೆ</span></h1>
      <p>${list.length ? `${list.length} resident${list.length === 1 ? ' owes' : 's owe'} ${fmt(total)}. Each message is drafted from her exact balance — read it, edit if you like, then send.` : 'Nobody owes rent right now.'}</p>
    </div>
    <div class="sm-chip-row" style="margin-bottom:14px">
      <button class="sm-chip ${reminderState.lang === 'en' ? 'selected' : ''}" onclick="reminderState.lang='en';renderReminders()">English</button>
      <button class="sm-chip ${reminderState.lang === 'kn' ? 'selected' : ''}" onclick="reminderState.lang='kn';renderReminders()">ಕನ್ನಡ</button>
    </div>
    ${list.length ? list.map((g, i) => `
      <div class="card" style="padding:14px;margin-bottom:12px" id="rem-${g.guest_id}">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div><strong style="font-size:15px">${g.name}</strong><div class="text-muted" style="font-size:12px">${g.room_number ? 'Room ' + g.room_number + ' · ' : ''}${fmt(g.amount_due)} due${g.months_behind >= 1 ? ' · ' + g.months_behind + ' month' + (g.months_behind === 1 ? '' : 's') : ''}</div></div>
          ${g.last_reminded ? `<span class="badge badge-gray" title="Last reminded">sent ${fmtDate(g.last_reminded)}</span>` : ''}
        </div>
        <textarea id="rem-text-${g.guest_id}" rows="4" style="margin-top:10px;font-size:14px">${g.text}</textarea>
        <div class="flex gap-2" style="margin-top:8px">
          ${g.phone ? `<button class="btn btn-success btn-sm" onclick="sendReminder(${g.guest_id})">${icon('whatsapp')} Send on WhatsApp</button>` : `<span class="text-muted" style="font-size:12px">No phone on file</span>`}
          <button class="btn btn-outline btn-sm" onclick="collectFrom(${g.guest_id})">${icon('rupee')} Collect</button>
        </div>
      </div>`).join('') : emptyState('🎉', 'All rent collected', 'There is nobody to remind.')}
  `);
}
async function sendReminder(guestId) {
  const g = reminderState.list.find(x => x.guest_id === guestId);
  if (!g) return;
  const text = document.getElementById('rem-text-' + guestId).value.trim();
  const url = buildWhatsappUrl(g.phone, text);
  if (!url) { toast('Phone number looks invalid'); return; }
  window.open(url, '_blank', 'noopener');
  try { await apiFetch('/assistant/reminders/sent', { method: 'POST', body: { guest_id: guestId, text, lang: reminderState.lang } }); } catch {}
  const card = document.getElementById('rem-' + guestId);
  if (card) card.style.opacity = '0.6';
}

/* ═══════════════════════════════════════════════════════════════
   SPRINT 5 — owner intelligence
   ═══════════════════════════════════════════════════════════════ */
let ownerReportCache = null;
async function loadOwnerReport(force) {
  const month = document.getElementById('owner-month')?.value;
  const out = document.getElementById('owner-summary');
  if (!out) return;
  out.textContent = 'Computing…';
  try {
    const r = await apiFetch(`/owner/report?month=${month}${force ? '&force=1' : ''}`);
    ownerReportCache = r;
    out.textContent = r.summary;
    document.getElementById('owner-forecast').innerHTML = `Next 3 months (simple projection): ` +
      r.forecast.months.map(m => `<strong>${m.label}</strong> ${fmt(m.income)} in / ${fmt(m.expenses)} out`).join(' · ') +
      `<br><span style="font-size:11px">${r.forecast.basis}</span>`;
    document.getElementById('owner-meta').textContent = `${r.cached ? 'Final report' : 'Computed just now'} · ${new Date(r.generated_at).toLocaleString('en-IN')}`;
  } catch (e) { out.textContent = 'Could not load the owner report: ' + e.message; }
}
function downloadOwnerPdf() {
  const month = document.getElementById('owner-month').value;
  API.downloadExport(`/owner/report/pdf?month=${month}`, `owner-report-${month}.pdf`).catch(e => toast(e.message));
}
function shareOwnerSummary() {
  if (!ownerReportCache) return;
  const text = `📈 *Siri Mane — ${ownerReportCache.label}*\n\n${ownerReportCache.summary}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}
function downloadAccountantZip() {
  const month = document.getElementById('owner-month').value;
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  API.downloadExport(`/owner/export.zip?from=${from}&to=${to}`, `sirimane-export-${month}.zip`).catch(e => toast(e.message));
}

// Admin page: schema banner from /health
async function loadSchemaBanner() {
  const host = document.getElementById('schema-banner');
  if (!host) return;
  try {
    const res = await fetch('/health'); const h = await res.json();
    if (h.schema === 'missing') {
      host.innerHTML = `<div class="alert alert-danger" style="display:block">
        <strong>Database needs a migration.</strong> Missing: ${h.schemaMissing.join(', ')}.<br>
        In the Railway console run: <code>node backend/scripts/migrate-all.js</code></div>`;
    } else host.innerHTML = '';
  } catch { /* no banner */ }
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 6 — Copilot bar: one entry point on every screen.
   Inform answers render inline; prepare answers show a preview with a
   Confirm button; execute only ever happens through that button.
   ═══════════════════════════════════════════════════════════════ */
const smContext = { page: 'dashboard', resident_id: null, resident_name: null, room_number: null };
function smSetContext(patch) { Object.assign(smContext, patch); renderCopilotChips(); }

const COPILOT_CHIPS = {
  dashboard: ['What needs attention today?', 'Who has not paid?', 'Which rooms are vacant?'],
  collect: ['Record 6000 rent from … by UPI', 'Who owes more than 10,000?'],
  guests: ['Who joined recently?', 'Who is 2+ months behind?', 'Find …'],
  rooms: ['Which rooms are vacant?', 'Who is in room …?'],
  'rent-due': ['Who is repeatedly late?', 'Send reminders to residents 2+ months behind'],
  reminders: ['Send reminders to residents 1+ months behind'],
  complaints: ['Which complaint is taking too long?', 'Geyser not working in room …'],
  purchases: ['Expense 500 vegetables paid to … cash', 'Expenses this month'],
  payments: ['Who has not paid?', 'How much collected this month?'],
  reports: ['How is this month compared to last month?', 'Give me a report'],
  admin: ['What needs attention today?']
};
function renderCopilotChips() {
  const host = document.getElementById('copilot-chips');
  if (!host) return;
  let chips = COPILOT_CHIPS[smContext.page] || COPILOT_CHIPS.dashboard;
  if (smContext.resident_name) chips = [`Summarise ${smContext.resident_name.split(' ')[0]}`, 'Why is she overdue?', ...chips.slice(0, 1)];
  else if (smContext.room_number) chips = [`What's wrong here?`, `Who is in room ${smContext.room_number}?`, ...chips.slice(0, 1)];
  host.innerHTML = chips.map(c => `<button type="button" class="copilot-chip" onclick="copilotAsk(${JSON.stringify(c)})">${c}</button>`).join('');
}

function initCopilotBar() {
  if (document.getElementById('copilot-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'copilot-bar';
  bar.innerHTML = `
    <div class="copilot-row">
      <span class="copilot-orb" aria-hidden="true">✦</span>
      <input type="text" id="copilot-q" placeholder="onion 100 · Jhanavi 5000 upi · tap leaking… or ask" autocomplete="off"
        onkeydown="if(event.key==='Enter'){copilotAsk(this.value)}" onfocus="document.getElementById('copilot-bar').classList.add('focus')" onblur="document.getElementById('copilot-bar').classList.remove('focus')"/>
      <button type="button" class="mic-btn" id="copilot-mic" onclick="copilotVoice()" aria-label="Speak">🎤</button>
      <button type="button" class="btn btn-primary btn-sm" id="copilot-go" onclick="copilotAsk(document.getElementById('copilot-q').value)">Ask</button>
    </div>
    <div id="copilot-chips" class="copilot-chips"></div>
    <div id="copilot-voice-status" class="voice-status" style="padding:2px 4px;min-height:0"></div>
    <div id="copilot-out" class="copilot-out hidden"></div>`;
  const content = document.getElementById('page-content');
  content.parentNode.insertBefore(bar, content);
  renderCopilotChips();
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('copilot-q').focus(); } });
}
function copilotVoice() { smVoice('copilot-mic', 'copilot-voice-status', t => copilotAsk(t), 'ask or tell me what to record'); }

let copilotBusy = false;
async function copilotAsk(text) {
  const q = String(text || '').trim();
  if (!q || copilotBusy) return;
  const out = document.getElementById('copilot-out');
  const input = document.getElementById('copilot-q');
  input.value = q;
  out.classList.remove('hidden');
  out.innerHTML = `<div class="copilot-answer"><div class="sm-skel"><div class="sm-skel-line" style="width:70%"></div><div class="sm-skel-line" style="width:40%"></div></div></div>`;
  copilotBusy = true;
  try {
    const r = await apiFetch('/copilot/ask', { method: 'POST', body: { text: q, context: { page: smContext.page, resident_id: smContext.resident_id, resident_name: smContext.resident_name, room_number: smContext.room_number } } });
    renderCopilotResult(r);
  } catch (e) { out.innerHTML = `<div class="copilot-answer copilot-err">${e.message}</div>`; }
  finally { copilotBusy = false; input.select(); }
}

function renderCopilotResult(r) {
  const out = document.getElementById('copilot-out');
  const ev = (r.evidence || []).slice(0, 8);
  const evidence = ev.length ? `<div class="copilot-evidence">${ev.map(x => {
    if (x.text && x.name) return `<div><strong>${x.name}</strong>${x.room ? ' · Room ' + x.room : ''} — ${fmt(x.amount_due)}</div>`;
    if (x.name && 'amount_due' in x) return `<div><strong>${x.name}</strong>${x.room || x.room_number ? ' · Room ' + (x.room || x.room_number) : ''} — ${fmt(x.amount_due)}${x.months ? ` · ${x.months} mo` : ''}</div>`;
    if (x.room_number && 'vacant' in x) return `<div><strong>Room ${x.room_number}</strong> — ${x.vacant} free of ${x.total_beds}${x.residents && x.residents.length ? ' · ' + x.residents.map(z => z.name).join(', ') : ''}</div>`;
    if (x.category && x.description) return `<div><strong>${x.category}</strong> · ${x.priority || ''}${x.room_number ? ' · Room ' + x.room_number : ''} — ${x.description}${x.age_days != null ? ` (${x.age_days} d)` : ''}</div>`;
    return `<div>${x.name || x.title || JSON.stringify(x)}</div>`;
  }).join('')}${(r.evidence || []).length > 8 ? `<div class="text-muted">…and ${r.evidence.length - 8} more</div>` : ''}</div>` : '';
  const preview = r.proposal ? `<div class="copilot-preview"><div class="copilot-preview-h">Siri prepared — check before confirming</div>${previewRows(r.proposal.preview)}</div>` : '';
  const wizardBtn = r.openWizard ? `<button class="btn btn-success" onclick='openWizardFromCopilot(${JSON.stringify(r.openWizard).replace(/'/g, "&#39;")});copilotDismiss()'>${r.openWizard.kind === 'checkout' ? 'Open checkout' : 'Open move-in form'}</button>` : '';
  const buttons = wizardBtn + (r.actions || []).map(a => {
    if (a.confirm) return `<button class="btn btn-success" onclick="copilotConfirm('${a.confirm}', this)">✓ ${a.label}</button>`;
    if (a.navigate) return `<button class="btn btn-outline btn-sm" onclick="navigate('${a.navigate}')">${a.label}</button>`;
    if (a.download) return `<button class="btn btn-outline btn-sm" onclick="API.downloadExport('${a.download}','${a.filename || 'file'}').catch(e=>toast(e.message))">📄 ${a.label}</button>`;
    if (a.tool) return `<button class="btn btn-outline btn-sm" onclick='copilotRetool(${JSON.stringify(a).replace(/'/g, "&#39;")})'>${a.label}</button>`;
    return '';
  }).join('');
  const conf = r.confidence === 'low' ? '<span class="copilot-conf">not sure</span>' : '';
  out.innerHTML = `<div class="copilot-answer ${r.clarify ? 'copilot-ask' : ''}">
    <div class="copilot-text">${(r.answer || '').replace(/\n/g, '<br>')} ${conf}</div>${evidence}${preview}
    ${buttons ? `<div class="copilot-actions">${buttons}${r.proposal ? '<button class="btn btn-outline btn-sm" onclick="copilotDismiss()">✗ Cancel</button>' : ''}</div>` : ''}
  </div>`;
  // Sprint 14: "What was ₹300 for?" leaves "300 " in the box, cursor at the
  // end — she types the item and presses Enter. No retyping the number.
  if (r.retry_text) { const q = document.getElementById('copilot-q'); if (q) { q.value = r.retry_text; q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}
function previewRows(p) {
  if (!p) return '';
  const label = { guest_name: 'Resident', amount: 'Amount', payment_mode: 'Mode', collection_type: 'Type', collection_date: 'Date', collection_month: 'For', category: 'Category', paid_to: 'Paid to', description: 'Details', purchase_date: 'Date', priority: 'Priority', title: 'Title', message: 'Message', effective_from: 'From', bed_number: 'Bed', id: 'Request', from: 'Currently', status: 'Change to', note: 'Note', room_number: 'Room' };
  return Object.entries(p).filter(([k, v]) => label[k] && v !== null && v !== '' && v !== undefined).map(([k, v]) => `<div class="copilot-kv"><span>${label[k]}</span><strong>${k === 'amount' ? fmt(v) : v}</strong></div>`).join('');
}
async function copilotConfirm(id, btn) {
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await apiFetch('/copilot/confirm', { method: 'POST', body: { proposal_id: id } });
    toast(r.answer, 'ok');
    // Refresh whatever screen is showing so the new record appears, keeping
    // the confirmation visible through that one refresh.
    window.__copilotKeep = true;
    if (typeof currentPage !== 'undefined' && currentPage) navigate(currentPage);
    renderCopilotResult({ answer: '✅ ' + r.answer, actions: r.actions || [], confidence: 'high' });
  } catch (e) { btn.disabled = false; btn.textContent = 'Try again'; toast(e.message); }
}
function copilotDismiss() { document.getElementById('copilot-out').classList.add('hidden'); }
// A candidate button ("which Priya?") re-asks with the chosen resident fixed.
async function copilotRetool(a) {
  const out = document.getElementById('copilot-out');
  out.innerHTML = `<div class="copilot-answer"><div class="sm-skel"><div class="sm-skel-line" style="width:60%"></div></div></div>`;
  try {
    const q = document.getElementById('copilot-q').value;
    const r = await apiFetch('/copilot/ask', { method: 'POST', body: { text: q, tool: a.tool, args: a.args, context: { page: smContext.page, resident_id: a.args && a.args.resident_id, resident_name: a.label } } });
    renderCopilotResult(r);
  } catch (e) { out.innerHTML = `<div class="copilot-answer copilot-err">${e.message}</div>`; }
}

// Admin → Copilot log: every ask, confirm and refusal, newest first.
async function renderAdminCopilotTab() {
  const __seq = adminRenderSeq;
  const host = document.getElementById('admin-tab-content');
  try {
    const rows = await apiFetch('/copilot/audit?limit=150');
    if (!rows.length) { host.innerHTML = emptyState('✦', 'No Copilot activity yet', 'Every question and confirmed action will be listed here.'); return; }
    host.innerHTML = `<div class="card"><div class="card-header"><h3>✦ Copilot log</h3><span class="text-muted" style="font-size:12px">${rows.length} most recent</span></div>
      <div class="table-wrap"><table><thead><tr><th>WHEN</th><th>WHO</th><th>ASKED</th><th>SIRI DID</th><th>OUTCOME</th></tr></thead><tbody>
      ${rows.map(r => {
        const i = r.interpretation || {};
        const did = r.request_text === 'confirm' ? `Confirmed ${i.tool || r.proposal_tool || ''}` : (i.tool ? `${i.tool}${i.via ? ' · ' + i.via : ''}` : (i.clarify ? 'Asked: ' + i.clarify : '—'));
        const outcome = r.error ? `<span class="badge badge-red">${r.error}</span>` : r.confirmed_at ? `<span class="badge badge-green">done</span>` : r.proposal_id && !r.proposal_confirmed_at ? `<span class="badge badge-amber">prepared, not confirmed</span>` : `<span class="badge badge-gray">answered</span>`;
        return `<tr><td>${new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${r.username || '—'}</td><td>${r.request_text === 'confirm' ? `<em>${r.preview_text || 'confirm'}</em>` : r.request_text}</td><td>${did}</td><td>${outcome}${r.result_text && r.request_text !== 'confirm' ? `<div class="text-muted" style="font-size:11px;margin-top:2px">${r.result_text.slice(0, 80)}</div>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  } catch (e) { host.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 7 — one product: icons, grouped navigation, AI-first Home,
   universal search, quick action.
   ═══════════════════════════════════════════════════════════════ */

// Inline the sprite once so <use href="#i-…"> resolves without a network hop
// on every icon (and works from file:// during local testing).
async function loadIconSprite() {
  const host = document.getElementById('icon-sprite');
  if (!host || host.dataset.loaded) return;
  try {
    const res = await fetch('/icons.svg');
    host.innerHTML = await res.text();
    host.dataset.loaded = '1';
  } catch { /* icons degrade to empty boxes; the labels still read */ }
}
const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ── Navigation groups ────────────────────────────────────────────────────
// The screens did not move; they are grouped. Every old page key still
// navigates, so bookmarks, the tab bar and navigate() calls keep working.
const NAV_GROUPS = {
  finance: { label: 'Finance', tabs: [
    { page: 'finance-overview', label: 'Overview', admin: true },
    { page: 'collect', label: 'Collect' }, { page: 'rent-due', label: 'Rent Due' }, { page: 'payments', label: 'Payments' },
    { page: 'reminders', label: 'Reminders' }, { page: 'purchases', label: 'Expenses' }, { page: 'collections', label: 'Collections' },
    { page: 'reports', label: 'Reports' }, { page: 'balance-sheet', label: 'Owner & Assets', admin: true } ] },
  operations: { label: 'Operations', tabs: [
    { page: 'daily-checklist', label: 'Checklist' }, { page: 'complaints', label: 'Requests' },
    { page: 'daily-menu', label: 'Menu' }, { page: 'guest-messages', label: 'Announcements' },
    { page: 'visitors', label: 'Visitors' }, { page: 'feedback', label: 'Feedback' }, { page: 'maintenance', label: 'Recurring' } ] }
};
const PAGE_GROUP = {};
for (const [g, def] of Object.entries(NAV_GROUPS)) for (const t of def.tabs) PAGE_GROUP[t.page] = g;

function highlightNav(page) {
  const group = PAGE_GROUP[page] || page;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === group || b.dataset.page === page));
}
function renderSubtabs(group, active) {
  const def = NAV_GROUPS[group];
  if (!def) return '';
  return `<div class="subtabs">${def.tabs.filter(t => !t.admin || isAdmin())
    .map(t => `<button class="subtab ${t.page === active ? 'active' : ''}" onclick="navigate('${t.page}')">${t.label}</button>`).join('')}</div>`;
}
// Landing on a group opens its first tab; the strip then rides above it.
async function pgFinance() { navigate(isAdmin() ? 'finance-overview' : 'collect'); }
async function pgOperations() { navigate('daily-checklist'); }
// Injected by navigate() after any grouped screen renders.
function injectSubtabs(page) {
  const group = PAGE_GROUP[page];
  const host = document.getElementById('page-content');
  if (!group || !host || host.querySelector('.subtabs')) return;
  host.insertAdjacentHTML('afterbegin', renderSubtabs(group, page));
}

// ── Universal search (topbar icon · Ctrl+K) ──────────────────────────────
let searchTimer = null, searchSel = -1, searchRows = [];
function openSearch() {
  if (document.getElementById('search-overlay')) return;
  const el = document.createElement('div');
  el.id = 'search-overlay';
  el.className = 'search-overlay';
  el.onclick = e => { if (e.target === el) closeSearch(); };
  el.innerHTML = `<div class="search-sheet">
      <div class="search-head">${icon('search', 'ic ic-lg')}
        <input id="search-q" type="text" placeholder="Search residents, rooms, receipts, requests…" autocomplete="off"/>
        <button class="btn btn-outline btn-sm" onclick="closeSearch()">Esc</button></div>
      <div class="search-results" id="search-results"><div class="search-group">Type at least 2 letters</div></div>
    </div>`;
  document.body.appendChild(el);
  // Sprint 13: the sheet opens on the commands, so Ctrl+K is useful before a
  // single letter is typed. Typing then filters commands and results together.
  searchRows = []; searchSel = -1;
  const host0 = document.getElementById('search-results');
  if (host0) host0.innerHTML = renderPaletteCommands('') || '<div class="search-group">Type at least 2 letters</div>';
  const input = document.getElementById('search-q');
  input.focus();
  input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); };
  input.onkeydown = e => {
    if (e.key === 'Escape') return closeSearch();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveSearchSel(e.key === 'ArrowDown' ? 1 : -1); }
    if (e.key === 'Enter' && searchSel >= 0 && searchRows[searchSel]) { e.preventDefault(); searchRows[searchSel].go(); }
  };
}
function closeSearch() { const el = document.getElementById('search-overlay'); if (el) el.remove(); searchSel = -1; searchRows = []; }
function moveSearchSel(d) {
  const items = [...document.querySelectorAll('.search-item')];
  if (!items.length) return;
  searchSel = (searchSel + d + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle('sel', i === searchSel));
  items[searchSel].scrollIntoView({ block: 'nearest' });
}
async function runSearch() {
  const q = document.getElementById('search-q')?.value.trim();
  const host = document.getElementById('search-results');
  if (!host) return;
  searchRows = []; searchSel = -1;
  if (!q || q.length < 2) { host.innerHTML = renderPaletteCommands('') || '<div class="search-group">Type at least 2 letters</div>'; return; }
  try {
    const r = await apiFetch(`/search?q=${encodeURIComponent(q)}`);
    searchRows = []; searchSel = -1;
    const cmdHtml = renderPaletteCommands(q);
    const renderedCommands = !!cmdHtml;
    const parts = [cmdHtml];
    const add = (label, rows, render, go) => {
      if (!rows.length) return;
      parts.push(`<div class="search-group">${label}</div>`);
      rows.forEach(row => { const i = searchRows.length; searchRows.push({ go: () => go(row) }); parts.push(`<button class="search-item" data-i="${i}" onclick="searchRows[${i}].go()">${render(row)}</button>`); });
    };
    add('Residents', r.residents, g => `${icon('users')}<span><span>${g.name}${g.is_active ? '' : ' <span class="s-sub">(past)</span>'}</span><div class="s-sub">${g.room_number ? 'Room ' + g.room_number : 'No room'}${g.phone ? ' · ' + g.phone : ''}</div></span>${g.amount_due > 0 ? `<span class="s-right text-red">${fmt(g.amount_due)}</span>` : ''}`,
      g => { closeSearch(); navigate('guests'); setTimeout(() => viewGuest(g.id), 350); });
    add('Rooms', r.rooms, x => `${icon('bed')}<span><span>Room ${x.room_number}</span><div class="s-sub">Floor ${x.floor} · ${x.occupied}/${x.total_beds} beds</div></span>${x.vacant ? `<span class="s-right text-green">${x.vacant} free</span>` : ''}`,
      () => { closeSearch(); navigate('rooms'); });
    add('Payments', r.payments, p => `${icon('receipt')}<span><span>${p.guest_name} — ${fmt(p.amount)}</span><div class="s-sub">${p.receipt_number || ''} · ${fmtDate(p.collection_date)}${p.status !== 'confirmed' ? ' · ' + p.status : ''}</div></span>`,
      () => { closeSearch(); navigate('payments'); });
    add('Requests', r.requests, c => `${icon('wrench')}<span><span>${c.category}${c.room_number ? ' · Room ' + c.room_number : ''}</span><div class="s-sub">${c.description.slice(0, 60)} · ${c.status}</div></span>`,
      () => { closeSearch(); navigate('complaints'); });
    // "Nothing matches" is about the SEARCH, so the Ask Siri row must not
    // stand in for a result — say it plainly, then still offer to ask Siri.
    const foundAny = parts.filter(Boolean).length > (renderedCommands ? 1 : 0);
    if (!foundAny) parts.push(`<div class="search-group">Nothing matches “${q}”</div>`);
    parts.push(renderPaletteAsk(q));
    host.innerHTML = parts.filter(Boolean).join('');
  } catch (e) { searchRows = []; host.innerHTML = (renderPaletteCommands(q) || '') + renderPaletteAsk(q) + `<div class="search-group">${e.message}</div>`; }
}

// ── Quick action ─────────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  { icon: 'rupee', label: 'Collect rent', run: () => navigate('collect') },
  { icon: 'users', label: 'Add resident', run: () => { navigate('guests'); setTimeout(() => moveInWizard(), 350); } },
  { icon: 'cart', label: 'Add expense', run: () => { navigate('purchases'); setTimeout(() => purchaseModal(), 350); } },
  { icon: 'wrench', label: 'Report an issue', run: () => { navigate('complaints'); setTimeout(() => complaintModal(), 350); } },
  { icon: 'megaphone', label: 'Post an announcement', admin: true, run: () => { navigate('guest-messages'); setTimeout(() => announcementModal(), 350); } }
];
function openQuickActions() {
  if (document.getElementById('qa-sheet')) return closeQuickActions();
  const back = document.createElement('div'); back.id = 'qa-backdrop'; back.className = 'qa-backdrop'; back.onclick = closeQuickActions;
  const sheet = document.createElement('div'); sheet.id = 'qa-sheet'; sheet.className = 'qa-sheet';
  // Sprint 14: one box before the forms. "onion 100", "Jhanavi 5000 upi",
  // "tap leaking room 106" — no verb needed. It hands the text to Siri, who
  // previews before anything is saved.
  sheet.innerHTML = `<form class="qe-form" onsubmit="return quickEntrySubmit(event)">
      <label for="qe-input" class="qe-label">Just say what happened</label>
      <div class="qe-row">
        <input type="text" id="qe-input" class="qe-input" autocomplete="off" inputmode="text"
          placeholder="onion 100 · Jhanavi 5000 upi · tap leaking room 106" aria-label="Quick entry">
        <button type="button" class="qe-mic" id="qe-mic" aria-label="Voice input" onclick="quickEntryVoice()">${icon('mic')}</button>
        <button type="submit" class="btn btn-primary qe-go" aria-label="Enter">${icon('sparkle')}</button>
      </div>
      <div class="qe-hint" id="qe-voice-status">Siri shows a preview — nothing is saved until you confirm.</div>
    </form>
    <div class="qe-or">or open a form</div>` +
    QUICK_ACTIONS.filter(a => !a.admin || isAdmin())
    .map((a, i) => `<button class="qa-item" onclick="runQuickAction(${i})">${icon(a.icon, 'ic ic-lg')} ${a.label}</button>`).join('');
  document.body.appendChild(back); document.body.appendChild(sheet);
  setTimeout(() => { const i = document.getElementById('qe-input'); if (i) i.focus(); }, 30);
}
function quickEntrySubmit(e) {
  if (e) e.preventDefault();
  const text = (document.getElementById('qe-input') || {}).value || '';
  if (!text.trim()) return false;
  closeQuickActions();
  const bar = document.getElementById('copilot-q');
  if (bar) { bar.value = text; bar.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  copilotAsk(text);
  return false;
}
function quickEntryVoice() {
  // Same recogniser as the Copilot bar (on-device on Android, Gemini fallback
  // on iOS); the words land in the box so she sees them before they go anywhere.
  smVoice('qe-mic', 'qe-voice-status', t => { const i = document.getElementById('qe-input'); if (i) { i.value = t; i.focus(); } }, 'say what happened');
}
function closeQuickActions() { ['qa-sheet', 'qa-backdrop'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); }); }
function runQuickAction(i) { const list = QUICK_ACTIONS.filter(a => !a.admin || isAdmin()); closeQuickActions(); list[i].run(); }

// ── Home (AI-first hierarchy, one API call) ──────────────────────────────
let homeCache = null;
async function pgHome(force) {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = '';
  const h = await apiFetch('/home');
  homeCache = h;
  const t = h.today;
  const rec = h.recommendations || [];
  const level = (arr, dot) => arr.map(l => `<div class="today-row"><span>${dot}</span><span class="t-main">${l}</span></div>`).join('');
  const hasAttention = h.attention.high.length || h.attention.medium.length || h.attention.low.length;
  const row = (ic, main, sub, action) => `<div class="today-row">${icon(ic)}<span class="t-main">${main}${sub ? `<div class="t-sub">${sub}</div>` : ''}</span>${action || ''}</div>`;

  setContent(`
    <div class="home-greeting">${h.brief.greeting}, ${h.user.username}</div>
    <div class="home-date">${h.brief.dateLabel}${h.brief.health ? ` · <span class="health-pill ${h.brief.health.overall >= 80 ? 'good' : h.brief.health.overall >= 60 ? 'ok' : 'low'}" onclick='showHealthDetail(homeCache.brief.health)'>Health ${h.brief.health.overall}</span>` : ''}</div>

    <div class="card mb-6" id="brief-card">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3>${icon('sparkle')} Siri's Brief</h3>
        <button class="btn btn-outline btn-sm" onclick="loadHome(true)" title="Recompute">${icon('refresh')}</button>
      </div>
      <div style="padding:14px 16px">
        <div class="brief-h">What changed</div>
        ${h.brief.changed.map(l => `<div class="brief-line">• ${l}</div>`).join('')}
        <div class="flex gap-2" style="flex-wrap:wrap;margin-top:12px">
          <button class="btn btn-outline btn-sm" onclick="shareBrief()">${icon('whatsapp')} WhatsApp</button>
          <button class="btn btn-outline btn-sm" onclick="copyBrief()">${icon('copy')} Copy</button>
          <button class="btn btn-outline btn-sm" onclick="showEvening()">${icon('moon')} Evening summary</button>
        </div>
      </div>
    </div>

    <div class="card mb-6 hidden" id="mytasks-card"></div>
    ${hasAttention ? `<div class="home-section-h">Needs attention</div>
    <div class="card"><div style="padding:4px 16px">
      ${level(h.attention.high, '🔴')}${level(h.attention.medium, '🟠')}${level(h.attention.low, '🟢')}
    </div></div>` : ''}

    ${rec.length ? `<div class="home-section-h">Siri recommends</div>
    <div class="card"><div style="padding:4px 16px">
      ${rec.map((r, i) => `<div class="today-row"><span class="t-main"><strong>${i + 1}.</strong> ${r.text}</span>
        <button class="btn btn-primary btn-sm" onclick='${r.action.navigate ? `navigate("${r.action.navigate}")` : `copilotAsk(${JSON.stringify(r.action.ask)})`}'>${r.action.label}</button></div>`).join('')}
    </div></div>` : ''}

    <div class="home-section-h">Today</div>
    <div class="card"><div style="padding:4px 16px">
      ${t.arrivals.length ? row('users', `${t.arrivals.length} check-in${t.arrivals.length === 1 ? '' : 's'} today`, t.arrivals.map(a => a.name + (a.room_number ? ' → Room ' + a.room_number : '')).join(', ')) : ''}
      ${t.departures.length ? row('logout', `${t.departures.length} checkout${t.departures.length === 1 ? '' : 's'} today`, t.departures.map(d => d.name + (d.room_number ? ' (Room ' + d.room_number + ')' : '')).join(', ')) : ''}
      ${row('rupee', `${fmt(t.collectedToday.t)} collected today`, `${t.collectedToday.n} payment${t.collectedToday.n === 1 ? '' : 's'}`, `<button class="btn btn-primary btn-sm" onclick="navigate('collect')">Collect</button>`)}
      ${t.rentDue.count ? row('calendar', `${fmt(t.rentDue.total)} rent outstanding`, `${t.rentDue.count} resident${t.rentDue.count === 1 ? '' : 's'}`, `<button class="btn btn-outline btn-sm" onclick="navigate('rent-due')">Open</button>`) : row('calendar', 'No rent outstanding', 'All settled')}
      ${row('check-square', `Checklist ${t.checklist.done}/${t.checklist.total}`, t.checklist.done >= t.checklist.total && t.checklist.total ? 'Complete for today' : 'Tap to continue', `<button class="btn btn-outline btn-sm" onclick="navigate('daily-checklist')">Open</button>`)}
      ${row('wrench', `${t.openRequests} open request${t.openRequests === 1 ? '' : 's'}`, t.highRequests.length ? `${t.highRequests.length} high priority` : 'None urgent', `<button class="btn btn-outline btn-sm" onclick="navigate('complaints')">Open</button>`)}
      ${Object.keys(t.menu).length ? row('utensils', "Today's menu", ['Breakfast', 'Lunch', 'Dinner'].filter(m => t.menu[m]).map(m => `${m}: ${t.menu[m]}`).join(' · ')) : ''}
    </div></div>

    ${h.finance ? `<div class="home-section-h">This month</div>
    <div class="money-grid">
      <div class="money-card"><div class="m-label">Collected</div><div class="m-value text-green">${fmt(h.finance.monthIncome)}</div></div>
      <div class="money-card"><div class="m-label">Spent</div><div class="m-value text-red">${fmt(h.finance.monthExpenses)}</div></div>
      <div class="money-card"><div class="m-label">Net</div><div class="m-value">${fmt(h.finance.monthNet)}</div></div>
      <div class="money-card"><div class="m-label">Outstanding</div><div class="m-value text-amber">${fmt(h.finance.outstanding)}</div></div>
    </div>` : ''}

    <div class="home-section-h">Occupancy</div>
    <div class="card"><div style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;font-size:14px"><strong>${h.occupancy.residents} of ${h.occupancy.beds} beds</strong><span>${h.occupancy.percent}%</span></div>
      <div class="occ-bar"><span style="width:${h.occupancy.percent}%"></span></div>
      <div class="t-sub">${h.occupancy.vacant} bed${h.occupancy.vacant === 1 ? '' : 's'} vacant</div>
    </div></div>

    ${h.upcoming.length ? `<div class="home-section-h">Upcoming</div>
    <div class="card"><div style="padding:4px 16px">
      ${h.upcoming.map(u => row('calendar', `${u.name} checks out`, `${u.room_number ? 'Room ' + u.room_number + ' · ' : ''}${fmtDate(u.leave_date)}`)).join('')}
    </div></div>` : ''}

    ${h.flags && h.flags.length ? `<div class="home-section-h">Flagged for the owner</div>
    <div class="card"><div style="padding:4px 16px">
      ${h.flags.map(f => row('flag', f.title, f.detail, f.action ? `<button class="btn btn-outline btn-sm" onclick="navigate('${f.action}')">Open</button>` : '')).join('')}
      ${h.flagCount > h.flags.length ? `<div class="t-sub" style="padding:8px 0">…and ${h.flagCount - h.flags.length} more in the owner report</div>` : ''}
    </div></div>` : ''}
  `);
  briefCache = { text: h.brief.text, computed_at: h.brief.computed_at, cached: h.brief.cached };
  loadMyTasks();
}
async function loadHome(force) { if (force) { await apiFetch('/copilot/brief?force=1'); } navigate('dashboard'); }


/* ═══════════════════════════════════════════════════════════════
   SPRINT 8 — Resident 360, move-in & checkout copilots, digital ID
   ═══════════════════════════════════════════════════════════════ */

// ── Resident 360 ────────────────────────────────────────────────
const R360_TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'money', label: 'Money' },
  { id: 'stay', label: 'Stay' }, { id: 'requests', label: 'Requests' }, { id: 'docs', label: 'Documents' }
];
let r360 = { id: null, tab: 'overview', data: null };

async function residentProfile(id, tab) {
  r360 = { id, tab: tab || 'overview', data: null };
  smSetContext({ resident_id: id });
  openModal(`<div class="modal modal-lg"><div class="modal-header"><h3>Resident</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="sm-skel"><div class="sm-skel-line" style="width:50%"></div><div class="sm-skel-card"></div></div></div></div>`);
  try {
    const [g, timeline, ledger] = await Promise.all([
      API.getGuest(id),
      apiFetch(`/guests/${id}/timeline`),
      API.getGuestLedger(id).catch(() => null)
    ]);
    r360.data = { g, timeline, ledger };
    smSetContext({ resident_id: id, resident_name: g.name, room_number: g.room_number || null });
    renderResident360();
  } catch (e) {
    openModal(`<div class="modal"><div class="modal-header"><h3>Resident</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body"><div class="alert alert-danger" style="display:block">${e.message}</div></div></div>`);
  }
}

function renderResident360() {
  const { g, timeline, ledger } = r360.data;
  const due = ledger && ledger.currentBalance < 0 ? -ledger.currentBalance : 0;
  const credit = ledger && ledger.currentBalance > 0 ? ledger.currentBalance : 0;
  const months = g.monthly_rent > 0 ? Math.round(due / g.monthly_rent * 10) / 10 : 0;
  const kv = rows => rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<div class="r360-kv"><span>${k}</span><strong>${v || '—'}</strong></div>`).join('');
  const body = {
    overview: () => `
      <div class="r360-status">${due > 0 ? `<span class="badge badge-red">Owes ${fmt(due)}${months ? ` · ${months} mo` : ''}</span>` : credit > 0 ? `<span class="badge badge-green">In credit ${fmt(credit)}</span>` : `<span class="badge badge-green">Settled</span>`}
        ${g.is_active ? '<span class="badge badge-gray">Active</span>' : '<span class="badge badge-gray">Checked out</span>'}
        ${g.expected_checkout ? `<span class="badge badge-amber">Leaving ${fmtDate(g.expected_checkout)}</span>` : ''}</div>
      ${kv([['Resident no.', g.resident_no], ['Room / bed', g.room_number ? `Room ${g.room_number}${g.bed_number ? ' / ' + g.bed_number : ''}` : '—'],
            ['Phone', g.phone], ['Emergency', [g.emergency_contact_name, g.emergency_contact].filter(Boolean).join(' · ')],
            ['Moved in', fmtDate(g.join_date)], ['Rent', fmt(g.monthly_rent) + '/mo'], ['Deposit', fmt(g.deposit_amount)], ['Address', g.address]])}
      <div class="flex gap-2" style="flex-wrap:wrap;margin-top:14px">
        <button class="btn btn-primary btn-sm" onclick="closeModal();collectFrom(${g.id})">${icon('rupee')} Collect</button>
        ${g.phone ? `<a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="${buildWhatsappUrl(g.phone, 'Hello ' + g.name + ',') || '#'}">${icon('whatsapp')} WhatsApp</a>` : ''}
        <button class="btn btn-outline btn-sm" onclick="guestModal(${g.id})">Edit</button>
        ${g.is_active && isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="checkoutWizard(${g.id})">Checkout</button>` : ''}
      </div>`,
    money: () => {
      const pays = timeline.items.filter(i => i.kind === 'payment');
      return `${kv([['Outstanding', due ? fmt(due) : '—'], ['In credit', credit ? fmt(credit) : '—'], ['Monthly rent', fmt(g.monthly_rent)], ['Deposit held', fmt(g.deposit_amount)]])}
        <div class="r360-h">Payments</div>
        ${pays.length ? pays.map(p => `<div class="r360-row"><span><strong>${p.title}</strong><div class="t-sub">${fmtDate(p.at)}${p.detail ? ' · ' + p.detail : ''}</div></span>
          ${p.status === 'confirmed' ? `<button class="btn btn-outline btn-sm" onclick="downloadReceipt(${p.id})">${icon('receipt')}</button>` : `<span class="badge badge-amber">${p.status}</span>`}</div>`).join('')
          : emptyState('rupee', 'No payments yet', 'Collections will appear here.', `<button class="btn btn-primary btn-sm" onclick="closeModal();collectFrom(${g.id})">Collect rent</button>`)}`;
    },
    stay: () => `${kv([['Moved in', fmtDate(g.join_date)], ['Expected checkout', g.expected_checkout ? fmtDate(g.expected_checkout) : 'Not set'], ['Checked out', g.leave_date ? fmtDate(g.leave_date) : '—']])}
      <div class="r360-h">Timeline</div>
      <ul class="r360-timeline">${timeline.items.map(i => `<li class="tl-${i.kind}"><div class="tl-date">${fmtDate(i.at)}</div><div><strong>${i.title}</strong>${i.detail ? `<div class="t-sub">${i.detail}</div>` : ''}</div></li>`).join('')}</ul>`,
    requests: () => {
      const reqs = timeline.items.filter(i => i.kind === 'request');
      return reqs.length ? reqs.map(r => `<div class="r360-row"><span><strong>${r.title}</strong><div class="t-sub">${fmtDate(r.at)} · ${r.detail}</div></span></div>`).join('')
        : emptyState('wrench', 'No requests', 'Anything she reports will be listed here.', '');
    },
    docs: () => `${kv([['ID proof', g.id_proof_type], ['ID number', g.id_proof_number ? g.id_proof_number.replace(/.(?=.{4})/g, '•') : null], ['Address on file', g.address]])}
      <div class="r360-h">Paperwork</div><div id="r360-docs"><div class="sm-skel"><div class="sm-skel-line"></div></div></div>
      <p class="text-muted" style="font-size:12px;margin-top:10px">ID photos are never stored — only the fields read from them.</p>
      ${!g.id_proof_type ? `<button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="guestModal(${g.id})">Add ID proof</button>` : ''}`
  };
  openModal(`<div class="modal modal-lg">
    <div class="modal-header"><h3>${g.name}${g.room_number ? ` · Room ${g.room_number}` : ''}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="subtabs">${R360_TABS.map(t => `<button class="subtab ${t.id === r360.tab ? 'active' : ''}" onclick="r360.tab='${t.id}';renderResident360()">${t.label}</button>`).join('')}</div>
      <div id="r360-body">${body[r360.tab]()}</div>
    </div></div>`);
  if (r360.tab === 'docs') loadResidentDocs(g.id);
}

// ── Move-in wizard ──────────────────────────────────────────────
// Seven short steps; nothing is written until the last one, so an abandoned
// wizard leaves no half-resident behind.
let moveIn = null;
async function moveInWizard(prefill) {
  const rooms = await API.getRooms();
  moveIn = { step: 1, rooms, data: Object.assign({ join_date: nowDate() }, prefill || {}) };
  renderMoveIn();
}
function renderMoveIn() {
  const d = moveIn.data, free = moveIn.rooms.filter(r => (r.total_beds - (r.occupied_beds || 0)) > 0);
  const steps = [
    { t: 'Who is moving in?', html: `
      <div class="form-group"><label>Full name *</label><input id="mi-name" value="${d.name || ''}" placeholder="As on her ID"/></div>
      <div class="form-group"><label>Phone *</label><input id="mi-phone" inputmode="numeric" value="${d.phone || ''}" placeholder="10-digit mobile"/></div>` },
    { t: 'Emergency contact', html: `
      <div class="form-group"><label>Name</label><input id="mi-ec-name" value="${d.emergency_contact_name || ''}" placeholder="Parent or guardian"/></div>
      <div class="form-group"><label>Phone</label><input id="mi-ec" inputmode="numeric" value="${d.emergency_contact || ''}"/></div>` },
    { t: 'Room and bed', html: `
      <div class="form-group"><label>Room *</label><select id="mi-room">${['<option value="">— choose —</option>'].concat(free.map(r => `<option value="${r.id}" ${String(d.room_id) === String(r.id) ? 'selected' : ''}>Room ${r.room_number} · ${r.total_beds - (r.occupied_beds || 0)} free · ${fmt(r.monthly_rent)}</option>`)).join('')}</select></div>
      <div class="form-group"><label>Bed</label><input id="mi-bed" value="${d.bed_number || ''}" placeholder="e.g. 2"/></div>
      <div id="mi-ready" class="text-muted" style="font-size:12px"></div>` },
    { t: 'Rent and deposit', html: `
      <div class="form-group"><label>Monthly rent *</label><input id="mi-rent" type="number" inputmode="numeric" value="${d.monthly_rent != null ? d.monthly_rent : ''}"/></div>
      <div class="form-group"><label>Deposit *</label><input id="mi-dep" type="number" inputmode="numeric" value="${d.deposit_amount != null ? d.deposit_amount : ''}"/></div>
      <div class="form-row"><div class="form-group"><label>Move-in date *</label><input id="mi-join" type="date" value="${d.join_date || nowDate()}"/></div>
      <div class="form-group"><label>Expected checkout</label><input id="mi-exp" type="date" value="${d.expected_checkout || ''}"/></div></div>` },
    { t: 'ID proof', html: `
      <div class="voice-row"><button type="button" id="mi-scan" class="mic-btn" style="background:var(--amber)" onclick="moveInScanId()">${icon('camera')}</button>
        <span id="mi-scan-status" class="voice-status">Photograph her Aadhaar / ID to fill these in. The photo is never stored.</span></div>
      <div class="form-row"><div class="form-group"><label>Type</label><select id="mi-idtype">${['', 'Aadhaar', 'PAN Card', 'Passport', 'Driving License', 'Voter ID'].map(t => `<option ${d.id_proof_type === t ? 'selected' : ''}>${t || '— select —'}</option>`).join('')}</select></div>
      <div class="form-group"><label>Number</label><input id="mi-idnum" value="${d.id_proof_number || ''}"/></div></div>
      <div class="form-group"><label>Address</label><textarea id="mi-address" rows="2">${d.address || ''}</textarea></div>` },
    { t: 'First payment (optional)', html: `
      <p class="text-muted" style="font-size:13px;margin-bottom:10px">Record what she is paying today. Leave blank to skip.</p>
      <div class="form-row"><div class="form-group"><label>Deposit received</label><input id="mi-pay-dep" type="number" inputmode="numeric" value="${d.pay_deposit || ''}"/></div>
      <div class="form-group"><label>Rent received</label><input id="mi-pay-rent" type="number" inputmode="numeric" value="${d.pay_rent || ''}"/></div></div>
      <div class="form-group"><label>Mode</label><select id="mi-pay-mode">${['Cash', 'UPI', 'Bank Transfer'].map(m => `<option ${d.pay_mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>` },
    { t: 'Check and confirm', html: `
      <div class="copilot-preview"><div class="copilot-preview-h">Nothing is saved until you tap Confirm</div>
        ${[['Name', d.name], ['Phone', d.phone], ['Room', (moveIn.rooms.find(r => String(r.id) === String(d.room_id)) || {}).room_number ? 'Room ' + moveIn.rooms.find(r => String(r.id) === String(d.room_id)).room_number + (d.bed_number ? ' / bed ' + d.bed_number : '') : '—'],
          ['Move-in', fmtDate(d.join_date)], ['Expected checkout', d.expected_checkout ? fmtDate(d.expected_checkout) : '—'],
          ['Rent', d.monthly_rent != null ? fmt(d.monthly_rent) + '/mo' : '—'], ['Deposit', d.deposit_amount != null ? fmt(d.deposit_amount) : '—'],
          ['ID', d.id_proof_type || '—'], ['Paying today', (d.pay_deposit || d.pay_rent) ? `${fmt((+d.pay_deposit || 0) + (+d.pay_rent || 0))} by ${d.pay_mode || 'Cash'}` : '—']]
          .map(([k, v]) => `<div class="copilot-kv"><span>${k}</span><strong>${v || '—'}</strong></div>`).join('')}</div>
      <div id="mi-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>` }
  ];
  const i = moveIn.step - 1, st = steps[i];
  openModal(`<div class="modal modal-lg">
    <div class="modal-header"><h3>Move in · step ${moveIn.step} of ${steps.length}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="wiz-bar"><span style="width:${moveIn.step * 100 / steps.length}%"></span></div>
      <h4 style="margin:12px 0 10px">${st.t}</h4>
      ${st.html}
      <div class="flex gap-2" style="margin-top:16px">
        ${moveIn.step > 1 ? `<button class="btn btn-outline" onclick="moveInStep(-1)">Back</button>` : ''}
        ${moveIn.step < steps.length ? `<button class="btn btn-primary" style="flex:1" onclick="moveInStep(1)">Next</button>`
          : `<button class="btn btn-success" style="flex:1" onclick="moveInSave()">✓ Confirm move-in</button>`}
      </div>
    </div></div>`);
  if (moveIn.step === 3) moveInReadiness();
}
function moveInCollect() {
  const v = id => { const e = document.getElementById(id); return e ? e.value.trim() : undefined; };
  const d = moveIn.data;
  if (moveIn.step === 1) { d.name = v('mi-name'); d.phone = v('mi-phone'); }
  if (moveIn.step === 2) { d.emergency_contact_name = v('mi-ec-name'); d.emergency_contact = v('mi-ec'); }
  if (moveIn.step === 3) { d.room_id = v('mi-room'); d.bed_number = v('mi-bed'); }
  if (moveIn.step === 4) { d.monthly_rent = v('mi-rent'); d.deposit_amount = v('mi-dep'); d.join_date = v('mi-join'); d.expected_checkout = v('mi-exp'); }
  if (moveIn.step === 5) { d.id_proof_type = v('mi-idtype'); d.id_proof_number = v('mi-idnum'); d.address = v('mi-address'); }
  if (moveIn.step === 6) { d.pay_deposit = v('mi-pay-dep'); d.pay_rent = v('mi-pay-rent'); d.pay_mode = v('mi-pay-mode'); }
}
function moveInStep(delta) {
  moveInCollect();
  const d = moveIn.data;
  if (delta > 0) {
    if (moveIn.step === 1 && (!d.name || !d.phone || d.phone.replace(/\D/g, '').length !== 10)) return toast('Her name and a 10-digit phone number are needed');
    if (moveIn.step === 3 && !d.room_id) return toast('Choose a room');
    if (moveIn.step === 4 && (!d.monthly_rent || !d.deposit_amount || !d.join_date)) return toast('Rent, deposit and the move-in date are needed');
  }
  moveIn.step = Math.max(1, moveIn.step + delta);
  renderMoveIn();
}
async function moveInReadiness() {
  const sel = document.getElementById('mi-room');
  const host = document.getElementById('mi-ready');
  if (!sel || !host) return;
  const show = async () => {
    const r = moveIn.rooms.find(x => String(x.id) === sel.value);
    if (!r) { host.textContent = ''; return; }
    try { const res = await apiFetch('/copilot/ask', { method: 'POST', body: { text: `is room ${r.room_number} ready?` } }); host.textContent = res.answer; }
    catch { host.textContent = ''; }
  };
  sel.onchange = show; show();
}
async function moveInScanId() {
  const status = document.getElementById('mi-scan-status');
  try {
    const r = await smScan('id', status);
    if (!r) return;
    const f = r.fields;
    if (f.name && !document.getElementById('mi-name')) moveIn.data.name = moveIn.data.name || f.name;
    smFill('mi-idnum', f.id_proof_number); smFill('mi-address', f.address);
    const t = ID_TYPE_MAP[f.id_proof_type]; if (t) smFill('mi-idtype', t);
    if (status) status.textContent = `Read from the ID (${f.confidence} confidence) — please check.`;
  } catch (e) { if (status) { status.textContent = e.message; status.classList.add('voice-error'); } }
}
async function moveInSave() {
  moveInCollect();
  const d = moveIn.data;
  const al = document.getElementById('mi-alert');
  try {
    const g = await API.createGuest({
      name: d.name, phone: d.phone, emergency_contact: d.emergency_contact || null, emergency_contact_name: d.emergency_contact_name || null,
      room_id: d.room_id, bed_number: d.bed_number || null, join_date: d.join_date, expected_checkout: d.expected_checkout || null,
      monthly_rent: d.monthly_rent, deposit_amount: d.deposit_amount, address: d.address || null,
      id_proof_type: d.id_proof_type || null, id_proof_number: d.id_proof_number || null, notes: null
    });
    const pays = [];
    if (+d.pay_deposit > 0) pays.push({ collection_type: 'deposit', amount: +d.pay_deposit });
    if (+d.pay_rent > 0) pays.push({ collection_type: 'rent', amount: +d.pay_rent });
    for (const p of pays) {
      await API.createCollection({ guest_id: g.id, guest_name: g.name, amount: p.amount, collection_date: d.join_date,
        collection_type: p.collection_type, payment_mode: d.pay_mode || 'Cash', collection_month: new Date(d.join_date).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }), description: 'At move-in' });
    }
    closeModal();
    const room = moveIn.rooms.find(r => String(r.id) === String(d.room_id));
    toast(`${g.name} is in${room ? ` Room ${room.room_number}` : ''}${d.bed_number ? ` bed ${d.bed_number}` : ''} — ready`, 'ok');
    moveIn = null;
    navigate('guests');
  } catch (e) { if (al) showAlert(al, e.message); else toast(e.message); }
}

// ── Checkout wizard ─────────────────────────────────────────────
// Wraps the existing admin checkout endpoint; the refund maths is the
// server's, shown here before it is committed.
let checkoutW = null;
async function checkoutWizard(id, prefill) {
  const [g, ledger] = await Promise.all([API.getGuest(id), API.getGuestLedger(id).catch(() => null)]);
  const due = ledger && ledger.currentBalance < 0 ? -ledger.currentBalance : 0;
  checkoutW = { step: 1, g, due, data: { leave_date: (prefill && prefill.leave_date) || nowDate(), deductions: '', deduction_notes: '', refund_mode: 'cash' } };
  renderCheckout();
}
function renderCheckout() {
  const { g, due, data } = checkoutW;
  const deposit = parseFloat(g.deposit_amount) || 0;
  const ded = Math.max(0, parseFloat(data.deductions) || 0);
  const refund = deposit - ded;
  const steps = [
    { t: 'Leaving date and dues', html: `
      <div class="form-group"><label>Checkout date</label><input id="co-date" type="date" max="${nowDate()}" value="${data.leave_date}"/></div>
      <div class="copilot-preview">${[['Outstanding rent', due ? fmt(due) : 'None'], ['Deposit held', fmt(deposit)]].map(([k, v]) => `<div class="copilot-kv"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>
      ${due > 0 ? `<div class="alert alert-warning" style="display:block;margin-top:10px">She still owes ${fmt(due)}. Collect it first, or deduct it from the deposit on the next step.</div>` : ''}` },
    { t: 'Room inspection and deductions', html: `
      <div class="form-group"><label>Deductions from deposit</label><input id="co-ded" type="number" inputmode="numeric" value="${data.deductions}" placeholder="0"/></div>
      <div class="form-group"><label>What for?</label><textarea id="co-notes" rows="2" placeholder="Damage, unpaid rent, cleaning…">${data.deduction_notes}</textarea></div>
      ${due > 0 ? `<button class="btn btn-outline btn-sm" onclick="document.getElementById('co-ded').value=${Math.min(due, deposit)};document.getElementById('co-notes').value='Unpaid rent at checkout'">Deduct the ${fmt(Math.min(due, deposit))} she owes</button>` : ''}` },
    { t: 'Refund', html: `
      <div class="copilot-preview">${[['Deposit held', fmt(deposit)], ['Deductions', ded ? '− ' + fmt(ded) : '—'], ['Refund due', fmt(refund)]].map(([k, v]) => `<div class="copilot-kv"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>
      ${refund < 0 ? `<div class="alert alert-danger" style="display:block;margin-top:10px">Deductions exceed the deposit — she owes ${fmt(-refund)}. Reduce the deduction or collect the difference separately.</div>` : ''}
      <div class="form-group" style="margin-top:10px"><label>Refund paid by</label><select id="co-mode">${['cash', 'upi', 'bank'].map(m => `<option value="${m}" ${data.refund_mode === m ? 'selected' : ''}>${m.toUpperCase()}</option>`).join('')}</select></div>
      <div id="co-alert" class="alert alert-danger hidden"></div>` }
  ];
  const st = steps[checkoutW.step - 1];
  openModal(`<div class="modal modal-lg">
    <div class="modal-header"><h3>Checkout · ${g.name}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="wiz-bar"><span style="width:${checkoutW.step * 100 / steps.length}%"></span></div>
      <h4 style="margin:12px 0 10px">${st.t}</h4>${st.html}
      <div class="flex gap-2" style="margin-top:16px">
        ${checkoutW.step > 1 ? `<button class="btn btn-outline" onclick="checkoutStep(-1)">Back</button>` : ''}
        ${checkoutW.step < steps.length ? `<button class="btn btn-primary" style="flex:1" onclick="checkoutStep(1)">Next</button>`
          : `<button class="btn btn-danger" style="flex:1" ${refund < 0 ? 'disabled' : ''} onclick="checkoutSave()">✓ Check out and refund ${fmt(refund)}</button>`}
      </div>
    </div></div>`);
}
function checkoutStep(delta) {
  const d = checkoutW.data;
  const v = id => { const e = document.getElementById(id); return e ? e.value : undefined; };
  if (checkoutW.step === 1) d.leave_date = v('co-date') || d.leave_date;
  if (checkoutW.step === 2) { d.deductions = v('co-ded') || ''; d.deduction_notes = v('co-notes') || ''; }
  if (checkoutW.step === 3) d.refund_mode = v('co-mode') || d.refund_mode;
  checkoutW.step = Math.max(1, checkoutW.step + delta);
  renderCheckout();
}
async function checkoutSave() {
  const d = checkoutW.data;
  const al = document.getElementById('co-alert');
  d.refund_mode = document.getElementById('co-mode')?.value || d.refund_mode;
  try {
    const r = await apiFetch(`/guests/${checkoutW.g.id}/checkout`, { method: 'POST', body: {
      deductions: d.deductions || 0, deduction_notes: d.deduction_notes || null, refund_mode: d.refund_mode, leave_date: d.leave_date } });
    closeModal();
    toast(`${checkoutW.g.name} checked out · refund ${fmt(r.refund_amount)}`, 'ok');
    checkoutW = null;
    navigate('guests');
  } catch (e) { if (al) showAlert(al, e.message); else toast(e.message); }
}

// The Copilot opens these wizards when it has prepared the fields.
function openWizardFromCopilot(w) {
  if (!w) return;
  if (w.kind === 'move-in') moveInWizard(w.fields);
  if (w.kind === 'checkout') checkoutWizard(w.fields.guest_id, w.fields);
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 9 — room & bed map, request workflow, staff tasks
   ═══════════════════════════════════════════════════════════════ */

// ── Room & bed map ──────────────────────────────────────────────
let roomMapCache = null;
async function pgRoomMap() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = isAdmin()
    ? `<button class="btn btn-primary btn-sm" onclick="roomModal()">${icon('plus')} Add room</button>` : '';
  const m = await apiFetch('/room-map');
  roomMapCache = m;
  setContent(`
    <div class="page-header"><h1>Rooms</h1><p>${m.totals.residents} resident${m.totals.residents === 1 ? '' : 's'} · ${m.totals.beds} beds · ${m.totals.free} free</p></div>
    ${(m.totals.overCapacity || m.totals.noRoom || m.totals.bedFixes) ? `<div class="alert alert-warning" style="display:block;margin-bottom:14px">
      ${m.totals.overCapacity ? `<div>${m.totals.overCapacity} resident${m.totals.overCapacity === 1 ? ' is' : 's are'} beyond the beds their room has.</div>` : ''}
      ${m.totals.noRoom ? `<div>${m.totals.noRoom} resident${m.totals.noRoom === 1 ? ' has' : 's have'} no room assigned.</div>` : ''}
      ${m.totals.bedFixes ? `<div>${m.totals.bedFixes} bed number${m.totals.bedFixes === 1 ? ' needs' : 's need'} correcting across ${m.floors.flatMap(f => f.rooms).filter(r => r.bed_fix_count).length} room${m.floors.flatMap(f => f.rooms).filter(r => r.bed_fix_count).length === 1 ? '' : 's'} (marked ⚑) — they have a bed, but the number recorded is wrong or duplicated.</div>` : ''}
      ${(m.totals.noRoom || m.totals.bedFixes) ? `<button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="pgGuests('all')">Show residents</button>` : ''}
    </div>` : ''}
    <div class="flex gap-2 mb-5" style="flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="pgRoomMap()">Map</button>
      <button class="btn btn-outline btn-sm" onclick="pgRooms()">Table</button>
      <span class="bed-key"><i class="bed occupied"></i> occupied <i class="bed free"></i> free <i class="bed maintenance"></i> maintenance</span>
    </div>
    ${m.floors.map(f => `
      <div class="home-section-h">Floor ${f.floor}</div>
      <div class="room-grid">
        ${f.rooms.map(r => `
          <button class="room-tile ${r.status !== 'active' ? 'is-' + r.status : ''}" onclick="roomProfile(${r.id})" aria-label="Room ${r.room_number}">
            <div class="rt-head"><strong>${r.room_number}</strong>${r.high_issues ? `<span class="badge badge-red">${r.high_issues}!</span>` : r.open_issues ? `<span class="badge badge-amber">${r.open_issues}</span>` : ''}</div>
            <div class="rt-beds">${r.beds.map(b => `<i class="bed ${b.state}" title="${b.resident ? b.resident.name : b.state}"></i>`).join('')}${r.over_capacity ? `<i class="bed over" title="${r.over.map(o => o.name).join(', ')}"></i>`.repeat(r.over_capacity) : ''}</div>
            <div class="rt-sub">${r.occupied}/${r.total_beds}${r.over_capacity ? ' <span class="text-red">+' + r.over_capacity + '</span>' : ''}${r.bed_fix_count ? ` <span class="text-amber" title="${r.bed_fix_count} bed number${r.bed_fix_count === 1 ? '' : 's'} to correct: ${(r.bed_fixes || []).map(f => f.name).join(', ')}">⚑${r.bed_fix_count > 1 ? r.bed_fix_count : ''}</span>` : ''} · ${fmt(r.monthly_rent)}</div>
          </button>`).join('')}
      </div>`).join('')}
  `);
}

function roomSheet(id) {
  const r = roomMapCache.floors.flatMap(f => f.rooms).find(x => String(x.id) === String(id));
  if (!r) return;
  const staffCanEdit = isAdmin();
  openModal(`<div class="modal">
    <div class="modal-header"><h3>Room ${r.room_number}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="r360-kv"><span>Floor</span><strong>${r.floor}</strong></div>
      <div class="r360-kv"><span>Beds</span><strong>${r.occupied} of ${r.total_beds} taken</strong></div>
      <div class="r360-kv"><span>Rent</span><strong>${fmt(r.monthly_rent)}</strong></div>
      <div class="r360-kv"><span>Condition</span><strong>${r.status}</strong></div>
      <div class="r360-kv"><span>Last inspected</span><strong>${r.last_inspected ? fmtDate(r.last_inspected) : 'Never'}</strong></div>
      <div class="r360-h">Beds</div>
      ${(r.bed_fixes || []).map(o => `<div class="r360-row"><span class="text-amber">Bed number needs fixing${o.bed_number ? ` · recorded as “${o.bed_number}”` : ' · none recorded'}</span>
        <button class="btn btn-outline btn-sm" onclick="closeModal();guestModal(${o.id})">${o.name}</button></div>`).join('')}
      ${(r.over || []).map(o => `<div class="r360-row"><span class="text-red">Over capacity${o.bed_number ? ' · bed ' + o.bed_number : ' · no bed'}</span>
        <button class="btn btn-outline btn-sm" onclick="closeModal();residentProfile(${o.id})">${o.name}</button></div>`).join('')}
      ${r.beds.map(b => `<div class="r360-row"><span>Bed ${b.bed}</span>${b.resident
        ? `<button class="btn btn-outline btn-sm" onclick="closeModal();residentProfile(${b.resident.id})">${b.resident.name}</button>`
        : `<span class="badge badge-green">free</span>`}</div>`).join('')}
      ${r.open_issues ? `<div class="r360-h">Requests</div><button class="btn btn-outline btn-sm" onclick="closeModal();navigate('complaints')">${r.open_issues} open — open the register</button>` : ''}
      <div class="flex gap-2" style="flex-wrap:wrap;margin-top:14px">
        ${r.free > 0 ? `<button class="btn btn-primary btn-sm" onclick="closeModal();moveInWizard({ room_id: ${r.id} })">Move someone in</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="markInspected(${r.id})">Mark inspected today</button>
        ${staffCanEdit ? `<button class="btn btn-outline btn-sm" onclick="setRoomStatus(${r.id}, '${r.status === 'maintenance' ? 'active' : 'maintenance'}')">${r.status === 'maintenance' ? 'Back in service' : 'Under maintenance'}</button>` : ''}
      </div>
      <div id="rs-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>
    </div></div>`);
}
async function setRoomStatus(id, status) {
  try { await apiFetch(`/rooms/${id}/status`, { method: 'PUT', body: { status } }); closeModal(); toast(`Room marked ${status}`, 'ok'); pgRoomMap(); }
  catch (e) { const a = document.getElementById('rs-alert'); if (a) showAlert(a, e.message); else toast(e.message); }
}
async function markInspected(id) {
  try { await apiFetch(`/rooms/${id}/status`, { method: 'PUT', body: { last_inspected: nowDate() } }); closeModal(); toast('Inspection recorded', 'ok'); pgRoomMap(); }
  catch (e) { toast(e.message); }
}

// ── Request detail: owner, clock, comments, photos ──────────────
let staffUsersCache = null;
async function requestSheet(id) {
  openModal(`<div class="modal modal-lg"><div class="modal-header"><h3>Request</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="sm-skel"><div class="sm-skel-line"></div><div class="sm-skel-card"></div></div></div></div>`);
  try {
    const [d, staff] = await Promise.all([
      apiFetch(`/requests/${id}`),
      staffUsersCache ? Promise.resolve(staffUsersCache) : (isAdmin() ? API.getUsers().then(u => (staffUsersCache = u)).catch(() => []) : Promise.resolve([]))
    ]);
    renderRequestSheet(d, staff || []);
  } catch (e) { toast(e.message); closeModal(); }
}
function slaLabel(r) {
  if (['resolved', 'closed'].includes(r.status)) return `<span class="badge badge-green">${r.status}</span>`;
  if (!r.sla_due_at) return '';
  const hrs = (new Date(r.sla_due_at) - Date.now()) / 3600000;
  if (hrs < 0) return `<span class="badge badge-red">${Math.round(-hrs)}h overdue</span>`;
  if (hrs < 4) return `<span class="badge badge-amber">${Math.round(hrs)}h left</span>`;
  return `<span class="badge badge-gray">${Math.round(hrs)}h left</span>`;
}
function renderRequestSheet(d, staff) {
  const r = d.request;
  openModal(`<div class="modal modal-lg">
    <div class="modal-header"><h3>${r.category}${r.room_number ? ` · Room ${r.room_number}` : ''}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="r360-status">${slaLabel(r)}<span class="badge badge-${r.priority === 'high' ? 'red' : r.priority === 'low' ? 'gray' : 'amber'}">${r.priority}</span>
        ${r.assigned_username ? `<span class="badge badge-blue">${r.assigned_username}</span>` : '<span class="badge badge-gray">unassigned</span>'}</div>
      <p style="font-size:15px;margin-bottom:6px">${r.description}</p>
      ${r.likely_issue ? `<p class="text-muted" style="font-size:13px">Likely: ${r.likely_issue}</p>` : ''}
      <div class="form-row" style="margin-top:12px">
        <div class="form-group"><label>Status</label><select id="rq-status">${['open', 'assigned', 'in_progress', 'resolved', 'closed'].map(x => `<option value="${x}" ${r.status === x ? 'selected' : ''}>${x.replace('_', ' ')}</option>`).join('')}</select></div>
        <div class="form-group"><label>Priority</label><select id="rq-priority">${['low', 'medium', 'high'].map(x => `<option value="${x}" ${r.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
      ${staff.length ? `<div class="form-group"><label>Assigned to</label><select id="rq-assign"><option value="">— nobody —</option>${staff.map(u => `<option value="${u.id}" ${String(r.assigned_to) === String(u.id) ? 'selected' : ''}>${u.username}</option>`).join('')}</select></div>` : ''}
      <div class="form-group"><label>Resolution note</label><textarea id="rq-note" rows="2" placeholder="What was done">${r.resolution_notes || ''}</textarea></div>
      <button class="btn btn-primary" style="width:100%" onclick="saveRequest(${r.id})">Save</button>

      <div class="r360-h">Photos</div>
      <div class="rq-photos">
        ${d.photos.map(p => `<img data-req="${r.id}" data-photo="${p.id}" alt="Request photo" onclick="window.open(this.src,'_blank')"/>`).join('')}
        <button class="rq-photo-add" onclick="requestAddPhoto(${r.id})">${icon('camera', 'ic ic-lg')}<span>Add</span></button>
      </div>
      <div id="rq-photo-status" class="text-muted" style="font-size:12px"></div>

      <div class="r360-h">Comments</div>
      ${d.comments.length ? d.comments.map(c => `<div class="rq-comment"><div class="t-sub">${c.username || c.guest_name || 'Someone'} · ${fmtDate(c.created_at)}</div>${c.body}</div>`).join('') : '<p class="text-muted" style="font-size:13px">No comments yet.</p>'}
      <div class="flex gap-2" style="margin-top:8px">
        <input id="rq-comment" placeholder="Add a note…" style="flex:1;margin:0" onkeydown="if(event.key==='Enter')addRequestComment(${r.id})"/>
        <button class="btn btn-outline btn-sm" onclick="addRequestComment(${r.id})">Post</button>
      </div>
      <div id="rq-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>
    </div></div>`);
  loadRequestPhotos();
}
// A browser does not attach the Authorization header to <img src>, so every
// photo is fetched with the token and shown from an object URL. The endpoint
// stays behind auth — no public photo links.
async function loadRequestPhotos() {
  const imgs = [...document.querySelectorAll('img[data-photo]')];
  for (const img of imgs) {
    if (img.dataset.loaded) continue;
    try {
      const res = await fetch(`/api/requests/${img.dataset.req}/photos/${img.dataset.photo}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('photo failed');
      const url = URL.createObjectURL(await res.blob());
      img.src = url; img.dataset.loaded = '1';
      img.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(url), 60000), { once: true });
    } catch { img.replaceWith(Object.assign(document.createElement('div'), { className: 'rq-photo-fail', textContent: 'Photo unavailable' })); }
  }
}

async function saveRequest(id) {
  const body = {
    status: document.getElementById('rq-status').value,
    priority: document.getElementById('rq-priority').value,
    note: document.getElementById('rq-note').value.trim() || undefined
  };
  const a = document.getElementById('rq-assign');
  if (a) body.assigned_to = a.value ? Number(a.value) : undefined;
  try { await apiFetch(`/requests/${id}`, { method: 'PUT', body }); closeModal(); toast('Request updated', 'ok'); navigate('complaints'); }
  catch (e) { const al = document.getElementById('rq-alert'); if (al) showAlert(al, e.message); else toast(e.message); }
}
async function addRequestComment(id) {
  const input = document.getElementById('rq-comment');
  const body = input.value.trim();
  if (!body) return;
  try { await apiFetch(`/requests/${id}/comments`, { method: 'POST', body: { body } }); requestSheet(id); }
  catch (e) { toast(e.message); }
}
async function requestAddPhoto(id) {
  const status = document.getElementById('rq-photo-status');
  const file = await smPickPhoto();
  if (!file) return;
  if (status) status.textContent = 'Compressing…';
  try {
    // 1000px / 0.7 quality keeps a readable photo of a leak or a meter under
    // 150 kB, which matters on the warden's data plan.
    const image = await smDownscale(file, 1000, 0.7);
    await apiFetch(`/requests/${id}/photos`, { method: 'POST', body: { image } });
    requestSheet(id);
  } catch (e) { if (status) status.textContent = e.message; }
}

// ── Staff "My day" ──────────────────────────────────────────────
async function loadMyTasks() {
  const host = document.getElementById('mytasks-card');
  if (!host) return;
  try {
    const t = await apiFetch('/my-tasks');
    const pending = t.checklist.items.filter(i => !i.is_checked);
    if (!pending.length && !t.requests.length) { host.classList.add('hidden'); return; }
    host.innerHTML = `
      <div class="card-header"><h3>${icon('check-square')} My day</h3>
        <span class="text-muted" style="font-size:12px">${t.checklist.done}/${t.checklist.total} done${t.overdue ? ` · ${t.overdue} overdue` : ''}</span></div>
      <div style="padding:4px 16px">
        ${t.requests.map(r => `<div class="today-row">${icon('wrench')}<span class="t-main"><strong>${r.category}</strong>${r.room_number ? ' · Room ' + r.room_number : ''}
          <div class="t-sub">${r.description.slice(0, 60)}</div></span>${r.overdue ? `<span class="badge badge-red">${Math.round(-r.hours_left)}h over</span>` : `<span class="badge badge-gray">${Math.round(r.hours_left)}h</span>`}
          <button class="btn btn-outline btn-sm" onclick="requestSheet(${r.id})">Open</button></div>`).join('')}
        ${pending.slice(0, 6).map(i => `<div class="today-row">${icon('calendar')}<span class="t-main">${i.task}<div class="t-sub">${i.due_time || i.time_label || ''}${i.assigned_to ? ' · yours' : ''}</div></span></div>`).join('')}
        ${pending.length > 6 ? `<div class="t-sub" style="padding:8px 0">…and ${pending.length - 6} more</div>` : ''}
      </div>`;
    host.classList.remove('hidden');
  } catch { host.classList.add('hidden'); }
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 10 — finance intelligence: KPIs, forecast, expense insight,
   daily cash-up. Every figure is arithmetic; the screen says how.
   ═══════════════════════════════════════════════════════════════ */
let financeCache = null;
async function pgFinanceOverview() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = '';
  const d = await apiFetch('/finance/overview');
  financeCache = d;
  const k = d.kpis, f = d.forecast.collections, o = d.forecast.occupancy, e = d.expenses, t = d.today;
  const kpi = (label, value, sub) => `<div class="money-card"><div class="m-label">${label}</div><div class="m-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ''}</div>`;
  setContent(`
    <div class="page-header"><h1>Finance</h1><p>${new Date(k.month + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</p></div>

    <div class="home-section-h">This month</div>
    <div class="money-grid">
      ${kpi('Collected', fmt(k.income))}
      ${kpi('Spent', fmt(k.expenses), k.expense_ratio_pct != null ? `${k.expense_ratio_pct}% of income` : '')}
      ${kpi('Net', fmt(k.net_operating_income))}
      ${kpi('Rent collected', `${k.collection_rate_pct == null ? '—' : k.collection_rate_pct + '%'}`, `${fmt(k.rent_collected)} of ${fmt(k.rent_roll)}`)}
      ${kpi('Per occupied bed', fmt(k.revenue_per_occupied_bed))}
      ${kpi('Occupancy', k.occupancy_pct + '%')}
    </div>

    <div class="home-section-h">Expected by month end</div>
    <div class="card"><div style="padding:14px 16px">
      <div class="fin-bar"><span class="collected" style="width:${Math.min(100, Math.round(f.collected * 100 / (f.target || 1)))}%"></span><span class="expected" style="width:${Math.min(100, Math.round((f.expected - f.collected) * 100 / (f.target || 1)))}%"></span></div>
      <div class="flex" style="justify-content:space-between;font-size:13px;margin-top:8px">
        <span>Collected <strong>${fmt(f.collected)}</strong></span>
        <span>Expected <strong>${fmt(f.expected)}</strong></span>
        <span>Target <strong>${fmt(f.target)}</strong></span>
      </div>
      ${f.shortfall ? `<p style="font-size:14px;margin-top:10px">Likely shortfall <strong class="text-amber">${fmt(f.shortfall)}</strong>. ${f.at_risk.length} resident${f.at_risk.length === 1 ? '' : 's'} usually pay late.</p>` : '<p style="font-size:14px;margin-top:10px">On track for the full month.</p>'}
      <p class="t-sub">${f.basis}</p>
      ${f.at_risk.length ? `<div style="margin-top:10px">${f.at_risk.slice(0, 5).map(g => `<div class="today-row"><span class="t-main"><strong>${g.name}</strong>${g.room_number ? ' · Room ' + g.room_number : ''}<div class="t-sub">${g.why}</div></span>
        <button class="btn btn-outline btn-sm" onclick="collectFrom(${g.id})">Collect</button></div>`).join('')}
        <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="navigate('reminders')">Draft reminders</button></div>` : ''}
    </div></div>

    <div class="home-section-h">Occupancy outlook</div>
    <div class="card"><div style="padding:14px 16px">
      <div class="r360-kv"><span>Now</span><strong>${o.occupied} of ${o.beds} beds</strong></div>
      <div class="r360-kv"><span>Next 7 days</span><strong>${o.next7.low}–${o.next7.high}</strong></div>
      <div class="r360-kv"><span>Next 30 days</span><strong>${o.next30.low}–${o.next30.high}</strong></div>
      ${o.avg_stay_days ? `<div class="r360-kv"><span>Average stay so far</span><strong>${Math.round(o.avg_stay_days / 30)} months</strong></div>` : ''}
      <p class="t-sub" style="margin-top:8px">${o.basis}</p>
    </div></div>

    ${(e.duplicates.length || e.spikes.length || e.changes.length) ? `<div class="home-section-h">Worth a look</div>
    <div class="card"><div style="padding:4px 16px">
      ${e.duplicates.map(x => `<div class="today-row">${icon('copy')}<span class="t-main"><strong>Possible duplicate</strong><div class="t-sub">${x.note} · ${fmtDate(x.purchase_date)}</div></span><button class="btn btn-outline btn-sm" onclick="navigate('purchases')">Check</button></div>`).join('')}
      ${e.spikes.map(x => `<div class="today-row">${icon('chart')}<span class="t-main"><strong>Unusual ${x.category}</strong><div class="t-sub">${x.note}${x.paid_to ? ' · ' + x.paid_to : ''}</div></span><button class="btn btn-outline btn-sm" onclick="navigate('purchases')">Check</button></div>`).join('')}
      ${e.changes.slice(0, 4).map(x => `<div class="today-row">${icon(x.change_pct > 0 ? 'chart' : 'chart')}<span class="t-main"><strong>${x.category} ${x.change_pct > 0 ? 'up' : 'down'} ${Math.abs(x.change_pct)}%</strong><div class="t-sub">${fmt(x.this_month)} this month vs a usual ${fmt(x.avg_month)}</div></span></div>`).join('')}
    </div></div>` : ''}

    ${e.recurring.length ? `<div class="home-section-h">Regular bills</div>
    <div class="card"><div style="padding:4px 16px">${e.recurring.slice(0, 6).map(x => `<div class="today-row">${icon('calendar')}<span class="t-main">${x.note}</span><span class="t-sub">${x.months} months</span></div>`).join('')}</div></div>` : ''}

    <div class="home-section-h">Today's cash-up</div>
    <div class="card" id="closing-card"><div style="padding:14px 16px">${renderClosing(t)}</div></div>
  `);
}

function renderClosing(t) {
  const row = (mode, label) => `
    <div class="close-row">
      <span class="c-label">${label}</span>
      <span class="c-exp">Recorded ${fmt(t.expected[mode])}</span>
      ${t.closed
        ? `<span class="c-cnt">Counted ${fmt(t.closing.counted[mode])}</span>
           <span class="c-diff ${t.closing.difference[mode] === 0 ? '' : t.closing.difference[mode] < 0 ? 'text-red' : 'text-amber'}">${t.closing.difference[mode] === 0 ? '✓' : (t.closing.difference[mode] > 0 ? '+' : '') + fmt(t.closing.difference[mode])}</span>`
        : `<input type="number" inputmode="numeric" id="close-${mode}" value="${t.expected[mode] || ''}" placeholder="0"/>`}
    </div>`;
  if (t.closed) {
    const diffs = ['cash', 'upi', 'bank'].filter(m => t.closing.difference[m] !== 0);
    return `
      <div class="r360-status"><span class="badge badge-green">Closed</span><span class="t-sub">by ${t.closing.closed_by_username || 'someone'} · ${new Date(t.closing.closed_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span></div>
      ${row('cash', 'Cash')}${row('upi', 'UPI')}${row('bank', 'Bank')}
      ${diffs.length ? `<p style="font-size:13px;margin-top:8px" class="text-amber">${diffs.map(m => `${m.toUpperCase()} ${t.closing.difference[m] > 0 ? 'over' : 'short'} by ${fmt(Math.abs(t.closing.difference[m]))}`).join(' · ')} — recorded as a variance, nothing was changed.</p>` : '<p style="font-size:13px;margin-top:8px" class="text-green">Everything matched.</p>'}
      ${t.closing.note ? `<p class="t-sub">"${t.closing.note}"</p>` : ''}
      ${isAdmin() ? `<button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="reopenDay('${t.date}')">Reopen the day</button>` : ''}`;
  }
  return `
    <p class="t-sub" style="margin-bottom:10px">Count what you actually hold and enter it. Nothing recorded today is changed — a difference is kept as a variance.</p>
    ${row('cash', 'Cash')}${row('upi', 'UPI')}${row('bank', 'Bank')}
    ${t.pending_not_counted.n ? `<p style="font-size:13px" class="text-amber">${t.pending_not_counted.n} payment${t.pending_not_counted.n === 1 ? '' : 's'} (${fmt(t.pending_not_counted.total)}) still waiting for confirmation — not included above.</p>` : ''}
    <div class="form-group" style="margin-top:8px"><label>Note (optional)</label><input id="close-note" placeholder="e.g. 200 short, checking with the cook"/></div>
    <button class="btn btn-primary" style="width:100%" onclick="closeDay('${t.date}')">Close the day</button>
    <div id="close-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>`;
}
async function closeDay(date) {
  const v = id => Number(document.getElementById(id)?.value || 0);
  try {
    const r = await apiFetch('/day-closing', { method: 'POST', body: { date, counted: { cash: v('close-cash'), upi: v('close-upi'), bank: v('close-bank') }, note: document.getElementById('close-note')?.value.trim() || undefined } });
    toast(r.variances.length ? `Day closed with ${r.variances.length} variance` : 'Day closed — everything matched', 'ok');
    pgFinanceOverview();
  } catch (e) { const a = document.getElementById('close-alert'); if (a) showAlert(a, e.message); else toast(e.message); }
}
async function reopenDay(date) {
  if (!confirm('Reopen this day? New entries will be allowed against it again.')) return;
  try { await apiFetch('/day-closing/reopen', { method: 'POST', body: { date } }); toast('Day reopened', 'ok'); pgFinanceOverview(); }
  catch (e) { toast(e.message); }
}

// Reliability shown beside each resident on Rent Due.
let reliabilityCache = null;
async function loadReliability() {
  try { reliabilityCache = await apiFetch('/finance/reliability'); } catch { reliabilityCache = []; }
  const map = new Map(reliabilityCache.map(r => [r.id, r]));
  document.querySelectorAll('[data-rel-for]').forEach(el => {
    const r = map.get(Number(el.dataset.relFor));
    if (!r) return;
    const label = { high: 'usually on time', medium: 'sometimes late', at_risk: 'often late', new: 'new resident' }[r.level];
    const cls = { high: 'badge-green', medium: 'badge-amber', at_risk: 'badge-red', new: 'badge-gray' }[r.level];
    el.innerHTML = `<span class="badge ${cls}" title="${r.why}">${label}</span>`;
  });
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 11 — what residents tell us: visitors, food, experience.
   Everything here is aggregated to a room, a floor or a dish. No
   resident is ever scored.
   ═══════════════════════════════════════════════════════════════ */
async function pgVisitors() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = '';
  const list = await apiFetch('/visitors');
  const label = { expected: 'Expected', in: 'Inside now', out: 'Left', denied: 'Not allowed' };
  const badge = { expected: 'badge-blue', in: 'badge-green', out: 'badge-gray', denied: 'badge-red' };
  const today = list.filter(v => v.status === 'expected' || v.status === 'in');
  setContent(`
    <div class="page-header"><h1>Visitors</h1><p>Registered by residents · ${today.length} expected or inside</p></div>
    ${list.length ? `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>VISITOR</th><th>FOR</th><th>EXPECTED</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
      <tbody>${list.map(v => `<tr>
        <td><strong>${v.visitor_name}</strong>${v.relation ? `<div class="t-sub">${v.relation}</div>` : ''}</td>
        <td>${v.resident_name}${v.room_number ? `<div class="t-sub">Room ${v.room_number}</div>` : ''}</td>
        <td>${v.expected_at ? fmtDate(v.expected_at) : '—'}${v.checked_in_at ? `<div class="t-sub">in ${new Date(v.checked_in_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}</td>
        <td><span class="badge ${badge[v.status]}">${label[v.status] || v.status}</span></td>
        <td><div class="flex gap-2">
          ${v.status === 'expected' ? `<button class="btn btn-primary btn-sm" onclick="visitorAction(${v.id},'check_in')">Check in</button>
            <button class="btn btn-outline btn-sm" onclick="visitorAction(${v.id},'deny')">Deny</button>` : ''}
          ${v.status === 'in' ? `<button class="btn btn-outline btn-sm" onclick="visitorAction(${v.id},'check_out')">Check out</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div></div>`
      : emptyState('users', 'No visitors registered', 'Residents register their visitors from the portal; they appear here for you to check in.', '')}
  `);
}
async function visitorAction(id, action) {
  try { await apiFetch(`/visitors/${id}`, { method: 'PUT', body: { action } }); toast('Updated', 'ok'); pgVisitors(); }
  catch (e) { toast(e.message); }
}

async function pgFeedback() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = '';
  const [food, exp, sat] = await Promise.all([
    apiFetch('/food-insight'),
    isAdmin() ? apiFetch('/experience-insight').catch(() => null) : Promise.resolve(null),
    isAdmin() ? apiFetch('/satisfaction').catch(() => null) : Promise.resolve(null)
  ]);
  const stars = n => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
  setContent(`
    <div class="page-header"><h1>Feedback</h1><p>What residents are telling us — grouped, never per person</p></div>

    <div class="home-section-h">Food</div>
    <div class="card"><div style="padding:14px 16px">
      <p style="font-size:14px">${food.headline}</p>
      ${food.favourites.length ? `<div class="r360-h">Best liked</div>${food.favourites.map(d => `<div class="r360-row"><span>${d.dish}<div class="t-sub">${d.meal_type} · ${d.votes} votes</div></span><strong>${stars(d.avg_stars)} ${d.avg_stars}</strong></div>`).join('')}` : ''}
      ${food.needs_work.length ? `<div class="r360-h">Least liked</div>${food.needs_work.map(d => `<div class="r360-row"><span>${d.dish}<div class="t-sub">${d.meal_type} · ${d.votes} votes</div></span><strong class="text-amber">${stars(d.avg_stars)} ${d.avg_stars}</strong></div>`).join('')}` : ''}
      ${food.comments.length ? `<div class="r360-h">In their words</div>${food.comments.map(c => `<div class="rq-comment">“${c.comment}” <span class="t-sub">· ${c.meal_type}, ${fmtDate(c.rating_date)}</span></div>`).join('')}` : ''}
    </div></div>

    ${sat && sat.months.length ? `<div class="home-section-h">Monthly satisfaction</div>
    <div class="card"><div style="padding:14px 16px">
      ${sat.months.slice(0, 3).map(m => `<div class="r360-row"><span>${new Date(m.month + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
        <div class="t-sub">${m.responses} answer${m.responses === 1 ? '' : 's'} · cleanliness ${m.cleanliness ?? '—'} · food ${m.food ?? '—'} · safety ${m.safety ?? '—'} · staff ${m.staff ?? '—'} · wifi ${m.wifi ?? '—'}</div></span>
        <strong>${m.overall ?? '—'}/5</strong></div>`).join('')}
      <p class="t-sub" style="margin-top:8px">${sat.note}</p>
    </div></div>` : ''}

    ${exp && exp.rooms.length ? `<div class="home-section-h">Rooms worth looking at</div>
    <div class="card"><div style="padding:4px 16px">
      ${exp.rooms.map(r => `<div class="today-row">${icon('wrench')}<span class="t-main">${r.note}</span>
        <button class="btn btn-outline btn-sm" onclick="navigate('rooms')">Open</button></div>`).join('')}
      <p class="t-sub" style="padding:8px 0">${exp.note}</p>
    </div></div>` : ''}
  `);
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 12 — one bell, one outbox, documents, recurring tasks,
   and a page that says whether Siri is earning her keep.
   ═══════════════════════════════════════════════════════════════ */

// ── Notification bell ───────────────────────────────────────────
function initBell() {
  const right = document.getElementById('topbar-right');
  if (!right || document.getElementById('bell-btn')) return;
  const b = document.createElement('button');
  b.id = 'bell-btn';
  b.className = 'bell-btn';
  b.setAttribute('aria-label', 'Notifications');
  b.innerHTML = `${icon('flag', 'ic ic-lg')}<span id="bell-count" class="bell-count hidden"></span>`;
  b.onclick = openNotifications;
  right.insertBefore(b, right.firstChild);
  refreshBell();
  // Every ten minutes is enough; the server sweeps hourly.
  setInterval(refreshBell, 10 * 60 * 1000);
}
async function refreshBell() {
  try {
    const d = await apiFetch('/notifications?unread=1');
    const el = document.getElementById('bell-count');
    if (!el) return;
    el.textContent = d.unread > 9 ? '9+' : String(d.unread);
    el.classList.toggle('hidden', !d.unread);
  } catch { /* the bell is never the reason a screen fails */ }
}
async function openNotifications() {
  openModal(`<div class="modal modal-lg"><div class="modal-header"><h3>Notifications</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="sm-skel"><div class="sm-skel-line"></div><div class="sm-skel-line"></div></div></div></div>`);
  try {
    const d = await apiFetch('/notifications');
    const badge = { critical: 'badge-red', important: 'badge-amber', informational: 'badge-blue', digest: 'badge-gray' };
    openModal(`<div class="modal modal-lg">
      <div class="modal-header"><h3>Notifications${d.unread ? ` · ${d.unread} new` : ''}</h3><button class="modal-close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        ${d.items.length ? `<div class="flex gap-2" style="margin-bottom:10px"><button class="btn btn-outline btn-sm" onclick="markAllRead()">Mark all read</button>
          <button class="btn btn-outline btn-sm" onclick="sweepNotifications()">Check now</button></div>` : ''}
        ${d.items.length ? d.items.map(n => `
          <div class="notif ${n.read_at ? 'is-read' : ''}">
            <div class="flex" style="justify-content:space-between;gap:8px;align-items:flex-start">
              <span><span class="badge ${badge[n.level]}">${n.level}</span> <strong>${n.title}</strong>
                ${n.detail ? `<div class="t-sub">${n.detail}</div>` : ''}
                <div class="t-sub">${fmtDate(n.created_at)}</div></span>
              <span class="flex gap-2">
                ${n.action_page ? `<button class="btn btn-outline btn-sm" onclick="closeModal();navigate('${n.action_page}')">Open</button>` : ''}
                ${!n.read_at ? `<button class="btn btn-outline btn-sm" onclick="readNotification(${n.id})">✓</button>` : ''}
              </span>
            </div>
          </div>`).join('') : emptyState('flag', 'Nothing needs your attention', 'Alerts about money, requests and documents appear here.', '')}
      </div></div>`);
  } catch (e) { toast(e.message); closeModal(); }
}
async function readNotification(id) { try { await apiFetch(`/notifications/${id}/read`, { method: 'POST' }); refreshBell(); openNotifications(); } catch (e) { toast(e.message); } }
async function markAllRead() { try { await apiFetch('/notifications/read-all', { method: 'POST' }); refreshBell(); openNotifications(); } catch (e) { toast(e.message); } }
async function sweepNotifications() { try { const r = await apiFetch('/notifications/sweep', { method: 'POST' }); toast(r.created ? `${r.created} new` : 'Nothing new', 'ok'); refreshBell(); openNotifications(); } catch (e) { toast(e.message); } }

// ── Outbox ──────────────────────────────────────────────────────
async function pgOutbox() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-outline btn-sm" onclick="draftOutbox()">Draft due messages</button>`;
  const [drafts, sent] = await Promise.all([apiFetch('/outbox?status=draft'), apiFetch('/outbox?status=sent')]);
  const kindLabel = { rent_due: 'Rent due', rent_overdue: 'Rent overdue', payment_confirmed: 'Payment received', request_updated: 'Request update', welcome: 'Welcome', checkout_reminder: 'Checkout' };
  setContent(`
    <div class="page-header"><h1>Outbox</h1><p>Messages Siri has drafted. Nothing is sent until you tap Send.</p></div>
    ${drafts.length ? `<div class="card"><div style="padding:4px 16px">
      ${drafts.map(m => `<div class="outbox-row">
        <div class="outbox-pick">${bulkCb(m.id, m.guest_name + ' — ' + (kindLabel[m.kind] || m.kind))}</div>
        <div><strong>${m.guest_name}</strong> <span class="badge badge-gray">${kindLabel[m.kind] || m.kind}</span>
          <div class="outbox-body">${m.body}</div></div>
        <div class="flex gap-2">
          <a class="btn btn-success btn-sm" target="_blank" rel="noopener" href="${m.wa_link}" onclick="markSent(${m.id})">${icon('whatsapp')} Send</a>
          <button class="btn btn-outline btn-sm" onclick="skipMessage(${m.id})">Skip</button>
        </div></div>`).join('')}
    </div></div>` : emptyState('whatsapp', 'Nothing to send', 'Reminders are drafted at the start of the month and again on the 7th.', `<button class="btn btn-primary btn-sm" onclick="draftOutbox()">Draft now</button>`)}
    ${sent.length ? `<div class="home-section-h">Sent</div><div class="card"><div style="padding:4px 16px">
      ${sent.slice(0, 20).map(m => `<div class="today-row">${icon('whatsapp')}<span class="t-main">${m.guest_name} · ${kindLabel[m.kind] || m.kind}
        <div class="t-sub">${fmtDate(m.sent_at)} by ${m.sent_by_username || '—'}</div></span></div>`).join('')}
    </div></div>` : ''}
  `);
  pgOutboxBulk();
}
async function pgOutboxBulk() {
  bulkSetup('outbox', [
    { action: 'reminders', label: 'Draft reminders', icon: 'whatsapp' },
    { action: 'skip_drafts', label: 'Skip', icon: 'x' }
  ]);
}
async function draftOutbox() { try { const r = await apiFetch('/outbox/draft', { method: 'POST' }); toast(r.drafted ? `${r.drafted} drafted` : 'Nothing due right now', 'ok'); pgOutbox(); } catch (e) { toast(e.message); } }
async function markSent(id) { try { await apiFetch(`/outbox/${id}/sent`, { method: 'POST' }); setTimeout(pgOutbox, 600); } catch (e) { toast(e.message); } }
async function skipMessage(id) { try { await apiFetch(`/outbox/${id}/skip`, { method: 'POST' }); pgOutbox(); } catch (e) { toast(e.message); } }

// ── Recurring maintenance ───────────────────────────────────────
async function pgMaintenance() {
  skeleton('cards');
  document.getElementById('topbar-actions').innerHTML = isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="maintenanceModal()">${icon('plus')} Add task</button>` : '';
  const list = await apiFetch('/maintenance-schedule');
  setContent(`
    <div class="page-header"><h1>Recurring maintenance</h1><p>Things that need doing every few months</p></div>
    ${list.length ? `<div class="card"><div style="padding:4px 16px">
      ${list.map(m => `<div class="today-row">${icon(m.due_now ? 'flag' : 'calendar')}
        <span class="t-main"><strong>${m.task}</strong>${m.vendor ? ` · ${m.vendor}` : ''}
          <div class="t-sub">Every ${m.every_days} days · ${m.last_done ? `last done ${fmtDate(m.last_done)} · ` : ''}next ${fmtDate(m.next_due)}</div></span>
        ${m.due_now ? '<span class="badge badge-amber">due</span>' : ''}
        <button class="btn btn-outline btn-sm" onclick="markMaintenanceDone(${m.id})">Done today</button>
        ${isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="removeMaintenance(${m.id})">✕</button>` : ''}</div>`).join('')}
    </div></div>` : emptyState('calendar', 'No recurring tasks', 'Water tank cleaning, pest control, RO service…', isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="maintenanceModal()">Add one</button>` : '')}
  `);
}
function maintenanceModal() {
  openModal(`<div class="modal"><div class="modal-header"><h3>Recurring task</h3><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-group"><label>What needs doing *</label><input id="mt-task" placeholder="e.g. Water tank cleaning"/></div>
      <div class="form-row">
        <div class="form-group"><label>Who does it</label><input id="mt-vendor" placeholder="Vendor or person"/></div>
        <div class="form-group"><label>Every (days)</label><input id="mt-days" type="number" value="90"/></div>
      </div>
      <div class="form-group"><label>Last done</label><input id="mt-last" type="date"/></div>
      <div id="mt-alert" class="alert alert-danger hidden"></div>
      <button class="btn btn-primary" style="width:100%" onclick="saveMaintenance()">Add</button>
    </div></div>`);
}
async function saveMaintenance() {
  const al = document.getElementById('mt-alert');
  try {
    await apiFetch('/maintenance-schedule', { method: 'POST', body: {
      task: document.getElementById('mt-task').value.trim(), vendor: document.getElementById('mt-vendor').value.trim(),
      every_days: document.getElementById('mt-days').value, last_done: document.getElementById('mt-last').value || null } });
    closeModal(); pgMaintenance();
  } catch (e) { showAlert(al, e.message); }
}
async function markMaintenanceDone(id) { try { await apiFetch(`/maintenance-schedule/${id}/done`, { method: 'POST', body: { date: nowDate() } }); toast('Recorded', 'ok'); pgMaintenance(); } catch (e) { toast(e.message); } }
async function removeMaintenance(id) { if (!confirm('Remove this recurring task?')) return; try { await apiFetch(`/maintenance-schedule/${id}`, { method: 'DELETE' }); pgMaintenance(); } catch (e) { toast(e.message); } }

// ── Documents (Resident 360 → Documents) ────────────────────────
async function loadResidentDocs(guestId) {
  const host = document.getElementById('r360-docs');
  if (!host) return;
  try {
    const docs = await apiFetch(`/guests/${guestId}/documents`);
    const cls = { verified: 'badge-green', pending: 'badge-amber', expired: 'badge-red' };
    host.innerHTML = docs.map(d => `
      <div class="r360-row"><span>${d.doc_type}${d.expires_on ? `<div class="t-sub">expires ${fmtDate(d.expires_on)}</div>` : ''}</span>
        <span class="flex gap-2"><span class="badge ${cls[d.status]}">${d.status}</span>
          <select onchange="setDocStatus(${guestId}, '${d.doc_type}', this.value)" style="margin:0;min-height:36px;width:auto">
            ${['pending', 'verified', 'expired'].map(x => `<option value="${x}" ${d.status === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select></span></div>`).join('');
  } catch (e) { host.innerHTML = `<p class="text-muted">${e.message}</p>`; }
}
async function setDocStatus(guestId, docType, status) {
  try { await apiFetch(`/guests/${guestId}/documents`, { method: 'PUT', body: { doc_type: docType, status } }); loadResidentDocs(guestId); toast('Saved', 'ok'); }
  catch (e) { toast(e.message); }
}

// ── AI metrics (Admin) ──────────────────────────────────────────
async function renderAdminAiTab() {
  const __seq = adminRenderSeq;
  const host = () => adminHost(__seq);
  try {
    const m = await apiFetch('/ai-metrics');
    const card = (label, value, sub) => `<div class="money-card"><div class="m-label">${label}</div><div class="m-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ''}</div>`;
    const h = host(); if (!h) return;
    h.innerHTML = `
      <div class="card"><div class="card-header"><h3>${icon('sparkle')} Is Siri saving work?</h3><span class="text-muted" style="font-size:12px">last ${m.days} days</span></div>
        <div style="padding:14px 16px">
          <div class="money-grid">
            ${card('Questions asked', m.asks)}
            ${card('Entries prepared', m.prepared)}
            ${card('Accepted', m.acceptance_rate == null ? '—' : m.acceptance_rate + '%', `${m.confirmed} of ${m.proposals}`)}
            ${card('Asked instead of guessing', m.clarification_rate == null ? '—' : m.clarification_rate + '%')}
            ${card('Entries not typed', m.ai_entry_share + '%', 'voice, photo or Copilot')}
            ${card('Reminders sent', m.reminders_sent)}
          </div>
          <div class="r360-h">Where entries came from</div>
          ${Object.entries(m.entries_by_source).map(([kind, srcs]) => `<div class="r360-row"><span style="text-transform:capitalize">${kind}s</span>
            <strong>${Object.entries(srcs).map(([k, v]) => `${k} ${v}`).join(' · ')}</strong></div>`).join('') || '<p class="text-muted">No entries yet.</p>'}
          <p class="t-sub" style="margin-top:10px">${m.note}</p>
        </div></div>`;
  } catch (e) { const h = host(); if (h) h.innerHTML = `<div class="alert alert-danger">${e.message}</div>`; }
}


// ── Photograph a fault: Siri suggests, the warden confirms ──────
async function complaintScanFault() {
  const status = document.getElementById('cp-voice-status');
  try {
    const r = await smScan('fault', status);
    if (!r) return;
    const f = r.fields;
    const box = document.getElementById('cp-preview');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="card" style="padding:12px;border:2px solid var(--primary);background:var(--accent-soft);margin-bottom:12px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">Read from the photo (${f.confidence} confidence) — please check</div>
        <div style="font-size:14px;margin:6px 0"><strong>${f.category}</strong> · ${f.priority} priority<br>${f.description || ''}
          ${f.likely_issue ? `<div class="t-sub">Likely: ${f.likely_issue}</div>` : ''}</div>
        <div class="flex gap-2">
          <button class="btn btn-primary btn-sm" onclick='complaintUseFault(${JSON.stringify(f).replace(/'/g, "&#39;")})'>✓ Use this</button>
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('cp-preview').classList.add('hidden')">✗ Ignore</button>
        </div>
      </div>`;
    if (status) status.textContent = 'Photo read. Check the suggestion and tap "Use this".';
  } catch (e) { if (status) { status.textContent = e.message; status.classList.add('voice-error'); } }
}
function complaintUseFault(f) {
  const sel = document.getElementById('cp-category');
  if (sel && [...sel.options].some(o => o.value === f.category)) smFill('cp-category', f.category);
  if (f.description) smFill('cp-desc', f.description);
  window.complaintSource = 'photo';
  window.complaintPriority = f.priority;
  window.complaintLikely = f.likely_issue || null;
  document.getElementById('cp-preview').classList.add('hidden');
}


/* ═══════════════════════════════════════════════════════════════
   SPRINT 13 — bulk actions with a preview, command palette,
   Room 360, universal "Why?", accessibility.
   ═══════════════════════════════════════════════════════════════ */

// ── 1. Bulk selection ────────────────────────────────────────────
// One selection at a time, scoped to the screen that started it. The bar
// only offers what the server allows this role (GET /bulk/limits), and every
// action goes preview → confirm on the server. The UI repeats the cap; it
// never enforces anything on its own.
let bulkSel = { scope: null, ids: new Set(), labels: new Map(), actions: [] };
let bulkLimits = null;

async function bulkGetLimits() {
  if (bulkLimits) return bulkLimits;
  try { bulkLimits = await apiFetch('/bulk/limits'); } catch { bulkLimits = { cap: 15, ack_above: 8, actions: [] }; }
  return bulkLimits;
}
function bulkAllowed(action) { return !bulkLimits || !bulkLimits.actions.length || bulkLimits.actions.some(a => a.action === action); }

// Called by a screen after it renders. `actions` = [{ action, label, icon }]
// in the order the bar should show them.
async function bulkSetup(scope, actions) {
  if (bulkSel.scope !== scope) bulkSel = { scope, ids: new Set(), labels: new Map(), actions: [] };
  await bulkGetLimits();
  bulkSel.actions = actions.filter(a => bulkAllowed(a.action));
  bulkSyncBoxes();
  bulkRenderBar();
}
function bulkCb(id, label) {
  const checked = bulkSel.ids.has(Number(id)) ? 'checked' : '';
  return `<input type="checkbox" class="bulk-cb" data-id="${id}" ${checked} aria-label="Select ${String(label).replace(/"/g, '&quot;')}" onchange="bulkToggle(${id}, this.checked, this.getAttribute('aria-label').slice(7))"/>`;
}
function bulkToggle(id, on, label) {
  id = Number(id);
  if (on) {
    if (bulkLimits && bulkSel.ids.size >= bulkLimits.cap) {
      toast(`At most ${bulkLimits.cap} at a time — confirm this batch first, then pick the next.`);
      const cb = document.querySelector(`.bulk-cb[data-id="${id}"]`); if (cb) cb.checked = false;
      return;
    }
    bulkSel.ids.add(id); if (label) bulkSel.labels.set(id, label);
  } else bulkSel.ids.delete(id);
  bulkRenderBar();
}
// "Select all matching this filter" — whatever rows are on screen right now.
function bulkSelectVisible() {
  const boxes = [...document.querySelectorAll('#page-content .bulk-cb')].filter(cb => cb.closest('tr') ? cb.closest('tr').style.display !== 'none' : true);
  const cap = bulkLimits ? bulkLimits.cap : 15;
  let added = 0;
  for (const cb of boxes) {
    if (bulkSel.ids.size >= cap) break;
    const id = Number(cb.dataset.id);
    if (!bulkSel.ids.has(id)) { bulkSel.ids.add(id); bulkSel.labels.set(id, cb.getAttribute('aria-label').slice(7)); added++; }
    cb.checked = true;
  }
  if (boxes.length > cap) toast(`${boxes.length} match but the limit is ${cap} at a time — the first ${cap} are selected.`, 'ok');
  bulkRenderBar();
}
function bulkClear() {
  bulkSel.ids.clear(); bulkSel.labels.clear();
  document.querySelectorAll('#page-content .bulk-cb').forEach(cb => { cb.checked = false; });
  bulkRenderBar();
}
function bulkSyncBoxes() { document.querySelectorAll('#page-content .bulk-cb').forEach(cb => { cb.checked = bulkSel.ids.has(Number(cb.dataset.id)); }); }
function bulkRenderBar() {
  let bar = document.getElementById('bulk-bar');
  const n = bulkSel.ids.size;
  if (!bulkSel.scope || !bulkSel.actions.length) { if (bar) bar.remove(); document.body.classList.remove('has-bulk-bar'); return; }
  // The bar is fixed above the tab bar, so the last rows would sit underneath
  // it — and a checkbox you cannot tap is worse than no checkbox. Reserve the
  // space while the bar is up.
  document.body.classList.add('has-bulk-bar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'bulk-bar'; bar.className = 'bulk-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Bulk actions'); document.body.appendChild(bar); }
  bar.classList.toggle('bulk-bar-empty', n === 0);
  bar.innerHTML = `
    <div class="bulk-count"><strong id="bulk-count-n">Selected: ${n}</strong>${bulkLimits ? `<span class="t-sub"> of ${bulkLimits.cap} max</span>` : ''}</div>
    <div class="bulk-actions">
      <button class="btn btn-outline btn-sm" onclick="bulkSelectVisible()">Select all shown</button>
      ${bulkSel.actions.map(a => `<button class="btn btn-primary btn-sm" ${n ? '' : 'disabled'} onclick="bulkStart('${a.action}')">${a.icon ? icon(a.icon) : ''}${a.label}</button>`).join('')}
      ${n ? `<button class="btn btn-outline btn-sm" onclick="bulkClear()" aria-label="Clear selection">✕ Clear</button>` : ''}
    </div>`;
}
// Leaving the screen drops the selection; the bar goes with it.
function bulkReset() { bulkSel = { scope: null, ids: new Set(), labels: new Map(), actions: [] }; const b = document.getElementById('bulk-bar'); if (b) b.remove(); document.body.classList.remove('has-bulk-bar'); }

// The arguments some actions need, gathered in a small form first.
async function bulkStart(action) {
  const ids = [...bulkSel.ids];
  if (!ids.length) return;
  if (action === 'reminders' || action === 'skip_drafts') return bulkPreview(action, ids, {});
  if (action === 'announcement') {
    return openModal(`<div class="modal"><div class="modal-header"><h3>Notice to ${ids.length} resident${ids.length === 1 ? '' : 's'}</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <p class="t-sub" style="margin-bottom:10px">Each selected resident gets her own copy in the portal. You will see a preview before anything is posted.</p>
        <div class="form-group"><label for="bk-an-title">Title</label><input id="bk-an-title" placeholder="e.g. Water off tomorrow 10–12"/></div>
        <div class="form-group"><label for="bk-an-msg">Message</label><textarea id="bk-an-msg" rows="3" placeholder="What they need to know"></textarea></div>
        <div class="form-group"><label for="bk-an-priority">Priority</label><select id="bk-an-priority"><option value="normal">Normal</option><option value="important">Important</option><option value="urgent">Urgent</option></select></div>
        <button class="btn btn-primary" style="width:100%" onclick="bulkPreview('announcement', [${ids}], { title: document.getElementById('bk-an-title').value, message: document.getElementById('bk-an-msg').value, priority: document.getElementById('bk-an-priority').value })">Preview</button>
      </div></div>`);
  }
  if (action === 'assign') {
    let staff = [];
    try { staff = await apiFetch('/staff-list'); } catch (e) { return toast(e.message); }
    return openModal(`<div class="modal"><div class="modal-header"><h3>Assign ${ids.length} request${ids.length === 1 ? '' : 's'}</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-group"><label for="bk-assign-to">Assign to</label><select id="bk-assign-to">${staff.map(u => `<option value="${u.id}">${u.username}${u.role === 'admin' ? ' (owner)' : ''}</option>`).join('')}</select></div>
        <button class="btn btn-primary" style="width:100%" onclick="bulkPreview('assign', [${ids}], { assigned_to: document.getElementById('bk-assign-to').value })">Preview</button>
      </div></div>`);
  }
  if (action === 'documents') {
    return openModal(`<div class="modal"><div class="modal-header"><h3>Documents for ${ids.length} resident${ids.length === 1 ? '' : 's'}</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
      <div class="modal-body">
        <div class="form-group"><label for="bk-doc-type">Document</label><select id="bk-doc-type">${['ID proof', 'Address proof', 'Agreement', 'Deposit receipt'].map(t => `<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label for="bk-doc-status">Mark as</label><select id="bk-doc-status"><option value="verified">Verified</option><option value="pending">Pending</option></select></div>
        <button class="btn btn-primary" style="width:100%" onclick="bulkPreview('documents', [${ids}], { doc_type: document.getElementById('bk-doc-type').value, status: document.getElementById('bk-doc-status').value })">Preview</button>
      </div></div>`);
  }
}

// The preview: what the server says will happen, who is skipped and why.
async function bulkPreview(action, ids, args) {
  openModal(`<div class="modal"><div class="modal-header"><h3>Preview</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="sm-skel"><div class="sm-skel-line" style="width:60%"></div><div class="sm-skel-line" style="width:40%"></div></div></div></div>`);
  let p;
  try { p = await apiFetch('/bulk/preview', { method: 'POST', body: { action, ids, args } }); }
  catch (e) { return openModal(`<div class="modal"><div class="modal-header"><h3>Preview</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="alert alert-danger" style="display:block">${e.message}</div></div></div>`); }
  renderBulkPreview(p);
}
function bulkPreviewHtml(p) {
  return `
    <div class="bulk-lines">${p.lines.map((l, i) => `<div class="bulk-line ${i === 0 ? 'bulk-line-h' : ''}">${l}</div>`).join('')}</div>
    ${p.eligible.length ? `<details class="bulk-list"><summary>Review list (${p.eligible.length})</summary>
      ${p.eligible.map(r => `<div class="r360-row"><span>${r.name}${r.room_number ? ` · Room ${r.room_number}` : ''}${r.kind ? ` <span class="badge badge-gray">${r.kind === 'rent_overdue' ? 'overdue' : 'due'}</span>` : ''}</span>${r.amount_due != null && r.amount_due !== undefined && r.amount_due > 0 ? `<strong>${fmt(r.amount_due)}</strong>` : ''}</div>`).join('')}</details>` : ''}
    ${p.skipped.length ? `<details class="bulk-list bulk-skipped"><summary>Skipped (${p.skipped.length})</summary>
      ${p.skipped.map(r => `<div class="r360-row"><span>${r.name}${r.room_number ? ` · Room ${r.room_number}` : ''}</span><span class="t-sub">${r.reason}</span></div>`).join('')}</details>` : ''}`;
}
function renderBulkPreview(p) {
  const n = p.eligible.length;
  openModal(`<div class="modal"><div class="modal-header"><h3>${p.label}</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      ${bulkPreviewHtml(p)}
      ${p.drafts_only ? `<p class="bulk-note">${icon('whatsapp')} Drafts go to the Outbox. Sending stays one tap per message — nothing is sent from here.</p>` : ''}
      <div id="bulk-alert" class="alert alert-danger hidden"></div>
      <div class="flex gap-2" style="margin-top:14px;flex-wrap:wrap">
        ${n && p.proposal ? `<button class="btn btn-primary" id="bulk-confirm-btn" onclick="bulkConfirm('${p.proposal.id}', ${p.requires_second_confirm}, ${p.confirm_count}, this)">Confirm${p.requires_second_confirm ? '…' : ''}</button>` : `<span class="t-sub">Nothing to do — everyone is skipped.</span>`}
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      </div>
    </div></div>`);
}
// Above the threshold the button turns into a second, explicit confirmation
// that names the count. The server refuses without it.
async function bulkConfirm(proposalId, needsCount, count, btn) {
  if (needsCount && !btn.dataset.acked) {
    btn.dataset.acked = '1';
    btn.className = 'btn btn-danger';
    btn.textContent = `Yes — go ahead with all ${count}`;
    return;
  }
  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const r = await apiFetch('/bulk/confirm', { method: 'POST', body: { proposal_id: proposalId, count } });
    closeModal(); bulkClear();
    toast(r.answer, 'ok');
    if (r.actions && r.actions[0] && r.actions[0].navigate && r.actions[0].navigate !== currentPage) navigate(r.actions[0].navigate); else if (currentPage) navigate(currentPage);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Try again';
    const a = document.getElementById('bulk-alert'); if (a) showAlert(a, e.message); else toast(e.message);
  }
}

// ── 2. Command palette (Ctrl+K gains commands) ───────────────────
// Same sheet as search, three groups: Commands · Results · Ask Siri.
// Role-filtered exactly like the sidebar (admin flag), never by hiding
// alone — every command's target is itself role-checked on the server.
const COMMANDS = [
  { id: 'add-resident', icon: 'users', label: 'Add resident', run: () => { navigate('guests'); setTimeout(() => moveInWizard(), 350); } },
  { id: 'collect', icon: 'rupee', label: 'Collect payment', run: () => navigate('collect') },
  { id: 'expense', icon: 'cart', label: 'Add expense', run: () => { navigate('purchases'); setTimeout(() => purchaseModal(), 350); } },
  { id: 'issue', icon: 'wrench', label: 'Report an issue', run: () => { navigate('complaints'); setTimeout(() => complaintModal(), 350); } },
  { id: 'announce', icon: 'megaphone', label: 'Post announcement', admin: true, run: () => { navigate('guest-messages'); setTimeout(() => announcementModal(), 350); } },
  { id: 'reminders', icon: 'whatsapp', label: 'Draft reminders', run: () => { navigate('rent-due'); setTimeout(() => toast('Tick the residents, then tap Draft reminders', 'ok'), 400); } },
  { id: 'tasks', icon: 'check-square', label: "Today's tasks", run: () => navigate('daily-checklist') },
  { id: 'owner-report', icon: 'receipt', label: 'Generate owner report', admin: true, run: () => { navigate('balance-sheet'); setTimeout(() => { if (typeof loadOwnerReport === 'function') loadOwnerReport(true); }, 400); } },
  { id: 'close-day', icon: 'moon', label: 'Close the day', admin: true, run: () => navigate('finance-overview') },
  { id: 'theme', icon: 'moon', label: 'Switch theme', run: () => toggleTheme() }
];
function commandsFor(q) {
  const list = COMMANDS.filter(c => !c.admin || isAdmin());
  if (!q) return list;
  const t = q.toLowerCase();
  return list.filter(c => c.label.toLowerCase().includes(t));
}
function paletteRunCommand(id) { const c = COMMANDS.find(x => x.id === id); if (!c || (c.admin && !isAdmin())) return; closeSearch(); c.run(); }
function renderPaletteCommands(q) {
  const cmds = commandsFor(q);
  if (!cmds.length) return '';
  const parts = ['<div class="search-group">Commands</div>'];
  cmds.forEach(c => { const i = searchRows.length; searchRows.push({ go: () => paletteRunCommand(c.id) }); parts.push(`<button class="search-item search-cmd" data-cmd="${c.id}" data-i="${i}" onclick="searchRows[${i}].go()">${icon(c.icon)}<span>${c.label}</span></button>`); });
  return parts.join('');
}
function renderPaletteAsk(q) {
  if (!q || q.length < 2) return '';
  const i = searchRows.length;
  searchRows.push({ go: () => { const t = q; closeSearch(); const bar = document.getElementById('copilot-q'); if (bar) bar.value = t; copilotAsk(t); } });
  return `<div class="search-group">Ask Siri</div><button class="search-item search-ask" data-i="${i}" onclick="searchRows[${i}].go()">${icon('sparkle')}<span>Ask Siri: “${q.replace(/</g, '&lt;')}”</span></button>`;
}

// ── 3. Room 360 ──────────────────────────────────────────────────
const ROOM360_TABS = [{ id: 'overview', label: 'Overview' }, { id: 'residents', label: 'Residents' }, { id: 'maintenance', label: 'Maintenance' }, { id: 'history', label: 'History' }];
let room360 = { id: null, tab: 'overview', data: null };

async function roomProfile(id, tab) {
  room360 = { id, tab: tab || 'overview', data: null };
  openModal(`<div class="modal modal-lg"><div class="modal-header"><h3>Room</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
    <div class="modal-body"><div class="sm-skel"><div class="sm-skel-line" style="width:50%"></div><div class="sm-skel-card"></div></div></div></div>`);
  try { room360.data = await apiFetch(`/rooms/${id}/360`); smSetContext({ room_number: room360.data.room.room_number }); renderRoom360(); }
  catch (e) { openModal(`<div class="modal"><div class="modal-header"><h3>Room</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="alert alert-danger" style="display:block">${e.message}</div></div></div>`); }
}
function renderRoom360() {
  const d = room360.data, r = d.room, h = d.health;
  const tile = roomMapCache ? roomMapCache.floors.flatMap(f => f.rooms).find(x => String(x.id) === String(r.id)) : null;
  const kv = rows => rows.map(([k, v]) => `<div class="r360-kv"><span>${k}</span><strong>${v || '—'}</strong></div>`).join('');
  const cls = s => s >= 80 ? 'good' : s >= 60 ? 'ok' : 'low';
  const body = {
    overview: () => `
      <div class="r360-status"><span class="health-pill ${cls(h.overall)}">Health ${h.overall}</span>${whyBtn(h.basis, 'Why this health score?')}
        <span class="badge ${r.status === 'active' ? 'badge-green' : 'badge-amber'}">${r.status}</span></div>
      <div class="room-health">${Object.entries(h.components).map(([k, c]) => `<div class="rh-row"><span class="rh-label">${k}</span><span class="rh-bar"><i style="width:${c.score}%" class="${cls(c.score)}"></i></span><strong>${c.score}</strong>${whyBtn(c.why, 'Why ' + k + '?')}</div>`).join('')}</div>
      ${kv([['Floor', r.floor], ['Beds', `${d.residents.length} of ${r.total_beds} taken`], ['Rent', fmt(r.monthly_rent)], ['Type', r.room_type], ['Open requests', d.maintenance.open], ['Last inspected', r.last_inspected ? fmtDate(r.last_inspected) : 'Never']])}
      ${(tile && tile.bed_fixes && tile.bed_fixes.length) ? tile.bed_fixes.map(o => `<div class="r360-row"><span class="text-amber">Bed number needs fixing${o.bed_number ? ` · recorded as “${o.bed_number}”` : ' · none recorded'}</span><button class="btn btn-outline btn-sm" onclick="closeModal();guestModal(null,${o.id})">${o.name}</button></div>`).join('') : ''}
      <div class="r360-h">Inspections</div>
      ${d.inspections.length ? d.inspections.map(i => `<div class="r360-row"><span><span class="badge ${i.condition === 'good' ? 'badge-green' : i.condition === 'poor' ? 'badge-red' : 'badge-gray'}">${i.condition}</span> ${fmtDate(i.inspected_on)}${i.note ? `<div class="t-sub">${i.note}</div>` : ''}</span><span class="t-sub">${i.username || ''}</span></div>`).join('') : '<p class="t-sub">No inspection recorded yet.</p>'}
      <div class="flex gap-2" style="flex-wrap:wrap;margin-top:14px">
        <button class="btn btn-primary btn-sm" onclick="inspectionForm(${r.id})">Record inspection</button>
        ${d.residents.length < r.total_beds && r.status === 'active' ? `<button class="btn btn-outline btn-sm" onclick="closeModal();moveInWizard({ room_id: ${r.id} })">Move someone in</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="setRoomStatus(${r.id}, '${r.status === 'maintenance' ? 'active' : 'maintenance'}')">${r.status === 'maintenance' ? 'Back in service' : 'Under maintenance'}</button>` : ''}
      </div>
      <div id="rs-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>`,
    // Every bed, taken or free — the old tap-sheet listed them and losing that
    // would hide the empty beds. A resident whose bed number is wrong or
    // duplicated is listed too, flagged, never dropped to tidy the view.
    residents: () => {
      const byBed = new Map();
      const odd = [];
      for (const g of d.residents) {
        const n = Number(g.bed_number);
        if (Number.isInteger(n) && n >= 1 && n <= r.total_beds && !byBed.has(n)) byBed.set(n, g);
        else odd.push(g);
      }
      const rows = [];
      for (let n = 1; n <= r.total_beds; n++) {
        const g = byBed.get(n);
        rows.push(`<div class="r360-row"><span>Bed ${n}${g ? `<div class="t-sub"><strong>${g.name}</strong> · since ${fmtDate(g.join_date)}${g.expected_checkout ? ' · leaving ' + fmtDate(g.expected_checkout) : ''}</div>` : ''}</span>${g
          ? `<button class="btn btn-outline btn-sm" onclick="closeModal();residentProfile(${g.id})">Open</button>`
          : `<span class="badge badge-green">free</span>`}</div>`);
      }
      for (const g of odd) rows.push(`<div class="r360-row"><span class="text-amber">Bed number needs fixing${g.bed_number ? ` · recorded as “${g.bed_number}”` : ' · none recorded'}<div class="t-sub"><strong>${g.name}</strong></div></span>
        <button class="btn btn-outline btn-sm" onclick="closeModal();residentProfile(${g.id})">Open</button></div>`);
      return rows.join('');
    },
    maintenance: () => `${d.repeats.length ? `<div class="alert alert-warning" style="display:block;margin-bottom:10px">Repeated in 90 days: ${d.repeats.map(x => `${x.category} ×${x.n}`).join(', ')} — the same thing again usually means the cause is still there.</div>` : ''}
      ${d.maintenance.items.length ? d.maintenance.items.map(c => `<div class="r360-row"><span><strong>${c.category}</strong> ${priorityBadge(c.priority)}<div class="t-sub">${fmtDate(c.created_at)} · ${c.description.slice(0, 80)}</div><div class="t-sub">Outcome: ${c.outcome}</div></span><button class="btn btn-outline btn-sm" onclick="requestSheet(${c.id})">Open</button></div>`).join('')
        : emptyState('wrench', 'No requests ever', 'Nothing has been raised for this room.', '')}`,
    history: () => {
      const rows = [
        ...d.history.lived.map(x => ({ at: x.from, html: `<strong>${x.name}</strong> ${x.kind === 'living' ? 'lives here' : 'lived here'}<div class="t-sub">${fmtDate(x.from)} → ${x.to ? fmtDate(x.to) : 'now'}</div>` })),
        ...d.history.moves.map(x => ({ at: x.on, html: `<strong>${x.name}</strong> ${x.kind === 'moved_in' ? `moved in${x.from_room ? ' from Room ' + x.from_room : ''}` : `moved out to Room ${x.to_room}`}${x.bed ? ' · bed ' + x.bed : ''}<div class="t-sub">${fmtDate(x.on)}${x.note ? ' · ' + x.note : ''}</div>` }))
      ].sort((a, b) => new Date(b.at) - new Date(a.at));
      return rows.length ? `<ul class="r360-timeline">${rows.map(x => `<li><div class="tl-date">${fmtDate(x.at)}</div><div>${x.html}</div></li>`).join('')}</ul>` : emptyState('bed', 'No history yet', 'Moves and stays will appear here.', '');
    }
  };
  openModal(`<div class="modal modal-lg">
    <div class="modal-header"><h3>Room ${r.room_number}</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="subtabs" role="tablist">${ROOM360_TABS.map(t => `<button class="subtab ${t.id === room360.tab ? 'active' : ''}" role="tab" aria-selected="${t.id === room360.tab}" onclick="room360.tab='${t.id}';renderRoom360()">${t.label}</button>`).join('')}</div>
      <div id="room360-body">${body[room360.tab]()}</div>
    </div></div>`);
}
function inspectionForm(roomId) {
  openModal(`<div class="modal"><div class="modal-header"><h3>Record inspection</h3><button class="modal-close" aria-label="Close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-group"><label for="insp-cond">Condition</label><select id="insp-cond"><option value="good">Good</option><option value="ok" selected>OK</option><option value="poor">Poor — needs work</option></select></div>
      <div class="form-group"><label for="insp-date">Date</label><input type="date" id="insp-date" value="${nowDate()}"/></div>
      <div class="form-group"><label for="insp-note">Note</label><textarea id="insp-note" rows="3" placeholder="What you saw — fan, geyser, walls, bathroom…"></textarea></div>
      <button class="btn btn-primary" style="width:100%" onclick="saveInspection(${roomId})">Save</button>
      <div id="insp-alert" class="alert alert-danger hidden" style="margin-top:10px"></div>
    </div></div>`);
}
async function saveInspection(roomId) {
  const body = { condition: document.getElementById('insp-cond').value, date: document.getElementById('insp-date').value, note: document.getElementById('insp-note').value.trim() || undefined };
  try { await apiFetch(`/rooms/${roomId}/inspections`, { method: 'POST', body }); toast('Inspection recorded', 'ok'); if (currentPage === 'rooms') { const m = await apiFetch('/room-map'); roomMapCache = m; } roomProfile(roomId, 'overview'); }
  catch (e) { const a = document.getElementById('insp-alert'); if (a) showAlert(a, e.message); else toast(e.message); }
}

// ── 4. Universal "Why?" ──────────────────────────────────────────
// A small "?" beside any AI-derived figure. The text ALWAYS comes from the
// API (`why`, `basis`, `priority_why`); nothing here composes an explanation.
function whyBtn(text, label) {
  if (!text) return '';
  return `<button type="button" class="why-btn" aria-label="${(label || 'Why?').replace(/"/g, '&quot;')}" title="Why?" data-why="${String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" onclick="showWhy(this)">?</button>`;
}
function showWhy(btn) {
  const text = btn.dataset.why || '';
  const label = btn.getAttribute('aria-label') || 'Why?';
  let pop = document.getElementById('why-pop');
  if (pop) pop.remove();
  pop = document.createElement('div');
  pop.id = 'why-pop'; pop.className = 'why-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', label);
  pop.innerHTML = `<div class="why-pop-h">${label}</div><div class="why-pop-t">${text.replace(/\n/g, '<br>')}</div><button class="btn btn-outline btn-sm" onclick="closeWhy()">Got it</button>`;
  document.body.appendChild(pop);
  // Anchor under the button on wide screens; a bottom sheet on phones.
  const rect = btn.getBoundingClientRect();
  if (window.innerWidth > 640) {
    pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 12, rect.bottom + 8 + window.scrollY)}px`;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  }
  pop.querySelector('button').focus();
  window.__whyReturn = btn;
}
function closeWhy() { const p = document.getElementById('why-pop'); if (p) p.remove(); if (window.__whyReturn) { try { window.__whyReturn.focus(); } catch {} window.__whyReturn = null; } }

// ── 5. Accessibility ─────────────────────────────────────────────
// Three things the screens could not be trusted to do one by one:
//   • every icon-only button gets an aria-label (from a real name, not the
//     icon id when we know better);
//   • every table header is scope="col";
//   • every form input has a <label for>.
// Runs on every render through the same observer the card view uses, so a
// screen added later is covered on day one.
const ICON_LABELS = { refresh: 'Recompute', whatsapp: 'WhatsApp', copy: 'Copy', moon: 'Evening summary', receipt: 'Download receipt', camera: 'Add photo', mic: 'Speak', search: 'Search', plus: 'Add', bell: 'Notifications', menu: 'Menu', x: 'Close', close: 'Close', chevron: 'Open', flag: 'Flag', sparkle: 'Ask Siri', trash: 'Delete', edit: 'Edit', logout: 'Log out', users: 'Residents', bed: 'Rooms', wrench: 'Requests', rupee: 'Collect', calendar: 'Date', cart: 'Expenses', megaphone: 'Announcements', 'check-square': 'Checklist', wallet: 'Finance', inbox: 'Messages', lock: 'Admin', chart: 'Chart', utensils: 'Menu' };
function a11ySweep(root) {
  const scope = root || document.body;
  scope.querySelectorAll('button, a.btn, a[role=button]').forEach(b => {
    if (b.getAttribute('aria-label') || b.getAttribute('aria-labelledby')) return;
    const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && !/^[×✕✓✗⬇↻+\-–—…•·?]*$/.test(text)) return;   // has readable text
    if (b.classList.contains('modal-close') || text === '×' || text === '✕') return b.setAttribute('aria-label', 'Close');
    if (b.classList.contains('why-btn')) return b.setAttribute('aria-label', 'Why?');
    const use = b.querySelector('use'); const id = use ? String(use.getAttribute('href') || use.getAttribute('xlink:href') || '').replace('#i-', '') : '';
    const label = b.getAttribute('title') || ICON_LABELS[id] || (id ? id.replace(/-/g, ' ') : '') || text || 'Button';
    b.setAttribute('aria-label', label);
  });
  scope.querySelectorAll('thead th:not([scope])').forEach(th => th.setAttribute('scope', 'col'));
  let seq = 0;
  scope.querySelectorAll('label:not([for])').forEach(l => {
    if (l.querySelector('input, select, textarea')) return;              // wraps its control already
    let ctl = l.nextElementSibling;
    if (!ctl || !/^(INPUT|SELECT|TEXTAREA)$/.test(ctl.tagName)) { const p = l.parentElement; ctl = p ? p.querySelector('input, select, textarea') : null; }
    if (!ctl) return;
    if (!ctl.id) ctl.id = `f-${Date.now().toString(36)}-${seq++}`;
    l.setAttribute('for', ctl.id);
  });
  scope.querySelectorAll('input:not([id]):not([type=checkbox]):not([type=hidden]):not([aria-label]), select:not([id]):not([aria-label]), textarea:not([id]):not([aria-label])').forEach(el => {
    const ph = el.getAttribute('placeholder'); if (ph) el.setAttribute('aria-label', ph.replace(/^[^\w]+/, '').trim() || 'Field');
  });
}
let a11yQueued = false;
function queueA11y() { if (a11yQueued) return; a11yQueued = true; requestAnimationFrame(() => { a11yQueued = false; try { a11ySweep(); } catch (e) { console.error(e); } }); }

// Modal focus: move in on open, keep Tab inside, Esc closes, return on close.
let modalReturnFocus = null;
function modalFocusIn() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  if (!overlay.dataset.a11y) {
    overlay.dataset.a11y = '1';
    const m = overlay.querySelector('.modal'); if (m) { m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); const h = m.querySelector('.modal-header h3'); if (h) { if (!h.id) h.id = 'modal-title-' + Date.now().toString(36); m.setAttribute('aria-labelledby', h.id); } }
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); closeModal(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(overlay); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  if (!overlay.contains(document.activeElement)) {
    // Remember where focus came from so closing can put it back — without
    // this, Esc drops the keyboard user at the top of the page.
    if (document.activeElement && document.activeElement !== document.body) modalReturnFocus = document.activeElement;
    const f = focusables(overlay).filter(el => !el.classList.contains('modal-close'));
    (f[0] || focusables(overlay)[0] || overlay).focus();
  }
}
function focusables(root) { return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null); }

// Wire the sweeps: the observer that mobilises tables also covers labels; the
// modal container gets its own so focus moves the moment a modal renders.
(function initA11y() {
  const start = () => {
    const pc = document.getElementById('page-content'); const mc = document.getElementById('modal-container');
    if (pc) new MutationObserver(queueA11y).observe(pc, { childList: true, subtree: true });
    if (mc) new MutationObserver(() => {
      queueA11y();
      if (document.getElementById('modal-overlay')) modalFocusIn();
      else if (modalReturnFocus) {
        const back = modalReturnFocus; modalReturnFocus = null;
        if (document.body.contains(back)) { try { back.focus(); } catch (e) {} }
      }
    }).observe(mc, { childList: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWhy(); });
    queueA11y();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
