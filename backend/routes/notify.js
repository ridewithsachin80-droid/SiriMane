// backend/routes/notify.js — Sprint 12
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const notify = require('../services/notify');

const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const json = express.json({ limit: '10kb' });
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

// ── Notifications ────────────────────────────────────────────────────────
router.get('/notifications', auth, wrap(async (req, res) =>
  res.json(await notify.list({ user: req.user, unreadOnly: req.query.unread === '1' }))));

router.post('/notifications/sweep', auth, wrap(async (req, res) => res.json(await notify.sweep())));

router.post('/notifications/:id/read', auth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE notifications SET read_at=NOW(), read_by=$1 WHERE id=$2 AND read_at IS NULL RETURNING id`, [req.user.id, req.params.id]);
  res.json({ success: true, changed: !!r.rows[0] });
}));

router.post('/notifications/read-all', auth, wrap(async (req, res) => {
  const roles = req.user.role === 'admin' ? ['staff', 'admin'] : ['staff'];
  const r = await pool.query(`UPDATE notifications SET read_at=NOW(), read_by=$1 WHERE read_at IS NULL AND for_role = ANY($2) RETURNING id`, [req.user.id, roles]);
  res.json({ success: true, cleared: r.rows.length });
}));

// ── Outbox ───────────────────────────────────────────────────────────────
router.get('/outbox', auth, wrap(async (req, res) => {
  const status = ['draft', 'sent', 'skipped'].includes(req.query.status) ? req.query.status : 'draft';
  const r = await pool.query(`SELECT o.*, u.username AS sent_by_username FROM outbox o LEFT JOIN users u ON u.id=o.sent_by
                               WHERE o.status=$1 ORDER BY o.created_at DESC LIMIT 200`, [status]);
  res.json(r.rows.map(x => ({ ...x, wa_link: notify.waLink(x.phone, x.body) })));
}));

router.post('/outbox/draft', auth, json, wrap(async (req, res) =>
  res.json(await notify.draftOutbox({ kinds: Array.isArray(req.body && req.body.kinds) ? req.body.kinds : undefined }))));

// Marking sent records that the warden opened WhatsApp for this message. The
// app never claims to have delivered anything itself.
router.post('/outbox/:id/sent', auth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE outbox SET status='sent', sent_at=NOW(), sent_by=$1 WHERE id=$2 AND status='draft' RETURNING *`, [req.user.id, req.params.id]);
  if (!r.rows[0]) return res.status(409).json({ error: 'That message is not a draft any more' });
  res.json(r.rows[0]);
}));

router.post('/outbox/:id/skip', auth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE outbox SET status='skipped' WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]);
  if (!r.rows[0]) return res.status(409).json({ error: 'That message is not a draft any more' });
  res.json(r.rows[0]);
}));

// ── Resident documents ───────────────────────────────────────────────────
const DOC_TYPES = ['ID proof', 'Address proof', 'Agreement', 'Deposit receipt'];
const DOC_STATUS = ['verified', 'pending', 'expired'];

router.get('/guests/:id/documents', auth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT * FROM resident_documents WHERE guest_id=$1`, [req.params.id]);
  const have = new Map(r.rows.map(d => [d.doc_type, d]));
  res.json(DOC_TYPES.map(t => have.get(t) || { guest_id: Number(req.params.id), doc_type: t, status: 'pending', expires_on: null, note: null }));
}));

router.put('/guests/:id/documents', auth, json, wrap(async (req, res) => {
  const { doc_type, status, expires_on, note } = req.body || {};
  if (!DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: `doc_type must be one of ${DOC_TYPES.join(', ')}` });
  if (status && !DOC_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const r = await pool.query(`
    INSERT INTO resident_documents(guest_id, doc_type, status, expires_on, note, updated_by, updated_at)
    VALUES($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (guest_id, doc_type) DO UPDATE SET status=EXCLUDED.status, expires_on=EXCLUDED.expires_on, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=NOW()
    RETURNING *`, [req.params.id, doc_type, status || 'pending', expires_on || null, note || null, req.user.id]);
  res.json(r.rows[0]);
}));

// ── Recurring maintenance ────────────────────────────────────────────────
router.get('/maintenance-schedule', auth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT *, (next_due <= CURRENT_DATE) AS due_now FROM maintenance_schedule WHERE is_active=true ORDER BY next_due`);
  res.json(r.rows);
}));

router.post('/maintenance-schedule', auth, requireAdmin, json, wrap(async (req, res) => {
  const { task, vendor, every_days, last_done } = req.body || {};
  if (!task || !String(task).trim()) return res.status(400).json({ error: 'What needs doing?' });
  const days = Math.max(1, Math.min(1095, parseInt(every_days) || 90));
  const r = await pool.query(`INSERT INTO maintenance_schedule(task, vendor, every_days, last_done, next_due)
    VALUES($1,$2,$3,$4::date, COALESCE($4::date, CURRENT_DATE) + ($3::int)) RETURNING *`,
    [String(task).trim().slice(0, 120), (vendor || '').slice(0, 100) || null, days, last_done || null]);
  res.status(201).json(r.rows[0]);
}));

router.post('/maintenance-schedule/:id/done', auth, json, wrap(async (req, res) => {
  const when = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).date || '') ? req.body.date : null;
  const r = await pool.query(`UPDATE maintenance_schedule
      SET last_done = COALESCE($2::date, CURRENT_DATE),
          next_due  = COALESCE($2::date, CURRENT_DATE) + every_days
    WHERE id=$1 AND is_active=true RETURNING *`, [req.params.id, when]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
  res.json(r.rows[0]);
}));

router.delete('/maintenance-schedule/:id', auth, requireAdmin, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE maintenance_schedule SET is_active=false WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
}));

// ── AI metrics ───────────────────────────────────────────────────────────
router.get('/ai-metrics', auth, requireAdmin, wrap(async (req, res) =>
  res.json(await notify.aiMetrics(Math.min(parseInt(req.query.days) || 30, 365)))));

module.exports = router;
