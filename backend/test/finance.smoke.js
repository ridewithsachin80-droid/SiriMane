// backend/test/finance.smoke.js
// Sprint 10 gate. Every figure is recomputed here from raw rows and compared
// with what the service returns, so a change in the maths cannot pass quietly.
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');
const finance = require('../services/finance');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };
const near = (a, b, m, tol = 1) => { assert.ok(Math.abs(a - b) <= tol, `${m} (got ${a}, expected ≈${b})`); count++; };

let BASE, adminTok, staffTok;
const api = async (method, p, body, token) => {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
};
const A = (m, p, b) => api(m, p, b, adminTok);
const S = (m, p, b) => api(m, p, b, staffTok);
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const today = () => ist().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const dayOf = (n) => { const d = ist(); d.setUTCDate(n); return d.toISOString().slice(0, 10); };
const monthsAgo = n => { const d = ist(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, purchases, guest_rent_history, deposit_refunds, guests, rooms, owner_reports, ai_proposals, ai_actions, ai_reads, day_closings, collection_variances RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    await A('POST', '/users', { username: 'smoke_fin_staff', password: 'staff123', role: 'staff' });
    r = await api('POST', '/auth/login', { username: 'smoke_fin_staff', password: 'staff123' }); staffTok = r.data.token;
    const room = (await A('POST', '/rooms', { room_number: 'F1', floor: 1, total_beds: 4, monthly_rent: 6000 })).data;

    // Three residents with deliberately different habits.
    const mk = async (name, phone) => (await A('POST', '/guests', { name, phone, room_id: room.id, join_date: monthsAgo(4), monthly_rent: 6000, deposit_amount: 12000 })).data;
    const punctual = await mk('Punctual Priya', '9700000001');
    const late = await mk('Late Latha', '9700000002');
    const fresh = await mk('Fresh Fatima', '9700000003');
    const pay = (g, date, month, amount = 6000, mode = 'cash') =>
      pool.query(`INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,created_by,status)
                  VALUES($1,$2,$3,$4::date,$5,'rent',$6,1,'confirmed')`, [g.id, g.name, amount, date, month, mode]);
    // Priya: 3 months, always by the 5th. Latha: 3 months, always the 25th.
    for (let i = 3; i >= 1; i--) {
      const d = ist(); d.setUTCMonth(d.getUTCMonth() - i);
      const m = d.toISOString().slice(0, 7);
      await pay(punctual, `${m}-05`, m);
      await pay(late, `${m}-25`, m);
    }

    // ── Reliability ────────────────────────────────────────────────────────
    r = await S('GET', '/finance/reliability'); eq(r.status, 200, 'staff may read reliability (it orders reminders)');
    const rel = r.data;
    const p = rel.find(x => x.id === punctual.id), l = rel.find(x => x.id === late.id), f = rel.find(x => x.id === fresh.id);
    eq(p.level, 'high', 'always by the 5th → high'); eq(p.on_time_rate, 100, 'on-time rate 100%');
    eq(l.level, 'at_risk', 'always the 25th → at risk'); eq(l.on_time_rate, 0, 'on-time rate 0%');
    eq(f.level, 'new', 'no history → "new", not "at risk"');
    ok(/3 recorded months/.test(p.why), `reliability explains itself ("${p.why}")`);
  eq(p.arrears, p.months_behind >= 1, 'arrears reported separately from habit');
  ok(p.level === 'high' && p.arrears, 'someone who always pays on time but still carries a balance is not called unreliable');
  ok(l.needs_attention, 'the late payer needs attention');
    ok(/Late in 3 of the last 3/.test(l.why), `and for the late payer ("${l.why}")`);
    ok(rel.every(x => !('score' in x)), 'PRIVACY: residents are not scored against each other');
    // Recomputed independently from the raw rows
    const raw = await pool.query(`SELECT guest_id, MIN(EXTRACT(DAY FROM collection_date))::int AS first_day, collection_month
                                   FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_type='rent' GROUP BY guest_id, collection_month`);
    const byGuest = {};
    for (const row of raw.rows) { byGuest[row.guest_id] = byGuest[row.guest_id] || []; byGuest[row.guest_id].push(row.first_day); }
    for (const g of [punctual, late]) {
      const days = byGuest[g.id] || [];
      const expected = Math.round(days.filter(d => d <= finance.ON_TIME_DAY).length * 100 / days.length);
      eq(rel.find(x => x.id === g.id).on_time_rate, expected, `MONEY: on-time rate for ${g.name} recomputes from raw rows`);
    }

    // ── Collection forecast ────────────────────────────────────────────────
    r = await S('GET', '/finance/forecast'); eq(r.status, 403, 'forecast is the owner’s view');
    r = await A('GET', '/finance/forecast'); eq(r.status, 200, 'forecast');
    const fc = r.data.collections;
    eq(fc.target, 18000, 'target = the three rents');
    const expectedForecast = Math.round(6000 * 1 + 6000 * 0.3 + 6000 * 0.9); // high, at-risk floor, new default
    near(fc.expected, expectedForecast, 'MONEY: expected = Σ rent × her own on-time rate');
    eq(fc.shortfall, Math.max(0, fc.target - fc.expected), 'shortfall = target − expected');
    ok(fc.at_risk.some(x => x.id === late.id), 'the late payer is named'); ok(!fc.at_risk.some(x => x.id === punctual.id), 'the punctual one is not');
    ok(/multiplied by how often/.test(fc.basis), 'the method is stated on the screen');
    const occ = r.data.occupancy;
    eq(occ.beds, 4, 'beds'); eq(occ.occupied, 3, 'occupied');
    ok(occ.next7.low <= occ.next7.high && occ.next30.low <= occ.next30.high, 'forecast ranges are the right way round');
    ok(occ.next7.high <= occ.beds && occ.next30.low >= 0, 'forecast stays inside the building');
    await A('PUT', `/guests/${fresh.id}`, { expected_checkout: today() });
    occ2 = (await A('GET', '/finance/forecast')).data.occupancy;
    ok(occ2.leaving.some(x => x.id === fresh.id), 'a known checkout appears in the forecast');
    ok(occ2.next7.low <= occ.next7.low, 'and pulls the low end down');

    // ── KPIs, recomputed here from raw rows ────────────────────────────────
    await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES(3000,'Groceries','Rice',CURRENT_DATE,'Store','cash',1,'confirmed')`);
    r = await A('GET', '/finance/kpis'); eq(r.status, 200, 'kpis');
    const k = r.data;
    const rawIncome = (await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND to_char(collection_date,'YYYY-MM')=$1`, [thisMonth()])).rows[0].t;
    const rawExp = (await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM purchases WHERE is_deleted=false AND status='confirmed' AND to_char(purchase_date,'YYYY-MM')=$1`, [thisMonth()])).rows[0].t;
    eq(k.income, Math.round(rawIncome), 'MONEY: KPI income equals the raw sum');
    eq(k.expenses, Math.round(rawExp), 'MONEY: KPI expenses equal the raw sum');
    eq(k.net_operating_income, Math.round(rawIncome - rawExp), 'MONEY: NOI = income − expenses');
    eq(k.rent_roll, 18000, 'rent roll = the three rents');
    eq(k.occupancy_pct, 75, 'occupancy 3 of 4 beds');
    eq(k.average_rent, 6000, 'average rent');
    eq(k.collection_rate_pct, Math.round(k.rent_collected * 100 / k.rent_roll), 'collection rate = collected ÷ rent roll');
    const rep = (await A('GET', `/reports?month=${Number(thisMonth().slice(5))}&year=${thisMonth().slice(0, 4)}`)).data;
    eq(k.income, Math.round(rep.totalIncome), 'MONEY: KPI income equals the Reports screen');
    eq(k.expenses, Math.round(rep.totalExpenses), 'MONEY: KPI expenses equal the Reports screen');

    // ── Expense insight ────────────────────────────────────────────────────
    await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES(3000,'Groceries','Rice again',CURRENT_DATE,'Store','cash',1,'confirmed')`);
    for (let i = 0; i < 4; i++) await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES($1,'Milk','hist',CURRENT_DATE - ($2||' days')::interval,'Dairy','cash',1,'confirmed')`, [500, 60 + i * 10]);
    await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES(4000,'Milk','spike',CURRENT_DATE,'Dairy','cash',1,'confirmed')`);
    for (let i = 1; i <= 3; i++) await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES(9000,'Electricity','bill',CURRENT_DATE - ($1||' months')::interval,'BESCOM','upi',1,'confirmed')`, [i]);
    r = await A('GET', '/finance/expenses'); eq(r.status, 200, 'expense insight');
    ok(r.data.duplicates.some(d => d.amount === 3000), 'the same amount to the same vendor within 3 days is flagged');
    ok(r.data.spikes.some(s => s.amount === 4000 && s.category === 'Milk'), 'a purchase over twice the category average is flagged');
    ok(r.data.spikes[0].note.includes('vs a usual'), 'the spike says what "usual" is');
    ok(r.data.recurring.some(x => x.paid_to === 'BESCOM'), 'a monthly vendor is recognised as recurring');
    r = await S('GET', '/finance/expenses'); eq(r.status, 403, 'expense insight is admin only');

    // ── Day closing ────────────────────────────────────────────────────────
    await pay(punctual, today(), thisMonth(), 5000, 'cash');
    await pay(late, today(), thisMonth(), 3000, 'UPI');
    r = await S('GET', '/day-closing'); eq(r.status, 200, 'today’s closing sheet');
    eq(r.data.expected.cash, 5000, 'expected cash from confirmed collections');
    eq(r.data.expected.upi, 3000, 'expected UPI'); eq(r.data.expected.bank, 0, 'expected bank');
    eq(r.data.closed, false, 'not closed yet');
    const beforeLedger = JSON.stringify((await A('GET', '/rent-due')).data);
    const beforeRows = (await A('GET', '/collections')).data.length;
    r = await S('POST', '/day-closing', { date: today(), counted: { cash: 4800, upi: 3000, bank: 0 }, note: 'Short by 200 — checking' });
    eq(r.status, 200, 'day closed by staff');
    eq(r.data.variances.length, 1, 'one variance recorded');
    eq(r.data.variances[0].mode, 'cash', 'the cash line'); eq(r.data.variances[0].difference, -200, 'MONEY: difference = counted − expected');
    eq(JSON.stringify((await A('GET', '/rent-due')).data), beforeLedger, 'MONEY: closing a day changes no ledger');
    eq((await A('GET', '/collections')).data.length, beforeRows, 'MONEY: closing a day creates no collection');
    r = await S('POST', '/day-closing', { date: today(), counted: { cash: 5000, upi: 3000, bank: 0 } }); eq(r.status, 409, 'a closed day cannot be closed twice');
    r = await A('POST', '/collections', { guest_id: punctual.id, guest_name: punctual.name, amount: 100, collection_date: today(), collection_type: 'rent', payment_mode: 'cash' });
    eq(r.status, 409, 'MONEY: money cannot be backdated into a closed day'); ok(/closed and counted/.test(r.data.error), 'and the message says why');
    r = await S('POST', '/day-closing/reopen', { date: today() }); eq(r.status, 403, 'staff cannot reopen a day');
    r = await A('POST', '/day-closing/reopen', { date: today() }); eq(r.status, 200, 'admin can');
    r = await A('POST', '/collections', { guest_id: punctual.id, guest_name: punctual.name, amount: 100, collection_date: today(), collection_type: 'rent', payment_mode: 'cash' });
    eq(r.status, 201, 'and then the entry is accepted');
    r = await A('GET', '/finance/variances'); eq(r.status, 200, 'variance log'); eq(r.data.length, 1, 'the original variance is kept, not erased');
    r = await S('POST', '/day-closing', { date: '2099-01-01', counted: { cash: 0 } }); eq(r.status, 400, 'cannot close a future day');
    r = await S('POST', '/day-closing', { date: 'rubbish', counted: { cash: 0 } }); eq(r.status, 400, 'bad date refused');

    // ── Overview ───────────────────────────────────────────────────────────
    r = await A('GET', '/finance/overview'); eq(r.status, 200, 'finance overview');
    ok(r.data.kpis && r.data.forecast && r.data.expenses && r.data.today, 'overview carries kpis, forecast, expenses and today');
  ok(r.data.forecast.collections && r.data.forecast.occupancy, 'overview uses the same forecast shape as /finance/forecast');
  const solo = (await A('GET', '/finance/forecast')).data;
  eq(r.data.forecast.collections.expected, solo.collections.expected, 'and the same numbers');
    eq(r.data.kpis.income, (await A('GET', '/finance/kpis')).data.income, 'MONEY: overview and KPI endpoint agree');
    r = await S('GET', '/finance/overview'); eq(r.status, 403, 'overview is admin only');

    console.log(`\n✅ Finance gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Finance gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
