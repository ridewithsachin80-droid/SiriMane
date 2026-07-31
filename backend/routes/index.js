// routes/index.js — All API routes
const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const path = require('path');
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

// Converts a rupee amount to words using Indian numbering (lakh/crore), for
// the "Amount in words" line on printed receipts. Paise are dropped since a
// receipt states the whole-rupee amount actually received.
function amountInWords(amount) {
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function twoDigits(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '');
  }
  function threeDigits(n) {
    if (n < 100) return twoDigits(n);
    return ones[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' ' + twoDigits(n%100) : '');
  }
  let n = Math.round(Math.abs(parseFloat(amount) || 0));
  if (n === 0) return 'Zero Rupees Only';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;
  let parts = [];
  if (crore) parts.push(threeDigits(crore) + ' Crore');
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if (hundred) parts.push(threeDigits(hundred));
  return parts.join(' ') + ' Rupees Only';
}

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
    const [guests, rooms, beds, income, expenses, recentGuests, recentPayments, checklistTotal, checklistToday, openComplaints, pendingVariance] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM guests WHERE is_active=true'),
      pool.query(`SELECT COUNT(*) as total_rooms, COALESCE(SUM(total_beds),0) as total_beds FROM rooms WHERE is_active=true`),
      pool.query(`SELECT COALESCE(SUM(r.total_beds),0) - COUNT(g.id) as available FROM rooms r LEFT JOIN guests g ON r.id=g.room_id AND g.is_active=true WHERE r.is_active=true`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND DATE_TRUNC('month',collection_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND DATE_TRUNC('month',purchase_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.is_active=true ORDER BY g.created_at DESC LIMIT 5`),
      pool.query(`SELECT c.*,g.name as guest_name FROM collections c LEFT JOIN guests g ON c.guest_id=g.id WHERE c.is_deleted=false AND c.status='confirmed' ORDER BY c.collection_date DESC LIMIT 5`),
      pool.query('SELECT COUNT(*) FROM checklist_items WHERE is_active=true'),
      pool.query(`SELECT COUNT(*) FILTER (WHERE is_checked) as checked FROM checklist_log WHERE log_date=CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) FROM complaints WHERE status != 'resolved'`),
      pool.query(`SELECT g.id,g.name,g.monthly_rent,r.room_number,r.monthly_rent as room_rent
                   FROM guests g JOIN rooms r ON g.room_id=r.id
                   WHERE g.is_active=true AND g.rent_variance_approved=false AND g.monthly_rent != r.monthly_rent
                   ORDER BY g.name`)
    ]);
    const totalBeds = parseInt(rooms.rows[0].total_beds) || 0;
    const availBeds = parseInt(beds.rows[0].available) || 0;
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    const checklistItemTotal = parseInt(checklistTotal.rows[0].count) || 0;
    const checklistChecked = parseInt(checklistToday.rows[0].checked) || 0;
    res.json({
      totalGuests: parseInt(guests.rows[0].count),
      totalRooms: parseInt(rooms.rows[0].total_rooms),
      totalBeds, availableBeds: availBeds,
      occupancyPercent: totalBeds > 0 ? Math.round(((totalBeds - availBeds) / totalBeds) * 100) : 0,
      monthlyIncome: inc, monthlyExpenses: exp, netProfit: inc - exp,
      recentGuests: recentGuests.rows, recentPayments: recentPayments.rows,
      todayChecklist: { checked: checklistChecked, total: checklistItemTotal, percent: checklistItemTotal > 0 ? Math.round((checklistChecked / checklistItemTotal) * 100) : 0 },
      openComplaints: parseInt(openComplaints.rows[0].count) || 0,
      pendingVariance: pendingVariance.rows
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
  const { name,phone,email,address,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes } = req.body;
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
      `INSERT INTO guests(name,phone,email,address,emergency_contact,id_proof_type,id_proof_number,room_id,bed_number,join_date,monthly_rent,deposit_amount,notes,created_by,rent_variance_approved) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [name,phone,email,address||null,emergency_contact,id_proof_type,id_proof_number,room_id||null,bed_number||null,join_date,monthly_rent||0,deposit_amount||0,notes,req.user.id,rentVarianceApproved]);
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
  const { name,phone,email,address,emergency_contact,room_id,bed_number,monthly_rent,deposit_amount,notes,leave_date,is_active,rent_effective_from } = req.body;
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
      `UPDATE guests SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=COALESCE($3,email),address=COALESCE($4,address),emergency_contact=COALESCE($5,emergency_contact),room_id=$6,bed_number=$7,monthly_rent=COALESCE($8,monthly_rent),deposit_amount=COALESCE($9,deposit_amount),notes=COALESCE($10,notes),leave_date=$11,is_active=COALESCE($12,is_active),rent_variance_approved=$13 WHERE id=$14 RETURNING *`,
      [name,phone,email,address,emergency_contact,room_id||null,bed_number||null,monthly_rent,deposit_amount,notes,leave_date||null,is_active,rentVarianceApproved,req.params.id]);
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
    const leaveDate = req.body?.leave_date || new Date().toISOString().split('T')[0];
    await pool.query('UPDATE guests SET is_active=false,leave_date=$2 WHERE id=$1', [req.params.id, leaveDate]);
    res.json({ message: 'Checked out' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full move-out flow: computes the deposit refund (deposit minus deductions),
// records it permanently in deposit_refunds, and checks the guest out — all
// in one step so the two can never get out of sync. Admin only, since it's
// the final sign-off on a financial transaction.
router.post('/guests/:id/checkout', auth, requireAdmin, async (req, res) => {
  const { deductions, deduction_notes, refund_mode, leave_date } = req.body;
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.id=$1`, [req.params.id]);
    const guest = g.rows[0];
    if (!guest) return res.status(404).json({ error: 'Guest not found' });
    if (!guest.is_active) return res.status(400).json({ error: 'Guest is already checked out' });

    // Default to today if not given; allow backdating (e.g. logging a
    // checkout that actually happened a few days ago) but not future-dating
    // beyond today.
    const checkoutDate = leave_date || new Date().toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    if (checkoutDate > todayStr) return res.status(400).json({ error: 'Checkout date cannot be in the future' });
    if (guest.join_date && checkoutDate < new Date(guest.join_date).toISOString().split('T')[0]) {
      return res.status(400).json({ error: 'Checkout date cannot be before the check-in date' });
    }

    const deductionAmount = parseFloat(deductions) || 0;
    const depositAmount = parseFloat(guest.deposit_amount) || 0;
    const refundAmount = depositAmount - deductionAmount;

    const refund = await pool.query(
      `INSERT INTO deposit_refunds(guest_id,guest_name,room_number,deposit_amount,deductions,deduction_notes,refund_amount,refund_mode,processed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [guest.id, guest.name, guest.room_number, depositAmount, deductionAmount, deduction_notes || null, refundAmount, refund_mode || 'cash', req.user.id]
    );
    await pool.query('UPDATE guests SET is_active=false,leave_date=$2 WHERE id=$1', [guest.id, checkoutDate]);
    await logActivity(req, 'guest_checkout', `${guest.name} (room ${guest.room_number || '—'}) — refund ₹${refundAmount}, effective ${checkoutDate}`);

    res.status(201).json(refund.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COLLECTIONS (Income) ─────────────────────────
router.get('/collections', auth, async (req, res) => {
  try {
    const { month, year, from, to } = req.query;
    let q = `SELECT c.*,g.name as guest_name,r.room_number FROM collections c LEFT JOIN guests g ON c.guest_id=g.id LEFT JOIN rooms r ON g.room_id=r.id WHERE c.is_deleted=false`;
    const p = [];
    if (from && to) { p.push(from,to); q += ` AND c.collection_date BETWEEN $${p.length-1} AND $${p.length}`; }
    else if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM c.collection_date)=$${p.length-1} AND EXTRACT(YEAR FROM c.collection_date)=$${p.length}`; }
    q += ' ORDER BY c.collection_date DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/collections/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const { month, year, from, to, type } = req.query;
    let q = `SELECT c.*,g.name as guest_name,r.room_number FROM collections c LEFT JOIN guests g ON c.guest_id=g.id LEFT JOIN rooms r ON g.room_id=r.id WHERE c.is_deleted=false AND c.status='confirmed'`;
    const p = [];
    const hasRange = from && to;
    if (hasRange) { p.push(from,to); q += ` AND c.collection_date BETWEEN $${p.length-1} AND $${p.length}`; }
    else if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM c.collection_date)=$${p.length-1} AND EXTRACT(YEAR FROM c.collection_date)=$${p.length}`; }
    if (type) { p.push(type); q += ` AND c.collection_type=$${p.length}`; }
    q += ' ORDER BY c.collection_date ASC';
    const r = await pool.query(q, p);
    const total = r.rows.reduce((s,x) => s + parseFloat(x.amount), 0);

    const periodLabel = hasRange
      ? `${fmtD(from)} \u2013 ${fmtD(to)}`
      : (month && year ? new Date(year, month-1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : 'All time');
    const typeLabel = type ? type.charAt(0).toUpperCase()+type.slice(1) : 'All Types';
    const fileSuffix = hasRange ? `${from}_to_${to}` : `${month||'all'}-${year||'all'}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-collections-${type||'all'}-${fileSuffix}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Collections', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`${periodLabel} \u00b7 ${typeLabel}`, { align: 'center' }).fillColor('#000');
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
  const { guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  try {
    // Staff entries need an admin's sign-off before they count as confirmed
    // income; admin's own entries are trusted immediately. This is separate
    // from the guest UPI self-reporting flow, which uses 'pending_verification'.
    const status = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
    const r = await pool.query(
      `INSERT INTO collections(guest_id,guest_name,amount,collection_date,collection_month,collection_type,payment_mode,description,receipt_number,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [guest_id||null,guest_name,amount,collection_date||new Date(),collection_month,collection_type||'rent',payment_mode||'cash',description,receipt_number,req.user.id,status]);
    await logActivity(req, 'collection_add', `₹${amount} ${collection_type||'rent'} from ${guest_name||'guest #'+guest_id}${status==='pending_approval'?' (pending approval)':''}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Draws the actual receipt onto a PDFDocument — shared by the staff-facing
// and guest-facing receipt routes so the design only lives in one place.
const RECEIPT_LOGO_PATH = path.join(__dirname, '../assets/siri-mane-logo.jpg');
const RECEIPT_LOGO_ASPECT = 577 / 1249; // height/width of the cropped logo asset

function drawReceiptPdf(doc, c, settings) {
  const pgName = settings.pg_name || 'Siri Mane';
  const pgAddress = settings.pg_address || '5th cross, Gangothri Road,\nSIT Ext, Tumakuru.';
  const pgPhone = settings.pg_phone || '9880217627';
  const guestName = c.guest_full_name || c.guest_name || 'Guest';
  const receiptNo = 'SM-' + String(c.id).padStart(5, '0');
  const gold = '#C99A2E', dark = '#1E293B', gray = '#64748B', lightGold = '#FFFBEB';
  const pageW = doc.page.width;

  // Header: logo top-left; PG name, address, phone stacked top-right
  const logoW = 120, logoH = logoW * RECEIPT_LOGO_ASPECT;
  try { doc.image(RECEIPT_LOGO_PATH, 30, 24, { width: logoW }); } catch (e) { /* logo missing — header still works without it */ }

  let ry = 24;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(dark).text(pgName.toUpperCase(), pageW - 260, ry, { width: 230, align: 'right' });
  ry += 18;
  doc.font('Helvetica').fontSize(8.5).fillColor(gray);
  pgAddress.split('\n').filter(Boolean).forEach(line => { doc.text(line, pageW - 260, ry, { width: 230, align: 'right' }); ry += 12; });
  if (pgPhone) { doc.text('Mob: ' + pgPhone, pageW - 260, ry, { width: 230, align: 'right' }); ry += 12; }

  const headerBottom = Math.max(24 + logoH, ry, 90);
  doc.moveTo(30, headerBottom + 10).lineTo(pageW - 30, headerBottom + 10).lineWidth(2).strokeColor(gold).stroke();

  let y = headerBottom + 24;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(dark).text('PAYMENT RECEIPT', 30, y, { width: pageW - 60, align: 'center' });
  y += 30;

  doc.fillColor(dark).font('Helvetica').fontSize(10);
  doc.font('Helvetica-Bold').text('Receipt No:', 30, y); doc.font('Helvetica').text(receiptNo, 130, y);
  doc.font('Helvetica-Bold').text('Date:', 280, y); doc.font('Helvetica').text(fmtD(c.collection_date), 320, y, { width: pageW - 30 - 320, align: 'left' });
  y += 20;
  doc.font('Helvetica-Bold').text('Received From:', 30, y); doc.font('Helvetica').text(guestName, 130, y);
  y += 18;
  if (c.room_number) { doc.font('Helvetica-Bold').text('Room / Bed:', 30, y); doc.font('Helvetica').text(`Room ${c.room_number}${c.bed_number?' / Bed '+c.bed_number:''}`, 130, y); }
  if (c.guest_phone) { doc.font('Helvetica-Bold').text('Phone:', 280, y); doc.font('Helvetica').text(c.guest_phone, 320, y, { width: pageW - 30 - 320, align: 'left' }); }
  y += 30;

  doc.rect(30, y, pageW - 60, 90).lineWidth(1).stroke(gold);
  let py = y + 12;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(gray).text('PARTICULARS', 42, py);
  doc.text('AMOUNT', pageW - 130, py);
  py += 16;
  doc.moveTo(30, py).lineTo(pageW - 30, py).lineWidth(1).strokeColor('#E2E8F0').stroke();
  py += 10;
  doc.font('Helvetica').fontSize(10).fillColor(dark);
  const label = `${(c.collection_type||'Payment').replace(/^\w/, ch=>ch.toUpperCase())}${c.collection_month?' — '+c.collection_month:''}${c.description?' ('+c.description+')':''}`;
  doc.text(label, 42, py, { width: pageW - 200 });
  doc.text(fmtMoney(c.amount), pageW - 130, py, { width: 90, align: 'right' });
  py += 20;
  doc.font('Helvetica-Bold').text('Payment Mode:', 42, py); doc.font('Helvetica').text(c.payment_mode || '—', 130, py);

  y += 105;
  doc.rect(30, y, pageW - 60, 34).fill(lightGold);
  doc.fillColor(gold).font('Helvetica-Bold').fontSize(13).text('Total Received: ' + fmtMoney(c.amount), 42, y + 10);
  y += 46;
  doc.fillColor(gray).font('Helvetica-Oblique').fontSize(9).text('(' + amountInWords(c.amount) + ')', 30, y, { width: pageW - 60 });

  y += 40;
  doc.moveTo(30, y).lineTo(pageW - 30, y).lineWidth(1).strokeColor('#E2E8F0').stroke();
  y += 14;
  doc.fillColor(gray).fontSize(8).font('Helvetica').text('This is a system-generated receipt.', 30, y);
  y += 40;
  doc.moveTo(pageW - 160, y).lineTo(pageW - 30, y).lineWidth(1).strokeColor(dark).stroke();
  doc.fontSize(8).fillColor(gray).text('Authorized Signature', pageW - 160, y + 4, { width: 130, align: 'center' });
}

async function fetchPgReceiptSettings() {
  const r = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('pg_name','pg_address','pg_phone')`);
  const settings = {};
  r.rows.forEach(row => { settings[row.key] = row.value; });
  return settings;
}

// Single-payment receipt — printable/downloadable proof of one specific
// payment, branded for the PG. Any logged-in user can print one (a staff
// member handing a resident a receipt shouldn't need admin sign-in).
router.get('/collections/:id/receipt/pdf', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, g.name as guest_full_name, g.phone as guest_phone, g.bed_number, rm.room_number
       FROM collections c
       LEFT JOIN guests g ON c.guest_id = g.id
       LEFT JOIN rooms rm ON g.room_id = rm.id
       WHERE c.id=$1 AND c.is_deleted=false`,
      [req.params.id]
    );
    const c = r.rows[0];
    if (!c) return res.status(404).json({ error: 'Receipt not found' });
    const settings = await fetchPgReceiptSettings();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-SM-${String(c.id).padStart(5,'0')}.pdf"`);
    const doc = new PDFDocument({ margin: 0, size: 'A5', layout: 'portrait' });
    doc.pipe(res);
    drawReceiptPdf(doc, c, settings);
    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
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
    const { month, year, from, to } = req.query;
    let q = 'SELECT * FROM purchases WHERE is_deleted=false';
    const p = [];
    if (from && to) { p.push(from,to); q += ` AND purchase_date BETWEEN $${p.length-1} AND $${p.length}`; }
    else if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM purchase_date)=$${p.length-1} AND EXTRACT(YEAR FROM purchase_date)=$${p.length}`; }
    q += ' ORDER BY purchase_date DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/purchases/export/pdf', auth, requireAdmin, async (req, res) => {
  try {
    const { month, year, from, to, category, mode } = req.query;
    let q = `SELECT * FROM purchases WHERE is_deleted=false AND status='confirmed'`;
    const p = [];
    const hasRange = from && to;
    if (hasRange) { p.push(from,to); q += ` AND purchase_date BETWEEN $${p.length-1} AND $${p.length}`; }
    else if (month && year) { p.push(month,year); q += ` AND EXTRACT(MONTH FROM purchase_date)=$${p.length-1} AND EXTRACT(YEAR FROM purchase_date)=$${p.length}`; }
    if (category) { p.push(category); q += ` AND category=$${p.length}`; }
    if (mode) { p.push(mode); q += ` AND LOWER(payment_mode)=LOWER($${p.length})`; }
    q += ' ORDER BY purchase_date ASC';
    const r = await pool.query(q, p);
    const total = r.rows.reduce((s,x) => s + parseFloat(x.amount), 0);

    const periodLabel = hasRange
      ? `${fmtD(from)} \u2013 ${fmtD(to)}`
      : (month && year ? new Date(year, month-1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : 'All time');
    const fileSuffix = hasRange ? `${from}_to_${to}` : `${month||'all'}-${year||'all'}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sirimane-purchases-${category||'all'}-${fileSuffix}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Siri Mane PG', { align: 'center' });
    doc.fontSize(11).font('Helvetica').text('Purchases', { align: 'center' });
    doc.fontSize(9).fillColor('#666').text(`${periodLabel}${category ? ' \u00b7 '+category : ''}`, { align: 'center' }).fillColor('#000');
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
  const { amount,category,description,purchase_date,paid_to,payment_mode,receipt_number } = req.body;
  if (!amount || !category) return res.status(400).json({ error: 'Amount and category required' });
  try {
    // Staff entries need an admin's sign-off before they count as confirmed
    // spend; admin's own entries are trusted immediately.
    const status = req.user.role === 'admin' ? 'confirmed' : 'pending_approval';
    const r = await pool.query(
      `INSERT INTO purchases(amount,category,description,purchase_date,paid_to,payment_mode,receipt_number,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [amount,category,description,purchase_date||new Date(),paid_to,payment_mode||'cash',receipt_number,req.user.id,status]);
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
    const [income, expenses, incomeBreakdown, expenseBreakdown] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2`, [dateFrom, dateTo]),
      pool.query(`SELECT COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2`, [dateFrom, dateTo]),
      pool.query(`SELECT collection_type, COALESCE(SUM(amount),0) as total FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date BETWEEN $1 AND $2 GROUP BY collection_type`, [dateFrom, dateTo]),
      pool.query(`SELECT category, COALESCE(SUM(amount),0) as total FROM purchases WHERE is_deleted=false AND status='confirmed' AND purchase_date BETWEEN $1 AND $2 GROUP BY category`, [dateFrom, dateTo])
    ]);
    const inc = parseFloat(income.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    res.json({ totalIncome: inc, totalExpenses: exp, netProfit: inc - exp, incomeBreakdown: incomeBreakdown.rows, expenseBreakdown: expenseBreakdown.rows, dateFrom, dateTo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Month-by-month income/expense for charting trends. Sequential per-month
// queries rather than one fancy GROUP BY — simpler to read and verify
// correct, and the guest-house scale here means performance is a non-issue.
router.get('/reports/trend', auth, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 6, 24);
    const now = new Date();
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
    res.json(result);
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
    SELECT g.id, g.name, g.phone, g.join_date, g.leave_date, g.monthly_rent, g.deposit_amount, r.room_number
    FROM guests g LEFT JOIN rooms r ON g.room_id = r.id
    WHERE g.is_active = true AND g.monthly_rent > 0
    ORDER BY g.name ASC
  `);
  const results = [];
  for (const guest of guests.rows) {
    const { currentBalance } = await computeGuestLedger(guest);
    // Standard expectation is one month's rent as deposit. The 'Deposit (₹)'
    // field on the guest profile is how much of that has actually been
    // collected so far (it's bumped as top-ups come in), so the shortfall
    // against monthly rent — not against itself — is what's still pending.
    const depositRequired = parseFloat(guest.monthly_rent) || 0;
    const depositPaid = parseFloat(guest.deposit_amount) || 0;
    const depositPending = Math.max(0, depositRequired - depositPaid);
    results.push({
      id: guest.id,
      name: guest.name,
      phone: guest.phone,
      room_number: guest.room_number,
      monthly_rent: guest.monthly_rent,
      current_balance: currentBalance,
      amount_due: currentBalance < 0 ? Math.abs(currentBalance) : 0,
      credit: currentBalance > 0 ? currentBalance : 0,
      deposit_required: depositRequired,
      deposit_pending: depositPending
    });
  }
  results.sort((a, b) => (b.amount_due + b.deposit_pending) - (a.amount_due + a.deposit_pending));
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
      { label: 'Name', x: 40, width: 80, get: r => r.name },
      { label: 'Room', x: 120, width: 45, get: r => r.room_number ? 'Room '+r.room_number : '—' },
      { label: 'Phone', x: 165, width: 70, get: r => r.phone },
      { label: 'Rent', x: 235, width: 55, get: r => fmtMoney(r.monthly_rent) },
      { label: 'Rent Pending', x: 290, width: 65, get: r => parseFloat(r.amount_due) > 0 ? fmtMoney(r.amount_due) : parseFloat(r.credit) > 0 ? fmtMoney(r.credit) + ' cr' : '—', color: r => parseFloat(r.amount_due) > 0 ? '#b91c1c' : '#0a7a3e' },
      { label: 'Deposit Pending', x: 355, width: 65, get: r => parseFloat(r.deposit_pending) > 0 ? fmtMoney(r.deposit_pending) : '—', color: r => parseFloat(r.deposit_pending) > 0 ? '#b91c1c' : '#000' },
      { label: 'Total Payable', x: 420, width: 65, get: r => (parseFloat(r.amount_due)+parseFloat(r.deposit_pending||0)) > 0 ? fmtMoney(parseFloat(r.amount_due)+parseFloat(r.deposit_pending||0)) : '—', color: r => (parseFloat(r.amount_due)+parseFloat(r.deposit_pending||0)) > 0 ? '#b91c1c' : '#000' },
      { label: 'Status', x: 485, width: 40, get: r => parseFloat(r.amount_due) > 0 ? 'Pending' : 'OK' }
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

router.get('/guests/:id/room-history', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT h.*, u.username FROM guest_room_history h LEFT JOIN users u ON h.changed_by=u.id WHERE h.guest_id=$1 ORDER BY h.effective_from ASC, h.id ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Internal room/bed shift — moves the guest to a different room within the
// PG (not a checkout). Admin only, and the effective date can be backdated
// (e.g. logging a shift that actually happened a few days ago), same rule
// as rent-history backfill: can't be before check-in, can't be in the future.
router.post('/guests/:id/shift-room', auth, requireAdmin, async (req, res) => {
  const { room_id, bed_number, effective_from, note } = req.body;
  if (!room_id) return res.status(400).json({ error: 'New room is required' });
  if (!effective_from) return res.status(400).json({ error: 'Effective date is required' });
  try {
    const g = await pool.query(`SELECT g.*,r.room_number FROM guests g LEFT JOIN rooms r ON g.room_id=r.id WHERE g.id=$1`, [req.params.id]);
    const guest = g.rows[0];
    if (!guest) return res.status(404).json({ error: 'Guest not found' });

    const todayStr = new Date().toISOString().split('T')[0];
    if (effective_from > todayStr) return res.status(400).json({ error: 'Effective date cannot be in the future' });
    if (guest.join_date && effective_from < new Date(guest.join_date).toISOString().split('T')[0]) {
      return res.status(400).json({ error: 'Effective date cannot be before the check-in date' });
    }

    const newRoom = await pool.query('SELECT room_number FROM rooms WHERE id=$1', [room_id]);
    if (!newRoom.rows[0]) return res.status(404).json({ error: 'Room not found' });

    const hist = await pool.query(
      `INSERT INTO guest_room_history(guest_id,from_room_number,from_bed_number,to_room_id,to_room_number,to_bed_number,effective_from,changed_by,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [guest.id, guest.room_number || null, guest.bed_number || null, room_id, newRoom.rows[0].room_number, bed_number || null, effective_from, req.user.id, note || null]
    );
    await pool.query('UPDATE guests SET room_id=$1,bed_number=$2 WHERE id=$3', [room_id, bed_number || null, guest.id]);
    await logActivity(req, 'guest_room_shift', `${guest.name}: ${guest.room_number||'—'} → ${newRoom.rows[0].room_number}, effective ${effective_from}`);

    res.status(201).json(hist.rows[0]);
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

// ── COMPLAINT / MAINTENANCE REGISTER ─────────────
// Feeds the checklist tasks "Log any new issues in Complaint/Maintenance
// Register" and "Update status on yesterday's complaints" with a real,
// trackable register instead of just a to-do line. Guests can raise their
// own (via /guest-complaint below); staff/admin can log ones found on
// rounds. Any logged-in user can view/update status — this is the warden's
// day-to-day tool, not an admin-only report.
router.get('/complaints', auth, async (req, res) => {
  try {
    const { status } = req.query;
    let q = 'SELECT c.*, u.username as resolved_by_username FROM complaints c LEFT JOIN users u ON c.resolved_by = u.id WHERE 1=1';
    const p = [];
    if (status && status !== 'all') { p.push(status); q += ` AND c.status=$${p.length}`; }
    q += ' ORDER BY (c.status=\'resolved\'), c.created_at DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/complaints', auth, async (req, res) => {
  const { guest_id, guest_name, room_number, category, description } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });
  try {
    const r = await pool.query(
      `INSERT INTO complaints(guest_id,guest_name,room_number,category,description,status,raised_by,created_by)
       VALUES($1,$2,$3,$4,$5,'open',$6,$7) RETURNING *`,
      [guest_id || null, guest_name || null, room_number || null, category || 'other', description, req.user.role === 'admin' ? 'admin' : 'staff', req.user.id]
    );
    await logActivity(req, 'complaint_add', `${category || 'other'}: ${description.slice(0, 80)}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/complaints/:id', auth, async (req, res) => {
  const { status, category, description, resolution_notes } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
    const oldStatus = existing.rows[0].status;
    const finalStatus = status || oldStatus;
    const wasResolved = oldStatus === 'resolved';
    const nowResolved = finalStatus === 'resolved';

    let resolvedAt = existing.rows[0].resolved_at;
    let resolvedBy = existing.rows[0].resolved_by;
    if (nowResolved && !wasResolved) { resolvedAt = new Date(); resolvedBy = req.user.id; }
    else if (!nowResolved) { resolvedAt = null; resolvedBy = null; }

    const r = await pool.query(
      `UPDATE complaints SET
         status=$1, category=COALESCE($2,category), description=COALESCE($3,description),
         resolution_notes=COALESCE($4,resolution_notes), updated_at=NOW(),
         resolved_at=$5, resolved_by=$6
       WHERE id=$7 RETURNING *`,
      [finalStatus, category, description, resolution_notes, resolvedAt, resolvedBy, req.params.id]
    );
    await logActivity(req, 'complaint_update', `#${req.params.id} → ${r.rows[0].status}`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/complaints/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM complaints WHERE id=$1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'complaint_delete', `#${req.params.id}`);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DAILY WARDEN CHECKLIST ─────────────────────────
// Canonical section order (matches the paper checklist), used everywhere
// items need to be grouped/sorted since Postgres won't order VARCHAR that
// way on its own.
const CHECKLIST_SECTION_ORDER = ['Morning', 'Mid-Day', 'Evening', 'Night', 'Closing'];
const CHECKLIST_SECTION_LABELS = { 'Morning': '🌅 Morning', 'Mid-Day': '☀️ Mid-Day', 'Evening': '🌇 Evening', 'Night': '🌙 Night / Gate Closing', 'Closing': '✅ Closing the Day' };

function sectionCaseSql(col) {
  return `CASE ${col} ${CHECKLIST_SECTION_ORDER.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 99 END`;
}

// Warden's checklist for a single day — every active item, plus whether it's
// been ticked yet today (and by whom), grouped by section in paper-checklist
// order. Any logged-in user (staff or admin) can view and tick this; it's
// the warden's own daily routine, not an admin-gated report.
router.get('/checklist', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const r = await pool.query(
      `SELECT i.id, i.section, i.time_label, i.task, i.sort_order,
              l.is_checked, l.checked_at, u.username as checked_by_username
       FROM checklist_items i
       LEFT JOIN checklist_log l ON l.item_id = i.id AND l.log_date = $1
       LEFT JOIN users u ON l.checked_by = u.id
       WHERE i.is_active = true
       ORDER BY ${sectionCaseSql('i.section')}, i.sort_order, i.id`,
      [date]
    );
    const bySection = {};
    CHECKLIST_SECTION_ORDER.forEach(s => { bySection[s] = []; });
    r.rows.forEach(row => { (bySection[row.section] = bySection[row.section] || []).push(row); });
    const sections = Object.keys(bySection)
      .sort((a, b) => CHECKLIST_SECTION_ORDER.indexOf(a) - CHECKLIST_SECTION_ORDER.indexOf(b))
      .map(section => ({ section, label: CHECKLIST_SECTION_LABELS[section] || section, items: bySection[section] }));
    const total = r.rows.length;
    const checked = r.rows.filter(row => row.is_checked).length;
    res.json({ date, sections, summary: { total, checked, percent: total > 0 ? Math.round((checked / total) * 100) : 0 } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tick/untick a single item for a given date. Upserts so ticking the same
// item twice for the same date just updates who/when rather than erroring.
router.put('/checklist/:itemId', auth, async (req, res) => {
  const { date, checked } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  try {
    const r = await pool.query(
      `INSERT INTO checklist_log(item_id, log_date, is_checked, checked_by, checked_at)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (item_id, log_date)
       DO UPDATE SET is_checked=$3, checked_by=$4, checked_at=$5
       RETURNING *`,
      [req.params.itemId, date, !!checked, req.user.id, checked ? new Date() : null]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin-facing completion trend — either the last N days (legacy ?days=)
// or a specific calendar month (?month=YYYY-MM), so the owner can look back
// at any past month, not just a rolling 30-day window.
router.get('/checklist/summary', auth, requireAdmin, async (req, res) => {
  try {
    const totalR = await pool.query('SELECT COUNT(*) FROM checklist_items WHERE is_active=true');
    const total = parseInt(totalR.rows[0].count) || 0;

    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    let startDate, endDate;

    if (req.query.month) {
      const [y, m] = req.query.month.split('-').map(Number);
      if (!y || !m) return res.status(400).json({ error: 'month must be YYYY-MM' });
      startDate = new Date(Date.UTC(y, m - 1, 1));
      endDate = new Date(Date.UTC(y, m, 0)); // last day of that month
      if (endDate > todayUTC) endDate = todayUTC; // don't show future days of the current month
    } else {
      const days = Math.min(parseInt(req.query.days) || 30, 90);
      endDate = todayUTC;
      startDate = new Date(todayUTC);
      startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    }

    if (endDate < startDate) return res.json([]); // a future month was requested

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const r = await pool.query(
      `SELECT log_date::date as date, COUNT(*) FILTER (WHERE is_checked) as checked
       FROM checklist_log
       WHERE log_date >= $1 AND log_date <= $2
       GROUP BY log_date`,
      [startStr, endStr]
    );
    const byDate = {};
    r.rows.forEach(row => { byDate[row.date.toISOString().split('T')[0]] = parseInt(row.checked); });

    const result = [];
    for (let d = new Date(endDate); d >= startDate; d.setUTCDate(d.getUTCDate() - 1)) {
      const key = d.toISOString().split('T')[0];
      const checked = byDate[key] || 0;
      result.push({ date: key, checked, total, percent: total > 0 ? Math.round((checked / total) * 100) : 0 });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CHECKLIST ITEMS (admin manages the master task list) ──
router.get('/checklist-items', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM checklist_items WHERE is_active=true ORDER BY ${sectionCaseSql('section')}, sort_order, id`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/checklist-items', auth, requireAdmin, async (req, res) => {
  const { section, time_label, task, sort_order } = req.body;
  if (!section || !task) return res.status(400).json({ error: 'Section and task are required' });
  try {
    const r = await pool.query(
      `INSERT INTO checklist_items(section, time_label, task, sort_order) VALUES($1,$2,$3,$4) RETURNING *`,
      [section, time_label || '—', task, sort_order || 0]
    );
    await logActivity(req, 'checklist_item_add', `${section}: ${task}`);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/checklist-items/:id', auth, requireAdmin, async (req, res) => {
  const { section, time_label, task, sort_order } = req.body;
  try {
    const r = await pool.query(
      `UPDATE checklist_items SET section=COALESCE($1,section),time_label=COALESCE($2,time_label),task=COALESCE($3,task),sort_order=COALESCE($4,sort_order) WHERE id=$5 RETURNING *`,
      [section, time_label, task, sort_order, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft delete — keeps historical checklist_log rows (and past completion %)
// intact for dates before this item was retired.
router.delete('/checklist-items/:id', auth, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE checklist_items SET is_active=false WHERE id=$1 RETURNING *', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logActivity(req, 'checklist_item_remove', `${r.rows[0].section}: ${r.rows[0].task}`);
    res.json({ message: 'Removed' });
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
      pool.query(`SELECT key, value FROM app_settings WHERE key IN ('upi_vpa','upi_name')`),
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

// POST /api/guest-complaint — resident raises an issue directly into the
// Complaint/Maintenance Register (separate from the general "Message Us"
// inbox, so it shows up with a trackable Open/In Progress/Resolved status
// the warden and admin both work from).
router.post('/guest-complaint', guestAuth, async (req, res) => {
  const { category, description } = req.body;
  if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required' });
  try {
    const g = req.guest;
    const room = g.room_id ? await pool.query('SELECT room_number FROM rooms WHERE id=$1', [g.room_id]) : { rows: [{}] };
    const r = await pool.query(
      `INSERT INTO complaints(guest_id,guest_name,room_number,category,description,status,raised_by)
       VALUES($1,$2,$3,$4,$5,'open','guest') RETURNING *`,
      [g.id, g.name, room.rows[0]?.room_number || null, category || 'other', description.trim()]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/guest-complaints — resident's own complaint history + status,
// so they can see whether management has acted on what they raised.
router.get('/guest-complaints', guestAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,category,description,status,resolution_notes,created_at,resolved_at FROM complaints WHERE guest_id=$1 ORDER BY created_at DESC', [req.guest.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/guest-receipt/:id/pdf — resident downloads their own payment
// receipt. Scoped to guest_id so a guest can't fetch someone else's by
// guessing an id.
router.get('/guest-receipt/:id/pdf', guestAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, g.name as guest_full_name, g.phone as guest_phone, g.bed_number, rm.room_number
       FROM collections c
       LEFT JOIN guests g ON c.guest_id = g.id
       LEFT JOIN rooms rm ON g.room_id = rm.id
       WHERE c.id=$1 AND c.is_deleted=false AND c.guest_id=$2`,
      [req.params.id, req.guest.id]
    );
    const c = r.rows[0];
    if (!c) return res.status(404).json({ error: 'Receipt not found' });
    const settings = await fetchPgReceiptSettings();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-SM-${String(c.id).padStart(5,'0')}.pdf"`);
    const doc = new PDFDocument({ margin: 0, size: 'A5', layout: 'portrait' });
    doc.pipe(res);
    drawReceiptPdf(doc, c, settings);
    doc.end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
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
