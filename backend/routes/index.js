// routes/index.js — All API routes
const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');
const requireAdmin = auth.requireAdmin;

// Records who did what, for the Audit Log. Never throws — a logging failure
// should never block the actual request it's describing.
// Computes a month-by-month rent ledger for one guest, with a running balance
// carried forward across months (positive = guest is in credit, negative =
// guest still owes that much). Deliberately uses the actual collection_date
// to attribute a payment to a month, NOT the free-text "collection_month"
// field on the form — that field is manually typed by whoever logs the
// payment and isn't reliable enough to do balance math on.
// Known limitation: this assumes the guest's CURRENT monthly_rent applied to
// every past month too. If a guest's rent was ever changed mid-stay, past
// months in this ledger will be calculated against the new rate, not what
// was actually owed at the time.
async function computeGuestLedger(guest) {
  const monthlyRent = parseFloat(guest.monthly_rent) || 0;
  if (!guest.join_date) return { ledger: [], currentBalance: 0 };

  const rentRows = await pool.query(
    `SELECT amount, collection_date FROM collections WHERE guest_id=$1 AND collection_type='rent' AND is_deleted=false ORDER BY collection_date ASC`,
    [guest.id]
  );

  const paidByMonth = {};
  for (const row of rentRows.rows) {
    const d = new Date(row.collection_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    paidByMonth[key] = (paidByMonth[key] || 0) + parseFloat(row.amount);
  }

  const joinDate = new Date(guest.join_date);
  const endDate = guest.leave_date ? new Date(guest.leave_date) : new Date();
  if (isNaN(joinDate.getTime())) return { ledger: [], currentBalance: 0 };

  let cursor = new Date(joinDate.getFullYear(), joinDate.getMonth(), 1);
  const endCursor = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

  const ledger = [];
  let balance = 0;
  let safety = 0; // hard cap so a bad join_date can never hang the request
  while (cursor <= endCursor && safety < 240) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const due = monthlyRent;
    const paid = paidByMonth[key] || 0;
    balance += (paid - due);
    ledger.push({
      month: key,
      label: cursor.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
      rent_due: due,
      rent_paid: paid,
      month_balance: paid - due,
      running_balance: balance
    });
    cursor.setMonth(cursor.getMonth() + 1);
    safety++;
  }

  return { ledger, currentBalance: balance };
}



// ── AUTH ─────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Required' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
    await pool.query(`INSERT INTO activity_log(user_id,action,ip_address) VALUES($1,'login',$2)`, [user.id, req.ip]);
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
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND DATE_TRUNC('month',collection_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND DATE_TRUNC('month',purchase_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.is_active=true ORDER BY g.created_at DESC LIMIT 5`),
      pool.query(`SELECT c.*,g.name as guest_name FROM collections c LEFT JOIN guests g ON c.guest_id=g.id WHERE c.is_deleted=false ORDER BY c.collection_date DESC LIMIT 5`)
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

router.delete('/rooms/:id', auth, requireAdmin, async (req, res) => {
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
    const c = await pool.query('SELECT * FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC', [req.params.id]);
    res.json({ ...g.rows[0], payments: c.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guests', auth, async (req, res) => {
  const { name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes } = req.body;
  if (!name || !join_date) return res.status(400).json({ error: 'Name and join date required' });
  try {
    const r = await pool.query(
      `INSERT INTO guests(name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id||null,bed_number||null,join_date,monthly_rent||0,deposit_amount||0,notes,req.user.id]);
    await logActivity(req, 'guest_add', `${name}${room_id?' (room assigned)':''}`);
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

router.delete('/guests/:id', auth, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE guests SET is_active=false,leave_date=CURRENT_DATE WHERE id=$1', [req.params.id]);
    res.json({ message: 'Checked out' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full move-out flow: computes the deposit refund (deposit minus deductions),
// records it permanently in deposit_refunds, and checks the guest out — all
// in one step so the two can never get out of sync. Admin only, since it's
// the final sign-off on a financial transaction.
router.post('/guests/:id/checkout', auth, requireAdmin, async (req, res) => {
  const { deductions, deduction_notes, refund_mode } = req.body;
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.id=$1`, [req.params.id]);
    const guest = g.rows[0];
    if (!guest) return res.status(404).json({ error: 'Guest not found' });
    if (!guest.is_active) return res.status(400).json({ error: 'Guest is already checked out' });

    const deductionAmount = parseFloat(deductions) || 0;
    const depositAmount = parseFloat(guest.deposit_amount) || 0;
    const refundAmount = depositAmount - deductionAmount;

    const refund = await pool.query(
      `INSERT INTO deposit_refunds(guest_id,guest_name,room_number,deposit_amount,deductions,deduction_notes,refund_amount,refund_mode,processed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [guest.id, guest.name, guest.room_number, depositAmount, deductionAmount, deduction_notes || null, refundAmount, refund_mode || 'cash', req.user.id]
    );
    await pool.query('UPDATE guests SET is_active=false,leave_date=CURRENT_DATE WHERE id=$1', [guest.id]);
    await logActivity(req, 'guest_checkout', `${guest.name} (room ${guest.room_number || '—'}) — refund ₹${refundAmount}`);

    res.status(201).json(refund.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COLLECTIONS (Income) ─────────────────────────
router.get('/collections', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `SELECT c.*,g.name as guest_name,r.room_number FROM collections c LEFT JOIN guests g ON c.guest_id=g.id LEFT JOIN rooms r ON g.room_id=r.id WHERE c.is_deleted=false`;
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
      `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [guest_id||null,guest_name,amount,collection_date||new Date(),collection_month,collection_type||'rent',payment_mode||'cash',description,receipt_number,req.user.id]);
    await logActivity(req, 'collection_add', `₹${amount} ${collection_type||'rent'} from ${guest_name||'guest #'+guest_id}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/collections/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE collections SET is_deleted=true,deleted_by=$1,deleted_at=NOW() WHERE id=$2 AND is_deleted=false RETURNING *', [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'collection_delete', `₹${r.rows[0].amount} ${r.rows[0].collection_type} (id ${req.params.id})`);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PURCHASES (Expenses) ─────────────────────────
router.get('/purchases', auth, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = 'SELECT * FROM purchases WHERE is_deleted=false';
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
      `INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,receipt_number,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [amount,category,description,purchase_date||new Date(),paid_to,payment_mode||'cash',receipt_number,req.user.id]);
    await logActivity(req, 'purchase_add', `₹${amount} ${category}${paid_to ? ' to '+paid_to : ''}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/purchases/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE purchases SET is_deleted=true,deleted_by=$1,deleted_at=NOW() WHERE id=$2 AND is_deleted=false RETURNING *', [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'purchase_delete', `₹${r.rows[0].amount} ${r.rows[0].category} (id ${req.params.id})`);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

router.post('/announcements', auth, requireAdmin, async (req, res) => {
  const { title, message, priority } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
  try {
    const r = await pool.query(
      `INSERT INTO announcements(title,message,priority) VALUES($1,$2,$3) RETURNING *`,
      [title, message, priority||'normal']);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/announcements/:id', auth, requireAdmin, async (req, res) => {
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
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND EXTRACT(MONTH FROM collection_date)=$1 AND EXTRACT(YEAR FROM collection_date)=$2`, [m,y]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND EXTRACT(MONTH FROM purchase_date)=$1 AND EXTRACT(YEAR FROM purchase_date)=$2`, [m,y]),
      pool.query(`SELECT collection_type, COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND EXTRACT(MONTH FROM collection_date)=$1 AND EXTRACT(YEAR FROM collection_date)=$2 GROUP BY collection_type`, [m,y]),
      pool.query(`SELECT category, COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND EXTRACT(MONTH FROM purchase_date)=$1 AND EXTRACT(YEAR FROM purchase_date)=$2 GROUP BY category`, [m,y])
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
    const c = await pool.query('SELECT amount,collection_date,collection_type,payment_mode FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC LIMIT 12', [g.rows[0].id]);
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

// ── RENT DUE TRACKER ──────────────────────────────
// Now backed by the same ledger math as the per-guest ledger below, so a
// guest who overpaid last month correctly shows reduced (or zero) amount
// due this month, instead of resetting to a fresh month-only snapshot.
router.get('/rent-due', auth, async (req, res) => {
  try {
    const guests = await pool.query(`
      SELECT g.id, g.name, g.phone, g.join_date, g.leave_date, g.monthly_rent, r.room_number
      FROM guests g LEFT JOIN rooms r ON g.room_id = r.id
      WHERE g.is_active = true AND g.monthly_rent > 0
      ORDER BY g.name ASC
    `);
    const results = [];
    for (const guest of guests.rows) {
      const { currentBalance } = await computeGuestLedger(guest);
      results.push({
        id: guest.id,
        name: guest.name,
        phone: guest.phone,
        room_number: guest.room_number,
        monthly_rent: guest.monthly_rent,
        current_balance: currentBalance,
        amount_due: currentBalance < 0 ? Math.abs(currentBalance) : 0,
        credit: currentBalance > 0 ? currentBalance : 0
      });
    }
    results.sort((a, b) => b.amount_due - a.amount_due);
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PER-GUEST LEDGER ───────────────────────────────
router.get('/guests/:id/ledger', auth, async (req, res) => {
  try {
    const g = await pool.query('SELECT * FROM guests WHERE id=$1', [req.params.id]);
    const guest = g.rows[0];
    if (!guest) return res.status(404).json({ error: 'Guest not found' });
    const { ledger, currentBalance } = await computeGuestLedger(guest);
    res.json({
      guest: { id: guest.id, name: guest.name, monthly_rent: guest.monthly_rent, join_date: guest.join_date, is_active: guest.is_active },
      ledger,
      current_balance: currentBalance
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STAFF / USERS (admin only) ────────────────────
router.get('/users', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', auth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const finalRole = role === 'admin' ? 'admin' : 'staff';
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role,created_at',
      [username.trim(), hash, finalRole]
    );
    await logActivity(req, 'user_create', `${username} (${finalRole})`);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', auth, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't remove your own account" });
  try {
    const r = await pool.query('DELETE FROM users WHERE id=$1 RETURNING username', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'user_delete', r.rows[0].username);
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUDIT LOG (admin only) ────────────────────────
router.get('/activity-log', auth, requireAdmin, async (req, res) => {
  try {
    const { limit } = req.query;
    const cappedLimit = Math.min(parseInt(limit) || 200, 500);
    const r = await pool.query(
      `SELECT a.*, u.username FROM activity_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT $1`,
      [cappedLimit]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DEPOSIT REFUND HISTORY (admin only) ───────────
router.get('/deposit-refunds', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT dr.*, u.username AS processed_by_username FROM deposit_refunds dr LEFT JOIN users u ON dr.processed_by = u.id ORDER BY dr.created_at DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

// ── GUEST AUTH ───────────────────────────────────
router.post('/guest-login', async (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) return res.status(400).json({ error: 'Mobile and password required' });
  try {
    const r = await pool.query(
      `SELECT g.*, ro.room_number FROM guests g 
       LEFT JOIN rooms ro ON g.room_id = ro.id 
       WHERE g.phone = $1 AND g.is_active = true LIMIT 1`,
      [mobile]
    );
    const guest = r.rows[0];
    if (!guest) return res.status(401).json({ error: 'No active account found with this mobile number' });

    // If no password set, default = mobile number
    let valid = false;
    if (guest.password_hash) {
      valid = await bcrypt.compare(password, guest.password_hash);
    } else {
      // Default password is mobile number itself
      valid = (password === mobile);
      if (valid) {
        // Auto-set the hash for future logins
        const hash = await bcrypt.hash(mobile, 10);
        await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [hash, guest.id]);
      }
    }

    if (!valid) return res.status(401).json({ error: 'Incorrect password. Default password is your mobile number.' });

    const token = jwt.sign({ guestId: guest.id, type: 'guest' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      guest: {
        id: guest.id, name: guest.name, phone: guest.phone,
        room_number: guest.room_number, bed_number: guest.bed_number
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Guest middleware
const guestAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'guest') return res.status(401).json({ error: 'Invalid token type' });
    const r = await pool.query('SELECT * FROM guests WHERE id=$1', [decoded.guestId]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Guest not found' });
    req.guest = r.rows[0];
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// GET /api/guest-portal - full guest data
router.get('/guest-portal', guestAuth, async (req, res) => {
  try {
    const g = req.guest;
    const [room, payments, menu, announcements] = await Promise.all([
      g.room_id ? pool.query('SELECT room_number FROM rooms WHERE id=$1', [g.room_id]) : { rows: [{}] },
      pool.query('SELECT * FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC LIMIT 24', [g.id]),
      pool.query('SELECT * FROM daily_menu ORDER BY CASE day_of_week WHEN \'Monday\' THEN 1 WHEN \'Tuesday\' THEN 2 WHEN \'Wednesday\' THEN 3 WHEN \'Thursday\' THEN 4 WHEN \'Friday\' THEN 5 WHEN \'Saturday\' THEN 6 WHEN \'Sunday\' THEN 7 END'),
      pool.query('SELECT * FROM announcements WHERE is_active=true ORDER BY created_at DESC LIMIT 10')
    ]);
    res.json({
      ...g,
      password_hash: undefined,
      room_number: room.rows[0]?.room_number,
      payments: payments.rows,
      menu: menu.rows,
      announcements: announcements.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/guest-change-password
router.post('/guest-change-password', guestAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const g = req.guest;
    let valid = false;
    if (g.password_hash) {
      valid = await bcrypt.compare(currentPassword, g.password_hash);
    } else {
      valid = (currentPassword === g.phone);
    }
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [hash, g.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
