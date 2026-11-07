// backend/test/xss.smoke.js — Sprint 15.2 security gate (S15.2-7)
//
// Text written by people who are NOT trusted staff must never become HTML on a
// staff screen. Two such writers exist:
//   · anyone on the internet — POST /api/guest-message needs no login
//   · residents — complaints, visitors, meal comments, monthly survey
// This gate plants a booby-trapped value through every one of those doors,
// then opens every management screen (and the sheets that show this text) in
// headless Chrome. If the payload ever becomes a real element, or its
// onerror handler ever runs, the gate fails and names the screen.
//
//   CHROME_PATH=... DATABASE_URL=... JWT_SECRET=test NODE_PATH=<puppeteer-core> \
//   node backend/test/xss.smoke.js
const assert = require('assert');
const puppeteer = require('puppeteer-core');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const CHROME = process.env.CHROME_PATH;
if (!CHROME) { console.error('CHROME_PATH is required'); process.exit(1); }

const app = require('../server');
const pool = require('../db');

let count = 0;
const ok = (c, m) => { assert.ok(c, m); count++; };

// Breaks out of text, attribute (" and ') and JS-string contexts, and the
// &quot; variant defeats code that only replaces " before an onclick.
const P = (tag) => `x${tag}"'&quot;><img src=x data-xss="${tag}" onerror="window.__xss=(window.__xss||[]).concat('${tag}')">`;
// Short columns (phone 15, room 20, category 50, relation 40): an element
// marker that still proves HTML injection. Real attackers fit in 20 chars too.
const SH = (t) => `<b data-xss=${t}>`;

(async () => {
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const j = (r) => r.json();
  const login = await j(await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'SiriMane@2024' }) }));
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const post = (p, b, h = H) => fetch(BASE + '/api' + p, { method: 'POST', headers: h, body: JSON.stringify(b) });

  // A room and a resident (staff-created, so trusted text)
  const room = await j(await post('/rooms', { room_number: 'X1', floor: 1, total_beds: 2, monthly_rent: 6000 }));
  const phone = '9' + String(Date.now()).slice(-9);
  const guest = await j(await post('/guests', { name: 'Xss Resident', phone, room_id: room.id, bed_number: 1, join_date: '2026-06-01', monthly_rent: 6000, deposit_amount: 1000 }));
  ok(guest.id, 'fixture resident created');

  // 1 · Anonymous door: no Authorization header at all
  const anon = await post('/guest-message', { guest_name: SH('inbox-name'), guest_phone: SH('ph'), room_number: SH('room'), subject: P('inbox-subject'), message: P('inbox-message') }, { 'Content-Type': 'application/json' });
  ok(anon.status === 200, `anonymous message accepted (${anon.status}) — this door is public by design`);

  // 2 · Resident doors
  const gl = await j(await post('/guest-login', { mobile: phone, password: phone }, { 'Content-Type': 'application/json' }));
  ok(gl.token, 'resident can log in');
  const GH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + gl.token };
  const c1 = await post('/guest-complaint', { category: `"'><b data-xss=cat>`, description: P('complaint-description') }, GH);
  ok(c1.status === 201, `resident complaint stored (${c1.status})`);
  const complaint = await j(c1);
  ok((await post('/guest-visitor', { visitor_name: SH('visitor-name'), relation: SH('relation') }, GH)).status === 201, 'resident visitor stored');
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  ok((await post('/guest-meal-rating', { meal_type: 'Lunch', stars: 2, comment: P('meal-comment'), date: today }, GH)).status < 300, 'resident meal comment stored');
  ok((await post('/guest-satisfaction', { food: 2, comment: P('survey-comment') }, GH)).status === 201, 'resident survey comment stored');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto(BASE + '/management', { waitUntil: 'networkidle0' });
    await page.type('#login-username', 'admin');
    await page.type('#login-password', process.env.ADMIN_PASSWORD || 'SiriMane@2024');
    await page.click('#login-btn');
    await page.waitForSelector('.home-greeting', { timeout: 15000 });

    const settle = () => page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
    const check = async (where) => {
      await settle();
      const r = await page.evaluate(() => ({ ran: window.__xss || [], els: [...document.querySelectorAll('[data-xss]')].map(e => e.getAttribute('data-xss')) }));
      const clean = r.ran.length === 0 && r.els.length === 0;
      if (clean) count++;
      else failures.push(`${where} (ran: ${[...new Set(r.ran)].join(',') || 'none'}; injected: ${[...new Set(r.els)].join(',') || 'none'})`);
      // Clear so the next screen is judged on its own
      await page.evaluate(() => { window.__xss = []; document.querySelectorAll('[data-xss]').forEach(e => e.remove()); });
    };
    const failures = [];

    // Every page the router knows
    const pages = await page.evaluate(() => {
      const src = navigate.toString(); const m = src.match(/const pages = \{([^}]*)\}/);
      return m ? m[1].split(',').map(s => s.split(':')[0].trim().replace(/'/g, '')).filter(Boolean) : [];
    });
    ok(pages.length >= 20, `found the router's page list (${pages.length})`);
    for (const p of pages) {
      await page.evaluate(pg => navigate(pg), p);
      await check(`page "${p}"`);
    }
    // Each inbox message opened
    await page.evaluate(() => navigate('inbox')); await settle();
    const nInbox = await page.$$eval('.inbox-item', els => els.length);
    // Injected quotes can break the list markup itself, so a missing row is a finding too
    if (nInbox < 1) failures.push('inbox: the anonymous message row did not render (markup broken by its text)');
    else count++;
    const msgs = await page.evaluate(() => apiFetch('/inbox'));
    ok(Array.isArray(msgs) && msgs.length >= 1, 'the anonymous message is in the inbox data');
    for (let i = 0; i < msgs.length; i++) {
      await page.evaluate(m => viewInboxMsg(m), msgs[i]);
      await check(`inbox message #${i + 1} opened`);
      await page.evaluate(() => closeModal());
    }
    // The request sheet for the resident's complaint
    await page.evaluate(id => requestSheet(id), complaint.id);
    await check('request sheet');
    await page.evaluate(() => closeModal());
    // Resident 360, every tab
    await page.evaluate(id => residentProfile(id), guest.id); await settle();
    for (const t of await page.evaluate(() => R360_TABS.map(x => x.id))) {
      await page.evaluate(id => { r360.tab = id; renderResident360(); }, t);
      await check(`Resident 360 tab "${t}"`);
    }
    await page.evaluate(() => closeModal());
    // Room 360, every tab
    await page.evaluate(id => roomProfile(id), room.id); await settle();
    for (const t of await page.evaluate(() => ROOM360_TABS.map(x => x.id))) {
      await page.evaluate(id => { room360.tab = id; renderRoom360(); }, t);
      await check(`Room 360 tab "${t}"`);
    }
    await page.evaluate(() => closeModal());
    // Universal search
    await page.evaluate(() => openSearch());
    await page.type('#search-q', 'xcomplaint');
    await new Promise(r => setTimeout(r, 900));
    await check('search results');
    await page.evaluate(() => closeSearch());
    // Copilot answers that list requests
    await page.evaluate(() => navigate('dashboard')); await settle();
    await page.evaluate(() => copilotAsk('show open requests')).catch(() => {});
    await check('Copilot answer');
    ok(failures.length === 0, `SECURITY: untrusted text became HTML on ${failures.length} screen(s):\n  - ${failures.join('\n  - ')}`);
    ok(dialogs.length === 0, `no alert/confirm dialogs were triggered (${dialogs.join(' | ')})`);
    console.log(`\n✅ XSS gate passed — ${count} assertions`);
  } catch (e) {
    console.error(`\n❌ XSS gate FAILED after ${count} assertions:\n`, e.message); process.exitCode = 1;
  } finally {
    await browser.close(); server.close(); await pool.end();
  }
})();
