// backend/routes/home.js — Sprint 7
//
// GET /home — everything the Home screen shows, in ONE request (patchy 4G).
// The payload follows the information hierarchy the review asks for:
//   brief → attention → recommendations → today → finance (admin) →
//   occupancy → upcoming.
// Role matters: a staff user never receives expense, profit or owner-level
// figures. That is enforced here, not in the UI.
//
// GET /search?q= — residents, rooms, payments (by receipt no.) and requests
// in one call, for the topbar search and Ctrl+K.
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const pool = require('../db');
const routes = require('./index');
const copilot = require('../services/copilot');
const owner = require('../services/owner');

const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

router.get('/home', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const today = istToday();
    const brief = await copilot.briefV2({ user: req.user });
    const f = brief.facts;

    const [arrivals, departures, menu, checklistDone, checklistTotal, highRequests, dueToday, monthMoney] = await Promise.all([
      pool.query(`SELECT g.id, g.name, r.room_number, g.bed_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.join_date=$1 ORDER BY g.name`, [today]),
      pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.leave_date=$1 ORDER BY g.name`, [today]),
      pool.query(`SELECT meal_type, items FROM daily_menu WHERE day_of_week=$1`, [new Date(Date.now() + 5.5 * 3600 * 1000).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' })]),
      pool.query(`SELECT COUNT(*)::int AS n FROM checklist_log l JOIN checklist_items i ON i.id=l.item_id AND i.is_active=true WHERE l.log_date=$1 AND l.is_checked=true`, [today]),
      pool.query(`SELECT COUNT(*)::int AS n FROM checklist_items WHERE is_active=true`),
      pool.query(`SELECT id, category, description, room_number, priority, created_at FROM complaints WHERE status<>'resolved' AND priority='high' ORDER BY created_at LIMIT 5`),
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1`, [today]),
      isAdmin ? pool.query(`SELECT
            (SELECT COALESCE(SUM(amount),0) FROM collections WHERE is_deleted=false AND status='confirmed' AND date_trunc('month', collection_date)=date_trunc('month', $1::date))::float AS income,
            (SELECT COALESCE(SUM(amount),0) FROM purchases   WHERE is_deleted=false AND status='confirmed' AND date_trunc('month', purchase_date)=date_trunc('month', $1::date))::float AS expenses`, [today]) : Promise.resolve({ rows: [] })
    ]);

    const payload = {
      date: today,
      user: { username: req.user.username, role: req.user.role },
      brief: { greeting: brief.greeting, dateLabel: brief.dateLabel, health: brief.health, changed: brief.changed, text: brief.text, computed_at: brief.computed_at, cached: brief.cached },
      attention: brief.attention,
      recommendations: brief.recommendations,
      today: {
        arrivals: arrivals.rows,
        departures: departures.rows,
        rentDue: { count: f.rentDue.count, total: f.rentDue.total },
        collectedToday: dueToday.rows[0],
        highRequests: highRequests.rows,
        openRequests: f.complaints.open,
        checklist: { done: checklistDone.rows[0].n, total: checklistTotal.rows[0].n },
        menu: Object.fromEntries(menu.rows.map(m => [m.meal_type, m.items]))
      },
      occupancy: { residents: f.headcount, beds: f.totalBeds, vacant: f.vacantBeds, percent: f.totalBeds ? Math.round(f.headcount * 100 / f.totalBeds) : 0 },
      upcoming: brief.checkoutsSoon || [],
      pending: { claims: f.pendingClaims, approvals: isAdmin ? f.pendingApprovals : undefined }
    };

    if (isAdmin) {
      const m = monthMoney.rows[0] || { income: 0, expenses: 0 };
      const flags = await owner.computeAnomalies();
      payload.finance = { monthIncome: m.income, monthExpenses: m.expenses, monthNet: m.income - m.expenses, outstanding: f.rentDue.total };
      payload.flags = flags.slice(0, 6);
      payload.flagCount = flags.length;
    }
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /search?q=priya
router.get('/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ query: q, residents: [], rooms: [], payments: [], requests: [] });
  const like = `%${q}%`;
  try {
    const [residents, rooms, payments, requests, due] = await Promise.all([
      pool.query(`SELECT g.id, g.name, g.phone, r.room_number, g.bed_number, g.is_active FROM guests g LEFT JOIN rooms r ON r.id=g.room_id
                   WHERE g.name ILIKE $1 OR g.phone ILIKE $1 OR r.room_number ILIKE $1 ORDER BY g.is_active DESC, g.name LIMIT 8`, [like]),
      pool.query(`SELECT r.id, r.room_number, r.floor, r.total_beds, (SELECT COUNT(*) FROM guests g WHERE g.room_id=r.id AND g.is_active=true)::int AS occupied
                   FROM rooms r WHERE r.is_active=true AND (r.room_number ILIKE $1 OR r.room_type ILIKE $1) ORDER BY r.room_number LIMIT 6`, [like]),
      pool.query(`SELECT id, guest_name, amount, collection_date, receipt_number, status FROM collections
                   WHERE is_deleted=false AND (receipt_number ILIKE $1 OR guest_name ILIKE $1) ORDER BY collection_date DESC LIMIT 6`, [like]),
      pool.query(`SELECT id, category, description, room_number, status, priority FROM complaints
                   WHERE description ILIKE $1 OR category ILIKE $1 OR room_number ILIKE $1 ORDER BY created_at DESC LIMIT 6`, [like])
    ].concat([routes.computeRentDueList()]));
    const dueMap = new Map(due.map(g => [g.id, g.amount_due]));
    res.json({
      query: q,
      residents: residents.rows.map(g => ({ ...g, amount_due: dueMap.get(g.id) || 0 })),
      rooms: rooms.rows.map(r => ({ ...r, vacant: Math.max(0, r.total_beds - r.occupied) })),
      payments: payments.rows,
      requests: requests.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
