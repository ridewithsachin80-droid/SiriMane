// backend/test/owner.smoke.js
// Sprint 5 gate. Real Postgres + in-process server. Proves the owner report
// says exactly what the Reports / Balance Sheet / Rent Due APIs say, that
// each anomaly rule fires on a matching fixture and stays quiet otherwise,
// that the PDF and ZIP are real files, and that the schema check reports
// missing migrations.
//
//   DATABASE_URL=... JWT_SECRET=test node backend/test/owner.smoke.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');
const owner = require('../services/owner');
const schemaCheck = require('../services/schema-check');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };
const near = (a, b, m) => { assert.ok(Math.abs(a - b) < 0.01, `${m} (got ${a}, expected ${b})`); count++; };

let BASE, adminTok, staffTok;
const api = async (method, p, body, token) => {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, ct, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const A = (m, p, b) => api(m, p, b, adminTok);
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const thisMonth = istToday().slice(0, 7);
const monthAgo = (n) => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, purchases, guest_rent_history, deposit_refunds, guests, rooms, owner_reports, fixed_assets, capital_transactions, ai_reads, day_closings, collection_variances RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    await A('POST', '/users', { username: 'smoke_owner_staff', password: 'staff123', role: 'staff' });
    r = await api('POST', '/auth/login', { username: 'smoke_owner_staff', password: 'staff123' }); staffTok = r.data.token;

    // ── Fixtures: 2 rooms, 3 residents with different arrears, money in the month ──
    const r1 = (await A('POST', '/rooms', { room_number: 'O1', floor: 1, total_beds: 2, monthly_rent: 6000 })).data;
    const r2 = (await A('POST', '/rooms', { room_number: 'O2', floor: 1, total_beds: 2, monthly_rent: 6000 })).data;
    const gA = (await A('POST', '/guests', { name: 'Owner A', phone: '9111111111', room_id: r1.id, join_date: monthAgo(4), monthly_rent: 6000, deposit_amount: 12000 })).data; // 4 months, pays 1 → 3 behind
    const gB = (await A('POST', '/guests', { name: 'Owner B', phone: '9222222222', room_id: r1.id, join_date: monthAgo(1), monthly_rent: 6000, deposit_amount: 12000 })).data; // 1 month, pays nothing → 1 behind
    const gC = (await A('POST', '/guests', { name: 'Owner C', phone: '9333333333', room_id: r2.id, join_date: istToday(), monthly_rent: 6000, deposit_amount: 12000 })).data; // joined today
    const today = istToday();
    await A('POST', '/collections', { guest_id: gA.id, guest_name: gA.name, amount: 6000, collection_date: today, collection_type: 'rent', payment_mode: 'UPI', source: 'voice' });
    await A('POST', '/collections', { guest_id: gC.id, guest_name: gC.name, amount: 12000, collection_date: today, collection_type: 'deposit', payment_mode: 'cash' });
    await A('POST', '/purchases', { amount: 2500, category: 'Groceries', description: 'Rice', purchase_date: today, paid_to: 'Store', payment_mode: 'cash', source: 'photo' });
    await A('POST', '/purchases', { amount: 900, category: 'Electricity', description: 'Bill', purchase_date: today, paid_to: 'BESCOM', payment_mode: 'UPI' });
    await A('POST', '/complaints', { category: 'Water', description: 'Owner test leak' }, );
    const cid = (await api('POST', '/complaints', { category: 'Water', description: 'Owner test leak 2' }, staffTok)).data.id;
    await api('PUT', `/complaints/${cid}`, { status: 'resolved', resolution_notes: 'done' }, staffTok);

    // ── Access ─────────────────────────────────────────────────────────────
    r = await api('GET', `/owner/report?month=${thisMonth}`); eq(r.status, 401, 'owner report needs auth');
    r = await api('GET', `/owner/report?month=${thisMonth}`, null, staffTok); eq(r.status, 403, 'owner report is admin only');
    r = await api('GET', `/owner/anomalies`, null, staffTok); eq(r.status, 403, 'anomalies admin only');
    r = await api('GET', `/owner/export.zip`, null, staffTok); eq(r.status, 403, 'export admin only');
    r = await A('GET', `/owner/report?month=2099-01`); eq(r.status, 400, 'future month refused');
    r = await A('GET', `/owner/report?month=garbage`); eq(r.status, 200, 'bad month falls back to this month'); eq(r.data.month, thisMonth, 'fallback month');

    // ── Consistency: report == Reports API == Balance Sheet API == Rent Due API ──
    r = await A('GET', `/owner/report?month=${thisMonth}&force=1`); eq(r.status, 200, 'owner report'); const rep = r.data;
    const [y, m] = thisMonth.split('-').map(Number);
    const reports = (await A('GET', `/reports?month=${m}&year=${y}`)).data;
    near(rep.money.income, reports.totalIncome, 'MONEY: income equals Reports screen');
    near(rep.money.expenses, reports.totalExpenses, 'MONEY: expenses equal Reports screen');
    near(rep.money.net, reports.netProfit, 'MONEY: net equals Reports screen');
    ok(rep.money.income >= 18000, `income includes the rent, the manual deposit and auto-recorded deposits (${rep.money.income})`);
    eq(rep.money.expenses, 3400, 'expenses = 2500 + 900');
    const incStr = 'Rs ' + Math.round(rep.money.income).toLocaleString('en-IN');
    const sheet = (await A('GET', `/balance-sheet?asOf=${rep.to}`)).data;
    near(rep.money.depositsHeld, sheet.liabilities.depositsHeld, 'MONEY: deposits held equals Balance Sheet');
    near(rep.money.cashPosition, sheet.assets.cashPosition, 'MONEY: cash position equals Balance Sheet');
    const due = (await A('GET', '/rent-due')).data;
    const owing = due.filter(g => g.amount_due > 0);
    eq(rep.dues.residents, owing.length, 'dues count equals Rent Due screen');
    near(rep.dues.total, owing.reduce((t, g) => t + g.amount_due, 0), 'MONEY: dues total equals Rent Due screen');
    const trend = (await A('GET', '/reports/trend?months=12')).data;
    near(rep.trend[rep.trend.length - 1].income, trend[trend.length - 1].income, 'trend equals Reports trend');
    eq(rep.occupancy.beds, 4, 'beds'); eq(rep.occupancy.occupied, 3, 'occupied'); eq(rep.occupancy.percent, 75, 'occupancy %'); eq(rep.occupancy.joined, 1, 'joined this month (C)');
    eq(rep.complaints.raised, 2, 'complaints raised'); eq(rep.complaints.resolved, 1, 'resolved'); eq(rep.complaints.openNow, 1, 'open now'); eq(rep.complaints.openHigh, 1, 'water = high');
    eq(rep.inputs.collection.voice, 1, 'voice collections counted'); eq(rep.inputs.purchase.photo, 1, 'photo purchases counted');
    const ag = rep.dues.ageing; eq(ag.over2.n >= 1, true, 'A is 2+ months behind'); eq(ag.under1.n + ag.one2.n + ag.over2.n, rep.dues.residents, 'ageing buckets sum to residents owing');
    ok(rep.summary.split('\n').length === 5, 'summary is exactly five lines');
    ok(rep.summary.includes(incStr) && rep.summary.includes('Rs 3,400'), 'summary quotes the real totals');
    ok(rep.summary.includes('75%'), 'summary quotes occupancy');
    console.log('✓ report consistency');

    // ── Anomalies ──────────────────────────────────────────────────────────
    let flags = (await A('GET', '/owner/anomalies')).data;
    ok(flags.some(f => f.id === 'overdue_30' && f.title.startsWith('Owner A')), 'flag: resident a month+ behind (A)');
    ok(flags.find(f => f.id === 'overdue_30' && f.title.startsWith('Owner A')).level === 'high', 'A (2+ months) is high');
    ok(!flags.some(f => f.title.startsWith('Owner C')), 'no flag for a resident who just joined');
    ok(!flags.some(f => f.id === 'claims_waiting'), 'no claims flag without claims');
    ok(!flags.some(f => f.id === 'big_purchase'), 'no purchase flag without history');
    eq(flags[0].level, 'high', 'sorted high first');
    // Rent variance pending > 3 days: backdate created_at on a guest with off-rate rent
    // (staff entry — admin entries are auto-approved, so only staff can leave a variance pending)
    await api('POST', '/guests', { name: 'Owner V', phone: '9444444444', room_id: r2.id, join_date: today, monthly_rent: 5000, deposit_amount: 10000 }, staffTok);
    await pool.query(`UPDATE guests SET created_at = NOW() - INTERVAL '4 days' WHERE name='Owner V'`);
    // Unusual purchase: 5 history rows around ₹500 then one at ₹3,000
    for (let i = 0; i < 5; i++) await pool.query(`INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,created_by,status) VALUES($1,'Milk','hist',CURRENT_DATE - ($2||' days')::interval,'Dairy','cash',1,'confirmed')`, [500 + i * 10, 40 + i * 7]);
    await A('POST', '/purchases', { amount: 3000, category: 'Milk', description: 'big', purchase_date: today, paid_to: 'Dairy', payment_mode: 'cash' });
    // Refund larger than deposit
    await pool.query(`INSERT INTO deposit_refunds(guest_id, guest_name, deposit_amount, deductions, refund_amount) VALUES($1,'Owner Refund',5000,0,7000)`, [gC.id]);
    // UPI claim older than 2 days
    await pool.query(`INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_type,payment_mode,status,reported_by_guest,created_at) VALUES($1,$2,1000,CURRENT_DATE-3,'rent','UPI','pending_verification',true,NOW()-INTERVAL '3 days')`, [gB.id, gB.name]);
    // Checklist under 50% for 3 days
    const items = await pool.query('SELECT id FROM checklist_items WHERE is_active=true ORDER BY id LIMIT 2');
    for (let d = 1; d <= 3; d++) for (const it of items.rows) await pool.query(`INSERT INTO checklist_log(item_id, log_date, is_checked) VALUES($1, CURRENT_DATE - ($2::int), true) ON CONFLICT DO NOTHING`, [it.id, d]);
    flags = (await A('GET', '/owner/anomalies')).data;
    const ids = flags.map(f => f.id);
    ok(ids.includes('rent_variance'), 'flag: rent variance pending > 3 days');
    ok(ids.includes('big_purchase'), 'flag: purchase > 2× category average');
    ok(flags.find(f => f.id === 'big_purchase').title.includes('Rs 3,000'), 'purchase flag names the amount');
    ok(ids.includes('refund_over_deposit'), 'flag: refund larger than deposit');
    ok(ids.includes('claims_waiting'), 'flag: UPI claims waiting > 2 days');
    ok(ids.includes('checklist_low'), 'flag: checklist < 50% for 3 days');
    ok(flags.every(f => f.title && f.detail && ['high', 'medium', 'low'].includes(f.level)), 'every flag has title, detail, level');
    // Confirm the claim → the claims flag disappears
    const claim = await pool.query(`SELECT id FROM collections WHERE status='pending_verification' LIMIT 1`);
    await A('PUT', `/collections/${claim.rows[0].id}/confirm`);
    flags = (await A('GET', '/owner/anomalies')).data;
    ok(!flags.some(f => f.id === 'claims_waiting'), 'claims flag clears once confirmed');
    console.log('✓ anomalies');

    // ── Forecast ───────────────────────────────────────────────────────────
    const fake = []; for (let i = 0; i < 13; i++) { const d = new Date(Date.UTC(2026, i, 1)); fake.push({ month: d.toISOString().slice(0, 7), income: 100000 + i * 1000, expenses: 40000, net: 60000 + i * 1000 }); }
    const fc = owner.forecastFromTrend(fake, { percent: 75 });
    eq(fc.months.length, 3, 'three months projected');
    eq(fc.months[0].month, '2027-02', 'projection starts the month after the report month');
    const fcFinal = owner.forecastFromTrend(fake, { percent: 75 }, false);
    eq(fcFinal.monthsUsed[5], '2027-01', 'a finished report month feeds its own projection');
    eq(fc.monthsUsed.length, 6, 'uses six completed months (current month excluded)');
    ok(fc.months[0].income > 104000 && fc.months[0].income < 116000, `projection is a sane average (${fc.months[0].income})`);
    eq(fc.months[0].expenses, 40000, 'flat expenses project flat');
    ok(/Average of the last 6/.test(fc.basis), 'basis is spelled out');
    const spike = fake.map(x => ({ ...x })); spike[11].income = 900000;
    const fc2 = owner.forecastFromTrend(spike, { percent: 75 });
    ok(fc2.months[2].income <= fc2.months[0].income * 1.3, 'one spike month cannot run the projection away (capped)');
    const empty = owner.forecastFromTrend([{ month: '2026-09', income: 0, expenses: 0, net: 0 }], { percent: 0 });
    eq(empty.months[0].income, 0, 'no history → zero, not NaN');
    console.log('✓ forecast');

    // ── Caching: past month final, current month recomputed ───────────────
    const prev = monthAgo(1).slice(0, 7);
    const p1 = (await A('GET', `/owner/report?month=${prev}`)).data; eq(p1.cached, false, 'first read of a past month computes');
    const p2 = (await A('GET', `/owner/report?month=${prev}`)).data; eq(p2.cached, true, 'second read of a past month is the stored one');
    eq(p2.summary, p1.summary, 'stored report is identical');
    const c1 = (await A('GET', `/owner/report?month=${thisMonth}`)).data; eq(c1.cached, false, 'current month always recomputes');
    console.log('✓ report cache');

    // ── PDF ────────────────────────────────────────────────────────────────
    const latest = (await A('GET', `/owner/report?month=${thisMonth}`)).data; // fixtures above changed this month
    const incNum = Math.round(latest.money.income).toLocaleString('en-IN'), expNum = Math.round(latest.money.expenses).toLocaleString('en-IN');
    r = await A('GET', `/owner/report/pdf?month=${thisMonth}`); eq(r.status, 200, 'pdf'); ok(r.ct.includes('application/pdf'), 'content-type pdf');
    eq(r.data.subarray(0, 4).toString(), '%PDF', 'starts with %PDF'); ok(r.data.subarray(-64).toString().includes('%%EOF'), 'complete pdf');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-')); const pdfPath = path.join(tmp, 'r.pdf'); fs.writeFileSync(pdfPath, r.data);
    let text = '';
    try { text = execFileSync('pdftotext', [pdfPath, '-']).toString(); } catch { text = ''; }
    if (text) {
      ok(text.includes('Owner report'), 'pdf has title');
      ok(text.includes(incNum), `pdf shows income ${incNum}`); ok(text.includes(expNum), `pdf shows expenses ${expNum}`);
      ok(!text.includes('¹') && !text.includes('₹'), 'no broken rupee glyph in the PDF');
      ok(text.includes('Needs attention') && text.includes('Owner A'), 'pdf lists the overdue resident');
      ok(text.includes('Next 3 months'), 'pdf has the projection');
      ok(text.includes('same calculations'), 'pdf footer states provenance');
    } else console.log('   (pdftotext not available — text assertions skipped)');
    console.log('✓ pdf');

    // ── ZIP export ─────────────────────────────────────────────────────────
    r = await A('GET', `/owner/export.zip?from=${thisMonth}-01&to=${today}`); eq(r.status, 200, 'zip'); ok(r.ct.includes('application/zip'), 'content-type zip');
    eq(r.data.readUInt32LE(0), 0x04034b50, 'zip local header signature');
    const zipPath = path.join(tmp, 'x.zip'); fs.writeFileSync(zipPath, r.data);
    let listing = '';
    try { listing = execFileSync('unzip', ['-t', zipPath]).toString(); } catch (e) { listing = String(e.stdout || ''); }
    ok(/No errors detected/.test(listing), 'unzip -t: archive is valid');
    for (const f of ['collections.csv', 'purchases.csv', 'residents.csv', 'rooms.csv', 'deposit_refunds.csv', 'README.txt']) ok(listing.includes(f), `zip contains ${f}`);
    const csv = execFileSync('unzip', ['-p', zipPath, 'collections.csv']).toString();
    ok(csv.split('\n')[0].startsWith('id,collection_date,guest_name'), 'collections.csv header');
    ok(csv.includes('Owner A') && csv.includes('6000'), 'collections.csv has the rows');
    ok(csv.includes('pending_verification') || csv.includes('confirmed'), 'status column present');
    const crc = owner.crc32(Buffer.from('123456789')); eq(crc, 0xCBF43926, 'crc32 reference vector');
    r = await A('GET', `/owner/export.zip?from=2026-09-10&to=2026-09-01`); eq(r.status, 400, 'from > to refused');
    console.log('✓ zip export');

    // ── Schema check ───────────────────────────────────────────────────────
    const okRes = await schemaCheck.checkSchema(); eq(okRes.ok, true, 'live schema passes the check'); eq(okRes.missing.length, 0, 'nothing missing');
    const bad = await schemaCheck.checkSchema({ tables: ['users', 'no_such_table'], columns: { guests: ['no_such_col'], no_such_table: ['x'] } });
    eq(bad.ok, false, 'missing table detected'); ok(bad.missing.includes('table no_such_table'), 'names the table'); ok(bad.missing.includes('column guests.no_such_col'), 'names the column');
    eq(bad.missing.length, 2, 'a missing table is not double-reported for its columns');
    const lines = []; schemaCheck.logResult(bad, l => lines.push(l));
    ok(lines.some(l => l.includes('migrate-all.js')), 'log tells the operator the exact command');
    const h = await (await fetch(BASE + '/health')).json();
    ok(['ok', 'missing', 'unchecked'].includes(h.schema), '/health exposes schema state');
    console.log('✓ schema check');

    console.log(`\n✅ Owner gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Owner gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
