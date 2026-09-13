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
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// Global limit: 600 requests / 15 min per IP. Raised from 200 in Sprint 6 —
// the Copilot bar, brief and attention card make the app chattier, and a
// warden working through a busy morning was within reach of the old cap.
// Login attempts are limited separately below (10 / 15 min).
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
}));

// Login-specific limit: 10 attempts / 15 min per IP, on top of the global one,
// so a password can't be guessed 200 times. Only failed-or-not attempts count
// (skipSuccessfulRequests) — a warden who logs in normally is never blocked.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/guest-login', loginLimiter);

// AI routes parse their own (larger) JSON body — mounted before the global
// 10 kb parser so a bill photo is accepted there and nowhere else.
app.use('/api/ai', require('./routes/ai'));
// Request photos need a larger body than the global 10 kb limit.
app.use('/api', require('./routes/rooms-requests'));

app.use(express.json({ limit: '10kb' }));

app.use('/api', require('./routes/index'));
app.use('/api/assistant', require('./routes/assistant'));
app.use('/api/owner', require('./routes/owner'));
app.use('/api/copilot', require('./routes/copilot'));
app.use('/api', require('./routes/home'));
app.use('/api', require('./routes/finance'));

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

app.use(express.static(PUBLIC));

// Root
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'home.html')));

// Guest portal
app.get('/siri-mane-guest-portal', (req, res) => res.sendFile(path.join(PUBLIC, 'guest.html')));
app.get('/guest', (req, res) => res.sendFile(path.join(PUBLIC, 'guest.html')));

// Management (the file is management.html — there is no index.html)
app.get('/siri-mane-management', (req, res) => res.sendFile(path.join(PUBLIC, 'management.html')));
app.get('/management', (req, res) => res.sendFile(path.join(PUBLIC, 'management.html')));

// Catch-all for the public site
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'home.html')));

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
  // Sprint 4: compute the morning brief once a day at the time in Settings
  // (default 07:00 IST). Runs inside this process — no extra Railway service.
  require('./services/assistant').startScheduler();
  require('./services/owner').startScheduler();
  require('./services/copilot').startEveningScheduler();
  schemaCheck.checkSchema().then(schemaCheck.logResult).catch(e => console.error('schema check failed:', e.message));
  setInterval(() => schemaCheck.checkSchema().catch(() => {}), 10 * 60 * 1000).unref();
}
module.exports = app;
