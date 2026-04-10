// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ─── SECURITY MIDDLEWARE ─────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting - 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

// Stricter limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' }
});

app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);
app.use(express.json({ limit: '10kb' }));

// ─── API ROUTES ──────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/guests', require('./routes/guests'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/expenses', require('./routes/expenses'));

// ─── HEALTH CHECK ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── PUBLIC GUEST SEARCH (no auth needed) ────────
app.get('/api/guest-lookup', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const pool = require('./db');
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.phone, g.is_active, g.join_date,
              g.monthly_rent, g.bed_number, r.room_number
       FROM guests g
       LEFT JOIN rooms r ON g.room_id = r.id
       WHERE g.phone = $1 LIMIT 1`, [phone]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    const guest = result.rows[0];
    const pays = await pool.query(
      `SELECT amount, payment_date, payment_type, payment_mode
       FROM payments WHERE guest_id = $1
       ORDER BY payment_date DESC LIMIT 12`, [guest.id]
    );
    res.json({ ...guest, payments: pays.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVE FRONTEND ──────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Root → landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/home.html'));
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/home.html'));
});

// ─── ERROR HANDLER ───────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Siri Mane server running on port ${PORT}`);
});
