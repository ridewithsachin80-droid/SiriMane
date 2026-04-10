// routes/dashboard.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/dashboard
router.get('/', auth, async (req, res) => {
  try {
    const [
      guestsResult,
      roomsResult,
      bedsResult,
      incomeResult,
      expenseResult,
      recentGuests,
      recentPayments
    ] = await Promise.all([
      // Total active guests
      pool.query('SELECT COUNT(*) FROM guests WHERE is_active = true'),

      // Rooms stats
      pool.query(`
        SELECT 
          COUNT(*) as total_rooms,
          SUM(total_beds) as total_beds,
          COUNT(CASE WHEN (
            SELECT COUNT(*) FROM guests g 
            WHERE g.room_id = r.id AND g.is_active = true
          ) >= r.total_beds THEN 1 END) as full_rooms
        FROM rooms r WHERE r.is_active = true
      `),

      // Available beds
      pool.query(`
        SELECT 
          SUM(r.total_beds) - COUNT(g.id) as available_beds
        FROM rooms r
        LEFT JOIN guests g ON r.id = g.room_id AND g.is_active = true
        WHERE r.is_active = true
      `),

      // This month income
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM payments
        WHERE DATE_TRUNC('month', payment_date) = DATE_TRUNC('month', NOW())
      `),

      // This month expenses
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', NOW())
      `),

      // Recent 5 guests
      pool.query(`
        SELECT g.id, g.name, g.phone, g.join_date, g.monthly_rent,
               r.room_number
        FROM guests g
        LEFT JOIN rooms r ON g.room_id = r.id
        WHERE g.is_active = true
        ORDER BY g.created_at DESC LIMIT 5
      `),

      // Recent 5 payments
      pool.query(`
        SELECT p.*, g.name as guest_name
        FROM payments p
        LEFT JOIN guests g ON p.guest_id = g.id
        ORDER BY p.payment_date DESC LIMIT 5
      `)
    ]);

    const rooms = roomsResult.rows[0];
    const income = parseFloat(incomeResult.rows[0].total);
    const expenses = parseFloat(expenseResult.rows[0].total);
    const totalBeds = parseInt(rooms.total_beds) || 0;
    const availBeds = parseInt(bedsResult.rows[0].available_beds) || 0;
    const occupiedBeds = totalBeds - availBeds;

    res.json({
      totalGuests: parseInt(guestsResult.rows[0].count),
      totalRooms: parseInt(rooms.total_rooms),
      totalBeds,
      availableBeds: availBeds,
      occupiedBeds,
      occupancyPercent: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
      monthlyIncome: income,
      monthlyExpenses: expenses,
      netProfit: income - expenses,
      recentGuests: recentGuests.rows,
      recentPayments: recentPayments.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
