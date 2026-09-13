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

// Global limit: 200 requests / 15 min per IP (unchanged).
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
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

app.use(express.json({ limit: '10kb' }));

app.use('/api', require('./routes/index'));

// Any /api path that no route claimed answers with JSON — never the landing
// page. (Before this, a missing route returned home.html and the app showed
// "Unexpected token '<'".)
app.use('/api', (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

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
}
module.exports = app;
