// backend/test/api.smoke.js
// Sprint 0 API gate. Runs against a REAL Postgres (rebuilt from the migration
// scripts) and a real Express server started in-process. No test framework,
// no extra dependencies — plain Node 20 fetch + assert.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5434/sirimane_test \
//   JWT_SECRET=test node backend/test/api.smoke.js
//
// Prints one line per assertion group and the total assertion count at the end.
// Exit code 1 on any failure. Never run this against the production database:
// it inserts rooms, guests, complaints and collections.
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');

let count = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); count++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

let BASE, adminTok, staffTok, guestTok;
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, ct, data };
};
const A = (m, p, b) => api(m, p, b, adminTok);
const S = (m, p, b) => api(m, p, b, staffTok);
const G = (m, p, b) => api(m, p, b, guestTok);
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const uniq = Date.now().toString().slice(-6);

async function main() {
  // Clean slate for the tables this test touches (rooms/guests/etc. from a
  // previous run would break capacity assertions).
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, purchases, guest_rent_history, deposit_refunds, guests, rooms, ai_proposals, ai_actions, day_closings, collection_variances RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM activity_log WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'smoke_%')`);
  await pool.query(`DELETE FROM users WHERE username LIKE 'smoke_%'`);

  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    // ── Server plumbing ───────────────────────────────────────────────────
    let r = await fetch(BASE + '/health'); eq(r.status, 200, 'health');
    r = await api('GET', '/does-not-exist'); eq(r.status, 404, 'unknown /api → 404'); ok(r.ct.includes('json'), 'unknown /api answers JSON, not HTML');
    r = await api('GET', '/checklist'); eq(r.status, 401, 'checklist without token → 401'); ok(r.ct.includes('json'), '401 is JSON');
    for (const p of ['/management', '/siri-mane-management']) {
      r = await fetch(BASE + p); const html = await r.text();
      ok(html.includes('id="login-page"'), `${p} serves management.html`);
    }
    r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    eq(r.status, 400, 'malformed JSON → 400'); ok((await r.json()).error, 'malformed JSON has error message');
    console.log('✓ server plumbing');

    // ── Auth ──────────────────────────────────────────────────────────────
    r = await api('POST', '/auth/login', { username: 'admin', password: 'wrong' }); eq(r.status, 401, 'bad password → 401');
    r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); eq(r.status, 200, 'admin login'); adminTok = r.data.token; ok(adminTok, 'admin token');
    r = await A('POST', '/users', { username: 'smoke_staff' + uniq, password: 'staff123', role: 'staff' }); eq(r.status, 201, 'create staff user');
    r = await api('POST', '/auth/login', { username: 'smoke_staff' + uniq, password: 'staff123' }); eq(r.status, 200, 'staff login'); staffTok = r.data.token;
    console.log('✓ auth');

    // ── Fixtures: 2 rooms, 1 guest ────────────────────────────────────────
    r = await A('POST', '/rooms', { room_number: 'S1', floor: 1, total_beds: 2, room_type: 'double', monthly_rent: 6000 }); eq(r.status, 201, 'room S1'); const room1 = r.data;
    r = await A('POST', '/rooms', { room_number: 'S2', floor: 1, total_beds: 1, room_type: 'single', monthly_rent: 6000 }); eq(r.status, 201, 'room S2'); const room2 = r.data;
    r = await A('POST', '/guests', { name: 'Smoke Guest', phone: '9' + uniq + '123', room_id: room1.id, bed_number: '1', join_date: '2026-06-01', monthly_rent: 6000, deposit_amount: 12000 });
    eq(r.status, 201, 'guest created'); const guest = r.data;
    console.log('✓ fixtures');

    // ── Daily checklist ───────────────────────────────────────────────────
    r = await S('GET', `/checklist?date=${today}`); eq(r.status, 200, 'GET checklist');
    eq(r.data.summary.total, 33, '33 seeded tasks'); eq(r.data.summary.checked, 0, 'none ticked yet'); eq(r.data.summary.percent, 0, '0%');
    ok(Array.isArray(r.data.sections) && r.data.sections.length >= 3, 'sections present');
    ok(r.data.sections.every(s => typeof s.label === 'string' && Array.isArray(s.items)), 'section shape {label,items}');
    const firstItem = r.data.sections.find(s => s.items.length)?.items[0]; ok(firstItem && firstItem.id, 'items have ids');
    ok(['is_checked', 'task', 'time_label'].every(k => k in firstItem), 'item shape');

    r = await S('PUT', `/checklist/${firstItem.id}`, { date: today, checked: true }); eq(r.status, 200, 'tick task'); eq(r.data.is_checked, true, 'log row checked');
    r = await S('GET', `/checklist?date=${today}`); eq(r.data.summary.checked, 1, 'summary counts tick'); eq(r.data.summary.percent, 3, '1/33 = 3%');
    const ticked = r.data.sections.flatMap(s => s.items).find(i => i.id === firstItem.id);
    eq(ticked.is_checked, true, 'item shows checked'); ok(ticked.checked_by_username.startsWith('smoke_staff'), 'checked_by_username = staff'); ok(ticked.checked_at, 'checked_at set');
    r = await S('PUT', `/checklist/${firstItem.id}`, { date: today, checked: true }); eq(r.status, 200, 'tick again is idempotent (no unique violation)');
    r = await S('PUT', `/checklist/${firstItem.id}`, { date: today, checked: false }); eq(r.data.is_checked, false, 'untick'); eq(r.data.checked_by, null, 'untick clears checked_by');
    r = await S('PUT', `/checklist/${firstItem.id}`, { date: '2099-01-01', checked: true }); eq(r.status, 400, 'future date rejected');
    r = await S('PUT', `/checklist/999999`, { date: today, checked: true }); eq(r.status, 404, 'unknown task → 404');
    r = await S('PUT', `/checklist/${firstItem.id}`, { date: today, checked: true }); eq(r.status, 200, 're-tick for summary');
    r = await S('GET', `/checklist/summary?month=${today.slice(0, 7)}`); eq(r.status, 200, 'summary by month');
    const todayRow = r.data.find(x => x.date === today); ok(todayRow, 'summary has today'); eq(todayRow.checked, 1, 'summary checked=1'); eq(todayRow.total, 33, 'summary total=33');
    r = await S('GET', `/checklist/summary?days=7`); eq(r.status, 200, 'summary by days'); ok(r.data.find(x => x.date === today), 'days summary has today');
    r = await S('GET', `/checklist/summary?month=not-a-month`); eq(r.status, 200, 'bad month falls back to days');
    console.log('✓ daily checklist');

    // ── Checklist items (admin manage) ────────────────────────────────────
    r = await S('POST', '/checklist-items', { section: 'Morning', task: 'x' }); eq(r.status, 403, 'staff cannot add tasks');
    r = await A('POST', '/checklist-items', { section: 'Night', time_label: '10:30 PM', task: 'Smoke: lock terrace door' }); eq(r.status, 201, 'admin adds task'); const newItem = r.data;
    eq(newItem.section, 'Night', 'section saved'); eq(newItem.time_label, '10:30 PM', 'time saved');
    r = await A('POST', '/checklist-items', { section: 'Nope', task: 'x' }); eq(r.status, 400, 'invalid section');
    r = await A('POST', '/checklist-items', { section: 'Morning', task: '  ' }); eq(r.status, 400, 'blank task');
    r = await S('GET', '/checklist-items'); eq(r.status, 200, 'staff can list items'); eq(r.data.length, 34, '34 items now');
    r = await A('PUT', `/checklist-items/${newItem.id}`, { section: 'Closing', time_label: '', task: 'Smoke: lock terrace & gate' }); eq(r.status, 200, 'edit task'); eq(r.data.section, 'Closing', 'section edited'); eq(r.data.time_label, '—', 'empty time → —');
    r = await S('GET', `/checklist?date=${today}`); ok(r.data.sections.find(s => s.label === 'Closing')?.items.some(i => i.id === newItem.id), 'edited item appears under Closing');
    r = await A('DELETE', `/checklist-items/${newItem.id}`); eq(r.status, 200, 'remove task');
    r = await A('DELETE', `/checklist-items/${newItem.id}`); eq(r.status, 404, 'remove twice → 404');
    r = await S('GET', '/checklist-items'); eq(r.data.length, 33, 'back to 33 (soft-deleted)');
    const dbItem = await pool.query('SELECT is_active FROM checklist_items WHERE id=$1', [newItem.id]); eq(dbItem.rows[0].is_active, false, 'soft delete keeps the row');
    console.log('✓ checklist items');

    // ── Complaints (staff side) ───────────────────────────────────────────
    r = await S('POST', '/complaints', { category: 'Water', description: '' }); eq(r.status, 400, 'blank description');
    r = await S('POST', '/complaints', { category: 'Water', description: 'Smoke: no hot water', guest_name: 'Smoke Guest' }); eq(r.status, 201, 'staff logs issue');
    const c1 = r.data; eq(c1.guest_id, guest.id, 'linked to guest by name'); eq(c1.room_number, 'S1', 'room filled from guest'); eq(c1.status, 'open', 'starts open'); eq(c1.raised_by, 'staff', 'raised_by staff');
    r = await S('POST', '/complaints', { category: 'Electrical', description: 'Smoke: fan noise', guest_name: 'Room S2' }); eq(r.status, 201, 'room-only issue');
    const c2 = r.data; eq(c2.room_number, 'S2', '"Room S2" parsed to room_number'); eq(c2.guest_id, null, 'no guest linked'); eq(c2.guest_name, null, 'guest_name cleared');
    r = await S('GET', '/complaints'); eq(r.status, 200, 'list all'); eq(r.data.length, 2, 'two complaints');
    r = await S('GET', '/complaints?status=open'); eq(r.data.length, 2, 'filter open');
    r = await S('PUT', `/complaints/${c1.id}`, { status: 'bogus' }); eq(r.status, 400, 'invalid status');
    r = await S('PUT', `/complaints/${c1.id}`, { status: 'in_progress' }); eq(r.status, 200, 'to in_progress'); eq(r.data.resolved_at, null, 'not resolved yet');
    r = await S('PUT', `/complaints/${c1.id}`, { status: 'resolved', resolution_notes: 'Geyser fixed' }); eq(r.data.status, 'resolved', 'resolved'); ok(r.data.resolved_at, 'resolved_at set'); eq(r.data.resolution_notes, 'Geyser fixed', 'notes saved');
    r = await S('GET', '/complaints?status=open'); eq(r.data.length, 1, 'one open left');
    r = await S('GET', '/complaints?status=resolved'); eq(r.data.length, 1, 'one resolved');
    r = await S('GET', '/complaints'); eq(r.data[0].status, 'open', 'open sorted first');
    r = await S('DELETE', `/complaints/${c1.id}`); eq(r.status, 403, 'staff cannot delete');
    r = await A('DELETE', `/complaints/${c1.id}`); eq(r.status, 200, 'admin deletes');
    r = await A('DELETE', `/complaints/${c1.id}`); eq(r.status, 404, 'delete twice → 404');
    console.log('✓ complaints');

    // ── Complaints (resident portal) ──────────────────────────────────────
    r = await api('POST', '/guest-login', { mobile: guest.phone, password: guest.phone }); eq(r.status, 200, 'guest login (default password = mobile)'); guestTok = r.data.token;
    r = await api('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'Smoke: wifi down' }); eq(r.status, 401, 'guest-complaint needs guest token');
    r = await S('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'x' }); eq(r.status, 401, 'staff token is not a guest token');
    r = await G('POST', '/guest-complaint', { category: 'Wifi/Internet', description: '' }); eq(r.status, 400, 'blank guest complaint');
    r = await G('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'Smoke: wifi down' }); eq(r.status, 201, 'guest raises issue'); eq(r.data.status, 'open', 'open');
    r = await G('GET', '/guest-complaints'); eq(r.status, 200, 'guest lists own'); eq(r.data.length, 1, 'sees exactly own issue'); eq(r.data[0].category, 'Wifi/Internet', 'category');
    r = await S('GET', '/complaints'); const gc = r.data.find(x => x.raised_by === 'guest'); ok(gc, 'staff sees guest issue'); eq(gc.guest_id, guest.id, 'linked'); eq(gc.room_number, 'S1', 'room set');
    console.log('✓ resident complaints');

    // ── Room shift ────────────────────────────────────────────────────────
    r = await S('GET', `/guests/${guest.id}/ledger`); eq(r.status, 200, 'ledger before'); const ledgerBefore = JSON.stringify(r.data);
    r = await S('GET', `/guests/${guest.id}/room-history`); eq(r.status, 200, 'history empty'); eq(r.data.length, 0, 'no moves yet');
    r = await S('POST', `/guests/${guest.id}/shift-room`, { room_id: room1.id, effective_from: today }); eq(r.status, 400, 'same room rejected');
    r = await S('POST', `/guests/${guest.id}/shift-room`, { room_id: room2.id, effective_from: '2099-01-01' }); eq(r.status, 400, 'future date rejected');
    r = await S('POST', `/guests/${guest.id}/shift-room`, { room_id: room2.id, effective_from: '2026-01-01' }); eq(r.status, 400, 'before join date rejected');
    r = await S('POST', `/guests/${guest.id}/shift-room`, { room_id: room2.id, effective_from: '' }); eq(r.status, 400, 'missing date rejected');
    r = await S('POST', `/guests/${guest.id}/shift-room`, { room_id: room2.id, bed_number: 1, effective_from: '2026-08-15', note: 'window bed' }); eq(r.status, 200, 'shift S1 → S2');
    eq(r.data.guest.room_id, room2.id, 'guest now in S2'); eq(String(r.data.guest.bed_number), '1', 'bed updated');
    eq(r.data.history.from_room_number, 'S1', 'history from'); eq(r.data.history.to_room_number, 'S2', 'history to'); eq(String(r.data.history.effective_from).slice(0, 10), '2026-08-15', 'backdated effective_from kept');
    r = await S('GET', `/guests/${guest.id}/room-history`); eq(r.data.length, 1, 'one history row'); ok(r.data[0].changed_by_username.startsWith('smoke_staff'), 'changed_by recorded');
    r = await S('GET', `/guests/${guest.id}`); eq(r.data.room_number, 'S2', 'GET guest reflects new room');
    r = await S('GET', `/guests/${guest.id}/ledger`); eq(JSON.stringify(r.data), ledgerBefore, 'MONEY: ledger identical after room shift');
    r = await A('POST', '/guests', { name: 'Smoke Guest 2', phone: '8' + uniq + '123', room_id: room1.id, bed_number: '1', join_date: '2026-07-01', monthly_rent: 6000, deposit_amount: 12000 }); const guest2 = r.data;
    r = await S('POST', `/guests/${guest2.id}/shift-room`, { room_id: room2.id, effective_from: today }); eq(r.status, 400, 'full room rejected'); ok(/full/i.test(r.data.error), 'error says full');
    r = await S('POST', `/guests/${guest2.id}/shift-room`, { room_id: 999999, effective_from: today }); eq(r.status, 404, 'unknown room → 404');
    r = await A('GET', '/rooms'); eq(Number(r.data.find(x => x.room_number === 'S2').occupied_beds), 1, 'rooms occupancy updated');
    console.log('✓ room shift');

    // ── Receipt PDF ───────────────────────────────────────────────────────
    r = await A('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 6000, collection_date: today, collection_month: 'September 2026', collection_type: 'rent', payment_mode: 'upi' });
    eq(r.status, 201, 'admin collection'); eq(r.data.status, 'confirmed', 'admin entry confirmed'); const col = r.data;
    r = await fetch(`${BASE}/api/collections/${col.id}/receipt/pdf`); eq(r.status, 401, 'receipt needs auth');
    r = await S('GET', `/collections/${col.id}/receipt/pdf`); eq(r.status, 200, 'staff can download receipt'); ok(r.ct.includes('application/pdf'), 'content-type pdf');
    const bytes = Buffer.from(r.data); ok(bytes.length > 1500, `pdf has bytes (${bytes.length})`); eq(bytes.subarray(0, 4).toString(), '%PDF', 'starts with %PDF'); ok(bytes.subarray(-64).toString().includes('%%EOF'), 'ends with %%EOF (complete file)');
    r = await S('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 500, collection_date: today, collection_type: 'rent', payment_mode: 'cash' }); const pend = r.data; eq(pend.status, 'pending_approval', 'staff entry pending');
    r = await S('GET', `/collections/${pend.id}/receipt/pdf`); eq(r.status, 400, 'no receipt for unconfirmed payment'); ok(r.ct.includes('json'), 'refusal is JSON');
    r = await S('GET', `/collections/999999/receipt/pdf`); eq(r.status, 404, 'unknown collection → 404');
    r = await A('DELETE', `/collections/${col.id}`); eq(r.status, 200, 'soft-delete collection');
    r = await S('GET', `/collections/${col.id}/receipt/pdf`); eq(r.status, 404, 'deleted collection has no receipt');
    console.log('✓ receipt pdf');

    // ── Sprint 2: resident's own receipt + portal payload ─────────────────
  r = await A('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 6000, collection_date: today, collection_month: 'September 2026', collection_type: 'rent', payment_mode: 'cash' });
  const mine = r.data;
  r = await A('POST', '/collections', { guest_id: guest2.id, guest_name: 'Smoke Guest 2', amount: 6000, collection_date: today, collection_type: 'rent', payment_mode: 'cash' });
  const hers = r.data;
  r = await api('GET', `/guest-receipt/${mine.id}/pdf`); eq(r.status, 401, 'guest receipt needs a guest token');
  r = await S('GET', `/guest-receipt/${mine.id}/pdf`); eq(r.status, 401, 'staff token is not a guest token here');
  r = await G('GET', `/guest-receipt/${mine.id}/pdf`); eq(r.status, 200, 'resident downloads her own receipt');
  ok(r.ct.includes('application/pdf'), 'guest receipt is a PDF');
  const gb = Buffer.from(r.data); eq(gb.subarray(0, 4).toString(), '%PDF', 'guest receipt starts with %PDF'); ok(gb.subarray(-64).toString().includes('%%EOF'), 'guest receipt is complete');
  r = await G('GET', `/guest-receipt/${hers.id}/pdf`); eq(r.status, 404, 'PRIVACY: cannot download another resident\'s receipt');
  r = await G('GET', `/guest-receipt/999999/pdf`); eq(r.status, 404, 'unknown receipt → 404');
  r = await G('GET', '/guest-portal'); eq(r.status, 200, 'portal payload');
  ok('pg_phone' in r.data, 'portal exposes PG phone for the WhatsApp button');
  ok('pg_name' in r.data, 'portal exposes PG name');
  eq(r.data.password_hash, undefined, 'PRIVACY: portal never returns the password hash');
  const balBefore = r.data.current_balance;
  r = await G('POST', '/guest-upi-claim', { amount: 505 }); ok(r.status === 200 || r.status === 201, 'resident can claim a UPI payment');
  r = await G('GET', '/guest-portal');
  eq(r.data.current_balance, balBefore, 'MONEY: a claim does not move her balance until confirmed');
  const claimRow = r.data.payments.find(p => parseFloat(p.amount) === 505);
  eq(claimRow.status, 'pending_verification', 'MONEY: claim stored as pending_verification');
  r = await G('GET', `/guest-receipt/${claimRow.id}/pdf`); eq(r.status, 400, 'no receipt for an unconfirmed claim');
  r = await A('GET', '/balance-sheet');
  const sheetWithClaim = JSON.stringify(r.data);
  r = await A('DELETE', `/collections/${mine.id}`); eq(r.status, 200, 'cleanup');
  ok(sheetWithClaim.length > 0, 'balance sheet still computes with a pending claim present');

  // ── Sprint 8: timeline, expected checkout, ID verification ────────────
  r = await A('PUT', `/guests/${guest.id}`, { expected_checkout: '2026-12-31', emergency_contact_name: 'Her mother' }); eq(r.status, 200, 'expected checkout saved');
  r = await A('GET', `/guests/${guest.id}`);
  eq(String(r.data.expected_checkout).slice(0, 10), '2026-12-31', 'expected_checkout persisted'); eq(r.data.emergency_contact_name, 'Her mother', 'emergency contact name persisted');
  ok(/^SM\d{4}$/.test(r.data.resident_no), `resident number assigned (${r.data.resident_no})`);
  r = await A('GET', `/guests/${guest.id}/timeline`); eq(r.status, 200, 'timeline');
  ok(r.data.items.length >= 2, `timeline has entries (${r.data.items.length})`);
  eq(r.data.items[r.data.items.length - 1].kind, 'joined', 'timeline ends at move-in');
  const dates = r.data.items.map(i => String(i.at).slice(0, 10));
  ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'timeline is newest-first');
  ok(r.data.items.some(i => i.kind === 'payment'), 'payments appear in the timeline');
  ok(r.data.items.some(i => i.kind === 'move'), 'room moves appear in the timeline');
  r = await S('GET', '/guests/999999/timeline'); eq(r.status, 404, 'timeline for an unknown resident → 404');

  r = await G('GET', '/guest-id'); eq(r.status, 200, 'resident downloads her own ID');
  ok(r.data.qr_svg.startsWith('<svg'), 'ID carries a QR'); ok(/^SM\d{4}$/.test(r.data.resident_no), 'ID shows the resident number');
  ok(!r.data.qr_svg.includes(guest.phone), 'PRIVACY: the QR does not contain her phone number');
  const idToken = r.data.qr_svg && (await api('GET', '/guest-id', null, guestTok)).data;
  r = await api('POST', '/resident-id/verify', { resident_no: idToken.resident_no }, staffTok);
  eq(r.status, 200, 'staff verify by resident number'); eq(r.data.valid, true, 'active resident verifies'); eq(r.data.resident.name, guest.name, 'verify names her');
  ok(!('phone' in r.data.resident) && !('id_proof_number' in r.data.resident), 'PRIVACY: verify returns no phone or ID number');
  r = await api('POST', '/resident-id/verify', { token: 'not-a-token' }, staffTok); eq(r.status, 400, 'garbage code refused'); eq(r.data.valid, false, 'and reported invalid');
  r = await api('POST', '/resident-id/verify', { resident_no: 'SM9999' }, staffTok); eq(r.status, 404, 'unknown resident number → 404');
  r = await api('POST', '/resident-id/verify', { resident_no: idToken.resident_no }); eq(r.status, 401, 'verify needs a staff login');

  r = await A('POST', `/guests/${guest2.id}/checkout`, { deductions: 0, refund_mode: 'cash', leave_date: '2099-01-01' }); eq(r.status, 400, 'future checkout date refused');
  r = await A('POST', `/guests/${guest2.id}/checkout`, { deductions: 500, deduction_notes: 'Broken chair', refund_mode: 'cash', leave_date: '2026-09-01' });
  eq(r.status, 201, 'backdated checkout accepted'); eq(parseFloat(r.data.refund_amount), 12000 - 500, 'MONEY: refund = deposit − deductions');
  const co = await pool.query('SELECT leave_date, is_active FROM guests WHERE id=$1', [guest2.id]);
  eq(new Date(co.rows[0].leave_date).toISOString().slice(0, 10), "2026-09-01", "leave_date is the date given, not today"); eq(co.rows[0].is_active, false, 'she is checked out');

  // ── Sprint 9: room map, request workflow, staff tasks ─────────────────
  r = await S('GET', '/room-map'); eq(r.status, 200, 'room map');
  const allTiles = r.data.floors.flatMap(f => f.rooms);
  eq(allTiles.length, 2, 'both rooms on the map');
  eq(r.data.totals.beds, 3, 'bed total matches the rooms table');
  const s1 = allTiles.find(x => x.room_number === 'S1'), s2 = allTiles.find(x => x.room_number === 'S2');
  eq(s1.beds.length, 2, 'S1 draws one dot per bed');
  eq(s2.occupied + s2.free, s2.total_beds, 'every bed is either taken or free');
  eq(allTiles.reduce((t, x) => t + x.occupied, 0), r.data.totals.occupied, 'MAP: tiles agree with the headline count');
  eq(r.data.totals.occupied + r.data.totals.free, r.data.totals.beds, 'MAP: occupied + free = total beds');
  ok(typeof r.data.totals.noRoom === 'number', 'MAP: residents without a room are reported separately, not hidden');
  // Nobody may vanish: an over-capacity room must still show its people.
  const packed = (await A('POST', '/rooms', { room_number: 'S4', floor: 3, total_beds: 2, monthly_rent: 5000 })).data;
  const packedIds = [];
  for (const b of ['1', '2', '3']) {
    const g = (await A('POST', '/guests', { name: `Packed ${b}`, phone: '7' + uniq + b + '11', room_id: packed.id, bed_number: b, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
    packedIds.push(g.id);
  }
  r = await S('GET', '/room-map');
  const packedTile = r.data.floors.flatMap(f => f.rooms).find(x => x.room_number === 'S4');
  eq(packedTile.occupied, 3, 'MAP: a 2-bed room with 3 residents reports all 3');
  eq(packedTile.over_capacity, 1, 'MAP: the third is flagged as over capacity');
  eq(packedTile.over[0].name, 'Packed 3', 'MAP: and is named, not dropped');
  eq(packedTile.free, 0, 'MAP: an over-full room offers no free bed');
  const mapped = r.data.floors.flatMap(f => f.rooms).reduce((t, x) => t + x.occupied, 0);
  eq(mapped + r.data.totals.noRoom, r.data.totals.residents, 'MAP: every active resident is accounted for (on a bed, over capacity, or roomless)');
  const headcount = (await S('GET', '/dashboard')).data.totalGuests;
  eq(r.data.totals.residents, headcount, 'MAP: the map headcount equals the dashboard headcount');
  for (const id of packedIds) await A('PUT', `/guests/${id}`, { is_active: false, leave_date: today });
  const occupiedRoom = allTiles.find(x => x.occupied > 0);
  if (occupiedRoom) {
    r = await S('PUT', `/rooms/${occupiedRoom.id}/status`, { status: 'maintenance' });
    eq(r.status, 400, 'cannot mothball a room someone lives in');
  } else {
    // Nobody is housed at this point in the run — create the situation.
    const tmp = (await A('POST', '/guests', { name: 'Room Blocker', phone: '9' + uniq + '999', room_id: room1.id, join_date: today, monthly_rent: 1000, deposit_amount: 0 })).data;
    r = await S('PUT', `/rooms/${room1.id}/status`, { status: 'maintenance' });
    eq(r.status, 400, 'cannot mothball a room someone lives in');
    await A('PUT', `/guests/${tmp.id}`, { is_active: false, leave_date: today });
  }
  r = await S('PUT', `/rooms/${room1.id}/status`, { status: 'nonsense' }); eq(r.status, 400, 'invalid room status refused');
  r = await A('POST', '/rooms', { room_number: 'S3', floor: 2, total_beds: 1, monthly_rent: 5000 }); const room3 = r.data;
  r = await S('PUT', `/rooms/${room3.id}/status`, { status: 'maintenance' }); eq(r.status, 200, 'empty room can go under maintenance');
  r = await S('GET', '/room-map');
  const t3 = r.data.floors.flatMap(f => f.rooms).find(x => x.room_number === 'S3');
  eq(t3.beds[0].state, 'maintenance', 'its beds show as maintenance, not free');
  eq(t3.free, 0, 'a room under maintenance offers no free bed');
  r = await S('PUT', `/rooms/${room3.id}/status`, { last_inspected: today }); eq(r.status, 200, 'inspection recorded');

  const rq = (await S('POST', '/complaints', { category: 'Water', description: 'SLA test leak', guest_name: 'Room S1' })).data;
  ok(rq.sla_due_at, 'a new request gets a clock');
  eq(rq.priority, 'high', 'water is high priority');
  const slaHours = (new Date(rq.sla_due_at) - new Date(rq.created_at)) / 3600000;
  ok(Math.abs(slaHours - 2) < 0.1, `high priority means 2 hours (${slaHours.toFixed(1)})`);
  r = await S('PUT', `/requests/${rq.id}`, { priority: 'low' });
  const lowHours = (new Date(r.data.sla_due_at) - new Date(rq.created_at)) / 3600000;
  ok(Math.abs(lowHours - 72) < 0.1, 'lowering priority recomputes the clock from when it was raised, not from now');
  r = await S('PUT', `/requests/${rq.id}`, { assigned_to: 999999 }); eq(r.status, 400, 'cannot assign to a non-existent user');
  const staffId = (await A('GET', '/users')).data.find(u => u.username.startsWith('smoke_staff')).id;
  r = await S('PUT', `/requests/${rq.id}`, { assigned_to: staffId });
  eq(r.data.assigned_to, staffId, 'assigned'); eq(r.data.status, 'assigned', 'assigning an open request moves it to "assigned"');
  r = await S('GET', '/requests?assigned_to=me'); eq(r.data.length, 1, 'staff sees it in their own queue');
  r = await A('GET', '/requests?assigned_to=me'); eq(r.data.length, 0, 'admin does not');
  await pool.query(`UPDATE complaints SET sla_due_at = NOW() - INTERVAL '3 hours' WHERE id=$1`, [rq.id]);
  r = await S('GET', '/requests?overdue=1'); eq(r.data.length, 1, 'overdue filter'); eq(r.data[0].overdue, true, 'flagged overdue'); ok(r.data[0].hours_left < 0, 'hours_left goes negative');
  r = await S('POST', `/requests/${rq.id}/comments`, { body: 'Plumber called' }); eq(r.status, 201, 'comment added');
  r = await S('POST', `/requests/${rq.id}/comments`, { body: '   ' }); eq(r.status, 400, 'empty comment refused');
  const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70]).toString('base64');
  r = await S('POST', `/requests/${rq.id}/photos`, { image: tinyJpeg }); eq(r.status, 201, 'photo stored'); ok(r.data.bytes > 0, 'byte count recorded');
  const photoId = r.data.id;
  r = await S('POST', `/requests/${rq.id}/photos`, { image: 'data:image/jpeg;base64,' + 'A'.repeat(400 * 1024) }); eq(r.status, 400, 'oversized photo refused');
  r = await S('POST', `/requests/${rq.id}/photos`, { image: 'data:text/plain;base64,QUJD' }); eq(r.status, 400, 'non-image refused');
  const pr = await fetch(`${BASE}/api/requests/${rq.id}/photos/${photoId}`, { headers: { Authorization: 'Bearer ' + staffTok } });
  eq(pr.status, 200, 'photo served'); ok((pr.headers.get('content-type') || '').startsWith('image/'), 'served as an image');
  const anon = await fetch(`${BASE}/api/requests/${rq.id}/photos/${photoId}`);
  eq(anon.status, 401, 'PRIVACY: a request photo needs a login');
  r = await S('DELETE', `/requests/${rq.id}/photos/${photoId}`); eq(r.status, 403, 'staff cannot delete a photo');
  r = await A('DELETE', `/requests/${rq.id}/photos/${photoId}`); eq(r.status, 200, 'admin can');
  r = await S('GET', `/requests/${rq.id}`); eq(r.data.photos.length, 0, 'photo gone'); eq(r.data.comments.length, 1, 'comment still there');
  r = await S('GET', '/my-tasks'); eq(r.status, 200, 'my tasks');
  ok(r.data.checklist.total >= 33, 'checklist included'); eq(r.data.requests.length, 1, 'my request included'); eq(r.data.overdue, 1, 'overdue counted');
  const taskToAssign = (await S('GET', '/checklist-items')).data[0];
  r = await S('PUT', `/checklist-items/${taskToAssign.id}/assign`, { assigned_to: staffId }); eq(r.status, 403, 'staff cannot reassign tasks');
  r = await A('PUT', `/checklist-items/${taskToAssign.id}/assign`, { assigned_to: staffId, due_time: '07:30' }); eq(r.status, 200, 'admin assigns a task');
  r = await S('GET', '/my-tasks'); eq(r.data.checklist.mine, 1, 'the assigned task is mine');
  const adminTasks = (await A('GET', '/my-tasks')).data;
  ok(!adminTasks.checklist.items.some(i => i.id === taskToAssign.id), "a task assigned to someone else is not on the admin's list");
  r = await S('PUT', `/requests/${rq.id}`, { status: 'closed', note: 'Washer replaced' });
  eq(r.data.status, 'closed', 'closed'); ok(r.data.closed_at, 'closed_at stamped'); ok(r.data.resolved_at, 'resolved_at stamped');
  r = await S('GET', '/requests?overdue=1'); eq(r.data.length, 0, 'a closed request is no longer overdue');

  // ── Dashboard still works with the new tables ─────────────────────────
    r = await S('GET', '/dashboard'); eq(r.status, 200, 'dashboard'); eq(r.data.todayChecklist.total, 33, 'dashboard checklist total'); eq(r.data.todayChecklist.checked, 1, 'dashboard checklist checked'); eq(r.data.openComplaints, (await S('GET', "/requests?status=open")).data.length, 'dashboard open-request count equals the requests list');
    console.log('✓ dashboard');

    // ── Login rate limit (last: it burns attempts for this IP) ────────────
    let last;
    // Two failed attempts already happened (malformed JSON + bad password), so 8 more = 10 failures.
    for (let i = 0; i < 8; i++) last = await api('POST', '/auth/login', { username: 'admin', password: 'nope' + i });
    eq(last.status, 401, '10th bad attempt still 401');
    last = await api('POST', '/auth/login', { username: 'admin', password: 'nope' }); eq(last.status, 429, '11th attempt → 429'); ok(last.ct.includes('json') && /wait/i.test(last.data.error), '429 is JSON with message');
    console.log('✓ login rate limit');

    console.log(`\n✅ API gate passed — ${count} assertions`);
  } finally {
    server.close();
    await pool.end();
  }
}

main().catch(e => { console.error(`\n❌ FAILED after ${count} assertions:\n`, e.message); process.exit(1); });
