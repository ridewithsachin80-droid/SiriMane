// routes/rooms.js
const router = require('express').Router();
const pool = require('../db');
const auth = require('../middleware/auth');

// GET /api/rooms
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.*,
        COUNT(g.id) as occupied_beds,
        r.total_beds - COUNT(g.id) as available_beds,
        JSON_AGG(
          CASE WHEN g.id IS NOT NULL THEN
            JSON_BUILD_OBJECT('id', g.id, 'name', g.name, 'bed_number', g.bed_number, 'phone', g.phone)
          END
        ) FILTER (WHERE g.id IS NOT NULL) as guests
      FROM rooms r
      LEFT JOIN guests g ON r.id = g.room_id AND g.is_active = true
      WHERE r.is_active = true
      GROUP BY r.id
      ORDER BY r.room_number
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rooms/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const room = await pool.query('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });

    const guests = await pool.query(
      `SELECT id, name, phone, bed_number, monthly_rent, join_date 
       FROM guests WHERE room_id = $1 AND is_active = true`,
      [req.params.id]
    );

    res.json({ ...room.rows[0], guests: guests.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rooms
router.post('/', auth, async (req, res) => {
  const { room_number, floor, total_beds, room_type, monthly_rent, description } = req.body;
  if (!room_number || !total_beds)
    return res.status(400).json({ error: 'Room number and total beds required' });

  try {
    const result = await pool.query(
      `INSERT INTO rooms (room_number, floor, total_beds, room_type, monthly_rent, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [room_number, floor || 1, total_beds, room_type || 'shared', monthly_rent || 0, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Room number already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rooms/:id
router.put('/:id', auth, async (req, res) => {
  const { room_number, floor, total_beds, room_type, monthly_rent, description } = req.body;
  try {
    const result = await pool.query(
      `UPDATE rooms SET
        room_number = COALESCE($1, room_number),
        floor = COALESCE($2, floor),
        total_beds = COALESCE($3, total_beds),
        room_type = COALESCE($4, room_type),
        monthly_rent = COALESCE($5, monthly_rent),
        description = COALESCE($6, description)
       WHERE id = $7 RETURNING *`,
      [room_number, floor, total_beds, room_type, monthly_rent, description, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Room not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rooms/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const guests = await pool.query(
      'SELECT COUNT(*) FROM guests WHERE room_id = $1 AND is_active = true', [req.params.id]
    );
    if (parseInt(guests.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete room with active guests' });
    }
    await pool.query('UPDATE rooms SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Room deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
