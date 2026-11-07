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
const ENV_ID = process.env.RAILWAY_ENVIRONMENT_ID || process.env.APP_ENV || 'local';
function signToken(payload, opts) {
  return jwt.sign({ ...payload, env: ENV_ID }, process.env.JWT_SECRET, opts);
}
// Transition: tokens issued before this release carry no `env` and are still
// accepted until they expire (8–24 h), so nobody is logged out by the deploy.
// A token that names a DIFFERENT environment is always rejected.
function verifyToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded && decoded.env !== undefined && decoded.env !== ENV_ID) {
    const e = new Error('Token from another environment'); e.name = 'EnvMismatch'; throw e;
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
module.exports = auth;
