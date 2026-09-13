// routes/index.js — All API routes
const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const pool = require('../db');
const auth = require('../middleware/auth');
const requireAdmin = auth.requireAdmin;

// Records who did what, for the Audit Log. Never throws — a logging failure
// should never block the actual request it's describing.
async function logActivity(req, action, details) {
  try {
    await pool.query(
      'INSERT INTO activity_log(user_id, action, details, ip_address) VALUES($1,$2,$3,$4)',
      [req.user ? req.user.id : null, action, details || null, req.ip]
    );
  } catch (err) {
    console.error('activity log failed:', err.message);
  }
}

// Shared formatting + table-drawing helpers for every PDF export route, so
// pagination logic lives in exactly one place instead of being copy-pasted
// per route (and potentially drifting out of sync / breaking inconsistently).
function fmtMoney(n) { return 'Rs ' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtD(d) { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }

// columns: [{ label, x, width, get: (row) => string, color?: (row) => string }]
function drawPdfTable(doc, columns, rows) {
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  function drawHeader() {
    doc.fontSize(8).font('Helvetica-Bold');
    const y = doc.y;
    columns.forEach(c => doc.text(c.label, c.x, y, { width: c.width }));
    doc.moveDown(0.5);
    doc.font('Helvetica');
  }
  drawHeader();
  doc.fontSize(8);
  for (const row of rows) {
    if (doc.y > pageBottom - 20) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    columns.forEach(c => {
      if (c.color) doc.fillColor(c.color(row));
      doc.text(String(c.get(row) ?? '—'), c.x, y, { width: c.width });
      if (c.color) doc.fillColor('#000');
    });
    doc.moveDown(0.4);
  }
  if (rows.length === 0) {
    doc.fillColor('#666').text('No data for this period').fillColor('#000');
  }
}

// Computes a month-by-month rent ledger for one guest, with a running balance
// carried forward across months (positive = guest is in credit, negative =
// guest still owes that much). Deliberately uses the actual collection_date
// to attribute a payment to a month, NOT the free-text "collection_month"
// field on the form — that field is manually typed by whoever logs the
// payment and isn't reliable enough to do balance math on.
// Rent rate for each month is looked up from guest_rent_history rather than
// assuming the guest's current rate applied retroactively — see that table
// for how changes get recorded (and backfilled for pre-existing guests).
async function computeGuestLedger(guest) {
  if (!guest.join_date) return { ledger: [], currentBalance: 0 };

  const [rentRows, historyRows] = await Promise.all([
    pool.query(
      `SELECT amount, collection_date FROM collections WHERE guest_id=$1 AND collection_type='rent' AND is_deleted=false AND status='confirmed' ORDER BY collection_date ASC`,
      [guest.id]
    ),
    pool.query(
      `SELECT monthly_rent, effective_from FROM guest_rent_history WHERE guest_id=$1 ORDER BY effective_from ASC`,
      [guest.id]
    )
  ]);

  const history = historyRows.rows.map(r => ({
    rent: parseFloat(r.monthly_rent) || 0,
    from: new Date(r.effective_from)
  }));
  const fallbackRent = parseFloat(guest.monthly_rent) || 0;

  // Finds the rate that was actually in effect for a given month, based on
  // the most recent history entry on or before that month's start. Falls
  // back to the guest's current rate if there's no history at all yet
  // (shouldn't normally happen post-migration, but kept as a safety net).
  function rateForMonth(monthStart) {
    if (history.length === 0) return fallbackRent;
    let applicable = history[0].rent;
    for (const h of history) {
      if (h.from <= monthStart) applicable = h.rent;
      else break;
    }
    return applicable;
  }

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
    const due = rateForMonth(cursor);
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
    const today = new Date().toISOString().split('T')[0];
    const [guests, rooms, beds, income, expenses, recentGuests, recentPayments,
           pendingVariance, checklistTotal, checklistDone, openComplaints] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM guests WHERE is_active=true'),
      pool.query(`SELECT COUNT(*) as total_rooms, COALESCE(SUM(total_beds),0) as total_beds FROM rooms WHERE is_active=true`),
      pool.query(`SELECT COALESCE(SUM(r.total_beds - COALESCE(occ.occupied,0)),0) as available FROM rooms r LEFT JOIN (SELECT room_id, COUNT(*) as occupied FROM guests WHERE is_active=true AND room_id IS NOT NULL GROUP BY room_id) occ ON r.id=occ.room_id WHERE r.is_active=true`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND DATE_TRUNC('month',collection_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND DATE_TRUNC('month',purchase_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.is_active=true ORDER BY g.created_at DESC LIMIT 5`),
      pool.query(`SELECT c.*,g.name as guest_name FROM collections c LEFT JOIN guests g ON c.guest_id=g.id WHERE c.is_deleted=false AND c.status='confirmed' ORDER BY c.collection_date DESC LIMIT 5`),
      pool.query(`SELECT g.id, g.name, g.monthly_rent, r.room_number, r.monthly_rent as room_rent FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.is_active=true AND g.rent_variance_approved=false`),
      pool.query(`SELECT COUNT(*) as total FROM checklist_items WHERE is_active=true`),
      pool.query(`SELECT COUNT(*) as done FROM checklist_log WHERE log_date=$1 AND is_checked=true`, [today]),
      pool.query(`SELECT COUNT(*) as open FROM complaints WHERE status != 'resolved'`)
    ]);
    const totalBeds = parseInt(rooms.rows[0].total_beds) || 0;
    const availBeds = parseInt(beds.rows[0].available) || 0;
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    const total = parseInt(checklistTotal.rows[0].total) || 0;
    const done = parseInt(checklistDone.rows[0].done) || 0;
    res.json({
      totalGuests: parseInt(guests.rows[0].count),
      totalRooms: parseInt(rooms.rows[0].total_rooms),
      totalBeds, availableBeds: availBeds,
      occupancyPercent: totalBeds > 0 ? Math.round(((totalBeds - availBeds) / totalBeds) * 100) : 0,
      monthlyIncome: inc, monthlyExpenses: exp, netProfit: inc - exp,
      recentGuests: recentGuests.rows, recentPayments: recentPayments.rows,
      pendingVariance: pendingVariance.rows,
      todayChecklist: { total, checked: done, percent: total > 0 ? Math.round((done/total)*100) : 0 },
      openComplaints: parseInt(openComplaints.rows[0].open) || 0
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
    let q = `SELECT g.*,r.room_number,r.monthly_rent as room_rent FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE 1=1`;
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
    const g = await pool.query(`SELECT g.*,r.room_number,r.monthly_rent as room_rent FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.id=$1`, [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = await pool.query('SELECT * FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC', [req.params.id]);
    res.json({ ...g.rows[0], payments: c.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/guests', auth, async (req, res) => {
  const { name,phone,email,emergency_contact,emergency_contact_name,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes,address,expected_checkout } = req.body;
  if (!name || !join_date) return res.status(400).json({ error: 'Name and join date required' });
  try {
    // If this guest's rent doesn't match their room's standard per-bed rate,
    // flag it. Admin setting a custom rate is self-authorizing; staff doing
    // the same needs admin to sign off before it's considered approved.
    let rentVarianceApproved = true;
    if (room_id) {
      const room = await pool.query('SELECT monthly_rent FROM rooms WHERE id=$1', [room_id]);
      if (room.rows[0] && parseFloat(room.rows[0].monthly_rent) !== parseFloat(monthly_rent || 0)) {
        rentVarianceApproved = req.user.role === 'admin';
      }
    }

    const r = await pool.query(
      `INSERT INTO guests(name,phone,email,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes,created_by,rent_variance_approved,address,expected_checkout,emergency_contact_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [name,phone,email,emergency_contact,id_proof_type||null,id_proof_number||null,room_id||null,bed_number||null,join_date,monthly_rent||0,deposit_amount||0,notes,req.user.id,rentVarianceApproved,address||null,expected_checkout||null,emergency_contact_name||null]);
    // Every resident gets a stable, readable number for her ID card.
    if (!r.rows[0].resident_no) {
      const num = await pool.query(`UPDATE guests SET resident_no='SM'||LPAD(id::text,4,'0') WHERE id=$1 RETURNING resident_no`, [r.rows[0].id]);
      r.rows[0].resident_no = num.rows[0].resident_no;
    }
    if (parseFloat(monthly_rent) > 0) {
      await pool.query(
        `INSERT INTO guest_rent_history(guest_id, monthly_rent, effective_from, changed_by, note) VALUES($1,$2,$3,$4,$5)`,
        [r.rows[0].id, monthly_rent, join_date, req.user.id, 'Initial rate at check-in']
      );
    }
    // Auto-log the deposit as a real Collection, so it's not just a number
    // on the guest's profile with no matching transaction — this is what
    // keeps the balance sheet's deposit reconciliation accurate without
    // needing a separate manual entry every time.
    if (parseFloat(deposit_amount) > 0) {
      const depositStatus = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
      await pool.query(
        `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_type,payment_mode,description,created_by,status) VALUES($1,$2,$3,$4,'deposit','cash','Security deposit at check-in',$5,$6)`,
        [r.rows[0].id, name, deposit_amount, join_date, req.user.id, depositStatus]
      );
    }
    await logActivity(req, 'guest_add', `${name}${room_id?' (room assigned)':''}${!rentVarianceApproved?' — rent differs from room rate, pending approval':''}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/guests/:id', auth, async (req, res) => {
  const { name,phone,email,emergency_contact,emergency_contact_name,room_id,bed_number,monthly_rent,deposit_amount,notes,leave_date,is_active,rent_effective_from,address,id_proof_type,id_proof_number,expected_checkout } = req.body;
  try {
    const existing = await pool.query('SELECT monthly_rent,deposit_amount FROM guests WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const oldRent = parseFloat(existing.rows[0].monthly_rent) || 0;
    const newRent = monthly_rent !== undefined && monthly_rent !== null ? parseFloat(monthly_rent) : oldRent;
    const oldDeposit = parseFloat(existing.rows[0].deposit_amount) || 0;
    const newDeposit = deposit_amount !== undefined && deposit_amount !== null ? parseFloat(deposit_amount) : oldDeposit;

    // Recompute the rent-variance flag against whichever room is being set,
    // same rule as guest creation: admin's own edit self-authorizes, staff's
    // edit needs admin sign-off if it creates a mismatch.
    let rentVarianceApproved = true;
    if (room_id) {
      const room = await pool.query('SELECT monthly_rent FROM rooms WHERE id=$1', [room_id]);
      if (room.rows[0] && parseFloat(room.rows[0].monthly_rent) !== newRent) {
        rentVarianceApproved = req.user.role === 'admin';
      }
    }

    const r = await pool.query(
      `UPDATE guests SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),emergency_contact=COALESCE($4,emergency_contact),room_id=$5,bed_number=$6,monthly_rent=COALESCE($7,monthly_rent),deposit_amount=COALESCE($8,deposit_amount),notes=COALESCE($9,notes),leave_date=$10,is_active=COALESCE($11,is_active),rent_variance_approved=$12,
              address=COALESCE($14,address),id_proof_type=COALESCE($15,id_proof_type),id_proof_number=COALESCE($16,id_proof_number),
              expected_checkout=COALESCE($17,expected_checkout),emergency_contact_name=COALESCE($18,emergency_contact_name)
        WHERE id=$13 RETURNING *`,
      [name,phone,email,emergency_contact,room_id||null,bed_number||null,monthly_rent,deposit_amount,notes,leave_date||null,is_active,rentVarianceApproved,req.params.id,
       address === undefined ? null : address, id_proof_type === undefined ? null : id_proof_type, id_proof_number === undefined ? null : id_proof_number,
       expected_checkout === undefined ? null : expected_checkout, emergency_contact_name === undefined ? null : emergency_contact_name]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });

    if (newRent !== oldRent && newRent > 0) {
      const effectiveFrom = rent_effective_from || new Date().toISOString().split('T')[0];
      await pool.query(
        `INSERT INTO guest_rent_history(guest_id, monthly_rent, effective_from, changed_by) VALUES($1,$2,$3,$4)`,
        [req.params.id, newRent, effectiveFrom, req.user.id]
      );
      await logActivity(req, 'rent_change', `${r.rows[0].name}: ₹${oldRent} → ₹${newRent}, effective ${effectiveFrom}${!rentVarianceApproved?' — differs from room rate, pending approval':''}`);
    }

    // If the deposit went UP, log the difference as a real collection (e.g.
    // a top-up payment) so it stays reconciled. A decrease isn't
    // auto-logged — a negative deposit entry would be confusing; correct
    // those directly on the original Collection entry instead.
    if (newDeposit > oldDeposit) {
      const depositStatus = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
      await pool.query(
        `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_type,payment_mode,description,created_by,status) VALUES($1,$2,$3,CURRENT_DATE,'deposit','cash','Additional deposit top-up',$4,$5)`,
        [req.params.id, r.rows[0].name, newDeposit - oldDeposit, req.user.id, depositStatus]
      );
      await logActivity(req, 'deposit_topup', `${r.rows[0].name}: +₹${newDeposit - oldDeposit} deposit`);
    }

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin sign-off on a rent that differs from the room's standard rate.
router.put('/guests/:id/approve-rent', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE guests SET rent_variance_approved=true WHERE id=$1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'rent_variance_approved', `${r.rows[0].name}: ₹${r.rows[0].monthly_rent}/mo approved`);
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
  const { deductions, deduction_notes, refund_mode, leave_date } = req.body;
  // The date may be backdated (she left on Sunday, it is recorded on Tuesday)
  // but never set in the future.
  const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (leave_date && !isDate(leave_date)) return res.status(400).json({ error: 'leave_date must be YYYY-MM-DD' });
  if (leave_date && leave_date > istToday()) return res.status(400).json({ error: 'Checkout date cannot be in the future' });
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
    await pool.query('UPDATE guests SET is_active=false, leave_date=COALESCE($2::date, $3::date) WHERE id=$1', [guest.id, leave_date || null, istToday()]);
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

router.get('/collections/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `SELECT c.*,g.name as guest_name,r.room_number FROM collections c LEFT JOIN guests g ON c.guest_id=g.id LEFT JOIN rooms r ON g.room_id=r.id WHERE c.is_deleted=false AND c.status='confirmed'`;
    const p = [];
    if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM c.collection_date)=$${p.length-1} AND EXTRACT(YEAR FROM c.collection_date)=$${p.length}`; }
    q += ' ORDER BY c.collection_date ASC';
    const r = await pool.query(q, p);
    const total = r.rows.reduce((s,x) => s + parseFloat(x.amount), 0);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-collections-${month||'all'}-${year||'all'}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Collections', { align: 'center' });
    if (month && year) doc.fontSize(9).fillColor('#666').text(new Date(year, month-1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }), { align: 'center' }).fillColor('#000');
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text(`Total: ${fmtMoney(total)}`);
    doc.moveDown(1);

    drawPdfTable(doc, [
      { label: 'Date', x: 40, width: 60, get: r => fmtD(r.collection_date) },
      { label: 'Type', x: 105, width: 60, get: r => r.collection_type },
      { label: 'Guest / From', x: 170, width: 110, get: r => r.guest_name },
      { label: 'Description', x: 285, width: 130, get: r => r.description || r.collection_month },
      { label: 'Mode', x: 420, width: 55, get: r => r.payment_mode },
      { label: 'Amount', x: 480, width: 75, get: r => fmtMoney(r.amount) }
    ], r.rows);

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

router.post('/collections', auth, async (req, res) => {
  const src = ['manual','voice','photo','copilot'].includes(req.body.source) ? req.body.source : 'manual';
  const { guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  try {
    // Staff entries need an admin's sign-off before they count as confirmed
    // income; admin's own entries are trusted immediately. This is separate
    // from the guest UPI self-reporting flow, which uses 'pending_verification'.
    const status = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
    const r = await pool.query(
      `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number,created_by,status,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [guest_id||null,guest_name,amount,collection_date||new Date(),collection_month,collection_type||'rent',payment_mode||'cash',description,receipt_number,req.user.id,status, src]);
    await logActivity(req, 'collection_add', `₹${amount} ${collection_type||'rent'} from ${guest_name||'guest #'+guest_id}${status==='pending_approval'?' (pending approval)':''}`);
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

// Confirms a guest's self-reported UPI payment claim after the admin has
// checked it actually landed in their bank/UPI app. Rejecting one (it never
// arrived, or was a mistake) reuses the delete route above — same end state.
router.put('/collections/:id/confirm', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`UPDATE collections SET status='confirmed' WHERE id=$1 AND is_deleted=false RETURNING *`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'upi_claim_confirmed', `₹${r.rows[0].amount} from ${r.rows[0].guest_name||'guest #'+r.rows[0].guest_id}`);
    res.json(r.rows[0]);
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

router.get('/purchases/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const { month, year } = req.query;
    let q = `SELECT * FROM purchases WHERE is_deleted=false AND status='confirmed'`;
    const p = [];
    if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM purchase_date)=$${p.length-1} AND EXTRACT(YEAR FROM purchase_date)=$${p.length}`; }
    q += ' ORDER BY purchase_date ASC';
    const r = await pool.query(q, p);
    const total = r.rows.reduce((s,x) => s + parseFloat(x.amount), 0);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-purchases-${month||'all'}-${year||'all'}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Purchases', { align: 'center' });
    if (month && year) doc.fontSize(9).fillColor('#666').text(new Date(year, month-1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }), { align: 'center' }).fillColor('#000');
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text(`Total: ${fmtMoney(total)}`);
    doc.moveDown(1);

    drawPdfTable(doc, [
      { label: 'Date', x: 40, width: 60, get: r => fmtD(r.purchase_date) },
      { label: 'Category', x: 105, width: 80, get: r => r.category },
      { label: 'Description', x: 190, width: 140, get: r => r.description },
      { label: 'Paid To', x: 335, width: 90, get: r => r.paid_to },
      { label: 'Mode', x: 430, width: 55, get: r => r.payment_mode },
      { label: 'Amount', x: 490, width: 65, get: r => fmtMoney(r.amount) }
    ], r.rows);

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

router.post('/purchases', auth, async (req, res) => {
  const src = ['manual','voice','photo','copilot'].includes(req.body.source) ? req.body.source : 'manual';
  const { amount,category,description,purchase_date,paid_to,payment_mode,receipt_number } = req.body;
  if (!amount || !category) return res.status(400).json({ error: 'Amount and category required' });
  try {
    // Staff entries need an admin's sign-off before they count as confirmed
    // spend; admin's own entries are trusted immediately.
    const status = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
    const r = await pool.query(
      `INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,receipt_number,created_by,status,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [amount,category,description,purchase_date||new Date(),paid_to,payment_mode||'cash',receipt_number,req.user.id,status, src]);
    await logActivity(req, 'purchase_add', `₹${amount} ${category}${paid_to ? ' to '+paid_to : ''}${status==='pending_approval'?' (pending approval)':''}`);
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

// Approves a staff-entered purchase after admin review. Rejecting one reuses
// the delete route above — same end state, already logged there.
router.put('/purchases/:id/confirm', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`UPDATE purchases SET status='confirmed' WHERE id=$1 AND is_deleted=false RETURNING *`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'purchase_approved', `₹${r.rows[0].amount} ${r.rows[0].category}`);
    res.json(r.rows[0]);
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
    const { month, year, from, to } = req.query;
    let dateFrom, dateTo;
    if (from && to) {
      dateFrom = from;
      dateTo = to;
    } else {
      const m = month || new Date().getMonth() + 1;
      const y = year || new Date().getFullYear();
      dateFrom = `${y}-${String(m).padStart(2,'0')}-01`;
      dateTo = new Date(y, m, 0).toISOString().split('T')[0]; // last day of that month
    }
    res.json(await computeReportData(dateFrom, dateTo));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The one place month/range income & expense totals are computed. The
// Reports screen, the CSV/PDF exports and the Sprint 5 owner report all call
// this, so they cannot disagree with each other.
async function computeReportData(dateFrom, dateTo) {
  const [income, expenses, incomeBreakdown, expenseBreakdown] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2`, [dateFrom, dateTo]),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2`, [dateFrom, dateTo]),
    pool.query(`SELECT collection_type, COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2 GROUP BY collection_type`, [dateFrom, dateTo]),
    pool.query(`SELECT category, COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2 GROUP BY category ORDER BY total DESC`, [dateFrom, dateTo])
  ]);
  const inc = parseFloat(income.rows[0].total);
  const exp = parseFloat(expenses.rows[0].total);
  return { totalIncome: inc, totalExpenses: exp, netProfit: inc - exp, incomeBreakdown: incomeBreakdown.rows, expenseBreakdown: expenseBreakdown.rows, dateFrom, dateTo };
}

// Month-by-month totals for the N months ending at `end` (a Date). Shared by
// the trend chart and the owner forecast.
async function computeTrend(months, end) {
  const now = end || new Date();
  const result = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const [inc, exp] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND EXTRACT(MONTH FROM collection_date)=$1 AND EXTRACT(YEAR FROM collection_date)=$2`, [m, y]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND EXTRACT(MONTH FROM purchase_date)=$1 AND EXTRACT(YEAR FROM purchase_date)=$2`, [m, y])
    ]);
    const income = parseFloat(inc.rows[0].total);
    const expenses = parseFloat(exp.rows[0].total);
    result.push({ month: `${y}-${String(m).padStart(2,'0')}`, label: d.toLocaleString('en-IN', { month: 'short', year: 'numeric' }), income, expenses, net: income - expenses });
  }
  return result;
}

// Month-by-month income/expense for charting trends. Sequential per-month
// queries rather than one fancy GROUP BY — simpler to read and verify
// correct, and the guest-house scale here means performance is a non-issue.
router.get('/reports/trend', auth, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 6, 24);
    res.json(await computeTrend(months));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Combined income+expense transaction export, sorted chronologically — for
// handing to an accountant. Admin only since it's a full financial export.
router.get('/reports/export/csv', auth, requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });
  try {
    const [collections, purchases] = await Promise.all([
      pool.query(`SELECT collection_date as date, collection_type as category, description, guest_name as party, amount, payment_mode FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2 ORDER BY collection_date`, [from, to]),
      pool.query(`SELECT purchase_date as date, category, description, paid_to as party, amount, payment_mode FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2 ORDER BY purchase_date`, [from, to])
    ]);
    const rows = [
      ...collections.rows.map(r => ({ ...r, type: 'Income' })),
      ...purchases.rows.map(r => ({ ...r, type: 'Expense' }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      return (str.includes(',') || str.includes('"') || str.includes('\n'))
        ? '"' + str.replace(/"/g, '""') + '"'
        : str;
    };

    const lines = [['Date','Type','Category','Description','Guest / Paid To','Amount','Mode'].join(',')];
    for (const r of rows) {
      lines.push([
        new Date(r.date).toLocaleDateString('en-IN'),
        r.type,
        r.category,
        r.description || '',
        r.party || '',
        r.amount,
        r.payment_mode
      ].map(escapeCsv).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-transactions-${from}-to-${to}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Formatted P&L PDF for handing to an accountant. Admin only.
router.get('/reports/export/pdf', auth, requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });
  try {
    const [income, expenses, incomeBreakdown, expenseBreakdown, collections, purchases] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2`, [from, to]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2`, [from, to]),
      pool.query(`SELECT collection_type, COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2 GROUP BY collection_type`, [from, to]),
      pool.query(`SELECT category, COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2 GROUP BY category`, [from, to]),
      pool.query(`SELECT collection_date as date, collection_type as category, description, guest_name as party, amount FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2 ORDER BY collection_date`, [from, to]),
      pool.query(`SELECT purchase_date as date, category, description, paid_to as party, amount FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2 ORDER BY purchase_date`, [from, to])
    ]);
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    const transactions = [
      ...collections.rows.map(r => ({ ...r, type: 'Income' })),
      ...purchases.rows.map(r => ({ ...r, type: 'Expense' }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    // fmtMoney and fmtD are now module-level helpers, shared across all PDF export routes.

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-report-${from}-to-${to}.pdf"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Profit & Loss Report', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`${fmtD(from)} to ${fmtD(to)}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1.5);

    doc.fontSize(12).font('Helvetica-Bold').text('Summary');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Income: ${fmtMoney(inc)}`);
    doc.text(`Total Expenses: ${fmtMoney(exp)}`);
    doc.font('Helvetica-Bold').text(`Net Profit / Loss: ${fmtMoney(inc - exp)}`);
    doc.font('Helvetica');
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').text('Income Breakdown');
    doc.fontSize(10).font('Helvetica');
    if (incomeBreakdown.rows.length === 0) doc.fillColor('#666').text('No income in this period').fillColor('#000');
    incomeBreakdown.rows.forEach(r => doc.text(`${r.collection_type}: ${fmtMoney(r.total)}`));
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').text('Expense Breakdown');
    doc.fontSize(10).font('Helvetica');
    if (expenseBreakdown.rows.length === 0) doc.fillColor('#666').text('No expenses in this period').fillColor('#000');
    expenseBreakdown.rows.forEach(r => doc.text(`${r.category}: ${fmtMoney(r.total)}`));
    doc.moveDown(1.5);

    doc.fontSize(12).font('Helvetica-Bold').text('Transactions');
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica-Bold');
    const colX = { date: 40, type: 105, cat: 160, desc: 250, party: 380, amt: 480 };
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    function drawHeader() {
      const y = doc.y;
      doc.text('Date', colX.date, y).text('Type', colX.type, y).text('Category', colX.cat, y)
        .text('Description', colX.desc, y).text('Party', colX.party, y).text('Amount', colX.amt, y);
      doc.moveDown(0.5);
      doc.font('Helvetica');
    }
    drawHeader();
    doc.fontSize(8);
    for (const t of transactions) {
      if (doc.y > pageBottom - 20) {
        doc.addPage();
        doc.fontSize(8).font('Helvetica-Bold');
        drawHeader();
      }
      const y = doc.y;
      doc.fillColor(t.type === 'Income' ? '#0a7a3e' : '#b91c1c');
      doc.text(fmtD(t.date), colX.date, y, { width: 60 })
        .text(t.type, colX.type, y, { width: 50 })
        .text(String(t.category||''), colX.cat, y, { width: 85 })
        .text(String(t.description||'—'), colX.desc, y, { width: 125 })
        .text(String(t.party||'—'), colX.party, y, { width: 95 })
        .text(fmtMoney(t.amount), colX.amt, y);
      doc.fillColor('#000');
      doc.moveDown(0.4);
    }
    if (transactions.length === 0) doc.fillColor('#666').text('No transactions in this period').fillColor('#000');

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── FIXED ASSETS (admin only) ─────────────────────
router.get('/fixed-assets', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM fixed_assets WHERE is_deleted=false ORDER BY purchase_date DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/fixed-assets', auth, requireAdmin, async (req, res) => {
  const { name, category, purchase_date, value, notes } = req.body;
  if (!name || !purchase_date || !value) return res.status(400).json({ error: 'Name, purchase date, and value are required' });
  try {
    const r = await pool.query(
      `INSERT INTO fixed_assets(name,category,purchase_date,value,notes,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, category||'Other', purchase_date, value, notes, req.user.id]
    );
    await logActivity(req, 'fixed_asset_add', `${name} — ₹${value}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/fixed-assets/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE fixed_assets SET is_deleted=true,deleted_by=$1,deleted_at=NOW() WHERE id=$2 AND is_deleted=false RETURNING *', [req.user.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'fixed_asset_delete', `${r.rows[0].name} (id ${req.params.id})`);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CAPITAL TRANSACTIONS (admin only) ─────────────
// Tracks money the owner has put into (positive) or taken out of (negative)
// the business — the "Equity" side of the balance sheet, separate from
// day-to-day rent/purchases.
router.get('/capital-transactions', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, u.username FROM capital_transactions c LEFT JOIN users u ON c.created_by=u.id ORDER BY c.transaction_date DESC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/capital-transactions', auth, requireAdmin, async (req, res) => {
  const { amount, transaction_date, note } = req.body;
  if (!amount || !transaction_date) return res.status(400).json({ error: 'Amount and date are required' });
  try {
    const r = await pool.query(
      `INSERT INTO capital_transactions(amount,transaction_date,note,created_by) VALUES($1,$2,$3,$4) RETURNING *`,
      [amount, transaction_date, note, req.user.id]
    );
    await logActivity(req, 'capital_transaction_add', `₹${amount} on ${transaction_date}${note?' — '+note:''}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/capital-transactions/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM capital_transactions WHERE id=$1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'capital_transaction_delete', `₹${r.rows[0].amount} on ${r.rows[0].transaction_date}`);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BALANCE SHEET (admin only) ────────────────────
// Cash-basis, deliberately — matches how Reports already recognizes income
// (when collected, not when earned), so this stays internally consistent
// rather than mixing cash and accrual accounting. That means rent owed but
// not yet paid does NOT appear here as a receivable (see Rent Due for that);
// including it would require accrual-basis P&L too, which Reports isn't.
//
// reconciliation_diff compares deposits collected-minus-refunded (from the
// collections/deposit_refunds transaction history) against deposits_held
// (from guests' current deposit_amount). These SHOULD match if every
// deposit was logged as a collection and every checkout went through the
// refund flow — a non-zero value here means real data to go investigate,
// not a bug in this calculation, and balance_check will show the same gap
// rather than silently forcing a balance.
async function computeBalanceSheetData(asOf) {
  const [
    collectionsTotalR, depositsCollectedR, purchasesTotalR,
    depositRefundsTotalR, fixedAssetsTotalR, depositsHeldR, capitalNetR,
    fixedAssetsList
  ] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date <= $1`, [asOf]),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_type='deposit' AND collection_date <= $1`, [asOf]),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date <= $1`, [asOf]),
    pool.query(`SELECT COALESCE(SUM(refund_amount),0) as total FROM deposit_refunds WHERE created_at::date <= $1`, [asOf]),
    pool.query(`SELECT COALESCE(SUM(value),0) as total FROM fixed_assets WHERE is_deleted=false AND purchase_date <= $1`, [asOf]),
    pool.query(`SELECT COALESCE(SUM(deposit_amount),0) as total FROM guests WHERE is_active=true`),
    pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM capital_transactions WHERE transaction_date <= $1`, [asOf]),
    pool.query(`SELECT * FROM fixed_assets WHERE is_deleted=false AND purchase_date <= $1 ORDER BY purchase_date DESC`, [asOf])
  ]);

  const collectionsTotal = parseFloat(collectionsTotalR.rows[0].total);
  const depositsCollected = parseFloat(depositsCollectedR.rows[0].total);
  const purchasesTotal = parseFloat(purchasesTotalR.rows[0].total);
  const depositRefundsTotal = parseFloat(depositRefundsTotalR.rows[0].total);
  const fixedAssetsTotal = parseFloat(fixedAssetsTotalR.rows[0].total);
  const depositsHeld = parseFloat(depositsHeldR.rows[0].total);
  const capitalNet = parseFloat(capitalNetR.rows[0].total);

  const cashPosition = capitalNet + collectionsTotal - purchasesTotal - depositRefundsTotal - fixedAssetsTotal;
  const totalAssets = cashPosition + fixedAssetsTotal;

  const retainedEarnings = (collectionsTotal - depositsCollected) - purchasesTotal;
  const totalEquity = capitalNet + retainedEarnings;
  const totalLiabilities = depositsHeld;

  const reconciliationDiff = (depositsCollected - depositRefundsTotal) - depositsHeld;
  const balanceCheck = totalAssets - (totalLiabilities + totalEquity);

  return {
    asOf,
    assets: { cashPosition, fixedAssets: fixedAssetsTotal, total: totalAssets },
    liabilities: { depositsHeld, total: totalLiabilities },
    equity: { capitalNet, retainedEarnings, total: totalEquity },
    reconciliationDiff,
    balanceCheck,
    fixedAssetsList: fixedAssetsList.rows
  };
}

router.get('/balance-sheet', auth, requireAdmin, async (req, res) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().split('T')[0];
    res.json(await computeBalanceSheetData(asOf));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/balance-sheet/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const asOf = req.query.asOf || new Date().toISOString().split('T')[0];
    const bs = await computeBalanceSheetData(asOf);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-balance-sheet-${asOf}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Balance Sheet', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`As of ${fmtD(asOf)}`, { align: 'center' }).fillColor('#000');
    doc.moveDown(1.5);

    if (Math.abs(bs.reconciliationDiff) > 0.5) {
      doc.fontSize(9).fillColor('#92400E').text(`Note: reconciliation gap of ${fmtMoney(Math.abs(bs.reconciliationDiff))} between deposits collected/refunded and deposits currently held — worth checking guest deposit records.`, { width: 515 }).fillColor('#000');
      doc.moveDown(1);
    }

    doc.fontSize(12).font('Helvetica-Bold').text('Assets');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Cash Position: ${fmtMoney(bs.assets.cashPosition)}`);
    doc.text(`Fixed Assets (at cost): ${fmtMoney(bs.assets.fixedAssets)}`);
    doc.font('Helvetica-Bold').text(`Total Assets: ${fmtMoney(bs.assets.total)}`);
    doc.font('Helvetica');
    doc.moveDown(1);

    doc.fontSize(12).font('Helvetica-Bold').text('Liabilities & Equity');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Security Deposits Held: ${fmtMoney(bs.liabilities.depositsHeld)}`);
    doc.text(`Capital (net): ${fmtMoney(bs.equity.capitalNet)}`);
    doc.text(`Retained Earnings: ${fmtMoney(bs.equity.retainedEarnings)}`);
    doc.font('Helvetica-Bold').text(`Total: ${fmtMoney(bs.liabilities.total + bs.equity.total)}`);
    doc.font('Helvetica');
    doc.moveDown(1.5);

    doc.fontSize(12).font('Helvetica-Bold').text('Fixed Assets Detail');
    doc.moveDown(0.3);
    drawPdfTable(doc, [
      { label: 'Date', x: 40, width: 60, get: r => fmtD(r.purchase_date) },
      { label: 'Name', x: 105, width: 140, get: r => r.name },
      { label: 'Category', x: 250, width: 90, get: r => r.category },
      { label: 'Value', x: 345, width: 70, get: r => fmtMoney(r.value) },
      { label: 'Notes', x: 420, width: 135, get: r => r.notes }
    ], bs.fixedAssetsList);

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// ── PUBLIC GUEST LOOKUP ──────────────────────────
router.get('/guest-lookup', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.phone=$1 LIMIT 1`, [phone]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = await pool.query('SELECT amount,collection_date,collection_type,payment_mode FROM collections WHERE guest_id=$1 AND is_deleted=false AND status=\'confirmed\' ORDER BY collection_date DESC LIMIT 12', [g.rows[0].id]);
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
async function computeRentDueList() {
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
      join_date: guest.join_date,
      current_balance: currentBalance,
      amount_due: currentBalance < 0 ? Math.abs(currentBalance) : 0,
      credit: currentBalance > 0 ? currentBalance : 0
    });
  }
  results.sort((a, b) => b.amount_due - a.amount_due);
  return results;
}

router.get('/rent-due', auth, async (req, res) => {
  try {
    res.json(await computeRentDueList());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rent-due/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const list = await computeRentDueList();
    const totalDue = list.reduce((s,g) => s + parseFloat(g.amount_due), 0);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-rent-due-${new Date().toISOString().split('T')[0]}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Rent Due', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`As of ${fmtD(new Date())}`, { align: 'center' }).fillColor('#000');
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text(`Total Outstanding: ${fmtMoney(totalDue)}`);
    doc.moveDown(1);

    drawPdfTable(doc, [
      { label: 'Name', x: 40, width: 110, get: r => r.name },
      { label: 'Room', x: 155, width: 60, get: r => r.room_number ? 'Room '+r.room_number : '—' },
      { label: 'Phone', x: 220, width: 90, get: r => r.phone },
      { label: 'Monthly Rent', x: 315, width: 80, get: r => fmtMoney(r.monthly_rent) },
      { label: 'Balance', x: 400, width: 90, get: r => parseFloat(r.amount_due) > 0 ? fmtMoney(r.amount_due) + ' due' : parseFloat(r.credit) > 0 ? fmtMoney(r.credit) + ' credit' : 'Settled', color: r => parseFloat(r.amount_due) > 0 ? '#b91c1c' : '#0a7a3e' },
      { label: 'Status', x: 495, width: 60, get: r => parseFloat(r.amount_due) > 0 ? 'Pending' : 'OK' }
    ], list);

    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
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

router.get('/guests/:id/rent-history', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT h.*, u.username FROM guest_rent_history h LEFT JOIN users u ON h.changed_by=u.id WHERE h.guest_id=$1 ORDER BY h.effective_from ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually record a rate change that happened before this feature existed
// (so there's no automatic record of it). Admin only, since it directly
// changes historical financial calculations for that guest.
router.post('/guests/:id/rent-history', auth, requireAdmin, async (req, res) => {
  const { monthly_rent, effective_from, note } = req.body;
  if (!monthly_rent || !effective_from) return res.status(400).json({ error: 'Monthly rent and effective date are required' });
  try {
    const g = await pool.query('SELECT name FROM guests WHERE id=$1', [req.params.id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Guest not found' });
    const r = await pool.query(
      `INSERT INTO guest_rent_history(guest_id, monthly_rent, effective_from, changed_by, note) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, monthly_rent, effective_from, req.user.id, note || 'Manually backfilled']
    );
    await logActivity(req, 'rent_history_backfill', `${g.rows[0].name}: ₹${monthly_rent} effective ${effective_from}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APP SETTINGS (admin only) ─────────────────────
router.get('/settings', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM app_settings');
    const settings = {};
    r.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', auth, requireAdmin, async (req, res) => {
  try {
    const entries = Object.entries(req.body || {});
    if (entries.length === 0) return res.status(400).json({ error: 'No settings provided' });
    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO app_settings(key, value, updated_by, updated_at) VALUES($1,$2,$3,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=NOW()`,
        [key, value, req.user.id]
      );
    }
    await logActivity(req, 'settings_update', entries.map(([k]) => k).join(', '));
    res.json({ message: 'Settings saved' });
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

// For removing test or erroneous refund records — a real, intentional
// checkout shouldn't normally be deleted, but mistakes during testing or
// data entry need a way to be cleaned up. Logged either way.
router.delete('/deposit-refunds/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM deposit_refunds WHERE id=$1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'deposit_refund_delete', `${r.rows[0].guest_name} — ₹${r.rows[0].refund_amount} (id ${req.params.id})`);
    res.json({ message: 'Deleted' });
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
    const [room, payments, menu, announcements, settingsRows, ledgerResult] = await Promise.all([
      g.room_id ? pool.query('SELECT room_number FROM rooms WHERE id=$1', [g.room_id]) : { rows: [{}] },
      pool.query('SELECT * FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC LIMIT 24', [g.id]),
      pool.query('SELECT * FROM daily_menu ORDER BY CASE day_of_week WHEN \'Monday\' THEN 1 WHEN \'Tuesday\' THEN 2 WHEN \'Wednesday\' THEN 3 WHEN \'Thursday\' THEN 4 WHEN \'Friday\' THEN 5 WHEN \'Saturday\' THEN 6 WHEN \'Sunday\' THEN 7 END'),
      pool.query('SELECT * FROM announcements WHERE is_active=true ORDER BY created_at DESC LIMIT 10'),
      pool.query(`SELECT key, value FROM app_settings WHERE key IN ('upi_vpa','upi_name','pg_name','pg_phone')`),
      computeGuestLedger(g)
    ]);
    const settings = {};
    settingsRows.rows.forEach(row => { settings[row.key] = row.value; });
    res.json({
      ...g,
      password_hash: undefined,
      room_number: room.rows[0]?.room_number,
      payments: payments.rows,
      menu: menu.rows,
      announcements: announcements.rows,
      upi_vpa: settings.upi_vpa || null,
      upi_name: settings.upi_name || null,
      pg_name: settings.pg_name || 'Siri Mane PG',
      pg_phone: settings.pg_phone || null,
      current_balance: ledgerResult.currentBalance
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

// POST /api/guest-upi-claim — resident reports "I've paid" after using the
// UPI link. This does NOT count as confirmed income anywhere (dashboard,
// ledger, reports) until an admin confirms it actually arrived.
router.post('/guest-upi-claim', guestAuth, async (req, res) => {
  const { amount } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  try {
    const g = req.guest;
    const r = await pool.query(
      `INSERT INTO collections(guest_id, guest_name, amount, collection_date, collection_type, payment_mode, status, reported_by_guest, description)
       VALUES($1,$2,$3,NOW(),'rent','UPI','pending_verification',true,'Self-reported by resident via UPI link') RETURNING *`,
      [g.id, g.name, amt]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SPRINT 0 (Sep 2026) — routes the frontend already calls but that were
// missing from the deployed backend: Daily Checklist, Complaint / Maintenance
// Register, Room Shift history, and the A5 payment receipt PDF.
// Tables come from migrate-checklist.js, migrate-complaints.js and
// migrate-room-shift.js (run `node backend/scripts/migrate-all.js`).
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'siri-mane-logo.jpg');

// IST calendar date "YYYY-MM-DD" — the server runs in UTC on Railway, but the
// warden's "today" is Indian time. Every date default below uses this.
function istToday() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isYearMonth = s => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
const CHECKLIST_SECTIONS = ['Morning', 'Mid-Day', 'Evening', 'Night', 'Closing'];
const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved'];

// ── DAILY WARDEN CHECKLIST ───────────────────────────────────────────────────

// GET /checklist?date=YYYY-MM-DD  → { date, summary:{checked,total,percent}, sections:[{label,items:[...]}] }
router.get('/checklist', auth, async (req, res) => {
  try {
    const date = isIsoDate(req.query.date) ? req.query.date : istToday();
    const r = await pool.query(
      `SELECT i.id, i.section, i.time_label, i.task, i.sort_order,
              COALESCE(l.is_checked,false) AS is_checked, l.checked_at,
              u.username AS checked_by_username
         FROM checklist_items i
         LEFT JOIN checklist_log l ON l.item_id=i.id AND l.log_date=$1
         LEFT JOIN users u ON u.id=l.checked_by
        WHERE i.is_active=true
        ORDER BY i.sort_order, i.id`, [date]);
    const bySection = {};
    for (const s of CHECKLIST_SECTIONS) bySection[s] = [];
    for (const row of r.rows) {
      if (!bySection[row.section]) bySection[row.section] = [];
      bySection[row.section].push(row);
    }
    const sections = Object.keys(bySection)
      .filter(label => CHECKLIST_SECTIONS.includes(label) || bySection[label].length > 0)
      .map(label => ({ label, items: bySection[label] }));
    const total = r.rows.length;
    const checked = r.rows.filter(x => x.is_checked).length;
    res.json({ date, summary: { checked, total, percent: total ? Math.round(checked * 100 / total) : 0 }, sections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /checklist/summary?month=YYYY-MM   (or ?days=30)  → [{date,checked,total,percent}]
// Must be declared before /checklist/:itemId so "summary" isn't read as an id.
router.get('/checklist/summary', auth, async (req, res) => {
  try {
    let where, params;
    if (isYearMonth(req.query.month)) {
      where = `l.log_date >= $1::date AND l.log_date < ($1::date + INTERVAL '1 month')`;
      params = [req.query.month + '-01'];
    } else {
      const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 366);
      where = `l.log_date >= ($1::date - ($2 || ' days')::interval) AND l.log_date <= $1::date`;
      params = [istToday(), String(days)];
    }
    const [logs, totalRow] = await Promise.all([
      pool.query(`SELECT l.log_date::text AS date, COUNT(*) FILTER (WHERE l.is_checked) AS checked
                    FROM checklist_log l JOIN checklist_items i ON i.id=l.item_id AND i.is_active=true
                   WHERE ${where} GROUP BY l.log_date ORDER BY l.log_date DESC`, params),
      pool.query(`SELECT COUNT(*) AS total FROM checklist_items WHERE is_active=true`)
    ]);
    const total = parseInt(totalRow.rows[0].total) || 0;
    res.json(logs.rows.map(x => {
      const checked = parseInt(x.checked) || 0;
      return { date: x.date, checked, total, percent: total ? Math.round(checked * 100 / total) : 0 };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /checklist/:itemId  { date, checked }  — tick / untick one task for a day
router.put('/checklist/:itemId', auth, async (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId);
    const date = isIsoDate(req.body.date) ? req.body.date : istToday();
    const checked = !!req.body.checked;
    if (!itemId) return res.status(400).json({ error: 'Invalid item' });
    if (date > istToday()) return res.status(400).json({ error: 'Cannot tick a future date' });
    const item = await pool.query('SELECT id, task FROM checklist_items WHERE id=$1 AND is_active=true', [itemId]);
    if (!item.rows[0]) return res.status(404).json({ error: 'Task not found' });
    const r = await pool.query(
      `INSERT INTO checklist_log(item_id, log_date, is_checked, checked_by, checked_at)
       VALUES($1::int,$2::date,$3::boolean,$4::int,CASE WHEN $3::boolean THEN NOW() ELSE NULL END)
       ON CONFLICT (item_id, log_date) DO UPDATE
         SET is_checked=EXCLUDED.is_checked,
             checked_by=CASE WHEN EXCLUDED.is_checked THEN EXCLUDED.checked_by ELSE NULL END,
             checked_at=CASE WHEN EXCLUDED.is_checked THEN NOW() ELSE NULL END
       RETURNING *`, [itemId, date, checked, req.user.id]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Checklist task definitions (admin manages; staff can read)
router.get('/checklist-items', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM checklist_items WHERE is_active=true ORDER BY sort_order, id');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/checklist-items', auth, requireAdmin, async (req, res) => {
  const { section, time_label, task } = req.body;
  if (!task || !String(task).trim()) return res.status(400).json({ error: 'Task is required' });
  if (!CHECKLIST_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' });
  try {
    const next = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM checklist_items');
    const r = await pool.query(
      `INSERT INTO checklist_items(section, time_label, task, sort_order) VALUES($1,$2,$3,$4) RETURNING *`,
      [section, (time_label || '—').trim() || '—', String(task).trim(), next.rows[0].n]);
    await logActivity(req, 'checklist_item_add', `${section}: ${task}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/checklist-items/:id', auth, requireAdmin, async (req, res) => {
  const { section, time_label, task } = req.body;
  if (!task || !String(task).trim()) return res.status(400).json({ error: 'Task is required' });
  if (section && !CHECKLIST_SECTIONS.includes(section)) return res.status(400).json({ error: 'Invalid section' });
  try {
    const r = await pool.query(
      `UPDATE checklist_items SET section=COALESCE($1,section), time_label=$2, task=$3 WHERE id=$4 AND is_active=true RETURNING *`,
      [section || null, (time_label || '—').trim() || '—', String(task).trim(), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
    await logActivity(req, 'checklist_item_edit', `#${req.params.id}: ${task}`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// "Delete" is a soft-delete so past days' ticks keep their history.
router.delete('/checklist-items/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE checklist_items SET is_active=false WHERE id=$1 AND is_active=true RETURNING task', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Task not found' });
    await logActivity(req, 'checklist_item_remove', r.rows[0].task);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COMPLAINT / MAINTENANCE REGISTER ─────────────────────────────────────────

// GET /complaints?status=open|in_progress|resolved
router.get('/complaints', auth, async (req, res) => {
  try {
    const p = [];
    let q = 'SELECT * FROM complaints';
    if (COMPLAINT_STATUSES.includes(req.query.status)) { p.push(req.query.status); q += ' WHERE status=$1'; }
    q += ` ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC`;
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /complaints  { category, description, guest_name? }  (staff logging an issue seen on rounds)
router.post('/complaints', auth, async (req, res) => {
  const { category, description, guest_name } = req.body;
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Description is required' });
  try {
    // The form has one free-text "Room / Guest" box. If it matches an active
    // guest by name we link the record; if it looks like "Room 12" we keep the
    // room number; otherwise it's stored as typed.
    let guestId = null, guestName = guest_name ? String(guest_name).trim() : null, roomNumber = null;
    if (guestName) {
      const m = guestName.match(/^room\s*([a-z0-9-]+)$/i);
      if (m) { roomNumber = m[1]; guestName = null; }
      else {
        const g = await pool.query(
          `SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id
            WHERE g.is_active=true AND LOWER(g.name)=LOWER($1) LIMIT 1`, [guestName]);
        if (g.rows[0]) { guestId = g.rows[0].id; guestName = g.rows[0].name; roomNumber = g.rows[0].room_number; }
      }
    }
    const r = await pool.query(
      `INSERT INTO complaints(guest_id, guest_name, room_number, category, description, status, raised_by, created_by, source, priority)
       VALUES($1,$2,$3,$4,$5,'open','staff',$6,$7,$8) RETURNING *`,
      [guestId, guestName, roomNumber, (category || 'Other').trim(), String(description).trim(), req.user.id,
       ['manual','voice','photo','copilot'].includes(req.body.source) ? req.body.source : 'manual',
       ['low','medium','high'].includes(req.body.priority) ? req.body.priority : require('../services/assistant').rulePriority(category || 'Other', description)]);
    await logActivity(req, 'complaint_add', `${category || 'Other'}: ${String(description).trim().slice(0, 80)}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /complaints/:id  { status, resolution_notes? }
router.put('/complaints/:id', auth, async (req, res) => {
  const { status, resolution_notes, priority } = req.body;
  if (!COMPLAINT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (priority !== undefined && !['low','medium','high'].includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  try {
    const r = await pool.query(
      `UPDATE complaints
          SET status=$1::varchar,
              resolution_notes=COALESCE($2::text, resolution_notes),
              resolved_at=CASE WHEN $1::varchar='resolved' THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
              resolved_by=CASE WHEN $1::varchar='resolved' THEN COALESCE(resolved_by, $3::int) ELSE NULL END,
              priority=COALESCE($5::varchar, priority),
              updated_at=NOW()
        WHERE id=$4::int RETURNING *`,
      [status, resolution_notes ? String(resolution_notes).trim() : null, req.user.id, req.params.id, priority || null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    await logActivity(req, 'complaint_update', `#${req.params.id} → ${status}`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/complaints/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM complaints WHERE id=$1 RETURNING category, description', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    await logActivity(req, 'complaint_delete', `#${req.params.id} ${r.rows[0].category}: ${r.rows[0].description.slice(0, 60)}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resident portal: raise an issue / see my issues (guest JWT, not staff JWT)
router.post('/guest-complaint', guestAuth, async (req, res) => {
  const { category, description } = req.body;
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Please describe the issue' });
  if (String(description).length > 2000) return res.status(400).json({ error: 'Description too long' });
  try {
    const g = req.guest;
    const room = g.room_id ? await pool.query('SELECT room_number FROM rooms WHERE id=$1', [g.room_id]) : { rows: [{}] };
    const r = await pool.query(
      `INSERT INTO complaints(guest_id, guest_name, room_number, category, description, status, raised_by, priority)
       VALUES($1,$2,$3,$4,$5,'open','guest',$6) RETURNING id, category, description, status, created_at`,
      [g.id, g.name, room.rows[0]?.room_number || null, (category || 'Other').trim(), String(description).trim(),
       require('../services/assistant').rulePriority(category || 'Other', description)]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/guest-complaints', guestAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, category, description, status, resolution_notes, created_at, resolved_at
         FROM complaints WHERE guest_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.guest.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ROOM SHIFT (internal move, not a checkout) ───────────────────────────────

router.get('/guests/:id/room-history', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT h.*, u.username AS changed_by_username
         FROM guest_room_history h LEFT JOIN users u ON u.id=h.changed_by
        WHERE h.guest_id=$1 ORDER BY h.effective_from DESC, h.id DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /guests/:id/shift-room  { room_id, bed_number?, effective_from, note? }
// Moves the guest and records the move. Rent, deposit and ledger are untouched:
// a room shift never changes money. (Rent changes go through PUT /guests/:id.)
router.post('/guests/:id/shift-room', auth, async (req, res) => {
  const { room_id, bed_number, effective_from, note } = req.body;
  if (!room_id) return res.status(400).json({ error: 'Select the new room' });
  if (!isIsoDate(effective_from)) return res.status(400).json({ error: 'Effective date is required' });
  if (effective_from > istToday()) return res.status(400).json({ error: 'Effective date cannot be in the future' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = await client.query(
      `SELECT g.*, (SELECT room_number FROM rooms WHERE id=g.room_id) AS room_number FROM guests g WHERE g.id=$1 FOR UPDATE OF g`, [req.params.id]);
    const guest = g.rows[0];
    if (!guest) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    if (!guest.is_active) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Guest has already checked out' }); }
    if (String(guest.room_id) === String(room_id)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Guest is already in that room' }); }
    if (guest.join_date && effective_from < new Date(guest.join_date).toISOString().slice(0, 10)) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Effective date is before the guest joined' });
    }
    const room = await client.query(
      `SELECT r.id, r.room_number, r.total_beds, COUNT(g.id) AS occupied
         FROM rooms r LEFT JOIN guests g ON g.room_id=r.id AND g.is_active=true
        WHERE r.id=$1 AND r.is_active=true GROUP BY r.id`, [room_id]);
    const target = room.rows[0];
    if (!target) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Room not found' }); }
    if (parseInt(target.occupied) >= parseInt(target.total_beds)) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: `Room ${target.room_number} is full` });
    }
    const hist = await client.query(
      `INSERT INTO guest_room_history(guest_id, from_room_number, from_bed_number, to_room_id, to_room_number, to_bed_number, effective_from, changed_by, note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [guest.id, guest.room_number || null, guest.bed_number || null, target.id, target.room_number,
       bed_number ? String(bed_number) : null, effective_from, req.user.id, note ? String(note).trim() || null : null]);
    const upd = await client.query(
      'UPDATE guests SET room_id=$1, bed_number=$2 WHERE id=$3 RETURNING *',
      [target.id, bed_number ? String(bed_number) : null, guest.id]);
    await client.query('COMMIT');
    await logActivity(req, 'guest_room_shift',
      `${guest.name}: Room ${guest.room_number || '—'} → Room ${target.room_number}${bed_number ? ' / Bed ' + bed_number : ''} (from ${effective_from})`);
    res.json({ guest: upd.rows[0], history: hist.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── PAYMENT RECEIPT (A5 PDF) ─────────────────────────────────────────────────

// GET /collections/:id/receipt/pdf — branded receipt for one confirmed collection.
// Pending (staff-unapproved or guest-claimed) payments have no receipt yet:
// a receipt is a promise that money was received and verified.
// Shared by the staff download and the resident's own download so the two can
// never drift apart. Writes the PDF straight to res.
async function sendReceiptPdf(res, collectionId, opts = {}) {
  const [c, s] = await Promise.all([
    pool.query(
      `SELECT c.*, g.name AS gname, g.phone AS gphone, r.room_number, u.username AS collected_by
         FROM collections c LEFT JOIN guests g ON g.id=c.guest_id LEFT JOIN rooms r ON r.id=g.room_id
         LEFT JOIN users u ON u.id=c.created_by
        WHERE c.id=$1 AND c.is_deleted=false`, [collectionId]),
    pool.query(`SELECT key, value FROM app_settings WHERE key IN ('pg_name','pg_address','pg_phone','upi_vpa')`)
  ]);
  const col = c.rows[0];
  if (!col) return res.status(404).json({ error: 'Payment not found' });
  // A resident may only ever download her own receipt.
  if (opts.guestId && String(col.guest_id) !== String(opts.guestId)) {
    return res.status(404).json({ error: 'Payment not found' });
  }
  if (col.status && col.status !== 'confirmed') {
    return res.status(400).json({ error: 'Receipt is available only after the payment is confirmed' });
  }
  const settings = Object.fromEntries(s.rows.map(x => [x.key, x.value]));
  const pgName = settings.pg_name || 'Siri Mane PG';
  const pgAddress = settings.pg_address || 'Tumakuru, Karnataka';
  const pgPhone = settings.pg_phone || '';
  const receiptNo = col.receipt_number || `SM-${String(col.id).padStart(5, '0')}`;
  const guestName = col.gname || col.guest_name || '—';
  const typeLabel = { rent: 'Rent', deposit: 'Security Deposit', advance: 'Advance' }[col.collection_type] || (col.collection_type || 'Payment');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${receiptNo}.pdf"`);
  const doc = new PDFDocument({ size: 'A5', margin: 32 });
  doc.pipe(res);
  const W = doc.page.width - 64;
  const gold = '#C9A96E', ink = '#1E293B', muted = '#64748B';

  if (fs.existsSync(LOGO_PATH)) { try { doc.image(LOGO_PATH, 32, 28, { width: 70 }); } catch { /* logo optional */ } }
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(16).text(pgName, 112, 30, { width: W - 80 });
  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(pgAddress, 112, 50, { width: W - 80 });
  if (pgPhone) doc.text('Ph: ' + pgPhone, 112, 62, { width: W - 80 });
  doc.moveTo(32, 84).lineTo(32 + W, 84).lineWidth(1.2).strokeColor(gold).stroke();

  doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text('PAYMENT RECEIPT', 32, 94, { width: W, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(muted)
    .text(`Receipt No: ${receiptNo}`, 32, 112, { width: W / 2 })
    .text(`Date: ${fmtD(col.collection_date)}`, 32 + W / 2, 112, { width: W / 2, align: 'right' });

  const rows = [
    ['Received from', guestName],
    ['Room', col.room_number ? `Room ${col.room_number}` : '—'],
    ['Towards', typeLabel + (col.collection_month ? ` — ${col.collection_month}` : '')],
    ['Payment mode', (col.payment_mode || 'cash').toUpperCase()],
    ['Description', col.description || '—']
  ];
  let y = 136;
  for (const [k, v] of rows) {
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(k, 32, y, { width: 90 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ink).text(String(v), 126, y, { width: W - 94 });
    y += Math.max(18, doc.heightOfString(String(v), { width: W - 94 }) + 8);
  }

  y += 6;
  doc.rect(32, y, W, 40).fillAndStroke('#FBF7EE', gold);
  doc.fillColor(muted).font('Helvetica').fontSize(9).text('AMOUNT RECEIVED', 44, y + 8);
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(fmtMoney(col.amount), 44, y + 18, { width: W - 24, align: 'right' });
  y += 54;

  doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(`Received by: ${col.collected_by || 'Management'}`, 32, y, { width: W });
  y += 14;
  doc.text('This is a computer-generated receipt and does not require a signature.', 32, y, { width: W });
  doc.text('Thank you for your payment.', 32, doc.page.height - 56, { width: W, align: 'center' });
  doc.end();
}

router.get('/collections/:id/receipt/pdf', auth, async (req, res) => {
  try { await sendReceiptPdf(res, req.params.id); }
  catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// SPRINT 2 — the resident portal has always called this; it did not exist.
// A resident may download only her own confirmed payments.
router.get('/guest-receipt/:id/pdf', guestAuth, async (req, res) => {
  try { await sendReceiptPdf(res, req.params.id, { guestId: req.guest.id }); }
  catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// Exposed for backend/services/*.js (Sprint 4). Same functions the routes
// use, so the brief and reminders can never disagree with Rent Due.
module.exports.computeRentDueList = computeRentDueList;
module.exports.computeGuestLedger = computeGuestLedger;
module.exports.istToday = istToday;
// ── DIGITAL RESIDENT ID (Sprint 8) ───────────────────────────────────────
// The card carries a QR holding a SIGNED, SHORT-LIVED token — not her name,
// phone or ID number. Staff scan it (or type the resident number) and the
// server decides what to show. A photographed card is useless after 24h.
const QRCode = require('qrcode');

router.get('/guest-id', guestAuth, async (req, res) => {
  try {
    const g = await pool.query(
      `SELECT g.id, g.name, g.resident_no, g.phone, g.emergency_contact, g.emergency_contact_name, g.join_date, g.bed_number, r.room_number
         FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [req.guest.id]);
    const x = g.rows[0];
    if (!x) return res.status(404).json({ error: 'Resident not found' });
    const token = jwt.sign({ type: 'resident-id', guestId: x.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
    const settings = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('pg_name','pg_phone')`);
    const st = Object.fromEntries(settings.rows.map(r => [r.key, r.value]));
    const qr = await QRCode.toString(token, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', width: 220 });
    res.json({
      resident_no: x.resident_no, name: x.name, room_number: x.room_number, bed_number: x.bed_number,
      join_date: x.join_date, emergency_contact: x.emergency_contact, emergency_contact_name: x.emergency_contact_name,
      pg_name: st.pg_name || 'Siri Mane PG', pg_phone: st.pg_phone || null,
      qr_svg: qr, expires_in_hours: 24
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Staff verify: POST /resident-id/verify { token } or { resident_no }
router.post('/resident-id/verify', auth, async (req, res) => {
  const { token, resident_no } = req.body || {};
  try {
    let guestId = null;
    if (token) {
      let decoded;
      try { decoded = jwt.verify(String(token), process.env.JWT_SECRET); }
      catch (e) { return res.status(400).json({ valid: false, error: /expired/i.test(e.message) ? 'That ID has expired — ask her to reopen the portal' : 'That code is not valid' }); }
      if (decoded.type !== 'resident-id') return res.status(400).json({ valid: false, error: 'That code is not a resident ID' });
      guestId = decoded.guestId;
    } else if (resident_no) {
      const r = await pool.query('SELECT id FROM guests WHERE resident_no=$1', [String(resident_no).trim().toUpperCase()]);
      if (!r.rows[0]) return res.status(404).json({ valid: false, error: 'No resident with that number' });
      guestId = r.rows[0].id;
    } else return res.status(400).json({ error: 'token or resident_no is required' });

    const g = await pool.query(
      `SELECT g.id, g.name, g.resident_no, g.is_active, g.join_date, g.leave_date, g.bed_number, r.room_number
         FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [guestId]);
    const x = g.rows[0];
    if (!x) return res.status(404).json({ valid: false, error: 'Resident not found' });
    await logActivity(req, 'resident_id_verify', `${x.name} (${x.resident_no})`);
    res.json({ valid: !!x.is_active, resident: { id: x.id, name: x.name, resident_no: x.resident_no, room_number: x.room_number, bed_number: x.bed_number, join_date: x.join_date, is_active: x.is_active, leave_date: x.leave_date } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /guests/:id/timeline — payments, room moves, rent changes, requests and
// the refund, merged into one dated list. Read-only; every row comes from the
// table that already owns it.
router.get('/guests/:id/timeline', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const g = await pool.query(`SELECT id, name, join_date, leave_date, monthly_rent, deposit_amount FROM guests WHERE id=$1`, [id]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Resident not found' });
    const [pays, moves, rents, reqs, refunds] = await Promise.all([
      pool.query(`SELECT id, collection_date AS at, amount, collection_type, payment_mode, status, receipt_number, source FROM collections WHERE guest_id=$1 AND is_deleted=false ORDER BY collection_date DESC, id DESC`, [id]),
      pool.query(`SELECT id, effective_from AS at, from_room_number, to_room_number, to_bed_number, note FROM guest_room_history WHERE guest_id=$1`, [id]),
      pool.query(`SELECT id, effective_from AS at, monthly_rent FROM guest_rent_history WHERE guest_id=$1`, [id]),
      pool.query(`SELECT id, created_at::date AS at, category, description, status, priority, resolved_at FROM complaints WHERE guest_id=$1`, [id]),
      pool.query(`SELECT id, created_at::date AS at, deposit_amount, deductions, refund_amount FROM deposit_refunds WHERE guest_id=$1`, [id])
    ]);
    const guest = g.rows[0];
    const items = [
      { at: guest.join_date, kind: 'joined', title: 'Moved in', detail: `Rent ${fmtMoney(guest.monthly_rent)}/month · deposit ${fmtMoney(guest.deposit_amount)}` },
      ...pays.rows.map(p => ({ at: p.at, kind: 'payment', title: `${fmtMoney(p.amount)} ${p.collection_type}`, detail: `${(p.payment_mode || '').toUpperCase()}${p.receipt_number ? ' · ' + p.receipt_number : ''}${p.status !== 'confirmed' ? ' · ' + p.status : ''}${p.source && p.source !== 'manual' ? ' · via ' + p.source : ''}`, id: p.id, status: p.status })),
      ...moves.rows.map(m => ({ at: m.at, kind: 'move', title: `Room ${m.from_room_number || '—'} → ${m.to_room_number}${m.to_bed_number ? ' / bed ' + m.to_bed_number : ''}`, detail: m.note || '' })),
      ...rents.rows.map(r => ({ at: r.at, kind: 'rent', title: `Rent set to ${fmtMoney(r.monthly_rent)}/month`, detail: '' })),
      ...reqs.rows.map(c => ({ at: c.at, kind: 'request', title: `${c.category} request`, detail: `${c.description.slice(0, 80)} · ${c.status}${c.priority ? ' · ' + c.priority : ''}`, id: c.id })),
      ...refunds.rows.map(r => ({ at: r.at, kind: 'refund', title: `Deposit refunded ${fmtMoney(r.refund_amount)}`, detail: `Held ${fmtMoney(r.deposit_amount)}${parseFloat(r.deductions) ? ' · deductions ' + fmtMoney(r.deductions) : ''}` })),
      ...(guest.leave_date ? [{ at: guest.leave_date, kind: 'left', title: 'Checked out', detail: '' }] : [])
    ].filter(x => x.at);
    // Newest first. On the same date, "Moved in" is always the first thing
    // that happened and "Checked out" the last, so they bracket the day.
    const rank = { left: 0, payment: 1, request: 2, move: 3, rent: 4, refund: 5, joined: 9 };
    items.sort((a, b) =>
      String(b.at).slice(0, 10).localeCompare(String(a.at).slice(0, 10))
      || (rank[a.kind] ?? 6) - (rank[b.kind] ?? 6)
      || (b.id || 0) - (a.id || 0));
    res.json({ resident: guest, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports.computeReportData = computeReportData;
module.exports.computeTrend = computeTrend;
module.exports.computeBalanceSheetData = computeBalanceSheetData;
module.exports.drawPdfTable = drawPdfTable;
module.exports.fmtMoney = fmtMoney;
module.exports.fmtD = fmtD;
