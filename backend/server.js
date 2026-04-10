require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 200 }));
app.use(express.json({ limit: '10kb' }));

app.use('/api', require('./routes/index'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use(express.static(path.join(__dirname, '../frontend/public')));

// Root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/home.html')));

// Guest portal - old Firebase URL + new short URLs
app.get('/siri-mane-guest-portal', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/guest.html')));
app.get('/guest', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/guest.html')));

// Management - old Firebase URL + new short URLs
app.get('/siri-mane-management', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));
app.get('/management', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

// Catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/public/home.html')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Siri Mane server running on port ${PORT}`));
