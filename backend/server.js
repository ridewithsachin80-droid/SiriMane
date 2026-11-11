// Sprint 18 (review): the app's date maths assumes Node runs in UTC (as on
// Railway); India's dates are computed explicitly (services/istdate.js).
process.env.TZ = 'UTC';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PUBLIC = path.join(__dirname, '../frontend/public');

// Required for Railway proxy
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
// ── Content Security Policy (Sprint 17, S17-4) ────────────────────────────
// What a page may load and where it may send data. The app pages (staff and
// resident) may talk only to this server: even if someone slipped a script
// into a page, it could not send the login token or resident data to another
// site (connect-src / img-src / form-action), load code from elsewhere
// (script-src), or show the app inside another site (frame-ancestors).
// 'unsafe-inline' stays because every screen uses inline onclick handlers;
// removing it would mean rewriting them all.
// The public home page also loads Google Analytics — only there, so a script
// on a staff page can't use an analytics account as a way out.
const CSP_BASE = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "script-src-attr": ["'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  "img-src": ["'self'", "data:", "blob:"],
  "media-src": ["'self'", "blob:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"]
};
// Google's published CSP list for Google Analytics with Ads-related features
// (developers.google.com/tag-platform/security/guides/csp). This property is
// linked to a Google Ads account, so gtag also sends to www.google.com/g/collect
// — blocked in production on 9 Nov until these were added. google.co.in is
// India's Google domain (CSP can't wildcard the TLD).
const GA = ["https://www.googletagmanager.com", "https://*.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com",
  "https://*.google.com", "https://*.google.co.in", "https://*.g.doubleclick.net"];
function cspHeader(extra, replace) {
  return Object.entries(CSP_BASE).map(([k, v]) => [k, ...((replace && replace[k]) || v), ...((extra && extra[k]) || [])].join(' ')).join('; ');
}
const CSP_APP = cspHeader();
const CSP_HOME = cspHeader(
  { "script-src": ["https://www.googletagmanager.com"], "connect-src": [...GA, "https://pagead2.googlesyndication.com"], "img-src": GA },
  { "frame-src": ["https://www.googletagmanager.com"] });   // 'none' can't be combined with a host
// Every response gets the strict app policy. Only the handlers that actually
// send home.html (below) switch to the home policy — so no spelling of a URL
// (e.g. /MANAGEMENT, which Express matches case-insensitively) can serve a
// staff or resident page with the looser one. (Review S17-4.)
app.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP_APP); next(); });
const sendHome = (req, res) => { res.setHeader('Content-Security-Policy', CSP_HOME); res.sendFile(path.join(PUBLIC, 'home.html')); };
// Sprint 25: the public hostname is a Railway variable, not code. With
// CANONICAL_HOST unset there is NO hostname redirect at all (the safe default
// after Hotfix 23.2, when a code-level redirect pointed at a hostname with no
// DNS record and took the site down). With CANONICAL_HOST=www.sirimane.in, a
// GET/HEAD for its twin (sirimane.in) is sent to it — the API, which can carry
// a body, is never redirected, and no other host is touched.
// The variable is normalised (scheme, path, case stripped) and logged once, so a mis-set value is visible in Railway logs.
const CANONICAL_HOST = (() => { const v = String(process.env.CANONICAL_HOST || '').trim(); if (!v) return ''; try { return new URL('https://' + v.replace(/^https?:\/\//i, '')).hostname.toLowerCase(); } catch { return ''; } })();
if (process.env.CANONICAL_HOST) console.log(`CANONICAL_HOST: "${process.env.CANONICAL_HOST}" → ${CANONICAL_HOST ? `redirecting ${CANONICAL_HOST.startsWith('www.') ? CANONICAL_HOST.slice(4) : 'www.' + CANONICAL_HOST} → ${CANONICAL_HOST}` : 'INVALID, no redirect'}`);
const CANONICAL_TWIN = CANONICAL_HOST ? (CANONICAL_HOST.startsWith('www.') ? CANONICAL_HOST.slice(4) : 'www.' + CANONICAL_HOST) : '';
app.locals.CANONICAL_HOST = CANONICAL_HOST; app.locals.CANONICAL_TWIN = CANONICAL_TWIN;
app.use((req, res, next) => {   // read from app.locals so the gate can prove both settings in one process
  const canon = app.locals.CANONICAL_HOST, twin = app.locals.CANONICAL_TWIN;
  if (canon && req.hostname === twin && (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api')) return res.redirect(301, 'https://' + canon + req.originalUrl);
  next();
});
// The app screens are for residents and staff — never a search result.
app.use((req, res, next) => {
  if (/^\/(guest|management)\.html$/i.test(req.path) || req.path.startsWith('/api')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.locals.CSP_APP = CSP_APP; app.locals.CSP_HOME = CSP_HOME;   // for the gates
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// Global limit: 2,000 requests / 15 min per IP. Raised again in Sprint 12 —
// the bell polls, Home is one call but every screen refreshes, and a whole PG
// sits behind one office IP. This is a brake on abuse, not on work.
// Login attempts are limited separately below (10 / 15 min).
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false
}));

// Login-specific limit: 10 attempts / 15 min per IP, on top of the global one,
// so a password can't be guessed 200 times. Only failed-or-not attempts count
// (skipSuccessfulRequests) — a warden who logs in normally is never blocked.
// Sprint 16 (S16-3): staff and residents get SEPARATE counters. On the PG's
// shared Wi-Fi every phone has the same public address, so residents' typos
// used to lock the warden out (and the other way round).
// Client address = req.ip (trust proxy 1). Verified on production 8 Nov:
// from the internet, a forged X-Forwarded-For does NOT change it (12 tries
// with 12 forged addresses were counted together and blocked at the 11th).
// Only requests from inside Railway's own network can set it. X-Real-IP was
// tried in 16.2 and removed in 16.2.1 — not proven per-client.
const makeLoginLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // S17-1 review: a turned-off account with the RIGHT password (403) is not a guess
  requestWasSuccessful: (req, res) => res.statusCode < 400 || res.statusCode === 403,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});
app.use('/api/auth/login', makeLoginLimiter());
app.use('/api/guest-login', makeLoginLimiter());

// Sprint 19 (review): a resident's password hash never leaves the server — not
// even to staff (several staff routes select guests.* / RETURNING *). One
// filter on every API response, so a future route can't leak it either.
function stripSecrets(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== 'object' || v instanceof Date || Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map(x => stripSecrets(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) if (k !== 'password_hash') out[k] = stripSecrets(v[k], depth + 1);
  return out;
}
app.use('/api', (req, res, next) => { const j = res.json.bind(res); res.json = body => j(stripSecrets(body)); next(); });
app.locals.stripSecrets = stripSecrets;

// AI routes parse their own (larger) JSON body — mounted before the global
// 10 kb parser so a bill photo is accepted there and nowhere else.
app.use('/api/ai', require('./routes/ai'));
// Request photos need a larger body than the global 10 kb limit.

app.use('/api', require('./routes/rooms-requests'));

app.use(express.json({ limit: '10kb' }));

// Sprint 16.2 (S16.2-1): a per-ACCOUNT limit as well, which no forged address
// can dodge. 10 wrong passwords for one resident's number (20 for a staff
// username — harder to lock the admin out on purpose) in 15 minutes pauses
// that account for the rest of the window. Correct logins never count.
// Mounted after the JSON parser because the key comes from the body.
const accountLimiter = (max, keyOf, who) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode < 400 || res.statusCode === 403,   // S17-1 review
  keyGenerator: (req) => keyOf(req.body || {}),
  // S16.3-4: when a pause trips, put it on the bell (once per account per
  // window) so the warden/admin knows someone is guessing.
  handler: (req, res, next, options) => {
    try {
      const key = keyOf(req.body || {});
      const win = Math.floor(Date.now() / options.windowMs);
      const resident = key.startsWith('g:');
      const label = resident ? `a resident number ending ${key.slice(-4)}` : `staff login "${key.slice(2, 32)}"`;
      // S16.4-2: only for an account that really exists — otherwise anyone
      // could plant text on the admin's bell by typing made-up usernames.
      const pool = require('./db');
      const exists = resident
        ? pool.query(`SELECT 1 FROM guests WHERE is_active = true AND right(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $1 LIMIT 1`, [key.slice(2)])
        : pool.query('SELECT 1 FROM users WHERE lower(username) = $1 LIMIT 1', [key.slice(2)]);
      exists.then(r => r.rows.length && require('./services/notify').push({
        level: 'important', category: 'system',
        title: `Login paused for ${label}`,
        detail: `${max} wrong passwords in 15 minutes. If it wasn't her/them, someone may be guessing. The pause lifts on its own.`,
        action_page: resident ? 'guests' : 'admin', for_role: resident ? 'staff' : 'admin',
        dedupe_key: `lockout:${key.slice(0, 40)}:${win}`
      })).catch(() => {});
    } catch (e) { /* the alert is best-effort; the pause itself always applies */ }
    res.status(options.statusCode).json(options.message);
  },
  message: { error: `Too many wrong passwords for this ${who}. It is paused for up to 15 minutes — try again later, or ask the warden.` }
});
app.use('/api/guest-login', accountLimiter(10, b => 'g:' + String(b.mobile || '').replace(/\D/g, '').slice(-10), 'number'));
app.use('/api/auth/login', accountLimiter(20, b => 'u:' + String(b.username || '').trim().toLowerCase(), 'username'));

app.use('/api', require('./routes/index'));
app.use('/api/assistant', require('./routes/assistant'));
app.use('/api/owner', require('./routes/owner'));
app.use('/api/copilot', require('./routes/copilot'));
app.use('/api', require('./routes/home'));
app.use('/api', require('./routes/finance'));
app.use('/api', require('./routes/experience'));
app.use('/api', require('./routes/notify'));
app.use('/api', require('./routes/bulk'));       // Sprint 13

// Any /api path that no route claimed answers with JSON — never the landing
// page. (Before this, a missing route returned home.html and the app showed
// "Unexpected token '<'".)
app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));

// /health also reports whether every migration this build needs has been run
// (checked at startup and re-checked every 10 minutes) — so Admin can show a
// banner instead of individual screens failing with "relation does not exist".
const schemaCheck = require('./services/schema-check');
app.get('/health', (req, res) => {
  const s = schemaCheck.lastResult();
  res.json({ status: 'ok', time: new Date().toISOString(), schema: s.ok === null ? 'unchecked' : (s.ok ? 'ok' : 'missing'), schemaMissing: s.missing, schemaCheckedAt: s.checkedAt });
});

app.get('/home.html', sendHome);   // before static, so it gets the home policy
app.use(express.static(PUBLIC));

// Root
app.get('/', sendHome);

// Guest portal
app.get('/siri-mane-guest-portal', (req, res) => res.sendFile(path.join(PUBLIC, 'guest.html')));
app.get('/guest', (req, res) => res.sendFile(path.join(PUBLIC, 'guest.html')));

// Management (the file is management.html — there is no index.html)
app.get('/siri-mane-management', (req, res) => res.sendFile(path.join(PUBLIC, 'management.html')));
app.get('/management', (req, res) => res.sendFile(path.join(PUBLIC, 'management.html')));

// Catch-all for the public site
app.get('*', sendHome);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (!err.type || !String(err.type).startsWith('entity.')) console.error(err.stack);
  // Malformed JSON body → 400 with a readable message, not a 500.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ Siri Mane server running on port ${PORT}`));
  // Review F-04: say at boot which environment tokens are bound to.
  { const a = require('./middleware/auth'); console.log(`🔐 login tokens bound to environment ${a.ENV_ID.split('#')[0]} (source: ${a.ENV_SOURCE})`); }
  // Sprint 4: compute the morning brief once a day at the time in Settings
  // (default 07:00 IST). Runs inside this process — no extra Railway service.
  require('./services/assistant').startScheduler();
  require('./services/owner').startScheduler();
  require('./services/copilot').startEveningScheduler();
  require('./services/notify').startScheduler();
  schemaCheck.checkSchema().then(schemaCheck.logResult).catch(e => console.error('schema check failed:', e.message));
  setInterval(() => schemaCheck.checkSchema().catch(() => {}), 10 * 60 * 1000).unref();
}
module.exports = app;
