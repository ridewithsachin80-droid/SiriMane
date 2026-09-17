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
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

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
    ai.providers._stub = realStub; ai.providers.groqText = realGroq;

    // ── 14.1 Voice repair: what Chrome heard vs what she said ───────────
    const vseen = [];
    ai.providers._stub = true;
    ai.providers.groqText = async ({ system, user }) => {
      vseen.push(system + '\n' + user);
      if (/category/i.test(system) && !/Transcripts/.test(user)) return JSON.stringify({ category: 'Other' });
      if (/union/i.test(user)) return JSON.stringify({ phrase: 'onion 100', confidence: 'high' });
      if (/janvi/i.test(user)) return JSON.stringify({ phrase: `Jhanavi ${alpha} 5000 upi`, confidence: 'high' });
      if (/tab leaking/i.test(user)) return JSON.stringify({ phrase: `tap leaking room ${roomNo}`, confidence: 'high' });
      return JSON.stringify({ phrase: user.split('\n')[1].replace(/^\d+\. /, ''), confidence: 'low' });
    };
    // Typed "union 100" is what she typed — NOT repaired, filed as typed.
    vseen.length = 0;
    i = await quick.intent('union 100', adminUser, {});
    eq(i.args.description, 'union', 'TYPED text is never "corrected" by the model');
    ok(!vseen.some(x => /Transcripts/.test(x)), '…and no repair call was made for typed text');
    // Spoken, mis-heard, with Chrome's alternatives → repaired, then classified as usual.
    vseen.length = 0;
    i = await quick.intent('union hundred rupees', adminUser, {}, { voice: true, alternatives: ['union hundred rupees', 'onion hundred rupees'] });
    eq(i.tool, 'prepare_expense', 'VOICE: "union hundred rupees" → an expense'); eq(i.args.description, 'onion', '…for onion'); eq(i.args.category, 'Groceries', '…in Groceries'); eq(i.args.amount, 100, '…₹100');
    eq(i.heard, 'union hundred rupees', 'it records what was heard'); eq(i.understood, 'onion 100', '…and what it understood');
    eq(vseen.filter(x => /Transcripts/.test(x)).length, 1, 'exactly one repair call');
    ok(/onion hundred rupees/.test(vseen[0]), 'the repair saw Chrome\'s alternatives');
    ok(new RegExp(`Jhanavi ${alpha}`).test(vseen[0]), 'the repair saw the resident names (allowed)');
    ok(!/\b\d{10}\b/.test(vseen[0]), 'PRIVACY: the repair never sees a phone number');
    ok(!/aadhaar|id_proof|address/i.test(vseen[0]), 'PRIVACY: nor an ID or address');
    // A mis-heard name resolves to the resident.
    i = await quick.intent('janvi five thousand upi', adminUser, {}, { voice: true, alternatives: ['janvi five thousand upi', 'janavi 5000 upi'] });
    eq(i.tool, 'prepare_payment', 'VOICE: "janvi five thousand upi" → a collection'); eq(i.args.resident_id, jh.id, '…for Jhanavi'); eq(i.args.amount, 5000, '…₹5,000'); eq(i.args.mode, 'UPI', '…UPI');
    i = await quick.intent('tab leaking room ' + roomNo, adminUser, {}, { voice: true, alternatives: [] });
    eq(i.tool, 'prepare_complaint', 'VOICE: "tab leaking" → a request'); eq(i.args.room, roomNo, '…for the room');
    // Spoken clearly → the deterministic pass is confident; the model is not called at all.
    vseen.length = 0;
    i = await quick.intent('onion 100', adminUser, {}, { voice: true, alternatives: ['onion 100'] });
    eq(i.args.category, 'Groceries', 'a clearly-heard phrase classifies at once'); ok(!i.heard, '…with no repair'); eq(vseen.length, 0, '…and no model call: fast path');
    // Through the API, the answer shows the correction.
    r = await api('POST', '/copilot/ask', { text: 'union hundred rupees', voice: true, alternatives: ['union hundred rupees', 'onion hundred rupees'] }, adminTok);
    eq(r.data.tool, 'prepare_expense', 'API: voice repair reaches the preview'); ok(/Heard “union hundred rupees” — understood as “onion 100”/.test(r.data.answer), 'API: the answer says what was heard and what was understood');
    eq(r.data.proposal.preview.description, 'onion', 'API: the preview is for onion'); eq(r.data.proposal.preview.source, 'quick', 'API: still source=quick');
    // Model down or keyless → behaves exactly as before, never an error.
    ai.providers.groqText = async () => { throw new Error('down'); };
    i = await quick.intent('union hundred rupees', adminUser, {}, { voice: true, alternatives: [] });
    eq(i.tool, 'prepare_expense', 'model down: still an expense'); eq(i.args.description, 'union', '…as heard'); ok(!i.heard, '…no false repair');
    ai.providers._stub = realStub; ai.providers.groqText = realGroq;
    i = await quick.intent('union hundred rupees', adminUser, {}, { voice: true, alternatives: [] });
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
