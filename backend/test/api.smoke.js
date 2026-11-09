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
    // S16-2: that login must set a new password before anything else
    eq(r.data.must_change_password, true, 'S16-2 default-password login is told to set a new password');
    eq((await api('GET', '/guest-portal', null, guestTok)).status, 403, 'S16-2 SECURITY: the default-password token cannot read the portal');
    eq((await api('POST', '/guest-complaint', { category: 'Other', description: 'x' }, guestTok)).status, 403, 'S16-2 SECURITY: …nor write anything');
    eq((await api('POST', '/guest-change-password', { currentPassword: guest.phone, newPassword: '+91 ' + guest.phone }, guestTok)).status, 400, 'S16-2 her phone number (in any form) is refused as the new password');
    r = await api('POST', '/guest-change-password', { currentPassword: '+91 ' + guest.phone, newPassword: 'Resident@2026' }, guestTok);
    eq(r.status, 200, 'S16-2 she sets her own password (current typed as "+91 …" is accepted)'); guestTok = r.data.token;
    eq((await api('GET', '/guest-portal', null, guestTok)).status, 200, 'S16-2 the new token works');
    r = await api('POST', '/guest-login', { mobile: guest.phone, password: 'Resident@2026' });
    eq(r.data.must_change_password, false, 'S16-2 logging in with her own password is not asked again');
    eq((await api('POST', '/guest-login', { mobile: guest.phone, password: guest.phone })).status, 401, 'S16-2 SECURITY: the default no longer works');
    r = await api('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'Smoke: wifi down' }); eq(r.status, 401, 'guest-complaint needs guest token');
    r = await S('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'x' }); eq(r.status, 401, 'staff token is not a guest token');
    r = await G('POST', '/guest-complaint', { category: 'Wifi/Internet', description: '' }); eq(r.status, 400, 'blank guest complaint');
    // S15-7: a token names the environment that issued it; another environment's token is refused.
    {
      const jwt = require('jsonwebtoken');
      const payload = JSON.parse(Buffer.from(guestTok.split('.')[1], 'base64url').toString());
      ok(payload.env, 'S15-7 tokens carry the issuing environment');
      const foreign = jwt.sign({ guestId: payload.guestId, type: 'guest', env: 'some-other-environment' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      r = await api('GET', '/guest-portal', null, foreign); eq(r.status, 401, 'S15-7 SECURITY: a token from another environment is refused');
      const cut = require('../middleware/auth').LEGACY_CUTOFF;
      const legacy = jwt.sign({ guestId: payload.guestId, type: 'guest', iat: cut - 3600, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET);
      r = await api('GET', '/guest-portal', null, legacy); eq(r.status, 200, 'S15-7 a token issued before the cut-off (no env) still works until it expires');
      // iat must be AFTER boot but already in the PAST, so a cut-off computed
      // per request (now) would wrongly accept it — only a boot-time cut-off refuses. (Review N-6d)
      while (Date.now() / 1000 < cut + 3) await new Promise(res => setTimeout(res, 200));
      const lateLegacy = jwt.sign({ guestId: payload.guestId, type: 'guest', iat: cut + 1, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET);
      ok(lateLegacy && (cut + 1) < Date.now() / 1000, 'S15-7 the late legacy token is dated after boot and before now');
      r = await api('GET', '/guest-portal', null, lateLegacy); eq(r.status, 401, 'S15-7 SECURITY (review F-03): a token with no env issued AFTER the cut-off is refused');
      for (const badIat of [null, '', true, [], '1']) {
        // jsonwebtoken refuses to SIGN a non-numeric iat, so build the token by hand
        const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
        const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ guestId: payload.guestId, type: 'guest', iat: badIat, exp: Math.floor(Date.now() / 1000) + 3600 });
        const odd = body + '.' + require('crypto').createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
        r = await api('GET', '/guest-portal', null, odd); eq(r.status, 401, `S15-7 SECURITY (review N-2): an env-less token with iat=${JSON.stringify(badIat)} is refused`);
      }
      ok(require('../middleware/auth').ENV_ID.includes('#'), 'S15-7 (review F-04) the environment id includes the database identity');
      const adminPayload = JSON.parse(Buffer.from(adminTok.split('.')[1], 'base64url').toString());
      const foreignAdmin = jwt.sign({ userId: adminPayload.userId, env: 'some-other-environment' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      r = await api('GET', '/rooms', null, foreignAdmin); eq(r.status, 401, 'S15-7 SECURITY: another environment\'s ADMIN token is refused');
    }
    r = await G('POST', '/guest-complaint', { category: 'Wifi/Internet', description: 'Smoke: wifi down' }); eq(r.status, 201, 'guest raises issue'); eq(r.data.status, 'open', 'open');
    r = await G('GET', '/guest-complaints'); eq(r.status, 200, 'guest lists own'); eq(r.data.length, 1, 'sees exactly own issue'); eq(r.data[0].category, 'Wifi/Internet', 'category');
    r = await S('GET', '/complaints'); const gc = r.data.find(x => x.raised_by === 'guest'); ok(gc, 'staff sees guest issue'); eq(gc.guest_id, guest.id, 'linked'); eq(gc.room_number, 'S1', 'room set');
        { // Sprint 15.1 (D-15-5): POST /guests deposit auto-log — both paths
      const s151Rooms = (await A('GET', '/rooms')).data;
      const s151Room = s151Rooms[0];
      const s151Count = async id => (await A('GET', '/collections')).data.filter(c => c.guest_id === id && c.collection_type === 'deposit');
      let s151 = await A('POST', '/guests', { name: 'S151 Old Form', phone: '9' + String(Date.now()).slice(-9), join_date: today, room_id: s151Room && s151Room.id, monthly_rent: 5000, deposit_amount: 9000 });
      eq(s151.status, 201, 'S15.1-2 old Add form still creates the resident');
      let s151Deps = await s151Count(s151.data.id);
      eq(s151Deps.length, 1, 'S15.1-2 MONEY: old Add form → exactly one automatic deposit record');
      eq(Number(s151Deps[0].amount), 9000, 'S15.1-2 the automatic deposit is the agreed amount');
      s151 = await A('POST', '/guests', { name: 'S151 Wizard', phone: '8' + String(Date.now()).slice(-9), join_date: today, room_id: s151Room && s151Room.id, monthly_rent: 5000, deposit_amount: 9000, deposit_recorded_by_client: true });
      eq(s151.status, 201, 'S15.1-1 wizard-style add creates the resident');
      eq((await s151Count(s151.data.id)).length, 0, 'S15.1-1 MONEY: with deposit_recorded_by_client the server records NO deposit itself');
      s151 = await A('POST', '/guests', { name: 'S151 Truthy', phone: '7' + String(Date.now()).slice(-9), join_date: today, room_id: s151Room && s151Room.id, monthly_rent: 5000, deposit_amount: 9000, deposit_recorded_by_client: 'yes' });
      eq((await s151Count(s151.data.id)).length, 1, 'S15.1-1 only a real true skips the record (a string does not)');
      // S15.2-2 deposit-status: confirmed only counts as received
      const s152Old = (await A('GET', '/guests')).data.find(x => x.name === 'S151 Old Form');
      let s152Dep = await A('GET', `/guests/${s152Old.id}/deposit-status`);
      eq(s152Dep.status, 200, 'S15.2-2 deposit-status answers');
      eq(s152Dep.data.agreed, 9000, 'S15.2-2 agreed deposit'); eq(s152Dep.data.received, 9000, 'S15.2-2 received = the confirmed deposit row');
      const s152Wiz = (await A('GET', '/guests')).data.find(x => x.name === 'S151 Wizard');
      await S('POST', '/collections', { guest_id: s152Wiz.id, guest_name: 'S151 Wizard', amount: 3000, collection_type: 'deposit', payment_mode: 'cash', collection_date: today });
      s152Dep = await A('GET', `/guests/${s152Wiz.id}/deposit-status`);
      eq(s152Dep.data.received, 0, 'S15.2-2 MONEY: a staff (pending_approval) deposit is NOT counted as received');
      eq(s152Dep.data.pending, 3000, 'S15.2-2 it is shown as pending instead');
      eq((await A('GET', '/guests/abc/deposit-status')).status, 400, 'S15.2-2 bad id → 400');
      eq((await G('GET', `/guests/${s152Wiz.id}/deposit-status`)).status, 401, 'S15.2-2 SECURITY: a resident token cannot read it');
      // S15.4-1 (T-1): phones stored as digits only
      const s154Num = '9' + String(Date.now()).slice(-9);
      const s154 = await A('POST', '/guests', { name: 'S154 Spaced', phone: s154Num.slice(0, 5) + ' ' + s154Num.slice(5, 8) + '-' + s154Num.slice(8), join_date: today, monthly_rent: 5000, deposit_amount: 0 });
      eq(s154.data.phone, s154Num, 'S15.4-1 POST /guests stores the phone digits only');
      const s154Login = await api('POST', '/guest-login', { mobile: s154Num, password: s154Num });
      eq(s154Login.status, 200, 'S15.4-1 she can log in with the plain 10 digits');
      const s154Put = await A('PUT', `/guests/${s154.data.id}`, { ...s154.data, phone: '+91 ' + s154Num });
      ok(s154Put.status < 300 && (await A('GET', '/guests')).data.find(x => x.id === s154.data.id).phone === s154Num, 'S15.4-1 PUT /guests strips spaces, symbols and the +91 prefix');
      const s154Zero = await A('POST', '/guests', { name: 'S154 Zero', phone: '0' + s154Num.replace(/^9/, '8'), join_date: today, monthly_rent: 5000, deposit_amount: 0 });
      eq(s154Zero.data.phone, s154Num.replace(/^9/, '8'), 'S15.4-1 a leading 0 is dropped');
      await A('DELETE', `/guests/${s154Zero.data.id}`);
      await A('DELETE', `/guests/${s154.data.id}`);
      // S15.5-1/2 (P-1): resident login with her number in any common form
      {
        const n10 = '7' + String(Date.now()).slice(-9);
        const g155 = await A('POST', '/guests', { name: 'S155 Login', phone: n10, join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        // Own client address (trust proxy = 1) so these deliberate failures don't
        // consume the limiter budget the rate-limit test below counts on.
        const L = async (m, p) => { const r = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.15.5.1' }, body: JSON.stringify({ mobile: m, password: p }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
        eq((await L('+91 ' + n10.slice(0, 5) + ' ' + n10.slice(5), '+91' + n10)).status, 200, 'S15.5-1 "+91 xxxxx xxxxx" logs in; default password typed with +91 (first login)');
        eq((await L(n10, n10)).status, 200, 'S15.5-2 after that first login, the plain 10 digits still work (hash is of the digits)');
        eq((await L('0' + n10, '+91 ' + n10)).status, 200, 'S15.5-2 "0…" mobile + "+91 …" password both accepted');
        eq((await L(n10, '1234567')).status, 401, 'S15.5 SECURITY: a wrong password is still refused');
        eq((await L('12345', '12345')).status, 401, 'S15.5 SECURITY: a short number matches nobody');
        // A resident saved WITH spaces before 15.4 (written directly, as old data is)
        const old10 = '6' + String(Date.now()).slice(-9);
        const gOld = await A('POST', '/guests', { name: 'S155 Old Spaced', phone: old10, join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        await pool.query('UPDATE guests SET phone=$1 WHERE id=$2', [old10.slice(0, 5) + ' ' + old10.slice(5), gOld.data.id]);
        eq((await L(old10, old10)).status, 200, 'S15.5-1 a phone stored with spaces before 15.4 logs in with the plain digits — no backfill needed');
        await A('DELETE', `/guests/${g155.data.id}`); await A('DELETE', `/guests/${gOld.data.id}`);
        // A-1: two sisters share a number — one saved "+91 …" (old data), one plain
        const sis = '8' + String(Date.now()).slice(-9);
        const sA = await A('POST', '/guests', { name: 'S155 Sister A', phone: sis, join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        // S16-1 now refuses a second active resident on one number, so the pair is made the way OLD data has it
        eq((await A('POST', '/guests', { name: 'S155 Sister B', phone: sis, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).status, 409, 'S16-1 a second active resident on the same number is refused');
        const sB = await A('POST', '/guests', { name: 'S155 Sister B', phone: '6' + sis.slice(1), join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        await pool.query('UPDATE guests SET phone=$1 WHERE id=$2', [sis, sB.data.id]);
        await pool.query('UPDATE guests SET phone=$1 WHERE id=$2', ['+91 ' + sis, sA.data.id]);
        // (i) both still on the default password: the exact saved text decides, as before 15.5
        let rr = await L('+91 ' + sis, '+91 ' + sis); eq(rr.status, 200, 'A-1 sister A (saved "+91 …") logs in typing "+91 …"'); eq(rr.data.guest && rr.data.guest.id, sA.data.id, 'A-1 …as sister A');
        rr = await L(sis, sis); eq(rr.status, 200, 'A-1 sister B (saved plain) logs in typing the plain number'); eq(rr.data.guest && rr.data.guest.id, sB.data.id, 'A-1 …as sister B, never A');
        // (ii) each now has her own password (hashes were set by those first logins); custom passwords
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [await require('bcrypt').hash('alpha-123', 6), sA.data.id]);
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [await require('bcrypt').hash('beta-456', 6), sB.data.id]);
        rr = await L(sis, 'beta-456'); eq(rr.data.guest && rr.data.guest.id, sB.data.id, 'A-1 SECURITY: B logs in with her own password, as B');
        rr = await L(sis, 'alpha-123'); eq(rr.data.guest && rr.data.guest.id, sA.data.id, 'A-1 SECURITY: A logs in with her own password even typing the plain number, as A');
        // (iii) same saved text and same password: nobody is logged in as the wrong person
        await pool.query('UPDATE guests SET phone=$1, password_hash=NULL WHERE id IN ($2,$3)', [sis, sA.data.id, sB.data.id]);
        rr = await L(sis, sis); eq(rr.status, 409, 'A-1 SECURITY: identical number and password → refused, not a random sister');
        ok(/warden/.test(rr.data.error || ''), 'A-1 the message tells her what to do');
        await A('DELETE', `/guests/${sA.data.id}`); await A('DELETE', `/guests/${sB.data.id}`);
      }
      // ── Sprint 16 ─────────────────────────────────────────────
      {
        // S16-1 one active resident per number
        const n16 = '7' + String(Date.now()).slice(-9);
        const room16 = (await A('GET', '/rooms')).data[0];
        const a16 = await A('POST', '/guests', { name: 'S16 Owner', phone: n16, room_id: room16 && room16.id, join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        let r16 = await A('POST', '/guests', { name: 'S16 Copy', phone: n16.slice(0, 5) + ' ' + n16.slice(5), join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        eq(r16.status, 409, 'S16-1 the same number typed with a space is refused');
        ok(/S16 Owner/.test(r16.data.error || ''), 'S16-1 the message names who has it');
        r16 = await A('GET', `/guests/phone-check?phone=${encodeURIComponent('+91 ' + n16)}`);
        ok(r16.data.taken === true && r16.data.by.id === a16.data.id, 'S16-1 phone-check finds the owner for "+91 …"');
        eq((await A('GET', `/guests/phone-check?phone=${n16}&except=${a16.data.id}`)).data.taken, false, 'S16-1 phone-check ignores the resident being edited');
        const b16 = await A('POST', '/guests', { name: 'S16 Other', phone: '6' + n16.slice(1), join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        eq((await A('PUT', `/guests/${b16.data.id}`, { ...b16.data, phone: n16 })).status, 409, 'S16-1 editing a number INTO a taken one is refused');
        // An existing pair (old data) can still have its other details edited
        await pool.query('UPDATE guests SET phone=$1 WHERE id=$2', [n16, b16.data.id]);
        eq((await A('PUT', `/guests/${b16.data.id}`, { ...b16.data, phone: n16, monthly_rent: 5500 })).status, 200, 'S16-1 an existing shared pair can still be edited (number unchanged)');
        // A checked-out resident's number can be reused
        await pool.query('UPDATE guests SET is_active=false WHERE id IN ($1,$2)', [a16.data.id, b16.data.id]);
        r16 = await A('POST', '/guests', { name: 'S16 New Owner', phone: n16, join_date: today, monthly_rent: 5000, deposit_amount: 0 });
        eq(r16.status, 201, "S16-1 a checked-out resident's number can be given to a new resident");
        const newOwnerId = r16.data.id;
        eq((await A('PUT', `/guests/${a16.data.id}`, { ...a16.data, is_active: true })).status, 409, 'S16-1 re-activating someone onto a number now in use is refused');
        eq((await A('PUT', `/guests/${a16.data.id}`, { ...a16.data, is_active: 'true' })).status, 409, 'S16-1 (review F16-2) …also when is_active is sent as the text "true"');
        for (const id of [a16.data.id, b16.data.id, newOwnerId]) await A('DELETE', `/guests/${id}`);

        // S16-2 (review F16-1): the default can't be bypassed by spelling
        {
          const nb = '6' + String(Date.now()).slice(-9);
          const gb = (await A('POST', '/guests', { name: 'S16 Bypass', phone: nb, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
          const XL = async (m, p) => { const r = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.16.2.9' }, body: JSON.stringify({ mobile: m, password: p }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
          eq((await XL(nb + 'x', nb + 'x')).status, 401, 'S16-2 F16-1 SECURITY: "98…x" as mobile AND password does not get in');
          const dotted = nb.slice(0, 5) + '.' + nb.slice(5);
          eq((await XL(dotted, dotted)).status, 401, 'S16-2 F16-1 SECURITY: "98…" with a dot as mobile AND password does not get in');
          let rb = await XL(nb, '+91 ' + nb);
          ok(rb.status === 200 && rb.data.must_change_password === true, 'S16-2 the real default still works — and is restricted');
          // A hash that IS her number (set before S16) is still "the default"
          await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [await require('bcrypt').hash(nb, 6), gb.id]);
          rb = await XL(nb, nb);
          ok(rb.status === 200 && rb.data.must_change_password === true, 'S16-2 F16-1 a stored password that is her own number still forces the change');
          // F16-1b: before 15.5 the first login hashed the number EXACTLY as typed
          for (const fmt of [x => '+91 ' + x, x => x.slice(0, 5) + ' ' + x.slice(5), x => '91' + x, x => '0' + x,
                             x => x.slice(0, 5) + '.' + x.slice(5), x => '+91.' + x, x => x + '/', x => x + ' (s)']) {   // F16-1c
            const typed = fmt(nb);
            await pool.query('UPDATE guests SET phone=$1, password_hash=$2 WHERE id=$3', [typed.length <= 15 ? typed : nb, await require('bcrypt').hash(typed, 6), gb.id]);
            const rf = await XL(nb, typed);
            ok(rf.status === 200 && rf.data.must_change_password === true, `S16-2 F16-1b SECURITY: an old hash of "${typed}" still forces the change`);
          }
          // …and her number with a symbol added is not accepted as a NEW password
          await pool.query('UPDATE guests SET phone=$1, password_hash=NULL WHERE id=$2', [nb, gb.id]);
          const rt = await XL(nb, nb);
          eq((await api('POST', '/guest-change-password', { currentPassword: nb, newPassword: nb + '.' }, rt.data.token)).status, 400, 'S16-2 her number plus a dot is refused as the new password');
          eq((await api('POST', '/guest-change-password', { currentPassword: nb, newPassword: 'pg-' + nb }, rt.data.token)).status, 400, 'S16-2 …and with a prefix');
          await A('DELETE', `/guests/${gb.id}`);
        }
        // S16-3 separate limiters: 10 wrong resident logins don't block staff from the same address
        const XF = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.16.3.1' };
        const tryLogin = async (path, body) => (await fetch(BASE + '/api' + path, { method: 'POST', headers: XF, body: JSON.stringify(body) })).status;
        for (let i = 0; i < 10; i++) await tryLogin('/guest-login', { mobile: '9999999999', password: 'wrong' + i });
        eq(await tryLogin('/guest-login', { mobile: '9999999999', password: 'wrong-again' }), 429, 'S16-3 the 11th wrong resident login is blocked');
        eq(await tryLogin('/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }), 200, 'S16-3 SECURITY/OPS: the warden can still log in from the same address');

        // S16.2: per-ACCOUNT limit — a forged address on every try does not help
        {
          const forged = (i) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.' + i });
          const gl = async (i, m, p) => (await fetch(BASE + '/api/guest-login', { method: 'POST', headers: forged(i), body: JSON.stringify({ mobile: m, password: p }) })).status;
          const victim = '8' + String(Date.now()).slice(-9);
          const gv = (await A('POST', '/guests', { name: 'S162 Target', phone: victim, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
          for (let i = 1; i <= 10; i++) await gl(i, victim, 'guess' + i);
          eq(await gl(11, victim, 'guess-11'), 429, 'S16.2-1 SECURITY: the 11th wrong password for one number is blocked even from a NEW forged address');
          eq(await gl(12, '+91 ' + victim, 'guess-12'), 429, 'S16.2-1 …and typing the same number as "+91 …" does not reset it');
          const other = '7' + String(Date.now()).slice(-9);
          ok((await gl(13, other, other)) !== 429, 'S16.2-2 another resident is not affected');
          // staff: 20 per username
          const su = (await A('POST', '/users', { username: 's162staff', password: 'Right-Pass-1', role: 'staff' })).data;
          const sl = async (i, u, p) => (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: forged(100 + i), body: JSON.stringify({ username: u, password: p }) })).status;
          for (let i = 1; i <= 20; i++) await sl(i, 's162staff', 'nope' + i);
          eq(await sl(21, 'S162STAFF ', 'nope-21'), 429, 'S16.2-1 SECURITY: the 21st wrong staff password is blocked (username case/space does not reset it)');
          eq(await sl(22, 'admin', process.env.ADMIN_PASSWORD || 'SiriMane@2024'), 200, 'S16.2-2 the admin is not affected by another username\'s limit');
          // S16.3-4: each pause is on the bell, once, with only the last 4 digits of her number
          const bell = (await pool.query(`SELECT title, for_role FROM notifications WHERE dedupe_key LIKE 'lockout:%' ORDER BY id`)).rows;
          const resB = bell.filter(b => b.title.includes('ending ' + victim.slice(-4)));
          ok(resB.length === 1 && resB[0].for_role === 'staff', `S16.3-4 the warden is told once that a resident login was paused (${resB.length})`);
          ok(!bell.some(b => b.title.includes(victim)), 'S16.3-4 PRIVACY: the full phone number is not on the bell');
          ok(bell.some(b => b.title.includes('s162staff') && b.for_role === 'admin'), 'S16.3-4 the admin is told a staff login was paused');
          // S16.4-2: 21 tries at a username that does NOT exist → paused, but nothing on the bell
          const ghost = 'ghost<b>' + 'x'.repeat(60);
          for (let i = 1; i <= 21; i++) await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.' + (100 + i) }, body: JSON.stringify({ username: ghost, password: 'nope' + i }) });
          await new Promise(r => setTimeout(r, 300));
          ok(!(await pool.query(`SELECT 1 FROM notifications WHERE title LIKE '%ghost%'`)).rows.length, 'S16.4-2 SECURITY: a made-up username never reaches the admin\'s bell');
          await A('DELETE', `/users/${su.id}`); await A('DELETE', `/guests/${gv.id}`);
        }
        // S16-4 bcrypt 6 accepts passwords hashed by bcrypt 5 — through the real login routes.
        // These two hashes were made by bcrypt 5.1.1 before the upgrade.
        const BCRYPT5_STAFF = '$2b$06$8tWaK3Ny61dHhJxfVmV9peQm1mYVFa2foFUHMAj8y8lKFylYgTXqe';      // 'alpha-123'
        const BCRYPT5_RESIDENT = '$2b$10$BlyBX.pewoDxSEJREM3JQuUKaduGnBnyDzdfTuXHr1l2aq4nx5nUy';     // 'päss wörd ₹'
        eq(require('bcrypt/package.json').version.split('.')[0], '6', 'S16-4 bcrypt 6 is installed');
        const u16 = (await A('POST', '/users', { username: 's16old', password: 'temporary-1', role: 'staff' })).data;
        await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [BCRYPT5_STAFF, u16.id]);
        eq((await api('POST', '/auth/login', { username: 's16old', password: 'alpha-123' })).status, 200, 'S16-4 a staff password hashed by bcrypt 5 still logs in');
        const g16 = (await A('POST', '/guests', { name: 'S16 Old Hash', phone: '8' + String(Date.now()).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [BCRYPT5_RESIDENT, g16.id]);
        r16 = await api('POST', '/guest-login', { mobile: g16.phone, password: 'päss wörd ₹' });
        ok(r16.status === 200 && r16.data.must_change_password === false, 'S16-4 a resident password hashed by bcrypt 5 still logs in (non-ASCII too)');
        await A('DELETE', `/users/${u16.id}`); await A('DELETE', `/guests/${g16.id}`);
      }
      // ── Sprint 19: the login lives in an HttpOnly cookie (D-17-1)
      {
        const XF19 = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.191' };
        const cookieOf = (res, name) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']).find(c => c.startsWith(name + '=')) || '';
        let r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: XF19, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) });
        const sc = cookieOf(r, 'sm_staff');
        ok(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Path=\/api/i.test(sc) && /Max-Age=28800/i.test(sc), `S19-1 SECURITY: staff login sets an HttpOnly, SameSite=Strict cookie for /api, 8 h (${sc.replace(/=[^;]+/, '=…').slice(0, 110)})`);
        const C = { Cookie: sc.split(';')[0] };
        eq((await fetch(BASE + '/api/auth/me', { headers: C })).status, 200, 'S19-4 the cookie alone logs her in for reads');
        eq((await fetch(BASE + '/api/auth/change-password', { method: 'POST', headers: { ...C, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }) })).status, 403, 'S19-3 SECURITY: a cookie write without the app header is refused (cross-site forgery)');
        ok((await fetch(BASE + '/api/auth/change-password', { method: 'POST', headers: { ...C, 'Content-Type': 'application/json', 'X-Requested-With': 'sirimane' }, body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }) })).status !== 403, 'S19-3 …with the app header it reaches the route');
        eq((await api('POST', '/auth/change-password', { currentPassword: 'x', newPassword: 'y' })).status !== 403, true, 'S19-4 a Bearer header (API clients, internal calls) needs no app header');
        r = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { ...C, 'X-Requested-With': 'sirimane' } });
        ok(/sm_staff=;/.test(cookieOf(r, 'sm_staff')) && /Expires=Thu, 01 Jan 1970/i.test(cookieOf(r, 'sm_staff')) && /Path=\/api/i.test(cookieOf(r, 'sm_staff')), 'S19-2 logout clears the staff cookie (same path, so the browser really drops it)');
        // Review S19-2: the app's own screens never get the token in the body
        r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { ...XF19, 'X-Requested-With': 'sirimane' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) });
        const rb = await r.json();
        ok(r.status === 200 && !('token' in rb) && rb.user && /HttpOnly/i.test(cookieOf(r, 'sm_staff')), 'S19-1 SECURITY: a login from the app screen gets the cookie, never the token in the body');
        // Other websites still cannot make logged-in requests (CORS gives no credentials)
        r = await fetch(BASE + '/api/auth/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-requested-with' } });
        ok(!r.headers.get('access-control-allow-credentials') && !/x-requested-with/i.test(r.headers.get('access-control-allow-headers') || ''), 'S19-3 SECURITY: CORS lets no other site send credentials or the app header');
        // Resident: remembered → kept for the token's life; not remembered → ends with the browser
        const g19 = (await A('POST', '/guests', { name: 'S19 Cookie', phone: '7' + String(Date.now()).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [await require('bcrypt').hash('Her-Own-19', 6), g19.id]);
        r = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: XF19, body: JSON.stringify({ mobile: g19.phone, password: 'Her-Own-19', remember: true }) });
        const gc = cookieOf(r, 'sm_guest');
        ok(/HttpOnly/i.test(gc) && /SameSite=Strict/i.test(gc) && /Max-Age=86400/i.test(gc), 'S19-2 "keep me signed in": an HttpOnly cookie kept for 24 h');
        r = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: XF19, body: JSON.stringify({ mobile: g19.phone, password: 'Her-Own-19' }) });
        const gs = cookieOf(r, 'sm_guest');
        ok(/HttpOnly/i.test(gs) && !/Max-Age|Expires/i.test(gs), 'S19-2 not remembered: the cookie ends when the browser closes');
        const GC = { Cookie: gs.split(';')[0] };
        eq((await fetch(BASE + '/api/guest-portal', { headers: GC })).status, 200, 'S19-4 her cookie opens the portal');
        eq((await fetch(BASE + '/api/guest-complaint', { method: 'POST', headers: { ...GC, 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'Other', description: 'forged' }) })).status, 403, 'S19-3 SECURITY: a resident cookie write without the app header is refused');
        eq((await fetch(BASE + '/api/guest-portal', { headers: { Cookie: sc.split(';')[0] } })).status, 401, 'S19-1 SECURITY: the staff cookie is not a resident login');
        eq((await fetch(BASE + '/api/auth/me', { headers: GC })).status, 401, 'S19-1 SECURITY: her cookie is not a staff login');
        r = await fetch(BASE + '/api/guest-logout', { method: 'POST', headers: { ...GC, 'X-Requested-With': 'sirimane' } });
        ok(/sm_guest=;/.test(cookieOf(r, 'sm_guest')) && /Path=\/api/i.test(cookieOf(r, 'sm_guest')), 'S19-2 logout clears her cookie (same path)');
        r = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: { ...XF19, 'X-Requested-With': 'sirimane' }, body: JSON.stringify({ mobile: g19.phone, password: 'Her-Own-19' }) });
        ok(r.status === 200 && !('token' in (await r.json())), 'S19-1 SECURITY: her login from the app screen never puts the token in the body');
        await A('DELETE', `/guests/${g19.id}`);
      }
      // ── Sprint 19 (review): staff never receive a resident's password hash
      {
        const gh = (await A('POST', '/guests', { name: 'S19 Hash', phone: '6' + String(Date.now() + 7).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 0, id_proof_type: 'Aadhaar', id_proof_number: '5555-6666-7777' })).data;
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', ['$2b$06$hashhashhashhashhashha', gh.id]);
        const noHash = x => !JSON.stringify(x).includes('password_hash') && !JSON.stringify(x).includes('$2b$06$hashhash');
        for (const [who, call] of [['staff', S], ['admin', A]]) {
          ok(noHash((await call('GET', '/guests')).data), `S19 SECURITY: ${who} /guests carries no password hash`);
          ok(noHash((await call('GET', `/guests/${gh.id}`)).data), `S19 SECURITY: ${who} /guests/:id carries no password hash`);
          ok(noHash((await call('GET', '/dashboard')).data), `S19 SECURITY: ${who} /dashboard carries no password hash`);
        }
        ok(noHash((await A('PUT', `/guests/${gh.id}/approve-rent`)).data), 'S19 SECURITY: approve-rent (RETURNING *) carries no password hash');
        ok(JSON.stringify((await S('GET', `/guests/${gh.id}`)).data).includes('5555-6666-7777'), 'S19 staff still see the ID number they need');
        await A('DELETE', `/guests/${gh.id}`);
      }
      // ── Hotfix 19.1: the old public guest lookup leaked her password hash and ID number
      {
        const gl = await A('POST', '/guests', { name: 'HF Lookup', phone: '6' + String(Date.now()).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 0, id_proof_type: 'Aadhaar', id_proof_number: '1234-5678-9012' });
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', ['$2b$06$secretsecretsecretsecretse', gl.data.id]);
        eq((await fetch(BASE + '/api/guest-lookup?phone=' + gl.data.phone)).status, 401, 'HF19.1 SECURITY: the guest lookup needs a login');
        eq((await S('GET', '/guest-lookup?phone=' + gl.data.phone)).status, 403, 'HF19.1 SECURITY: …and an admin');
        const lk = await A('GET', '/guest-lookup?phone=' + gl.data.phone);
        ok(lk.status === 200 && lk.data.name === 'HF Lookup' && !('password_hash' in lk.data) && !('id_proof_number' in lk.data) && !JSON.stringify(lk.data).includes('1234-5678-9012'), 'HF19.1 SECURITY: even for the admin it never returns the password hash or the ID number');
        await A('DELETE', `/guests/${gl.data.id}`);
      }
      // ── Sprint 18: one clock — India's date at every hour (the gate also runs on a faked clock at 01:00 IST on the 1st)
      {
        const ym = today.slice(0, 7);
        const lastDay = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 0)).toISOString().slice(0, 10);
        let r18 = await A('GET', '/reports');
        ok(r18.data.dateFrom === `${ym}-01` && r18.data.dateTo === lastDay, `S18-1 the default report period is THIS month in India (${r18.data.dateFrom}…${r18.data.dateTo}, today ${today})`);
        r18 = await A('GET', '/reports/trend?months=3');
        eq(r18.data[r18.data.length - 1].month, ym, 'S18-1 the trend ends at this month in India');
        const bs18 = await A('GET', '/balance-sheet');
        if (bs18.data && bs18.data.asOf) eq(String(bs18.data.asOf).slice(0, 10), today, 'S18-1 the balance sheet defaults to India\'s today');
        // MONEY: entries the server dates itself
        const g18 = (await A('POST', '/guests', { name: 'S18 Clock', phone: '6' + String(Date.now()).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 1000 })).data;
        await A('PUT', `/guests/${g18.id}`, { ...g18, deposit_amount: 1500 });
        const dep18 = (await pool.query(`SELECT collection_date::text AS d FROM collections WHERE guest_id=$1 AND description LIKE 'Additional deposit%'`, [g18.id])).rows[0];
        eq(dep18 && dep18.d, today, "S18-2 MONEY: an additional deposit is dated India's today");
        await A('DELETE', `/guests/${g18.id}`);
        eq((await pool.query(`SELECT leave_date::text AS d FROM guests WHERE id=$1`, [g18.id])).rows[0].d, today, "S18-2 checkout is dated India's today");
        // Day boundaries of stored time stamps are taken in India
        const own0 = (await A('GET', `/owner/report?month=${ym}&force=1`)).data;
        const c18 = (await A('POST', '/complaints', { category: 'Water', description: 'S18 clock tap', room_number: '1' })).data;
        const own1 = (await A('GET', `/owner/report?month=${ym}&force=1`)).data;
        const raised = x => (x && (x.facts || x).complaints || {}).raised;
        eq(raised(own1), raised(own0) + 1, "S18-1 a complaint raised now counts in THIS month's owner report");
        await A('DELETE', `/complaints/${c18.id}`);
        // MONEY (review): a blank date is India's today — and a closed day stays closed
        const gB = (await A('POST', '/guests', { name: 'S18 Blank', phone: '8' + String(Date.now()).slice(-9), join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
        const dash0 = (await A('GET', '/dashboard')).data.monthlyIncome;
        const cb = await A('POST', '/collections', { guest_id: gB.id, guest_name: gB.name, amount: 1818, collection_type: 'rent', payment_mode: 'cash', collection_date: '' });
        ok(cb.status === 201 && String(cb.data.collection_date).slice(0, 10) === today, `S18-2 MONEY: a collection with a blank date is dated India's today (${cb.data && String(cb.data.collection_date).slice(0, 10)})`);
        eq((await A('GET', '/dashboard')).data.monthlyIncome, dash0 + 1818, "S18-2 MONEY: it counts in THIS month's dashboard income");
        const pb = await A('POST', '/purchases', { amount: 181, category: 'Other', description: 'S18 blank', purchase_date: '' });
        ok(pb.status === 201 && String(pb.data.purchase_date).slice(0, 10) === today, "S18-2 MONEY: a purchase with a blank date is dated India's today");
        const closeR = await A('POST', '/day-closing', { date: today, counted: { cash: 0, upi: 0, bank: 0 }, note: 'S18 test' });
        if (closeR.status === 200) {
          eq((await A('POST', '/collections', { guest_id: gB.id, guest_name: gB.name, amount: 1, collection_type: 'rent', payment_mode: 'cash', collection_date: '' })).status, 409, 'S18-2 MONEY: a blank-date collection cannot slip into a closed day');
          await A('POST', '/day-closing/reopen', { date: today });
        } else ok(false, `S18 (fixture) today's day could be closed (${closeR.status} ${JSON.stringify(closeR.data).slice(0, 80)})`);
        // The resident's UPI claim: dated India's today, pending, never income
        const tB = (await api('POST', '/guest-login', { mobile: gB.phone, password: gB.phone })).data;
        const tokB = tB.must_change_password ? (await api('POST', '/guest-change-password', { currentPassword: gB.phone, newPassword: 'Her-Own-18' }, tB.token)).data.token : tB.token;
        const dash1 = (await A('GET', '/dashboard')).data.monthlyIncome;
        eq((await api('POST', '/guest-upi-claim', { amount: 2500 }, tokB)).status, 201, 'S18 (fixture) she reports a UPI payment');
        const claim = (await pool.query(`SELECT collection_date::text AS d, status FROM collections WHERE guest_id=$1 AND amount=2500`, [gB.id])).rows[0];
        ok(claim && claim.d === today && claim.status === 'pending_verification', `S18-2 MONEY: her UPI claim is dated India's today and pending (${claim && claim.d} ${claim && claim.status})`);
        eq((await A('GET', '/dashboard')).data.monthlyIncome, dash1, 'MONEY: a pending_verification claim never counts as income');
        await pool.query(`DELETE FROM collections WHERE guest_id=$1`, [gB.id]); await pool.query(`DELETE FROM purchases WHERE description='S18 blank'`);
        await A('DELETE', `/guests/${gB.id}`);
      }
      // ── Sprint 16.3: account management ──────────────────────
      {
        const LX = (ip) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.' + ip });
        const login = async (u, p, ip) => { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: LX(ip), body: JSON.stringify({ username: u, password: p }) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
        const t163 = (await A('POST', '/users', { username: 's163user', password: 'First-Pass-1', role: 'staff' })).data;
        const tok = (await login('s163user', 'First-Pass-1', 1)).data.token;
        // S16.3-1 own password
        eq((await api('POST', '/auth/change-password', { currentPassword: 'First-Pass-1', newPassword: 'short' }, tok)).status, 400, 'S16.3-1 a new password under 8 characters is refused');
        eq((await api('POST', '/auth/change-password', { currentPassword: 'First-Pass-1', newPassword: 'S163USER' }, tok)).status, 400, 'S16.3-1 the username is refused as a password');
        eq((await api('POST', '/auth/change-password', { currentPassword: 'wrong-one', newPassword: 'Second-Pass-2' }, tok)).status, 401, 'S16.3-1 the current password is required');
        eq((await api('POST', '/auth/change-password', { currentPassword: 'First-Pass-1', newPassword: 'Second-Pass-2' }, tok)).status, 200, 'S16.3-1 staff can change their own password');
        eq((await login('s163user', 'Second-Pass-2', 2)).status, 200, 'S16.3-1 …and log in with it');
        // S16.3-2 admin sets a password, renames
        eq((await api('POST', `/users/${t163.id}/password`, { password: 'Third-Pass-3' }, tok)).status, 403, 'S16.3-2 SECURITY: staff cannot set another account\'s password');
        eq((await A('POST', `/users/${t163.id}/password`, { password: 'abc' })).status, 400, 'S16.3-2 admin-set password follows the 8-character rule');
        eq((await A('POST', `/users/${t163.id}/password`, { password: 'Third-Pass-3' })).status, 200, 'S16.3-2 admin sets a new password');
        eq((await login('s163user', 'Second-Pass-2', 3)).status, 401, 'S16.3-2 the old password stops working');
        eq((await login('s163user', 'Third-Pass-3', 4)).status, 200, 'S16.3-2 the new one works');
        eq((await A('PUT', `/users/${t163.id}/username`, { username: 'ADMIN' })).status, 400, 'S16.3-2 a name taken in another case is refused');
        eq((await A('PUT', `/users/${t163.id}/username`, { username: 'a b<c>' })).status, 400, 'S16.3-2 odd characters are refused');
        eq((await A('POST', '/users', { username: 'x<img src=x>', password: 'Long-Enough-1', role: 'staff' })).status, 400, 'S16.4 a new account with odd characters in its name is refused');
        eq((await A('POST', '/users', { username: 'ab', password: 'Long-Enough-1', role: 'staff' })).status, 400, 'S16.4 a new account name under 3 characters is refused');
        { const rn = await A('POST', '/users', { username: 16412345, password: 'Long-Enough-1', role: 'staff' });
          eq(rn.status, 201, 'S16.4 a numeric username is treated as text (no server error)');
          if (rn.data && rn.data.id) await A('DELETE', `/users/${rn.data.id}`); }
        eq((await api('PUT', `/users/${t163.id}/username`, { username: 's163self' }, tok)).status, 403, 'S16.3-2 SECURITY: staff cannot rename accounts');
        let r163 = await A('PUT', `/users/${t163.id}/username`, { username: 's163renamed' });
        eq(r163.status, 200, 'S16.3-2 admin renames an account');
        eq((await api('GET', '/auth/me', null, tok)).status, 200, 'S16.3-2 an open session keeps working after the rename');
        eq((await login('s163renamed', 'Third-Pass-3', 5)).status, 200, 'S16.3-2 the new name logs in');
        eq((await login('s163user', 'Third-Pass-3', 6)).status, 401, 'S16.3-2 the old name no longer does');
        ok((await pool.query(`SELECT 1 FROM activity_log WHERE action='user_rename' AND details='s163user → s163renamed'`)).rows.length === 1, 'S16.4-4 the audit log records old → new');
        eq((await A('POST', '/users', { username: 'S163RENAMED', password: 'Other-Pass-1', role: 'staff' })).status, 400, 'S16.4-4 creating a name that exists in another case is refused');
        const audit = (await pool.query(`SELECT action FROM activity_log WHERE action IN ('user_password_reset','user_rename','password_change') ORDER BY id`)).rows.map(x => x.action);
        ok(audit.includes('user_password_reset') && audit.includes('user_rename') && audit.includes('password_change'), 'S16.3-2 all three are in the Audit Log');
        r163 = await A('DELETE', `/users/${t163.id}`);
        ok(r163.status === 409 && /Turn off/.test(r163.data.error || ''), 'S16.3 deleting an account with history is refused with a clear way out (not a database error)');
        // ── Sprint 17 (S17-1): turn an account off instead of deleting it
        {
          const u17 = (await A('POST', '/users', { username: 's17staff', password: 'Staff-Pass-17', role: 'staff' })).data;
          const t17 = (await login('s17staff', 'Staff-Pass-17', 21)).data.token;
          eq((await api('GET', '/auth/me', null, t17)).status, 200, 'S17-1 the account works before');
          eq((await api('POST', `/users/${u17.id}/disable`, null, t17)).status, 403, 'S17-1 SECURITY: staff cannot turn accounts off');
          const me17 = (await A('GET', '/auth/me')).data.user;
          eq((await A('POST', `/users/${me17.id}/disable`)).status, 400, 'S17-1 the admin cannot turn off their own account');
          const d17 = await A('POST', `/users/${u17.id}/disable`);
          ok(d17.status === 200 && d17.data.disabled_at, 'S17-1 admin turns an account off');
          eq((await api('GET', '/auth/me', null, t17)).status, 401, 'S17-1 SECURITY: an open session stops at its next request');
          const l17 = await login('s17staff', 'Staff-Pass-17', 22);
          ok(l17.status === 403 && /turned off/.test(l17.data.error || '') && !l17.data.token, 'S17-1 the right password gets "turned off", and no token');
          const w17 = await login('s17staff', 'wrong-password', 23);
          ok(w17.status === 401 && w17.data.error === 'Invalid credentials', 'S17-1 SECURITY: a wrong password stays generic (does not reveal the account is off)');
          ok((await A('GET', '/users')).data.find(x => x.id === u17.id).disabled_at, 'S17-1 the staff list shows it as turned off');
          ok(!(await A('GET', '/staff-list')).data.some(x => x.id === u17.id), 'S17-1 a turned-off account is not offered in "assign to"');
          const c17 = (await A('POST', '/complaints', { category: 'Water', description: 'S17 tap', room_number: '1' })).data;
          ok(c17 && c17.id, 'S17-1 (fixture) a request to assign');
          const c17b = (await A('POST', '/complaints', { category: 'Water', description: 'S17 tap 2', room_number: '1' })).data;
          eq((await A('PUT', `/requests/${c17.id}`, { assigned_to: u17.id })).status, 400, 'S17-1 a request cannot be given to a turned-off account');
          const ck17 = (await A('GET', '/checklist-items')).data[0];
          eq((await A('PUT', `/checklist-items/${ck17.id}/assign`, { assigned_to: u17.id })).status, 400, 'S17-1 a checklist task cannot be given to a turned-off account');
          eq((await A('POST', '/bulk/preview', { action: 'assign', ids: [c17.id], args: { assigned_to: u17.id } })).status, 400, 'S17-1 bulk assign does not offer a turned-off account');
          // A turned-off account's right password is not counted as a guess (shared PG Wi-Fi)
          const XF17 = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.170' };
          let lim17 = [];
          for (let i = 0; i < 11; i++) lim17.push((await fetch(BASE + '/api/auth/login', { method: 'POST', headers: XF17, body: JSON.stringify({ username: 's17staff', password: 'Staff-Pass-17' }) })).status);
          ok(lim17.every(s => s === 403), `S17-1 OPS: 11 right-password tries on a turned-off account never trip the login pause (${lim17.join(',')})`);
          eq((await fetch(BASE + '/api/auth/login', { method: 'POST', headers: XF17, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) })).status, 200, 'S17-1 OPS: …and the other warden on the same Wi-Fi can still log in');
          eq((await A('POST', `/users/${u17.id}/enable`)).status, 200, 'S17-1 admin turns it back on');
          eq((await login('s17staff', 'Staff-Pass-17', 24)).status, 200, 'S17-1 …and it can log in again');
          eq((await A('PUT', `/requests/${c17.id}`, { assigned_to: u17.id })).status, 200, 'S17-1 …and can be given requests again');
          // A request left with someone who is then turned off can still be closed (review S17-1)
          await A('POST', `/users/${u17.id}/disable`);
          eq((await A('PUT', `/requests/${c17.id}`, { status: 'resolved', assigned_to: u17.id, priority: 'high' })).status, 200, 'S17-1 a request still with a turned-off account can be saved and closed (assignee unchanged)');
          eq((await A('PUT', `/requests/${c17b.id}`, { assigned_to: u17.id })).status, 400, 'S17-1 …but cannot be newly given to them');
          await A('POST', `/users/${u17.id}/enable`);
          const a17 = (await pool.query(`SELECT action FROM activity_log WHERE action IN ('user_disable','user_enable')`)).rows.map(x => x.action);
          ok(a17.includes('user_disable') && a17.includes('user_enable'), 'S17-1 both are in the Audit Log');
          // Before the migration runs (production between deploy and migrate-all), nothing breaks
          await pool.query('ALTER TABLE users DROP COLUMN disabled_at');
          try {
            eq((await A('GET', '/auth/me')).status, 200, 'S17-1 OPS: before the migration, open sessions keep working');
            eq((await login('s17staff', 'Staff-Pass-17', 25)).status, 200, 'S17-1 OPS: before the migration, login works');
            eq((await A('GET', '/users')).status, 200, 'S17-1 OPS: before the migration, the staff list loads');
            eq((await A('GET', '/staff-list')).status, 200, 'S17-1 OPS: before the migration, "assign to" loads');
            const p17 = await A('POST', `/users/${u17.id}/disable`);
            ok(p17.status === 503 && /migrate-all/.test(p17.data.error), 'S17-1 OPS: before the migration, Turn off says the update is pending');
          } finally { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ'); }
          await A('DELETE', `/complaints/${c17.id}`); await A('DELETE', `/complaints/${c17b.id}`);
        }
        // ── Sprint 17 (S17-4): content security policy
        {
          const h = async p => (await fetch(BASE + p)).headers.get('content-security-policy') || '';
          for (const p of ['/management', '/guest', '/api/rooms', '/js/app.js']) {
            const c = await h(p);
            ok(/connect-src 'self'(;|$)/.test(c) && /img-src 'self' data: blob:(;|$)/.test(c) && /frame-ancestors 'none'/.test(c) && /object-src 'none'/.test(c) && !/google-analytics|googletagmanager/.test(c), `S17-4 SECURITY: ${p} may only talk to the app itself and can't be framed`);
          }
          const home = await h('/');
          ok(/script-src [^;]*googletagmanager/.test(home) && /frame-ancestors 'none'/.test(home), 'S17-4 the public home page allows Google Analytics');
          for (const p of ['/home.html', '/some-unknown-page']) ok(/googletagmanager/.test(await h(p)), `S17-4 ${p} (the home page) allows Google Analytics`);
          // Hotfix 17.1: GA4 linked to Google Ads also sends to www.google.com/g/collect (blocked in production 9 Nov)
          ok(/connect-src [^;]*https:\/\/\*\.google\.com/.test(home) && /img-src [^;]*https:\/\/\*\.google\.com/.test(home) && /connect-src [^;]*\*\.g\.doubleclick\.net/.test(home) && /frame-src https:\/\/www\.googletagmanager\.com(;|$)/.test(home), 'S17.1 the home page allows Google Analytics with Ads features (google.com/g/collect)');
          const app = await h('/management');
          ok(!/google\.com|doubleclick|googlesyndication/.test(app) && /frame-src 'none'/.test(app), 'S17.1 SECURITY: staff pages still allow none of the Google hosts');
          // Express matches routes case-insensitively: no spelling may give a staff/resident page the home policy (review)
          for (const p of ['/MANAGEMENT', '/Management', '/Siri-Mane-Management', '/GUEST', '/Guest', '/SIRI-MANE-GUEST-PORTAL', '/management.html', '/guest.html']) {
            const r = await fetch(BASE + p); const c = r.headers.get('content-security-policy') || ''; const body = await r.text();
            ok(!/googletagmanager/.test(body) && !/google-analytics|googletagmanager/.test(c) && /connect-src 'self'(;|$)/.test(c), `S17-4 SECURITY: ${p} serves an app page with the strict policy`);
          }
        }
        // S16.3-3 reset a resident's app login
        const n163 = '9' + String(Date.now()).slice(-9);
        const g163 = (await A('POST', '/guests', { name: 'S163 Resident', phone: n163, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [await require('bcrypt').hash('Her-Own-1', 6), g163.id]);
        eq((await S('POST', `/guests/${g163.id}/reset-login`)).status, 200, 'S16.3-3 the warden (staff) can reset a resident\'s app login');
        ok((await pool.query(`SELECT 1 FROM notifications WHERE for_role='admin' AND title LIKE '%reset S163 Resident''s app login%'`)).rows.length === 1, 'S16.4-3 the admin is told who reset whose login');
        let gl163 = await fetch(BASE + '/api/guest-login', { method: 'POST', headers: LX(7), body: JSON.stringify({ mobile: n163, password: n163 }) }).then(r => r.json());
        eq(gl163.must_change_password, true, 'S16.3-3 she logs in with her number and must set her own password');
        eq((await api('POST', `/guests/${g163.id}/reset-login`)).status, 401, 'S16.3-3 SECURITY: needs a staff login');
        // S16.3-7 her messages and the replies
        const tokG = (await api('POST', '/guest-change-password', { currentPassword: n163, newPassword: 'Her-New-2' }, gl163.token)).data.token;
        eq((await api('POST', '/guest-my-message', { message: 'Geyser not working', subject: 'Water', guest_name: 'Someone Else' }, tokG)).status, 200, 'S16.3-7 she sends a message from the app');
        const inb = (await pool.query(`SELECT * FROM inbox_messages WHERE guest_id=$1`, [g163.id])).rows;
        ok(inb.length === 1 && inb[0].guest_name === 'S163 Resident', 'S16.3-7 SECURITY: linked to her account, with her name from her record (not the form)');
        await A('PUT', `/inbox/${inb[0].id}/reply`, { reply: 'Plumber coming at 5 pm' });
        let mine = (await api('GET', '/guest-my-messages', null, tokG)).data;
        ok(mine.ready === true && mine.messages[0].reply === 'Plumber coming at 5 pm', 'S16.3-7 she sees the reply');
        const other = (await api('POST', '/guest-login', { mobile: guest.phone, password: 'Resident@2026' })).data.token;
        ok(other && !(await api('GET', '/guest-my-messages', null, other)).data.messages.some(m => m.id === inb[0].id), 'S16.3-7 PRIVACY: another resident never sees it');
        eq((await api('GET', '/guest-my-messages')).status, 401, 'S16.3-7 SECURITY: needs her login');
        // Before the owner runs the migration (column missing): sending still works, the list says "soon"
        await pool.query('ALTER TABLE inbox_messages DROP COLUMN guest_id');
        eq((await api('POST', '/guest-my-message', { message: 'Before migration' }, tokG)).status, 200, 'S16.3-7 before the migration, sending still works');
        mine = (await api('GET', '/guest-my-messages', null, tokG)).data;
        ok(mine.ready === false && mine.messages.length === 0, 'S16.3-7 before the migration, the list says replies will appear soon');
        await pool.query('ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL');
        await A('DELETE', `/guests/${g163.id}`);
      }
      for (const n of ['S151 Old Form', 'S151 Wizard', 'S151 Truthy']) { const g = (await A('GET', '/guests')).data.find(x => x.name === n); if (g) await A('DELETE', `/guests/${g.id}`); }
    }
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
  { // S15-7 (review F-05): a gate QR minted by another environment is not valid here
    const jwt = require('jsonwebtoken');
    const g0 = JSON.parse(Buffer.from(guestTok.split('.')[1], 'base64url').toString());
    const foreignQr = jwt.sign({ type: 'resident-id', guestId: g0.guestId, env: 'other#000000000000' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    r = await api('POST', '/resident-id/verify', { token: foreignQr }, staffTok);
    ok(r.status >= 400 && r.data.valid === false, `S15-7 SECURITY: a gate QR from another environment is refused (${r.status})`);
  }
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
  // A duplicated or out-of-range bed number must not invent a crowd: the
  // resident still has a bed, only the number is wrong.
  const mixed = (await A('POST', '/rooms', { room_number: 'S5', floor: 3, total_beds: 3, monthly_rent: 5000 })).data;
  const mixedIds = [];
  for (const b of ['1', '1', '7000']) {
    const g = (await A('POST', '/guests', { name: `Mixed ${mixedIds.length}`, phone: '6' + uniq + mixedIds.length + '11', room_id: mixed.id, bed_number: b, join_date: today, monthly_rent: 5000, deposit_amount: 0 })).data;
    mixedIds.push(g.id);
  }
  r = await S('GET', '/room-map');
  const mixedTile = r.data.floors.flatMap(f => f.rooms).find(x => x.room_number === 'S5');
  eq(mixedTile.occupied, 3, 'MAP: three residents in a three-bed room read as three');
  eq(mixedTile.on_beds, 3, 'MAP: all three are on beds');
  eq(mixedTile.over_capacity, 0, 'MAP: none is called over capacity');
  eq(mixedTile.free, 0, 'MAP: the room offers no free bed');
  eq(mixedTile.bed_fix_count, 2, 'MAP: the two wrong bed numbers are flagged for correction');
  ok(mixedTile.bed_fixes.some(f => String(f.bed_number) === '7000'), 'MAP: and the offending number is named');
  const roomsTable = (await S('GET', '/rooms')).data.find(x => x.room_number === 'S5');
  eq(mixedTile.occupied, Number(roomsTable.occupied_beds), 'MAP: the map agrees with the Rooms table');
  for (const id of mixedIds) await A('PUT', `/guests/${id}`, { is_active: false, leave_date: today });

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
