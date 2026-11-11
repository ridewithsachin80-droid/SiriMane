// backend/scripts/check-live.js — Sprint 25
// Proves, from outside the app, that every public hostname answers BEFORE a
// release that touches hostnames, redirects or DNS. (Hotfix 23.2: a redirect
// to a hostname with no DNS record took the site down; the test gate cannot
// see DNS.) Run it from the Railway console, where the network is open:
//
//   node backend/scripts/check-live.js www.sirimane.in sirimane.in
//
// For each host: DNS lookup, then GET https://host/health without following
// redirects. Exit code 1 if any host fails to resolve or returns 5xx.
const dns = require('dns').promises;
const https = require('https');

function get(host) {
  return new Promise(resolve => {
    const req = https.request({ host, path: '/health', method: 'GET', timeout: 8000, headers: { 'User-Agent': 'sirimane-check-live' } }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, body: body.slice(0, 120) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
}

async function check(host) {
  let addrs;
  try { addrs = (await dns.lookup(host, { all: true })).map(a => a.address); }
  catch (e) { return { host, ok: false, note: `DNS: ${e.code || e.message} — nobody can reach this name` }; }
  const r = await get(host);
  if (r.error) return { host, ok: false, note: `resolves to ${addrs.join(', ')} but HTTPS failed: ${r.error}` };
  if (r.status >= 300 && r.status < 400) return { host, ok: true, note: `${r.status} → ${r.location} (make sure THAT host is in this list and answers)`, redirect: r.location };
  return { host, ok: r.status < 500, note: `${r.status} ${r.body.replace(/\s+/g, ' ')}` };
}

(async () => {
  const hosts = process.argv.slice(2);
  if (!hosts.length) { console.log('usage: node backend/scripts/check-live.js <host> [host…]'); process.exit(2); }
  let bad = 0;
  const results = [];
  for (const h of hosts) { const r = await check(h); results.push(r); console.log(`${r.ok ? '✅' : '❌'} ${r.host}: ${r.note}`); if (!r.ok) bad++; }
  // A redirect whose target is not itself checked and healthy is the exact failure of Hotfix 23.2.
  for (const r of results) {
    if (r.redirect) {
      let target; try { target = new URL(r.redirect).hostname; } catch { target = null; }
      const t = results.find(x => x.host === target);
      if (!t) { console.log(`❌ ${r.host} redirects to ${target || r.redirect}, which was not checked — add it to the list`); bad++; }
      else if (!t.ok) { console.log(`❌ ${r.host} redirects to ${target}, which is down`); bad++; }
    }
  }
  console.log(bad ? `\n${bad} problem(s) — do not release until every line is ✅` : '\nAll hosts answer.');
  process.exit(bad ? 1 : 0);
})();
