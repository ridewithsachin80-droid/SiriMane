// routes/expenses.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/expenses
router.get('/', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];

    if (month && year) {
      params.push(parseInt(month), parseInt(year));
      query += ` AND EXTRACT(MONTH FROM expense_date) = $${params.length-1}
                 AND EXTRACT(YEAR FROM expense_date) = $${params.length}`;
    }

    query += ' ORDER BY expense_date DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses
router.post('/', auth, async (req, res) => {
  const { amount, category, description, expense_date, paid_to, receipt_number } = req.body;
  if (!amount || !category)
    return res.status(400).json({ error: 'Amount and category required' });

  try {
    const result = await pool.query(
      `INSERT INTO expenses (amount, category, description, expense_date, paid_to, receipt_number)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [amount, category, description, expense_date || new Date(), paid_to, receipt_number]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
