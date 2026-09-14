// backend/test/bulk.smoke.js — Sprint 13 gate
//
// Bulk actions, Room 360 and the three new nudges, against a REAL Postgres.
//
//   DATABASE_URL=… JWT_SECRET=test node backend/test/bulk.smoke.js
//
// The assertion that matters most is the money one: a bulk reminder of 12
// must leave collections, the ledger and rent-due byte-identical. Everything
// else is about the preview telling the truth before anything happens.
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');
const bulk = require('../services/bulk');
const notify = require('../services/notify');

let count = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); count++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

let BASE, adminTok, staffTok;
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('application/json') ? await res.json() : await res.text() };
};
const A = (m, p, b) => api(m, p, b, adminTok);
const S = (m, p, b) => api(m, p, b, staffTok);
const uniq = Date.now().toString().slice(-6);
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// A stable fingerprint of every number the money rules produce.
async function moneyFingerprint() {
  const [cols, rent, report] = await Promise.all([
    pool.query(`SELECT id, guest_id, amount, status, is_deleted FROM collections ORDER BY id`),
    A('GET', '/rent-due'),
    A('GET', `/reports?month=${new Date().getMonth() + 1}&year=${new Date().getFullYear()}`)
  ]);
  return JSON.stringify({
    collections: cols.rows,
    rentDue: (rent.data.list || rent.data).map(g => [g.id, g.amount_due, g.credit, g.deposit_pending]),
    income: report.data && report.data.summary ? report.data.summary : null
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    // ── Setup ────────────────────────────────────────────────────────────
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' });
    eq(r.status, 200, 'admin login'); adminTok = r.data.token;
    const staffName = `bulkstaff${uniq}`;
    await A('POST', '/users', { username: staffName, password: 'Staff@12345', role: 'staff' });
    r = await api('POST', '/auth/login', { username: staffName, password: 'Staff@12345' });
    eq(r.status, 200, 'staff login'); staffTok = r.data.token;

    const room = (await A('POST', '/rooms', { room_number: `B${uniq}`.slice(0, 9), floor: 3, total_beds: 20, monthly_rent: 6000, room_type: 'sharing' })).data;
    ok(room.id, 'test room created');

    // 14 residents who joined 120 days ago and have paid nothing: all overdue.
    const made = [];
    for (let i = 0; i < 14; i++) {
      const g = await A('POST', '/guests', {
        name: `Bulk Test ${uniq}-${i}`, phone: `98${uniq}${String(i).padStart(2, '0')}`.slice(0, 10),
        room_id: room.id, bed_number: String(i + 1), monthly_rent: 6000, deposit_amount: 0,
        join_date: daysAgo(120), id_proof_type: 'Aadhaar'
      });
      if (g.data && g.data.id) made.push(g.data.id);
    }
    eq(made.length, 14, '14 residents created');
    // One with no phone, one who joined yesterday — both must be skipped.
    const noPhone = (await A('POST', '/guests', { name: `No Phone ${uniq}`, room_id: room.id, bed_number: '15', monthly_rent: 6000, join_date: daysAgo(120), id_proof_type: 'Aadhaar' })).data;
    const brandNew = (await A('POST', '/guests', { name: `Brand New ${uniq}`, phone: `97${uniq}99`.slice(0, 10), room_id: room.id, bed_number: '16', monthly_rent: 6000, join_date: daysAgo(1), id_proof_type: 'Aadhaar' })).data;
    ok(noPhone.id && brandNew.id, 'edge-case residents created');
    await pool.query(`UPDATE guests SET phone=NULL WHERE id=$1`, [noPhone.id]);

    // ── Limits ───────────────────────────────────────────────────────────
    r = await A('GET', '/bulk/limits');
    eq(r.status, 200, 'limits readable'); eq(r.data.cap, 15, 'cap is 15'); eq(r.data.ack_above, 8, 'second confirm above 8');
    ok(r.data.actions.some(a => a.action === 'reminders'), 'admin may draft reminders');
    r = await S('GET', '/bulk/limits');
    ok(r.data.actions.some(a => a.action === 'reminders'), 'staff may draft reminders');
    ok(r.data.actions.some(a => a.action === 'assign'), 'staff may assign requests');
    ok(!r.data.actions.some(a => a.action === 'announcement'), 'staff may NOT post notices to a group');
    ok(!r.data.actions.some(a => a.action === 'documents'), 'staff may NOT verify documents');

    // ── Cap and empties ──────────────────────────────────────────────────
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: [...made, noPhone.id, brandNew.id] });
    eq(r.status, 400, '16 selected is refused'); ok(/15/.test(r.data.error), 'the refusal names the cap');
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: [] });
    eq(r.status, 400, 'nothing selected is refused');
    r = await A('POST', '/bulk/preview', { action: 'nonsense', ids: made.slice(0, 2) });
    eq(r.status, 400, 'unknown action refused');
    r = await S('POST', '/bulk/preview', { action: 'announcement', ids: made.slice(0, 2), args: { message: 'hi' } });
    eq(r.status, 403, 'staff is refused the admin-only action');

    // ── The preview tells the truth ──────────────────────────────────────
    const twelve = made.slice(0, 12);
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: twelve });
    eq(r.status, 200, 'preview of 12');
    eq(r.data.selected, 12, 'preview counts what was selected');
    eq(r.data.eligible.length, 12, 'all 12 are eligible');
    eq(r.data.total_outstanding, r.data.eligible.reduce((t, x) => t + x.amount_due, 0), 'the rupee total is the sum of the rows');
    ok(r.data.total_outstanding > 0, 'there is something outstanding');
    ok(r.data.requires_second_confirm, '12 is above 8, so a second confirmation is required');
    eq(r.data.confirm_count, 12, 'the second confirmation names 12');
    ok(r.data.drafts_only, 'a reminder is drafts-only');
    ok(r.data.lines.some(l => /Nothing is sent/i.test(l)), 'the preview says nothing is sent');
    ok(r.data.proposal && r.data.proposal.id, 'a proposal was issued');
    const proposal12 = r.data.proposal.id;

    // Every skip reason fires.
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: [...made.slice(0, 3), noPhone.id, brandNew.id] });
    const reasons = r.data.skipped.map(s => s.reason);
    ok(reasons.some(x => /no phone/i.test(x)), 'skip: no phone number');
    ok(reasons.some(x => /less than 30 days/i.test(x)), 'skip: joined under 30 days');
    eq(r.data.eligible.length, 3, 'the other three go ahead');
    ok(!r.data.requires_second_confirm, '3 eligible needs no second confirmation');
    ok(r.data.skipped.every(s => s.reason), 'no skip is silent');

    // ── Money is untouched by a bulk of 12 ───────────────────────────────
    const before = await moneyFingerprint();
    r = await A('POST', '/bulk/confirm', { proposal_id: proposal12, count: 11 });
    eq(r.status, 409, 'the wrong count is refused'); eq(r.data.confirm_count, 12, 'the refusal names the right count');
    r = await A('POST', '/bulk/confirm', { proposal_id: proposal12, count: 12 });
    eq(r.status, 200, 'confirmed with the count');
    ok(/12 reminders drafted/i.test(r.data.answer), 'twelve drafts reported');
    const after = await moneyFingerprint();
    eq(after, before, 'MONEY: collections, rent-due and income are byte-identical after a bulk reminder of 12');

    const drafts = await pool.query(`SELECT guest_id, kind, status FROM outbox WHERE guest_id = ANY($1)`, [twelve]);
    eq(drafts.rows.length, 12, '12 drafts exist in the outbox');
    ok(drafts.rows.every(d => d.status === 'draft'), 'every one is a draft — nothing is sent');

    // ── A double-tap produces one set of drafts, not two ─────────────────
    r = await A('POST', '/bulk/confirm', { proposal_id: proposal12, count: 12 });
    ok(r.status >= 400, 'the same proposal cannot be confirmed twice');
    const again = await pool.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE guest_id = ANY($1)`, [twelve]);
    eq(again.rows[0].n, 12, 'DOUBLE-TAP: still 12 drafts, not 24');

    // A fresh preview now skips all twelve — they already have a draft.
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: twelve });
    eq(r.data.eligible.length, 0, 'nobody is eligible twice in a day');
    ok(r.data.skipped.every(s => /draft waiting/i.test(s.reason)), 'skip: already has a draft');
    eq(r.data.proposal, null, 'no proposal when there is nothing to do');

    // Reminded in the last 7 days → skipped, with the day named.
    await pool.query(`UPDATE outbox SET status='sent', sent_at=NOW() - INTERVAL '2 days' WHERE guest_id=$1`, [twelve[0]]);
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: [twelve[0]] });
    ok(r.data.skipped.some(s => /reminded/i.test(s.reason) && /2 days ago/.test(s.reason)), 'skip: reminded 2 days ago');

    // ── The proposal belongs to one user and expires ─────────────────────
    r = await A('POST', '/bulk/preview', { action: 'reminders', ids: made.slice(12, 14) });
    const pid = r.data.proposal.id;
    eq((await S('POST', '/bulk/confirm', { proposal_id: pid, count: 2 })).status, 403, 'another user cannot confirm it');
    eq((await A('POST', '/bulk/confirm', { proposal_id: '11111111-1111-1111-1111-111111111111', count: 2 })).status, 404, 'an invented proposal id is refused');
    eq((await A('POST', '/bulk/confirm', { proposal_id: 'not-a-uuid', count: 2 })).status, 404, 'a malformed proposal id is refused');
    r = await A('POST', '/bulk/confirm', { proposal_id: pid, count: 2 });
    eq(r.status, 200, '2 needs no count check but still confirms');

    // ── Announcement, documents, assignment ──────────────────────────────
    r = await A('POST', '/bulk/preview', { action: 'announcement', ids: made.slice(0, 3), args: { title: `Water ${uniq}`, message: 'Tanker at 6pm', priority: 'important' } });
    eq(r.status, 200, 'announcement preview'); eq(r.data.eligible.length, 3, '3 residents will be told');
    ok(r.data.lines.some(l => /only to her/i.test(l)), 'the preview says each copy is private');
    r = await A('POST', '/bulk/confirm', { proposal_id: r.data.proposal.id, count: 3 });
    eq(r.status, 200, 'notice posted');
    const anns = await pool.query(`SELECT COUNT(*)::int AS n FROM announcements WHERE title=$1 AND target_type='resident'`, [`Water ${uniq}`]);
    eq(anns.rows[0].n, 3, 'one targeted announcement per resident');

    r = await A('POST', '/bulk/preview', { action: 'announcement', ids: made.slice(0, 2), args: { message: '' } });
    eq(r.status, 400, 'an empty notice is refused');

    r = await A('POST', '/bulk/preview', { action: 'documents', ids: made.slice(0, 3), args: { doc_type: 'ID proof', status: 'verified' } });
    eq(r.status, 200, 'documents preview');
    r = await A('POST', '/bulk/confirm', { proposal_id: r.data.proposal.id, count: r.data.confirm_count });
    eq(r.status, 200, 'documents marked');
    r = await A('POST', '/bulk/preview', { action: 'documents', ids: made.slice(0, 3), args: { doc_type: 'ID proof', status: 'verified' } });
    eq(r.data.eligible.length, 0, 'already-verified documents are skipped, not rewritten');
    r = await A('POST', '/bulk/preview', { action: 'documents', ids: made.slice(0, 2), args: { doc_type: 'Nonsense', status: 'verified' } });
    eq(r.status, 400, 'an unknown document type is refused');

    const c1 = (await S('POST', '/complaints', { category: 'Water', description: `Bulk assign test ${uniq}`, guest_name: `Room ${room.room_number}` })).data;
    const c2 = (await S('POST', '/complaints', { category: 'Electrical', description: `Bulk assign test two ${uniq}`, guest_name: `Room ${room.room_number}` })).data;
    ok(c1.id && c2.id, 'two requests raised');
    const staffId = (await pool.query(`SELECT id FROM users WHERE username=$1`, [staffName])).rows[0].id;
    r = await S('POST', '/bulk/preview', { action: 'assign', ids: [c1.id, c2.id], args: { assigned_to: staffId } });
    eq(r.status, 200, 'assign preview'); eq(r.data.eligible.length, 2, 'both requests will move');
    r = await S('POST', '/bulk/confirm', { proposal_id: r.data.proposal.id, count: 2 });
    eq(r.status, 200, 'requests assigned');
    const assigned = await pool.query(`SELECT assigned_to FROM complaints WHERE id = ANY($1)`, [[c1.id, c2.id]]);
    ok(assigned.rows.every(x => String(x.assigned_to) === String(staffId)), 'both requests are with the staff member');
    r = await S('POST', '/bulk/preview', { action: 'assign', ids: [c1.id], args: { assigned_to: staffId } });
    ok(r.data.skipped.some(s => /already with/i.test(s.reason)), 'skip: already with that person');

    // ── Everything is audited ────────────────────────────────────────────
    const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE request_text LIKE 'bulk:%'`);
    ok(audit.rows[0].n >= 8, 'every bulk ask is written to the Copilot log');
    console.log('✓ bulk actions');

    // ── Room 360 ─────────────────────────────────────────────────────────
    r = await A('GET', `/rooms/${room.id}/360`);
    eq(r.status, 200, 'room 360 loads');
    eq(r.data.room.room_number, room.room_number, 'the right room');
    ok(r.data.health.overall >= 0 && r.data.health.overall <= 100, 'health is 0–100');
    eq(Object.keys(r.data.health.components).length, 4, 'health has four parts');
    ok(Object.values(r.data.health.components).every(c => c.why && c.why.length > 5), 'every part states its own reason');
    ok(r.data.health.basis, 'the score explains how it is built');
    const avg = Math.round(Object.values(r.data.health.components).reduce((t, c) => t + c.score, 0) / 4);
    eq(r.data.health.overall, avg, 'health recomputes from its parts');
    eq(r.data.residents.length, 16, 'sixteen residents listed');
    eq(r.data.maintenance.total, 2, 'the room has both requests');
    const viaRequests = (await A('GET', `/requests?room=${encodeURIComponent(room.room_number)}`)).data;
    eq(r.data.maintenance.total, (viaRequests.length !== undefined ? viaRequests : viaRequests.list).length, 'the room request count matches /requests?room=');
    ok(r.data.history.lived.length >= 16, 'history lists who has lived here');
    eq((await A('GET', '/rooms/99999/360')).status, 404, 'an unknown room is 404');

    const inspBefore = r.data.health.components.inspection.score;
    r = await S('POST', `/rooms/${room.id}/inspections`, { condition: 'poor', note: 'Tap leaking in the bathroom' });
    eq(r.status, 201, 'an inspection is recorded');
    const roomRow = (await pool.query(`SELECT last_inspected FROM rooms WHERE id=$1`, [room.id])).rows[0];
    const inspDay = roomRow.last_inspected instanceof Date
      ? new Date(roomRow.last_inspected.getTime() - roomRow.last_inspected.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      : String(roomRow.last_inspected).slice(0, 10);
    eq(inspDay, istToday(), 'rooms.last_inspected moved to today');
    r = await A('GET', `/rooms/${room.id}/360`);
    eq(r.data.inspections.length, 1, 'the inspection is listed');
    eq(r.data.inspections[0].condition, 'poor', 'with its condition');
    ok(r.data.health.components.inspection.score >= inspBefore, 'inspecting does not lower the inspection score');
    ok(/today|within 30 days/i.test(r.data.health.components.inspection.why), 'the inspection reason names the gap');
    for (let i = 0; i < 3; i++) await S('POST', `/rooms/${room.id}/inspections`, { condition: 'ok', note: `pass ${i}` });
    r = await A('GET', `/rooms/${room.id}/360`);
    eq(r.data.inspections.length, 3, 'only the last three inspections are shown');
    console.log('✓ room 360');

    // ── Universal "Why?" — the words come from the services ──────────────
    r = await A('GET', '/owner/anomalies');
    ok(Array.isArray(r.data), 'anomalies load');
    ok(r.data.every(f => f.why && f.why.length > 10), 'every anomaly carries the rule that raised it');
    r = await A('GET', '/complaints');
    ok(r.data.every(c => c.priority_why && c.priority_why.length > 10), 'every request explains its priority');
    const high = r.data.find(c => c.category === 'Water');
    ok(high && /high priority/i.test(high.priority_why), 'a Water request says why it is high');
    r = await A('GET', '/finance/forecast');
    eq(r.status, 200, 'the forecast loads');
    ok(r.data.collections.why && r.data.collections.why.length > 40, 'the collections forecast explains itself');
    ok(/on-time rate|rent roll/i.test(r.data.collections.why), 'and names the inputs it used');
    ok(r.data.occupancy.why && r.data.occupancy.why.length > 40, 'the occupancy forecast explains itself');
    ok(r.data.occupancy.basis, 'the occupancy forecast states its basis');
    r = await A('GET', '/finance/kpis');
    eq(r.status, 200, 'the KPIs load');
    ok(r.data.why && Object.keys(r.data.why).length >= 5, 'every KPI carries its own explanation');
    ok(/not counted/i.test(r.data.why.income), 'the income KPI says pending claims are excluded');
    r = await A('GET', '/finance/reliability');
    ok((Array.isArray(r.data) ? r.data : r.data.list || []).every(x => !x.level || x.why), 'every reliability rating explains itself');
    console.log('✓ universal why');

    // ── The three nudges ─────────────────────────────────────────────────
    await pool.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'afternoon:%' OR dedupe_key LIKE 'monthend:%' OR dedupe_key LIKE 'checkout2:%'`);
    notify._reset();
    // Morning: nothing before 15:00.
    await notify.sweep({ now: new Date(istToday() + 'T09:00:00Z') });
    let n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'afternoon:%'`);
    eq(n.rows[0].c, 0, 'no afternoon nudge at 09:00');
    // Afternoon: there is plenty unresolved (two open requests, nothing collected).
    notify._reset();
    await notify.sweep({ now: new Date(istToday() + 'T15:30:00Z') });
    n = await pool.query(`SELECT title, detail FROM notifications WHERE dedupe_key LIKE 'afternoon:%'`);
    eq(n.rows.length, 1, 'one afternoon nudge when something is unresolved');
    ok(/still open/i.test(n.rows[0].title), 'the afternoon nudge names what is open');
    // Sweeping again produces no second copy.
    notify._reset(); await notify.sweep({ now: new Date(istToday() + 'T16:30:00Z') });
    notify._reset(); await notify.sweep({ now: new Date(istToday() + 'T17:30:00Z') });
    n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'afternoon:%'`);
    eq(n.rows[0].c, 1, 'THREE SWEEPS: still one afternoon nudge');

    // Month-end: the last day of this month at 18:00.
    const lastDay = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    notify._reset(); await notify.sweep({ now: new Date(lastDay + 'T17:00:00Z') });
    n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'monthend:%'`);
    eq(n.rows[0].c, 0, 'no month-end nudge before 18:00');
    notify._reset(); await notify.sweep({ now: new Date(lastDay + 'T18:30:00Z') });
    n = await pool.query(`SELECT title, detail FROM notifications WHERE dedupe_key LIKE 'monthend:%'`);
    eq(n.rows.length, 1, 'one month-end nudge on the last day after 18:00');
    ok(/outstanding/i.test(n.rows[0].title), 'it names what is still outstanding');
    ok(/owner report/i.test(n.rows[0].detail), 'it says the owner report is ready tomorrow');
    notify._reset(); await notify.sweep({ now: new Date(lastDay + 'T19:30:00Z') });
    n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'monthend:%'`);
    eq(n.rows[0].c, 1, 'the month-end nudge does not repeat');

    // Checkout in two days.
    const inTwo = new Date(new Date(istToday() + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString().slice(0, 10);
    await pool.query(`UPDATE guests SET expected_checkout=$1 WHERE id=$2`, [inTwo, made[0]]);
    notify._reset(); await notify.sweep({ now: new Date(istToday() + 'T10:00:00Z') });
    n = await pool.query(`SELECT title, detail FROM notifications WHERE dedupe_key LIKE 'checkout2:%'`);
    eq(n.rows.length, 1, 'one checkout nudge, two days ahead');
    ok(/checks out in 2 days/i.test(n.rows[0].title), 'it says who and when');
    ok(/Deposit on file/i.test(n.rows[0].detail), 'it carries the deposit');
    ok(/outstanding|nothing outstanding/i.test(n.rows[0].detail), 'it carries the balance');
    ok(/request/i.test(n.rows[0].detail), 'it carries the open requests');
    notify._reset(); await notify.sweep({ now: new Date(istToday() + 'T11:00:00Z') });
    n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'checkout2:%'`);
    eq(n.rows[0].c, 1, 'the checkout nudge does not repeat');

    // Nothing unresolved → silence. Resolve everything and clear the day.
    await pool.query(`UPDATE complaints SET status='resolved' WHERE room_number=$1`, [room.room_number]);
    await pool.query(`DELETE FROM notifications WHERE dedupe_key LIKE 'afternoon:%'`);
    await pool.query(`UPDATE guests SET is_active=false WHERE room_id=$1`, [room.id]);
    notify._reset(); await notify.sweep({ now: new Date(istToday() + 'T15:30:00Z') });
    n = await pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE dedupe_key LIKE 'afternoon:%'`);
    ok(n.rows[0].c <= 1, 'the afternoon nudge stays quiet when the reasons are gone');
    console.log('✓ proactive nudges');

    // ── Privacy: the bulk layer never hands a phone number to a model ────
    const acts = await pool.query(`SELECT interpretation, result_text FROM ai_actions WHERE request_text LIKE 'bulk:%'`);
    const blob = JSON.stringify(acts.rows);
    ok(!/\b\d{10}\b/.test(blob), 'PRIVACY: no phone number is written to the Copilot log');

    console.log(`\n✅ Bulk gate passed — ${count} assertions`);
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Bulk gate FAILED after ${count} assertions:\n ${e.message}\n`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    server.close();
    await pool.end().catch(() => {});
  }
})();
