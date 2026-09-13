// backend/routes/owner.js — Sprint 5. Admin only: the owner's view.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const owner = require('../services/owner');

const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const isYm = s => /^\d{4}-\d{2}$/.test(String(s || ''));
const thisMonth = () => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
async function pgName() { const r = await pool.query(`SELECT value FROM app_settings WHERE key='pg_name'`); return r.rows[0]?.value || 'Siri Mane PG'; }

// GET /owner/report?month=YYYY-MM[&force=1]
router.get('/report', auth, requireAdmin, async (req, res) => {
  const month = isYm(req.query.month) ? req.query.month : thisMonth();
  if (month > thisMonth()) return res.status(400).json({ error: 'That month has not happened yet' });
  try { res.json(await owner.getOwnerReport(month, { force: req.query.force === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/report/pdf', auth, requireAdmin, async (req, res) => {
  const month = isYm(req.query.month) ? req.query.month : thisMonth();
  if (month > thisMonth()) return res.status(400).json({ error: 'That month has not happened yet' });
  try {
    const report = await owner.getOwnerReport(month, { force: req.query.force === '1' });
    await owner.writeOwnerPdf(res, report, await pgName());
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

router.get('/anomalies', auth, requireAdmin, async (req, res) => {
  try { res.json(await owner.computeAnomalies()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /owner/export.zip?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults: this financial year to date)
router.get('/export.zip', auth, requireAdmin, async (req, res) => {
  const isD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const n = new Date(Date.now() + 5.5 * 3600 * 1000);
  const fyStart = `${n.getUTCMonth() >= 3 ? n.getUTCFullYear() : n.getUTCFullYear() - 1}-04-01`;
  const from = isD(req.query.from) ? req.query.from : fyStart;
  const to = isD(req.query.to) ? req.query.to : n.toISOString().slice(0, 10);
  if (from > to) return res.status(400).json({ error: '"from" must be before "to"' });
  try {
    const zip = await owner.buildAccountantZip(from, to);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-export-${from}-to-${to}.zip"`);
    res.end(zip);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

module.exports = router;
