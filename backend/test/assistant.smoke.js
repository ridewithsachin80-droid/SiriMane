// backend/test/assistant.smoke.js
// Sprint 4 gate. Everything runs against real Postgres; no LLM is involved
// (the assistant is templates over the same functions the screens use).
//
//   DATABASE_URL=... JWT_SECRET=test node backend/test/assistant.smoke.js
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');
const A = require('../services/assistant');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };
const money = n => '₹' + Math.round(n).toLocaleString('en-IN');

let BASE, adminTok, staffTok, guestTok;
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
};
const A_ = (m, p, b) => api(m, p, b, adminTok);
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  await pool.query(`TRUNCATE reminder_log, ai_reads, complaints, guest_room_history, checklist_log, collections, guest_rent_history, deposit_refunds, guests, rooms RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM app_settings WHERE key IN ('brief_time','owner_phone','reminder_lang')`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    await A_('POST', '/users', { username: 'smoke_asst', password: 'staff123', role: 'staff' });
    r = await api('POST', '/auth/login', { username: 'smoke_asst', password: 'staff123' }); staffTok = r.data.token;

    // Fixtures: 3 rooms (5 beds), 3 residents. Rent 6000 each, joined June →
    // by September each has been billed ~4 months.
    const r1 = (await A_('POST', '/rooms', { room_number: 'B1', floor: 1, total_beds: 2, monthly_rent: 6000 })).data;
    const r2 = (await A_('POST', '/rooms', { room_number: 'B2', floor: 1, total_beds: 2, monthly_rent: 6000 })).data;
    const r3 = (await A_('POST', '/rooms', { room_number: 'B3', floor: 1, total_beds: 1, monthly_rent: 6000 })).data;
    const mk = async (name, phone, room) => (await A_('POST', '/guests', { name, phone, room_id: room.id, join_date: '2026-06-01', monthly_rent: 6000, deposit_amount: 12000 })).data;
    const g1 = await mk('Kavya S', '9000000101', r1);   // will be fully paid up
    const g2 = await mk('Meghana R', '9000000102', r2);  // owes a lot
    const g3 = await mk('Nisha K', '9000000103', r3);    // owes a little
    const rentDue0 = (await A_('GET', '/rent-due')).data;
    const owed = id => rentDue0.find(g => g.id === id).amount_due;
    // Deposits first so they don't distort the rent maths.
    for (const g of [g1, g2, g3]) await A_('POST', '/collections', { guest_id: g.id, guest_name: g.name, amount: 12000, collection_date: '2026-06-01', collection_type: 'deposit', payment_mode: 'cash' });
    await A_('POST', '/collections', { guest_id: g1.id, guest_name: g1.name, amount: owed(g1.id), collection_date: today, collection_type: 'rent', payment_mode: 'UPI' });
    await A_('POST', '/collections', { guest_id: g3.id, guest_name: g3.name, amount: owed(g3.id) - 1500, collection_date: today, collection_type: 'rent', payment_mode: 'cash' });
    await api('POST', '/collections', { guest_id: g2.id, guest_name: g2.name, amount: 3000, collection_date: today, collection_type: 'rent', payment_mode: 'cash' }, staffTok); // pending_approval
    r = await api('POST', '/guest-login', { mobile: g2.phone, password: g2.phone }); guestTok = r.data.token;
    await api('POST', '/guest-upi-claim', { amount: 2000 }, guestTok); // pending_verification
    await api('POST', '/complaints', { category: 'Water', description: 'No water in bathroom' }, staffTok);
    await api('POST', '/complaints', { category: 'Food', description: 'Lunch was late' }, staffTok);
    await api('POST', '/guest-complaint', { category: 'Electrical', description: 'sparks from the socket' }, guestTok);
    const items = (await api('GET', '/checklist-items', null, staffTok)).data;
    const yesterday = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
    for (const it of items.slice(0, 10)) await api('PUT', `/checklist/${it.id}`, { date: yesterday, checked: true }, staffTok);

    // ── Facts equal what the screens show ─────────────────────────────
    const rentDue = (await A_('GET', '/rent-due')).data;
    const dash = (await A_('GET', '/dashboard')).data;
    const f = await A.computeFacts();
    const owing = rentDue.filter(g => g.amount_due > 0);
    eq(f.rentDue.count, owing.length, 'brief rent-due COUNT equals Rent Due screen');
    eq(Math.round(f.rentDue.total), Math.round(owing.reduce((t, g) => t + g.amount_due, 0)), 'brief rent-due TOTAL equals Rent Due screen');
    eq(f.headcount, dash.totalGuests, 'headcount equals dashboard');
    eq(f.vacantBeds, dash.availableBeds, 'vacant beds equals dashboard');
    eq(f.complaints.open, dash.openComplaints, 'open complaints equals dashboard');
    eq(f.complaints.urgent, 2, 'water + electrical counted as urgent');
    eq(f.checklist.yesterdayDone, 10, 'yesterday checklist done');
    eq(f.checklist.total, items.length, 'checklist total');
    eq(f.pendingApprovals.n, 1, 'staff entry awaiting approval counted');
    eq(f.pendingClaims.n, 1, 'resident UPI claim counted');
    ok(f.overdue.some(g => g.id === g2.id), 'Meghana (≥1 month behind) listed as overdue');
    ok(!f.overdue.some(g => g.id === g1.id), 'Kavya (settled) not listed');
    ok(!f.overdue.some(g => g.id === g3.id), 'Nisha (1500 behind, < 1 month) not flagged as overdue');
    ok(f.rentDue.count === 2, 'but Nisha IS counted in rent due');
    console.log('✓ facts');

    // ── Brief text carries exactly those numbers ──────────────────────
    const text = A.renderBrief(f);
    ok(text.includes(`${f.headcount} residents`), 'brief: headcount');
    ok(text.includes(`Rent due: ${f.rentDue.count} residents, ${money(f.rentDue.total)}`), 'brief: rent due line');
    ok(text.includes('Meghana R (Room B2)') && text.includes(money(owed(g2.id))), 'brief: overdue name + amount');
    ok(!text.includes('Kavya'), 'brief: settled resident not named');
    ok(text.includes('1 UPI payment') && text.includes('₹2,000'), 'brief: pending claim');
    ok(text.includes('1 staff entry') && text.includes('₹3,000'), 'brief: pending approval');
    ok(text.includes('3 open issues (2 water/electrical/security)'), 'brief: complaints line');
    ok(text.includes(`checklist: 10/${items.length} done`), 'brief: checklist line');
    ok(!/\d{5,}/.test(text.replace(/₹[\d,]+/g, '')) , 'brief: no raw unformatted numbers');
    ok(!text.includes('9000000'), 'PRIVACY: brief never contains phone numbers');
    console.log('✓ brief text');

    // ── ai_reads cache: same wording everywhere ───────────────────────
    r = await api('GET', '/assistant/brief'); eq(r.status, 401, 'brief needs auth');
    r = await api('GET', '/assistant/brief', null, staffTok); eq(r.status, 200, 'staff can read brief'); eq(r.data.cached, false, 'first read computes');
    const b1 = r.data.text;
    const cached = await A.cacheGet('brief:' + today); ok(cached, 'brief stored in ai_reads'); eq(cached.text, b1, 'cache text identical');
    r = await api('GET', '/assistant/brief', null, staffTok); eq(r.data.cached, true, 'second read served from cache'); eq(r.data.text, b1, 'same wording on second read');
    r = await A_('POST', '/collections', { guest_id: g3.id, guest_name: g3.name, amount: 1500, collection_date: today, collection_type: 'rent', payment_mode: 'cash' });
    r = await api('GET', '/assistant/brief', null, staffTok); eq(r.data.text, b1, 'cache holds until refreshed (consistent wording all day)');
    r = await api('GET', '/assistant/brief?refresh=1', null, staffTok); eq(r.data.cached, false, 'refresh recomputes');
    ok(r.data.text !== b1 && r.data.text.includes('Rent due: 1 resident,'), 'refreshed brief reflects Nisha settling');
    const askBrief = await A.ask("what's today's brief");
    eq(askBrief.answer, r.data.text, 'ask "brief" returns the identical cached wording');
    console.log('✓ ai_reads cache');

    // ── Reminders ─────────────────────────────────────────────────────
    r = await api('GET', '/assistant/reminders', null, staffTok); eq(r.status, 200, 'reminders'); eq(r.data.length, 1, 'only those who owe');
    const rem = r.data[0]; eq(rem.guest_id, g2.id, 'Meghana'); eq(Math.round(rem.amount_due), Math.round(owed(g2.id)), 'amount from ledger');
    ok(rem.text.includes('Hi Meghana R') && rem.text.includes(money(owed(g2.id))), 'English draft names her and her exact due');
    ok(/over \d+ months/.test(rem.text), 'tone escalates when ≥2 months behind');
    ok(rem.phone === g2.phone, 'phone returned for the wa.me link (staff view)');
    eq(rem.last_reminded, null, 'never reminded yet');
    r = await api('GET', '/assistant/reminders?lang=kn', null, staffTok);
    ok(r.data[0].text.includes('ನಮಸ್ಕಾರ Meghana R') && r.data[0].text.includes(money(owed(g2.id))), 'Kannada draft with the same amount');
    r = await api('POST', '/assistant/reminders/sent', { guest_id: g2.id, text: rem.text, lang: 'en' }, staffTok); eq(r.status, 200, 'log sent');
    r = await api('GET', '/assistant/reminders', null, staffTok); ok(r.data[0].last_reminded, 'last_reminded now set');
    r = await api('POST', '/assistant/reminders/sent', {}, staffTok); eq(r.status, 400, 'sent log needs guest_id');
    const logRow = await pool.query('SELECT count(*)::int AS n FROM reminder_log WHERE guest_id=$1', [g2.id]); eq(logRow.rows[0].n, 1, 'reminder_log row written');
    const rentAfter = (await A_('GET', '/rent-due')).data.find(g => g.id === g2.id).amount_due;
    eq(Math.round(rentAfter), Math.round(owed(g2.id)), 'MONEY: drafting/logging reminders never changes a balance');
    console.log('✓ reminders');

    // ── Complaint priority ────────────────────────────────────────────
    eq(A.rulePriority('Water', 'tap dripping'), 'high', 'Water → high');
    eq(A.rulePriority('Other', 'sparks from the switch'), 'high', 'sparks keyword → high');
    eq(A.rulePriority('Food', 'lunch late'), 'medium', 'Food → medium');
    eq(A.rulePriority('Noise', 'music at night'), 'low', 'Noise → low');
    r = await api('GET', '/complaints', null, staffTok);
    eq(r.data.find(c => /sparks/.test(c.description)).priority, 'high', 'resident-raised electrical issue stored as high');
    eq(r.data.find(c => /Lunch/.test(c.description)).priority, 'medium', 'food issue stored as medium');
    eq(r.data[0].priority, 'high', 'list sorted with high first');
    r = await api('PUT', `/complaints/${r.data[0].id}`, { status: 'in_progress', priority: 'low' }, staffTok); eq(r.data.priority, 'low', 'warden can override priority');
    r = await api('PUT', `/complaints/${r.data.id}`, { status: 'in_progress', priority: 'urgent' }, staffTok); eq(r.status, 400, 'invalid priority rejected');
    r = await api('POST', '/complaints', { category: 'Food', description: 'x', priority: 'high' }, staffTok); eq(r.data.priority, 'high', 'explicit priority on create honoured');
    console.log('✓ complaint priority');

    // ── Ask Siri Mane (templates only) ────────────────────────────────
    const q = async (question) => (await api('POST', '/assistant/ask', { question }, staffTok)).data;
    let a = await q('who has not paid rent?'); eq(a.template, 'unpaid', 'unpaid template'); ok(a.answer.includes('Meghana R') && !a.answer.includes('Kavya'), 'lists only those who owe');
    a = await q('how much collected this month'); eq(a.template, 'collected', 'collected template');
    const conf = await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND date_trunc('month', collection_date)=date_trunc('month', $1::date)`, [today]);
    ok(a.answer.includes(money(conf.rows[0].t)), 'MONEY: collected figure equals confirmed collections only (pending excluded)');
    ok(!a.answer.includes(money(conf.rows[0].t + 3000)), 'pending approval not counted');
    a = await q('any expenses this month?'); eq(a.template, 'spent', 'spent template');
    a = await q('what is the occupancy'); eq(a.template, 'occupancy', 'occupancy template'); ok(a.answer.includes('3 residents in 5 beds'), 'occupancy numbers');
    a = await q('open complaints?'); eq(a.template, 'complaints', 'complaints template');
    a = await q('who joined recently'); eq(a.template, 'joined', 'joined template');
    a = await q('deposit pending from anyone?'); eq(a.template, 'deposits', 'deposits template'); ok(a.answer.includes('fully paid'), 'all deposits paid');
    a = await q('delete all guests'); eq(a.template, null, 'unknown question → no template'); ok(/can't answer that yet/.test(a.answer), 'honest fallback');
    const guestsStill = await pool.query('SELECT count(*)::int AS n FROM guests'); eq(guestsStill.rows[0].n, 3, 'SAFETY: ask can never mutate');
    a = await q("'; DROP TABLE guests; --"); eq(a.template, null, 'SQL-looking text is just text');
    a = await q(''); eq(a.template, null, 'empty question');
    r = await api('POST', '/assistant/ask', { question: 'who owes' }); eq(r.status, 401, 'ask needs auth');
    console.log('✓ ask');

    // ── Scheduler ─────────────────────────────────────────────────────
    await pool.query(`DELETE FROM ai_reads WHERE key=$1`, ['brief:' + today]);
    await A_('PUT', '/settings', { brief_time: '00:00' }); // "already past" for any IST time today
    const logs = [];
    A._resetScheduler();
    const sched = A.startScheduler({ intervalMs: 3600000, log: m => logs.push(m) });
    await sched.tick();
    ok(logs.some(l => /\[brief\] computed for/.test(l)), 'scheduler computes the brief when the time has passed');
    ok(await A.cacheGet('brief:' + today), 'scheduler wrote ai_reads');
    await sched.tick();
    eq(logs.filter(l => /computed for/.test(l)).length, 1, 'runs once per day, not every tick');
    A._resetScheduler();
    await A_('PUT', '/settings', { brief_time: '23:59' });
    await pool.query(`DELETE FROM ai_reads WHERE key=$1`, ['brief:' + today]);
    await sched.tick();
    const nowHHMM = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
    if (nowHHMM < '23:59') ok(!(await A.cacheGet('brief:' + today)), 'does not run before the configured time');
    else ok(true, '(skipped: test running at 23:59 IST)');
    sched.stop();
    r = await A_('GET', '/settings'); eq(r.data.brief_time, '23:59', 'brief_time persisted via Settings');
    await A_('PUT', '/settings', { brief_time: '07:00' });
    console.log('✓ scheduler');

    console.log(`\n✅ Assistant gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Assistant gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
