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
// ONLY if issued before this cut-off (7 Nov 2026, 19:30 IST), so an
// environment still running older code cannot mint fresh ones that this code
// trusts. Every token lasts at most 24 h, so after 8 Nov 19:30 IST this branch
// accepts nothing and can be deleted. (Review F-03.)
const LEGACY_CUTOFF = Date.UTC(2026, 10, 7, 14, 0, 0) / 1000;
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
      if (!(decoded.iat < LEGACY_CUTOFF)) { const e = new Error('Token without environment, issued after the cut-off'); e.name = 'EnvMismatch'; throw e; }
    } else if (decoded.env !== ENV_ID) {
      const e = new Error('Token from another environment'); e.name = 'EnvMismatch'; throw e;
    }
  }
  return decoded;
}
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = verifyToken(token);
    const result = await pool.query('SELECT id,username,role FROM users WHERE id=$1', [decoded.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    req.user = result.rows[0];
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
module.exports = auth;
