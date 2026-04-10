// routes/guests.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/guests
router.get('/', auth, async (req, res) => {
  try {
    const { active, search } = req.query;
    let query = `
      SELECT g.*, r.room_number
      FROM guests g
      LEFT JOIN rooms r ON g.room_id = r.id
      WHERE 1=1
    `;
    const params = [];

    if (active !== 'all') {
      params.push(active !== 'false');
      query += ` AND g.is_active = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (g.name ILIKE $${params.length} OR g.phone ILIKE $${params.length})`;
    }

    query += ' ORDER BY g.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/guests/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const guest = await pool.query(
      `SELECT g.*, r.room_number FROM guests g 
       LEFT JOIN rooms r ON g.room_id = r.id 
       WHERE g.id = $1`, [req.params.id]
    );
    if (!guest.rows[0]) return res.status(404).json({ error: 'Guest not found' });

    const payments = await pool.query(
      'SELECT * FROM payments WHERE guest_id = $1 ORDER BY payment_date DESC',
      [req.params.id]
    );

    res.json({ ...guest.rows[0], payments: payments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/guests
router.post('/', auth, async (req, res) => {
  const {
    name, phone, email, emergency_contact,
    id_proof_type, id_proof_number,
    room_id, bed_number, join_date,
    monthly_rent, deposit_amount, notes
  } = req.body;

  if (!name || !join_date) {
    return res.status(400).json({ error: 'Name and join date are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO guests 
        (name, phone, email, emergency_contact, id_proof_type, id_proof_number,
         room_id, bed_number, join_date, monthly_rent, deposit_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [name, phone, email, emergency_contact, id_proof_type, id_proof_number,
       room_id || null, bed_number || null, join_date,
       monthly_rent || 0, deposit_amount || 0, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/guests/:id
router.put('/:id', auth, async (req, res) => {
  const {
    name, phone, email, emergency_contact,
    room_id, bed_number, monthly_rent,
    deposit_amount, notes, leave_date, is_active
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE guests SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        email = COALESCE($3, email),
        emergency_contact = COALESCE($4, emergency_contact),
        room_id = $5,
        bed_number = $6,
        monthly_rent = COALESCE($7, monthly_rent),
        deposit_amount = COALESCE($8, deposit_amount),
        notes = COALESCE($9, notes),
        leave_date = $10,
        is_active = COALESCE($11, is_active)
       WHERE id = $12 RETURNING *`,
      [name, phone, email, emergency_contact,
       room_id || null, bed_number || null,
       monthly_rent, deposit_amount, notes, leave_date || null,
       is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Guest not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/guests/:id (soft delete - mark inactive)
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE guests SET is_active = false, leave_date = CURRENT_DATE 
       WHERE id = $1`, [req.params.id]
    );
    res.json({ message: 'Guest checked out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
