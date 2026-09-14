// backend/test/notify.smoke.js
// Sprint 12 gate. The two properties that matter: an alert never arrives
// twice, and nothing is ever sent without the warden tapping send.
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');
const notify = require('../services/notify');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

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
const monthsAgo = n => { const d = ist(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, purchases, guest_rent_history, deposit_refunds, guests, rooms, owner_reports, ai_proposals, ai_actions, ai_reads, day_closings, collection_variances, notifications, outbox, resident_documents RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    await A('POST', '/users', { username: 'smoke_nt_staff', password: 'staff123', role: 'staff' });
    r = await api('POST', '/auth/login', { username: 'smoke_nt_staff', password: 'staff123' }); staffTok = r.data.token;
    const room = (await A('POST', '/rooms', { room_number: 'N1', floor: 1, total_beds: 3, monthly_rent: 6000 })).data;
    // One resident three months behind (triggers the critical alert), one current.
    const behind = (await A('POST', '/guests', { name: 'Behind Bhavya', phone: '9600000001', room_id: room.id, join_date: monthsAgo(3), monthly_rent: 6000, deposit_amount: 12000 })).data;
    const fine = (await A('POST', '/guests', { name: 'Fine Farida', phone: '9600000002', room_id: room.id, join_date: today(), monthly_rent: 6000, deposit_amount: 12000 })).data;
    await A('POST', '/complaints', { category: 'Water', description: 'Notify test leak', guest_name: 'Room N1' });
    await pool.query(`UPDATE complaints SET sla_due_at = NOW() - INTERVAL '5 hours' WHERE status NOT IN ('resolved','closed')`);

    // ── Notifications: dedupe and ranking ─────────────────────────────────
    r = await S('POST', '/notifications/sweep'); eq(r.status, 200, 'sweep runs');
    const firstRun = r.data.created;
    ok(firstRun >= 2, `sweep produced alerts (${firstRun})`);
    r = await S('POST', '/notifications/sweep'); eq(r.data.created, 0, 'DEDUPE: a second sweep produces nothing new');
    r = await S('POST', '/notifications/sweep'); eq(r.data.created, 0, 'DEDUPE: and a third');
    r = await S('GET', '/notifications'); eq(r.status, 200, 'list');
    const items = r.data.items;
    eq((await A('GET', '/notifications')).data.items.length, firstRun, 'one row per trigger (admin sees them all)');
  ok(items.length <= firstRun, `staff sees the staff-facing subset (${items.length} of ${firstRun})`);
    ok(items.some(n => /two months or more behind/.test(n.title) && n.level === 'critical'), 'arrears alert is critical');
    ok(items.some(n => /past the promised time/.test(n.title)), 'SLA breach alert raised');
    const order = items.map(n => ['critical', 'important', 'informational', 'digest'].indexOf(n.level));
    ok(order.every((v, i) => i === 0 || v >= order[i - 1]), 'RANKING: critical first, digest last');
    // Role scoping
    const adminList = (await A('GET', '/notifications')).data;
    ok(adminList.items.length >= items.length, 'admin sees at least what staff sees');
    ok(!items.some(n => n.for_role === 'admin'), 'ROLE: staff never sees owner-only alerts');
    // Read state
    const one = items[0];
    r = await S('POST', `/notifications/${one.id}/read`); eq(r.data.changed, true, 'marked read');
    r = await S('POST', `/notifications/${one.id}/read`); eq(r.data.changed, false, 'reading twice changes nothing');
    r = await S('GET', '/notifications?unread=1');
    ok(!r.data.items.some(n => n.id === one.id), 'it drops out of the unread list');
    eq(r.data.unread, items.length - 1, 'unread count drops by one');
    r = await S('POST', '/notifications/read-all'); ok(r.data.cleared >= 1, 'read-all clears the rest');
    eq((await S('GET', '/notifications?unread=1')).data.unread, 0, 'nothing unread left');
    console.log('✓ notifications');

    // ── Outbox: drafts only, sending is a human act ───────────────────────
    r = await S('POST', '/outbox/draft'); eq(r.status, 200, 'drafting runs');
    r = await S('POST', '/outbox/draft'); eq(r.data.drafted, 0, 'DEDUPE: drafting twice does not duplicate a message');
    r = await S('GET', '/outbox'); eq(r.status, 200, 'outbox list');
    const drafts = r.data;
    ok(drafts.length >= 1, `messages drafted (${drafts.length})`);
    ok(drafts.every(m => m.status === 'draft'), 'MONEY/TRUST: everything is still a draft — nothing was sent');
    ok(drafts.every(m => m.wa_link && m.wa_link.startsWith('https://wa.me/91')), 'each carries a wa.me link with the country code');
    ok(drafts.every(m => decodeURIComponent(m.wa_link).includes(m.guest_name.split(' ')[0])), 'the message names the resident');
    ok(drafts.some(m => m.guest_id === behind.id), 'the resident in arrears is drafted');
    ok(!drafts.some(m => m.guest_id === fine.id && m.kind === 'rent_overdue'), 'a resident who joined this week is not chased as overdue');
    const draft = drafts[0];
    r = await S('POST', `/outbox/${draft.id}/sent`); eq(r.status, 200, 'warden marks it sent'); eq(r.data.status, 'sent', 'status updated');
    r = await S('POST', `/outbox/${draft.id}/sent`); eq(r.status, 409, 'it cannot be sent twice');
    const second = drafts[1];
    if (second) { r = await S('POST', `/outbox/${second.id}/skip`); eq(r.data.status, 'skipped', 'a draft can be skipped'); }
    r = await S('GET', '/outbox?status=sent'); eq(r.data.length, 1, 'the sent list has exactly the one');
    ok(r.data[0].sent_by_username.startsWith('smoke_nt'), 'and records who sent it');
    // An event-driven message
    const queued = await notify.queueMessage({ kind: 'payment_confirmed', guest_id: behind.id, extra: { amount: 6000 }, key: `pay:${behind.id}:test` });
    ok(queued && /6,000/.test(queued.body), 'a payment confirmation can be queued');
    const again = await notify.queueMessage({ kind: 'payment_confirmed', guest_id: behind.id, extra: { amount: 6000 }, key: `pay:${behind.id}:test` });
    eq(again, null, 'DEDUPE: the same event does not queue twice');
    console.log('✓ outbox');

    // ── Documents ─────────────────────────────────────────────────────────
    r = await S('GET', `/guests/${behind.id}/documents`); eq(r.status, 200, 'documents list');
    eq(r.data.length, 4, 'four document types'); ok(r.data.every(d => d.status === 'pending'), 'all pending to start');
    r = await S('PUT', `/guests/${behind.id}/documents`, { doc_type: 'Nonsense', status: 'verified' }); eq(r.status, 400, 'unknown document type refused');
    r = await S('PUT', `/guests/${behind.id}/documents`, { doc_type: 'Agreement', status: 'verified', expires_on: today() });
    eq(r.status, 200, 'document marked verified');
    r = await S('PUT', `/guests/${behind.id}/documents`, { doc_type: 'Agreement', status: 'expired' });
    eq(r.status, 200, 'and can be changed'); eq((await S('GET', `/guests/${behind.id}/documents`)).data.filter(d => d.doc_type === 'Agreement').length, 1, 'without creating a second row');
    // An expiring document raises exactly one notification
    await pool.query(`UPDATE resident_documents SET expires_on = CURRENT_DATE + 10, status='verified' WHERE guest_id=$1`, [behind.id]);
    await pool.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'doc:%'`);
    await S('POST', '/notifications/sweep');
    const docAlerts = (await S('GET', '/notifications')).data.items.filter(n => /expires soon|has expired/.test(n.title));
    eq(docAlerts.length, 1, 'one alert for the expiring document');
    await S('POST', '/notifications/sweep');
    eq((await S('GET', '/notifications')).data.items.filter(n => /expires soon|has expired/.test(n.title)).length, 1, 'DEDUPE: still one after another sweep');
    console.log('✓ documents');

    // ── Recurring maintenance ─────────────────────────────────────────────
    r = await S('GET', '/maintenance-schedule'); eq(r.status, 200, 'schedule list'); ok(r.data.length >= 4, 'seeded tasks present');
    r = await S('POST', '/maintenance-schedule', { task: 'Lift service', every_days: 30 }); eq(r.status, 403, 'staff cannot add to the schedule');
    r = await A('POST', '/maintenance-schedule', { task: 'Lift service', vendor: 'Otis', every_days: 30 }); eq(r.status, 201, 'admin adds one');
    const lift = r.data;
    eq(String(lift.next_due).slice(0, 10), new Date(Date.now() + 30 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10), 'next due = today + interval');
    r = await S('POST', `/maintenance-schedule/${lift.id}/done`, { date: today() });
    eq(r.status, 200, 'staff can mark it done');
    eq(String(r.data.last_done).slice(0, 10), today(), 'last done recorded');
    ok(String(r.data.next_due).slice(0, 10) > today(), 'and it schedules itself again');
    r = await A('DELETE', `/maintenance-schedule/${lift.id}`); eq(r.status, 200, 'admin can remove it');
    ok(!(await S('GET', '/maintenance-schedule')).data.some(x => x.id === lift.id), 'it leaves the list');
    console.log('✓ maintenance');

    // ── AI metrics ────────────────────────────────────────────────────────
    r = await S('GET', '/ai-metrics'); eq(r.status, 403, 'metrics are the owner’s view');
    r = await A('GET', '/ai-metrics'); eq(r.status, 200, 'metrics');
    const m = r.data;
    ok('acceptance_rate' in m && 'clarification_rate' in m, 'acceptance and clarification rates reported');
    ok(m.entries_by_source && typeof m.ai_entry_share === 'number', 'entry sources reported');
    eq(m.reminders_sent, 1, 'counts the message the warden actually sent');
    // With a real proposal in play the acceptance rate must be computable
    await pool.query(`INSERT INTO ai_proposals(id, user_id, tool, args, expires_at, confirmed_at) VALUES(gen_random_uuid(), 1, 'create_payment', '{}'::jsonb, NOW()+INTERVAL '10 min', NOW())`);
    await pool.query(`INSERT INTO ai_proposals(id, user_id, tool, args, expires_at) VALUES(gen_random_uuid(), 1, 'create_payment', '{}'::jsonb, NOW()+INTERVAL '10 min')`);
    const m2 = (await A('GET', '/ai-metrics')).data;
    eq(m2.proposals, 2, 'both proposals counted'); eq(m2.confirmed, 1, 'one confirmed'); eq(m2.acceptance_rate, 50, 'acceptance rate = confirmed ÷ shown');
    ok(/Acceptance is proposals confirmed/.test(m2.note), 'the page explains what the number means');
    console.log('✓ ai metrics');

    // ── Scheduler: once per hour, not per tick ────────────────────────────
    notify._reset();
    await pool.query('DELETE FROM notifications');
    const logs = [];
    const sch = notify.startScheduler({ intervalMs: 60000, log: l => logs.push(l) });
    await sch.tick(); await sch.tick(); await sch.tick();
    sch.stop();
    const created = (await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n;
    ok(created >= 1, 'the scheduler swept once');
    eq(logs.filter(l => /new notification/.test(l)).length, 1, 'and only once across three ticks');
    console.log('✓ scheduler');

    console.log(`\n✅ Notify gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Notify gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
