// backend/routes/finance.js — Sprint 10
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const finance = require('../services/finance');

const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

// Reliability shapes the reminder order, so staff may read it; the money
// KPIs and forecasts are the owner's view.
router.get('/finance/reliability', auth, wrap(async (req, res) => res.json(await finance.computeReliability())));
router.get('/finance/forecast', auth, requireAdmin, wrap(async (req, res) => res.json({
  collections: await finance.collectionForecast(req.query.month), occupancy: await finance.occupancyForecast()
})));
router.get('/finance/expenses', auth, requireAdmin, wrap(async (req, res) => res.json(await finance.expenseInsight())));
router.get('/finance/kpis', auth, requireAdmin, wrap(async (req, res) => res.json(await finance.kpis(req.query.month))));

router.get('/finance/overview', auth, requireAdmin, wrap(async (req, res) => {
  const month = req.query.month;
  // Same shape as /finance/forecast, so a caller can use either without
  // learning two formats.
  const [k, collections, occupancy, e, closing] = await Promise.all([
    finance.kpis(month), finance.collectionForecast(month), finance.occupancyForecast(), finance.expenseInsight(), finance.getDayClosing(istToday())
  ]);
  res.json({ kpis: k, forecast: { collections, occupancy }, expenses: e, today: closing });
}));

// Day closing: read-only over collections, writes only its own record.
router.get('/day-closing', auth, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : istToday();
  res.json(await finance.getDayClosing(date));
}));
router.post('/day-closing', auth, express.json({ limit: '10kb' }), wrap(async (req, res) => {
  const { date, counted, note } = req.body || {};
  res.json(await finance.closeDay({ date: date || istToday(), counted, note, user: req.user }));
}));
router.post('/day-closing/reopen', auth, requireAdmin, express.json({ limit: '10kb' }), wrap(async (req, res) => {
  res.json(await finance.reopenDay({ date: (req.body && req.body.date) || istToday(), user: req.user }));
}));
router.get('/finance/variances', auth, requireAdmin, wrap(async (req, res) => {
  const pool = require('../db');
  const r = await pool.query(`SELECT v.*, u.username FROM collection_variances v LEFT JOIN users u ON u.id=v.created_by ORDER BY v.close_date DESC, v.id DESC LIMIT 100`);
  res.json(r.rows);
}));

module.exports = router;
