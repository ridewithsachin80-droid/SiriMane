// backend/routes/assistant.js — Sprint 4 HTTP surface for services/assistant.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const A = require('../services/assistant');

// Morning brief for today (cached in ai_reads; ?refresh=1 recomputes)
router.get('/brief', auth, async (req, res) => {
  try { res.json(await A.getBrief({ force: req.query.refresh === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Drafted reminders for everyone who owes rent. Nothing is sent from here —
// the warden opens each wa.me link herself.
router.get('/reminders', auth, async (req, res) => {
  const lang = req.query.lang === 'kn' ? 'kn' : 'en';
  try { res.json(await A.draftReminders(lang)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Log that a reminder was sent (called when the warden taps "Send").
router.post('/reminders/sent', auth, async (req, res) => {
  const { guest_id, text, lang } = req.body || {};
  if (!guest_id) return res.status(400).json({ error: 'guest_id required' });
  try {
    await pool.query(`INSERT INTO reminder_log(guest_id, sent_by, channel, lang, text) VALUES($1,$2,'whatsapp',$3,$4)`,
      [guest_id, req.user.id, lang === 'kn' ? 'kn' : 'en', String(text || '').slice(0, 1000)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ask Siri Mane — read-only, template-matched.
router.post('/ask', auth, async (req, res) => {
  try { res.json(await A.ask(req.body && req.body.question)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
