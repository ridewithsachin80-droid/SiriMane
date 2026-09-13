// backend/test/portal.smoke.js
// Sprint 2 gate for the RESIDENT portal (/guest.html) in headless Chrome at
// 360px and 390px, against the real server + Postgres.
//
//   CHROME_PATH=... DATABASE_URL=... JWT_SECRET=test \
//   NODE_PATH=<dir with puppeteer-core> node backend/test/portal.smoke.js
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
const PHONE = '9000000042';

async function runAtWidth(browser, BASE, width, fixtures) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  const tag = `@${width}`;
  const fits = async (label) => {
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(w <= width + 1, `${tag} ${label}: no sideways scroll (${w}px)`);
  };

  // ── Login ─────────────────────────────────────────────────────────────
  await page.goto(BASE + '/guest', { waitUntil: 'networkidle0' });
  ok(await page.$('#login-section'), `${tag} /guest serves the portal`);
  ok(await page.$('#login-remember'), `${tag} "keep me signed in" offered`);
  eq(await page.$eval('link[rel=manifest]', e => e.getAttribute('href')), '/manifest-guest.json', `${tag} portal uses its own manifest`);
  // Installability: every icon the manifest declares must exist and really be
  // the size it claims (Chrome silently refuses "Add to home screen" otherwise).
  const manifest = await (await fetch(BASE + '/manifest-guest.json')).json();
  ok(manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'), `${tag} manifest declares 192 and 512 icons`);
  for (const icon of manifest.icons) {
    const buf = Buffer.from(await (await fetch(BASE + icon.src)).arrayBuffer());
    eq(buf.subarray(1, 4).toString(), 'PNG', `${tag} ${icon.src} is a PNG`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    eq(`${w}x${h}`, icon.sizes, `${tag} ${icon.src} is really ${icon.sizes}`);
    eq(w, h, `${tag} ${icon.src} is square`);
  }
  ok(manifest.icons.some(i => i.purpose === 'maskable'), `${tag} has a maskable icon for Android`);
  ok(manifest.start_url.startsWith('/guest'), `${tag} start_url opens the portal`);
  await page.type('#login-mobile', PHONE);
  await page.type('#login-password', PHONE);
  await page.click('#login-btn');
  await page.waitForFunction(() => !document.getElementById('portal-section').classList.contains('hidden'), { timeout: 8000 });
  ok(true, `${tag} resident logs in`);
  const headerH = await page.$eval('.header', e => e.getBoundingClientRect().height);
  ok(headerH < 90, `${tag} header compacts after login (${Math.round(headerH)}px)`);
  await page.waitForSelector('.dues-hero', { timeout: 8000 });
  const duesTop = await page.evaluate(() => document.querySelector('.dues-hero').getBoundingClientRect().top);
  ok(duesTop < 520, `${tag} dues visible without scrolling (top ${Math.round(duesTop)}px)`);

  // ── Dues card is first and shows the real balance ─────────────────────
  await page.waitForSelector('.dues-hero .dues-amount', { timeout: 8000 });
  const shown = await page.$eval('.dues-hero .dues-amount', e => e.textContent.trim());
  const expected = '₹' + Math.abs(fixtures.balance).toLocaleString('en-IN');
  eq(shown, expected, `${tag} dues figure matches the ledger`);
  const order = await page.evaluate(() => {
    const hero = document.querySelector('.dues-hero').getBoundingClientRect().top;
    const pay = document.querySelector('.dues-actions')?.getBoundingClientRect().top ?? 1e6;
    return { hero, pay };
  });
  ok(order.hero < order.pay, `${tag} amount appears above the buttons`);
  const btns = await page.$$eval('.dues-actions .btn', els => els.map(e => e.textContent.trim()));
  eq(btns.length, 2, `${tag} Pay via UPI and I've paid sit side by side`);
  const sideBySide = await page.evaluate(() => {
    const [a, b] = document.querySelectorAll('.dues-actions .btn');
    return Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 4;
  });
  ok(sideBySide || width <= 360, `${tag} action buttons share a row`);
  const tapH = await page.$eval('.dues-actions .btn', e => e.getBoundingClientRect().height);
  ok(tapH >= 44, `${tag} buttons are thumb-sized (${Math.round(tapH)}px)`);
  await page.screenshot({ path: path.join(SHOTS, `portal-dues-${width}.png`) });
  await fits('dues');

  // ── Receipt for the last confirmed payment ────────────────────────────
  const downloadDir = path.join(SHOTS, `portal-dl-${width}`); fs.mkdirSync(downloadDir, { recursive: true });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, browserContextId: ctx.id });
  const receiptBtn = await page.$('button[onclick^="downloadGuestReceipt"]');
  ok(receiptBtn, `${tag} last confirmed payment offers a receipt`);
  await page.evaluate(() => document.querySelector('button[onclick^="downloadGuestReceipt"]').click());
  let file = null;
  for (let i = 0; i < 40 && !file; i++) { await sleep(250); file = fs.readdirSync(downloadDir).find(f => f.endsWith('.pdf')); }
  ok(file, `${tag} receipt downloads (${file})`);
  eq(fs.readFileSync(path.join(downloadDir, file)).subarray(0, 4).toString(), '%PDF', `${tag} it is a real PDF, not an error page`);

  // ── WhatsApp the warden ───────────────────────────────────────────────
  const wa = await page.$eval('a[href^="https://wa.me"]', e => e.href).catch(() => null);
  ok(wa && wa.includes('wa.me/919'), `${tag} WhatsApp-to-warden uses the PG number`);
  ok(decodeURIComponent(wa).includes('Room'), `${tag} message pre-fills her room`);

  // ── "I've paid" claim → pending, balance unmoved ──────────────────────
  const before = await page.evaluate(() => guestData.current_balance);
  await page.evaluate(() => claimUpiPayment(100));
  await page.waitForFunction(() => document.body.innerText.includes('waiting for the warden'), { timeout: 8000 });
  ok(true, `${tag} claim shown as awaiting confirmation`);
  const after = await page.evaluate(() => guestData.current_balance);
  eq(after, before, `${tag} MONEY: her balance does not move on a claim`);

  // ── Menu: cards, today first and highlighted (IST) ────────────────────
  await page.evaluate(() => showTab('menu'));
  await page.waitForSelector('.menu-day', { timeout: 8000 });
  const days = await page.$$eval('.menu-day h4', els => els.map(e => e.textContent.trim()));
  const istDay = new Date(Date.now() + (5.5 * 60 + new Date().getTimezoneOffset()) * 60000).toLocaleDateString('en-IN', { weekday: 'long' });
  ok(days[0].startsWith(istDay), `${tag} today (${istDay}) is the first menu card`);
  ok(await page.$eval('.menu-day', e => e.classList.contains('today')), `${tag} today's menu is highlighted`);
  eq(await page.$$eval('table', t => t.length), 0, `${tag} no wide tables left in the portal`);
  await fits('menu');

  // ── Notices ───────────────────────────────────────────────────────────
  await page.evaluate(() => showTab('notices'));
  await page.waitForSelector('.notice-card, #p-notices .card', { timeout: 8000 });
  ok(await page.$('.notice-card'), `${tag} notices render as cards`);
  await fits('notices');

  // ── Complaint → status timeline ───────────────────────────────────────
  // Start clean so "the first card" is unambiguously the one this run raises
  // (the 360px run leaves a resolved issue behind).
  await pool.query('DELETE FROM complaints');
  await page.evaluate(() => showTab('complaint'));
  await page.waitForSelector('#cpg-desc', { timeout: 8000 });
  await page.type('#cpg-desc', `Portal smoke ${width}: light not working`);
  await page.evaluate(() => sendComplaint());
  await page.waitForSelector('.timeline', { timeout: 8000 });
  const steps = await page.evaluate(() => [...document.querySelector('.timeline').querySelectorAll('.t-label')].map(e => e.textContent.trim()));
  eq(steps.join(' → '), 'Raised → In progress → Resolved', `${tag} timeline shows all three stages`);
  eq(await page.$eval('.timeline li', e => e.className), 'current', `${tag} a new issue sits at "Raised"`);
  // Only the newest issue (first card) — earlier runs leave resolved ones behind.
  const firstSteps = () => page.evaluate(() => [...document.querySelector('.timeline').children].map(li => li.className));
  eq((await firstSteps()).filter(c => c.includes('done')).length, 0, `${tag} nothing marked done yet`);
  await page.screenshot({ path: path.join(SHOTS, `portal-complaint-${width}.png`) });
  await fits('complaint');

  // Warden resolves it; the resident sees the note.
  const cid = await page.evaluate(async () => (await (await fetch('/api/guest-complaints', { headers: { Authorization: 'Bearer ' + guestToken } })).json())[0].id);
  await fetch(`${BASE}/api/complaints/${cid}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixtures.adminTok },
    body: JSON.stringify({ status: 'resolved', resolution_notes: 'Tube light replaced' })
  });
  await page.evaluate(() => loadComplaintHistory());
  await page.waitForFunction(() => document.body.innerText.includes('Tube light replaced'), { timeout: 8000 });
  ok(true, `${tag} resolution note reaches the resident`);
  eq((await firstSteps()).filter(c => c.includes('done')).length, 2, `${tag} timeline advances to Resolved`);

  // ── Service worker + session ──────────────────────────────────────────
  const swReady = await page.evaluate(() => navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
  ok(swReady, `${tag} service worker registers`);
  const cachedApi = await page.evaluate(async () => {
    const keys = await caches.keys();
    for (const k of keys) {
      const c = await caches.open(k);
      const reqs = await c.keys();
      if (reqs.some(r => new URL(r.url).pathname.startsWith('/api/'))) return true;
    }
    return false;
  });
  eq(cachedApi, false, `${tag} PRIVACY/MONEY: no API response is ever cached`);
  const remembered = await page.evaluate(() => !!localStorage.getItem('guest_token') && !!localStorage.getItem('guest_expires'));
  ok(remembered, `${tag} "keep me signed in" stores a 30-day session`);
  const days30 = await page.evaluate(() => Math.round((Number(localStorage.getItem('guest_expires')) - Date.now()) / 86400000));
  eq(days30, 30, `${tag} session expiry is 30 days`);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.getElementById('portal-section').classList.contains('hidden'), { timeout: 8000 });
  ok(true, `${tag} still signed in after a reload`);
  // Expired session must not let her back in.
  await page.evaluate(() => localStorage.setItem('guest_expires', String(Date.now() - 1000)));
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  ok(await page.$eval('#portal-section', e => e.classList.contains('hidden')), `${tag} expired session lands back on login`);
  eq(await page.evaluate(() => localStorage.getItem('guest_token')), null, `${tag} expired session is cleared`);

  // ── Sprint 7.1: dark theme in the portal ──────────────────────────────
  const lum = c => { const [r, g, b] = c.match(/\d+/g).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
  await page.evaluate(() => showTab('pay'));
  await page.waitForFunction(() => document.querySelector('.dues-hero') || document.querySelector('#p-pay-content'), { timeout: 10000 });
  ok(await page.$('#p-theme'), `${tag} portal has a theme toggle`);
  await page.evaluate(() => togglePortalTheme());
  await sleep(200);
  const d = await page.evaluate(() => {
    const b = getComputedStyle(document.body), c = getComputedStyle(document.querySelector('.card'));
    return { theme: document.documentElement.getAttribute('data-theme'), bg: b.backgroundColor, text: b.color, card: c.backgroundColor };
  });
  eq(d.theme, 'dark', `${tag} portal toggles to dark`);
  ok(lum(d.bg) < 0.12 && lum(d.card) < 0.15, `${tag} portal surfaces go dark`);
  ok(contrast(d.card, d.text) >= 7, `${tag} portal dark contrast ${contrast(d.card, d.text).toFixed(1)}:1`);
  if (await page.$('.dues-amount')) {
    const dues = await page.$eval('.dues-amount', e => { const c = getComputedStyle(e); return { color: c.color, bg: getComputedStyle(e.closest('.card')).backgroundColor }; });
    ok(contrast(dues.bg, dues.color) >= 3, `${tag} the dues figure stays legible in dark (${contrast(dues.bg, dues.color).toFixed(1)}:1)`);
  }
  if (await page.$('.dues-actions .btn')) {
    const payBtn = await page.$eval('.dues-actions .btn', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
    ok(contrast(payBtn.bg, payBtn.color) >= 4.5, `${tag} Pay via UPI button contrast ${contrast(payBtn.bg, payBtn.color).toFixed(1)}:1`);
  }
  await page.screenshot({ path: path.join(SHOTS, `portal-dark-${width}.png`) });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
  eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark', `${tag} portal theme persists`);
  await page.evaluate(() => togglePortalTheme());
  await sleep(150);
  eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', `${tag} portal toggles back`);

  eq(jsErrors.length, 0, `${tag} no uncaught JS errors (${jsErrors.join('; ')})`);
  await page.close(); await ctx.close();
}

(async () => {
  await pool.query(`TRUNCATE complaints, guest_room_history, checklist_log, collections, guest_rent_history, deposit_refunds, guests, rooms RESTART IDENTITY CASCADE`);
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) })).json();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const post = (p, b) => fetch(BASE + '/api' + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
  const put = (p, b) => fetch(BASE + '/api' + p, { method: 'PUT', headers: H, body: JSON.stringify(b) }).then(r => r.json());
  const room = await post('/rooms', { room_number: 'P1', floor: 1, total_beds: 2, monthly_rent: 6000 });
  const guest = await post('/guests', { name: 'Portal Resident', phone: PHONE, room_id: room.id, bed_number: 1, join_date: '2026-06-01', monthly_rent: 6000, deposit_amount: 12000 });
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  await post('/collections', { guest_id: guest.id, guest_name: guest.name, amount: 6000, collection_date: today, collection_month: 'August 2026', collection_type: 'rent', payment_mode: 'cash' });
  await post('/announcements', { title: 'Water tank cleaning', message: 'Supply off 10am-12pm on Sunday.', priority: 'important' });
  for (const d of ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])
    for (const m of ['Breakfast','Lunch','Dinner'])
      await post('/menu', { day_of_week: d, meal_type: m, items: `${m} for ${d}` }).catch(() => {});
  await put('/settings', { pg_phone: '9880217627', pg_name: 'Siri Mane PG', upi_vpa: 'sirimane@upi', upi_name: 'Siri Mane PG' }).catch(() => {});

  // The portal's own view of the balance is the source of truth for the test.
  const gLogin = await (await fetch(BASE + '/api/guest-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: PHONE, password: PHONE }) })).json();
  const portal = await (await fetch(BASE + '/api/guest-portal', { headers: { Authorization: 'Bearer ' + gLogin.token } })).json();
  const fixtures = { balance: parseFloat(portal.current_balance || 0), adminTok: login.token };

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const w of [360, 390]) { await runAtWidth(browser, BASE, w, fixtures); console.log(`✓ ${w}px`); }
    console.log(`\n✅ Portal gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ Portal gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally { await browser.close(); server.close(); await pool.end(); }
})();
