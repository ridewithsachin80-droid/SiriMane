// backend/routes/bulk.js — Sprint 13
//
// POST /bulk/preview { action, ids, args }
//   → the preview (who, what, who is skipped and why) plus a proposal id.
//     Nothing changes. Audited in ai_actions like any Copilot ask.
// POST /bulk/confirm { proposal_id, count }
//   → runs the proposal once through the same confirm path the Copilot uses
//     (single-use, same user, 10-minute expiry). Above ACK_ABOVE the body must
//     carry the eligible count — that is the second confirmation.
// GET  /bulk/limits → the cap and threshold, so the UI never hard-codes them.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const bulk = require('../services/bulk');
const copilot = require('../services/copilot');

const json = express.json({ limit: '20kb' });
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };

router.get('/bulk/limits', auth, (req, res) => res.json({
  cap: bulk.BULK_CAP, ack_above: bulk.ACK_ABOVE,
  actions: Object.entries(bulk.ACTIONS).filter(([k]) => bulk.allowed(k, req.user)).map(([k, a]) => ({ action: k, label: a.label, role: a.role }))
}));

router.post('/bulk/preview', auth, json, wrap(async (req, res) => {
  const { action, ids, args } = req.body || {};
  const t0 = Date.now();
  const p = await bulk.preview({ action, ids, args: args && typeof args === 'object' ? args : {}, user: req.user });
  let proposal = null;
  if (p.eligible.length) {
    const id = crypto.randomUUID();
    const toolArgs = {
      action, ids: p.eligible.map(r => r.id), acknowledged: !p.requires_second_confirm,
      args: { title: p.title, message: p.message, priority: p.priority, assigned_to: p.assigned_to, assignee: p.assignee, doc_type: p.doc_type, status: p.status }
    };
    await pool.query(`INSERT INTO ai_proposals(id, user_id, tool, args, preview_text, expires_at) VALUES($1,$2,'bulk_execute',$3,$4,NOW() + INTERVAL '10 minutes')`,
      [id, req.user.id, toolArgs, p.lines.join('\n')]);
    proposal = { id, tool: 'bulk_execute', expires_in_minutes: 10 };
  }
  await pool.query(`INSERT INTO ai_actions(user_id, request_text, context, interpretation, tools_read, proposal_id, result_text, ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [req.user.id, `bulk:${action}`, { page: 'bulk' }, { tool: 'bulk_execute', via: 'bar', action, selected: p.selected }, ['bulk'], proposal ? proposal.id : null, p.lines.join(' · ').slice(0, 500), Date.now() - t0]).catch(() => {});
  res.json({ ...p, proposal });
}));

router.post('/bulk/confirm', auth, json, wrap(async (req, res) => {
  const { proposal_id, count } = req.body || {};
  if (!/^[0-9a-f-]{36}$/i.test(String(proposal_id || ''))) return res.status(404).json({ error: 'That proposal does not exist.' });
  const r = await pool.query(`SELECT * FROM ai_proposals WHERE id=$1 AND tool='bulk_execute'`, [proposal_id]);
  const p = r.rows[0];
  if (!p) return res.status(404).json({ error: 'That proposal does not exist.' });
  if (String(p.user_id) !== String(req.user.id)) return res.status(403).json({ error: 'That proposal belongs to another user.' });
  const n = (p.args.ids || []).length;
  if (n > bulk.ACK_ABOVE) {
    if (Number(count) !== n) return res.status(409).json({ error: `This touches ${n} ${bulk.ACTIONS[p.args.action]?.noun || 'item'}s — confirm the count to go ahead.`, confirm_count: n, needs_count: true });
    // Record the acknowledgement on the proposal itself, so the execute tool
    // (the only thing that runs it) can insist on it regardless of caller.
    await pool.query(`UPDATE ai_proposals SET args = args || '{"acknowledged": true}'::jsonb WHERE id=$1 AND confirmed_at IS NULL`, [proposal_id]);
  }
  res.json(await copilot.confirm({ user: req.user, proposal_id, authorization: req.headers.authorization, port: req.socket.localPort }));
}));

// Staff need a name list to assign requests to; /users is admin-only and
// carries more than a name. This is id + username, nothing else.
router.get('/staff-list', auth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT id, username, role FROM users ORDER BY role, username`);
  res.json(r.rows);
}));

module.exports = router;
