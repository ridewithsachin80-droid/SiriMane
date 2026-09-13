// backend/test/ui.smoke.js
// Sprint 0 UI gate. Drives the real management app in headless Chrome at
// 360px and 390px against the real server + Postgres. Exercises exactly the
// screens Sprint 0 touched: Daily Checklist, Complaints, Guests → Room Shift,
// Payments → receipt download, and the new error boundary / toast.
//
// Needs puppeteer-core available (NOT added to package.json — it is a local
// dev tool only) and a Chrome binary:
//   CHROME_PATH=/path/to/chrome DATABASE_URL=... JWT_SECRET=test \
//   NODE_PATH=<dir containing puppeteer-core> node backend/test/ui.smoke.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const CHROME = process.env.CHROME_PATH;
if (!CHROME) { console.error('CHROME_PATH is required'); process.exit(1); }

// Sprint 3: stub the AI providers so the browser flows run without keys/network.
delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
const ai = require('../routes/ai');
ai.providers._stub = true;
ai.providers.geminiVision = async ({ prompt }) => /identity/i.test(prompt)
  ? '{"name":"Scan Test","id_proof_type":"Aadhaar","id_proof_number":"9999 8888 7777","address":"5th Cross, Tumakuru","confidence":"high"}'
  : '{"amount":845,"paid_to":"Nandini Milk Parlour","purchase_date":"2026-09-11","category":"Groceries","description":"Milk and curd for the week","payment_mode":"Cash","confidence":"high"}';
ai.providers.geminiText = async () => 'OK';
ai.providers.groqText = async ({ user }) => {
  if (user === 'ping') return 'OK';
  if (/Request:/.test(user)) return JSON.stringify({ tool: null, args: {}, clarify: null }); // copilot router: defer to local/template
  return JSON.stringify({ guest_id: null, amount: null, mode: null, type: 'rent', category: 'Water', priority: 'high', description: user });
};
const app = require('../server');
const pool = require('../db');
let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); count++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = path.join(__dirname, 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });

async function runAtWidth(browser, BASE, width) {
  // Fresh browser context per width so the 360px login doesn't carry over.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  const downloadDir = path.join(SHOTS, `dl-${width}`); fs.mkdirSync(downloadDir, { recursive: true });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, browserContextId: ctx.id });

  const tag = `@${width}`;
  await page.goto(BASE + '/management', { waitUntil: 'networkidle0' });
  ok(await page.$('#login-page:not(.hidden)'), `${tag} /management shows login (not landing page)`);
  await page.type('#login-username', 'admin');
  await page.type('#login-password', process.env.ADMIN_PASSWORD || 'SiriMane@2024');
  await page.click('#login-btn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  // Let the dashboard finish its async render before navigating, otherwise
  // its late setContent() overwrites the screen under test.
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  ok(true, `${tag} login works`);
  // Measures the screen body only. The topbar (#topbar-actions) already
  // overflows at 360px on every screen in the current app — a pre-existing
  // layout defect scheduled for Sprint 1 (mobile-first warden UX), not
  // something Sprint 0 touched.
  const noHScroll = async (label) => {
    const w = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#page-content, #page-content > *')].map(e => e.getBoundingClientRect().right)));
    ok(w <= width + 1, `${tag} ${label}: content fits viewport (${Math.round(w)}px)`);
    const doc = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(doc <= width + 1, `${tag} ${label}: page does not scroll sideways (${doc}px)`);
  };

  // ── Daily Checklist ───────────────────────────────────────────────────
  await page.evaluate(() => navigate('daily-checklist'));
  await page.waitForFunction(() => document.querySelector('#page-content input[type=checkbox]'), { timeout: 8000 });
  const boxes = await page.$$('#page-content input[type=checkbox]');
  ok(boxes.length >= 33, `${tag} checklist renders ${boxes.length} tasks`);
  ok(!(await page.evaluate(() => document.body.innerText.includes('Unexpected token'))), `${tag} no "Unexpected token" error`);
  await page.waitForSelector('#cl-date + span', { timeout: 8000 });
  const before = await page.$eval('#cl-date + span', e => e.textContent);
  await boxes[0].click();
  await page.waitForFunction(b => { const t = document.querySelector('#cl-date + span')?.textContent; return t && !t.includes(b); }, { timeout: 8000 }, before);
  const after = await page.$eval('#cl-date + span', e => e.textContent);
  ok(/1 \/ \d+ done/.test(after) || /\d+ \/ \d+ done/.test(after), `${tag} tick updates summary (${after.trim()})`);
  await page.screenshot({ path: path.join(SHOTS, `checklist-${width}.png`) });
  await noHScroll('checklist');
  // untick so the other width starts clean
  await (await page.$$('#page-content input[type=checkbox]'))[0].click();
  await page.waitForFunction(b => document.querySelector('#cl-date + span')?.textContent.includes(b), { timeout: 8000 }, before);

  // ── Complaints ────────────────────────────────────────────────────────
  await page.evaluate(() => navigate('complaints'));
  await page.waitForFunction(() => document.querySelector('#page-content h1')?.textContent.includes('Complaint'), { timeout: 8000 });
  await page.evaluate(() => complaintModal());
  await page.waitForSelector('#cp-desc');
  await page.select('#cp-category', 'Water');
  await page.type('#cp-desc', `UI smoke ${width}: tap leaking`);
  await page.evaluate(() => saveComplaint());
  await page.waitForFunction(w => document.body.innerText.includes(`UI smoke ${w}`), { timeout: 8000 }, width);
  ok(true, `${tag} complaint logged and listed`);
  await page.waitForFunction(() => parseInt(document.querySelector('#complaints-badge')?.textContent) >= 1, { timeout: 8000 });
  const badge = await page.$eval('#complaints-badge', e => e.textContent);
  ok(parseInt(badge) >= 1, `${tag} sidebar badge shows open count (${badge})`);
  await page.screenshot({ path: path.join(SHOTS, `complaints-${width}.png`) });
  await noHScroll('complaints');

  // ── Guests → Room shift ───────────────────────────────────────────────
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table, #page-content .card'), { timeout: 8000 });
  const guestId = await page.evaluate(async () => (await API.getGuests())[0]?.id);
  ok(guestId, `${tag} has a guest to shift`);
  await page.evaluate(id => roomShiftModal(id, 'UI Guest'), guestId);
  await page.waitForSelector('#rs-room');
  const opts = await page.$$eval('#rs-room option:not([disabled])', o => o.map(x => x.value).filter(Boolean));
  ok(opts.length >= 1, `${tag} shift modal lists other rooms`);
  await page.select('#rs-room', opts[0]);
  await page.evaluate(id => saveRoomShift(id), guestId);
  await page.waitForFunction(() => !document.querySelector('#rs-room'), { timeout: 8000 });
  ok(true, `${tag} room shift saved, modal closed`);
  const hist = await page.evaluate(id => API.getRoomHistory(id), guestId);
  ok(hist.length >= 1, `${tag} room history recorded (${hist.length})`);
  await noHScroll('guests');

  // ── Payments → receipt download ───────────────────────────────────────
  await page.evaluate(() => navigate('payments'));
  await page.waitForFunction(() => document.querySelector('#page-content h1')?.textContent.includes('Payments'), { timeout: 8000 });
  await page.waitForSelector('button[title="Download receipt"]', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('button[title="Download receipt"]').click());
  let file = null;
  for (let i = 0; i < 40 && !file; i++) { await sleep(250); file = fs.readdirSync(downloadDir).find(f => f.endsWith('.pdf')); }
  ok(file, `${tag} receipt downloaded (${file})`);
  const head = fs.readFileSync(path.join(downloadDir, file)).subarray(0, 4).toString();
  eq(head, '%PDF', `${tag} downloaded receipt is a real PDF`);
  await page.screenshot({ path: path.join(SHOTS, `payments-${width}.png`) });
  await noHScroll('payments');

  // ── Error boundary + JSON 404 + toast ─────────────────────────────────
  await page.evaluate(() => { window.pgBroken = () => { throw new Error('boom from screen'); }; });
  await page.evaluate(() => {
    // Force the Home renderer to throw, to prove the boundary catches it.
    window.__origHome = window.pgHome; window.pgHome = window.pgBroken; navigate('dashboard');
  });
  await page.waitForFunction(() => document.body.innerText.includes('This screen could not load'), { timeout: 5000 });
  ok(true, `${tag} error boundary shows retry card instead of blank page`);
  ok(await page.evaluate(() => document.body.innerText.includes('boom from screen')), `${tag} boundary shows the error message`);
  await page.evaluate(() => { window.pgHome = window.__origHome; });
  await page.click('#page-content button.btn-primary');
  await page.waitForFunction(() => !document.body.innerText.includes('This screen could not load'), { timeout: 8000 });
  ok(true, `${tag} retry recovers`);
  const missing = await page.evaluate(() => apiFetch('/no-such-thing').catch(e => e.message));
  ok(/No such endpoint/.test(missing), `${tag} missing endpoint gives readable error ("${missing}")`);
  await page.evaluate(() => toast('hello toast'));
  ok(await page.$eval('#sm-toast', e => e.classList.contains('show') && e.textContent === 'hello toast'), `${tag} toast renders`);
  const toastTop = await page.$eval('#sm-toast', e => e.getBoundingClientRect().bottom);
  const barTop = await page.$eval('.sm-tabbar', e => e.getBoundingClientRect().top);
  ok(toastTop <= barTop, `${tag} toast sits clear of the tab bar`);
  await page.evaluate(() => document.getElementById('sm-toast').classList.remove('show'));

  // ── Sprint 1: phone chrome ────────────────────────────────────────────
  const tabs = await page.$$eval('.sm-tab', els => els.map(e => e.textContent.trim()));
  eq(tabs.length, 5, `${tag} bottom tab bar has 5 tabs`);
  ok(tabs.join('|').includes('Finance'), `${tag} Finance tab present (Sprint 7 regrouping)`);
  ok(await page.$eval('.sm-tabbar', e => getComputedStyle(e).display === 'grid'), `${tag} tab bar visible on phone`);
  const tabH = await page.$eval('.sm-tab', e => e.getBoundingClientRect().height);
  ok(tabH >= 44, `${tag} tab targets ≥44px (${Math.round(tabH)}px)`);
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, `guests-cards-${width}.png`) });
  await page.evaluate(() => navigate('rent-due'));
  await page.waitForFunction(() => document.querySelector('#rentdue-tb tr'), { timeout: 8000 });
  ok(await page.$eval('.sm-fab', e => e.classList.contains('sm-fab-on')), `${tag} Collect FAB shown on Rent Due`);
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 8000 });
  ok(await page.$eval('#page-content thead', e => getComputedStyle(e).display === 'none'), `${tag} table headers hidden, cards shown`);
  const labelled = await page.$$eval('#page-content tbody tr:first-child td', tds => tds.filter(t => t.hasAttribute('data-label')).length);
  ok(labelled >= 5, `${tag} card cells carry their column labels (${labelled})`);
  await page.evaluate(() => navigate('daily-menu'));
  await page.waitForFunction(() => !document.querySelector('#page-content table.sm-cards'), { timeout: 8000 }).catch(() => {});
  ok(!(await page.$eval('.sm-fab', e => e.classList.contains('sm-fab-on'))), `${tag} FAB hidden where collecting makes no sense`);

  // ── Sprint 1: collect rent in one screen ──────────────────────────────
  const dueBefore = await page.evaluate(() => API.getRentDue());
  const target = dueBefore.find(g => parseFloat(g.amount_due) > 0) || dueBefore[0];
  const beforeLedger = await page.evaluate(id => API.getGuestLedger ? API.getGuestLedger(id) : apiFetch(`/guests/${id}/ledger`), target.id);
  await page.evaluate(() => navigate('collect'));
  await page.waitForSelector('#collect-people .sm-person', { timeout: 8000 });
  ok(true, `${tag} Collect opens from the Finance group`);
  await page.screenshot({ path: path.join(SHOTS, `collect-${width}.png`) });
  await page.waitForSelector('#collect-people .sm-person .sm-person-due', { timeout: 8000 });
  const firstDue = await page.$eval('#collect-people .sm-person .sm-person-due', e => e.textContent);
  ok(firstDue.length > 0, `${tag} residents listed with amount (${firstDue})`);
  await page.type('#collect-search', target.name.split(' ')[0]);
  await sleep(200);
  const matches = await page.$$('#collect-people .sm-person');
  ok(matches.length >= 1, `${tag} search narrows the list`);
  await page.evaluate(id => selectCollectGuest(id), target.id);
  await page.waitForSelector('#collect-amount', { timeout: 5000 });
  const prefill = await page.$eval('#collect-amount', e => e.value);
  eq(Number(prefill), Math.round(parseFloat(target.amount_due) > 0 ? parseFloat(target.amount_due) : parseFloat(target.monthly_rent)), `${tag} amount pre-filled from what is owed`);
  await page.evaluate(() => setCollectMode('UPI'));
  ok(await page.$eval('#collect-modes .sm-chip[data-mode="UPI"]', e => e.classList.contains('selected')), `${tag} payment mode selectable`);
  await page.evaluate(() => { document.getElementById('collect-amount').value = 1000; });
  await page.evaluate(() => saveCollectEntry());
  await page.waitForFunction(() => document.body.innerText.includes('recorded'), { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, `collect-done-${width}.png`) });
  ok(true, `${tag} payment saved from one screen`);
  const waHref = await page.$eval('.sm-done-card a.btn-success', e => e.href).catch(() => null);
  ok(waHref && waHref.startsWith('https://wa.me/91'), `${tag} WhatsApp receipt link built with country code`);
  ok(decodeURIComponent(waHref).includes(target.name), `${tag} WhatsApp text names the resident`);
  const saved = (await page.evaluate(() => apiFetch('/collections'))).find(c => parseFloat(c.amount) === 1000);
  ok(saved, `${tag} collection exists in the API`);
  eq(saved.payment_mode, 'UPI', `${tag} mode saved as chosen`);
  const afterLedger = await page.evaluate(id => apiFetch(`/guests/${id}/ledger`), target.id);
  ok(JSON.stringify(afterLedger) !== JSON.stringify(beforeLedger), `${tag} ledger reflects the new payment`);

  // Rent Due: collect button per resident
  await page.evaluate(() => navigate('rent-due'));
  await page.waitForFunction(() => document.querySelector('#rentdue-tb tr'), { timeout: 8000 });
  const order = await page.$$eval('#rentdue-tb tr td:first-child', els => els.map(e => e.textContent.trim()));
  ok(order.length >= 1, `${tag} rent due lists residents`);
  const hasCollect = await page.$('button[onclick^="collectFrom"]');
  ok(hasCollect, `${tag} Rent Due has a per-resident Collect button`);
  await noHScroll('rent-due');

  // ── Sprint 3: voice → preview → confirm on Collect ────────────────────
  await page.evaluate(() => navigate('collect'));
  await page.waitForSelector('#collect-mic', { timeout: 8000 });
  ok(await page.$('#collect-mic'), `${tag} Collect has a mic`);
  ok(typeof (await page.evaluate(() => typeof SMParse)) === 'string' && (await page.evaluate(() => typeof SMParse.parseCollection)) === 'function', `${tag} shared parser loaded in the browser`);
  const spoken = `${target.name} ${target.room_number ? 'room ' + target.room_number : ''} two thousand five hundred gpay`;
  await page.evaluate(t => collectApplyVoice(t), spoken);
  await page.waitForSelector('#collect-preview:not(.hidden) .btn-primary', { timeout: 8000 });
  const previewText = await page.$eval('#collect-preview', e => e.innerText);
  ok(previewText.includes(target.name) && previewText.includes('2,500') && previewText.includes('UPI'), `${tag} voice preview shows resident, ₹2,500, UPI`);
  const rowsBefore = (await page.evaluate(() => apiFetch('/collections'))).length;
  eq(await page.$eval('#collect-amount', e => e.value).catch(() => ''), '', `${tag} nothing filled before "Use this"`);
  eq((await page.evaluate(() => apiFetch('/collections'))).length, rowsBefore, `${tag} nothing saved by the preview`);
  await page.evaluate(() => collectUseVoice());
  await page.waitForSelector('#collect-amount', { timeout: 5000 });
  eq(await page.$eval('#collect-amount', e => e.value), '2500', `${tag} "Use this" fills the amount`);
  ok(await page.$eval('#collect-modes .sm-chip[data-mode="UPI"]', e => e.classList.contains('selected')), `${tag} and the mode`);
  eq((await page.evaluate(() => apiFetch('/collections'))).length, rowsBefore, `${tag} still nothing saved until Save is tapped`);
  await page.evaluate(() => saveCollectEntry());
  await page.waitForFunction(() => document.body.innerText.includes('recorded'), { timeout: 8000 });
  const voiceRow = (await page.evaluate(() => apiFetch('/collections'))).find(c => parseFloat(c.amount) === 2500);
  ok(voiceRow, `${tag} voice entry saved on confirm`); eq(voiceRow.source, 'voice', `${tag} saved with source=voice`);
  await page.screenshot({ path: path.join(SHOTS, `collect-voice-${width}.png`) });
  // Ambiguous phrase → asks, never guesses
  await page.evaluate(() => navigate('collect'));
  await page.waitForSelector('#collect-mic', { timeout: 8000 });
  await page.evaluate(() => collectApplyVoice('somebody paid three thousand'));
  await page.waitForSelector('#collect-preview:not(.hidden)', { timeout: 8000 });
  ok((await page.$eval('#collect-preview', e => e.innerText)).includes("couldn't tell which resident"), `${tag} unknown resident → asks instead of guessing`);

  // ── Sprint 3: complaint by voice ──────────────────────────────────────
  await page.evaluate(() => navigate('complaints'));
  await page.waitForFunction(() => document.querySelector('#page-content h1')?.textContent.includes('Complaint'), { timeout: 8000 });
  await page.evaluate(() => complaintModal());
  await page.waitForSelector('#cp-mic', { timeout: 5000 });
  await page.evaluate(() => complaintApplyVoice('geyser leaking in bathroom room 2'));
  await page.waitForSelector('#cp-preview:not(.hidden) .btn-primary', { timeout: 8000 });
  ok((await page.$eval('#cp-preview', e => e.innerText)).includes('Water'), `${tag} complaint preview categorised as Water`);
  eq(await page.$eval('#cp-desc', e => e.value), '', `${tag} form untouched before confirm`);
  await page.evaluate(() => document.querySelector('#cp-preview .btn-primary').click());
  eq(await page.$eval('#cp-category', e => e.value), 'Water', `${tag} category filled on confirm`);
  eq(await page.$eval('#cp-desc', e => e.value), 'geyser leaking in bathroom room 2', `${tag} description filled`);
  eq(await page.$eval('#cp-room', e => e.value), 'Room 2', `${tag} room filled`);
  await page.evaluate(() => saveComplaint());
  await page.waitForFunction(() => document.body.innerText.includes('geyser leaking'), { timeout: 8000 });
  const cRow = (await page.evaluate(() => apiFetch('/complaints'))).find(c => /geyser leaking/.test(c.description));
  eq(cRow.source, 'voice', `${tag} complaint saved with source=voice`);

  // ── Sprint 3: bill photo → purchase (stubbed reader) ──────────────────
  await page.evaluate(() => navigate('purchases'));
  await page.waitForFunction(() => document.querySelector('#page-content h1'), { timeout: 8000 });
  await page.evaluate(() => purchaseModal());
  await page.waitForSelector('#pu-scan-btn', { timeout: 5000 });
  ok(await page.$('#pu-scan-btn'), `${tag} purchase modal has a scan-bill button`);
  // Drive the same code path as the camera, with a canvas-made image instead of a file picker.
  const scanned = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 40; c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, 40, 40);
    const image = c.toDataURL('image/jpeg', 0.8);
    return apiFetch('/ai/vision', { method: 'POST', body: { kind: 'bill', image } });
  });
  eq(scanned.fields.amount, 845, `${tag} bill scan returns fields`);
  await page.evaluate(f => { const b = document.getElementById('pu-preview'); b.classList.remove('hidden'); purchaseUseScan(f); }, scanned.fields);
  eq(await page.$eval('#pu-amt', e => e.value), '845', `${tag} amount filled from bill`);
  eq(await page.$eval('#pu-paid', e => e.value), 'Nandini Milk Parlour', `${tag} vendor filled`);
  eq(await page.$eval('#pu-cat', e => e.value), 'Groceries', `${tag} category filled`);
  eq(await page.$eval('#pu-date', e => e.value), '2026-09-11', `${tag} date filled`);
  await page.evaluate(() => savePurchase());
  await sleep(800);
  const pRow = (await page.evaluate(() => apiFetch('/purchases'))).find(p => parseFloat(p.amount) === 845);
  ok(pRow, `${tag} purchase saved`); eq(pRow.source, 'photo', `${tag} saved with source=photo`);

  // ── Sprint 3: ID photo → guest fields ─────────────────────────────────
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table'), { timeout: 8000 });
  await page.evaluate(() => guestModal());
  await page.waitForSelector('#gf-scan-btn', { timeout: 5000 });
  ok(await page.$('#gf-idnum'), `${tag} guest form now has an ID number field`);
  await page.evaluate(() => guestUseScan({ name: 'Scan Test', id_proof_type: 'Aadhaar', id_proof_number: '999988887777', address: '5th Cross, Tumakuru', confidence: 'high' }));
  eq(await page.$eval('#gf-name', e => e.value), 'Scan Test', `${tag} name filled from ID`);
  eq(await page.$eval('#gf-idtype', e => e.value), 'Aadhaar', `${tag} ID type mapped to the form's list`);
  eq(await page.$eval('#gf-idnum', e => e.value), '999988887777', `${tag} ID number filled`);
  eq(await page.$eval('#gf-address', e => e.value), '5th Cross, Tumakuru', `${tag} address filled`);
  await page.evaluate(() => { document.getElementById('gf-join').value = '2026-09-01'; document.getElementById('gf-phone').value = '9' + String(Date.now()).slice(-9); });
  await page.evaluate(() => saveGuest());
  await page.waitForFunction(() => !document.querySelector('#gf-name'), { timeout: 8000 });
  const saved2 = (await page.evaluate(() => API.getGuests())).find(g => g.name === 'Scan Test');
  ok(saved2, `${tag} guest saved from scanned fields`);
  const full = await page.evaluate(id => API.getGuest(id), saved2.id);
  eq(full.address, '5th Cross, Tumakuru', `${tag} LINKAGE: address actually persisted`); eq(full.id_proof_number, '999988887777', `${tag} ID number persisted`);

  // ── Sprint 4: brief on Home, ask box, reminders, priority ─────────────
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('#brief-card .brief-line', { timeout: 15000 });
  const briefApi = await page.evaluate(() => apiFetch('/copilot/brief'));
  const briefUi = await page.$eval('#brief-card', e => e.textContent);
  for (const line of briefApi.changed) ok(briefUi.includes(line), `${tag} Home shows brief line "${line.slice(0, 30)}…" word-for-word from ai_reads`);
  ok((await page.$eval('#page-content', e => e.textContent)).includes('Needs attention') || !briefApi.attention.high.concat(briefApi.attention.medium, briefApi.attention.low).length, `${tag} Home shows the attention section when there is something to show`);
  await page.screenshot({ path: path.join(SHOTS, `home-brief-${width}.png`) });
  await page.evaluate(() => copilotAsk('who has not paid'));
  await page.waitForFunction(() => { const a = document.getElementById('copilot-out'); return a && !a.classList.contains('hidden') && /owe|Nobody/.test(a.textContent); }, { timeout: 10000 });
  const askUi = await page.$eval('#copilot-out', e => e.textContent);
  ok(/owe|Nobody/.test(askUi), `${tag} ask answers in place ("${askUi.slice(0, 40)}…")`);
  await noHScroll('dashboard');

  await page.evaluate(() => navigate('reminders'));
  await page.waitForFunction(() => document.querySelector('#page-content h1')?.textContent.includes('Rent Reminders'), { timeout: 8000 });
  const remCards = await page.$$('[id^="rem-text-"]');
  const remApi = await page.evaluate(() => apiFetch('/assistant/reminders?lang=en'));
  eq(remCards.length, remApi.length, `${tag} one editable draft per resident who owes (${remApi.length})`);
  if (remApi.length) {
    eq(await page.$eval('[id^="rem-text-"]', e => e.value), remApi[0].text, `${tag} draft text identical to the API's`);
    await page.evaluate(() => { const t = document.querySelector('[id^="rem-text-"]'); t.value = t.value + ' — edited by warden'; });
    const opened = [];
    await page.exposeFunction('__capture', u => opened.push(u)).catch(() => {});
    await page.evaluate(() => { window.open = u => { window.__capture(u); return null; }; });
    await page.evaluate(id => sendReminder(id), remApi[0].guest_id);
    await sleep(600);
    ok(opened[0] && opened[0].startsWith('https://wa.me/91') && decodeURIComponent(opened[0]).includes('edited by warden'), `${tag} Send opens WhatsApp with the warden's edited text`);
    const logged = await page.evaluate(() => apiFetch('/assistant/reminders?lang=en'));
    ok(logged[0].last_reminded, `${tag} send is logged (last_reminded set)`);
  }
  await page.evaluate(() => document.querySelector('.sm-chip-row .sm-chip:last-child').click());
  await page.waitForFunction(() => document.querySelector('.sm-chip-row .sm-chip:last-child')?.classList.contains('selected'), { timeout: 8000 });
  if (remApi.length) ok((await page.$eval('[id^="rem-text-"]', e => e.value)).includes('ನಮಸ್ಕಾರ'), `${tag} Kannada toggle rewrites the drafts`);
  await page.screenshot({ path: path.join(SHOTS, `reminders-${width}.png`) });
  await noHScroll('reminders');

  await page.evaluate(() => navigate('complaints'));
  await page.waitForFunction(() => document.querySelector('#page-content h1')?.textContent.includes('Complaint'), { timeout: 8000 });
  const hasPriority = await page.$$eval('#complaints-tb td[data-label="PRIORITY"] .badge', els => els.length);
  ok(hasPriority >= 1, `${tag} complaints show a priority badge`);
  ok(await page.evaluate(() => document.body.innerText.includes('🔴 High')), `${tag} the geyser/water issue is marked High`);

  // ── Sprint 5: owner report on Reports, attention card on Home, schema banner ──
  await page.evaluate(() => navigate('reports'));
  await page.waitForSelector('#owner-card', { timeout: 8000 });
  await page.waitForFunction(() => { const t = document.querySelector('#owner-summary')?.textContent || ''; return t && !/Loading|Computing/.test(t); }, { timeout: 15000 });
  const summary = await page.$eval('#owner-summary', e => e.textContent);
  eq(summary.split('\n').length, 5, `${tag} owner summary is five lines (${summary.slice(0, 120)})`);
  ok(/collected Rs [\d,]+/.test(summary), `${tag} summary quotes collections`);
  ok((await page.$eval('#owner-forecast', e => e.textContent)).includes('Next 3 months'), `${tag} forecast shown`);
  const ownerW = await page.$eval('#owner-card', e => e.getBoundingClientRect().right);
  ok(ownerW <= width + 1, `${tag} owner card fits (${Math.round(ownerW)}px)`);
  await page.screenshot({ path: path.join(SHOTS, `owner-report-${width}.png`) });
  const ownerDl = path.join(SHOTS, `owner-dl-${width}`); fs.mkdirSync(ownerDl, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ownerDl, browserContextId: ctx.id });
  await page.evaluate(() => downloadOwnerPdf());
  let pdfFile = null;
  for (let i = 0; i < 40 && !pdfFile; i++) { await sleep(250); pdfFile = fs.readdirSync(ownerDl).find(f => f.endsWith('.pdf')); }
  ok(pdfFile, `${tag} owner PDF downloads`);
  eq(fs.readFileSync(path.join(ownerDl, pdfFile)).subarray(0, 4).toString(), '%PDF', `${tag} owner PDF is real`);
  await page.evaluate(() => downloadAccountantZip());
  let zipFile = null;
  for (let i = 0; i < 40 && !zipFile; i++) { await sleep(250); zipFile = fs.readdirSync(ownerDl).find(f => f.endsWith('.zip')); }
  ok(zipFile, `${tag} accountant ZIP downloads`);
  eq(fs.readFileSync(path.join(ownerDl, zipFile)).readUInt32LE(0), 0x04034b50, `${tag} ZIP has a valid signature`);

  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  // Sprint 7 folded the owner's anomaly list into Home's "Flagged for the owner".
  await page.waitForFunction(() => /Flagged for the owner/.test(document.getElementById('page-content')?.textContent || ''), { timeout: 12000 });
  const homeFlags = await page.evaluate(() => homeCache.flags.length);
  ok(homeFlags >= 1, `${tag} Home shows owner flags (${homeFlags})`);
  ok(await page.$eval('#page-content', e => /Open/.test(e.textContent)), `${tag} flags carry an Open button`);

  await page.evaluate(() => navigate('admin'));
  await page.waitForSelector('#schema-banner', { timeout: 8000 });
  await sleep(500);
  eq(await page.$eval('#schema-banner', e => e.innerHTML.trim()), '', `${tag} no schema banner when migrations are current`);

  // ── Sprint 6: Copilot bar on every screen, brief v2, prepare→confirm ────
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  ok(await page.$('#copilot-bar'), `${tag} Copilot bar present`);
  await page.waitForSelector('.health-pill', { timeout: 15000 });
  const healthTxt = await page.$eval('.health-pill', e => e.textContent);
  ok(/Health \d+/.test(healthTxt), `${tag} Home shows a health score (${healthTxt})`);
  const homeAll = await page.$eval('#page-content', e => e.textContent);
  ok(/Siri recommends/.test(homeAll) || !(await page.evaluate(() => homeCache.recommendations.length)), `${tag} recommendations shown when present`);
  ok(/What changed/.test(homeAll), `${tag} brief shows what changed`);
  const barW = await page.$eval('#copilot-bar', e => e.getBoundingClientRect().right);
  ok(barW <= width + 1, `${tag} Copilot bar fits (${Math.round(barW)}px)`);
  for (const pg of ['guests', 'rooms', 'rent-due', 'purchases']) {
    await page.evaluate(p => navigate(p), pg);
    await sleep(500);
    ok(await page.$('#copilot-bar'), `${tag} Copilot bar persists on ${pg}`);
    const chips = await page.$$eval('#copilot-chips .copilot-chip', els => els.map(e => e.textContent));
    ok(chips.length >= 1, `${tag} ${pg} has context chips (${chips[0]})`);
  }
  // inform
  await page.evaluate(() => copilotAsk('who has not paid?'));
  await page.waitForFunction(() => /owe|outstanding|Nobody/.test(document.querySelector('#copilot-out')?.textContent || ''), { timeout: 10000 });
  ok(true, `${tag} inform answer renders inline`);
  // prepare → preview → nothing saved → confirm → saved
  const nBefore = (await page.evaluate(() => apiFetch('/collections'))).length;
  await page.evaluate(n => copilotAsk(`record 700 rent from ${n} cash`), target.name);
  await page.waitForSelector('#copilot-out .copilot-preview', { timeout: 10000 });
  ok(await page.$eval('#copilot-out', e => /700/.test(e.textContent) && /Cash/.test(e.textContent)), `${tag} preview shows amount and mode`);
  eq((await page.evaluate(() => apiFetch('/collections'))).length, nBefore, `${tag} MONEY: preview saved nothing`);
  const confirmBtn = await page.$('#copilot-out .btn-success');
  ok(confirmBtn, `${tag} Confirm button present`);
  const btnH = await page.$eval('#copilot-out .btn-success', e => e.getBoundingClientRect().height);
  ok(btnH >= 44, `${tag} confirm is thumb-sized (${Math.round(btnH)}px)`);
  await page.screenshot({ path: path.join(SHOTS, `copilot-preview-${width}.png`) });
  await page.evaluate(() => document.querySelector('#copilot-out .btn-success').click());
  await page.waitForFunction(() => /✅/.test(document.querySelector('#copilot-out')?.textContent || ''), { timeout: 10000 });
  eq((await page.evaluate(() => apiFetch('/collections'))).length, nBefore + 1, `${tag} MONEY: exactly one row after confirm`);
  const cp = (await page.evaluate(() => apiFetch('/collections'))).find(c => parseFloat(c.amount) === 700);
  eq(cp.source, 'copilot', `${tag} saved with source=copilot`);
  // context: viewing a resident makes "her" resolve
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 8000 });
  await page.evaluate(id => viewGuest(id), target.id);
  await page.waitForSelector('.modal', { timeout: 8000 });
  await sleep(300);
  const chipsCtx = await page.$$eval('#copilot-chips .copilot-chip', els => els.map(e => e.textContent));
  ok(chipsCtx.some(c => /Summarise/.test(c)), `${tag} chips change when viewing a resident`);
  await page.evaluate(() => copilotAsk('why is she overdue?'));
  await page.waitForFunction(n => (document.querySelector('#copilot-out')?.textContent || '').includes(n), { timeout: 10000 }, target.name);
  ok(true, `${tag} "she" resolves to the resident being viewed`);
  await page.evaluate(() => closeModal());
  const ctxAfter = await page.evaluate(() => smContext.resident_id);
  eq(ctxAfter, null, `${tag} context clears when the modal closes`);
  // 6.1: Admin → Copilot log tab renders the audit
  await page.evaluate(() => navigate('admin'));
  await page.waitForSelector('#schema-banner', { timeout: 8000 });
  await page.evaluate(() => switchAdminTab('copilot'));
  await page.waitForFunction(() => /Copilot log|No Copilot activity/.test(document.querySelector('#admin-tab-content')?.textContent || ''), { timeout: 10000 });
  const logTxt = await page.$eval('#admin-tab-content', e => e.textContent);
  ok(/record 700 rent/.test(logTxt), `${tag} Copilot log lists the ask made earlier (${logTxt.replace(/\s+/g, ' ').slice(0, 160)})`);
  ok(await page.$eval('#admin-tab-content', e => /done/.test(e.textContent)), `${tag} Copilot log shows the confirmed outcome`);
  await page.evaluate(() => switchAdminTab('settings'));
  await page.waitForSelector('#set-evening-time', { timeout: 8000 });
  ok(await page.$('#set-evening-time'), `${tag} evening time is editable in Settings`);
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('#copilot-q', { timeout: 8000 });
  // Ctrl+K focuses the bar
  // Sprint 7: Ctrl+K opens universal search; the Copilot bar is always on screen.
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'search-q', `${tag} Ctrl+K opens search`);
  await page.keyboard.press('Escape');
  ok(await page.$('#copilot-q'), `${tag} Copilot bar still reachable on the page`);

  // ── Sprint 7: one product — Home in one call, groups, search, quick add ──
  // Let any in-flight navigation settle, then count the requests one fresh
  // Home render makes.
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  await sleep(600);
  let homeCalls = 0;
  const countHome = res => { if (/\/api\/home/.test(res.url())) homeCalls++; };
  page.on('response', countHome);
  await page.evaluate(() => navigate('guests'));
  await sleep(400);
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  eq(homeCalls, 1, `${tag} Home renders from exactly one /home request`);
  page.off('response', countHome);
  const homeTxt = await page.$eval('#page-content', e => e.textContent);
  const hierarchy = ['Siri\'s Brief', 'Today', 'Occupancy'].map(h => homeTxt.indexOf(h));
  ok(hierarchy.every((v, i) => v >= 0 && (i === 0 || v > hierarchy[i - 1])), `${tag} Home follows brief → … → occupancy order`);
  ok(/Health \d+/.test(homeTxt), `${tag} Home shows the health pill`);
  ok(await page.$('.home-section-h'), `${tag} Home uses sections, not a grid of module cards`);
  eq(await page.$$eval('#page-content .stat-grid', e => e.length), 0, `${tag} the old module-card grid is gone`);
  await page.screenshot({ path: path.join(SHOTS, `home-sprint7-${width}.png`) });
  await noHScroll('home');
  // Admin sees money on Home; the API must not send it to staff at all
  ok(/This month/.test(homeTxt), `${tag} admin Home shows the month's money`);
  const staffHome = await page.evaluate(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ui_staff', password: 'staff123' }) });
    const { token } = await r.json();
    const h = await (await fetch('/api/home', { headers: { Authorization: 'Bearer ' + token } })).json();
    return { hasFinance: 'finance' in h, hasFlags: 'flags' in h, hasApprovals: h.pending && h.pending.approvals !== undefined, hasRentDue: !!h.today.rentDue };
  });
  eq(staffHome.hasFinance, false, `${tag} ROLE: staff /home carries no finance block`);
  eq(staffHome.hasFlags, false, `${tag} ROLE: staff /home carries no owner flags`);
  eq(staffHome.hasApprovals, false, `${tag} ROLE: staff /home carries no approval queue`);
  eq(staffHome.hasRentDue, true, `${tag} ROLE: staff still sees rent due`);
  // Icons, not emoji, in the chrome
  // Icons must render at their declared size — a stray `height:auto` once made
  // them 150px tall inside cards.
  const iconSizes = await page.$$eval('#page-content svg.ic', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  ok(iconSizes.length >= 3, `${tag} icons render in content (${iconSizes.length})`);
  ok(iconSizes.every(h => h > 0 && h <= 24), `${tag} every icon is icon-sized (max ${Math.max(...iconSizes)}px)`);
  const hdrH = await page.$eval('#brief-card .card-header', e => Math.round(e.getBoundingClientRect().height));
  ok(hdrH <= 80, `${tag} card headers stay compact (${hdrH}px)`);
  const sprite = await page.$$eval('#icon-sprite symbol', els => els.length);
  ok(sprite >= 20, `${tag} icon sprite loaded (${sprite} icons)`);
  const navTxt = await page.$$eval('.nav-item', els => els.map(e => e.textContent.trim()).join('|'));
  ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(navTxt), `${tag} no emoji in the sidebar (${navTxt.slice(0, 60)})`);
  const tabTxt = await page.$$eval('.sm-tab', els => els.map(e => e.textContent.trim()).join('|'));
  ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(tabTxt), `${tag} no emoji in the tab bar`);
  eq(tabTxt.split('|').length, 5, `${tag} five tabs`);
  ok(/Residents/.test(navTxt) && /Operations/.test(navTxt) && /Finance/.test(navTxt), `${tag} sidebar is grouped and renamed`);
  eq(await page.$$eval('.nav-item', els => els.length), 7, `${tag} sidebar is 7 entries, not 17`);
  // Grouped screens keep working and show their sub-tabs
  for (const [group, first] of [['finance', 'collect'], ['operations', 'daily-checklist']]) {
    await page.evaluate(g => navigate(g), group);
    await page.waitForSelector('.subtabs .subtab.active', { timeout: 10000 });
    const active = await page.$eval('.subtabs .subtab.active', e => e.textContent.trim());
    ok(active.length > 0, `${tag} ${group} opens on ${active}`);
    const activeNav = await page.$eval('.nav-item.active', e => e.dataset.page);
    eq(activeNav, group, `${tag} ${group} highlights its sidebar entry`);
  }
  // Every legacy page key still navigates (bookmarks, old calls, tab bar)
  for (const key of ['dashboard', 'rooms', 'guests', 'daily-menu', 'daily-checklist', 'complaints', 'payments', 'guest-messages', 'inbox', 'purchases', 'collections', 'rent-due', 'reports', 'admin', 'collect', 'reminders']) {
    await page.evaluate(k => navigate(k), key);
    // Wait for the screen to actually paint (skeleton → content), not just for
    // the absence of the error card.
    await page.waitForFunction(() => {
      const c = document.getElementById('page-content');
      return c && c.textContent.trim().length > 0 && !c.querySelector('.sm-skel') && !document.body.innerText.includes('This screen could not load');
    }, { timeout: 12000 });
    ok(true, `${tag} legacy key "${key}" still renders`);
  }
  // Universal search
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 12000 });
  await page.evaluate(() => openSearch());
  await page.waitForSelector('#search-q', { timeout: 5000 });
  await page.type('#search-q', target.name.slice(0, 4));
  await page.waitForSelector('.search-item', { timeout: 8000 });
  const found = await page.$eval('.search-results', e => e.textContent);
  ok(found.includes(target.name), `${tag} search finds the resident`);
  await page.keyboard.press('ArrowDown');
  ok(await page.$('.search-item.sel'), `${tag} arrow keys move the selection`);
  await page.screenshot({ path: path.join(SHOTS, `search-${width}.png`) });
  await page.keyboard.press('Escape');
  ok(!(await page.$('#search-overlay')), `${tag} Esc closes search`);
  await page.evaluate(() => openSearch());
  await page.type('#search-q', 'zzzznothing');
  await page.waitForFunction(() => /Nothing matches/.test(document.querySelector('#search-results')?.textContent || ''), { timeout: 8000 });
  ok(true, `${tag} empty search says so`);
  await page.keyboard.press('Escape');
  // Quick action
  await page.evaluate(() => openQuickActions());
  await page.waitForSelector('#qa-sheet .qa-item', { timeout: 5000 });
  const qa = await page.$$eval('#qa-sheet .qa-item', els => els.map(e => e.textContent.trim()));
  ok(qa.length >= 4 && qa.some(x => /Collect rent/.test(x)) && qa.some(x => /Add expense/.test(x)), `${tag} quick actions listed (${qa.length})`);
  const qaH = await page.$eval('#qa-sheet .qa-item', e => e.getBoundingClientRect().height);
  ok(qaH >= 44, `${tag} quick actions are thumb-sized`);
  await page.evaluate(() => document.querySelectorAll('#qa-sheet .qa-item')[0].click());
  await page.waitForFunction(() => /Collect/.test(document.getElementById('page-title')?.textContent || ''), { timeout: 8000 });
  ok(true, `${tag} quick action navigates`);
  ok(!(await page.$('#qa-sheet')), `${tag} quick action sheet closes after use`);

  // ── Sprint 7.1: dark theme, and the two gaps found on the live app ──────
  await page.evaluate(() => navigate('dashboard'));
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  const readTheme = () => page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const card = getComputedStyle(document.querySelector('.card'));
    return { theme: document.documentElement.getAttribute('data-theme'), bg: cs.backgroundColor, text: cs.color, card: card.backgroundColor };
  });
  const lum = c => { const [r, g, b] = c.match(/\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
  const light = await readTheme();
  eq(light.theme, 'light', `${tag} starts in light`);
  ok(contrast(light.bg, light.text) >= 7, `${tag} light text contrast ${contrast(light.bg, light.text).toFixed(1)}:1`);
  await page.evaluate(() => toggleTheme());
  await sleep(200);
  const dark = await readTheme();
  eq(dark.theme, 'dark', `${tag} toggles to dark`);
  ok(lum(dark.bg) < 0.12, `${tag} dark background is actually dark`);
  ok(contrast(dark.bg, dark.text) >= 7, `${tag} dark text contrast ${contrast(dark.bg, dark.text).toFixed(1)}:1`);
  ok(lum(dark.card) < 0.15, `${tag} cards are dark too (no white slabs)`);
  // Every surface on the page must follow the theme — a hardcoded #fff shows up here.
  const lightSurfaces = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#page-content *, .topbar, .sidebar, .sm-tabbar, #copilot-bar *').forEach(e => {
      const bg = getComputedStyle(e).backgroundColor;
      const m = bg.match(/\d+/g);
      if (!m || bg.includes('rgba(0, 0, 0, 0)')) return;
      const [r, g, b] = m.map(Number);
      if (r > 235 && g > 235 && b > 235) out.push((e.id || e.className || e.tagName).toString().slice(0, 40));
    });
    return [...new Set(out)].slice(0, 8);
  });
  eq(lightSurfaces.length, 0, `${tag} no light surfaces left in dark mode (${lightSurfaces.join(', ')})`);
  // Inputs must be readable, not white-on-white
  await page.evaluate(() => navigate('collect'));
  await page.waitForSelector('#collect-search', { timeout: 10000 });
  const inputCs = await page.$eval('#collect-search', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
  ok(contrast(inputCs.bg, inputCs.color) >= 4.5, `${tag} dark input contrast ${contrast(inputCs.bg, inputCs.color).toFixed(1)}:1`);
  // Solid green/red/amber fills must keep readable text in both themes —
  // a blanket white→token sweep once made toast text dark-on-green.
  await page.evaluate(() => toast('contrast probe', 'ok'));
  await sleep(150);
  const toastCs = await page.$eval('#sm-toast', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
  ok(contrast(toastCs.bg, toastCs.color) >= 4.5, `${tag} toast text contrast ${contrast(toastCs.bg, toastCs.color).toFixed(1)}:1`);
  await page.evaluate(() => document.getElementById('sm-toast').classList.remove('show'));
  await page.screenshot({ path: path.join(SHOTS, `dark-${width}.png`) });
  // The choice survives a reload
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.home-greeting', { timeout: 15000 });
  eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', `${tag} theme persists across reload`);
  await page.evaluate(() => toggleTheme());
  await sleep(150);
  eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', `${tag} toggles back to light`);

  // Gap: a Copilot answer must not follow the user to another screen
  await page.evaluate(() => copilotAsk('who has not paid?'));
  await page.waitForFunction(() => /owe|Nobody/.test(document.querySelector('#copilot-out')?.textContent || ''), { timeout: 10000 });
  await page.evaluate(() => navigate('rooms'));
  await sleep(400);
  ok(await page.$eval('#copilot-out', e => e.classList.contains('hidden') && e.textContent.trim() === ''), `${tag} Copilot answer clears when leaving the screen`);
  eq(await page.$eval('#copilot-q', e => e.value), '', `${tag} Copilot input clears too`);

  // Gap: the Residents screen is called Residents everywhere, not "Guests"
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 10000 });
  const resTxt = await page.$eval('#page-content', e => e.textContent);
  ok(/Residents/.test(resTxt), `${tag} Residents heading`);
  ok(!/All Guests|Add Guest/.test(resTxt), `${tag} no "Guests" wording left on the screen`);

  // ── Sprint 7 completion: no "guest" wording, empty states carry a next step ──
  const wording = {};
  for (const pg of ['guests', 'guest-messages', 'inbox', 'rent-due', 'balance-sheet', 'complaints']) {
    await page.evaluate(k => navigate(k), pg);
    await page.waitForFunction(() => {
      const c = document.getElementById('page-content');
      return c && c.textContent.trim().length > 0 && !c.querySelector('.sm-skel');
    }, { timeout: 12000 });
    wording[pg] = await page.$eval('#page-content', e => e.textContent);
  }
  ok(!/Guest Messages|Guest Inbox|All Guests|Add Guest/.test(Object.values(wording).join(' ')), `${tag} no legacy "Guest…" screen wording left`);
  ok(/Announcements/.test(wording['guest-messages']), `${tag} Announcements screen renamed`);
  ok(/Messages/.test(wording['inbox']), `${tag} Messages screen renamed`);
  eq(await page.evaluate(() => { navigate('balance-sheet'); return document.getElementById('page-title').textContent; }), 'Owner & Assets', `${tag} Balance Sheet is "Owner & Assets"`);
  await page.waitForFunction(() => !document.querySelector('#page-content .sm-skel'), { timeout: 12000 });
  const emptyStates = await page.$$eval('.sm-empty-state', els => els.map(e => ({ h: !!e.querySelector('h4'), icon: !!e.querySelector('svg.ic') })));
  ok(emptyStates.every(e => e.h && e.icon), `${tag} empty states have a heading and an icon (${emptyStates.length} on screen)`);
  // Every button an empty state offers must call a function that exists —
  // a dead "Add asset" button shipped once because the name was guessed.
  const deadButtons = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.sm-empty-state button[onclick]').forEach(b => {
      const fn = (b.getAttribute('onclick').match(/^\s*([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
      if (fn && typeof window[fn] !== 'function') out.push(fn);
    });
    return out;
  });
  eq(deadButtons.length, 0, `${tag} no empty-state button calls a missing function (${deadButtons.join(', ')})`);

  // ── Sprint 8: Resident 360, move-in and checkout wizards ───────────────
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 10000 });
  await page.evaluate(id => residentProfile(id), target.id);
  await page.waitForSelector('.r360-kv', { timeout: 10000 });
  const r360txt = await page.$eval('.modal-body', e => e.textContent);
  ok(r360txt.includes(target.name) || (await page.$eval('.modal-header', e => e.textContent)).includes(target.name), `${tag} Resident 360 opens on her`);
  ok(/SM\d{4}/.test(r360txt), `${tag} shows her resident number`);
  const tabs360 = await page.$$eval('.modal .subtab', els => els.map(e => e.textContent.trim()));
  eq(tabs360.length, 5, `${tag} five profile tabs (${tabs360.join('/')})`);
  await page.evaluate(() => { r360.tab = 'stay'; renderResident360(); });
  await page.waitForSelector('.r360-timeline li', { timeout: 8000 });
  const tlDates = await page.$$eval('.r360-timeline .tl-date', els => els.map(e => e.textContent.trim()));
  ok(tlDates.length >= 2, `${tag} timeline rendered (${tlDates.length} entries)`);
  ok(await page.$eval('.r360-timeline li:last-child', e => /Moved in/.test(e.textContent)), `${tag} timeline ends with "Moved in"`);
  await page.evaluate(() => { r360.tab = 'money'; renderResident360(); });
  await sleep(200);
  ok(await page.$eval('#r360-body', e => /Payments/.test(e.textContent)), `${tag} money tab lists payments`);
  await page.screenshot({ path: path.join(SHOTS, `resident360-${width}.png`) });
  await page.evaluate(() => closeModal());

  // Move-in wizard: nothing is written until the final step
  const guestsBefore = (await page.evaluate(() => API.getGuests())).length;
  await page.evaluate(() => moveInWizard());
  await page.waitForSelector('#mi-name', { timeout: 10000 });
  ok(await page.$('.wiz-bar'), `${tag} wizard shows progress`);
  await page.type('#mi-name', 'Wizard Tester');
  await page.type('#mi-phone', '9' + String(Date.now()).slice(-9));
  await page.evaluate(() => moveInStep(1));
  await page.waitForSelector('#mi-ec-name', { timeout: 5000 });
  await page.evaluate(() => moveInStep(1));
  await page.waitForSelector('#mi-room', { timeout: 5000 });
  const roomOpts = await page.$$eval('#mi-room option', els => els.map(e => e.value).filter(Boolean));
  ok(roomOpts.length >= 1, `${tag} wizard offers rooms with a free bed`);
  await page.select('#mi-room', roomOpts[0]);
  await page.evaluate(() => moveInStep(1));
  await page.waitForSelector('#mi-rent', { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('mi-rent').value = 6000; document.getElementById('mi-dep').value = 12000; });
  await page.evaluate(() => moveInStep(1));
  await page.waitForSelector('#mi-idtype', { timeout: 5000 });
  await page.evaluate(() => moveInStep(1));
  await page.waitForSelector('#mi-pay-dep', { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('mi-pay-dep').value = 12000; });
  await page.evaluate(() => moveInStep(1));
  await page.waitForFunction(() => /Nothing is saved until/.test(document.querySelector('.modal-body')?.textContent || ''), { timeout: 5000 });
  eq((await page.evaluate(() => API.getGuests())).length, guestsBefore, `${tag} DATA: six steps in, still nobody created`);
  await page.screenshot({ path: path.join(SHOTS, `movein-${width}.png`) });
  await page.evaluate(() => moveInSave());
  await page.waitForFunction(() => !document.querySelector('#mi-name'), { timeout: 10000 });
  const afterMoveIn = await page.evaluate(() => API.getGuests());
  eq(afterMoveIn.length, guestsBefore + 1, `${tag} resident created on confirm`);
  const made = afterMoveIn.find(g => g.name === 'Wizard Tester');
  ok(made, `${tag} she is in the list`);
  const herPays = await page.evaluate(id => apiFetch(`/guests/${id}/timeline`), made.id);
  ok(herPays.items.some(i => i.kind === 'payment' && /12,000/.test(i.title)), `${tag} the deposit taken at move-in is recorded`);
  // Abandoning the wizard writes nothing
  await page.evaluate(() => moveInWizard());
  await page.waitForSelector('#mi-name', { timeout: 8000 });
  await page.type('#mi-name', 'Abandoned Person');
  await page.evaluate(() => closeModal());
  await sleep(300);
  eq((await page.evaluate(() => API.getGuests())).length, guestsBefore + 1, `${tag} DATA: an abandoned wizard leaves nobody behind`);

  // Checkout wizard: refund = deposit − deductions, and it is the server's number
  await page.evaluate(id => checkoutWizard(id), made.id);
  await page.waitForSelector('#co-date', { timeout: 10000 });
  await page.evaluate(() => checkoutStep(1));
  await page.waitForSelector('#co-ded', { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('co-ded').value = 500; document.getElementById('co-notes').value = 'Broken drawer'; });
  await page.evaluate(() => checkoutStep(1));
  await page.waitForFunction(() => /Refund due/.test(document.querySelector('.modal-body')?.textContent || ''), { timeout: 5000 });
  ok(await page.$eval('.modal-body', e => /11,500/.test(e.textContent)), `${tag} MONEY: refund shown as 12,000 − 500`);
  const activeBefore = (await page.evaluate(() => API.getGuests())).filter(g => g.is_active).length;
  await page.screenshot({ path: path.join(SHOTS, `checkout-${width}.png`) });
  await page.evaluate(() => checkoutSave());
  await page.waitForFunction(() => !document.querySelector('#co-date'), { timeout: 10000 });
  const activeAfter = (await page.evaluate(() => API.getGuests())).filter(g => g.is_active).length;
  eq(activeAfter, activeBefore - 1, `${tag} she is checked out`);
  const refunds = await page.evaluate(() => apiFetch('/deposit-refunds'));
  ok(refunds.some(x => parseFloat(x.refund_amount) === 11500), `${tag} MONEY: the refund recorded is 11,500`);
  // Leaving-soon filter
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 10000 });
  ok(await page.$eval('#page-content', e => /Leaving soon/.test(e.textContent)), `${tag} Residents has a "Leaving soon" filter`);

  eq(jsErrors.length, 0, `${tag} no uncaught JS errors (${jsErrors.join('; ')})`);
  await page.close(); await ctx.close();
}

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, guest_rent_history, deposit_refunds, guests, rooms RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  // Fixtures via API: two rooms, one guest, one confirmed collection
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) })).json();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const post = (p, b) => fetch(BASE + '/api' + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
  await post('/users', { username: 'ui_staff', password: 'staff123', role: 'staff' }).catch(() => {});
  const r1 = await post('/rooms', { room_number: 'U1', floor: 1, total_beds: 2, monthly_rent: 6000 });
  await post('/rooms', { room_number: 'U2', floor: 1, total_beds: 2, monthly_rent: 6000 });
  await post('/rooms', { room_number: 'U3', floor: 1, total_beds: 2, monthly_rent: 6000 });
  const g = await post('/guests', { name: 'UI Guest', phone: '9000000001', room_id: r1.id, bed_number: 1, join_date: '2026-06-01', monthly_rent: 6000, deposit_amount: 12000 });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  await post('/collections', { guest_id: g.id, guest_name: g.name, amount: 6000, collection_date: today, collection_month: 'September 2026', collection_type: 'rent', payment_mode: 'upi' });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const w of [360, 390]) { await runAtWidth(browser, BASE, w); console.log(`✓ ${w}px`); }
    console.log(`\n✅ UI gate passed — ${count} assertions (screenshots in backend/test/screenshots/)`);
  } catch (e) {
    console.error(`\n❌ UI gate FAILED after ${count} assertions:\n`, e.stack || e.message); process.exitCode = 1;
  } finally {
    await browser.close(); server.close(); await pool.end();
  }
})();
