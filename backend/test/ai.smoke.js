// backend/test/ai.smoke.js
// Sprint 3 gate. Runs the on-device speech parser against 60+ phrases, and
// the AI proxy routes against STUBBED providers (no key, no network), so the
// gate proves plumbing, privacy and validation — not Google's uptime.
//
//   DATABASE_URL=... JWT_SECRET=test node backend/test/ai.smoke.js
const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
// Make sure real keys never leak into this run.
delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;

const SMParse = require('../../frontend/public/js/speech-parser.js');
const ai = require('../routes/ai');
const app = require('../server');
const pool = require('../db');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); count++; };

// ── 1. Speech parser ────────────────────────────────────────────────────
const R = [
  { id: 1, name: 'Priya Sharma', room_number: '12' },
  { id: 2, name: 'Ananya', room_number: '5' },
  { id: 3, name: 'Priya Nair', room_number: '7' },
  { id: 4, name: 'Deepa', room_number: '12' },
  { id: 5, name: 'Lakshmi Devi', room_number: 'A1' }
];
const collectCases = [
  // [phrase, guestId, amount, mode, type]
  ['Priya room 12 six thousand UPI', 1, 6000, 'UPI', 'rent'],
  ['Ananya 6000 cash', 2, 6000, 'Cash', 'rent'],
  ['priya nair aaru saavira gpay', 3, 6000, 'UPI', 'rent'],
  ['deepa chhe hazaar', 4, 6000, null, 'rent'],
  ['room 5 five hundred deposit', 2, 500, null, 'deposit'],
  ['2.5 lakh from ananya bank', 2, 250000, 'Bank Transfer', 'rent'],
  ['one and a half thousand ananya', 2, 1500, null, 'rent'],
  ['Ananya 6k phonepe', 2, 6000, 'UPI', 'rent'],
  ['hattu saavira room 7', 3, 10000, null, 'rent'],
  ['room 12 deepa 6000', 4, 6000, null, 'rent'],
  ['Lakshmi Devi room A1 paid 7000 by google pay', 5, 7000, 'UPI', 'rent'],
  ['lakshmi 7,000 rupees cash', 5, 7000, 'Cash', 'rent'],
  ['collected six thousand five hundred from ananya online', 2, 6500, 'UPI', 'rent'],
  ['deepa advance two thousand', 4, 2000, null, 'advance'],
  ['Priya Sharma 6000', 1, 6000, null, 'rent'],
  ['Priya paid 1500', null, 1500, null, 'rent'],           // two Priyas → ambiguous → null
  ['ananya paanch sau', 2, 500, null, 'rent'],
  ['eradu saavira ananya nagadu', 2, 2000, 'Cash', 'rent'],
  ['ananya twelve thousand neft', 2, 12000, 'Bank Transfer', 'rent'],
  ['ananya security deposit ten thousand', 2, 10000, null, 'deposit'],
  ['room 7 six thousand', 3, 6000, null, 'rent'],
  ['nobody here 500', null, 500, null, 'rent'],
  ['ananya', 2, null, null, 'rent'],
  ['', null, null, null, 'rent']
];
for (const [phrase, gid, amount, mode, type] of collectCases) {
  const p = SMParse.parseCollection(phrase, R);
  eq(p.guest ? p.guest.id : null, gid, `parse guest "${phrase}"`);
  eq(p.amount, amount, `parse amount "${phrase}"`);
  eq(p.mode, mode, `parse mode "${phrase}"`);
  eq(p.type, type, `parse type "${phrase}"`);
}
const amountOnly = [['six thousand', 6000], ['aaru saavira', 6000], ['chhe hazaar', 6000], ['five hundred', 500], ['two lakh', 200000], ['1.5k', 1500], ['thousand', 1000], ['half thousand', 500], ['nineteen hundred', 1900], ['twenty five hundred', 2500], ['500.50', 501], ['eleven thousand two hundred', 11200]];
for (const [t, n] of amountOnly) eq(SMParse.extractAmount(t)?.amount ?? null, n, `amount "${t}"`);
eq(SMParse.extractAmount('no numbers here'), null, 'no amount → null');
const complaintCases = [
  ['geyser not working in bathroom room 5', 'Water', '5'],
  ['wifi very slow', 'Wifi/Internet', null],
  ['fan making noise room 12', 'Electrical', '12'],
  ['cockroaches in the kitchen', 'Cleanliness', null],
  ['cupboard door broken', 'Furniture', null],
  ['breakfast was cold today', 'Food', null],
  ['stranger near the gate at night', 'Security', null],
  ['something is wrong', 'Other', null]
];
for (const [t, cat, room] of complaintCases) {
  const p = SMParse.parseComplaint(t);
  eq(p.category, cat, `complaint category "${t}"`); eq(p.room, room, `complaint room "${t}"`); eq(p.description, t, `complaint keeps the words "${t}"`);
}
console.log('✓ speech parser');

// ── 2. AI routes with stubbed providers ─────────────────────────────────
const calls = [];
ai.providers._stub = true;
ai.providers.geminiVision = async ({ mimeType, base64, prompt }) => {
  calls.push({ kind: 'vision', mimeType, bytes: base64.length, promptHasBill: /bill/i.test(prompt), promptHasId: /identity/i.test(prompt), promptHasFault: /broken/i.test(prompt) });
  if (/broken/i.test(prompt)) return '{"category":"Water","priority":"high","likely_issue":"Tap washer worn — dripping at the spout","description":"Water dripping steadily from the bathroom tap","confidence":"high"}';
  if (/identity/i.test(prompt)) return '```json\n{"name":"Asha Rao","id_proof_type":"Aadhaar","id_proof_number":"1234 5678 9012","address":"12 MG Road, Tumakuru 572101","confidence":"high"}\n```';
  return '{"amount":"1,250.00","paid_to":"Sri Ganesh Stores","purchase_date":"2026-09-10","category":"groceries","description":"Rice, dal and cooking oil","payment_mode":"upi","confidence":"medium"}';
};
ai.providers.geminiText = async ({ prompt }) => { calls.push({ kind: 'gtext' }); return 'OK'; };
ai.providers.groqText = async ({ system, user, json }) => {
  calls.push({ kind: 'groq', user });
  if (user === 'ping') return 'OK';
  if (/Roster/.test(user)) {
    // Simulate the model matching "the girl in A1" by room from the roster
    const line = user.split('\n').find(l => l.endsWith('|A1'));
    return JSON.stringify({ guest_id: line ? Number(line.split('|')[0]) : null, amount: 7000, mode: 'UPI', type: 'rent' });
  }
  return JSON.stringify({ category: 'Electrical', priority: 'high', description: 'Sparks from the socket in room 3' });
};

const tinyPng = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]).toString('base64') + 'AAAA';
let BASE, adminTok, staffTok;
const api = async (method, path, body, token) => {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
};

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, guest_rent_history, deposit_refunds, guests, rooms, day_closings, collection_variances RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await api('POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }); adminTok = r.data.token;
    r = await api('POST', '/users', { username: 'smoke_ai_staff', password: 'staff123', role: 'staff' }, adminTok);
    r = await api('POST', '/auth/login', { username: 'smoke_ai_staff', password: 'staff123' }); staffTok = r.data.token;
    const room = (await api('POST', '/rooms', { room_number: 'A1', floor: 1, total_beds: 2, monthly_rent: 7000 }, adminTok)).data;
    const guest = (await api('POST', '/guests', { name: 'Asha Rao', phone: '9000000077', room_id: room.id, join_date: '2026-06-01', monthly_rent: 7000, deposit_amount: 14000, address: '12 MG Road' }, adminTok)).data;

    // status + auth
    r = await api('GET', '/ai/status'); eq(r.status, 401, 'ai/status needs auth');
    r = await api('GET', '/ai/status', null, staffTok); eq(r.status, 200, 'ai/status'); eq(r.data.vision, false, 'no key → vision off'); ok(r.data.models.gemini, 'reports model name');
    r = await api('GET', '/ai/probe', null, staffTok); eq(r.status, 403, 'probe is admin-only');
    r = await api('GET', '/ai/probe', null, adminTok); eq(r.status, 200, 'probe runs'); eq(r.data.gemini.ok, true, 'probe gemini (stub) ok'); eq(r.data.groq.ok, true, 'probe groq (stub) ok');

    // vision validation
    r = await api('POST', '/ai/vision', { kind: 'bill' }, staffTok); eq(r.status, 400, 'vision without image → 400');
    r = await api('POST', '/ai/vision', { kind: 'nope', image: tinyPng }, staffTok); eq(r.status, 400, 'bad kind → 400');
    r = await api('POST', '/ai/vision', { kind: 'bill', image: 'data:text/plain;base64,QUJD' }, staffTok); eq(r.status, 400, 'non-image data URL → 400');
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }); eq(r.status, 401, 'vision needs auth');
    // body limit: a 5 MB image must be accepted by the AI router (global limit is 10 kb)
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(Math.floor(5.6 * 1024 * 1024)); // ≈4.2 MB decoded
    const bigRes = await fetch(BASE + '/api/ai/vision', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + staffTok }, body: JSON.stringify({ kind: 'bill', image: big }) });
    ok(bigRes.status !== 413, `5.6 MB body is not rejected by the body limit (${bigRes.status})`);
    eq(bigRes.status, 400, 'but an image over the 4 MB cap is refused with a message');
    const tooBigForGlobal = await fetch(BASE + '/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok }, body: JSON.stringify({ amount: 1, guest_name: 'x'.repeat(20000) }) });
    eq(tooBigForGlobal.status, 413, 'the 10 kb limit still guards every other route');

    // bill scan
    calls.length = 0;
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }, staffTok); eq(r.status, 200, 'bill scan');
    eq(calls[0].promptHasBill, true, 'bill prompt used'); eq(calls[0].mimeType, 'image/png', 'mime passed through');
    eq(r.data.fields.amount, 1250, 'amount "1,250.00" → 1250'); eq(r.data.fields.category, 'Groceries', 'category normalised to app list'); eq(r.data.fields.payment_mode, 'UPI', 'mode normalised');
    eq(r.data.fields.purchase_date, '2026-09-10', 'date kept'); eq(r.data.fields.confidence, 'medium', 'confidence kept');
    ok(!JSON.stringify(r.data).includes('base64'), 'PRIVACY: response never echoes the image');

    // id scan
    r = await api('POST', '/ai/vision', { kind: 'id', image: tinyPng }, staffTok); eq(r.status, 200, 'id scan');
    eq(r.data.fields.name, 'Asha Rao', 'name'); eq(r.data.fields.id_proof_type, 'Aadhaar', 'type'); eq(r.data.fields.id_proof_number, '123456789012', 'number cleaned'); ok(r.data.fields.address.includes('Tumakuru'), 'address');
    const stored = await pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE id_proof_number='123456789012'`);
    eq(stored.rows[0].n, 0, 'AI never writes to guests by itself');

    // parse fallback: privacy of what goes to the model
    calls.length = 0;
    r = await api('POST', '/ai/parse', { kind: 'collection', text: 'the girl in A1 paid seven thousand gpay' }, staffTok); eq(r.status, 200, 'parse collection');
    eq(r.data.guest_id, guest.id, 'server fallback resolved the resident by room'); eq(r.data.amount, 7000, 'amount'); eq(r.data.mode, 'UPI', 'mode');
    const sent = calls.find(c => c.kind === 'groq').user;
    ok(sent.includes('Asha Rao') && sent.includes('|A1'), 'roster sends name + room');
    ok(!sent.includes('9000000077'), 'PRIVACY: phone number never sent to the model');
    ok(!sent.includes('MG Road'), 'PRIVACY: address never sent to the model');
    ok(!sent.includes('14000') && !sent.includes('7000|'), 'PRIVACY: money figures never sent to the model');
    r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'sparks coming from socket room 3' }, staffTok); eq(r.status, 200, 'parse complaint');
    eq(r.data.category, 'Electrical', 'complaint category'); eq(r.data.priority, 'high', 'priority');
    r = await api('POST', '/ai/parse', { kind: 'collection', text: 'x'.repeat(600) }, staffTok); eq(r.status, 400, 'over-long text refused');
    r = await api('POST', '/ai/parse', { kind: 'collection', text: 'hi' }); eq(r.status, 401, 'parse needs auth');

    // no stub, no key → 503 with a clear message (the UI hides the buttons on status=false anyway)
    ai.providers._stub = false;
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }, staffTok); eq(r.status, 503, 'no key → 503'); ok(/not enabled/.test(r.data.error), 'clear message');
    r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'x' }, staffTok); eq(r.status, 503, 'parse no key → 503');
    ai.providers._stub = true;

    // provider failure / garbage
    ai.providers.geminiVision = async () => { throw new Error('Gemini 404: model not found'); };
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }, staffTok); eq(r.status, 502, 'provider error → 502'); ok(/model not found/.test(r.data.error), 'error message surfaces');
    ai.providers.geminiVision = async () => 'this is not json at all';
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }, staffTok); eq(r.status, 502, 'garbage reply → 502');
    ai.providers.geminiVision = async () => '{"amount":"abc","category":"Space Travel","confidence":"???"}';
    r = await api('POST', '/ai/vision', { kind: 'bill', image: tinyPng }, staffTok); eq(r.status, 200, 'odd fields still 200');
    eq(r.data.fields.amount, null, 'non-numeric amount → null'); eq(r.data.fields.category, null, 'unknown category → null'); eq(r.data.fields.confidence, 'low', 'bad confidence → low');

    // ── Fault photo → triage (Phase 2 completion) ──────────────────────
    // An earlier block swapped the provider out to test failures; put the
    // stub back before exercising a new prompt.
    ai.providers.geminiVision = async ({ prompt }) => {
      calls.push({ kind: 'vision', promptHasFault: /broken/i.test(prompt) });
      return '{"category":"Water","priority":"high","likely_issue":"Tap washer worn — dripping at the spout","description":"Water dripping steadily from the bathroom tap","confidence":"high"}';
    };
    calls.length = 0;
    r = await api('POST', '/ai/vision', { kind: 'fault', image: tinyPng }, staffTok); eq(r.status, 200, 'fault photo read');
    eq(calls[0].promptHasFault, true, 'the fault prompt was used');
    eq(r.data.fields.category, 'Water', 'category suggested'); eq(r.data.fields.priority, 'high', 'water is high priority');
    ok(/washer/.test(r.data.fields.likely_issue), 'a likely cause is named');
    const noReq = await pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE description ILIKE '%dripping%'`);
    eq(noReq.rows[0].n, 0, 'AI never files the request itself');
    ai.providers.geminiVision = async () => '{"category":"Space Travel","priority":"urgent","confidence":"???"}';
    r = await api('POST', '/ai/vision', { kind: 'fault', image: tinyPng }, staffTok);
    eq(r.data.fields.category, 'Other', 'an unknown category falls back to Other');
    eq(r.data.fields.priority, 'medium', 'an invalid priority falls back to medium');
    r = await api('POST', '/ai/vision', { kind: 'nonsense', image: tinyPng }, staffTok); eq(r.status, 400, 'only bill, id and fault are accepted');
    // The suggestion reaches the record only when the warden saves it
    r = await api('POST', '/complaints', { category: 'Water', description: 'Dripping tap', priority: 'high', likely_issue: 'Tap washer worn', source: 'photo' }, staffTok);
    eq(r.status, 201, 'the warden files it'); eq(r.data.likely_issue, 'Tap washer worn', 'the likely cause is kept on the record'); eq(r.data.source, 'photo', 'and where it came from');

    // ── 3. source column + guest address/ID linkage fix ────────────────
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    r = await api('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 7000, collection_date: today, collection_type: 'rent', payment_mode: 'UPI', source: 'voice' }, adminTok);
    eq(r.status, 201, 'collection with source'); eq(r.data.source, 'voice', 'collection source=voice stored');
    r = await api('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 10, collection_date: today, collection_type: 'rent', payment_mode: 'cash', source: 'hacked' }, adminTok);
    eq(r.data.source, 'manual', 'unknown source falls back to manual');
    r = await api('POST', '/collections', { guest_id: guest.id, guest_name: guest.name, amount: 10, collection_date: today, collection_type: 'rent', payment_mode: 'cash' }, adminTok);
    eq(r.data.source, 'manual', 'no source → manual (old clients keep working)');
    r = await api('POST', '/purchases', { amount: 1250, category: 'Groceries', description: 'Rice', purchase_date: today, paid_to: 'Sri Ganesh Stores', payment_mode: 'UPI', source: 'photo' }, adminTok);
    eq(r.status, 201, 'purchase with source'); eq(r.data.source, 'photo', 'purchase source=photo stored');
    r = await api('POST', '/complaints', { category: 'Electrical', description: 'Sparks', source: 'voice' }, staffTok);
    eq(r.status, 201, 'complaint with source'); eq(r.data.source, 'voice', 'complaint source=voice stored');

    r = await api('GET', `/guests/${guest.id}`, null, adminTok); eq(r.data.address, '12 MG Road', 'LINKAGE: address saved on create');
    r = await api('PUT', `/guests/${guest.id}`, { address: '14 MG Road, Tumakuru', id_proof_type: 'Aadhaar', id_proof_number: '123456789012' }, adminTok); eq(r.status, 200, 'update guest');
    r = await api('GET', `/guests/${guest.id}`, null, adminTok);
    eq(r.data.address, '14 MG Road, Tumakuru', 'LINKAGE: address saved on update'); eq(r.data.id_proof_type, 'Aadhaar', 'LINKAGE: ID type saved on update'); eq(r.data.id_proof_number, '123456789012', 'ID number saved on update');
    r = await api('PUT', `/guests/${guest.id}`, { name: 'Asha R' }, adminTok);
    r = await api('GET', `/guests/${guest.id}`, null, adminTok); eq(r.data.id_proof_number, '123456789012', 'partial update keeps ID number (COALESCE)');
    r = await api('GET', '/guest-portal', null, staffTok); // not a guest token
    eq(r.status, 401, 'staff token cannot open a resident portal');
    console.log('✓ ai routes, privacy, source columns, guest linkage');

    // ── Sprint 20: AI text never depends on one provider
    {
      const realGroq = ai.providers.groqText, realGem = ai.providers.geminiText;
      let groqCalls = 0, gemCalls = 0;
      ai.providers.groqDownUntil = 0;
      ai.providers.groqText = async () => { groqCalls++; throw new Error('Groq 404: The model `llama-3.3-70b-versatile` does not exist'); };
      ai.providers.geminiText = async ({ prompt }) => { gemCalls++; return /complaint/i.test(prompt) ? JSON.stringify({ category: 'Water', priority: 'high', description: 'Tap leaking in room 4' }) : 'OK'; };
      r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'tap leaking in room 4' }, staffTok);
      ok(r.status === 200 && r.data.category === 'Water' && groqCalls === 1 && gemCalls === 1, `S20-1 Groq failing → the same request is answered by Gemini (${r.status} ${JSON.stringify(r.data).slice(0, 80)})`);
      r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'tap leaking in room 5' }, staffTok);
      ok(r.status === 200 && groqCalls === 1 && gemCalls === 2, 'S20-1 after a Groq failure, Groq is skipped (no extra wait) and Gemini answers');
      ok(ai.providers.groqDownUntil > Date.now() + 9 * 60000, 'S20-1 …for 10 minutes');
      // The probe says what's in use, and a working Groq ends the skip window
      r = await api('GET', '/ai/probe', null, adminTok);
      ok(r.data.groq.ok === false && r.data.in_use === 'gemini' && r.data.fallback === true, `S20-2 the connection test says Gemini is standing in (${r.data.in_use})`);
      ai.providers.groqText = async ({ user }) => { groqCalls++; return user === 'ping' ? 'OK' : JSON.stringify({ category: 'Electrical', priority: 'low', description: 'x' }); };
      r = await api('GET', '/ai/probe', null, adminTok);
      ok(r.data.groq.ok === true && r.data.in_use === 'groq' && ai.providers.groqDownUntil === 0, 'S20-2 a working Groq is used again straight away');
      // Sprint 22: the connection test pauses Groq only when Gemini can stand in.
      ai.providers.groqText = async () => { const e = new Error('Groq 503: down'); e.status = 503; throw e; };
      ai.providers.geminiText = async () => { throw new Error('Gemini 500: also down'); };
      ai.providers.groqDownUntil = 0;
      r = await api('GET', '/ai/probe', null, adminTok);
      ok(r.data.groq.ok === false && r.data.gemini.ok === false && ai.providers.groqDownUntil === 0 && r.data.fallback === false, `S22 both down: the test does not start a Groq pause — there is nothing to fall back to (${JSON.stringify([r.data.in_use, r.data.fallback])})`);
      ai.providers.geminiText = async () => 'OK';
      r = await api('GET', '/ai/probe', null, adminTok);
      ok(r.data.groq.ok === false && ai.providers.groqDownUntil > Date.now() + 9 * 60000 && r.data.in_use === 'gemini', 'S22 Groq down, Gemini fine: Groq is paused and Gemini is in use');
      ai.providers.groqDownUntil = 0;
      // Sprint 22: the real Gemini request — JSON asked for only when wanted, key in a header, never in the URL.
      { const keepFetch = global.fetch, keepKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'gem-test-key';
        const aiPath = require.resolve('../routes/ai'); const cached = require.cache[aiPath]; delete require.cache[aiPath];
        const freshGem = require('../routes/ai').providers.geminiText; require.cache[aiPath] = cached;
        const seen = [];
        global.fetch = async (url, opts) => /generativelanguage/.test(url) ? (seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }), { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }) }) : keepFetch(url, opts);
        let outJ, outT; try { outJ = await freshGem({ prompt: 'p1', json: true }); outT = await freshGem({ prompt: 'p2' }); } finally { global.fetch = keepFetch; if (keepKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = keepKey; }
        ok(seen.length === 2 && seen[0].body.generationConfig.responseMimeType === 'application/json' && seen[1].body.generationConfig.responseMimeType === undefined, `S22 Gemini is asked for JSON only when JSON is wanted (${JSON.stringify(seen.map(x => x.body.generationConfig))})`);
        ok(seen.every(x => x.headers['x-goog-api-key'] === 'gem-test-key' && !/gem-test-key/.test(x.url)) && seen[0].body.contents[0].parts[0].text === 'p1' && outJ === '{"a":1}' && outT === '{"a":1}', 'S22 …with the key in a header (never in the URL), the prompt as sent, and the text returned'); }
      // No provider at all → a clear error, not a hang
      ai.providers.groqText = async () => { throw new Error('down'); };
      ai.providers.geminiText = async () => { throw new Error('also down'); };
      ai.providers.groqDownUntil = 0;
      r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'fan broken' }, staffTok);
      ok(r.status === 502, 'S20-1 both providers down → the form says to fill it in (502), no crash');
      // Review S20 — PRIVACY: Gemini gets exactly what Groq got, no more; JSON mode carried over
      let gArgs = null, gemArgs = null;
      ai.providers.groqText = async (a) => { gArgs = a; const e = new Error('Groq 503: down'); e.status = 503; throw e; };
      ai.providers.geminiText = async (a) => { gemArgs = a; return JSON.stringify({ category: 'Water', priority: 'low', description: 'x' }); };
      ai.providers.groqDownUntil = 0;
      await api('POST', '/ai/parse', { kind: 'complaint', text: 'drain blocked' }, staffTok);
      ok(gArgs && gemArgs && gemArgs.prompt === gArgs.system + '\n\n' + gArgs.user && gemArgs.json === true, 'S20-1 PRIVACY: Gemini receives exactly the text Groq got (and JSON mode), nothing more');
      // A one-request problem (400, empty answer) falls back WITHOUT pausing Groq
      for (const [label, fail] of [['400', () => { const e = new Error('Groq 400: failed to generate JSON'); e.status = 400; throw e; }], ['empty answer', () => { const e = new Error('Groq gave an empty answer'); e.status = 'empty'; throw e; }]]) {
        ai.providers.groqDownUntil = 0; let used = null;
        ai.providers.groqText = async () => fail();
        ai.providers.geminiText = async () => { used = 'gemini'; return JSON.stringify({ category: 'Water', priority: 'low', description: 'x' }); };
        r = await api('POST', '/ai/parse', { kind: 'complaint', text: 'drain blocked' }, staffTok);
        ok(r.status === 200 && used === 'gemini' && ai.providers.groqDownUntil === 0, `S20-1 a Groq ${label} falls back to Gemini for that request only (Groq not paused)`);
      }
      // Groq only (no Gemini): a failure is reported, and Groq is never paused
      { const keep = { stub: ai.providers._stub, g: process.env.GROQ_API_KEY, m: process.env.GEMINI_API_KEY };
        ai.providers._stub = false; process.env.GROQ_API_KEY = 'test-key'; delete process.env.GEMINI_API_KEY; ai.providers.groqDownUntil = 0;
        ai.providers.groqText = async () => { const e = new Error('Groq 503: down'); e.status = 503; throw e; };
        let msg = ''; try { await ai.providers.text({ system: 's', user: 'u' }); } catch (e) { msg = e.message; }
        ok(/503/.test(msg) && ai.providers.groqDownUntil === 0, `S20-1 with Groq only, a failure is reported as it is and Groq is not paused (${msg})`);
        ai.providers._stub = keep.stub; if (keep.g === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keep.g; if (keep.m !== undefined) process.env.GEMINI_API_KEY = keep.m; }
      // The real Groq call: an empty or cut-off answer is a failure, not success
      { const keepFetch = global.fetch, keepKey = process.env.GROQ_API_KEY;
        process.env.GROQ_API_KEY = 'test-key';
        // a fresh copy of the module: the suite's stubs replaced groqText on the shared one
        const aiPath = require.resolve('../routes/ai'); const cached = require.cache[aiPath]; delete require.cache[aiPath];
        const freshGroq = require('../routes/ai').providers.groqText; require.cache[aiPath] = cached;
        let thrown = [];
        for (const reply of [{ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, { choices: [{ message: { content: '{"cat' }, finish_reason: 'length' }] }]) {
          global.fetch = async (url, opts) => /groq/.test(url) ? { ok: true, status: 200, json: async () => reply } : keepFetch(url, opts);
          try { await freshGroq({ system: 's', user: 'u', json: true }); thrown.push('returned'); } catch (e) { thrown.push(e.status); }
        }
        global.fetch = keepFetch; if (keepKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keepKey;
        eq(thrown.join(','), 'empty,empty', 'S20-1 an empty or cut-off Groq answer counts as a failure (so Gemini answers)'); }
      ai.providers.groqText = realGroq; ai.providers.geminiText = realGem; ai.providers.groqDownUntil = 0;
    }

    console.log(`\n✅ AI gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ AI gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { server.close(); await pool.end(); }
})();
