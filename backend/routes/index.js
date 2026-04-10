// routes/index.js — All API routes
const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');

// ── AUTH ─────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Required' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    await pool.query(`INSERT INTO activity_log(user_id,action,ip_address) VALUES($1,'login',$2)`, [user.id, req.ip]);
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Required' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, r.rows[0].password_hash)))
      return res.status(401).json({ error: 'Wrong current password' });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), req.user.id]);
    res.json({ message: 'Password changed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/auth/me', auth, (req, res) => res.json({ user: req.user }));

// ── DASHBOARD ────────────────────────────────────
router.get('/dashboard', auth, async (req, res) => {
  try {
    const [guests, rooms, beds, income, expenses, recentGuests, recentPayments] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM guests WHERE is_active=true'),
      pool.query(`SELECT COUNT(*) as total_rooms, COALESCE(SUM(total_beds),0) as total_beds FROM rooms WHERE is_active=true`),
      pool.query(`SELECT COALESCE(SUM(r.total_beds),0) - COUNT(g.id) as available FROM rooms r LEFT JOIN guests g ON r.id=g.room_id AND g.is_active=true WHERE r.is_active=true`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE DATE_TRUNC('month',collection_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE DATE_TRUNC('month',purchase_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.is_active=true ORDER BY g.created_at DESC LIMIT 5`),
      pool.query(`SELECT c.*,g.name as guest_name FROM collections c LEFT JOIN guests g ON c.guest_id=g.id ORDER BY c.collection_date DESC LIMIT 5`)
    ]);
    const totalBeds = parseInt(rooms.rows[0].total_beds) || 0;
    const availBeds = parseInt(beds.rows[0].available) || 0;
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    res.json({
      totalGuests: parseInt(guests.rows[0].count),
      totalRooms: parseInt(rooms.rows[0].total_rooms),
      totalBeds, availableBeds: availBeds,
      occupancyPercent: totalBeds > 0 ? Math.round(((totalBeds - availBeds) / totalBeds) * 100) : 0,
      monthlyIncome: inc, monthlyExpenses: exp, netProfit: inc - exp,
      recentGuests: recentGuests.rows, recentPayments: recentPayments.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ROOMS ────────────────────────────────────────
router.get('/rooms', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, COUNT(g.id) as occupied_beds, r.total_beds - COUNT(g.id) as available_beds,
        JSON_AGG(JSON_BUILD_OBJECT('id',g.id,'name',g.name,'bed_number',g.bed_number)) FILTER (WHERE g.id IS NOT NULL) as guests
      FROM rooms r LEFT JOIN guests g ON r.id=g.room_id AND g.is_active=true
      WHERE r.is_active=true GROUP BY r.id ORDER BY r.room_number`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/rooms', auth, async (req, res) => {
  const { room_number, floor, total_beds, room_type, monthly_rent, description } = req.body;
  if (!room_number || !total_beds) return res.status(400).json({ error: 'Room number and beds required' });
  try {
    const r = await pool.query(
      `INSERT INTO rooms(room_number,floor,total_beds,room_type,monthly_rent,description) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [room_number, floor||1, total_beds, room_type||'shared', monthly_rent||0, description]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code==='23505') return res.status(400).json({ error: 'Room number exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/rooms/:id', auth, async (req, res) => {
  const { room_number, floor, total_beds, room_type, monthly_rent, description } = req.body;
  try {
    const r = await pool.query(
      `UPDATE rooms SET room_number=COALESCE($1,room_number),floor=COALESCE($2,floor),total_beds=COALESCE($3,total_beds),room_type=COALESCE($4,room_type),monthly_rent=COALESCE($5,monthly_rent),description=COALESCE($6,description) WHERE id=$7 RETURNING *`,
      [room_number,floor,total_beds,room_type,monthly_rent,description,req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/rooms/:id', auth, async (req, res) => {
  try {
    const g = await pool.query('SELECT COUNT(*) FROM guests WHERE room_id=$1 AND is_active=true', [req.params.id]);
    if (parseInt(g.rows[0].count) > 0) return res.status(400).json({ error: 'Room has active guests' });
    await pool.query('UPDATE rooms SET is_active=false WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GUESTS ───────────────────────────────────────
router.get('/guests', auth, async (req, res) => {
  try {
    const { search, active } = req.query;
    let q = `SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE 1=1`;
    const p = [];
    if (active !== 'all') { p.push(active !== 'false'); q += ` AND g.is_active=$${p.length}`; }
    if (search) { p.push(`%${search}%`); q += ` AND (g.name ILIKE $${p.length} OR g.phone ILIKE $${p.length})`; }
    q += ' ORDER BY g.created_at DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/guests/:id', auth, async (req, res) => {
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.id=$1`, [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = await pool.query('SELECT * FROM collections WHERE guest_id=$1 ORDER BY collection_date DESC', [req.params.id]);
    res.json({ ...g.rows[0], payments: c.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guests', auth, async (req, res) => {
  const { name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes } = req.body;
  if (!name || !join_date) return res.status(400).json({ error: 'Name and join date required' });
  try {
    const r = await pool.query(
      `INSERT INTO guests(name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id||null,bed_number||null,join_date,monthly_rent||0,deposit_amount||0,notes]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/guests/:id', auth, async (req, res) => {
  const { name,phone,email,emergency_contact,room_id,bed_number,monthly_rent,deposit_amount,notes,leave_date,is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE guests SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),emergency_contact=COALESCE($4,emergency_contact),room_id=$5,bed_number=$6,monthly_rent=COALESCE($7,monthly_rent),deposit_amount=COALESCE($8,deposit_amount),notes=COALESCE($9,notes),leave_date=$10,is_active=COALESCE($11,is_active) WHERE id=$12 RETURNING *`,
      [name,phone,email,emergency_contact,room_id||null,bed_number||null,monthly_rent,deposit_amount,notes,leave_date||null,is_active,req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/guests/:id', auth, async (req, res) => {
  try {
    await pool.query('UPDATE guests SET is_active=false,leave_date=CURRENT_DATE WHERE id=$1', [req.params.id]);
    res.json({ message: 'Checked out' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COLLECTIONS (Income) ─────────────────────────
router.get('/collections', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `SELECT c.*,g.name as guest_name,r.room_number FROM collections c LEFT JOIN guests g ON c.guest_id=g.id LEFT JOIN rooms r ON g.room_id=r.id WHERE 1=1`;
    const p = [];
    if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM c.collection_date)=$${p.length-1} AND EXTRACT(YEAR FROM c.collection_date)=$${p.length}`; }
    q += ' ORDER BY c.collection_date DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/collections', auth, async (req, res) => {
  const { guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  try {
    const r = await pool.query(
      `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [guest_id||null,guest_name,amount,collection_date||new Date(),collection_month,collection_type||'rent',payment_mode||'cash',description,receipt_number]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/collections/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM collections WHERE id=$1', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PURCHASES (Expenses) ─────────────────────────
router.get('/purchases', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = 'SELECT * FROM purchases WHERE 1=1';
    const p = [];
    if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM purchase_date)=$${p.length-1} AND EXTRACT(YEAR FROM purchase_date)=$${p.length}`; }
    q += ' ORDER BY purchase_date DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/purchases', auth, async (req, res) => {
  const { amount,category,description,purchase_date,paid_to,payment_mode,receipt_number } = req.body;
  if (!amount || !category) return res.status(400).json({ error: 'Amount and category required' });
  try {
    const r = await pool.query(
      `INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,receipt_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [amount,category,description,purchase_date||new Date(),paid_to,payment_mode||'cash',receipt_number]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/purchases/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM purchases WHERE id=$1', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DAILY MENU ───────────────────────────────────
router.get('/menu', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM daily_menu ORDER BY CASE day_of_week WHEN \'Monday\' THEN 1 WHEN \'Tuesday\' THEN 2 WHEN \'Wednesday\' THEN 3 WHEN \'Thursday\' THEN 4 WHEN \'Friday\' THEN 5 WHEN \'Saturday\' THEN 6 WHEN \'Sunday\' THEN 7 END, meal_type');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/menu', auth, async (req, res) => {
  const { day_of_week, meal_type, items } = req.body;
  if (!day_of_week || !meal_type || !items) return res.status(400).json({ error: 'All fields required' });
  try {
    const r = await pool.query(
      `INSERT INTO daily_menu(day_of_week,meal_type,items) VALUES($1,$2,$3) ON CONFLICT(day_of_week,meal_type) DO UPDATE SET items=$3 RETURNING *`,
      [day_of_week, meal_type, items]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/menu/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM daily_menu WHERE id=$1', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ANNOUNCEMENTS (Guest Messages) ───────────────
router.get('/announcements', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/announcements', auth, async (req, res) => {
  const { title, message, priority } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    const r = await pool.query(
      `INSERT INTO announcements(title,message,priority) VALUES($1,$2,$3) RETURNING *`,
      [title, message, priority||'normal']);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/announcements/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM announcements WHERE id=$1', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── INBOX ────────────────────────────────────────
router.get('/inbox', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM inbox_messages ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/inbox/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE inbox_messages SET is_read=true WHERE id=$1', [req.params.id]);
    res.json({ message: 'Marked read' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/inbox/:id/reply', auth, async (req, res) => {
  const { reply } = req.body;
  try {
    const r = await pool.query('UPDATE inbox_messages SET reply=$1,replied_at=NOW(),is_read=true WHERE id=$2 RETURNING *', [reply, req.params.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/inbox/:id', auth, async (req, res) => {
  try { await pool.query('DELETE FROM inbox_messages WHERE id=$1', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REPORTS ──────────────────────────────────────
router.get('/reports', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = month || new Date().getMonth() + 1;
    const y = year || new Date().getFullYear();
    const [income, expenses, incomeBreakdown, expenseBreakdown] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE EXTRACT(MONTH FROM collection_date)=$1 AND EXTRACT(YEAR FROM collection_date)=$2`, [m,y]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE EXTRACT(MONTH FROM purchase_date)=$1 AND EXTRACT(YEAR FROM purchase_date)=$2`, [m,y]),
      pool.query(`SELECT collection_type, COALESCE(SUM(amount),0) as total FROM collections WHERE EXTRACT(MONTH FROM collection_date)=$1 AND EXTRACT(YEAR FROM collection_date)=$2 GROUP BY collection_type`, [m,y]),
      pool.query(`SELECT category, COALESCE(SUM(amount),0) as total FROM purchases WHERE EXTRACT(MONTH FROM purchase_date)=$1 AND EXTRACT(YEAR FROM purchase_date)=$2 GROUP BY category`, [m,y])
    ]);
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    res.json({ totalIncome: inc, totalExpenses: exp, netProfit: inc - exp, incomeBreakdown: incomeBreakdown.rows, expenseBreakdown: expenseBreakdown.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUBLIC GUEST LOOKUP ──────────────────────────
router.get('/guest-lookup', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.phone=$1 LIMIT 1`, [phone]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = await pool.query('SELECT amount,collection_date,collection_type,payment_mode FROM collections WHERE guest_id=$1 ORDER BY collection_date DESC LIMIT 12', [g.rows[0].id]);
    const a = await pool.query('SELECT title,message,priority,created_at FROM announcements WHERE is_active=true ORDER BY created_at DESC LIMIT 5');
    const m = await pool.query('SELECT * FROM daily_menu ORDER BY CASE day_of_week WHEN \'Monday\' THEN 1 WHEN \'Tuesday\' THEN 2 WHEN \'Wednesday\' THEN 3 WHEN \'Thursday\' THEN 4 WHEN \'Friday\' THEN 5 WHEN \'Saturday\' THEN 6 WHEN \'Sunday\' THEN 7 END');
    res.json({ ...g.rows[0], payments: c.rows, announcements: a.rows, menu: m.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUBLIC GUEST MESSAGE ─────────────────────────
router.post('/guest-message', async (req, res) => {
  const { guest_name, guest_phone, room_number, subject, message } = req.body;
  if (!guest_name || !message) return res.status(400).json({ error: 'Name and message required' });
  try {
    await pool.query(`INSERT INTO inbox_messages(guest_name,guest_phone,room_number,subject,message) VALUES($1,$2,$3,$4,$5)`, [guest_name,guest_phone,room_number,subject,message]);
    res.json({ message: 'Message sent' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
