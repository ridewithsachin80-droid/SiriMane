// backend/routes/experience.js — Sprint 11
//
// The resident's side of the app, and what the owner learns from it.
//
// A principle that shapes this whole file: residents are aggregated, never
// scored. Food ratings roll up to a dish and a weekday; complaints and
// ratings roll up to a room or a floor. Nothing here produces a number
// attached to a young woman's name, and the satisfaction card is anonymous by
// construction — the answers table has no guest_id at all.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const routes = require('./index');
const guestAuth = routes.guestAuth;

const requireAdmin = (req, res, next) => req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const json = express.json({ limit: '10kb' });
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => ist().toISOString().slice(0, 10);
const istMonth = () => istToday().slice(0, 7);
const weekday = () => ist().toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
const MEALS = ['Breakfast', 'Lunch', 'Dinner'];

// Notices this resident should see: targeted at everyone, her floor, her room
// or her personally, published and not expired.
function noticeWhere(alias = 'a') {
  return `(${alias}.publish_at IS NULL OR ${alias}.publish_at <= NOW())
      AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > NOW())
      AND (COALESCE(${alias}.target_type,'all') = 'all'
        OR (${alias}.target_type='room' AND ${alias}.target_value = $2)
        OR (${alias}.target_type='floor' AND ${alias}.target_value = $3)
        OR (${alias}.target_type='resident' AND ${alias}.target_value = $1::text))`;
}

async function residentContext(guestId) {
  const r = await pool.query(`SELECT g.id, g.name, g.room_id, g.bed_number, r.room_number, r.floor
                                FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [guestId]);
  const x = r.rows[0] || {};
  return { id: guestId, name: x.name, room_number: x.room_number || null, floor: x.floor == null ? null : String(x.floor) };
}

// ── Portal home: one call ────────────────────────────────────────────────
router.get('/guest-home', guestAuth, wrap(async (req, res) => {
  const c = await residentContext(req.guest.id);
  const today = istToday();
  const [portal, menu, ratings, requests, notices, visitors, satisfied] = await Promise.all([
    pool.query(`SELECT 1`), // placeholder to keep the shape obvious
    pool.query(`SELECT meal_type, items FROM daily_menu WHERE day_of_week=$1`, [weekday()]),
    pool.query(`SELECT meal_type, stars FROM meal_ratings WHERE guest_id=$1 AND rating_date=$2`, [req.guest.id, today]),
    pool.query(`SELECT id, category, status, priority, created_at FROM complaints WHERE guest_id=$1 AND status NOT IN ('resolved','closed') ORDER BY created_at DESC`, [req.guest.id]),
    pool.query(`SELECT a.id, a.title, a.message, a.priority, a.created_at, (r.guest_id IS NOT NULL) AS read
                  FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.guest_id=$1
                 WHERE ${noticeWhere()} ORDER BY a.created_at DESC LIMIT 10`, [req.guest.id, c.room_number, c.floor]),
    pool.query(`SELECT id, visitor_name, status, expected_at FROM visitors WHERE guest_id=$1 AND status IN ('expected','in') ORDER BY expected_at NULLS LAST LIMIT 5`, [req.guest.id]),
    pool.query(`SELECT 1 FROM satisfaction_submitted WHERE guest_id=$1 AND month=$2`, [req.guest.id, istMonth()])
  ]);
  const ratedBy = new Map(ratings.rows.map(r => [r.meal_type, r.stars]));
  res.json({
    resident: c,
    greeting: (() => { const h = ist().getUTCHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })(),
    date: today,
    menu: MEALS.map(m => ({ meal_type: m, items: (menu.rows.find(x => x.meal_type === m) || {}).items || null, my_rating: ratedBy.get(m) || null })),
    open_requests: requests.rows,
    notices: notices.rows,
    unread_notices: notices.rows.filter(n => !n.read).length,
    visitors: visitors.rows,
    satisfaction_due: !satisfied.rows[0]
  });
}));

// ── Meal ratings ─────────────────────────────────────────────────────────
router.post('/guest-meal-rating', guestAuth, json, wrap(async (req, res) => {
  const { meal_type, stars, comment, date } = req.body || {};
  if (!MEALS.includes(meal_type)) return res.status(400).json({ error: 'meal_type must be Breakfast, Lunch or Dinner' });
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) return res.status(400).json({ error: 'Rate between 1 and 5' });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : istToday();
  if (d > istToday()) return res.status(400).json({ error: 'You cannot rate a meal that has not happened' });
  const r = await pool.query(`
    INSERT INTO meal_ratings(guest_id, rating_date, meal_type, stars, comment) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (guest_id, rating_date, meal_type) DO UPDATE SET stars=EXCLUDED.stars, comment=EXCLUDED.comment, created_at=NOW()
    RETURNING id, rating_date, meal_type, stars`, [req.guest.id, d, meal_type, n, (comment || '').slice(0, 120) || null]);
  res.status(201).json(r.rows[0]);
}));

// What the residents think of the food, by dish and by weekday. Staff-visible;
// no resident is named.
router.get('/food-insight', auth, wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 60, 7), 365);
  const [byDish, byDay, recent] = await Promise.all([
    pool.query(`SELECT m.items AS dish, r.meal_type, ROUND(AVG(r.stars)::numeric,1)::float AS avg_stars, COUNT(*)::int AS votes
                  FROM meal_ratings r
                  JOIN daily_menu m ON m.meal_type=r.meal_type AND m.day_of_week=TRIM(TO_CHAR(r.rating_date,'Day'))
                 WHERE r.rating_date >= CURRENT_DATE - ($1||' days')::interval
                 GROUP BY m.items, r.meal_type HAVING COUNT(*) >= 2 ORDER BY AVG(r.stars) DESC`, [days]),
    pool.query(`SELECT TRIM(TO_CHAR(rating_date,'Day')) AS day_of_week, meal_type, ROUND(AVG(stars)::numeric,1)::float AS avg_stars, COUNT(*)::int AS votes
                  FROM meal_ratings WHERE rating_date >= CURRENT_DATE - ($1||' days')::interval
                 GROUP BY 1,2 ORDER BY AVG(stars)`, [days]),
    pool.query(`SELECT comment, stars, meal_type, rating_date FROM meal_ratings
                 WHERE comment IS NOT NULL AND rating_date >= CURRENT_DATE - ($1||' days')::interval
                 ORDER BY rating_date DESC LIMIT 10`, [days])
  ]);
  const worst = byDay.rows[0];
  res.json({
    favourites: byDish.rows.slice(0, 5),
    needs_work: byDish.rows.slice(-5).reverse().filter(d => d.avg_stars < 3.5),
    by_day: byDay.rows,
    comments: recent.rows,
    headline: worst ? `${worst.day_of_week} ${worst.meal_type.toLowerCase()} rates lowest (${worst.avg_stars}★ from ${worst.votes} votes) — worth changing the rotation.` : 'Not enough ratings yet.'
  });
}));

// ── Visitors ─────────────────────────────────────────────────────────────
// A resident registers her own visitor; the warden approves the check-in.
router.post('/guest-visitor', guestAuth, json, wrap(async (req, res) => {
  const { visitor_name, visitor_phone, relation, expected_at } = req.body || {};
  if (!visitor_name || !String(visitor_name).trim()) return res.status(400).json({ error: 'Who is visiting?' });
  const r = await pool.query(`INSERT INTO visitors(guest_id, visitor_name, visitor_phone, relation, expected_at, status)
                              VALUES($1,$2,$3,$4,$5,'expected') RETURNING *`,
    [req.guest.id, String(visitor_name).trim().slice(0, 100), (visitor_phone || '').replace(/\D/g, '').slice(-10) || null,
     (relation || '').slice(0, 40) || null, expected_at || null]);
  res.status(201).json(r.rows[0]);
}));

router.get('/guest-visitors', guestAuth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT id, visitor_name, relation, status, expected_at, checked_in_at, checked_out_at FROM visitors WHERE guest_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.guest.id]);
  res.json(r.rows);
}));

router.get('/visitors', auth, wrap(async (req, res) => {
  const p = []; const where = [];
  if (req.query.status) { p.push(req.query.status); where.push(`v.status=$${p.length}`); }
  if (req.query.today === '1') where.push(`(v.expected_at::date = CURRENT_DATE OR v.checked_in_at::date = CURRENT_DATE)`);
  const r = await pool.query(`SELECT v.*, g.name AS resident_name, rm.room_number
                                FROM visitors v JOIN guests g ON g.id=v.guest_id LEFT JOIN rooms rm ON rm.id=g.room_id
                               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                               ORDER BY v.expected_at NULLS LAST, v.created_at DESC LIMIT 100`, p);
  res.json(r.rows);
}));

router.put('/visitors/:id', auth, json, wrap(async (req, res) => {
  const { action, note } = req.body || {};
  if (!['check_in', 'check_out', 'deny'].includes(action)) return res.status(400).json({ error: 'action must be check_in, check_out or deny' });
  const cur = await pool.query('SELECT * FROM visitors WHERE id=$1', [req.params.id]);
  const v = cur.rows[0];
  if (!v) return res.status(404).json({ error: 'Visitor not found' });
  if (action === 'check_in' && v.status !== 'expected') return res.status(409).json({ error: `That visitor is already ${v.status}` });
  if (action === 'check_out' && v.status !== 'in') return res.status(409).json({ error: 'That visitor is not checked in' });
  const next = action === 'check_in' ? 'in' : action === 'check_out' ? 'out' : 'denied';
  // Every parameter is cast: Postgres cannot infer a type for one used both as
  // a value and inside a CASE comparison.
  const r = await pool.query(`UPDATE visitors SET status=$1::varchar,
      checked_in_at = CASE WHEN $1::varchar='in' THEN NOW() ELSE checked_in_at END,
      checked_out_at = CASE WHEN $1::varchar='out' THEN NOW() ELSE checked_out_at END,
      handled_by=$2::int, note=COALESCE($3::text, note) WHERE id=$4::int RETURNING *`,
    [next, req.user.id, note || null, req.params.id]);
  res.json(r.rows[0]);
}));

// ── Notices: targeting and read receipts ─────────────────────────────────
router.get('/guest-notices', guestAuth, wrap(async (req, res) => {
  const c = await residentContext(req.guest.id);
  const r = await pool.query(`SELECT a.id, a.title, a.message, a.priority, a.created_at, (rd.guest_id IS NOT NULL) AS read
                                FROM announcements a LEFT JOIN announcement_reads rd ON rd.announcement_id=a.id AND rd.guest_id=$1
                               WHERE ${noticeWhere()} ORDER BY a.created_at DESC LIMIT 50`, [req.guest.id, c.room_number, c.floor]);
  res.json(r.rows);
}));

router.post('/guest-notices/:id/read', guestAuth, wrap(async (req, res) => {
  const c = await residentContext(req.guest.id);
  const ok = await pool.query(`SELECT 1 FROM announcements a WHERE a.id=$4 AND ${noticeWhere()}`, [req.guest.id, c.room_number, c.floor, req.params.id]);
  if (!ok.rows[0]) return res.status(404).json({ error: 'Notice not found' });
  await pool.query(`INSERT INTO announcement_reads(announcement_id, guest_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.guest.id]);
  res.json({ success: true });
}));

router.get('/announcements/:id/reads', auth, wrap(async (req, res) => {
  const [total, reads] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE is_active=true`),
    pool.query(`SELECT COUNT(*)::int AS n FROM announcement_reads WHERE announcement_id=$1`, [req.params.id])
  ]);
  res.json({ read: reads.rows[0].n, residents: total.rows[0].n });
}));

// ── Satisfaction: anonymous by construction ──────────────────────────────
router.post('/guest-satisfaction', guestAuth, json, wrap(async (req, res) => {
  const month = istMonth();
  const done = await pool.query('SELECT 1 FROM satisfaction_submitted WHERE guest_id=$1 AND month=$2', [req.guest.id, month]);
  if (done.rows[0]) return res.status(409).json({ error: 'You have already answered this month — thank you' });
  const f = ['cleanliness', 'food', 'safety', 'staff', 'wifi'];
  const vals = f.map(k => { const n = Number((req.body || {})[k]); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; });
  if (vals.every(v => v === null)) return res.status(400).json({ error: 'Rate at least one thing' });
  // Two separate writes, deliberately: the answer carries no resident id, and
  // the record of "she answered" carries no answer.
  await pool.query(`INSERT INTO satisfaction_responses(month, cleanliness, food, safety, staff, wifi, comment) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [month, ...vals, ((req.body || {}).comment || '').slice(0, 300) || null]);
  await pool.query(`INSERT INTO satisfaction_submitted(guest_id, month) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.guest.id, month]);
  res.status(201).json({ success: true, month });
}));

router.get('/satisfaction', auth, requireAdmin, wrap(async (req, res) => {
  const r = await pool.query(`SELECT month, COUNT(*)::int AS responses,
      ROUND(AVG(cleanliness)::numeric,1)::float AS cleanliness, ROUND(AVG(food)::numeric,1)::float AS food,
      ROUND(AVG(safety)::numeric,1)::float AS safety, ROUND(AVG(staff)::numeric,1)::float AS staff,
      ROUND(AVG(wifi)::numeric,1)::float AS wifi,
      ROUND(AVG((COALESCE(cleanliness,0)+COALESCE(food,0)+COALESCE(safety,0)+COALESCE(staff,0)+COALESCE(wifi,0))::numeric
        / NULLIF((CASE WHEN cleanliness IS NULL THEN 0 ELSE 1 END + CASE WHEN food IS NULL THEN 0 ELSE 1 END
        + CASE WHEN safety IS NULL THEN 0 ELSE 1 END + CASE WHEN staff IS NULL THEN 0 ELSE 1 END
        + CASE WHEN wifi IS NULL THEN 0 ELSE 1 END),0)),2)::float AS overall
    FROM satisfaction_responses GROUP BY month ORDER BY month DESC LIMIT 12`);
  const comments = await pool.query(`SELECT month, comment, created_at FROM satisfaction_responses WHERE comment IS NOT NULL ORDER BY created_at DESC LIMIT 20`);
  res.json({ months: r.rows, comments: comments.rows, note: 'Answers are anonymous — they are not linked to any resident.' });
}));

// ── Experience insight: rooms and floors, never people ───────────────────
router.get('/experience-insight', auth, requireAdmin, wrap(async (req, res) => {
  const [byRoom, byFloor, byCategory] = await Promise.all([
    pool.query(`SELECT c.room_number, COUNT(*)::int AS requests, COUNT(DISTINCT c.category)::int AS kinds,
                       STRING_AGG(DISTINCT c.category, ', ') AS categories
                  FROM complaints c WHERE c.room_number IS NOT NULL AND c.created_at >= CURRENT_DATE - 90
                 GROUP BY c.room_number HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC LIMIT 10`),
    pool.query(`SELECT r.floor, COUNT(c.id)::int AS requests
                  FROM complaints c JOIN rooms r ON r.room_number=c.room_number
                 WHERE c.created_at >= CURRENT_DATE - 90 GROUP BY r.floor ORDER BY COUNT(c.id) DESC`),
    pool.query(`SELECT category, COUNT(*)::int AS n FROM complaints WHERE created_at >= CURRENT_DATE - 90 GROUP BY category ORDER BY COUNT(*) DESC LIMIT 5`)
  ]);
  const findings = byRoom.rows.map(r => ({
    room_number: r.room_number, requests: r.requests, categories: r.categories,
    note: r.kinds === 1
      ? `Room ${r.room_number}: ${r.requests} ${r.categories.toLowerCase()} reports in 90 days — the same thing keeps coming back, so check the cause rather than repeating the repair.`
      : `Room ${r.room_number}: ${r.requests} reports across ${r.kinds} kinds (${r.categories}).`
  }));
  res.json({ rooms: findings, floors: byFloor.rows, categories: byCategory.rows, note: 'Grouped by room and floor. Individual residents are never scored.' });
}));

module.exports = router;
