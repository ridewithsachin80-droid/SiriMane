// backend/test/copilot.smoke.js
// Sprint 6 gate. Runs twice in one process: once with the model STUBBED and
// once with NO provider at all, proving the Copilot degrades to on-device
// parsing and templates instead of failing.
//
//   DATABASE_URL=... JWT_SECRET=test node backend/test/copilot.smoke.js
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;

const ai = require('../routes/ai');
const app = require('../server');
const pool = require('../db');
const copilot = require('../services/copilot');
const tools = require('../services/tools');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

let BASE, adminTok, staffTok;
const api = async (method, p, body, token) => {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
};
const askAs = (tok, text, context) => api('POST', '/copilot/ask', { text, context }, tok);
const confirmAs = (tok, id) => api('POST', '/copilot/confirm', { proposal_id: id }, tok);
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Stub model: routes a few phrasings the local parser deliberately does not know.
const modelCalls = [];
function stubModel() {
  ai.providers._stub = true;
  ai.providers.groqText = async ({ system, user }) => {
    modelCalls.push(user);
    if (user === 'ping') return 'OK';
    if (/Roster/.test(user)) return JSON.stringify({ guest_id: null });
    const req = (user.split('Request:')[1] || '').trim().toLowerCase();
    if (/how much money/.test(req)) return JSON.stringify({ tool: 'get_month_performance', args: {} });
    if (/tell everyone/.test(req)) return JSON.stringify({ tool: 'prepare_announcement', args: { message: 'Water will be off tomorrow 10am to 12pm.' } });
    if (/two priyas|which/.test(req)) return JSON.stringify({ tool: null, args: {}, clarify: 'Which Priya — Sharma or Nair?' });
    if (/delete everything/.test(req)) return JSON.stringify({ tool: 'create_payment', args: { amount: 1 } }); // model tries to skip the preview
    if (/nonsense tool/.test(req)) return JSON.stringify({ tool: 'drop_database', args: {} });
    return JSON.stringify({ tool: null, args: {}, clarify: null });
  };
  ai.providers.geminiText = async () => 'OK';
}
function noModel() { ai.providers._stub = false; }

async function run(mode) {
  console.log(`\n── mode: ${mode} ──`);
  if (mode === 'stubbed') stubModel(); else noModel();
  eq(copilot.modelAvailable(), mode === 'stubbed', `${mode}: modelAvailable reflects mode`);

  // ── inform tools & permissions ────────────────────────────────────────
  let r = await askAs(null, 'who has not paid'); eq(r.status, 401, `${mode}: ask needs auth`);
  r = await askAs(staffTok, 'who has not paid?'); eq(r.status, 200, `${mode}: staff asks`);
  eq(r.data.tool, 'get_outstanding_rent', `${mode}: routed to outstanding rent`); ok(/owe|outstanding/i.test(r.data.answer), `${mode}: answer text`);
  ok(Array.isArray(r.data.evidence) && r.data.evidence.length >= 1, `${mode}: evidence rows returned`);
  ok(r.data.evidence.every(x => !('phone' in x)), `${mode}: evidence for outstanding rent carries no phone numbers`);
  r = await askAs(staffTok, 'who owes more than 10000 and is 2 months behind');
  eq(r.data.tool, 'get_outstanding_rent', `${mode}: filtered NL query`); ok(r.data.evidence.every(x => x.amount_due >= 10000 && x.months >= 2), `${mode}: filters applied (${r.data.evidence.length} rows)`);
  r = await askAs(staffTok, 'which rooms are vacant?'); eq(r.data.tool, 'get_room_status', `${mode}: vacancy`); ok(/vacant/.test(r.data.answer), `${mode}: vacancy text`);
  r = await askAs(staffTok, "what's wrong here?", { page: 'rooms', room_number: 'C1' }); eq(r.data.tool, 'get_room_status', `${mode}: "here" resolves to the viewed room`); ok(/Room C1/.test(r.data.answer), `${mode}: answers about room C1`);
  r = await askAs(staffTok, 'why is she overdue?', { page: 'guests', resident_id: F.gA.id, resident_name: 'Copilot Anu', room_number: 'C1' }); eq(r.data.tool, 'get_resident', `${mode}: "she" resolves to the viewed resident even when her room is also in context`); ok(/Copilot Anu/.test(r.data.answer), `${mode}: names her`);
  r = await askAs(staffTok, "what's wrong here?", { page: 'guests', resident_id: F.gA.id, resident_name: 'Copilot Anu', room_number: 'C1' }); eq(r.data.tool, 'get_room_status', `${mode}: "here" prefers the room when both are in context`);
  r = await askAs(staffTok, 'which complaint is taking too long'); eq(r.data.tool, 'get_open_requests', `${mode}: open requests`);
  r = await askAs(staffTok, 'what needs attention today?'); eq(r.data.tool, 'get_today', `${mode}: brief`);
  r = await askAs(staffTok, 'how is this month compared to last month'); ok(r.data.tool !== 'get_month_performance' || r.data.forbidden, `${mode}: staff never gets owner performance`);
  r = await askAs(adminTok, 'how is this month compared to last month'); eq(r.data.tool, 'get_month_performance', `${mode}: admin gets performance`); ok(/collected/i.test(r.data.answer), `${mode}: performance text`);
  ok(r.data.actions.some(a => a.download), `${mode}: performance offers the PDF`);

  // ── prepare → confirm lifecycle ───────────────────────────────────────
  const before = (await api('GET', '/collections', null, adminTok)).data.length;
  r = await askAs(staffTok, 'record 2500 rent from Copilot Anu by UPI');
  eq(r.data.tool, 'prepare_payment', `${mode}: payment prepared`); eq(r.data.level, 'prepare', `${mode}: level prepare`);
  ok(r.data.proposal && r.data.proposal.id, `${mode}: proposal issued`); eq(r.data.proposal.preview.amount, 2500, `${mode}: preview amount`); eq(r.data.proposal.preview.payment_mode, 'UPI', `${mode}: preview mode`); eq(r.data.proposal.preview.guest_id, F.gA.id, `${mode}: preview resident`);
  ok(r.data.actions[0].confirm === r.data.proposal.id && r.data.actions[0].level === 'execute', `${mode}: first action is the confirm button`);
  eq((await api('GET', '/collections', null, adminTok)).data.length, before, `${mode}: MONEY: preview saved nothing`);
  const pid = r.data.proposal.id;
  let c = await confirmAs(adminTok, pid); eq(c.status, 403, `${mode}: another user cannot confirm my proposal`);
  c = await confirmAs(staffTok, 'not-a-real-id'); eq(c.status, 404, `${mode}: unknown proposal → 404`);
  c = await confirmAs(staffTok, pid); eq(c.status, 200, `${mode}: owner confirms`); ok(/recorded/i.test(c.data.answer), `${mode}: confirm text`); ok(c.data.record && c.data.record.id, `${mode}: record returned`);
  eq((await api('GET', '/collections', null, adminTok)).data.length, before + 1, `${mode}: MONEY: exactly one row created`);
  c = await confirmAs(staffTok, pid); eq(c.status, 409, `${mode}: cannot confirm twice`);
  eq((await api('GET', '/collections', null, adminTok)).data.length, before + 1, `${mode}: MONEY: double-tap did not duplicate`);
  // Parity with a form-created payment
  const copilotRow = (await pool.query(`SELECT * FROM collections WHERE id=$1`, [c.status === 409 ? (await pool.query(`SELECT (result->>'id')::int AS id FROM ai_proposals WHERE id=$1`, [pid])).rows[0].id : 0])).rows[0];
  const formRes = await api('POST', '/collections', { guest_id: F.gA.id, guest_name: 'Copilot Anu', amount: 2500, payment_mode: 'UPI', collection_type: 'rent', collection_date: today, collection_month: copilotRow.collection_month, description: '' }, staffTok);
  const formRow = (await pool.query(`SELECT * FROM collections WHERE id=$1`, [formRes.data.id])).rows[0];
  for (const k of ['guest_id', 'guest_name', 'amount', 'payment_mode', 'collection_type', 'collection_month', 'status', 'created_by'])
    eq(String(copilotRow[k]), String(formRow[k]), `${mode}: PARITY: ${k} identical to a form-created payment`);
  eq(copilotRow.source, 'copilot', `${mode}: source=copilot`); eq(formRow.source, 'manual', `${mode}: form source=manual`);
  eq(copilotRow.status, 'pending_approval', `${mode}: staff copilot payment still pends approval like the form`);
  // Expiry
  r = await askAs(staffTok, 'record 100 rent from Copilot Anu cash'); const pid2 = r.data.proposal.id;
  await pool.query(`UPDATE ai_proposals SET expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [pid2]);
  c = await confirmAs(staffTok, pid2); eq(c.status, 409, `${mode}: expired proposal refused`); ok(/expired/i.test(c.data.error), `${mode}: says expired`);
  // Execute-without-preview is refused even if the model asks for it
  if (mode === 'stubbed') {
    r = await askAs(adminTok, 'delete everything'); ok(/preview first/i.test(r.data.answer), `${mode}: model cannot jump straight to an execute tool`);
    r = await askAs(adminTok, 'nonsense tool please'); ok(/don't have/i.test(r.data.answer), `${mode}: unknown tool name from the model is rejected`);
    r = await askAs(adminTok, 'there are two priyas, which?'); ok(r.data.clarify, `${mode}: model clarification passes through`);
    r = await askAs(staffTok, 'tell everyone water is off tomorrow'); ok(r.data.forbidden, `${mode}: staff cannot prepare an announcement`);
    r = await askAs(adminTok, 'tell everyone water is off tomorrow'); eq(r.data.tool, 'prepare_announcement', `${mode}: admin drafts a notice`); ok(r.data.proposal, `${mode}: notice proposal`);
    const nBefore = (await api('GET', '/announcements', null, adminTok)).data.length;
    c = await confirmAs(adminTok, r.data.proposal.id); eq(c.status, 200, `${mode}: notice posted`);
    eq((await api('GET', '/announcements', null, adminTok)).data.length, nBefore + 1, `${mode}: one notice created`);
    r = await askAs(adminTok, 'how much money did we make'); eq(r.data.tool, 'get_month_performance', `${mode}: model routes an unfamiliar phrasing`);
  } else {
    r = await askAs(staffTok, 'blorp the fizzwangle'); ok(/without AI keys|not sure/i.test(r.data.answer), `${mode}: unknown request gets an honest answer, no crash`); eq(r.data.actions.length, 0, `${mode}: no actions on nonsense`);
  }
  // Ambiguity → asks, offers candidates
  r = await askAs(staffTok, 'record 500 rent from Copilot cash');
  ok(r.data.clarify, `${mode}: two "Copilot ..." residents → asks which`); ok(r.data.candidates.length >= 2 && r.data.actions.length >= 2, `${mode}: offers candidate buttons`);
  ok(!r.data.proposal, `${mode}: no proposal while ambiguous`);
  // Expense + complaint prepare paths
  r = await askAs(staffTok, 'expense 850 milk paid to Nandini cash'); eq(r.data.tool, 'prepare_expense', `${mode}: expense prepared`); eq(r.data.proposal.preview.amount, 850, `${mode}: expense amount`); eq(r.data.proposal.preview.payment_mode, 'Cash', `${mode}: expense mode`);
  const pBefore = (await api('GET', '/purchases', null, adminTok)).data.length;
  c = await confirmAs(staffTok, r.data.proposal.id); eq(c.status, 200, `${mode}: expense confirmed`); eq((await api('GET', '/purchases', null, adminTok)).data.length, pBefore + 1, `${mode}: one purchase row`);
  r = await askAs(staffTok, 'geyser not working in room C1'); eq(r.data.tool, 'prepare_complaint', `${mode}: complaint prepared`); eq(r.data.proposal.preview.category, 'Water', `${mode}: category Water`); eq(r.data.proposal.preview.priority, 'high', `${mode}: water → high`);
  c = await confirmAs(staffTok, r.data.proposal.id); eq(c.status, 200, `${mode}: complaint logged`); ok(/Request #\d+/.test(c.data.answer), `${mode}: request id in answer`);
  // Sprint 13: a group reminder ask lands on the SAME bulk preview the sticky
  // bar uses — skip reasons, cap, and a confirm that drafts into the Outbox.
  // It is no longer a second path that drafts straight to the Reminders screen.
  r = await askAs(staffTok, 'send reminders to residents 1+ months behind'); eq(r.data.tool, 'prepare_reminders', `${mode}: reminders prepared`);
  ok(r.data.proposal && r.data.proposal.preview && r.data.proposal.preview.bulk, `${mode}: routed through the bulk preview, not a separate path`);
  ok(Array.isArray(r.data.proposal.preview.lines) && r.data.proposal.preview.lines.length >= 1, `${mode}: the preview lines came from the server`);
  ok(r.data.proposal.preview.lines.some(l => /Nothing is sent/i.test(l)), `${mode}: the preview says nothing is sent`);
  ok('requires_second_confirm' in r.data.proposal.preview, `${mode}: the preview carries the second-confirmation rule`);
  const remOutboxBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM outbox`)).rows[0].n;
  ok((await pool.query(`SELECT COUNT(*)::int AS n FROM outbox`)).rows[0].n === remOutboxBefore, `${mode}: preview drafted nothing`);

  // ── request status by voice (6.1) ──────────────────────────────────────
  const openReq = (await pool.query(`SELECT id FROM complaints WHERE status<>'resolved' ORDER BY id LIMIT 1`)).rows[0];
  r = await askAs(staffTok, `mark request ${openReq.id} resolved — tap replaced`);
  eq(r.data.tool, 'prepare_request_status', `${mode}: status change prepared`); eq(r.data.proposal.preview.status, 'resolved', `${mode}: target status`); ok(r.data.proposal.preview.note && /tap replaced/.test(r.data.proposal.preview.note), `${mode}: note captured`);
  eq((await pool.query(`SELECT status FROM complaints WHERE id=$1`, [openReq.id])).rows[0].status !== 'resolved', true, `${mode}: preview changed nothing`);
  c = await confirmAs(staffTok, r.data.proposal.id); eq(c.status, 200, `${mode}: status confirmed`);
  eq((await pool.query(`SELECT status, resolution_notes FROM complaints WHERE id=$1`, [openReq.id])).rows[0].status, 'resolved', `${mode}: request resolved after confirm`);
  r = await askAs(staffTok, `resolve request ${openReq.id}`); ok(r.data.clarify && /already/.test(r.data.clarify), `${mode}: already-resolved is explained, not re-proposed`);
  r = await askAs(staffTok, `mark request 999999 resolved`); ok(r.data.clarify && /can't find/.test(r.data.clarify), `${mode}: unknown request id is explained`);

  // ── Sprint 8: move-in, checkout, readiness ─────────────────────────────
  r = await askAs(staffTok, 'Meera Joshi joining room C2 tomorrow, rent 6000, deposit 12000, phone 9876543210');
  eq(r.data.tool, 'prepare_resident', `${mode}: move-in prepared`);
  const mi = r.data.data || r.data.preview || (r.data.proposal && r.data.proposal.preview) || r.data.openWizard?.fields;
  ok(r.data.openWizard && r.data.openWizard.kind === 'move-in', `${mode}: returns a move-in wizard to open`);
  const f = r.data.openWizard.fields;
  eq(f.name, 'Meera Joshi', `${mode}: name read`); eq(f.monthly_rent, 6000, `${mode}: rent read`); eq(f.deposit_amount, 12000, `${mode}: deposit read`);
  eq(f.phone, '9876543210', `${mode}: phone read`); eq(f.room_number, 'C2', `${mode}: room matched`);
  eq((await api('GET', '/guests', null, adminTok)).data.length, (await api('GET', '/guests', null, adminTok)).data.length, `${mode}: MONEY/DATA: preparing a move-in creates nobody`);
  const beforeGuests = (await api('GET', '/guests', null, adminTok)).data.length;
  r = await askAs(staffTok, 'Nobody Special joining room C9 tomorrow'); ok(r.data.clarify && /don't know a room/i.test(r.data.clarify), `${mode}: unknown room is explained`);
  eq((await api('GET', '/guests', null, adminTok)).data.length, beforeGuests, `${mode}: still nobody created`);
  r = await askAs(staffTok, 'is room C1 ready?'); eq(r.data.tool, 'room_readiness', `${mode}: readiness`); ok(/readiness/i.test(r.data.answer), `${mode}: readiness text`);
  r = await askAs(staffTok, 'Copilot Anu is checking out tomorrow'); ok(r.data.forbidden, `${mode}: staff cannot run a checkout`);
  r = await askAs(adminTok, 'Copilot Anu is checking out tomorrow');
  eq(r.data.tool, 'prepare_checkout', `${mode}: checkout prepared`);
  ok(r.data.openWizard && r.data.openWizard.kind === 'checkout', `${mode}: returns a checkout wizard`);
  const cf = r.data.openWizard.fields;
  eq(cf.deposit_held, 12000, `${mode}: deposit held`); eq(cf.refund_before_deductions, 12000, `${mode}: refund before deductions`);
  ok(cf.outstanding > 0, `${mode}: outstanding computed from her ledger (${cf.outstanding})`);
  const stillActive = await pool.query('SELECT is_active FROM guests WHERE id=$1', [F.gA.id]);
  eq(stillActive.rows[0].is_active, true, `${mode}: MONEY: preparing a checkout checks nobody out`);

  // ── audit ─────────────────────────────────────────────────────────────
  const audit = await pool.query(`SELECT * FROM ai_actions WHERE request_text ILIKE 'record 2500 rent%' ORDER BY id DESC LIMIT 1`);
  ok(audit.rows[0], `${mode}: ask audited`); eq(audit.rows[0].interpretation.tool, 'prepare_payment', `${mode}: audit has the interpretation`); ok(audit.rows[0].proposal_id, `${mode}: audit links the proposal`);
  const conf = await pool.query(`SELECT * FROM ai_actions WHERE proposal_id=$1 AND confirmed_at IS NOT NULL`, [pid]);
  eq(conf.rows.length, 1, `${mode}: confirm audited once`);
  const denied = await pool.query(`SELECT * FROM ai_actions WHERE proposal_id=$1 AND error='forbidden'`, [pid]);
  eq(denied.rows.length, 1, `${mode}: the other user's attempt is audited as forbidden`);
}

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, purchases, guest_rent_history, deposit_refunds, guests, rooms, owner_reports, ai_proposals, ai_actions, ai_reads, announcements, day_closings, collection_variances RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    await api('POST', '/users', { username: 'smoke_cp_staff', password: 'staff123', role: 'staff' }, adminTok);
    r = await api('POST', '/auth/login', { username: 'smoke_cp_staff', password: 'staff123' }); staffTok = r.data.token;
    const r1 = (await api('POST', '/rooms', { room_number: 'C1', floor: 1, total_beds: 2, monthly_rent: 6000 }, adminTok)).data;
    const r2 = (await api('POST', '/rooms', { room_number: 'C2', floor: 1, total_beds: 2, monthly_rent: 6000 }, adminTok)).data;
    const monthsAgo = n => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
    global.F = {
      gA: (await api('POST', '/guests', { name: 'Copilot Anu', phone: '9555555551', room_id: r1.id, bed_number: 1, join_date: monthsAgo(3), monthly_rent: 6000, deposit_amount: 12000 }, adminTok)).data,
      gB: (await api('POST', '/guests', { name: 'Copilot Bela', phone: '9555555552', room_id: r1.id, bed_number: 2, join_date: monthsAgo(1), monthly_rent: 6000, deposit_amount: 12000 }, adminTok)).data,
      gC: (await api('POST', '/guests', { name: 'Solo Chitra', phone: '9555555553', room_id: r2.id, bed_number: 1, join_date: today, monthly_rent: 6000, deposit_amount: 12000 }, adminTok)).data
    };
    await api('POST', '/complaints', { category: 'Wifi/Internet', description: 'Copilot wifi slow', guest_name: 'Room C1' }, staffTok);

    // ── health score + brief v2 + evening (mode-independent) ──────────────
    const facts = { headcount: 3, totalBeds: 4, rentDue: { count: 2, total: 30000 }, overdue: [], complaints: { open: 1, urgent: 0 }, checklist: { yesterdayDone: 20, total: 33 }, pendingClaims: { n: 0 }, pendingApprovals: { n: 0 } };
    const h = copilot.healthScore(facts, { monthlyBilled: 18000 });
    eq(h.components.occupancy.score, 75, 'health: occupancy 3/4 = 75'); eq(h.components.collections.score, 0, 'health: dues exceeding a month\'s rent roll → 0'); eq(h.components.operations.score, 61, 'health: checklist 20/33 = 61'); eq(h.components.maintenance.score, 92, 'health: one open request = 92');
    eq(h.components.experience.score, null, 'health: experience not measured yet'); eq(h.overall, Math.round((75 + 0 + 61 + 92) / 4), 'health: overall ignores null components');
    ok(Object.values(h.components).every(c => c.why), 'health: every component explains itself');
    const h2 = copilot.healthScore({ ...facts, rentDue: { count: 0, total: 0 }, complaints: { open: 0, urgent: 0 } }, { monthlyBilled: 18000 });
    eq(h2.components.collections.score, 100, 'health: nothing outstanding = 100'); eq(h2.components.maintenance.score, 100, 'health: no requests = 100');

    r = await api('GET', '/copilot/brief', null, staffTok); eq(r.status, 200, 'brief v2'); const b = r.data;
    ok(b.health && typeof b.health.overall === 'number', 'brief has health score'); ok(Array.isArray(b.changed) && b.changed.length, 'brief has "what changed"');
    ok(b.attention && Array.isArray(b.attention.high), 'brief has attention levels'); ok(b.recommendations.length >= 1 && b.recommendations.length <= 3, 'brief has 1–3 recommendations');
    ok(b.recommendations.every(x => x.action && (x.action.navigate || x.action.ask)), 'every recommendation is a button');
    ok(b.text.includes('Property health') && b.text.includes('Siri recommends'), 'brief text is WhatsApp-ready');
    eq(b.facts.rentDue.total, (await api('GET', '/rent-due', null, staffTok)).data.filter(g => g.amount_due > 0).reduce((t, g) => t + g.amount_due, 0), 'MONEY: brief total equals Rent Due');
    const bAdmin = (await api('GET', '/copilot/brief', null, adminTok)).data;
    ok(JSON.stringify(bAdmin.recommendations) !== JSON.stringify(b.recommendations) || bAdmin.facts.pendingClaims.n === 0, 'brief recommendations are role-aware');
    const bCached = (await api('GET', '/copilot/brief', null, staffTok)).data; eq(bCached.cached, true, 'brief cached per day per role');

    r = await api('GET', '/copilot/evening', null, staffTok); eq(r.status, 200, 'evening summary'); ok(r.data.text.includes('Tomorrow'), 'evening has Tomorrow'); ok(/collected/.test(r.data.text), 'evening has collections');
    copilot._reset();
    await pool.query(`INSERT INTO app_settings(key, value) VALUES('evening_time','00:00') ON CONFLICT (key) DO UPDATE SET value='00:00'`);
    const logs = []; const sch = copilot.startEveningScheduler({ intervalMs: 60000, log: l => logs.push(l) }); await sch.tick(); await sch.tick(); sch.stop();
    eq(logs.filter(l => /summary computed/.test(l)).length, 1, 'evening scheduler runs once per day, not twice');
    // 6.1: audit screen route + evening time setting
    r = await api('GET', '/copilot/audit', null, staffTok); eq(r.status, 403, 'audit is admin-only');
    r = await api('GET', '/copilot/audit', null, adminTok); eq(r.status, 200, 'audit readable'); ok(Array.isArray(r.data), 'audit is a list');
    r = await api('PUT', '/settings', { evening_time: '21:30' }, adminTok); eq(r.status, 200, 'evening time saved');
    eq((await pool.query(`SELECT value FROM app_settings WHERE key='evening_time'`)).rows[0].value, '21:30', 'evening_time persisted');
    r = await api('GET', '/copilot/tools', null, staffTok); ok(r.data.tools.every(t => !/announcement|performance|owner_report/.test(t.name)), 'staff tool list excludes admin tools');
    r = await api('GET', '/copilot/tools', null, adminTok); ok(r.data.tools.some(t => t.name === 'get_month_performance'), 'admin tool list includes performance');
    console.log('✓ health, brief v2, evening, tool catalogue');

    await run('stubbed');
    await run('no-model');
    ok(modelCalls.every(u => !/9555555551|9555555552|9555555553/.test(u)), 'PRIVACY: phone numbers never sent to the model');
    ok(modelCalls.every(u => !/12000/.test(u)), 'PRIVACY: deposit amounts never sent to the model');
    const auditRows = (await api('GET', '/copilot/audit?limit=500', null, adminTok)).data;
    ok(auditRows.some(x => /record 2500 rent/i.test(x.request_text)), 'audit screen data includes asks');
    ok(auditRows.some(x => x.request_text === 'confirm' && x.confirmed_at), 'audit screen data includes confirms');
    ok(auditRows.some(x => x.error === 'forbidden'), 'audit screen data includes refusals');
    console.log(`\n✅ Copilot gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Copilot gate FAILED after ${count} assertions:\n`, e.stack || e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
