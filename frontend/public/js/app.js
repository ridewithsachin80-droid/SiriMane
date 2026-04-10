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

function navigate(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page===page));
  const titles = { dashboard:'Dashboard', rooms:'Rooms', guests:'Guests', 'daily-menu':'Daily Menu', payments:'Payments', 'guest-messages':'Guest Messages', inbox:'Inbox', purchases:'Purchases', collections:'Collections', reports:'Reports' };
  document.getElementById('page-title').textContent = titles[page]||page;
  document.getElementById('topbar-actions').innerHTML = '';
  document.getElementById('sidebar').classList.remove('open');
  const pages = { dashboard:pgDashboard, rooms:pgRooms, guests:pgGuests, 'daily-menu':pgMenu, payments:pgPayments, 'guest-messages':pgAnnouncements, inbox:pgInbox, purchases:pgPurchases, collections:pgCollections, reports:pgReports };
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
function closeModal() { document.getElementById('modal-container').innerHTML = ''; }
function loading() { setContent('<div class="loading-center"><div class="spinner"></div></div>'); }
function nowDate() { return new Date().toISOString().split('T')[0]; }
function monthPicker() {
  const n = new Date();
  return `<input type="month" id="month-picker" value="${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}" style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;cursor:pointer">`;
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
                        <button class="btn btn-danger btn-sm" onclick="delRoom(${r.id},'${r.room_number}')">Delete</button>
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
    setContent(`
      <div class="page-header"><h1>Guests</h1><p>Register and manage PG residents</p></div>
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
            <thead><tr><th>NAME</th><th>PHONE</th><th>ROOM / BERTH</th><th>CHECK-IN</th><th>RENT</th><th>STATUS</th><th>DOCS</th><th>ACTIONS</th></tr></thead>
            <tbody id="guests-tb">
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="8">No guests yet. Click Add Guest to register.</td></tr>`
                : list.map(g=>`
                <tr data-search="${g.name.toLowerCase()} ${g.phone||''}">
                  <td><strong>${g.name}</strong><br><span class="text-muted">${g.email||''}</span></td>
                  <td>${g.phone||'—'}</td>
                  <td>${g.room_number?'Room '+g.room_number+(g.bed_number?' / Bed '+g.bed_number:''):'-'}</td>
                  <td>${fmtDate(g.join_date)}</td>
                  <td>${fmt(g.monthly_rent)}/mo</td>
                  <td><span class="badge ${g.is_active?'badge-green':'badge-red'}">${g.is_active?'Active':'Left'}</span></td>
                  <td><span class="badge badge-gray">${g.id_proof_type||'—'}</span></td>
                  <td>
                    <div class="flex gap-2">
                      <button class="btn btn-outline btn-sm" onclick="viewGuest(${g.id})">View</button>
                      <button class="btn btn-primary btn-sm" onclick="guestModal(null,${g.id})">Edit</button>
                      ${g.is_active?`<button class="btn btn-danger btn-sm" onclick="checkoutGuest(${g.id},'${g.name}')">Checkout</button>`:''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
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
            <select id="gf-room">
              <option value="">— Select Room —</option>
              ${rooms.map(r=>`<option value="${r.id}" ${g.room_id==r.id?'selected':''}>Room ${r.room_number} (${r.available_beds} beds free)</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Bed / Berth Number</label><input id="gf-bed" type="number" value="${g.bed_number||''}" placeholder="1, 2..."/></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Check-in Date *</label><input id="gf-join" type="date" value="${g.join_date?g.join_date.split('T')[0]:nowDate()}"/></div>
          <div class="form-group"><label>Monthly Rent (₹)</label><input id="gf-rent" type="number" value="${g.monthly_rent||''}" placeholder="e.g. 5000"/></div>
        </div>
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
}

async function saveGuest(id) {
  const al = document.getElementById('gf-alert');
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
    notes:document.getElementById('gf-notes').value
  };
  if(!d.name) { showAlert(al,'Name is required'); return; }
  if(!d.join_date) { showAlert(al,'Check-in date required'); return; }
  try { if(id) await API.updateGuest(id,d); else await API.createGuest(d); closeModal(); pgGuests(); }
  catch(e) { showAlert(al,e.message); }
}

async function viewGuest(id) {
  try {
    const g = await API.getGuest(id);
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
          <h4 style="margin-bottom:10px;font-size:14px">Payment History</h4>
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

async function checkoutGuest(id, name) {
  if(!confirm(`Checkout ${name}?`)) return;
  try { await API.checkoutGuest(id); pgGuests(); } catch(e) { alert(e.message); }
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
async function pgPayments() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Record Payment</button>`;
  try {
    const now = new Date();
    const list = await API.getCollections(`?month=${now.getMonth()+1}&year=${now.getFullYear()}`);
    const total = list.reduce((s,c)=>s+parseFloat(c.amount),0);
    setContent(`
      <div class="page-header"><h1>Payments</h1><p>Track rent payments</p></div>
      <div class="card">
        <div class="card-header">
          <h3>Payment Records</h3>
          <button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Record Payment</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>GUEST</th><th>MONTH</th><th>AMOUNT</th><th>DATE</th><th>MODE</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="7">No payments yet.</td></tr>`
                : list.map(c=>`<tr>
                  <td><strong>${c.guest_name||c.guest_name||'—'}</strong></td>
                  <td>${c.collection_month||fmtMonth(c.collection_date)}</td>
                  <td class="text-green fw-600">${fmt(c.amount)}</td>
                  <td>${fmtDate(c.collection_date)}</td>
                  <td><span class="badge badge-blue">${c.payment_mode}</span></td>
                  <td><span class="badge badge-green">Received</span></td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

// ── GUEST MESSAGES (Announcements) ───────────────
async function pgAnnouncements() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="announcementModal()">📢 Post Message</button>`;
  try {
    const list = await API.getAnnouncements();
    setContent(`
      <div class="page-header"><h1>Guest Messages</h1><p>Post announcements and notices to all guests</p></div>
      <div class="card">
        <div class="card-header"><h3>Posted Messages</h3><button class="btn btn-primary btn-sm" onclick="announcementModal()">📢 Post Message</button></div>
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
                  <button class="btn btn-danger btn-sm btn-icon" onclick="delAnnouncement(${a.id})">✕</button>
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
async function pgPurchases() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="purchaseModal()">+ Add Purchase</button>`;
  try {
    const now = new Date();
    const list = await API.getPurchases(`?month=${now.getMonth()+1}&year=${now.getFullYear()}`);
    const total = list.reduce((s,p)=>s+parseFloat(p.amount),0);
    const byCat = {};
    list.forEach(p => { byCat[p.category]=(byCat[p.category]||0)+parseFloat(p.amount); });
    setContent(`
      <div class="page-header"><h1>🛒 Purchases</h1><p>Track all PG expenses and purchases</p></div>
      <div class="stat-grid mb-5">
        <div class="stat-card red"><div class="s-label">This Month</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${now.toLocaleString('en-IN',{month:'long',year:'numeric'})}</div></div>
        <div class="stat-card"><div class="s-label">Groceries</div><div class="s-value">${fmt(byCat['Groceries']||0)}</div><div class="s-sub" style="color:var(--green)">Food &amp; vegetables</div></div>
        <div class="stat-card"><div class="s-label">Maintenance</div><div class="s-value">${fmt(byCat['Maintenance']||0)}</div><div class="s-sub" style="color:var(--amber)">Repairs &amp; upkeep</div></div>
        <div class="stat-card"><div class="s-label">Utilities</div><div class="s-value">${fmt((byCat['Electricity']||0)+(byCat['Water']||0)+(byCat['Internet']||0))}</div><div class="s-sub" style="color:var(--blue)">Bills &amp; services</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Purchases</h3>
          <div class="flex gap-2 items-center">
            ${monthPicker()}
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
            <tbody id="purchases-tb">
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="7">No purchases found for this filter.</td></tr>`
                : list.map(p=>`<tr>
                  <td>${fmtDate(p.purchase_date)}</td>
                  <td><span class="badge badge-amber">${p.category}</span></td>
                  <td>${p.description||'—'}</td>
                  <td class="text-red fw-600">${fmt(p.amount)}</td>
                  <td>${p.paid_to||'—'}</td>
                  <td>${p.payment_mode}</td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delPurchase(${p.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
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
        <div class="form-row">
          <div class="form-group"><label>Amount (₹) *</label><input id="pu-amt" type="number" placeholder="e.g. 500"/></div>
          <div class="form-group"><label>Date</label><input id="pu-date" type="date" value="${nowDate()}"/></div>
        </div>
        <div class="form-group"><label>Category *</label>
          <select id="pu-cat">
            ${['Groceries','Maintenance','Electricity','Water','Internet','Cleaning','Salary','Furniture','Repairs','Other'].map(c=>`<option>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Description</label><textarea id="pu-desc" rows="2" placeholder="What was purchased?"></textarea></div>
        <div class="form-row">
          <div class="form-group"><label>Paid To</label><input id="pu-paid" placeholder="Vendor name"/></div>
          <div class="form-group"><label>Payment Mode</label>
            <select id="pu-mode">${['Cash','UPI','Bank Transfer','Cheque'].map(m=>`<option>${m}</option>`).join('')}</select>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="savePurchase()">Add Purchase</button>
      </div>
    </div>`);
}

async function savePurchase() {
  const al = document.getElementById('pu-alert');
  const d = { amount:document.getElementById('pu-amt').value, purchase_date:document.getElementById('pu-date').value, category:document.getElementById('pu-cat').value, description:document.getElementById('pu-desc').value, paid_to:document.getElementById('pu-paid').value, payment_mode:document.getElementById('pu-mode').value };
  if(!d.amount) { showAlert(al,'Amount required'); return; }
  try { await API.createPurchase(d); closeModal(); pgPurchases(); } catch(e) { showAlert(al,e.message); }
}

async function delPurchase(id) {
  if(!confirm('Delete?')) return;
  try { await API.deletePurchase(id); pgPurchases(); } catch(e) { alert(e.message); }
}

// ── COLLECTIONS (Income) ──────────────────────────
async function pgCollections() {
  loading();
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Add Collection</button>`;
  try {
    const now = new Date();
    const list = await API.getCollections(`?month=${now.getMonth()+1}&year=${now.getFullYear()}`);
    const total = list.reduce((s,c)=>s+parseFloat(c.amount),0);
    const byType = {};
    list.forEach(c => { byType[c.collection_type]=(byType[c.collection_type]||0)+parseFloat(c.amount); });
    setContent(`
      <div class="page-header"><h1>💵 Collections</h1><p>Track all income — rent, deposits, and extra charges</p></div>
      <div class="stat-grid mb-5">
        <div class="stat-card green"><div class="s-label">This Month</div><div class="s-value">${fmt(total)}</div><div class="s-sub">${now.toLocaleString('en-IN',{month:'long',year:'numeric'})}</div></div>
        <div class="stat-card"><div class="s-label">Rent</div><div class="s-value">${fmt(byType['rent']||0)}</div><div class="s-sub" style="color:var(--green)">Monthly rent</div></div>
        <div class="stat-card"><div class="s-label">Deposits</div><div class="s-value">${fmt(byType['deposit']||0)}</div><div class="s-sub" style="color:var(--blue)">Security deposits</div></div>
        <div class="stat-card"><div class="s-label">Extra Charges</div><div class="s-value">${fmt(byType['extra']||byType['other']||0)}</div><div class="s-sub" style="color:var(--amber)">Laundry, food, etc.</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3>All Collections</h3>
          <div class="flex gap-2 items-center">
            ${monthPicker()}
            <select style="margin:0">
              <option>All Types</option>
              <option>Rent</option><option>Deposit</option><option>Extra</option>
            </select>
            <button class="btn btn-primary btn-sm" onclick="collectionModal()">+ Add Collection</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>DATE</th><th>TYPE</th><th>GUEST / FROM</th><th>DESCRIPTION</th><th>AMOUNT</th><th>MODE</th><th>ACTIONS</th></tr></thead>
            <tbody>
              ${list.length===0
                ? `<tr class="empty-row"><td colspan="7">No collections found for this filter.</td></tr>`
                : list.map(c=>`<tr>
                  <td>${fmtDate(c.collection_date)}</td>
                  <td><span class="badge badge-green" style="text-transform:capitalize">${c.collection_type}</span></td>
                  <td>${c.guest_name||'—'}</td>
                  <td>${c.description||c.collection_month||'—'}</td>
                  <td class="text-green fw-600">${fmt(c.amount)}</td>
                  <td>${c.payment_mode}</td>
                  <td><button class="btn btn-danger btn-sm btn-icon" onclick="delCollection(${c.id})">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}

async function collectionModal(guestId=null, guestName='') {
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
  try { await API.createCollection(d); closeModal(); pgCollections(); } catch(e) { showAlert(al,e.message); }
}

async function delCollection(id) {
  if(!confirm('Delete this record?')) return;
  try { await API.deleteCollection(id); pgCollections(); } catch(e) { alert(e.message); }
}

// ── REPORTS ───────────────────────────────────────
async function pgReports() {
  loading();
  const now = new Date();
  const m = now.getMonth()+1; const y = now.getFullYear();
  try {
    const r = await API.getReports(m,y);
    setContent(`
      <div class="page-header flex justify-between items-center">
        <div><h1>📋 Reports</h1><p>Monthly Profit &amp; Loss summary</p></div>
        <div class="flex items-center gap-2">
          <span style="font-size:13px;color:var(--text-muted)">Select Month</span>
          ${monthPicker()}
        </div>
      </div>
      <div class="stat-grid mb-6 mt-4">
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
      <div class="two-col">
        <div class="card">
          <div class="card-header"><h3>💵 Income Breakdown</h3></div>
          <div class="card-body">
            ${r.incomeBreakdown.length===0
              ? '<div style="text-align:center;padding:32px;color:var(--text-muted)">💵<br><br>No collections this month</div>'
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
              ? '<div style="text-align:center;padding:32px;color:var(--text-muted)">🛒<br><br>No purchases this month</div>'
              : r.expenseBreakdown.map(e=>`
              <div class="flex justify-between items-center" style="padding:10px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:14px">${e.category}</span>
                <strong class="text-red">${fmt(e.total)}</strong>
              </div>`).join('')}
          </div>
        </div>
      </div>`);
  } catch(e) { setContent(`<div class="alert alert-danger">${e.message}</div>`); }
}
