// backend/routes/rooms-requests.js — Sprint 9
//
// The room and bed map, the maintenance request workflow (owner + clock +
// comments + photos), and each staff member's list for the day.
//
// Photos live in Postgres as bytea. Railway's disk is ephemeral, so a file on
// disk would vanish on the next deploy; an object store is a new paid
// dependency. The client compresses to ≤150 kB before upload and the server
// refuses anything over 200 kB.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');

const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const MAX_PHOTO_BYTES = 200 * 1024;
const SLA_HOURS = { high: 2, medium: 24, low: 72 };
const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];
const ROOM_STATUSES = ['active', 'maintenance', 'blocked'];
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Body parsing is per route, not router-wide: only the photo upload may send
// a megabyte. Anything else keeps the app's ordinary 10 kb ceiling, so this
// router cannot quietly widen the limit for the rest of /api.
const jsonSmall = express.json({ limit: '10kb' });
const jsonPhoto = express.json({ limit: '1mb' });

// ── Room & bed map ────────────────────────────────────────────────────────
// One tile per room, one dot per bed. Bed state is derived from who is in the
// room right now; the room's own condition is the new rooms.status.
router.get('/room-map', auth, async (req, res) => {
  try {
    const [rooms, residents, issues] = await Promise.all([
      pool.query(`SELECT id, room_number, floor, total_beds, room_type, monthly_rent, status, last_inspected FROM rooms WHERE is_active=true ORDER BY floor, room_number`),
      pool.query(`SELECT g.id, g.name, g.room_id, g.bed_number, g.expected_checkout FROM guests g WHERE g.is_active=true`),
      pool.query(`SELECT room_number, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE priority='high')::int AS high FROM complaints WHERE status NOT IN ('resolved','closed') GROUP BY room_number`)
    ]);
    const issueBy = new Map(issues.rows.map(r => [String(r.room_number), r]));
    const floors = {};
    for (const r of rooms.rows) {
      const inRoom = residents.rows.filter(g => String(g.room_id) === String(r.id));
      // A bed is "taken" if someone names it; residents without a bed number
      // still occupy one, so they fill the unnamed beds in order.
      const named = new Map();
      for (const g of inRoom) if (g.bed_number) named.set(String(g.bed_number), g);
      const unplaced = inRoom.filter(g => !g.bed_number);
      const beds = [];
      for (let i = 1; i <= r.total_beds; i++) {
        const key = String(i);
        let who = named.get(key) || null;
        if (!who && unplaced.length) who = unplaced.shift();
        beds.push({ bed: key, state: r.status !== 'active' ? r.status : who ? 'occupied' : 'free', resident: who ? { id: who.id, name: who.name, expected_checkout: who.expected_checkout } : null });
      }
      const iss = issueBy.get(String(r.room_number)) || { n: 0, high: 0 };
      const tile = { ...r, beds, occupied: beds.filter(b => b.state === 'occupied').length, free: beds.filter(b => b.state === 'free').length, open_issues: iss.n, high_issues: iss.high };
      (floors[r.floor] = floors[r.floor] || []).push(tile);
    }
    const list = Object.keys(floors).sort((a, b) => Number(a) - Number(b)).map(f => ({ floor: f, rooms: floors[f] }));
    // The headline must equal what the tiles show: residents who are not in an
    // active room occupy no bed, so they are reported separately rather than
    // silently inflating the count.
    const placed = list.flatMap(f => f.rooms).reduce((t, r) => t + r.occupied, 0);
    const unplaced = residents.rows.filter(g => !rooms.rows.some(r => String(r.id) === String(g.room_id))).length;
    const totals = { beds: rooms.rows.reduce((t, r) => t + r.total_beds, 0), occupied: placed, unplaced };
    totals.free = Math.max(0, totals.beds - placed);
    res.json({ floors: list, totals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/rooms/:id/status', jsonSmall, auth, async (req, res) => {
  const { status, last_inspected } = req.body || {};
  if (status && !ROOM_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${ROOM_STATUSES.join(', ')}` });
  try {
    const occupied = await pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE room_id=$1 AND is_active=true`, [req.params.id]);
    if (status && status !== 'active' && occupied.rows[0].n > 0) {
      return res.status(400).json({ error: `${occupied.rows[0].n} resident${occupied.rows[0].n === 1 ? ' is' : 's are'} still in that room` });
    }
    const r = await pool.query(`UPDATE rooms SET status=COALESCE($1,status), last_inspected=COALESCE($2::date,last_inspected) WHERE id=$3 RETURNING *`,
      [status || null, last_inspected || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Room not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Requests: assignment, SLA, comments, photos ──────────────────────────
function slaFrom(priority, from) {
  const hours = SLA_HOURS[priority] || SLA_HOURS.medium;
  return new Date(new Date(from || Date.now()).getTime() + hours * 3600 * 1000);
}

// GET /requests?status=&assigned_to=me&overdue=1
router.get('/requests', auth, async (req, res) => {
  const p = []; const where = [];
  if (STATUSES.includes(req.query.status)) { p.push(req.query.status); where.push(`c.status=$${p.length}`); }
  else if (req.query.status === 'open') where.push(`c.status NOT IN ('resolved','closed')`);
  if (req.query.assigned_to === 'me') { p.push(req.user.id); where.push(`c.assigned_to=$${p.length}`); }
  else if (req.query.assigned_to) { p.push(Number(req.query.assigned_to)); where.push(`c.assigned_to=$${p.length}`); }
  if (req.query.overdue === '1') where.push(`c.sla_due_at < NOW() AND c.status NOT IN ('resolved','closed')`);
  try {
    const r = await pool.query(`
      SELECT c.*, u.username AS assigned_username,
             (SELECT COUNT(*)::int FROM request_comments rc WHERE rc.complaint_id=c.id) AS comment_count,
             (SELECT COUNT(*)::int FROM request_photos rp WHERE rp.complaint_id=c.id) AS photo_count,
             (c.sla_due_at IS NOT NULL AND c.sla_due_at < NOW() AND c.status NOT IN ('resolved','closed')) AS overdue,
             EXTRACT(EPOCH FROM (c.sla_due_at - NOW()))/3600 AS hours_left
        FROM complaints c LEFT JOIN users u ON u.id=c.assigned_to
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (c.status IN ('resolved','closed')),
                (c.sla_due_at IS NOT NULL AND c.sla_due_at < NOW() AND c.status NOT IN ('resolved','closed')) DESC,
                CASE c.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.created_at`, p);
    res.json(r.rows.map(x => ({ ...x, hours_left: x.hours_left == null ? null : Math.round(x.hours_left * 10) / 10 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/requests/:id', auth, async (req, res) => {
  try {
    const [c, comments, photos] = await Promise.all([
      pool.query(`SELECT c.*, u.username AS assigned_username FROM complaints c LEFT JOIN users u ON u.id=c.assigned_to WHERE c.id=$1`, [req.params.id]),
      pool.query(`SELECT rc.id, rc.body, rc.created_at, u.username, g.name AS guest_name FROM request_comments rc
                    LEFT JOIN users u ON u.id=rc.author_user_id LEFT JOIN guests g ON g.id=rc.author_guest_id
                   WHERE rc.complaint_id=$1 ORDER BY rc.created_at`, [req.params.id]),
      pool.query(`SELECT id, mime_type, bytes, created_at FROM request_photos WHERE complaint_id=$1 ORDER BY id`, [req.params.id])
    ]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json({ request: c.rows[0], comments: comments.rows, photos: photos.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /requests/:id { status?, priority?, assigned_to?, note? }
router.put('/requests/:id', jsonSmall, auth, async (req, res) => {
  const { status, priority, assigned_to, note } = req.body || {};
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const cur = await pool.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    const c = cur.rows[0];
    if (!c) return res.status(404).json({ error: 'Request not found' });
    if (assigned_to) {
      const u = await pool.query(`SELECT id FROM users WHERE id=$1`, [assigned_to]);
      if (!u.rows[0]) return res.status(400).json({ error: 'No such staff member' });
    }
    // Raising the priority shortens the clock; it is always measured from when
    // the request was raised, so nobody can buy time by re-prioritising.
    const newPriority = priority || c.priority || 'medium';
    const sla = priority ? slaFrom(newPriority, c.created_at) : c.sla_due_at;
    // Giving a request an owner takes it out of the unowned pile, whether or
    // not the status dropdown was touched.
    const gainsOwner = assigned_to && String(assigned_to) !== String(c.assigned_to);
    const asked = status || c.status;
    const newStatus = (gainsOwner && asked === 'open') ? 'assigned' : asked;
    const r = await pool.query(`
      UPDATE complaints SET
        status=$1::varchar, priority=$2::varchar, assigned_to=COALESCE($3::int, assigned_to), sla_due_at=$4::timestamp,
        resolution_notes=COALESCE($5::text, resolution_notes),
        resolved_at=CASE WHEN $1::varchar IN ('resolved','closed') THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
        resolved_by=CASE WHEN $1::varchar IN ('resolved','closed') THEN COALESCE(resolved_by, $6::int) ELSE NULL END,
        closed_at=CASE WHEN $1::varchar='closed' THEN COALESCE(closed_at, NOW()) ELSE NULL END,
        updated_at=NOW()
      WHERE id=$7::int RETURNING *`,
      [newStatus, newPriority, assigned_to || null, sla, note || null, req.user.id, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/requests/:id/comments', jsonSmall, auth, async (req, res) => {
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first' });
  if (body.length > 1000) return res.status(400).json({ error: 'Comment is too long' });
  try {
    const c = await pool.query('SELECT id FROM complaints WHERE id=$1', [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Request not found' });
    const r = await pool.query(`INSERT INTO request_comments(complaint_id, author_user_id, body) VALUES($1,$2,$3) RETURNING *`, [req.params.id, req.user.id, body]);
    res.status(201).json({ ...r.rows[0], username: req.user.username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /requests/:id/photos { image: dataURL }
router.post('/requests/:id/photos', jsonPhoto, auth, async (req, res) => {
  const img = String((req.body && req.body.image) || '');
  const m = img.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP data URL' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: `Photo is too large (${Math.round(buf.length / 1024)} kB) — retake it` });
  try {
    const c = await pool.query('SELECT id FROM complaints WHERE id=$1', [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Request not found' });
    const r = await pool.query(`INSERT INTO request_photos(complaint_id, mime_type, bytes, data, uploaded_by_user) VALUES($1,$2,$3,$4,$5) RETURNING id, mime_type, bytes, created_at`,
      [req.params.id, m[1] === 'image/jpg' ? 'image/jpeg' : m[1], buf.length, buf, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/requests/:id/photos/:photoId', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT mime_type, data FROM request_photos WHERE id=$1 AND complaint_id=$2', [req.params.photoId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Photo not found' });
    res.setHeader('Content-Type', r.rows[0].mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(r.rows[0].data);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

router.delete('/requests/:id/photos/:photoId', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM request_photos WHERE id=$1 AND complaint_id=$2 RETURNING id', [req.params.photoId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Photo not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Staff tasks ──────────────────────────────────────────────────────────
// "My day": checklist items assigned to me (or unassigned, which are
// everyone's) plus the requests I own, ordered by what bites first.
router.get('/my-tasks', auth, async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : istToday();
  try {
    const [checks, reqs] = await Promise.all([
      pool.query(`SELECT i.id, i.section, i.time_label, i.due_time, i.task, i.assigned_to, COALESCE(l.is_checked,false) AS is_checked
                    FROM checklist_items i LEFT JOIN checklist_log l ON l.item_id=i.id AND l.log_date=$1
                   WHERE i.is_active=true AND (i.assigned_to IS NULL OR i.assigned_to=$2)
                   ORDER BY i.sort_order, i.id`, [date, req.user.id]),
      pool.query(`SELECT id, category, description, room_number, priority, status, sla_due_at,
                         (sla_due_at IS NOT NULL AND sla_due_at < NOW()) AS overdue,
                         EXTRACT(EPOCH FROM (sla_due_at - NOW()))/3600 AS hours_left
                    FROM complaints WHERE assigned_to=$1 AND status NOT IN ('resolved','closed')
                   ORDER BY (sla_due_at < NOW()) DESC, CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`, [req.user.id])
    ]);
    const mine = checks.rows.filter(c => c.assigned_to === req.user.id);
    res.json({
      date,
      checklist: { mine: mine.length, mineDone: mine.filter(c => c.is_checked).length, items: checks.rows, done: checks.rows.filter(c => c.is_checked).length, total: checks.rows.length },
      requests: reqs.rows.map(r => ({ ...r, hours_left: r.hours_left == null ? null : Math.round(r.hours_left * 10) / 10 })),
      overdue: reqs.rows.filter(r => r.overdue).length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/checklist-items/:id/assign', jsonSmall, auth, requireAdmin, async (req, res) => {
  const { assigned_to, due_time } = req.body || {};
  try {
    if (assigned_to) {
      const u = await pool.query('SELECT id FROM users WHERE id=$1', [assigned_to]);
      if (!u.rows[0]) return res.status(400).json({ error: 'No such staff member' });
    }
    const r = await pool.query(`UPDATE checklist_items SET assigned_to=$1::int, due_time=COALESCE($2,due_time) WHERE id=$3 AND is_active=true RETURNING *`,
      [assigned_to || null, due_time || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.slaFrom = slaFrom;
module.exports.SLA_HOURS = SLA_HOURS;
