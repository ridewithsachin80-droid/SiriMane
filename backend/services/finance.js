// backend/services/finance.js — Sprint 10
//
// Everything here is arithmetic the owner can check on a calculator. The model
// is never asked for a number; at most it phrases one. Each function states
// its own reasoning in words so the screen can show *why*, not just *what*.
const pool = require('../db');
const routes = require('../routes/index');

const fmt = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => istNow().toISOString().slice(0, 10);
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// ── 1. Payment reliability, per resident, from her own history ───────────
// "On time" = a rent payment landed on or before the 10th of the month it was
// for. Nothing is compared between residents, and nothing here drives an
// automatic decision — it only orders the reminder list.
const ON_TIME_DAY = 10;

async function computeReliability() {
  const [guests, pays] = await Promise.all([
    pool.query(`SELECT g.id, g.name, g.join_date, g.monthly_rent, r.room_number
                  FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`),
    pool.query(`SELECT guest_id, collection_date, collection_month, amount
                  FROM collections
                 WHERE is_deleted=false AND status='confirmed' AND collection_type='rent'
                   AND collection_date >= CURRENT_DATE - INTERVAL '12 months'`)
  ]);
  const byGuest = new Map();
  for (const p of pays.rows) {
    if (!byGuest.has(p.guest_id)) byGuest.set(p.guest_id, []);
    byGuest.get(p.guest_id).push(p);
  }
  const due = await routes.computeRentDueList();
  const dueBy = new Map(due.map(g => [g.id, g]));

  return guests.rows.map(g => {
    const list = (byGuest.get(g.id) || []).slice().sort((a, b) => String(a.collection_date).localeCompare(String(b.collection_date)));
    // Group by the month the payment was *for*; a month is on time if the
    // first payment towards it arrived by the 10th.
    const months = new Map();
    for (const p of list) {
      const key = p.collection_month || String(p.collection_date).slice(0, 7);
      const day = new Date(p.collection_date).getUTCDate();
      const prev = months.get(key);
      if (!prev || day < prev) months.set(key, day);
    }
    const considered = [...months.values()];
    const onTime = considered.filter(d => d <= ON_TIME_DAY).length;
    const total = considered.length;
    const d = dueBy.get(g.id) || {};
    const monthsBehind = g.monthly_rent > 0 && d.amount_due > 0 ? d.amount_due / g.monthly_rent : 0;

    let level, why;
    if (total < 2) {
      level = 'new';
      why = total === 0 ? 'No rent payments recorded yet' : 'Only one month on record so far';
    } else if (onTime === total) {
      level = 'high'; why = `Paid on time in all ${total} recorded months`;
    } else if (onTime / total >= 0.6) {
      level = 'medium'; why = `On time in ${onTime} of the last ${total} months`;
    } else {
      level = 'at_risk'; why = `Late in ${total - onTime} of the last ${total} months`;
    }
    // Arrears are reported next to the habit, not merged into it. Someone who
    // pays by the 5th every month but joined recently can carry a balance
    // without being called unreliable — and someone who always pays late is
    // "at risk" even when her balance is clear.
    const arrears = monthsBehind >= 1;
    if (arrears) why += `; ${Math.round(monthsBehind * 10) / 10} month${monthsBehind >= 2 ? 's' : ''} outstanding now`;

    return {
      id: g.id, name: g.name, room_number: g.room_number, monthly_rent: parseFloat(g.monthly_rent) || 0,
      amount_due: d.amount_due || 0, months_behind: Math.round(monthsBehind * 10) / 10,
      months_recorded: total, on_time: onTime,
      on_time_rate: total ? Math.round(onTime * 100 / total) : null,
      level, why, arrears, needs_attention: arrears || level === 'at_risk'
    };
  }).sort((a, b) => b.amount_due - a.amount_due);
}

// ── 2. Collection forecast for the current month ─────────────────────────
// expected = Σ (her rent × her own on-time rate). A resident with no history
// is assumed to pay — optimism is the fair default for someone new.
async function collectionForecast(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : istToday().slice(0, 7);
  const [rel, collected] = await Promise.all([
    computeReliability(),
    pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM collections
                 WHERE is_deleted=false AND status='confirmed' AND collection_type='rent'
                   AND to_char(collection_date,'YYYY-MM')=$1`, [m])
  ]);
  const target = rel.reduce((t, g) => t + g.monthly_rent, 0);
  const already = collected.rows[0].t;
  const rate = g => g.on_time_rate == null ? 0.9 : Math.max(0.3, Math.min(1, g.on_time_rate / 100));
  const expected = Math.round(rel.reduce((t, g) => t + g.monthly_rent * rate(g), 0));
  const atRisk = rel.filter(g => g.level === 'at_risk');
  return {
    month: m, target: Math.round(target), collected: Math.round(already), expected,
    shortfall: Math.max(0, Math.round(target - expected)),
    basis: 'Each resident’s own rent multiplied by how often she has paid by the 10th. Residents with no history are counted at 90%.',
    at_risk: atRisk.slice(0, 10).map(g => ({ id: g.id, name: g.name, room_number: g.room_number, amount_due: g.amount_due, why: g.why })),
    at_risk_total: Math.round(atRisk.reduce((t, g) => t + (g.amount_due || g.monthly_rent), 0))
  };
}

// ── 3. Occupancy forecast, 7 and 30 days ─────────────────────────────────
async function occupancyForecast() {
  const today = istToday();
  const [beds, active, leaving, joinsLastYear, staysRows] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_beds),0)::int AS n FROM rooms WHERE is_active=true AND status='active'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE is_active=true`),
    pool.query(`SELECT id, name, expected_checkout FROM guests WHERE is_active=true AND expected_checkout IS NOT NULL AND expected_checkout <= ($1::date + 30) ORDER BY expected_checkout`, [today]),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE join_date >= $1::date - 365`, [today]),
    pool.query(`SELECT AVG(leave_date - join_date)::float AS days FROM guests WHERE leave_date IS NOT NULL AND join_date IS NOT NULL`)
  ]);
  const total = beds.rows[0].n, now = active.rows[0].n;
  const out7 = leaving.rows.filter(g => new Date(g.expected_checkout) <= new Date(new Date(today).getTime() + 7 * 86400000)).length;
  const out30 = leaving.rows.length;
  // Arrivals are assumed to continue at last year's pace — nothing cleverer,
  // and the screen says so.
  const perMonth = joinsLastYear.rows[0].n / 12;
  const in7 = Math.round(perMonth * 7 / 30), in30 = Math.round(perMonth);
  const clamp = v => Math.max(0, Math.min(total, v));
  return {
    beds: total, occupied: now, vacant: Math.max(0, total - now),
    next7: { low: clamp(now - out7), high: clamp(now - out7 + in7) },
    next30: { low: clamp(now - out30), high: clamp(now - out30 + in30) },
    leaving: leaving.rows,
    avg_stay_days: Math.round(staysRows.rows[0].days || 0),
    basis: `Known checkouts, plus arrivals continuing at last year’s pace (${perMonth.toFixed(1)} a month).`
  };
}

// ── 4. Expense insight ───────────────────────────────────────────────────
async function expenseInsight() {
  const [dupes, spikes, recurring, monthCmp] = await Promise.all([
    pool.query(`SELECT a.id, a.amount, a.category, a.paid_to, a.purchase_date, b.id AS other_id
                  FROM purchases a JOIN purchases b
                    ON a.id < b.id AND a.amount=b.amount AND COALESCE(a.paid_to,'')=COALESCE(b.paid_to,'')
                   AND ABS(a.purchase_date - b.purchase_date) <= 3
                 WHERE a.is_deleted=false AND b.is_deleted=false AND a.purchase_date >= CURRENT_DATE - 60
                 ORDER BY a.purchase_date DESC LIMIT 10`),
    pool.query(`WITH avg6 AS (
                  SELECT category, AVG(amount) AS avg_amt FROM purchases
                   WHERE is_deleted=false AND purchase_date >= CURRENT_DATE - 180 AND purchase_date < CURRENT_DATE - 30
                   GROUP BY category HAVING COUNT(*) >= 3)
                SELECT p.id, p.amount, p.category, p.paid_to, p.purchase_date, a.avg_amt
                  FROM purchases p JOIN avg6 a ON a.category=p.category
                 WHERE p.is_deleted=false AND p.purchase_date >= CURRENT_DATE - 30 AND p.amount > 2*a.avg_amt
                 ORDER BY p.amount DESC LIMIT 10`),
    pool.query(`SELECT paid_to, category, COUNT(DISTINCT to_char(purchase_date,'YYYY-MM'))::int AS months, ROUND(AVG(amount)) AS typical
                  FROM purchases WHERE is_deleted=false AND paid_to IS NOT NULL AND paid_to <> ''
                   AND purchase_date >= CURRENT_DATE - 200
                 GROUP BY paid_to, category HAVING COUNT(DISTINCT to_char(purchase_date,'YYYY-MM')) >= 3
                 ORDER BY AVG(amount) DESC LIMIT 10`),
    pool.query(`SELECT category,
                  COALESCE(SUM(amount) FILTER (WHERE to_char(purchase_date,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')),0)::float AS this_month,
                  COALESCE(AVG(amount_by_month),0)::float AS avg_month
                FROM (SELECT category, amount, purchase_date,
                             SUM(amount) OVER (PARTITION BY category, to_char(purchase_date,'YYYY-MM')) AS amount_by_month
                        FROM purchases WHERE is_deleted=false AND purchase_date >= CURRENT_DATE - 180) x
               GROUP BY category`)
  ]);
  const changes = monthCmp.rows
    .filter(r => r.avg_month > 0 && r.this_month > 0)
    .map(r => ({ category: r.category, this_month: r.this_month, avg_month: r.avg_month, change_pct: Math.round((r.this_month - r.avg_month) * 100 / r.avg_month) }))
    .filter(r => Math.abs(r.change_pct) >= 15)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  return {
    duplicates: dupes.rows.map(d => ({ ...d, amount: parseFloat(d.amount), note: `${fmt(d.amount)} to ${d.paid_to || 'the same vendor'} twice within 3 days` })),
    spikes: spikes.rows.map(s => ({ ...s, amount: parseFloat(s.amount), avg_amt: parseFloat(s.avg_amt), note: `${fmt(s.amount)} vs a usual ${fmt(s.avg_amt)} for ${s.category}` })),
    recurring: recurring.rows.map(r => ({ ...r, typical: parseFloat(r.typical), note: `${r.paid_to} — about ${fmt(r.typical)} every month` })),
    changes
  };
}

// ── 5. KPIs ──────────────────────────────────────────────────────────────
async function kpis(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : istToday().slice(0, 7);
  const from = `${m}-01`;
  const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [report, occ, billed, collectedRent] = await Promise.all([
    routes.computeReportData(from, to),
    pool.query(`SELECT (SELECT COALESCE(SUM(total_beds),0) FROM rooms WHERE is_active=true)::int AS beds,
                       (SELECT COUNT(*) FROM guests WHERE is_active=true)::int AS residents`),
    pool.query(`SELECT COALESCE(SUM(monthly_rent),0)::float AS t FROM guests WHERE is_active=true`),
    pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_type='rent' AND to_char(collection_date,'YYYY-MM')=$1`, [m])
  ]);
  const beds = occ.rows[0].beds, residents = occ.rows[0].residents;
  const rentRoll = billed.rows[0].t;
  return {
    month: m,
    occupancy_pct: beds ? Math.round(residents * 100 / beds) : 0,
    revenue_per_occupied_bed: residents ? Math.round(report.totalIncome / residents) : 0,
    collection_rate_pct: rentRoll ? Math.round(collectedRent.rows[0].t * 100 / rentRoll) : null,
    average_rent: residents ? Math.round(rentRoll / residents) : 0,
    expense_ratio_pct: report.totalIncome ? Math.round(report.totalExpenses * 100 / report.totalIncome) : null,
    net_operating_income: Math.round(report.netProfit),
    income: Math.round(report.totalIncome), expenses: Math.round(report.totalExpenses),
    rent_roll: Math.round(rentRoll), rent_collected: Math.round(collectedRent.rows[0].t)
  };
}

// ── 6. Day closing ───────────────────────────────────────────────────────
// Reads collections; never writes to them. A difference is recorded as a
// variance so the day's story is kept, rather than a figure being "corrected".
async function expectedForDay(date) {
  const r = await pool.query(`
    SELECT LOWER(COALESCE(payment_mode,'cash')) AS mode, COALESCE(SUM(amount),0)::float AS total, COUNT(*)::int AS n
      FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1
     GROUP BY LOWER(COALESCE(payment_mode,'cash'))`, [date]);
  const bucket = { cash: 0, upi: 0, bank: 0 };
  for (const row of r.rows) {
    if (row.mode.includes('upi') || row.mode.includes('gpay') || row.mode.includes('phonepe')) bucket.upi += row.total;
    else if (row.mode.includes('bank') || row.mode.includes('neft') || row.mode.includes('imps') || row.mode.includes('transfer')) bucket.bank += row.total;
    else bucket.cash += row.total;
  }
  return { cash: Math.round(bucket.cash * 100) / 100, upi: Math.round(bucket.upi * 100) / 100, bank: Math.round(bucket.bank * 100) / 100 };
}

async function getDayClosing(date) {
  const expected = await expectedForDay(date);
  const c = await pool.query(`SELECT d.*, u.username AS closed_by_username FROM day_closings d LEFT JOIN users u ON u.id=d.closed_by WHERE d.close_date=$1`, [date]);
  const closing = c.rows[0] || null;
  const pending = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS total FROM collections WHERE is_deleted=false AND status<>'confirmed' AND collection_date=$1`, [date]);
  return {
    date, expected,
    closed: !!closing && !closing.reopened_at,
    closing: closing ? {
      ...closing,
      counted: { cash: parseFloat(closing.cash_counted), upi: parseFloat(closing.upi_counted), bank: parseFloat(closing.bank_counted) },
      difference: {
        cash: Math.round((parseFloat(closing.cash_counted) - expected.cash) * 100) / 100,
        upi: Math.round((parseFloat(closing.upi_counted) - expected.upi) * 100) / 100,
        bank: Math.round((parseFloat(closing.bank_counted) - expected.bank) * 100) / 100
      }
    } : null,
    pending_not_counted: pending.rows[0]
  };
}

async function closeDay({ date, counted, note, user }) {
  if (!isDate(date)) throw Object.assign(new Error('date must be YYYY-MM-DD'), { status: 400 });
  if (date > istToday()) throw Object.assign(new Error('You cannot close a day that has not happened'), { status: 400 });
  const existing = await pool.query('SELECT close_date, reopened_at FROM day_closings WHERE close_date=$1', [date]);
  if (existing.rows[0] && !existing.rows[0].reopened_at) throw Object.assign(new Error('That day is already closed'), { status: 409 });
  const expected = await expectedForDay(date);
  const num = v => Math.round((Number(v) || 0) * 100) / 100;
  const c = { cash: num(counted && counted.cash), upi: num(counted && counted.upi), bank: num(counted && counted.bank) };
  await pool.query(`
    INSERT INTO day_closings(close_date, cash_counted, upi_counted, bank_counted, expected_cash, expected_upi, expected_bank, note, closed_by, closed_at, reopened_at, reopened_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NULL,NULL)
    ON CONFLICT (close_date) DO UPDATE SET cash_counted=$2, upi_counted=$3, bank_counted=$4,
      expected_cash=$5, expected_upi=$6, expected_bank=$7, note=$8, closed_by=$9, closed_at=NOW(), reopened_at=NULL, reopened_by=NULL`,
    [date, c.cash, c.upi, c.bank, expected.cash, expected.upi, expected.bank, note || null, user.id]);
  const variances = [];
  for (const mode of ['cash', 'upi', 'bank']) {
    const diff = Math.round((c[mode] - expected[mode]) * 100) / 100;
    if (Math.abs(diff) >= 0.01) {
      await pool.query(`INSERT INTO collection_variances(close_date, mode, expected, counted, difference, note, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [date, mode, expected[mode], c[mode], diff, note || null, user.id]);
      variances.push({ mode, expected: expected[mode], counted: c[mode], difference: diff });
    }
  }
  return { date, expected, counted: c, variances, closed: true };
}

async function reopenDay({ date, user }) {
  const r = await pool.query(`UPDATE day_closings SET reopened_at=NOW(), reopened_by=$2 WHERE close_date=$1 AND reopened_at IS NULL RETURNING close_date`, [date, user.id]);
  if (!r.rows[0]) throw Object.assign(new Error('That day is not closed'), { status: 404 });
  return { date, closed: false };
}

// A day already closed must not silently gain new money.
async function isDayClosed(date) {
  const r = await pool.query('SELECT 1 FROM day_closings WHERE close_date=$1 AND reopened_at IS NULL', [date]);
  return !!r.rows[0];
}

module.exports = { computeReliability, collectionForecast, occupancyForecast, expenseInsight, kpis, getDayClosing, closeDay, reopenDay, isDayClosed, expectedForDay, ON_TIME_DAY };
