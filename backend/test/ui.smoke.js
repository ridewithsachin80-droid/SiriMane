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
  await page.waitForSelector('#page-content .stat-card', { timeout: 10000 });
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
    // Register a fake page through navigate's table by monkey-patching pgDashboard temporarily
    window.__origDash = window.pgDashboard; window.pgDashboard = window.pgBroken; navigate('dashboard');
  });
  await page.waitForFunction(() => document.body.innerText.includes('This screen could not load'), { timeout: 5000 });
  ok(true, `${tag} error boundary shows retry card instead of blank page`);
  ok(await page.evaluate(() => document.body.innerText.includes('boom from screen')), `${tag} boundary shows the error message`);
  await page.evaluate(() => { window.pgDashboard = window.__origDash; });
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
  ok(tabs.join('|').includes('Collect'), `${tag} Collect tab present`);
  ok(await page.$eval('.sm-tabbar', e => getComputedStyle(e).display === 'grid'), `${tag} tab bar visible on phone`);
  const tabH = await page.$eval('.sm-tab', e => e.getBoundingClientRect().height);
  ok(tabH >= 44, `${tag} tab targets ≥44px (${Math.round(tabH)}px)`);
  await page.evaluate(() => navigate('guests'));
  await page.waitForFunction(() => document.querySelector('#page-content table.sm-cards tbody tr'), { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, `guests-cards-${width}.png`) });
  ok(await page.$eval('.sm-fab', e => e.classList.contains('sm-fab-on')), `${tag} Collect FAB shown on Guests`);
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
  await page.evaluate(() => document.getElementById('sm-fab').click());
  await page.waitForSelector('#collect-people .sm-person', { timeout: 8000 });
  ok(true, `${tag} FAB opens Collect`);
  await page.screenshot({ path: path.join(SHOTS, `collect-${width}.png`) });
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
    console.error(`\n❌ UI gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally {
    await browser.close(); server.close(); await pool.end();
  }
})();
