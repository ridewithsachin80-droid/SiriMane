const jwt = require('jsonwebtoken');
const pool = require('../db');

// ── Tokens are bound to the environment that issued them (Sprint 15, SEC) ──
// Railway copies variables into a new environment, so the Test service can
// end up with production's JWT_SECRET. Every token only carries a user/guest
// id, and each environment looks that id up in its OWN database — so a token
// from the test site (whose admin password is the public default) would be
// accepted by the live site as its user #1. Binding the token to the
// environment id closes that even when the secret is shared.
// Railway sets RAILWAY_ENVIRONMENT_ID itself; locally it is 'local'.
// The id has two parts so it can never silently collapse to one value:
//   1. RAILWAY_ENVIRONMENT_ID (Railway sets it), else APP_ENV, else 'local'
//   2. a short hash of WHICH database this server talks to (host/port/db —
//      not the password, so rotating a password logs nobody out).
// Test and production use different databases, so even if the Railway
// variable were missing on both, their ids still differ. (Review F-04.)
const crypto = require('crypto');
function dbIdentity() {
  try { const u = new URL(process.env.DATABASE_URL || ''); return `${u.hostname}:${u.port || 5432}${u.pathname}`; }
  catch { return 'no-db'; }
}
const ENV_SOURCE = process.env.RAILWAY_ENVIRONMENT_ID ? 'railway' : process.env.APP_ENV ? 'app_env' : 'local';
const ENV_ID = `${process.env.RAILWAY_ENVIRONMENT_ID || process.env.APP_ENV || 'local'}#${crypto.createHash('sha256').update(dbIdentity()).digest('hex').slice(0, 12)}`;
// Tokens without an environment were issued by older code. They are accepted
// ONLY if issued before THIS server process started. Code from Sprint 15 on
// never issues an env-less token, so the set of such tokens is closed: they
// are the ones the previous release handed out, and each expires within 24 h
// (enforced by jwt.verify). Effect: the release logs nobody out, and nothing
// minted after boot without an environment is trusted. (Review F-03, N-1:
// a fixed calendar cut-off would have logged everyone out on a later deploy.)
const LEGACY_CUTOFF = Math.floor(Date.now() / 1000);
function signToken(payload, opts) {
  return jwt.sign({ ...payload, env: ENV_ID }, process.env.JWT_SECRET, opts);
}
// Transition: tokens issued before this release carry no `env` and are still
// accepted until they expire (8–24 h), so nobody is logged out by the deploy.
// A token that names a DIFFERENT environment is always rejected.
function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded && typeof decoded === 'object') {
    if (decoded.env === undefined) {
      if (!(typeof decoded.iat === 'number' && Number.isFinite(decoded.iat) && decoded.iat < LEGACY_CUTOFF)) { const e = new Error('Token without environment, issued after the cut-off'); e.name = 'EnvMismatch'; throw e; }
    } else if (decoded.env !== ENV_ID) {
      const e = new Error('Token from another environment'); e.name = 'EnvMismatch'; throw e;
    }
  }
  return decoded;
}
// ── Sprint 19 (D-17-1): the login lives in an HttpOnly cookie ─────────────
// Page scripts can't read it, so an injected script can no longer copy the
// token anywhere. API clients that send `Authorization: Bearer` (the gates,
// Copilot's internal calls) keep working.
const STAFF_COOKIE = 'sm_staff', GUEST_COOKIE = 'sm_guest';
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}
/** The request's token and how it came: 'header' | 'cookie' | null. */
function tokenFrom(req, cookieName) {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+\S+/.test(h)) return { token: h.split(/\s+/)[1], via: 'header' };
  const c = readCookie(req, cookieName);
  return c ? { token: c, via: 'cookie' } : { token: null, via: null };
}
/** A browser can send a cookie on a forged cross-site request; it cannot add
 *  our own header to one. Writes that ride on the cookie must carry it. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function csrfOk(req, via) {
  return via !== 'cookie' || SAFE.has(req.method) || req.headers['x-requested-with'] === 'sirimane';
}
function setAuthCookie(req, res, name, token, maxAgeMs) {
  res.cookie(name, token, { httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: '/api', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) });
}
/** Review S19-2: the app's own screens (which send X-Requested-With) get the
 *  cookie only — the token stays out of the body so no page script sees it.
 *  API clients (the gates, scripts) still receive it. */
function bodyToken(req, token) { return req.headers['x-requested-with'] === 'sirimane' ? {} : { token }; }
function clearAuthCookie(req, res, name) {
  res.clearCookie(name, { httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: '/api' });
}

const auth = async (req, res, next) => {
  try {
    const { token, via } = tokenFrom(req, STAFF_COOKIE);
    if (!token) return res.status(401).json({ error: 'No token' });
    if (!csrfOk(req, via)) return res.status(403).json({ error: 'Request refused (missing app header).' });
    const decoded = verifyToken(token);
    req.authToken = token;   // for Copilot / bulk internal calls
    // S17-1: a turned-off account stops at its next request. to_jsonb() reads
    // disabled_at if the column exists and NULL if the migration hasn't run yet.
    const result = await pool.query(`SELECT id, username, role, (to_jsonb(u)->>'disabled_at') IS NOT NULL AS off FROM users u WHERE id=$1`, [decoded.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    if (result.rows[0].off) return res.status(401).json({ error: 'This account is turned off — ask the owner.' });
    const { off, ...user } = result.rows[0];
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Use after `auth` in the middleware chain — relies on req.user already being set.
// Staff accounts get 403'd; admin accounts pass through unchanged.
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

auth.requireAdmin = requireAdmin;
auth.signToken = signToken;
auth.verifyToken = verifyToken;
auth.ENV_ID = ENV_ID;
auth.ENV_SOURCE = ENV_SOURCE;
auth.LEGACY_CUTOFF = LEGACY_CUTOFF;
Object.assign(auth, { STAFF_COOKIE, GUEST_COOKIE, tokenFrom, csrfOk, setAuthCookie, clearAuthCookie, bodyToken });
module.exports = auth;
