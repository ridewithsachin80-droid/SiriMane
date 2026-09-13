// backend/routes/copilot.js — Sprint 6
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const copilot = require('../services/copilot');
const tools = require('../services/tools');

// POST /copilot/ask { text, context:{ page, resident_id, resident_name, room_number } }
router.post('/ask', auth, async (req, res) => {
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  const ctx = req.body.context && typeof req.body.context === 'object' ? {
    page: String(req.body.context.page || '').slice(0, 40),
    resident_id: req.body.context.resident_id ? Number(req.body.context.resident_id) : undefined,
    resident_name: req.body.context.resident_name ? String(req.body.context.resident_name).slice(0, 80) : undefined,
    room_number: req.body.context.room_number ? String(req.body.context.room_number).slice(0, 20) : undefined
  } : null;
  try {
    res.json(await copilot.ask({ user: req.user, text, context: ctx, authorization: req.headers.authorization, port: req.socket.localPort }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /copilot/confirm { proposal_id }
router.post('/confirm', auth, async (req, res) => {
  const id = req.body && req.body.proposal_id;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'proposal_id is required' });
  try {
    res.json(await copilot.confirm({ user: req.user, proposal_id: id, authorization: req.headers.authorization, port: req.socket.localPort }));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// GET /copilot/brief   — Siri's Brief v2 for this user's role
router.get('/brief', auth, async (req, res) => {
  try { res.json(await copilot.briefV2({ user: req.user, force: req.query.force === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /copilot/evening
router.get('/evening', auth, async (req, res) => {
  try { res.json(await copilot.eveningSummary({ force: req.query.force === '1' })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /copilot/tools — what this user may ask for (drives the chips)
router.get('/tools', auth, (req, res) => res.json({ model: copilot.modelAvailable(), tools: tools.catalogue(req.user).map(t => ({ name: t.name, level: t.level })) }));

module.exports = router;
