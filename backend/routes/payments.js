// routes/payments.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/payments
router.get('/', auth, async (req, res) => {
  try {
    const { month, year, guest_id } = req.query;
    let query = `
      SELECT p.*, g.name as guest_name, r.room_number
      FROM payments p
      LEFT JOIN guests g ON p.guest_id = g.id
      LEFT JOIN rooms r ON g.room_id = r.id
      WHERE 1=1
    `;
    const params = [];

    if (month && year) {
      params.push(parseInt(month), parseInt(year));
      query += ` AND EXTRACT(MONTH FROM p.payment_date) = $${params.length-1}
                 AND EXTRACT(YEAR FROM p.payment_date) = $${params.length}`;
    }
    if (guest_id) {
      params.push(guest_id);
      query += ` AND p.guest_id = $${params.length}`;
    }

    query += ' ORDER BY p.payment_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments
router.post('/', auth, async (req, res) => {
  const {
    guest_id, amount, payment_date,
    payment_for_month, payment_type,
    payment_mode, receipt_number, notes
  } = req.body;

  if (!guest_id || !amount)
    return res.status(400).json({ error: 'Guest and amount required' });

  try {
    const result = await pool.query(
      `INSERT INTO payments
        (guest_id, amount, payment_date, payment_for_month, payment_type, payment_mode, receipt_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [guest_id, amount, payment_date || new Date(),
       payment_for_month, payment_type || 'rent',
       payment_mode || 'cash', receipt_number, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/payments/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM payments WHERE id = $1', [req.params.id]);
    res.json({ message: 'Payment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
