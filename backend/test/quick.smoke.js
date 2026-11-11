// backend/test/quick.smoke.js — Sprint 14 gate: Quick Entry
//
//   DATABASE_URL=… JWT_SECRET=test node backend/test/quick.smoke.js
//
// The two phrases from Sachin's screenshots are fixtures here. If "brought
// onion 100rs" ever stops being an expense in Groceries, this goes red.
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;   // keyless by default — it must work like that

const app = require('../server');
const pool = require('../db');
const quick = require('../services/quick');
const ai = require('../routes/ai');
const routes = require('../routes/index');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

let BASE, adminTok, staffTok;
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('application/json') ? await res.json() : await res.text() };
};
const A = (m, p, b) => api(m, p, b, adminTok);
const S = (m, p, b) => api(m, p, b, staffTok);
const ask = (text, tok) => api('POST', '/copilot/ask', { text, context: { page: 'finance-overview' } }, tok || adminTok);
const uniq = Date.now().toString().slice(-6);
const alpha = uniq.replace(/\d/g, d => 'abcdefghij'[d]);   // matchResident strips digits, so tell the twins apart with letters
const daysAgo = n => new Date(Date.now() + 5.5 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);   // Sprint 18: India dates, like the forms

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' });
    eq(r.status, 200, 'admin login'); adminTok = r.data.token;
    const staffName = `qstaff${uniq}`;
    await A('POST', '/users', { username: staffName, password: 'Staff@12345', role: 'staff' });
    r = await api('POST', '/auth/login', { username: staffName, password: 'Staff@12345' }); staffTok = r.data.token;

    await pool.query(`UPDATE guests SET is_active=false WHERE name ILIKE 'Jhanavi %'`);   // leftovers from earlier runs against the same DB
    // A realistic room number ("9" + two digits) so extractRoom can read it back.
    const roomNo = '9' + uniq.slice(-2);
    let room = (await A('POST', '/rooms', { room_number: roomNo, floor: 9, total_beds: 4, monthly_rent: 6000, room_type: 'sharing' })).data;
    if (!room || !room.id) room = ((await A('GET', '/rooms')).data.list || (await A('GET', '/rooms')).data).find(x => x.room_number === roomNo);
    ok(room && room.id, 'test room ready');
    const jh = (await A('POST', '/guests', { name: `Jhanavi ${alpha}`, phone: `97${uniq}01`.slice(0, 10), room_id: room.id, bed_number: '1', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(90), id_proof_type: 'Aadhaar' })).data;
    const jh2 = (await A('POST', '/guests', { name: `Jhanavi Zwin${alpha}`, phone: `97${uniq}02`.slice(0, 10), room_id: room.id, bed_number: '2', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(90), id_proof_type: 'Aadhaar' })).data;
    ok(jh.id && jh2.id, 'two residents, one a near-name of the other');

    // ── Amount forms ─────────────────────────────────────────────────────
    const SMParse = require('../../frontend/public/js/speech-parser.js');
    for (const [txt, want] of [['onion 100rs', 100], ['onion rs100', 100], ['onion rs.100', 100], ['onion ₹100', 100], ['onion 100 rupees', 100], ['onion 100/-', 100], ['onion 1.5k', 1500], ['rs5000 upi', 5000], ['2,500 milk', 2500]]) {
      const a = SMParse.extractAmount(quick.normaliseAmount(txt));
      eq(a && a.amount, want, `amount: "${txt}"`);
    }

    // ── Classification, no verbs ─────────────────────────────────────────
    const adminUser = { id: 1, role: 'admin' };
    let i = await quick.intent('onion 100rs', adminUser, {});
    eq(i && i.tool, 'prepare_expense', 'SCREENSHOT 1: "onion 100rs" is an expense');
    eq(i.args.category, 'Groceries', '…in Groceries'); eq(i.args.amount, 100, '…for ₹100'); eq(i.args.description, 'onion', '…described as onion');
    i = await quick.intent('brought onion 100rs', adminUser, {});
    eq(i && i.tool, 'prepare_expense', 'SCREENSHOT 2: "brought onion 100rs" (typo) is an expense');
    eq(i.args.category, 'Groceries', '…Groceries despite the typo'); eq(i.args.description, 'onion', '…and the typo verb is not the description');
    for (const t of ['bougt tomato 60', 'purchsed rice 900', 'tomoto 40', 'sabzi 250 cash']) { i = await quick.intent(t, adminUser, {}); ok(i && i.tool === 'prepare_expense' && i.args.category === 'Groceries', `typo/kannada: "${t}" → Groceries`); }
    i = await quick.intent('phenyl 120', adminUser, {}); eq(i.args.category, 'Cleaning', 'phenyl → Cleaning');
    i = await quick.intent('plumber 800 cash', adminUser, {}); eq(i.args.category, 'Repairs', 'plumber → Repairs'); eq(i.args.mode, 'Cash', 'mode read from the phrase');
    i = await quick.intent('bescom 4300', adminUser, {}); eq(i.args.category, 'Electricity', 'bescom → Electricity');
    i = await quick.intent('wifi 999 upi', adminUser, {}); eq(i.args.category, 'Internet', 'wifi → Internet');
    i = await quick.intent('cook salary 9000', adminUser, {}); eq(i.args.category, 'Salary', 'cook salary → Salary');
    i = await quick.intent('xyzzy gadget 400', adminUser, {}); eq(i.args.category, 'Other', 'unknown item → Other, keyless');

    i = await quick.intent(`jhanavi ${alpha} 500`, adminUser, {});
    eq(i && i.tool, 'prepare_payment', 'a resident name → collection'); eq(i.args.resident_id, jh.id, '…for the right resident'); eq(i.args.amount, 500, '…₹500');
    i = await quick.intent(`jhanavi ${alpha} paid rs5000 upi`, adminUser, {});
    eq(i.tool, 'prepare_payment', '"paid rs5000 upi" → collection'); eq(i.args.amount, 5000, 'glued rs5000 parsed'); eq(i.args.mode, 'UPI', 'UPI read');
    i = await quick.intent(`jhanavi ${alpha} deposit 10000 gpay`, adminUser, {}); eq(i.args.type, 'deposit', 'deposit type read'); eq(i.args.mode, 'UPI', 'gpay is UPI');
    i = await quick.intent('jhanavi 500', adminUser, {});
    eq(i && i.tool, 'prepare_payment', 'AMBIGUOUS: "jhanavi" matches two residents → still a collection, never an expense');
    ok(!i.args.resident_id && i.args.name, '…with no resident chosen: it will ask which one');
    r = await ask('jhanavi 500');
    ok(r.data.clarify && /which resident/i.test(r.data.clarify), '…and through the API it asks "Which resident?"');
    const cand = (r.data.candidates || []).map(c => c.id);
    ok(cand.includes(jh.id) && cand.includes(jh2.id), `…offering both Jhanavis as taps (${cand.length} candidates)`);

    i = await quick.intent(`tap leaking room ${room.room_number}`, adminUser, {});
    eq(i && i.tool, 'prepare_complaint', 'fault words → request'); eq(i.args.room, room.room_number, '…with the room');
    i = await quick.intent('geyser not working', adminUser, {}); eq(i && i.tool, 'prepare_complaint', '"not working" → request');

    i = await quick.intent('300', adminUser, {});
    eq(i && i.tool, null, 'DECISION 2: a bare amount is not filed'); ok(/what was ₹300 for/i.test(i.clarify), '…it asks "for what?"'); eq(i.retry_text, '300 ', '…and hands the number back to the box');
    i = await quick.intent('rs 300 cash', adminUser, {}); ok(i && !i.tool && /for/i.test(i.clarify), 'amount + mode but no item still asks');

    for (const q of ['who has not paid?', 'which rooms are vacant', 'how much does jhanavi owe', 'show me 5000 rent', 'what needs attention today?']) {
      i = await quick.intent(q, adminUser, {}); ok(i === null, `a question is never an entry: "${q}"`);
    }
    for (const q of [`checkout jhanavi ${alpha} on 30th`, `move jhanavi ${alpha} to room 204`, 'mark request 12 resolved']) {
      const before = await api('POST', '/copilot/ask', { text: q }, adminTok);
      ok(before.status === 200 && before.data.tool !== 'prepare_payment', `existing verbs still win over the name rule: "${q}" → ${before.data.tool || before.data.via}`);
    }
    console.log('✓ classifier');

    // ── Full flow: ask → preview → confirm, through the API ──────────────
    r = await ask('onion 100rs');
    eq(r.status, 200, 'ask ok'); eq(r.data.tool, 'prepare_expense', 'routed to prepare_expense'); eq(r.data.via, 'quick', 'via quick');
    ok(r.data.proposal && r.data.proposal.preview, 'a preview came back'); eq(r.data.proposal.preview.category, 'Groceries', 'preview: Groceries');
    eq(r.data.proposal.preview.source, 'quick', 'preview carries source=quick'); ok(/Category: /.test(r.data.answer), 'the answer says WHY that category');
    let purchasesBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM purchases`)).rows[0].n;
    ok(r.data.actions.some(a => a.confirm), 'confirm is a separate tap');
    eq((await pool.query(`SELECT COUNT(*)::int AS n FROM purchases`)).rows[0].n, purchasesBefore, 'NOTHING SAVED at preview');
    const c = await A('POST', '/copilot/confirm', { proposal_id: r.data.proposal.id });
    eq(c.status, 200, 'confirmed');
    const saved = (await pool.query(`SELECT amount, category, description, source, payment_mode FROM purchases ORDER BY id DESC LIMIT 1`)).rows[0];
    eq(Number(saved.amount), 100, 'saved ₹100'); eq(saved.category, 'Groceries', 'saved as Groceries'); eq(saved.description, 'onion', 'saved description'); eq(saved.source, 'quick', 'SOURCE IS quick, not downgraded to manual');

    // Decision 1: a collection with no mode asks, with taps.
    r = await ask(`jhanavi ${alpha} 500`);
    eq(r.data.tool, 'prepare_payment', 'collection routed'); ok(r.data.clarify && /how did .* pay/i.test(r.data.clarify), 'DECISION 1: asks the mode, never assumes Cash');
    ok(!r.data.proposal, '…and prepared nothing yet');
    const chips = (r.data.actions || []).filter(a => a.tool === 'prepare_payment' && a.args && a.args.mode);
    eq(chips.length, 3, 'three tap-answers: UPI, Cash, Bank Transfer');
    const tap = chips.find(a => a.args.mode === 'UPI');
    r = await api('POST', '/copilot/ask', { text: `jhanavi ${alpha} 500`, tool: tap.tool, args: tap.args }, adminTok);
    // A tap can never reach an execute tool, nor an admin tool as staff.
    const bad = await api('POST', '/copilot/ask', { text: 'x', tool: 'create_payment', args: { guest_id: jh.id, amount: 1 } }, staffTok);
    ok(bad.status === 200 && bad.data.tool !== 'create_payment' && !(await pool.query(`SELECT 1 FROM collections WHERE guest_id=$1 AND amount=1`, [jh.id])).rows.length, 'SECURITY: a forged tap cannot execute');
    const badAdmin = await api('POST', '/copilot/ask', { text: 'x', tool: 'prepare_announcement', args: { message: 'hi' } }, staffTok);
    ok(badAdmin.data.tool !== 'prepare_announcement', 'SECURITY: a forged tap cannot reach an admin tool as staff');
    ok(r.status === 200 && r.data.proposal && r.data.proposal.preview, 'tapping UPI produces the preview');
    eq(r.data.proposal.preview.payment_mode, 'UPI', 'preview: UPI'); eq(r.data.proposal.preview.guest_id, jh.id, 'preview: right resident');
    const colsBefore = (await pool.query(`SELECT COUNT(*)::int AS n FROM collections WHERE guest_id=$1`, [jh.id])).rows[0].n;
    eq(colsBefore, 0, 'nothing saved at preview');
    const c2 = await A('POST', '/copilot/confirm', { proposal_id: r.data.proposal.id });
    eq(c2.status, 200, 'collection confirmed');
    const col = (await pool.query(`SELECT amount, payment_mode, collection_type, status, source FROM collections WHERE guest_id=$1 ORDER BY id DESC LIMIT 1`, [jh.id])).rows[0];
    eq(Number(col.amount), 500, '₹500 saved'); eq(col.payment_mode, 'UPI', 'as UPI'); eq(col.collection_type, 'rent', 'as rent'); eq(col.source, 'quick', 'source=quick');

    // ── MONEY: the ledger cannot tell Quick Entry from the form ──────────
    await A('POST', '/collections', { guest_id: jh2.id, amount: 500, payment_mode: 'UPI', collection_type: 'rent', collection_date: daysAgo(0), collection_month: col.collection_month || '' , description: '' });
    const strip = l => JSON.stringify(l, (k, v) => ['id', 'guest_id', 'guest_name', 'name', 'receipt_number', 'created_at', 'created_by', 'source', 'description', 'at'].includes(k) ? undefined : v);
    const gRow = async id => (await pool.query(`SELECT * FROM guests WHERE id=$1`, [id])).rows[0];
    const l1 = await routes.computeGuestLedger(await gRow(jh.id)), l2 = await routes.computeGuestLedger(await gRow(jh2.id));
    eq(strip(l1), strip(l2), 'MONEY: ledger after "jhanavi 500" (quick) is byte-identical to the same payment through the form');
    const rd = (await A('GET', '/rent-due')).data; const list = rd.list || rd;
    const d1 = list.find(g => g.id === jh.id), d2 = list.find(g => g.id === jh2.id);
    eq(d1.amount_due, d2.amount_due, 'MONEY: rent-due agrees for both');

    // Staff entries still wait for the admin.
    r = await ask('tomato 60', staffTok); ok(r.data.proposal, 'staff can prepare');
    const cs = await S('POST', '/copilot/confirm', { proposal_id: r.data.proposal.id }); eq(cs.status, 200, 'staff confirm ok');
    const sp = (await pool.query(`SELECT status FROM purchases ORDER BY id DESC LIMIT 1`)).rows[0]; ok(sp.status !== 'confirmed', 'MONEY: a staff expense via quick is pending_approval, not income');

    // ── Decision 3a: it learns from THIS PG's purchases ──────────────────
    await A('POST', '/purchases', { amount: 200, category: 'Furniture', description: 'zorbo mat', purchase_date: daysAgo(3), payment_mode: 'Cash' });
    await A('POST', '/purchases', { amount: 210, category: 'Furniture', description: 'zorbo mat again', purchase_date: daysAgo(2), payment_mode: 'Cash' });
    quick.invalidateHistory();
    i = await quick.intent('zorbo 220', adminUser, {}); eq(i.args.category, 'Furniture', 'LEARNED: "zorbo" is Furniture because this PG filed it so twice');
    ok(/filed "zorbo" under Furniture \d+ times?/.test(i.category_basis), "and says why");
    // One stray misfiling must NOT flip an item with a clear majority.
    await A('POST', '/purchases', { amount: 30, category: 'Cleaning', description: 'onion', purchase_date: daysAgo(1), payment_mode: 'Cash' });
    quick.invalidateHistory();
    i = await quick.intent('onion 50', adminUser, {}); eq(i.args.category, 'Groceries', 'MAJORITY RULES: one stray "onion → Cleaning" does not flip it');
    // But a consistent choice beats the dictionary: phenyl is Cleaning by the
    // book; this PG files it under Groceries (the kirana bill) three times.
    for (let k = 0; k < 3; k++) await A('POST', '/purchases', { amount: 120, category: 'Groceries', description: `phenyl bottle`, purchase_date: daysAgo(k + 1), payment_mode: 'Cash' });
    quick.invalidateHistory();
    i = await quick.intent('phenyl 120', adminUser, {}); eq(i.args.category, 'Groceries', 'HISTORY OUTWEIGHS THE DICTIONARY: phenyl → Groceries because this PG files it so');
    await pool.query(`UPDATE purchases SET is_deleted=true WHERE description IN ('phenyl bottle','onion') AND category IN ('Groceries','Cleaning') AND amount IN (120,30)`); quick.invalidateHistory();
    i = await quick.intent('phenyl 120', adminUser, {}); eq(i.args.category, 'Cleaning', 'a deleted purchase no longer teaches');

    // ── Decision 3b: the model as tie-breaker — and what it is shown ─────
    const seen = [];
    const realStub = ai.providers._stub, realGroq = ai.providers.groqText;
    ai.providers._stub = true;
    ai.providers.groqText = async ({ system, user }) => { seen.push(system + '\n' + user); return JSON.stringify({ category: 'Furniture' }); };
    i = await quick.intent(`jhanavi ${alpha} kept zzquark 750`, adminUser, {});
    eq(i.tool, 'prepare_payment', 'a name still wins — the model is not consulted for a collection'); eq(seen.length, 0, 'PRIVACY: no model call for a collection');
    i = await quick.intent('zzquark 750 upi', adminUser, {});
    eq(i.args.category, 'Furniture', 'unknown item → the model decides'); eq(i.category_via, 'model', 'via model');
    eq(seen.length, 1, 'exactly one model call');
    ok(!/750/.test(seen[0]), 'PRIVACY: the model never sees the rupee figure');
    ok(!/upi/i.test(seen[0]), 'PRIVACY: nor the payment mode');
    ok(!new RegExp(alpha).test(seen[0]) && !/jhanavi/i.test(seen[0]), 'PRIVACY: nor any resident name');
    ok(/zzquark/.test(seen[0]), 'it sees the item words only');
    ai.providers.groqText = async () => { throw new Error('boom'); };
    i = await quick.intent('zzquark 750', adminUser, {}); eq(i.args.category, 'Other', 'model failure → Other, never an error to the warden');
    ai.providers._stub = realStub; ai.providers.groqText = realGroq; ai.providers.groqDownUntil = 0;   // Sprint 20: a simulated outage starts the 10-min skip — end it with the stub

    // ── Review S20: quick entry really falls back to Gemini, item words only
    {
      const keepG = ai.providers.geminiText, keepQ = ai.providers.groqText; let gp = '';
      ai.providers._stub = true; ai.providers.groqDownUntil = 0;
      ai.providers.groqText = async () => { const e = new Error('Groq 404: retired'); e.status = 404; throw e; };
      ai.providers.geminiText = async ({ prompt }) => { gp = prompt; return JSON.stringify({ category: 'Groceries' }); };
      const fb = await quick.categorise('zzfallbackitem');
      ok(fb.category === 'Groceries' && fb.via === 'model', `S20-1 quick entry: Groq down → Gemini picks the category (${fb.category} via ${fb.via})`);
      ok(/Item: zzfallbackitem/.test(gp) && !/jhanavi|9\d{9}/i.test(gp), 'S20-1 PRIVACY: Gemini sees the item words only');
      ai.providers.groqText = keepQ; ai.providers.geminiText = keepG; ai.providers._stub = realStub; ai.providers.groqDownUntil = 0;
    }

    // ── 14.1 Voice repair: what Chrome heard vs what she said ───────────
    const vseen = [];
    ai.providers._stub = true; ai.providers.groqDownUntil = 0;
    ai.providers.groqText = async ({ system, user }) => {
      vseen.push(system + '\n' + user);
      if (/category/i.test(system) && !/Transcripts/.test(user)) return JSON.stringify({ category: 'Other' });
      if (/opinion/i.test(user)) return JSON.stringify({ phrase: 'onion 100', confidence: 'high' });
      if (/janvi/i.test(user)) return JSON.stringify({ phrase: `Jhanavi ${alpha} 5000 upi`, confidence: 'high' });
      if (/tab leaking/i.test(user)) return JSON.stringify({ phrase: `tap leaking room ${roomNo}`, confidence: 'high' });
      return JSON.stringify({ phrase: user.split('\n')[1].replace(/^\d+\. /, ''), confidence: 'low' });
    };
    // Typed "opinion 100" is what she typed — NOT repaired, filed as typed.
    vseen.length = 0;
    i = await quick.intent('opinion 100', adminUser, {});
    eq(i.args.description, 'opinion', 'TYPED text is never "corrected" by the model');
    // (Since 14.4, "union" resolves to onion by SOUND with no model at all.)
    i = await quick.intent('union 100', adminUser, {}); eq(i.args.category, 'Groceries', '"union" → Groceries phonetically, no repair needed');
    ok(!vseen.some(x => /Transcripts/.test(x)), '…and no repair call was made for typed text');
    // Spoken, mis-heard, with Chrome's alternatives → repaired, then classified as usual.
    vseen.length = 0;
    i = await quick.intent('opinion hundred rupees', adminUser, {}, { voice: true, alternatives: ['opinion hundred rupees', 'onion hundred rupees'] });
    eq(i.tool, 'prepare_expense', 'VOICE: "opinion hundred rupees" → an expense'); eq(i.args.description, 'onion', '…for onion'); eq(i.args.category, 'Groceries', '…in Groceries'); eq(i.args.amount, 100, '…₹100');
    eq(i.heard, 'opinion hundred rupees', 'it records what was heard'); eq(i.understood, 'onion 100', '…and what it understood');
    eq(vseen.filter(x => /Transcripts/.test(x)).length, 1, 'exactly one repair call');
    ok(/onion hundred rupees/.test(vseen[0]), 'the repair saw Chrome\'s alternatives');
    ok(new RegExp(`Jhanavi ${alpha}`).test(vseen[0]), 'the repair saw the resident names (allowed)');
    ok(!/\b\d{10}\b/.test(vseen[0]), 'PRIVACY: the repair never sees a phone number');
    ok(!/aadhaar|id_proof|address/i.test(vseen[0]), 'PRIVACY: nor an ID or address');
    // A mis-heard name resolves to the resident.
    i = await quick.intent('janvi five thousand upi', adminUser, {}, { voice: true, alternatives: ['janvi five thousand upi', 'janavi 5000 upi'] });
    // Hotfix 21.2 (review B3b): two Jhanavis live here, and "janvi" does not say
    // which. Until 21.2 the model chose one; now she is asked, with both as taps.
    eq(i.tool, 'prepare_payment', 'VOICE: "janvi five thousand upi" → a collection'); eq(i.args.resident_id, undefined, '…the model does not choose between two Jhanavis'); ok(i.fuzzy && i.fuzzy.length === 2, '…both are offered'); eq(i.args.amount, 5000, '…₹5,000'); eq(i.args.mode, 'UPI', '…UPI');
    i = await quick.intent('tab leaking room ' + roomNo, adminUser, {}, { voice: true, alternatives: [] });
    eq(i.tool, 'prepare_complaint', 'VOICE: "tab leaking" → a request'); eq(i.args.room, roomNo, '…for the room');
    // Spoken clearly → the deterministic pass is confident; the model is not called at all.
    vseen.length = 0;
    i = await quick.intent('onion 100', adminUser, {}, { voice: true, alternatives: ['onion 100'] });
    eq(i.args.category, 'Groceries', 'a clearly-heard phrase classifies at once'); ok(!i.heard, '…with no repair'); eq(vseen.length, 0, '…and no model call: fast path');
    // Through the API, the answer shows the correction.
    r = await api('POST', '/copilot/ask', { text: 'opinion hundred rupees', voice: true, alternatives: ['opinion hundred rupees', 'onion hundred rupees'] }, adminTok);
    eq(r.data.tool, 'prepare_expense', 'API: voice repair reaches the preview'); ok(/Heard “opinion hundred rupees” — understood as “onion 100”/.test(r.data.answer), 'API: the answer says what was heard and what was understood');
    eq(r.data.proposal.preview.description, 'onion', 'API: the preview is for onion'); eq(r.data.proposal.preview.source, 'quick', 'API: still source=quick');
    // Review S20: Groq down → Gemini repairs the voice phrase instead
    { const keepG = ai.providers.geminiText, keepQ = ai.providers.groqText;
      ai.providers.groqDownUntil = 0;
      ai.providers.groqText = async () => { const e = new Error('Groq 404: retired'); e.status = 404; throw e; };
      ai.providers.geminiText = async ({ prompt }) => /Transcripts/.test(prompt) && /opinion/i.test(prompt) ? JSON.stringify({ phrase: 'onion 100', confidence: 'high' }) : JSON.stringify({ category: 'Groceries' });
      const vr = await quick.intent('opinion hundred rupees', adminUser, {}, { voice: true, alternatives: ['opinion hundred rupees', 'onion hundred rupees'] });
      eq(vr.args.description, 'onion', 'S20-1 voice repair: Groq down → Gemini repairs "opinion" to onion');
      ai.providers.groqText = keepQ; ai.providers.geminiText = keepG; ai.providers.groqDownUntil = 0; }
    // Model down or keyless → behaves exactly as before, never an error.
    ai.providers.groqText = async () => { throw new Error('down'); };
    i = await quick.intent('opinion hundred rupees', adminUser, {}, { voice: true, alternatives: [] });
    eq(i.tool, 'prepare_expense', 'model down: still an expense'); eq(i.args.description, 'opinion', '…as heard'); ok(!i.heard, '…no false repair');
    ai.providers._stub = realStub; ai.providers.groqText = realGroq; ai.providers.groqDownUntil = 0;   // Sprint 20: a simulated outage starts the 10-min skip — end it with the stub
    i = await quick.intent('opinion hundred rupees', adminUser, {}, { voice: true, alternatives: [] });
    eq(i.args.category, 'Other', 'KEYLESS: voice still files, as Other');
    // A forged request cannot smuggle a phrase past the bounds.
    const many = await api('POST', '/copilot/ask', { text: 'onion 100', voice: true, alternatives: Array(20).fill('x'.repeat(300)) }, adminTok);
    eq(many.status, 200, 'twenty alternatives are trimmed to five, not fatal');
    const huge = await api('POST', '/copilot/ask', { text: 'onion 100', voice: true, alternatives: Array(50).fill('x'.repeat(500)) }, adminTok);
    eq(huge.status, 413, 'a 25 kB body is refused by the global limit before it reaches the parser');
    console.log('✓ voice repair');

    // ── 14.2 Fuzzy names: suggest the resident, never file an expense ──────
    // Sachin's phone screenshot, verbatim: filed a ₹5,000 expense called "janavi".
    i = await quick.intent('rupees 5000 janavi', adminUser, {});
    eq(i && i.tool, 'prepare_payment', 'SCREENSHOT: "rupees 5000 janavi" is a collection, NOT an expense');
    ok(!i.args.resident_id, '…nobody chosen: it will ask'); ok(i.fuzzy && i.fuzzy.some(f => f.id === jh.id), '…and Jhanavi is the suggestion');
    for (const t of [`jhanvi 5000 upi`, `jahnavi 500`, `janvi 500`, `janavi paid 5000`]) {
      i = await quick.intent(t, adminUser, {}); ok(i && i.tool === 'prepare_payment' && i.fuzzy && i.fuzzy.some(f => f.id === jh.id), `spelling "${t.split(' ')[0]}" suggests Jhanavi`);
    }
    r = await ask('rupees 5000 janavi');
    eq(r.data.tool, 'prepare_payment', 'API: routed as a collection'); ok(/did you mean/i.test(r.data.clarify || ''), 'API: asks "Did you mean…?"');
    ok((r.data.candidates || []).some(c => c.id === jh.id), 'API: Jhanavi offered as a tap'); ok(!r.data.proposal, 'API: nothing prepared until she taps');
    const tapJ = (r.data.actions || []).find(a => a.args && a.args.resident_id === jh.id);
    ok(tapJ, 'the tap carries her resident id');
    r = await api('POST', '/copilot/ask', { text: 'rupees 5000 janavi', tool: tapJ.tool, args: tapJ.args }, adminTok);
    ok(r.data.clarify && /how did .* pay/i.test(r.data.clarify), 'after the tap it asks the mode (no mode was said)');
    // Expense items that resemble names stay expenses.
    for (const t of ['rice 500', 'dal 200', 'milk 60', 'tomato 40', 'phenyl 120']) { i = await quick.intent(t, adminUser, {}); ok(i && i.tool === 'prepare_expense', `"${t}" is still an expense`); }
    const purchasesNow = (await pool.query(`SELECT COUNT(*)::int AS n FROM purchases WHERE description ILIKE '%janavi%' OR description ILIKE '%jhanvi%'`)).rows[0].n;
    eq(purchasesNow, 0, 'NO expense named after a resident was ever created');
    console.log('✓ fuzzy names');

    // ── 14.4 Kannada / Hindi words, by sound ─────────────────────────────
    i = await quick.intent('eruli 500rs', adminUser, {});
    eq(i.tool, 'prepare_expense', 'SCREENSHOT: "eruli 500rs" is an expense'); eq(i.args.category, 'Groceries', '…in Groceries (ಈರುಳ್ಳಿ = onion)'); eq(i.args.amount, 500, '…₹500');
    for (const [t, cat] of [['yerulli 40', 'Groceries'], ['irully 40', 'Groceries'], ['tamaate 60', 'Groceries'], ['aalugadde 80', 'Groceries'], ['haloo 50', 'Groceries'], ['pyaz 40', 'Groceries'], ['tamatar 60', 'Groceries'], ['chaaval 900', 'Groceries'], ['pudina soppu 20', 'Groceries'],
                            ['nally repair 300', 'Repairs'], ['jhaadoo 80', 'Cleaning'], ['sabboo 45', 'Cleaning'], ['fenayil 120', 'Cleaning'], ['neeru tanker 900', 'Water'], ['current bill 4300', 'Electricity'], ['kurchee 1200', 'Furniture'], ['cook sambala 9000', 'Salary']]) {
      i = await quick.intent(t, adminUser, {}); ok(i && i.tool === 'prepare_expense' && i.args.category === cat, `"${t}" → ${cat} (got ${i && i.args && i.args.category})`);
    }
    // Unseen spellings resolve by SOUND, not by being in the list.
    ok(!quick.DICT.Groceries.includes('yerulli') && !quick.DICT.Cleaning.includes('jhaadoo'), 'those spellings are NOT in the dictionary — the match is phonetic');
    // English words that are not items stay unrecognised — no wild category.
    for (const t of ['laptop 30000', 'saree 1500', 'medicine 400', 'dinner 600']) { i = await quick.intent(t, adminUser, {}); ok(i && i.args.category === 'Other', `"${t}" stays Other (no false phonetic hit)`); }
    // Correct-then-learn loop: an unknown item, category fixed at the preview, remembered next time.
    r = await ask('zzkumbla 300');
    eq(r.data.proposal.preview.category, 'Other', 'unknown item previews as Other');
    const catChips = (r.data.actions || []).filter(a => a.chip === 'category');
    ok(catChips.length >= 9, `the preview offers the other categories as taps (${catChips.length})`);
    ok(/Tap the right category/.test(r.data.answer), '…and says tapping will be remembered');
    const groc = catChips.find(a => a.label === 'Groceries');
    r = await api('POST', '/copilot/ask', { text: 'zzkumbla 300', tool: groc.tool, args: groc.args }, adminTok);
    eq(r.data.proposal.preview.category, 'Groceries', 'tapping Groceries re-previews as Groceries'); eq(r.data.proposal.preview.description, 'zzkumbla', '…same item'); eq(r.data.proposal.preview.source, 'quick', '…still source=quick');
    const fewer = (r.data.actions || []).filter(a => a.chip === 'category');
    ok(fewer.length >= 1 && fewer.length <= 4, `a recognised category shows only a short "change" row (${fewer.length})`);
    const c4 = await A('POST', '/copilot/confirm', { proposal_id: r.data.proposal.id }); eq(c4.status, 200, 'confirmed as Groceries');
    i = await quick.intent('zzkumbla 120', adminUser, {}); eq(i.args.category, 'Groceries', 'LEARNED: next "zzkumbla" is Groceries without asking');
    ok(/filed "zzkumbla" under Groceries/.test(i.category_basis), '…and says it learned it from her');
    console.log('✓ kannada/hindi + learn loop');

    // ── Sprint 21: she speaks Kannada ─────────────────────────────────────
    // S21-1 Kannada script is spelt out the way WhatsApp Kannada is typed.
    for (const [kn, lat] of [['ಈರುಳ್ಳಿ', 'eerulli'], ['ಬೆಳ್ಳುಳ್ಳಿ', 'bellulli'], ['ಹಾಲು', 'haalu'], ['ಸಂಬಳ', 'sambala'], ['ತೊಂಬತ್ತು', 'tombattu'], ['ಎಂಟು', 'entu'], ['ಜಾನವಿ', 'jaanavi'],
                             ['ಕ್ಯಾಶ್', 'cash'], ['ಯುಪಿಐ', 'upi'], ['ಗೂಗಲ್ ಪೇ', 'google pay'], ['ಫೋನ್ ಪೇ', 'phonepe'], ['ರೂಮ್ ನಂಬರ್ ೧೦೬', 'room number 106'], ['ಟೊಮ್ಯಾಟೊ', 'tomato'], ['100 ರೂಪಾಯಿ', '100 rupees']]) {
      eq(SMParse.toLatin(kn), lat, `S21-1 toLatin "${kn}"`);
    }
    for (const typed of ['onion 100rs', 'Jhanavi paid ₹5,000 UPI', 'tap leaking room 106', 'rent', 'bil', 'tee 20']) eq(SMParse.toLatin(typed), typed, `S21-1 typed English is returned untouched: "${typed}"`);
    // S21-2 Kannada number words — digits, words, and the one-word hundreds
    for (const [kn, n] of [['ಐದು ಸಾವಿರ', 5000], ['ಎರಡು ಸಾವಿರದ ಐನೂರು', 2500], ['ಐನೂರು', 500], ['ಹತ್ತು ಸಾವಿರ', 10000], ['ನೂರು ಇಪ್ಪತ್ತು', 120], ['ತೊಂಬತ್ತು', 90], ['೫೦', 50], ['ಹದಿನೈದು', 15]]) {
      const a = SMParse.extractAmount(SMParse.toLatin(kn)); eq(a && a.amount, n, `S21-2 "${kn}" is ₹${n}`);
    }
    // S21-3 Kannada script all the way through Quick Entry
    for (const [kn, cat, amt, mode] of [['ಈರುಳ್ಳಿ 100 ರೂಪಾಯಿ', 'Groceries', 100], ['ಹಾಲು ಅರವತ್ತು', 'Groceries', 60], ['ಸೌತೆಕಾಯಿ 30', 'Groceries', 30], ['ಹೀರೇಕಾಯಿ 40', 'Groceries', 40],
                                        ['ತರಕಾರಿ 350 ಕ್ಯಾಶ್', 'Groceries', 350, 'Cash'], ['ಫಿನಾಯಿಲ್ 120', 'Cleaning', 120], ['ಪ್ಲಂಬರ್ 500 ಯುಪಿಐ', 'Repairs', 500, 'UPI'], ['ಕರೆಂಟ್ ಬಿಲ್ 4500', 'Electricity', 4500], ['ಸಂಬಳ ಹತ್ತು ಸಾವಿರ', 'Salary', 10000]]) {
      i = await quick.intent(kn, adminUser, {});
      ok(i && i.tool === 'prepare_expense' && i.args.category === cat && i.args.amount === amt && (!mode || i.args.mode === mode), `S21-3 "${kn}" → ${cat} ₹${amt}${mode ? ' ' + mode : ''} (got ${JSON.stringify(i && i.args)})`);
    }
    i = await quick.intent('ಈರುಳ್ಳಿ 100', adminUser, {});
    eq(i.args.description, 'eerulli', 'S21-3 the expense is filed as "eerulli" — the same word typed entries learn from');
    // A resident's name said in Kannada is still a collection, never an expense.
    r = await ask('ಜಾನವಿ ಐದು ಸಾವಿರ ಯುಪಿಐ');
    ok(r.data.tool === 'prepare_payment' || /Jhanavi/.test(r.data.answer), `S21-3 "ಜಾನವಿ ಐದು ಸಾವಿರ ಯುಪಿಐ" is a payment by Jhanavi (${r.data.tool} · ${String(r.data.answer).slice(0, 90)})`);
    ok(!/expense|Groceries|Other/i.test(r.data.answer || ''), 'S21-3 …and not an expense called "jaanavi"');
    i = await quick.intent('ಜಾನವಿ ಐದು ಸಾವಿರ ಯುಪಿಐ', adminUser, {});
    ok(i.tool === 'prepare_payment' && i.args.amount === 5000 && i.args.mode === 'UPI', `S21-3 …₹5,000 by UPI (got ${JSON.stringify(i.args)})`);
    // S21-4 A complaint in Kannada keeps her own words; the room is read.
    for (const [kn, room] of [['ರೂಮ್ 106 ನಲ್ಲಿ ನಲ್ಲಿ ಸೋರುತ್ತಿದೆ', '106'], ['ಫ್ಯಾನ್ ಕೆಲಸ ಮಾಡ್ತಿಲ್ಲ ರೂಮ್ 12', '12'], ['ನೀರು ಬರುತ್ತಿಲ್ಲ', undefined], ['current illa room 7', '7'], ['nalli soruttide', undefined], ['fan kelsa madtilla room 4', '4']]) {
      i = await quick.intent(kn, adminUser, {});
      ok(i && i.tool === 'prepare_complaint' && i.args.description === kn && i.args.room === room, `S21-4 "${kn}" is a complaint${room ? ' for room ' + room : ''}, worded as she said it (got ${JSON.stringify(i && i.args)})`);
    }
    // S21-5 An item with no amount asks how much — instead of "I'm not sure".
    for (const t of ['pudina soppu', 'eerulli', 'ಈರುಳ್ಳಿ', 'phenyl']) {
      r = await ask(t);
      ok(/^How much was the /.test(r.data.answer || '') && r.data.clarify, `S21-5 "${t}" asks how much (got "${String(r.data.answer).slice(0, 80)}")`);
      ok(/ $/.test(r.data.retry_text || '') && !/\d/.test(r.data.retry_text), `S21-5 …and puts "${(r.data.retry_text || '').trim()}" back in the box for her to add the amount`);
      ok(!r.data.proposal, 'S21-5 …and prepares nothing');
    }
    r = await ask('pudina soppu 20'); eq(r.data.proposal && r.data.proposal.preview.amount, 20, 'S21-5 adding the amount then prepares the expense');
    // …but only for things she buys: commands, questions and unknown words are untouched.
    for (const t of ['rent', 'rent due', 'milk finished', 'onion price', 'wifi', 'fan', 'laptop', 'Erode']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(!i || !/How much was/.test(i.clarify || ''), `S21-5 "${t}" is not mistaken for an item without an amount`);
    }
    // S21-6 A question in Kannada is left for the Copilot.
    for (const t of ['ಯಾರು ರೆಂಟ್ ಕೊಟ್ಟಿಲ್ಲ', 'eshtu collection aaytu']) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); eq(i, null, `S21-6 "${t}" is a question, not an entry`); }
    // S21-7 The spoken Kannada path is local: a clear phrase never calls the model.
    {
      let calls = 0; const keep = ai.providers.groqText, keepStub = ai.providers._stub;
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => { calls++; return '{}'; };
      try {
        i = await quick.intent('ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ', adminUser, {}, { voice: true, alternatives: ['ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ'] });
        ok(i.tool === 'prepare_expense' && i.args.amount === 100 && i.args.category === 'Groceries', 'S21-7 spoken "ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ" → onion ₹100 Groceries');
        eq(calls, 0, 'S21-7 …with no AI call');
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // S21-8 /copilot/category — the purchase form asks for words its own list lacks.
    for (const [item, cat] of [['Eerulli', 'Groceries'], ['ಹಾಲು', 'Groceries'], ['phenyl', 'Cleaning'], ['zzkumbla', 'Groceries'], ['laptop', null]]) {
      r = await A('POST', '/copilot/category', { item });
      ok(r.status === 200 && r.data.category === cat, `S21-8 category for "${item}" is ${cat} (got ${r.status} ${JSON.stringify(r.data)})`);
    }
    r = await S('POST', '/copilot/category', { item: 'eerulli' }); eq(r.status, 200, 'S21-8 staff may use it (the purchase form is theirs too)');
    r = await api('POST', '/copilot/category', { item: 'eerulli' }); eq(r.status, 401, 'S21-8 not without a login');
    r = await A('POST', '/copilot/category', {}); eq(r.status, 400, 'S21-8 an empty item is refused');
    {
      let calls = 0; const keep = ai.providers.groqText, keepStub = ai.providers._stub;
      ai.providers._stub = true; ai.providers.groqText = async () => { calls++; return '{"category":"Repairs"}'; };
      try { r = await A('POST', '/copilot/category', { item: 'laptop' }); eq(r.data.category, null, 'S21-8 an unknown word stays unknown'); eq(calls, 0, 'S21-8 …the model is never asked (no text leaves the server)'); }
      finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // ── Review S21 (round 1 BLOCK) ────────────────────────────────────────
    // B1/S4: Kannada amounts as people say them — never a confident wrong figure.
    for (const [kn, n] of [['ಐದೂವರೆ ಸಾವಿರ', 5500], ['ಐದು ಸಾವಿರದ ಇನ್ನೂರ ಐವತ್ತು', 5250], ['ಇನ್ನೂರ ಐವತ್ತು', 250], ['ನೂರ ಐವತ್ತು', 150], ['ಐನೂರ ಐವತ್ತು', 550],
                           ['ಒಂದೂವರೆ ಸಾವಿರ', 1500], ['ಎರಡೂವರೆ ಸಾವಿರ', 2500], ['ನಾಲ್ಕೂವರೆ ಸಾವಿರ', 4500], ['ಆರ್ ಸಾವಿರ', 6000], ['ಐದ್ ಸಾವಿರ', 5000], ['ಮೂರ್ ಸಾವಿರ', 3000],
                           ['ಇಪ್ಪತ್ತೈದು', 25], ['ಎಪ್ಪತ್ತೈದು', 75], ['ಇಪ್ಪತ್ಮೂರು', 23], ['ನೂರೈವತ್ತು', 150], ['ಐನೂರೈವತ್ತು', 550], ['ಆರನೂರು', 600], ['ಏಳ್ನೂರು', 700], ['ಮುನ್ನೂರ ಎಪ್ಪತ್ತೈದು', 375]]) {
      const a = SMParse.extractAmount(SMParse.toLatin(kn)); eq(a && a.amount, n, `B1 "${kn}" is ₹${n}`);
    }
    i = await quick.intent(`Jhanavi ${alpha} ಐದೂವರೆ ಸಾವಿರ ಯುಪಿಐ`, adminUser, {});
    ok(i.tool === 'prepare_payment' && i.args.resident_id === jh.id && i.args.amount === 5500 && i.args.mode === 'UPI', `B1 a rent said in Kannada previews the right figure: ₹5,500 (got ${JSON.stringify(i.args)})`);
    for (const t of ['xyzzy saavira', 'priya saavira', 'aidoovre saavira', SMParse.toLatin('ಐದೂವ್ರೆ ಸಾವಿರ')]) eq(SMParse.extractAmount(t), null, `B1 "${t}": a Kannada multiplier after a word we cannot read gives NO amount (she is asked), never ×1`);
    for (const [t, n] of [['onion hundred', 100], ['onion hundred rupees', 100], ['haalu nooru', 100], ['aidu nooru', 500], ['aidu noora aivattu', 550], ['eradu saavira aidu nooru', 2500]]) eq(SMParse.extractAmount(t).amount, n, `B1 English "${t}" is still ₹${n}`);
    for (const [t, n] of [['a thousand', 1000], ['one and a half thousand', 1500], ['six thousand', 6000], ['ondu saavira', 1000]]) eq(SMParse.extractAmount(t).amount, n, `B1 "${t}" still ₹${n}`);
    // S6: a quantity is not the price.
    for (const [t, n] of [['5 kg rice 500', 500], ['5kg rice 500', 500], ['ಐದು ಕೆಜಿ ಅಕ್ಕಿ ಐನೂರು', 500], ['1 dozen eggs 80', 80], ['2 litre oil 340', 340], ['milk 2 packets 56', 56]]) {
      const a = SMParse.extractAmount(SMParse.toLatin(t)); eq(a && a.amount, n, `S6 "${t}" is ₹${n}, not the quantity`);
    }
    for (const t of ['two packets of milk', 'ಹಾಲು ಮೂರು ಪ್ಯಾಕೆಟ್']) eq(SMParse.extractAmount(SMParse.toLatin(t)), null, `S6 "${t}" has no price`);
    // B2: the amount question never takes over a command, a question or a note word.
    await A('POST', '/purchases', { amount: 40, category: 'Groceries', description: 'weekly stock from market fresh', purchase_date: daysAgo(1), payment_mode: 'Cash' });
    quick.invalidateHistory();
    for (const t of ['milk expenses', 'milk bill', 'grocery bill', 'buy milk', 'pay milk', 'groceries', 'cleaning', 'water', 'gas', 'cylinder', 'menu', 'stock', 'market', 'fresh milk', 'weekly stock', 'eerulli haalu akki bele tuppa']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(!i || !/How much was/.test(i.clarify || ''), `B2 "${t}" is not taken over by "How much was…" (got ${JSON.stringify(i && (i.clarify || i.tool))})`);
    }
    for (const t of ['onions', 'tondekaayi', 'pudeena soppu']) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && /^How much was/.test(i.clarify || '') && i.ask === 'amount', `B2 "${t}" still asks how much`); }
    i = await quick.intent('tondekaayi 40', adminUser, {}); ok(i.args.category === 'Groceries' && /-kaayi/.test(i.category_basis), 'minor: an unlisted "-kaayi" vegetable is Groceries by the rule');
    // S1: a spoken item with no amount asks her — the model is not called and cannot invent an amount.
    {
      let calls = 0; const keep = ai.providers.groqText, keepStub = ai.providers._stub;
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => { calls++; return '{"phrase":"onion 100","confidence":"high"}'; };
      try {
        i = await quick.intent('ಈರುಳ್ಳಿ', adminUser, {}, { voice: true, alternatives: ['ಈರುಳ್ಳಿ'] });
        ok(!i.tool && /^How much was the eerulli/.test(i.clarify), `S1 spoken "ಈರುಳ್ಳಿ" asks how much (got ${JSON.stringify(i.tool || i.clarify)})`);
        eq(calls, 0, 'S1 …with no AI call (nothing can invent "100")');
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // S2: a Kannada question with the question word last is a question.
    for (const t of [`Jhanavi ${alpha} rent eshtu`, `Jhanavi ${alpha} ಎಷ್ಟು ಕೊಡಬೇಕು`, 'eshtu haalu', `yaaru jhanavi`, 'ರೆಂಟ್ ಯಾರು ಕೊಟ್ಟಿಲ್ಲ']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); eq(i, null, `S2 "${t}" is a question, not an entry`);
    }
    // S3: a resident whose name is a Kannada question word is still found.
    const elli = (await A('POST', '/guests', { name: `Elli Q${alpha}`, phone: `97${uniq}03`.slice(0, 10), room_id: room.id, bed_number: '3', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(elli && elli.id, 'S3 (fixture) a resident named Elli');
    i = await quick.classify('Elli 5000', adminUser, {}, { allowModel: false });
    ok(i && i.tool === 'prepare_payment' && i.args.resident_id === elli.id && i.args.amount === 5000, `S3 "Elli 5000" is her payment, as before S21 (got ${JSON.stringify(i && i.args)})`);
    await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [elli.id]);
    // Minor: wordings and leftovers.
    for (const t of ['ಸೋರ್ತಿದೆ ರೂಮ್ 5', 'ಲೈಟ್ ಹೋಗಿದೆ', 'ಫ್ಯಾನ್ ತಿರುಗ್ತಿಲ್ಲ']) { i = await quick.intent(t, adminUser, {}); eq(i && i.tool, 'prepare_complaint', `minor: "${t}" is a complaint`); }
    for (const [t, d] of [['ಈರುಳ್ಳಿ 100 ರೂ', 'eerulli'], ['ಪ್ಲಂಬರ್ 500 ಕೊಟ್ಟೆ', 'plumber'], ['eerullige 50', 'eerullige']]) { i = await quick.intent(t, adminUser, {}); eq(i.args.description, d, `minor: "${t}" is filed as "${d}"`); }
    i = await quick.intent('eerullige 50', adminUser, {}); eq(i.args.category, 'Groceries', 'minor: a Kannada case ending on an item still matches it');
    for (const t of ['raveena 5000', 'kolin 300']) { i = await quick.intent(t, adminUser, {}); eq(i.args.category, 'Other', `minor: "${t}" is not stretched to a short dictionary word`); }
    eq(SMParse.toLatin('TEE ಟೀ'), 'TEE tea', 'minor: English typed beside Kannada is left as typed');
    eq(SMParse.toLatin('ಈರುಳ್ಳಿ'.normalize('NFD')), 'eerulli', 'minor: decomposed Kannada text reads the same');
    // ── Review S21 round 2 ───────────────────────────────────────────────
    // R1: a full stop (phone voice typing adds one) never loses or changes the amount.
    for (const [t, n] of [[`Jhanavi ${alpha} paid 5000.`, 5000], [`Jhanavi ${alpha} 5,000.`, 5000], [`Jhanavi ${alpha} five thousand.`, 5000], [`Jhanavi ${alpha} ಐದು ಸಾವಿರ.`, 5000]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.amount === n, `R1 "${t}" is ₹${n} (got ${JSON.stringify(i && i.args)})`);
    }
    for (const [t, n] of [['onion 100.', 100], ['onion 1.5k.', 1500], ['onion 2.5 lakh.', 250000], ['onion 99.50', 100]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_expense' && i.args.amount === n, `R1 "${t}" is ₹${n} (got ${JSON.stringify(i && i.args)})`);
    }
    // R2: "g pay" and a lone letter are not grams or litres; glued units still are.
    for (const t of [`Jhanavi ${alpha} 6000 g pay`, `Jhanavi ${alpha} 6000 G Pay`, `Jhanavi ${alpha} 6000 l`]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.args.amount === 6000, `R2 "${t}" keeps ₹6,000 (got ${JSON.stringify(i && i.args)})`);
    }
    i = await quick.classify(`Jhanavi ${alpha} 6000 g pay`, adminUser, {}, { allowModel: false }); eq(i.args.mode, 'UPI', 'R2 …and "g pay" is UPI');
    for (const [t, n] of [['rice 500g 60', 60], ['oil 2l 340', 340]]) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); eq(i.args.amount, n, `R2 "${t}": the glued quantity is skipped, the price is ₹${n}`); }
    // R3: English words that start with a dictionary item keep their category.
    for (const [t, cat] of [['milkman 900', 'Groceries'], ['milkman paid 900', 'Groceries'], ['toiletries 300', 'Cleaning'], ['onions 80', 'Groceries']]) {
      i = await quick.intent(t, adminUser, {}); eq(i.args.category, cat, `R3 "${t}" is ${cat}, as before S21`);
    }
    // Should-fix: the amount's own words are never read as a resident's name.
    const noora = (await A('POST', '/guests', { name: `Noora Q${alpha}`, phone: `97${uniq}04`.slice(0, 10), room_id: room.id, bed_number: '4', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(noora && noora.id, 'round 2 (fixture) a resident named Noora');
    for (const [t, n] of [['ಈರುಳ್ಳಿ ನೂರೈವತ್ತು', 150], ['ಹಾಲು ನೂರು', 100]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && i.tool === 'prepare_expense' && i.args.amount === n && i.args.category === 'Groceries', `round 2 "${t}" is a ₹${n} grocery, not Noora's payment (got ${JSON.stringify(i && [i.tool, i.args])})`);
    }
    i = await quick.classify('Noora 5000', adminUser, {}, { allowModel: false }); ok(i && i.args.resident_id === noora.id, 'round 2 …while "Noora 5000" is still hers');
    await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [noora.id]);
    // Minor: a quantity with no price asks how much.
    for (const [t, item] of [['ಹಾಲು ಮೂರು ಪ್ಯಾಕೆಟ್', 'haalu'], ['milk 3 packets', 'milk']]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.ask === 'amount' && new RegExp(`^How much was the ${item}\\?`).test(i.clarify), `round 2 "${t}" asks how much the ${item} was (got ${JSON.stringify(i && (i.clarify || i.tool))})`);
    }
    // ── Review S21 round 3 (N1): a resident's name is never a number ─────
    const roomNo2 = '8' + uniq.slice(-2);
    let room2 = (await A('POST', '/rooms', { room_number: roomNo2, floor: 8, total_beds: 4, monthly_rent: 6000, room_type: 'sharing' })).data;
    if (!room2 || !room2.id) { const rl = (await A('GET', '/rooms')).data; room2 = (rl.list || rl).find(x => x.room_number === roomNo2); }
    const nk = (await A('POST', '/guests', { name: `Noora K${alpha}`, phone: `97${uniq}05`.slice(0, 10), room_id: room2.id, bed_number: '1', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    const an = (await A('POST', '/guests', { name: `Ainoor Z${alpha}`, phone: `97${uniq}06`.slice(0, 10), room_id: room2.id, bed_number: '2', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(nk && nk.id && an && an.id, 'N1 (fixture) residents named Noora and Ainoor');
    for (const [t, who, mode] of [[`Noora K${alpha} cash`, nk, 'Cash'], [`Noora K${alpha}`, nk], [`Noora K${alpha} paid`, nk], ['Noora paid', nk], ['Noora upi', nk, 'UPI'], ['Ainoor paid', an]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && i.tool === 'prepare_payment' && !i.args.amount && (!mode || i.args.mode === mode), `N1 "${t}" is her payment with NO amount — never ₹100/₹500 from her name (got ${JSON.stringify(i && i.args)})`);
    }
    for (const t of ['noora', 'noora deposit']) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && !i.args.amount, `N1 "${t}" is not ₹100 (got ${JSON.stringify(i && (i.args || i.clarify))})`); }
    for (const [t, who, n] of [[`Noora K${alpha} 5000 upi`, nk, 5000], [`Noora K${alpha} aidu saavira`, nk, 5000], ['Ainoor 5000', an, 5000]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.args.resident_id === who.id && i.args.amount === n, `N1 "${t}" is still ₹${n}`);
    }
    for (const [t, n] of [['ಈರುಳ್ಳಿ ನೂರೈವತ್ತು', 150]]) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_expense' && i.args.amount === n, `N1 "${t}" (joined ನೂರೈವತ್ತು) is still ₹${n} with a Noora living here`); }
    // Spaced "noora aivattu" with a resident named Noora: her name wins, as before S21 (₹50, shown for her to check).
    i = await quick.classify('noora aivattu onion', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.amount === 50, `N2 with a Noora living here, spaced "noora aivattu" is read as her name + ₹50, as before S21 (got ${JSON.stringify(i && [i.tool, i.args])})`);
    eq(SMParse.extractAmount('noora aivattu onion').amount, 150, 'N2 …and with no Noora it is Kannada ₹150');
    eq(SMParse.extractAmount('noora'), null, 'N1 "noora" alone is a word, not ₹100');
    eq(SMParse.parseCollection(`Noora K${alpha} cash`, [{ id: nk.id, name: nk.name }]).amount, null, 'N1 the on-device Collect parser agrees: no amount from her name');
    eq(SMParse.parseCollection(`Ainoor Z${alpha} cash`, [{ id: an.id, name: an.name }]).amount, null, 'N1 …and "Ainoor" is not ₹500 there either');
    eq(SMParse.parseCollection(`Ainoor Z${alpha} 5000 cash`, [{ id: an.id, name: an.name }]).amount, 5000, 'N1 …while her real amount is kept');
    // Round 4 (N2): her name before her amount never adds ₹100 to it.
    for (const [t, n, mode] of [[`Noora K${alpha} five thousand`, 5000], [`Noora K${alpha} aidu saavira`, 5000], [`Noora K${alpha} eradu saavira`, 2000], [`Noora K${alpha} aaru saavira cash`, 6000, 'Cash'],
                                [`Noora K${alpha} do hazaar`, 2000], [`Noora K${alpha} aivattu`, 50], ['noora aidu saavira upi', 5000, 'UPI'], ['noora ondu saavira', 1000], ['Noora five thousand', 5000]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && i.tool === 'prepare_payment' && i.args.amount === n && (!mode || i.args.mode === mode), `N2 "${t}" is a payment of ₹${n}, not ₹${n + 100} (got ${JSON.stringify(i && [i.tool, i.args || i.clarify])})`);
    }
    eq(SMParse.parseCollection(`Noora K${alpha} eradu saavira`, [{ id: nk.id, name: nk.name }]).amount, 2000, 'N2 the Collect parser agrees: ₹2,000');
    for (const [t, cat] of [[`Priya Das paid`, null]]) {
      const r = SMParse.parseCollection(t, [{ id: 99, name: 'Priya Das' }]); eq(r.amount, null, 'N2 "Priya Das paid" is not ₹10 ("das" is her name)');
    }
    eq(SMParse.extractAmount('aidu noora'), null, 'minor: "aidu noora" is unclear — no amount, she is asked');
    // Round 5 (N3): a resident's surname that is also a number ("Das" = 10) never shrinks someone else's amount.
    const pd = (await A('POST', '/guests', { name: `Priya Das`, phone: `97${uniq}07`.slice(0, 10), room_id: room2.id, bed_number: '3', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    const kv = (await A('POST', '/guests', { name: `Kavya R${alpha}`, phone: `97${uniq}08`.slice(0, 10), room_id: room2.id, bed_number: '4', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(pd && pd.id && kv && kv.id, 'N3 (fixture) Priya Das and Kavya live here');
    i = await quick.classify('Kavya das hazaar', adminUser, {}, { allowModel: false });
    ok(i && i.tool === 'prepare_payment' && i.args.amount !== 1000, `N3 "Kavya das hazaar" is never ₹1,000 — unclear, so she is asked (got ${JSON.stringify(i && i.args)})`);
    eq(SMParse.parseCollection('Kavya das hazaar', [{ id: pd.id, name: 'Priya Das' }, { id: kv.id, name: kv.name }]).amount, null, 'N3 the Collect parser agrees: no ₹1,000');
    i = await quick.classify('Priya Das paid', adminUser, {}, { allowModel: false }); ok(i && i.args.resident_id === pd.id && !i.args.amount, 'N3 "Priya Das paid" is her payment, no amount');
    i = await quick.classify('Priya Das 6000 upi', adminUser, {}, { allowModel: false }); ok(i && i.args.resident_id === pd.id && i.args.amount === 6000, 'N3 "Priya Das 6000 upi" is ₹6,000');
    await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[pd.id, kv.id]]);
    await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[nk.id, an.id]]);
    // ── Hotfix 21.1 (owner's phone, Test site, English-mode mic) ──────────
    // Chrome capitalises the first word: "Nooru rupaye" must not leave "Nooru" as the item.
    i = await quick.classify('Nooru rupaye', adminUser, {}, { allowModel: false });
    ok(i && !i.tool && /^What was ₹100 for\?/.test(i.clarify), `H21.1 "Nooru rupaye" asks what ₹100 was for — never an item called "Nooru" (got ${JSON.stringify(i && (i.clarify || i.args))})`);
    for (const [t, d, n] of [['Eerulli Nooru rupaye', 'Eerulli', 100], ['Onion Hundred', 'Onion', 100], ['Pudina Soppu Ippattu', 'Pudina Soppu', 20], ['Milk Five Hundred', 'Milk', 500]]) {
      i = await quick.intent(t, adminUser, {});
      ok(i && i.tool === 'prepare_expense' && i.args.amount === n && i.args.description === d && i.args.category === 'Groceries', `H21.1 "${t}" → ${d} ₹${n} Groceries (got ${JSON.stringify(i && i.args)})`);
    }
    // English-mode hearings of Kannada numbers: ಐದು ಸಾವಿರ → "I sawida".
    for (const [t, n] of [['i sawida', 5000], ['I sawida', 5000], ['aru sawira', 6000], ['yeradu savida', 2000], ['ondu sawira', 1000]]) eq(SMParse.extractAmount(t).amount, n, `H21.1 "${t}" is ₹${n}`);
    for (const [t, n] of [['I paid 5000', 5000], ['I paid thousand', 1000]]) eq(SMParse.extractAmount(t).amount, n, `H21.1 "${t}" is unchanged (₹${n}) — "I" is only a number right before ಸಾವಿರ`);
    for (const t of ['are you there', 'i am here', 'id proof']) eq(SMParse.extractAmount(t), null, `H21.1 "${t}" has no amount`);
    for (const t of [`Jhanavi ${alpha} I sawida upi`, 'Jaanvi I sawida upi']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && i.tool === 'prepare_payment' && i.args.amount === 5000 && i.args.mode === 'UPI', `H21.1 "${t}" is a ₹5,000 UPI payment (got ${JSON.stringify(i && (i.args || i.clarify))})`);
    }
    eq(SMParse.extractAmount('Priya sawida'), null, 'H21.1 "sawida" after a name is unclear — she is asked, never ₹1,000');
    // Review 21.1 S1: the English-mode "I" = 5 is only before a Kannada ಸಾವಿರ/ನೂರು.
    for (const [t, n] of [['Priya I thousand', 1000], ['milk I hundred', 100], ['I nooru', 500]]) eq(SMParse.extractAmount(t).amount, n, `H21.1 S1 "${t}" is ₹${n}`);
    // Review 21.1 S2: an amount word is removed only as a whole word.
    const tz = (await A('POST', '/guests', { name: `Tenzin D${alpha}`, phone: `97${uniq}09`.slice(0, 10), room_id: room2.id, bed_number: '1', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(tz && tz.id, 'H21.1 S2 (fixture) a resident named Tenzin');
    i = await quick.classify('Tenzin ten', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.resident_id === tz.id, `H21.1 S2 "Tenzin ten" is still her payment (got ${JSON.stringify(i && [i.tool, i.args])})`);
    await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [tz.id]);
    // Review 21.1 H1: punctuation after the amount (phone voice typing adds full stops).
    for (const t of ['500.', '₹500.', '500, cash', 'Spent 500.', '500!', 'Five hundred.']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && !i.tool && /^What was ₹500 for\?/.test(i.clarify), `H21.1 H1 "${t}" asks what ₹500 was for — never a blind expense (got ${JSON.stringify(i && (i.clarify || i.args))})`);
    }
    for (const [t, d] of [['onion 100.', 'onion'], ['onion 100, cash', 'onion'], ['Onion 100.', 'Onion'], ['Milk 500;', 'Milk'], ['onion 1.5k.', 'onion']]) { i = await quick.intent(t, adminUser, {}); eq(i.args.description, d, `H21.1 H1 "${t}" is filed as "${d}"`); }
    for (const [t, d] of [['Tender coconut ten', 'Tender coconut'], ['Milk 2500ml 500', 'Milk 2500ml'], ['Kitten food ten', 'Kitten food'], ['Paneer 1500g 500', 'Paneer 1500g']]) { i = await quick.intent(t, adminUser, {}); eq(i.args.description, d, `H21.1 S2 "${t}" is filed as "${d}"`); }
    // ── Hotfix 21.2 (owner's phone, 10 Nov) ──────────────────────────────
    // English-mode hearings: "I do/I jo Savera" = ಐದು ಸಾವಿರ, "Noor" = ನೂರು, "upay" = UPI.
    for (const [t, n] of [['I do Savera', 5000], ['I jo savera', 5000], ['eye do sawera', 5000], ['onion I do nooru', 500], ['Noor upay', 100], ['eradu savera', 2000]]) eq(SMParse.extractAmount(t).amount, n, `H21.2 "${t}" is ₹${n}`);
    eq(SMParse.extractAmount('I do this 2').amount, 2, 'H21.2 "I do" is only 5 right before ಸಾವಿರ/ನೂರು');
    eq(SMParse.extractMode('noor upay').mode, 'UPI', 'H21.2 "upay" is UPI');
    for (const t of [`Jhanavi ${alpha} I do Savera upi`, `Jhanavi ${alpha} I Jo Savera upi`]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.amount === 5000 && i.args.mode === 'UPI', `H21.2 "${t}" is ₹5,000 UPI (got ${JSON.stringify(i && i.args)})`);
    }
    i = await quick.intent('onion I do nooru', adminUser, {}); eq(i.args.description, 'onion', 'H21.2 "onion I do nooru" is filed as "onion"');
    // A word once saved in an expense note is still a resident's name when it clearly is one.
    await A('POST', '/purchases', { amount: 2, category: 'Other', description: 'Janvi I Savera', purchase_date: daysAgo(1), payment_mode: 'UPI' });
    quick.invalidateHistory();
    for (const t of ['Janvi 5000 upi', 'Janvi I do Savera upi']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false });
      ok(i && i.tool === 'prepare_payment' && i.args.amount === 5000, `H21.2 "${t}" stays Jhanavi's payment even after an expense note said "Janvi" (got ${JSON.stringify(i && [i.tool, i.args])})`);
    }
    // The model may fix how a word was heard — never add a resident, a deposit, an amount or an item.
    const sg = (await A('POST', '/guests', { name: `Sachin G${alpha}`, phone: `97${uniq}10`.slice(0, 10), room_id: room2.id, bed_number: '2', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    ok(sg && sg.id, 'H21.2 (fixture) a resident named Sachin');
    {
      const keep = ai.providers.groqText, keepStub = ai.providers._stub; let reply = '{}';
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => reply;
      const say = async (t, phrase) => { reply = JSON.stringify({ phrase, confidence: 'high' }); return quick.intent(t, adminUser, {}, { voice: true, alternatives: [t] }); };
      try {
        i = await say('Nooru rupee', `Sachin G${alpha} 100 cash deposit`);
        ok(i && i.tool !== 'prepare_payment' && /^What was ₹100 for\?/.test(i.clarify || ''), `H21.2 "Nooru rupee" is never turned into a deposit from a resident nobody named (got ${JSON.stringify(i && (i.args || i.clarify))})`);
        i = await say('Nooru rupee', `Sachin G${alpha} 100 cash`);
        ok(i && i.tool !== 'prepare_payment' && /^What was ₹100 for\?/.test(i.clarify || ''), `H21.2 …nor into a plain payment from him: a resident is only used if his name was heard (got ${JSON.stringify(i && (i.args || i.clarify))})`);
        i = await say('noorulu upay', 'groceries 100 upi');
        ok(!i || i.tool !== 'prepare_expense', `H21.2 "noorulu upay": an amount nobody said is never filled in (got ${JSON.stringify(i && (i.args || i.clarify))})`);
        i = await say('Nooru rupee', 'groceries 100');
        ok(!i || i.tool !== 'prepare_expense', 'H21.2 an item is never conjured from a bare number');
        i = await say('Jaanvi 5000', `Jhanavi ${alpha} 5000 deposit`);
        ok(!(i && i.tool === 'prepare_payment' && i.args.type === 'deposit'), `H21.2 a "deposit" nobody said is never added (got ${JSON.stringify(i && i.args)})`);
        i = await say('Jaanvi upi', `Jhanavi ${alpha} 5000 upi`);
        ok(!(i && i.args && i.args.amount === 5000), 'H21.2 the model never adds the amount for a resident');
        // …but it may still fix what was heard:
        i = await say('heerly Nooru rupaye', 'onion 100 cash');
        ok(i && i.tool === 'prepare_expense' && i.args.description === 'onion' && i.args.amount === 100 && i.understood === 'onion 100 cash', `H21.2 "heerly Nooru rupaye" → onion ₹100 is still repaired (got ${JSON.stringify(i && i.args)})`);
        ok(!i.args.mode, 'H21.2 …without the "cash" nobody said (the form default applies)');
        i = await say('Suchin five thousand upi', `Sachin G${alpha} 5000 upi`);
        ok(i && i.tool === 'prepare_payment' && i.args.resident_id === sg.id && i.args.amount === 5000 && i.args.mode === 'UPI', `H21.2 a heard name the model spells properly is still repaired (got ${JSON.stringify(i && i.args)})`);
        // Two Jhanavis live here: "Jaanvee" does not say which, and the model may not pick one.
        i = await say('Jaanvee five thousand upi', `Jhanavi ${alpha} 5000 upi`);
        ok(i && i.tool === 'prepare_payment' && !i.args.resident_id && i.args.amount === 5000, `H21.2 r2 B3b a shared first name is never settled by the model — she is asked which (got ${JSON.stringify(i && i.args)})`);
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // ── Hotfix 21.2, review round 1 (BLOCK) ───────────────────────────────
    // B1: "Noor"/"Savera" are words and names too — a multiplier only after a number.
    const amtOf = (t, roster) => { const a = SMParse.extractAmount(SMParse.maskNames(SMParse.toLatin(t), roster || [])); return a ? a.amount : null; };
    const NJ = [{ id: 901, name: 'Noorjahan Begum' }];
    for (const [t, n, roster] of [['Noor salary aidu saavira', 5000], ['Noor stores rice five hundred', 500], ['Noor, five thousand upi', 5000, NJ], ['Noor paid five thousand upi', 5000, NJ], ['ನೂರ್ ಜಹಾನ್ ಐದು ಸಾವಿರ', 5000, NJ],
                                 ['savera hotel tiffin two hundred', 200], ['Savera five thousand', 5000], ['paid 500 Noor stores', 500], ['noor mahal 200', 200],
                                 ['eerulli noor', 100], ['yeruli noor upay', 100], ['tomato noor rupees', 100], ['Noor upay', 100], ['aidu noor', 500], ['I noor', 500], ['Jhanavi 5 Savera upi', 5000], ['eradu savera', 2000],
                                 ['aaru saavira', 6000, [{ id: 902, name: 'Aarushi M' }]], ['I do five hundred', 500]]) {
      eq(amtOf(t, roster), n, `H21.2 r2 B1 "${t}"${roster ? ' (with ' + roster[0].name + ')' : ''} is ₹${n}`);
    }
    for (const [t, roster] of [['Noor upay', NJ], ['Noor rupees', NJ], ['Noor'], ['Noor paid'], ['Savera'], ['Priya noor', [{ id: 903, name: 'Priya K' }]], ['Priya savera', [{ id: 903, name: 'Priya K' }]], ['I do sabira upi'], ['I do not know'], ['I do']]) {
      eq(amtOf(t, roster), null, `H21.2 r2 B1/S4 "${t}" has no amount — she is asked`);
    }
    i = await quick.classify('Noor salary aidu saavira', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_expense' && i.args.amount === 5000 && i.args.category === 'Salary', `H21.2 r2 B1 "Noor salary aidu saavira" is a ₹5,000 salary (got ${JSON.stringify(i && i.args)})`);
    i = await quick.classify('eerulli noor', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_expense' && i.args.amount === 100 && i.args.category === 'Groceries' && i.args.description === 'eerulli', `H21.2 r2 B1 "eerulli noor" is onion ₹100 with no AI (got ${JSON.stringify(i && i.args)})`);
    i = await quick.classify('Janvi I do sabira upi', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && !i.args.amount, `H21.2 r2 S4 "Janvi I do sabira upi" asks the amount — never ₹2 (got ${JSON.stringify(i && i.args)})`);
    // Fixtures with names that collide with number, rupee and item words.
    const roomNo3 = '7' + uniq.slice(-2);
    let room3 = (await A('POST', '/rooms', { room_number: roomNo3, floor: 7, total_beds: 10, monthly_rent: 6000, room_type: 'sharing' })).data;
    if (!room3 || !room3.id) { const rl = (await A('GET', '/rooms')).data; room3 = (rl.list || rl).find(x => x.room_number === roomNo3); }
    const mk = async (name, n) => (await A('POST', '/guests', { name, phone: `97${uniq}${n}`.slice(0, 10), room_id: room3.id, bed_number: String(n - 10), monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    const nj = await mk('Noorjahan Begum', 11), sv = await mk('Savitha Mohan', 12), ind = await mk('Indu Rao', 13), lk = await mk('Lakshmi Narayan', 14), ru = await mk('Rupa Menon', 15), p1 = await mk('Priya Dasgupta', 16), p2 = await mk('Priya Sharma', 17), sw = await mk('Swathi Prabhu', 18), rl2 = await mk('Rupa Shetty', 19);
    ok([nj, sv, ind, lk, ru, p1, p2, sw, rl2].every(g => g && g.id), 'H21.2 r2 (fixtures) Noorjahan, Savitha, Indu, Lakshmi, Rupa, two Priyas, Swathi');
    for (const t of ['Noor, five thousand upi', 'Noor paid five thousand upi', 'ನೂರ್ ಜಹಾನ್ ಐದು ಸಾವಿರ ಯುಪಿಐ']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.resident_id === nj.id && i.args.amount === 5000 && i.args.mode === 'UPI', `H21.2 r2 B1 "${t}" is Noorjahan's ₹5,000 by UPI — not ₹5,100, not a ₹100 expense (got ${JSON.stringify(i && [i.tool, i.args])})`);
    }
    i = await quick.classify('Noor upay', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && i.args.resident_id === nj.id && !i.args.amount, `H21.2 r2 B1 with a Noorjahan here, "Noor upay" is her payment with NO amount — her name is not ₹100 (got ${JSON.stringify(i && [i.tool, i.args])})`);
    // The word for rupees is not Rupa — nor, with two Rupas here, a "which Rupa?" question.
    for (const t of ['aidu nooru rupai', 'Nooru rupaye', 'eerulli nooru rupai']) { i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool !== 'prepare_payment', `H21.2 r2 "${t}" is not a payment from Rupa (got ${JSON.stringify(i && [i.tool, i.args || i.clarify])})`); }
    i = await quick.classify('Rupa Menon 5000 upi', adminUser, {}, { allowModel: false }); ok(i && i.args.resident_id === ru.id && i.args.amount === 5000, 'H21.2 r2 …while "Rupa Menon 5000 upi" is hers');
    i = await quick.classify('Rupa 5000 upi', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment' && !i.args.resident_id && i.args.amount === 5000, 'H21.2 r2 …and "Rupa 5000 upi" still asks which Rupa');
    eq(SMParse.parseCollection('aidu nooru rupai', [{ id: ru.id, name: ru.name }]).guest, null, 'H21.2 r2 …and the Collect parser agrees');
    // B2: an item she has filed under a real category stays an item beside a similar name.
    await A('POST', '/purchases', { amount: 50, category: 'Groceries', description: 'sweet', purchase_date: daysAgo(1), payment_mode: 'Cash' });
    await A('POST', '/purchases', { amount: 60, category: 'Groceries', description: 'sweet', purchase_date: daysAgo(2), payment_mode: 'Cash' });
    quick.invalidateHistory();
    i = await quick.classify('sweet 200', adminUser, {}, { allowModel: false });
    ok(i && i.tool === 'prepare_expense' && i.args.category === 'Groceries' && i.args.amount === 200, `H21.2 r2 B2 "sweet 200" stays a Groceries expense beside Swathi and Savitha (got ${JSON.stringify(i && [i.tool, i.args])})`);
    i = await quick.classify('Janvi 5000 upi', adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_payment', 'H21.2 r2 B2 …while "Janvi" (only ever filed under Other) is still a resident');
    {
      const keep = ai.providers.groqText, keepStub = ai.providers._stub; let reply = '{}';
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => reply;
      const say = async (t, phrase) => { reply = JSON.stringify({ phrase, confidence: 'high' }); return quick.intent(t, adminUser, {}, { voice: true, alternatives: [t] }); };
      try {
        // B3a: amount, rupee and mode words are not evidence of a name.
        for (const [t, phrase, n] of [['aaru savira upi', 'Savitha Mohan 6000 upi', '6,000'], ['ondu saavira upi', 'Indu Rao 1000 upi', '1,000'], ['ondu laksha upi', 'Lakshmi Narayan 100000 upi', '1,00,000'], ['Nooru rupee', 'Noorjahan Begum 100 cash', '100'], ['aidu nooru rupai', 'Rupa Menon 500', '500']]) {
          // (two Rupas live here: the rules already ask nothing about them)
          i = await say(t, phrase);
          ok(i && !i.tool && i.clarify === `What was ₹${n} for? Say the item too — e.g. "onion ${n.replace(/,/g, '')}".`, `H21.2 r2 B3a "${t}" is never a payment from ${phrase.split(' ')[0]} (got ${JSON.stringify(i && (i.args || i.clarify))})`);
        }
        // B3b: two Priyas — the model may not choose.
        i = await say('Priya aidu saavira upi', 'Priya Sharma 5000 upi'); ok(i && i.tool === 'prepare_payment' && !i.args.resident_id, `H21.2 r2 B3b "Priya aidu saavira upi" asks which Priya (got ${JSON.stringify(i && i.args)})`);
        i = await quick.intent('Priya Sharma aidu saavira upi', adminUser, {}, { voice: true }); eq(i.args.resident_id, p2.id, 'H21.2 r2 B3b …and "Priya Sharma" said in full is hers');
        // S1: the mode is the one she said.
        i = await say('Suchin aidu saavira cash', `Sachin G${alpha} 5000 upi`); ok(i && i.args.resident_id === sg.id && i.args.mode === 'Cash', `H21.2 r2 S1 heard "cash", the model said "upi" → Cash (got ${JSON.stringify(i && i.args)})`);
        // S2: the type is the one she said — swapped, dropped, or slipped in in Kannada script.
        for (const [t, phrase, type] of [['Suchin aidu saavira advance', `Sachin G${alpha} 5000 deposit`, 'advance'], ['Suchin aidu saavira deposit', `Sachin G${alpha} 5000`, 'deposit'], ['Suchin aidu saavira', `Sachin G${alpha} 5000 ಡೆಪಾಸಿಟ್`, 'rent'], ['Suchin aidu saavira', `Sachin G${alpha} 5000 ಅಡ್ವಾನ್ಸ್`, 'rent']]) {
          i = await say(t, phrase); ok(i && i.tool === 'prepare_payment' && i.args.type === type && i.args.amount === 5000, `H21.2 r2 S2 "${t}" ⇐ "${phrase.split(' ').slice(-1)}" stays ${type} (got ${JSON.stringify(i && i.args)})`);
        }
        // S5: a re-worded question adds nothing she said.
        i = await say('hello hello', '5000 cash'); eq(i, null, 'H21.2 r2 S5 "hello hello" is not turned into "What was ₹5,000 for?"');
        i = await say('Nooru rupee', '100 cash'); eq(i.retry_text, 'Nooru rupee ', 'H21.2 r2 S5 "Nooru rupee" keeps her own words in the box, without a "cash" nobody said');
        // S6: a room number is not an amount that was heard.
        i = await say('Suchin room 104 aidu saavira upi', `Sachin G${alpha} 5000 upi`); ok(i && i.args.resident_id === sg.id && i.args.amount === 5000, `H21.2 r2 S6 a room number does not block the real amount (got ${JSON.stringify(i && i.args)})`);
        i = await say('Suchin room 104', `Sachin G${alpha} 104 cash`); ok(i && i.tool === 'prepare_payment' && !i.args.amount, `H21.2 r2 S6 …and is never used as one (got ${JSON.stringify(i && i.args)})`);
        // S3: a name the model recognised but nobody can prove → a question with a tap, never an expense preview.
        i = await say('Satin aaru saavira cash', `Sachin G${alpha} 6000 cash`);
        ok(i && i.tool === 'prepare_payment' && !i.args.resident_id && i.args.suggest_id === sg.id && i.args.amount === 6000 && i.args.mode === 'Cash', `H21.2 r2 S3 "Satin aaru saavira cash" asks about Sachin with what was heard (got ${JSON.stringify(i && [i.tool, i.args])})`);
        reply = JSON.stringify({ phrase: `Sachin G${alpha} 6000 cash`, confidence: 'high' });
        r = await api('POST', '/copilot/ask', { text: 'Satin aaru saavira cash', voice: true, alternatives: ['Satin aaru saavira cash'], context: { page: 'finance-overview' } }, adminTok);
        ok(/^Did you mean Sachin G/.test(r.data.answer || '') && !r.data.proposal && r.data.actions.filter(x => x.tool === 'prepare_payment').length === 1 && r.data.actions[0].args.resident_id === sg.id, `H21.2 r2 S3 she sees "Did you mean Sachin…?" with one resident tap, nothing prepared (got ${String(r.data.answer).slice(0, 80)} · ${JSON.stringify(r.data.actions)})`);
        r = await api('POST', '/copilot/ask', { text: 'Satin aaru saavira cash', tool: 'prepare_payment', args: r.data.actions[0].args, context: { page: 'finance-overview' } }, adminTok);
        ok(r.data.proposal && r.data.proposal.preview.guest_id === sg.id && Number(r.data.proposal.preview.amount) === 6000 && r.data.proposal.preview.payment_mode === 'Cash', `H21.2 r2 S3 the tap prepares Sachin ₹6,000 Cash for her to confirm (got ${JSON.stringify(r.data.proposal && r.data.proposal.preview)})`);
        // …but a word that sounds nothing like the model's resident is no reason to ask about him.
        i = await say('heerly nooru rupaye', `Sachin G${alpha} 100 cash`); ok(i && i.tool === 'prepare_expense' && !i.args.suggest_id, `H21.2 r2 S3 "heerly" is not offered as Sachin (got ${JSON.stringify(i && [i.tool, i.args])})`);
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // ── Hotfix 21.2, review round 2 (BLOCK) ───────────────────────────────
    // N1: a shop's name after a small number is not a multiplier.
    for (const [t, n] of [['rice 50 Noor stores', 50], ['haalu aivattu Noor angadi', 50], ['milk fifty Noor stores', 50], ['bread 40 Noor bakery', 40], ['eggs 60 noor stores cash', 60], ['tiffin 80 Savera hotel', 80], ['curd thirty Savera hotel', 30],
                          ['40 noor', 40], ['5 noor', 500], ['aidu noor upay', 500], ['eradu savera kottlu', 2000], ['ippattu savera', 20000], ['eradu savera aidu nooru', 2500], ['I do Savera upi', 5000]]) {
      eq(amtOf(t), n, `H21.2 r3 N1 "${t}" is ₹${n}`);
    }
    for (const t of ['I noor stores', 'I do savera hotel', 'rice from Noor', 'salary Noor', 'sambala noor']) eq(amtOf(t), null, `H21.2 r3 N1/S-c "${t}" has no amount`);
    await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [nj.id]);   // no Noor lives here now: "Noor stores" is a shop
    for (const [t, n, cat] of [['rice 50 Noor stores', 50, 'Groceries'], ['eggs 60 noor stores cash', 60, 'Groceries'], ['tiffin 80 Savera hotel', 80]]) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && i.tool === 'prepare_expense' && i.args.amount === n && (!cat || i.args.category === cat), `H21.2 r3 N1 "${t}" previews ₹${n}, never ₹${n * (/savera/i.test(t) ? 1000 : 100)} (got ${JSON.stringify(i && i.args)})`);
    }
    i = await quick.classify('rice from Noor', adminUser, {}, { allowModel: false }); ok(!i || !(i.args && i.args.amount), 'H21.2 r3 S-c "rice from Noor" is not a ₹100 entry');
    // S-b: more spellings of "rupees" — never Rupa, never the item.
    for (const t of ['aidu nooru rupay', 'Nooru RuPay', 'aidu nooru rupya', 'aidu nooru rupe']) {
      i = await quick.classify(t, adminUser, {}, { allowModel: false }); ok(i && !i.tool && /^What was ₹[15]00 for\?/.test(i.clarify), `H21.2 r3 S-b "${t}" asks what it was for (got ${JSON.stringify(i && (i.args || i.clarify))})`);
    }
    // S-e: on a resident's page, a different name that was said is not given to the page's resident.
    r = await api('POST', '/copilot/ask', { text: 'Suchin aaru saavira cash', context: { page: 'resident', resident_id: jh.id } }, adminTok);
    ok(!r.data.proposal && /^Did you mean/.test(r.data.answer || '') && r.data.actions.some(a => a.args && a.args.resident_id === sg.id), `H21.2 r3 S-e on Jhanavi's page, "Suchin aaru saavira cash" asks about Sachin — it is not Jhanavi's payment (got ${String(r.data.answer).slice(0, 90)} · ${JSON.stringify(r.data.proposal && r.data.proposal.preview)})`);
    r = await api('POST', '/copilot/ask', { text: 'record payment', tool: 'prepare_payment', args: { amount: 6000, mode: 'Cash' }, context: { page: 'resident', resident_id: jh.id } }, adminTok);
    ok(r.data.proposal && r.data.proposal.preview.guest_id === jh.id, `H21.2 r3 S-e …while with no name said, the page's resident is still used (got ${JSON.stringify(r.data.proposal && r.data.proposal.preview)} · ${String(r.data.answer).slice(0, 60)})`);
    {
      const roomNo4 = '6' + uniq.slice(-2);
      let room4 = (await A('POST', '/rooms', { room_number: roomNo4, floor: 6, total_beds: 10, monthly_rent: 6000, room_type: 'sharing' })).data;
      if (!room4 || !room4.id) { const rl = (await A('GET', '/rooms')).data; room4 = (rl.list || rl).find(x => x.room_number === roomNo4); }
      const mk4 = async (name, n) => (await A('POST', '/guests', { name, phone: `97${uniq}${n}`.slice(0, 10), room_id: room4.id, bed_number: String(n - 20), monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
      const so1 = await mk4('Sowmya Rao', 21), so2 = await mk4('Soumya Kiran', 22), kt = await mk4('Kavitha Thomas', 23), ky = await mk4('Kavya Reddy', 24);
      ok([so1, so2, kt, ky].every(g => g && g.id), 'H21.2 r3 (fixtures) Sowmya + Soumya, Kavitha + Kavya');
      const keep = ai.providers.groqText, keepStub = ai.providers._stub; let reply = '{}';
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => reply;
      const say = async (t, phrase, alts) => { reply = JSON.stringify({ phrase, confidence: 'high' }); return quick.intent(t, adminUser, {}, { voice: true, alternatives: alts || [t] }); };
      try {
        // S-a: names that sound alike — the model may not pick.
        for (const [t, phrase, who] of [['Somya 5000 upi', 'Sowmya Rao 5000 upi', so1], ['Somya 5000 upi', 'Soumya Kiran 5000 upi', so2], ['Swati aidu saavira upi', 'Savitha Mohan 5000 upi', sv], ['Kavia 7000 cash', 'Kavitha Thomas 7000 cash', kt]]) {
          i = await say(t, phrase);
          ok(i && i.tool === 'prepare_payment' && !i.args.resident_id && !i.args.suggest_id, `H21.2 r3 S-a "${t}" ⇐ "${phrase.split(' ').slice(0, 2).join(' ')}": she is asked who — the model does not choose between similar names (got ${JSON.stringify(i && [i.tool, i.args])})`);
        }
        i = await say('Kavitha Thomas 7000 cash', 'Kavitha Thomas 7000 cash'); ok(i && i.args.resident_id === kt.id && i.args.amount === 7000, 'H21.2 r3 S-a …and a name said in full is hers without any model');
        // The rules already read "Swati" as a collection (Swathi lives here): a model
        // that names someone else does not replace that with its own suggestion.
        i = await say('Swati 5000 upi', `Sachin G${alpha} 5000 upi`);
        ok(i && i.tool === 'prepare_payment' && !i.args.suggest_id && !i.args.resident_id && (i.fuzzy || []).some(f => f.id === sw.id), `H21.2 r3 "Swati 5000 upi" still offers Swathi, not the model's Sachin (got ${JSON.stringify(i && [i.args, i.fuzzy])})`);
        // S-b through the repair: a rupee word is not evidence of Rupa (one Rupa here now).
        await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [rl2.id]);
        for (const t of ['aidu nooru rupay', 'Nooru RuPay', 'aidu nooru rupya']) { i = await say(t, 'Rupa Menon 500'); ok(i && i.tool !== 'prepare_payment', `H21.2 r3 S-b "${t}" is never a payment from Rupa (got ${JSON.stringify(i && (i.args || i.clarify))})`); }
        // S-d: "deposit" in what she said first is not dropped because an alternative lacks it.
        i = await say('Suchin 5000 deposit', `Sachin G${alpha} 5000`, ['Suchin 5000 deposit', 'Suchin 5000']);
        ok(i && i.tool === 'prepare_payment' && i.args.type === 'deposit' && i.args.amount === 5000, `H21.2 r3 S-d a heard "deposit" stays a deposit (got ${JSON.stringify(i && i.args)})`);
        i = await say('Suchin 5000 deposit', `Sachin G${alpha} 5000 deposit`, ['Suchin 5000 deposit', 'Suchin 5000']);
        ok(i && i.args.resident_id === sg.id && i.args.type === 'deposit', 'H21.2 r3 S-d …and a faithful repair of it is still used');
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
      await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[so1.id, so2.id, kt.id, ky.id]]);
    }
    await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[sg.id, nj.id, sv.id, ind.id, lk.id, ru.id, p1.id, p2.id, sw.id, rl2.id]]);
    // ── Hotfix 21.3 ──────────────────────────────────────────────────────
    // A name-like multiplier keeps its other reading, so the caller can ask.
    let x = SMParse.extractAmount('tiffin 80 savera'); ok(x.amount === 80000 && x.alt === 80 && x.altMatched === '80' && x.heardWord === 'savera', `H21.3 "tiffin 80 savera" reads ₹80,000 and remembers ₹80 (got ${JSON.stringify(x)})`);
    x = SMParse.extractAmount('plumber eradu savera'); ok(x.amount === 2000 && x.alt === 2, 'H21.3 "plumber eradu savera" reads ₹2,000 and remembers 2');
    for (const t of ['eradu savera aidu nooru', 'I do Savera upi', 'six thousand', 'onion 100', 'tiffin 80 Savera hotel']) { x = SMParse.extractAmount(t); ok(x && x.alt === undefined && x.lone === undefined, `H21.3 "${t}" has one reading only`); }
    x = SMParse.extractAmount('eerulli noor'); ok(x.amount === 100 && x.lone === 'noor', 'H21.3 a lone "noor" is marked as such');
    // A resident's name or "for" after the multiplier does not stop it (review 21.2 r3).
    const JK = [{ id: 904, name: 'Jhanavi K' }];
    for (const t of ['five savera Jhanavi', 'aidu savera Jhanavi kottlu', '5 savera Jhanavi upi', 'Jhanavi 5 Savera for rent']) eq(amtOf(t, JK), 5000, `H21.3 "${t}" is ₹5,000, not ₹5`);
    for (const [t, n] of [['rice 50 Noor stores', 50], ['tiffin 80 Savera hotel', 80], ['curd thirty Savera hotel', 30]]) eq(amtOf(t), n, `H21.3 "${t}" is still ₹${n}`);
    // "tiffin 80 savera": two believable readings → a question, both as taps.
    i = await quick.classify('tiffin 80 savera', adminUser, {}, { allowModel: false });
    ok(i && !i.tool && i.ask === 'which_amount' && i.options.length === 2 && i.options[0].args.amount === 80000 && i.options[0].args.description === 'tiffin' && i.options[1].args.amount === 80 && i.options[1].args.description === 'tiffin savera' && i.options.every(o => o.tool === 'prepare_expense' && o.args.category === 'Groceries'),
      `H21.3 "tiffin 80 savera" asks ₹80,000 or ₹80, prepares neither (got ${JSON.stringify(i)})`);
    {
      let calls = 0; const keep = ai.providers.groqText, keepStub = ai.providers._stub;
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => { calls++; return '{"phrase":"tiffin 80000","confidence":"high"}'; };
      try { i = await quick.intent('tiffin 80 savera', adminUser, {}, { voice: true, alternatives: ['tiffin 80 savera'] }); ok(i && i.ask === 'which_amount' && calls === 0, `H21.3 spoken, the same question — the AI is not asked to choose (${calls} calls)`); }
      finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    const purchases0 = (await pool.query(`SELECT COUNT(*)::int AS n FROM purchases`)).rows[0].n;
    r = await ask('tiffin 80 savera');
    ok(r.data.answer === 'Is that ₹80,000 — or ₹80 at "Savera"? Tap the right one.' && !r.data.proposal && r.data.actions.length === 2 && r.data.actions.every(a => a.tool === 'prepare_expense' && a.level === 'prepare'), `H21.3 the Copilot shows the question with two taps (got ${r.data.answer} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
    for (const [k, amount, desc] of [[0, 80000, 'tiffin'], [1, 80, 'tiffin savera']]) {
      const t2 = await api('POST', '/copilot/ask', { text: 'tiffin 80 savera', tool: r.data.actions[k].tool, args: r.data.actions[k].args, context: { page: 'finance-overview' } }, adminTok);
      ok(t2.data.proposal && Number(t2.data.proposal.preview.amount) === amount && t2.data.proposal.preview.description === desc && t2.data.proposal.preview.category === 'Groceries', `H21.3 tap "${r.data.actions[k].label}" → a preview of ₹${amount} "${desc}" to confirm (got ${JSON.stringify(t2.data.proposal && t2.data.proposal.preview)})`);
    }
    eq((await pool.query(`SELECT COUNT(*)::int AS n FROM purchases`)).rows[0].n, purchases0, 'H21.3 …and nothing is saved by the question or the taps');
    r = await ask('tiffin 80 savera', staffTok); eq(r.data.actions.length, 2, 'H21.3 staff get the same two taps');
    // Under ₹10 the plain reading is not believable: the multiplied one is prepared, and the preview says how it was read.
    for (const [t, n, said] of [['plumber eradu savera', 2000, 'eradu savera'], ['rice 5 noor', 500, '5 noor'], ['eerulli noor', 100, 'noor']]) {
      r = await ask(t); ok(r.data.proposal && Number(r.data.proposal.preview.amount) === n && r.data.answer.includes(`I read "${said}" as ₹${n.toLocaleString('en-IN')}.`), `H21.3 "${t}" prepares ₹${n} and says how it read it (got ${String(r.data.answer).slice(0, 140)})`);
    }
    r = await ask('onion 100'); ok(r.data.proposal && !/I read/.test(r.data.answer), 'H21.3 a plain "onion 100" says nothing extra');
    // Fixtures for the name cases.
    const roomNo5 = '5' + uniq.slice(-2);
    let room5 = (await A('POST', '/rooms', { room_number: roomNo5, floor: 5, total_beds: 10, monthly_rent: 6000, room_type: 'sharing' })).data;
    if (!room5 || !room5.id) { const rl = (await A('GET', '/rooms')).data; room5 = (rl.list || rl).find(z => z.room_number === roomNo5); }
    const mk5 = async (name, n) => (await A('POST', '/guests', { name, phone: `97${uniq}${n}`.slice(0, 10), room_id: room5.id, bed_number: String(n - 30), monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
    const bd = await mk5('Bindu Rao', 31), sc = await mk5('Sachin Gowda', 32), kv2 = await mk5('Kavya Reddy', 33);
    ok([bd, sc, kv2].every(g => g && g.id), 'H21.3 (fixtures) Bindu, Sachin, Kavya');
    r = await ask(`Jhanavi ${alpha} 5 Savera upi`); ok(r.data.proposal && Number(r.data.proposal.preview.amount) === 5000 && r.data.proposal.preview.guest_id === jh.id && /I read "5 savera" as ₹5,000\./.test(r.data.answer), `H21.3 a resident's "5 Savera" is ₹5,000, and the preview says so (got ${String(r.data.answer).slice(0, 140)})`);
    // "Did you mean …?" now has a way out when it was really a purchase.
    await A('POST', '/purchases', { amount: 20, category: 'Other', description: 'bindi', purchase_date: daysAgo(1), payment_mode: 'Cash' });
    quick.invalidateHistory();
    r = await ask('bindi 20');
    const resTap = r.data.actions.find(a => a.tool === 'prepare_payment'), expTap = r.data.actions.find(a => a.tool === 'prepare_expense');
    ok(/^Did you mean Bindu Rao\?/.test(r.data.answer) && !r.data.proposal && resTap && resTap.args.resident_id === bd.id && expTap && expTap.label === 'Not a resident — expense: bindi ₹20', `H21.3 "bindi 20" asks about Bindu AND offers the expense (got ${r.data.answer} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
    let t3 = await api('POST', '/copilot/ask', { text: 'bindi 20', tool: expTap.tool, args: expTap.args, context: { page: 'finance-overview' } }, adminTok);
    ok(t3.data.proposal && Number(t3.data.proposal.preview.amount) === 20 && t3.data.proposal.preview.description === 'bindi' && !t3.data.proposal.preview.guest_id, `H21.3 the expense tap prepares bindi ₹20 (got ${JSON.stringify(t3.data.proposal && t3.data.proposal.preview)})`);
    t3 = await api('POST', '/copilot/ask', { text: 'bindi 20', tool: resTap.tool, args: resTap.args, context: { page: 'finance-overview' } }, adminTok);
    ok(/How did Bindu Rao pay ₹20/.test(t3.data.answer || ''), 'H21.3 …and the resident tap carries on as her payment');
    r = await ask('Jhanavi 500 upi'); ok(/Which resident do you mean\?/.test(r.data.answer) && !r.data.actions.some(a => a.tool === 'prepare_expense'), 'H21.3 a real name shared by two residents ("Jhanavi") gets no expense tap');
    // On a resident's page, another name typed with digits is not that page's resident (review 21.2 S-e, second half).
    const onJh = t => api('POST', '/copilot/ask', { text: t, context: { page: 'resident', resident_id: jh.id } }, adminTok);
    r = await onJh('Suchin 6000 cash');
    ok(!r.data.proposal && /^Did you mean one of these\?/.test(r.data.answer) && r.data.actions[0].args.resident_id === sc.id && r.data.actions.some(a => a.label === `Jhanavi ${alpha} (Room ${room.room_number}) · this page` && a.args.resident_id === jh.id) && r.data.actions.some(a => a.tool === 'prepare_expense'),
      `H21.3 on Jhanavi's page "Suchin 6000 cash" prepares nothing: Sachin first, Jhanavi "this page", or an expense (got ${String(r.data.answer).slice(0, 60)} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
    // A word that resembles nobody is asked about — one tap — never silently hers, never a dead end.
    for (const [t, item] of [['Ramesh 6000 cash', 'Ramesh'], ['Jo 6000 cash', 'Jo'], ['6000 cash sound box', 'sound box']]) {
      r = await onJh(t);
      const her = r.data.actions.find(a => a.tool === 'prepare_payment'), exp = r.data.actions.find(a => a.tool === 'prepare_expense');
      ok(!r.data.proposal && r.data.answer === `Is this ₹6,000 from Jhanavi ${alpha} — the resident on this page?` && her && her.args.resident_id === jh.id && exp && exp.label === `Not a resident — expense: ${item} ₹6,000` && exp.args.description === item,
        `H21.3 on Jhanavi's page "${t}" asks whether it is hers, with the expense way out (got ${String(r.data.answer).slice(0, 70)} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
      const t4 = await api('POST', '/copilot/ask', { text: t, tool: her.tool, args: her.args, context: { page: 'resident', resident_id: jh.id } }, adminTok);
      ok(t4.data.proposal && t4.data.proposal.preview.guest_id === jh.id && Number(t4.data.proposal.preview.amount) === 6000 && t4.data.proposal.preview.payment_mode === 'Cash', `H21.3 …and her tap prepares her ₹6,000 Cash (got ${JSON.stringify(t4.data.proposal && t4.data.proposal.preview)})`);
    }
    r = await ask('Ramesh 6000 cash'); ok(!r.data.proposal && /could not find that resident/.test(r.data.answer) && !r.data.actions.length, 'H21.3 off a resident page, "Ramesh 6000 cash" is still "I could not find that resident"');
    // The warden's ordinary ways of saying it — Kannada, English, typos — need no tap (review 21.3 B1).
    for (const t of ['6000 cash', 'received 6000 rent from her by upi', 'record six thousand rent cash', 'collected 6000 rent for november by cash',
                     '6000 cash kottlu', '6000 cash kottaru', '6000 upi kottidaale', 'ivattu 6000 cash', 'baadige 6000 cash', '6000 cash bantu', '6000 cash tagonde', 'ee tingalu rent 6000 upi',
                     '6000 cash last month rent', '6000 cash room rent', '6000 cash security deposit', '6000 cash next month advance', '6000 upi late fee', '6000 upi from father', '6000 cash by hand',
                     '6000 cash rent received sir', 'log 6000 cash rent', 'save 6000 cash', 'recieved 6000 cash', 'payed 6000 cash', '6000 upi scan', 'Jhanavi 6000 cash']) {
      r = await onJh(t); ok(r.data.proposal && r.data.proposal.preview.guest_id === jh.id && Number(r.data.proposal.preview.amount) === 6000, `H21.3 …while "${t}" (no other name) is still hers (got ${String(r.data.answer).slice(0, 80)})`);
    }
    {
      const keep = ai.providers.groqText, keepStub = ai.providers._stub; let reply = '{}';
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => reply;
      const say = async (t, phrase) => { reply = JSON.stringify({ phrase, confidence: 'high' }); return quick.intent(t, adminUser, {}, { voice: true, alternatives: [t] }); };
      try {
        // The rules read a collection: the model may not turn it into a purchase.
        i = await say('Kavia aidu saavira upi', 'jaggery 5000 upi'); ok(i && i.tool === 'prepare_payment' && !i.understood, `H21.3 "Kavia aidu saavira upi" stays a collection — never "jaggery ₹5,000" (got ${JSON.stringify(i && [i.tool, i.args])})`);
        // A shared first letter is not a reason to ask about a resident.
        for (const t of ['samosa 200', 'stationery 300 cash']) { i = await say(t, `Sachin Gowda ${t.match(/\d+/)[0]}`); ok(i && i.tool === 'prepare_expense' && !i.args.suggest_id, `H21.3 "${t}" is not offered as Sachin (got ${JSON.stringify(i && [i.tool, i.args])})`); }
        for (const [t, who] of [['Satin aaru saavira cash', sc], ['such in aaru saavira cash', sc]]) { i = await say(t, 'Sachin Gowda 6000 cash'); ok(i && i.tool === 'prepare_payment' && i.args.suggest_id === who.id, `H21.3 "${t}" still asks about Sachin (got ${JSON.stringify(i && [i.tool, i.args])})`); }
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
    }
    // ── Hotfix 21.3, review round 1 ──────────────────────────────────────
    // The way-out tap names the whole item she said, not only the word that resembled a name.
    r = await ask('bindi box 20'); x = r.data.actions.find(z => z.tool === 'prepare_expense');
    ok(/^Did you mean Bindu Rao\?/.test(r.data.answer) && x && x.label === 'Not a resident — expense: bindi box ₹20' && x.args.description === 'bindi box' && x.args.amount === 20, `H21.3 r1 "bindi box 20" offers the expense "bindi box" (got ${JSON.stringify(r.data.actions.map(z => z.label))})`);
    // The "bought / purchase / bill" path gets the same question and the same note.
    for (const [t, big, small] of [['bought tiffin 80 savera', 80000, 80], ['purchase rice 50 savera', 50000, 50]]) {
      r = await ask(t); ok(!r.data.proposal && r.data.actions.length === 2 && r.data.actions[0].args.amount === big && r.data.actions[1].args.amount === small, `H21.3 r1 "${t}" asks ₹${big} or ₹${small} (got ${String(r.data.answer).slice(0, 70)})`);
    }
    r = await ask('bought rice 5 noor'); ok(r.data.proposal && Number(r.data.proposal.preview.amount) === 500 && /I read "5 noor" as ₹500\./.test(r.data.answer), `H21.3 r1 "bought rice 5 noor" → ₹500 with the note (got ${String(r.data.answer).slice(0, 120)})`);
    r = await ask('bought onion 100'); ok(r.data.proposal && Number(r.data.proposal.preview.amount) === 100 && r.data.via === 'local', 'H21.3 r1 an ordinary "bought onion 100" keeps its old path');
    // "and" after the multiplier does not hide the question.
    x = SMParse.extractAmount('tiffin eighty savera and coffee'); ok(x.amount === 80000 && x.alt === 80 && x.matched === 'eighty savera', `H21.3 r1 "tiffin eighty savera and coffee" keeps both readings (got ${JSON.stringify(x)})`);
    i = await quick.classify('tiffin eighty savera and coffee', adminUser, {}, { allowModel: false }); ok(i && i.ask === 'which_amount' && i.options[1].args.amount === 80, 'H21.3 r1 …and asks');
    eq(SMParse.extractAmount('six thousand and').matched, 'six thousand', 'H21.3 r1 a trailing "and" is not part of the amount');
    // Hundreds after the thousands belong to the number.
    for (const [t, n, roster] of [['Jhanavi 6 savera 5 noor upi', 6500, JK], ['6 thousand 5 hundred', 6500], ['6 saavira 5 nooru', 6500], ['aaru savera aidu noor', 6500], ['eradu savera eradu noor', 2200, NJ], ['6 thousand 500', 6000], ['2 savera 500', 2000]]) eq(amtOf(t, roster), n, `H21.3 r1 "${t}" is ₹${n}`);
    ok(SMParse.extractAmount('6 savera 5 noor').alt === undefined, 'H21.3 r1 …and "6 savera 5 noor" has one reading');
    for (const [t, n, roster] of [['tea 8 Savera for guests', 8], ['Jhanavi 5 Savera for rent', 5000, JK], ['Noor upay', null, NJ]]) eq(amtOf(t, roster), n, `H21.3 r1 "${t}" is ${n === null ? 'no amount' : '₹' + n}`);
    // A resident's "80 savera": ₹80,000 or ₹80 — asked, with her on both taps.
    r = await ask(`Jhanavi ${alpha} 80 savera upi`);
    ok(!r.data.proposal && r.data.answer === `Is that ₹80,000 or ₹80 from Jhanavi ${alpha}? Tap the right one.` && r.data.actions.length === 2 && r.data.actions.every(a => a.tool === 'prepare_payment' && a.args.resident_id === jh.id && a.args.mode === 'UPI') && r.data.actions[0].args.amount === 80000 && r.data.actions[1].args.amount === 80,
      `H21.3 r1 "Jhanavi … 80 savera upi" asks which amount (got ${String(r.data.answer).slice(0, 80)} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
    // The "I read …" note survives a resident tap.
    r = await ask('Sachin 5 savera upi');   // one Sachin here → resolved outright
    ok(r.data.proposal && /I read "5 savera" as ₹5,000\./.test(r.data.answer), 'H21.3 r1 a matched resident gets the note');
    r = await ask('Suchin 5 savera upi');
    const sTap = r.data.actions.find(a => a.tool === 'prepare_payment' && a.args.resident_id === sc.id);
    ok(!r.data.proposal && sTap, `H21.3 r1 "Suchin 5 savera upi" asks about Sachin (got ${String(r.data.answer).slice(0, 60)})`);
    t3 = await api('POST', '/copilot/ask', { text: 'Suchin 5 savera upi', tool: sTap.tool, args: sTap.args, context: { page: 'finance-overview' } }, adminTok);
    ok(t3.data.proposal && Number(t3.data.proposal.preview.amount) === 5000 && /I read "5 savera" as ₹5,000\./.test(t3.data.answer), `H21.3 r1 …and after the tap the preview still says how the amount was read (got ${String(t3.data.answer).slice(0, 140)})`);
    // ── Sprint 22: stability sweep ───────────────────────────────────────
    // A weight is not money, with or without a multiplier word.
    for (const [t, n] of [['rice 2 thousand 5 hundred grams', null], ['onion 1 thousand 2 hundred gm 50', 50], ['rice 5 hundred grams 60', 60], ['rice 500 grams 60', 60], ['plumber 2 thousand 5 hundred cash', 2500], ['6 thousand', 6000], ['a thousand', 1000], ['onion hundred', 100], ['1.5k', 1500]]) eq(amtOf(t), n, `S22 "${t}" is ${n === null ? 'no amount' : '₹' + n}`);
    // A resident's deposit in thousands is prepared, not asked about; an unusual figure still is.
    r = await ask(`Jhanavi ${alpha} hattu savera deposit upi`);
    ok(r.data.proposal && Number(r.data.proposal.preview.amount) === 10000 && r.data.proposal.preview.collection_type === 'deposit' && r.data.proposal.preview.guest_id === jh.id && /I read "hattu savera" as ₹10,000\./.test(r.data.answer), `S22 "hattu savera deposit" is her ₹10,000 deposit, with the note (got ${String(r.data.answer).slice(0, 120)})`);
    r = await ask(`Jhanavi ${alpha} 80 savera upi`); ok(!r.data.proposal && r.data.actions.length === 2, 'S22 …while ₹80,000 is still asked about');
    // On a resident's page: a leftover word that merely sits inside another name is not about her.
    const bh = await mk5('Bhavana Rao', 34), rn = await mk5('Rani Shetty', 35);
    ok(bh && bh.id && rn && rn.id, 'S22 (fixtures) Bhavana, Rani');
    for (const t of ['6000 cash van', '6000 cash ran']) {
      r = await onJh(t); ok(!r.data.proposal && r.data.answer === `Is this ₹6,000 from Jhanavi ${alpha} — the resident on this page?` && r.data.actions[0].args.resident_id === jh.id && !r.data.actions.some(a => a.args && (a.args.resident_id === bh.id || a.args.resident_id === rn.id)), `S22 on Jhanavi's page "${t}" asks about Jhanavi only (got ${String(r.data.answer).slice(0, 60)} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
    }
    r = await onJh('Bhavana 6000 cash'); ok(r.data.proposal && r.data.proposal.preview.guest_id === bh.id, 'S22 …while "Bhavana 6000 cash" there is Bhavana\'s payment');
    r = await onJh('Bhav 6000 cash'); ok((r.data.proposal && r.data.proposal.preview.guest_id === bh.id) || (r.data.actions || []).some(a => a.args && a.args.resident_id === bh.id), `S22 …and "Bhav" (the start of her name) still leads to Bhavana (got ${String(r.data.answer).slice(0, 60)})`);
    r = await ask('van 6000 cash'); ok(!r.data.proposal && r.data.actions.some(a => a.args && a.args.resident_id === bh.id), 'S22 off a resident page the old name search is unchanged');
    for (const t of ['6000 cash avalu kottlu', 'old dues 6000 cash', 'morning 6000 upi', 'hostel fee 6000 upi', '6000 cash all dues', 'idu 6000 cash', 'token 6000 upi', 'qr code 6000 upi']) {
      r = await onJh(t); ok(r.data.proposal && r.data.proposal.preview.guest_id === jh.id && Number(r.data.proposal.preview.amount) === 6000, `S22 "${t}" on her page needs no tap (got ${String(r.data.answer).slice(0, 70)})`);
    }
    await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[bh.id, rn.id]]);
    await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[bd.id, sc.id, kv2.id]]);
    // ── Sprint 24: one mic, two languages — the rules pick, no button, no AI ──
    {
      let calls = 0; const keep = ai.providers.groqText, keepStub = ai.providers._stub;
      ai.providers._stub = true; ai.providers.groqDownUntil = 0; ai.providers.groqText = async () => { calls++; return '{"phrase":"onion 100","confidence":"high"}'; };
      const dual = (t, alts) => quick.intent(t, adminUser, {}, { voice: true, alternatives: alts, dual: true });
      try {
        // English ear garbles the Kannada; the Kannada ear got it: the Kannada reading wins.
        i = await dual('heroine Nooru rupaye', ['heroine Nooru rupaye', 'ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ']);
        ok(i && i.tool === 'prepare_expense' && i.args.description === 'eerulli' && i.args.amount === 100 && i.args.category === 'Groceries' && i.understood === 'ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ', `S24-1 "heroine" (en) + "ಈರುಳ್ಳಿ" (kn) → onion ₹100 from the Kannada ear (got ${JSON.stringify(i && [i.tool, i.args, i.understood])})`);
        eq(calls, 0, 'S24-1 …with no AI call');
        // Kanglish: the English ear hears the name and UPI, the Kannada ear the amount — the more complete reading wins.
        const sg2 = (await A('POST', '/guests', { name: `Sachin Q${alpha}`, phone: `97${uniq}41`.slice(0, 10), room_id: room5.id, bed_number: '5', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
        i = await dual('Suchin I sawida', ['Suchin I sawida', 'ಸಚಿನ್ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.tool === 'prepare_payment' && i.args.resident_id === sg2.id && i.args.amount === 5000 && i.args.mode === 'UPI', `S24-1 Kanglish "Sachin aidu saavira upi": the English ear garbled it, the Kannada ear is complete → ₹5,000 UPI (got ${JSON.stringify(i && [i.args, i.understood])})`);
        // Equally complete readings that disagree on money: two taps, never a guess.
        i = await dual('Sachin 5000 upi', ['Sachin 5000 upi', 'ಸಚಿನ್ ಆರು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && !i.tool && i.ask === 'which_reading' && i.options.length === 2 && i.options.every(o => o.tool === 'prepare_payment' && o.args.resident_id === sg2.id) && new Set(i.options.map(o => o.args.amount)).size === 2 && i.options.every(o => /₹[56],000 · UPI/.test(o.label) && /^Sachin Q/.test(o.label)), `S24-2 ₹5,000 vs ₹6,000 for the same resident is asked, with two taps (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : i.args))})`);
        eq(calls, 0, 'S24-2 …the AI is not asked to break the tie');
        i = await dual('Sachin 5000 upi', ['Sachin 5000 upi', 'ಸಚಿನ್ 5000 ಯುಪಿಐ']);
        ok(i && i.tool === 'prepare_payment' && !i.ask && i.args.amount === 5000, 'S24-2 the same reading in two scripts is simply prepared');
        // Review S24 B1: a less complete reading that heard a DIFFERENT amount still forces the question —
        // the Kannada ear's "jaanavi" is only a fuzzy match (one point less), but ₹6,000 is not ₹5,000.
        i = await dual(`Jhanavi ${alpha} 5000 upi`, [`Jhanavi ${alpha} 5000 upi`, 'ಜಾನವಿ ಆರು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && !i.tool && i.ask === 'which_reading' && i.options.length === 2 && new Set(i.options.map(o => o.args.amount)).size === 2 && i.options.some(o => /^Janavi\? · ₹6,000/.test(o.label) || /^Jaanavi\? · ₹6,000/.test(o.label)), `S24-3 (B1) exact-name ₹5,000 vs fuzzy-name ₹6,000 is asked, and the unresolved tap says "Name?" (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : i.args))})`);
        // …but the same amount with a fuzzy name is one entry (the fuller reading wins, no question).
        i = await dual(`Jhanavi ${alpha} 5000 upi`, [`Jhanavi ${alpha} 5000 upi`, 'ಜಾನವಿ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.tool === 'prepare_payment' && i.args.resident_id === jh.id && i.args.amount === 5000 && !i.ask, `S24-3 (B1) the same ₹5,000 for "Jhanavi"/"ಜಾನವಿ" is simply prepared (got ${JSON.stringify(i && (i.args || i.options))})`);
        // Different people at the same amount: asked. Income vs expense: asked, whichever ear is primary.
        const sv2 = (await A('POST', '/guests', { name: `Savitha Q${alpha}`, phone: `97${uniq}43`.slice(0, 10), room_id: room5.id, bed_number: '7', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
        i = await dual('Sachin 5000 upi', ['Sachin 5000 upi', 'ಸವಿತಾ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.ask === 'which_reading' && i.options.some(o => o.args.resident_id === sg2.id) && i.options.some(o => /^Savit\w*\? · ₹5,000/.test(o.label) || o.args.resident_id === sv2.id), `S24-3 (B1) Sachin vs Savitha at ₹5,000 is asked (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : i.args))})`);
        i = await dual('sugar 5000 upi', ['sugar 5000 upi', 'ಸಚಿನ್ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.ask === 'which_reading' && i.options.map(o => o.tool).sort().join(',') === 'prepare_expense,prepare_payment', `S24-3 (B1) "sugar" expense vs Sachin's payment is asked (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : [i.tool, i.args]))})`);
        i = await dual('Sachin 5000 upi', ['Sachin 5000 upi', 'ಸಕ್ಕರೆ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.ask === 'which_reading' && i.options.map(o => o.tool).sort().join(',') === 'prepare_expense,prepare_payment', `S24-3 (B1) …and the other way round (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : [i.tool, i.args]))})`);
        i = await dual('sugar 5000 upi', ['sugar 5000 upi', 'ಸವಿತಾ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.ask === 'which_reading' && i.options.map(o => o.tool).sort().join(',') === 'prepare_expense,prepare_payment', `S24-3 (B1) an expense vs a payment whose resident is still fuzzy is asked too — income or expense is never a guess (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : [i.tool, i.args]))})`);
        // Review S24 S1: English speech makes Kannada noise; noise that fuzzy-matches a name cannot outrank a complaint.
        i = await dual('fan not working', ['fan not working', 'ಜಾನವಿ ಕೆ ಐದು ಸಾವಿರ']);
        ok(i && i.tool === 'prepare_complaint' && !i.ask, `S24-3 (S1) "fan not working" is kept over Kannada noise that half-matched a name (got ${JSON.stringify(i && [i.tool, i.ask, i.args || i.options])})`);
        i = await dual('fan not working', ['fan not working', 'ಸಚಿನ್ ಐದು ಸಾವಿರ ಯುಪಿಐ']);
        ok(i && i.ask === 'which_reading' && i.options.some(o => o.tool === 'prepare_complaint' && /^Complaint/.test(o.label)) && i.options.some(o => o.tool === 'prepare_payment' && o.args.resident_id === sg2.id), `S24-3 (S1) …but a payment that found its resident and an amount is offered beside it (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : i.args))})`);
        i = await dual('fan not working', ['fan not working', 'ಈರುಳ್ಳಿ ನೂರು']);
        ok(i && i.ask === 'which_reading' && i.options.some(o => o.tool === 'prepare_complaint') && i.options.some(o => o.tool === 'prepare_expense' && o.args.amount === 100), `S24-3 (review 2) a complaint vs an expense with an amount is asked, not guessed (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : [i.tool, i.args]))})`);
        await pool.query(`UPDATE guests SET is_active=false WHERE id = ANY($1)`, [[sg2.id, sv2.id]]);
        // English first and correct: kept as the primary, nothing re-ordered.
        i = await dual(`Jhanavi ${alpha} 5000 upi`, [`Jhanavi ${alpha} 5000 upi`, 'ಜಾನವಿ ಐದು ಸಾವಿರ']);
        ok(i && i.tool === 'prepare_payment' && i.args.resident_id === jh.id && i.args.amount === 5000 && i.args.mode === 'UPI' && !i.understood, `S24-1 a complete English reading stays (got ${JSON.stringify(i && [i.args, i.understood])})`);
        eq(calls, 0, 'S24-1 …still no AI call');
        i = await dual('onion 100', ['onion 100', 'ಬೆಳ್ಳುಳ್ಳಿ ನೂರು']);
        ok(i && i.ask === 'which_reading' && i.options.map(o => o.args.description).sort().join(',') === 'bellulli,onion', `S24-2 onion vs garlic at ₹100 is asked (got ${JSON.stringify(i && (i.options ? i.options.map(o => o.label) : i.args))})`);
        // A complaint is never offered as a tie; the fuller one (with a room) wins.
        i = await dual('tap leaking', ['tap leaking', 'ನಲ್ಲಿ ಸೋರುತ್ತಿದೆ ರೂಮ್ 106']);
        ok(i && i.tool === 'prepare_complaint' && i.args.room === '106', `S24-1 the complaint with the room number wins (got ${JSON.stringify(i && i.args)})`);
        // Neither ear made sense: the old path (AI repair, with its guards) still applies.
        i = await dual('heroine urupai', ['heroine urupai', 'ಹೀರೋಯಿನ್ ಉರುಪೈ']);
        ok(calls === 1 && (!i || !i.tool), `S24-1 nonsense in both ears goes to the repair step once — and its invented "₹100" is still refused (${calls} call; got ${JSON.stringify(i && (i.args || i.clarify))})`);
        i = await dual('heerly Nooru rupaye', ['heerly Nooru rupaye', 'ಹೀರ್ಲಿ ನೂರು ರೂಪಾಯಿ']);
        ok(calls === 2 && i && i.tool === 'prepare_expense' && i.args.description === 'onion' && i.args.amount === 100, `S24-1 …while a repair that only fixes the item word is still used (got ${JSON.stringify(i && i.args)})`);
        // Without the dual flag (one ear, as before) the behaviour is unchanged.
        calls = 0; i = await quick.intent('heroine Nooru rupaye', adminUser, {}, { voice: true, alternatives: ['heroine Nooru rupaye', 'ಈರುಳ್ಳಿ ನೂರು ರೂಪಾಯಿ'] });
        ok(i && i.tool === 'prepare_expense', 'S24-1 (control) the single-ear path is as before');
      } finally { ai.providers.groqText = keep; ai.providers._stub = keepStub; ai.providers.groqDownUntil = 0; }
      // Through the Copilot: the tie is a question with two preview taps; a tap prepares; nothing saved.
      const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM collections`)).rows[0].n;
      const sg3 = (await A('POST', '/guests', { name: `Sachin Q${alpha}`, phone: `97${uniq}42`.slice(0, 10), room_id: room5.id, bed_number: '6', monthly_rent: 6000, deposit_amount: 0, join_date: daysAgo(30), id_proof_type: 'Aadhaar' })).data;
      r = await api('POST', '/copilot/ask', { text: 'Sachin 5000 upi', voice: true, dual: true, alternatives: ['Sachin 5000 upi', 'ಸಚಿನ್ ಆರು ಸಾವಿರ ಯುಪಿಐ'], context: { page: 'home' } }, adminTok);
      ok(r.data.answer === 'I heard two different things — tap the right one.' && !r.data.proposal && r.data.actions.length === 2 && r.data.actions.every(a => a.tool === 'prepare_payment' && a.level === 'prepare'), `S24-2 the Copilot shows the two readings as taps (got ${r.data.answer} · ${JSON.stringify(r.data.actions.map(a => a.label))})`);
      const t5 = await api('POST', '/copilot/ask', { text: 'Sachin 5000 upi', tool: r.data.actions[1].tool, args: r.data.actions[1].args, context: { page: 'home' } }, adminTok);
      ok(t5.data.proposal && Number(t5.data.proposal.preview.amount) === 6000 && t5.data.proposal.preview.guest_id === sg3.id, `S24-2 tapping ₹6,000 prepares ₹6,000 for her to confirm (got ${JSON.stringify(t5.data.proposal && t5.data.proposal.preview)})`);
      eq((await pool.query(`SELECT COUNT(*)::int AS n FROM collections`)).rows[0].n, before, 'S24-2 …and nothing is saved');
      await pool.query(`UPDATE guests SET is_active=false WHERE id=$1`, [sg3.id]);
    }
    console.log('✓ S21 Kannada');

    // ── Audit ────────────────────────────────────────────────────────────
    const au = await pool.query(`SELECT COUNT(*)::int AS n FROM ai_actions WHERE interpretation::text LIKE '%"via":"quick"%' OR interpretation::text LIKE '%quick%'`);
    ok(au.rows[0].n >= 2, 'quick entries are in the Copilot log');
    const metrics = (await A('GET', '/ai-metrics?days=1')).data;
    ok(metrics && JSON.stringify(metrics).includes('quick'), 'AI impact sees source=quick');

    console.log(`\n✅ Quick gate passed — ${count} assertions`);
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Quick gate FAILED after ${count} assertions:\n ${e.message}\n`); console.error(e.stack); process.exit(1);
  } finally { server.close(); await pool.end().catch(() => {}); }
})();
