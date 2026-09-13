// backend/services/owner.js — Sprint 5
//
// Owner intelligence: the monthly report, anomaly flags and a plain forecast.
// Every rupee figure here comes from the same functions behind the Reports,
// Balance Sheet and Rent Due screens (routes/index.js exports them), so the
// owner's PDF can never show a number the warden's screens don't.
//
// No new dependencies: the PDF uses pdfkit (already installed) and the CSV
// bundle is a hand-built ZIP (Node's zlib for deflate, a 30-line CRC32).
const zlib = require('zlib');
const PDFDocument = require('pdfkit');
const pool = require('../db');
const routes = require('../routes/index');

// "Rs" not "₹": the PDF's built-in Helvetica has no rupee glyph (it prints
// as "¹"), and the same text goes into the PDF, WhatsApp and the screen —
// one wording everywhere is the rule.
const fmt = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const ym = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const isYm = s => /^\d{4}-\d{2}$/.test(String(s || ''));

function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from, to, label, y, m };
}

// ── Facts for one month ───────────────────────────────────────────────────
async function computeOwnerFacts(yyyymm) {
  const { from, to, label, y, m } = monthBounds(yyyymm);
  const [report, sheet, rentDue, trend, occ, joins, leaves, refunds, complaints, resolveTime, sources, pendingClaims, pendingApprovals, checklist] = await Promise.all([
    routes.computeReportData(from, to),
    routes.computeBalanceSheetData(to),
    routes.computeRentDueList(),
    routes.computeTrend(12, new Date(Date.UTC(y, m - 1, 1))),
    pool.query(`SELECT (SELECT COALESCE(SUM(total_beds),0) FROM rooms WHERE is_active=true)::int AS beds,
                       (SELECT COUNT(*) FROM guests g JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND r.is_active=true)::int AS occupied`),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE join_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE leave_date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_amount),0) AS total FROM deposit_refunds WHERE created_at::date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE created_at::date BETWEEN $1 AND $2)::int AS raised,
                       COUNT(*) FILTER (WHERE resolved_at::date BETWEEN $1 AND $2)::int AS resolved,
                       COUNT(*) FILTER (WHERE status <> 'resolved')::int AS open_now,
                       COUNT(*) FILTER (WHERE status <> 'resolved' AND priority='high')::int AS open_high
                  FROM complaints`, [from, to]),
    pool.query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/86400),0) AS days
                  FROM complaints WHERE resolved_at::date BETWEEN $1 AND $2`, [from, to]),
    pool.query(`SELECT 'collection' AS kind, COALESCE(source,'manual') AS source, COUNT(*)::int AS n FROM collections WHERE is_deleted=false AND collection_date BETWEEN $1 AND $2 GROUP BY source
                UNION ALL
                SELECT 'purchase', COALESCE(source,'manual'), COUNT(*)::int FROM purchases WHERE is_deleted=false AND purchase_date BETWEEN $1 AND $2 GROUP BY source`, [from, to]),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM collections WHERE is_deleted=false AND status='pending_verification'`),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM collections WHERE is_deleted=false AND status='pending_approval'`),
    pool.query(`SELECT COUNT(DISTINCT l.log_date)::int AS days,
                       COALESCE(AVG(sub.pct),0) AS avg_pct
                  FROM checklist_log l
                  JOIN (SELECT log_date, 100.0*COUNT(*) FILTER (WHERE is_checked)/NULLIF((SELECT COUNT(*) FROM checklist_items WHERE is_active=true),0) AS pct
                          FROM checklist_log WHERE log_date BETWEEN $1 AND $2 GROUP BY log_date) sub ON sub.log_date=l.log_date`, [from, to])
  ]);

  // Overdue ageing from the same list the Rent Due screen shows.
  const ageing = { under1: { n: 0, total: 0 }, one2: { n: 0, total: 0 }, over2: { n: 0, total: 0 } };
  const owing = rentDue.filter(g => g.amount_due > 0);
  for (const g of owing) {
    const months = g.monthly_rent > 0 ? g.amount_due / g.monthly_rent : 0;
    const b = months < 1 ? ageing.under1 : months < 2 ? ageing.one2 : ageing.over2;
    b.n++; b.total += g.amount_due;
  }
  const totalDue = owing.reduce((t, g) => t + g.amount_due, 0);

  const beds = occ.rows[0].beds, occupied = occ.rows[0].occupied;
  const byKind = { collection: {}, purchase: {} };
  for (const r of sources.rows) byKind[r.kind][r.source] = r.n;

  return {
    month: yyyymm, label, from, to,
    money: {
      income: report.totalIncome, expenses: report.totalExpenses, net: report.netProfit,
      incomeByType: report.incomeBreakdown.map(r => ({ type: r.collection_type, total: parseFloat(r.total) })),
      expensesByCategory: report.expenseBreakdown.map(r => ({ category: r.category, total: parseFloat(r.total) })),
      depositsHeld: sheet.liabilities.depositsHeld, cashPosition: sheet.assets.cashPosition,
      refundsInMonth: { n: refunds.rows[0].n, total: parseFloat(refunds.rows[0].total) },
      pendingClaims: { n: pendingClaims.rows[0].n, total: parseFloat(pendingClaims.rows[0].total) },
      pendingApprovals: { n: pendingApprovals.rows[0].n, total: parseFloat(pendingApprovals.rows[0].total) }
    },
    dues: { residents: owing.length, total: totalDue, ageing, top: owing.slice(0, 10).map(g => ({ name: g.name, room: g.room_number, amount: g.amount_due })) },
    occupancy: { beds, occupied, vacant: Math.max(0, beds - occupied), percent: beds ? Math.round(occupied * 100 / beds) : 0, joined: joins.rows[0].n, left: leaves.rows[0].n },
    complaints: { raised: complaints.rows[0].raised, resolved: complaints.rows[0].resolved, openNow: complaints.rows[0].open_now, openHigh: complaints.rows[0].open_high, avgDaysToResolve: Math.round(parseFloat(resolveTime.rows[0].days) * 10) / 10 },
    checklist: { daysLogged: checklist.rows[0].days, avgPercent: Math.round(parseFloat(checklist.rows[0].avg_pct)) },
    inputs: byKind,
    trend
  };
}

// ── Anomaly rules (deterministic, explained in plain words) ──────────────
async function computeAnomalies() {
  const flags = [];
  const [variance, purchases, rentDue, refunds, checklist, claims, approvals, items] = await Promise.all([
    pool.query(`SELECT g.name, r.room_number, g.monthly_rent, r.monthly_rent AS room_rent, g.created_at
                  FROM guests g LEFT JOIN rooms r ON r.id=g.room_id
                 WHERE g.is_active=true AND g.rent_variance_approved=false AND g.created_at < NOW() - INTERVAL '3 days'`),
    pool.query(`WITH avg6 AS (
                  SELECT category, AVG(amount) AS avg_amt, COUNT(*) AS n FROM purchases
                   WHERE is_deleted=false AND purchase_date >= CURRENT_DATE - INTERVAL '6 months' AND purchase_date < CURRENT_DATE - INTERVAL '30 days'
                   GROUP BY category HAVING COUNT(*) >= 3)
                SELECT p.id, p.amount, p.category, p.paid_to, p.purchase_date, a.avg_amt
                  FROM purchases p JOIN avg6 a ON a.category=p.category
                 WHERE p.is_deleted=false AND p.purchase_date >= CURRENT_DATE - INTERVAL '30 days' AND p.amount > 2*a.avg_amt
                 ORDER BY p.amount DESC LIMIT 10`),
    routes.computeRentDueList(),
    pool.query(`SELECT d.guest_name, d.refund_amount, d.deposit_amount FROM deposit_refunds d
                 WHERE d.created_at >= NOW() - INTERVAL '90 days' AND d.refund_amount > COALESCE(d.deposit_amount,0) + 0.5`).catch(() => ({ rows: [] })),
    pool.query(`SELECT log_date, 100.0*COUNT(*) FILTER (WHERE is_checked)/NULLIF((SELECT COUNT(*) FROM checklist_items WHERE is_active=true),0) AS pct
                  FROM checklist_log WHERE log_date >= CURRENT_DATE - INTERVAL '3 days' AND log_date < CURRENT_DATE GROUP BY log_date ORDER BY log_date`),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM collections WHERE is_deleted=false AND status='pending_verification' AND created_at < NOW() - INTERVAL '2 days'`),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM collections WHERE is_deleted=false AND status='pending_approval' AND created_at < NOW() - INTERVAL '2 days'`),
    pool.query(`SELECT COUNT(*)::int AS n FROM checklist_items WHERE is_active=true`)
  ]);

  for (const g of variance.rows) flags.push({
    id: 'rent_variance', level: 'medium',
    title: `${g.name}'s rent needs approval`,
    detail: `Rent ${fmt(g.monthly_rent)} differs from the room rate ${fmt(g.room_rent)} and has waited more than 3 days.`,
    action: 'guests'
  });
  for (const p of purchases.rows) flags.push({
    id: 'big_purchase', level: 'medium',
    title: `Unusual ${p.category} purchase: ${fmt(p.amount)}`,
    detail: `${p.paid_to || 'Unknown vendor'} on ${routes.fmtD(p.purchase_date)} — more than double the usual ${fmt(p.avg_amt)} for ${p.category}.`,
    action: 'purchases'
  });
  // "Behind" means at least one full month owed AND she has been here at
  // least 30 days — the ledger charges the joining month on day one, so a
  // resident who joined this week legitimately shows one month due.
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  for (const g of rentDue.filter(x => x.amount_due > 0 && x.monthly_rent > 0 && x.amount_due >= x.monthly_rent && x.join_date && new Date(x.join_date).getTime() <= thirtyDaysAgo)) flags.push({
    id: 'overdue_30', level: g.amount_due >= 2 * g.monthly_rent ? 'high' : 'medium',
    title: `${g.name} is ${(g.amount_due / g.monthly_rent).toFixed(1)} months behind`,
    detail: `${fmt(g.amount_due)} outstanding${g.room_number ? ' · Room ' + g.room_number : ''}.`,
    action: 'reminders'
  });
  for (const r of refunds.rows) flags.push({
    id: 'refund_over_deposit', level: 'high',
    title: `Refund larger than deposit: ${r.guest_name}`,
    detail: `${fmt(r.refund_amount)} refunded against a ${fmt(r.deposit_amount)} deposit.`,
    action: 'admin'
  });
  const lowDays = checklist.rows.filter(r => parseFloat(r.pct) < 50);
  if (items.rows[0].n > 0 && checklist.rows.length >= 3 && lowDays.length === checklist.rows.length) flags.push({
    id: 'checklist_low', level: 'medium',
    title: 'Warden checklist under 50% for 3 days',
    detail: checklist.rows.map(r => `${routes.fmtD(r.log_date)}: ${Math.round(parseFloat(r.pct))}%`).join(' · '),
    action: 'daily-checklist'
  });
  if (claims.rows[0].n) flags.push({
    id: 'claims_waiting', level: 'medium',
    title: `${claims.rows[0].n} UPI payment${claims.rows[0].n === 1 ? '' : 's'} waiting over 2 days`,
    detail: `${fmt(claims.rows[0].total)} reported by residents and not yet confirmed — they are not counted as income until you confirm.`,
    action: 'payments'
  });
  if (approvals.rows[0].n) flags.push({
    id: 'approvals_waiting', level: 'low',
    title: `${approvals.rows[0].n} staff entr${approvals.rows[0].n === 1 ? 'y' : 'ies'} waiting for approval`,
    detail: `${fmt(approvals.rows[0].total)} entered by staff more than 2 days ago.`,
    action: 'payments'
  });
  const order = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => order[a.level] - order[b.level]);
  return flags;
}

// ── Forecast: plain averages, labelled as such ────────────────────────────
// Next 3 months = average of the last 6 completed months, adjusted by the
// simple growth between the older and newer halves of the last 12. No ML —
// the owner can check it on a calculator.
function forecastFromTrend(trend, occupancy, excludeLast = true) {
  // The last entry is the report month. When that month is still running it
  // is partial and must not feed the averages; a finished month may.
  const completed = excludeLast ? trend.slice(0, -1) : trend.slice();
  const last6 = completed.slice(-6);
  const avg = k => last6.length ? last6.reduce((t, x) => t + x[k], 0) / last6.length : 0;
  const older = completed.slice(-12, -6), newer = completed.slice(-6);
  const growth = (k) => {
    const a = older.length ? older.reduce((t, x) => t + x[k], 0) / older.length : 0;
    const b = newer.length ? newer.reduce((t, x) => t + x[k], 0) / newer.length : 0;
    if (!a || !b) return 0;
    return Math.max(-0.25, Math.min(0.25, (b - a) / a)); // clamp to ±25% so one odd month can't run away
  };
  const gi = growth('income'), ge = growth('expenses');
  // Projection always starts the month AFTER the report month.
  const base = trend.length ? new Date(trend[trend.length - 1].month + '-01T00:00:00Z') : new Date();
  const months = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    const income = Math.round(avg('income') * (1 + gi * i / 3));
    const expenses = Math.round(avg('expenses') * (1 + ge * i / 3));
    months.push({ month: ym(d), label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }), income, expenses, net: income - expenses });
  }
  return {
    basis: `Average of the last ${last6.length} completed month${last6.length === 1 ? '' : 's'}, trend-adjusted (capped at ±25%).`,
    monthsUsed: last6.map(x => x.month),
    months,
    occupancy: { current: occupancy.percent, note: 'Occupancy is assumed to hold at the current level.' }
  };
}

// ── Five-line summary (deterministic; AI never invents a number) ─────────
function summarise(f, anomalies) {
  const lines = [];
  lines.push(`${f.label}: collected ${fmt(f.money.income)}, spent ${fmt(f.money.expenses)}, net ${f.money.net >= 0 ? 'surplus' : 'deficit'} of ${fmt(Math.abs(f.money.net))}.`);
  lines.push(`Occupancy ${f.occupancy.percent}% (${f.occupancy.occupied} of ${f.occupancy.beds} beds); ${f.occupancy.joined} joined, ${f.occupancy.left} left.`);
  const n = f.dues.residents, o = f.dues.ageing.over2.n;
  lines.push(n
    ? `${n} resident${n === 1 ? ' owes' : 's owe'} ${fmt(f.dues.total)} in total; ${o === 0 ? 'none' : o === n ? (n === 1 ? 'she is' : 'all of them are') : `${o} of them ${o === 1 ? 'is' : 'are'}`} two or more months behind.`
    : 'No rent outstanding at month end.');
  lines.push(`${f.complaints.raised} issue${f.complaints.raised === 1 ? '' : 's'} raised, ${f.complaints.resolved} resolved (avg ${f.complaints.avgDaysToResolve} days); ${f.complaints.openNow} still open${f.complaints.openHigh ? `, ${f.complaints.openHigh} high priority` : ''}.`);
  const high = anomalies.filter(a => a.level === 'high').length;
  lines.push(anomalies.length
    ? `${anomalies.length} item${anomalies.length === 1 ? '' : 's'} need attention${high ? ` (${high} high)` : ''}: ${anomalies.slice(0, 3).map(a => a.title).join('; ')}${anomalies.length > 3 ? '; …' : ''}.`
    : 'Nothing flagged for attention.');
  return lines.join('\n');
}

// ── Report assembly + cache ───────────────────────────────────────────────
async function getOwnerReport(yyyymm, { force } = {}) {
  if (!isYm(yyyymm)) throw new Error('month must be YYYY-MM');
  if (!force) {
    const hit = await pool.query('SELECT facts, summary_text, generated_at FROM owner_reports WHERE month=$1', [yyyymm]);
    // A past month is final once generated; the current month is always recomputed.
    if (hit.rows[0] && yyyymm < ym(istNow())) return { ...hit.rows[0].facts, summary: hit.rows[0].summary_text, generated_at: hit.rows[0].generated_at, cached: true };
  }
  const facts = await computeOwnerFacts(yyyymm);
  const anomalies = await computeAnomalies();
  const forecast = forecastFromTrend(facts.trend, facts.occupancy, yyyymm === ym(istNow()));
  const summary = summarise(facts, anomalies);
  const full = { ...facts, anomalies, forecast };
  await pool.query(
    `INSERT INTO owner_reports(month, facts, summary_text, generated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT (month) DO UPDATE SET facts=EXCLUDED.facts, summary_text=EXCLUDED.summary_text, generated_at=NOW()`,
    [yyyymm, JSON.stringify(full), summary]);
  return { ...full, summary, generated_at: new Date().toISOString(), cached: false };
}

// ── PDF ───────────────────────────────────────────────────────────────────
async function writeOwnerPdf(res, report, pgName) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="owner-report-${report.month}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  const W = doc.page.width - 80, ink = '#1E293B', muted = '#64748B', gold = '#C9A96E';
  const h = (t) => { doc.moveDown(0.6); doc.fillColor(ink).font('Helvetica-Bold').fontSize(12).text(t); doc.moveTo(40, doc.y + 2).lineTo(40 + W, doc.y + 2).lineWidth(0.6).strokeColor(gold).stroke(); doc.moveDown(0.5); doc.font('Helvetica').fontSize(9.5).fillColor(ink); };
  const kv = (rows) => { for (const [k, v] of rows) { const y = doc.y; doc.fillColor(muted).text(k, 40, y, { width: 220 }); doc.fillColor(ink).font('Helvetica-Bold').text(String(v), 260, y, { width: W - 220, align: 'right' }); doc.font('Helvetica'); doc.moveDown(0.2); } };

  doc.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(pgName);
  doc.font('Helvetica').fontSize(11).fillColor(muted).text(`Owner report — ${report.label}`);
  doc.fontSize(8).text(`Generated ${new Date(report.generated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  h('Summary');
  doc.fontSize(10).fillColor(ink).text(report.summary, { width: W, lineGap: 3 });

  h('Money');
  kv([['Collected (confirmed)', fmt(report.money.income)], ['Spent', fmt(report.money.expenses)], ['Net', fmt(report.money.net)],
      ['Deposits held (liability)', fmt(report.money.depositsHeld)], ['Deposits refunded this month', `${report.money.refundsInMonth.n} · ${fmt(report.money.refundsInMonth.total)}`],
      ['Cash position (balance sheet)', fmt(report.money.cashPosition)],
      ['Resident UPI claims unconfirmed', `${report.money.pendingClaims.n} · ${fmt(report.money.pendingClaims.total)}`],
      ['Staff entries awaiting approval', `${report.money.pendingApprovals.n} · ${fmt(report.money.pendingApprovals.total)}`]]);
  if (report.money.expensesByCategory.length) {
    doc.moveDown(0.4); doc.fillColor(muted).text('Top expense categories'); doc.moveDown(0.2);
    kv(report.money.expensesByCategory.slice(0, 6).map(c => [c.category, fmt(c.total)]));
  }

  h('Occupancy');
  kv([['Beds occupied', `${report.occupancy.occupied} of ${report.occupancy.beds} (${report.occupancy.percent}%)`], ['Vacant beds', report.occupancy.vacant], ['Joined this month', report.occupancy.joined], ['Left this month', report.occupancy.left]]);

  h('Rent outstanding (month end)');
  const a = report.dues.ageing;
  kv([['Residents owing', report.dues.residents], ['Total outstanding', fmt(report.dues.total)],
      ['Under 1 month', `${a.under1.n} · ${fmt(a.under1.total)}`], ['1–2 months', `${a.one2.n} · ${fmt(a.one2.total)}`], ['2+ months', `${a.over2.n} · ${fmt(a.over2.total)}`]]);
  if (report.dues.top.length) {
    doc.moveDown(0.4);
    routes.drawPdfTable(doc,
      [{ label: 'Resident', x: 40, width: 220, get: r => r.name }, { label: 'Room', x: 270, width: 80, get: r => r.room || '—' }, { label: 'Outstanding', x: 360, width: 150, get: r => fmt(r.amount) }],
      report.dues.top);
  }

  h('Issues & operations');
  kv([['Issues raised', report.complaints.raised], ['Issues resolved', report.complaints.resolved], ['Average days to resolve', report.complaints.avgDaysToResolve], ['Open now', `${report.complaints.openNow}${report.complaints.openHigh ? ` (${report.complaints.openHigh} high)` : ''}`],
      ['Checklist days logged', report.checklist.daysLogged], ['Average checklist completion', `${report.checklist.avgPercent}%`],
      ['Collections entered by voice', report.inputs.collection.voice || 0], ['Purchases entered from a photo', report.inputs.purchase.photo || 0]]);

  h('Needs attention');
  if (!report.anomalies.length) doc.fillColor(muted).text('Nothing flagged.');
  for (const f of report.anomalies.slice(0, 12)) {
    doc.fillColor(f.level === 'high' ? '#B91C1C' : f.level === 'medium' ? '#B45309' : muted).font('Helvetica-Bold').text(`${f.level.toUpperCase()} · ${f.title}`, { width: W });
    doc.fillColor(ink).font('Helvetica').text(f.detail, { width: W }); doc.moveDown(0.3);
  }

  h('Next 3 months (simple projection)');
  doc.fillColor(muted).fontSize(8.5).text(report.forecast.basis, { width: W }); doc.moveDown(0.3); doc.fontSize(9.5);
  routes.drawPdfTable(doc,
    [{ label: 'Month', x: 40, width: 120, get: r => r.label }, { label: 'Income', x: 170, width: 110, get: r => fmt(r.income) }, { label: 'Expenses', x: 290, width: 110, get: r => fmt(r.expenses) }, { label: 'Net', x: 410, width: 110, get: r => fmt(r.net) }],
    report.forecast.months);

  doc.fontSize(8).fillColor(muted).text('Every figure in this report is taken from the same calculations as the Reports, Balance Sheet and Rent Due screens.', 40, doc.page.height - 50, { width: W, align: 'center' });
  doc.end();
}

// ── CSV bundle as a ZIP (no dependency) ───────────────────────────────────
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function buildZip(files) {
  const parts = [], central = []; let offset = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  const now = new Date();
  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime(now), 10); local.writeUInt16LE(dosDate(now), 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, deflated);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime(now), 12); cd.writeUInt16LE(dosDate(now), 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(deflated.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}
const csvEsc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows, columns) { return [columns.join(','), ...rows.map(r => columns.map(c => csvEsc(r[c])).join(','))].join('\n') + '\n'; }

async function buildAccountantZip(from, to) {
  const [col, pur, ref, guests, rooms, assets, capital] = await Promise.all([
    pool.query(`SELECT c.id, c.collection_date, c.guest_name, r.room_number, c.collection_type, c.amount, c.payment_mode, c.collection_month, c.receipt_number, c.status, c.source, c.description
                  FROM collections c LEFT JOIN guests g ON g.id=c.guest_id LEFT JOIN rooms r ON r.id=g.room_id
                 WHERE c.is_deleted=false AND c.collection_date BETWEEN $1 AND $2 ORDER BY c.collection_date, c.id`, [from, to]),
    pool.query(`SELECT id, purchase_date, category, description, paid_to, amount, payment_mode, receipt_number, status, source FROM purchases WHERE is_deleted=false AND purchase_date BETWEEN $1 AND $2 ORDER BY purchase_date, id`, [from, to]),
    pool.query(`SELECT id, created_at::date AS refund_date, guest_name, deposit_amount, deductions, refund_amount, deduction_notes FROM deposit_refunds WHERE created_at::date BETWEEN $1 AND $2 ORDER BY created_at`, [from, to]).catch(() => ({ rows: [] })),
    pool.query(`SELECT g.id, g.name, r.room_number, g.join_date, g.leave_date, g.monthly_rent, g.deposit_amount, g.is_active FROM guests g LEFT JOIN rooms r ON r.id=g.room_id ORDER BY g.name`),
    pool.query(`SELECT id, room_number, floor, total_beds, room_type, monthly_rent, is_active FROM rooms ORDER BY room_number`),
    pool.query(`SELECT id, name, category, value, purchase_date FROM fixed_assets WHERE is_deleted=false ORDER BY purchase_date`).catch(() => ({ rows: [] })),
    pool.query(`SELECT id, transaction_date, amount, note FROM capital_transactions ORDER BY transaction_date`).catch(() => ({ rows: [] }))
  ]);
  const files = [
    { name: 'collections.csv', content: toCsv(col.rows, ['id', 'collection_date', 'guest_name', 'room_number', 'collection_type', 'amount', 'payment_mode', 'collection_month', 'receipt_number', 'status', 'source', 'description']) },
    { name: 'purchases.csv', content: toCsv(pur.rows, ['id', 'purchase_date', 'category', 'description', 'paid_to', 'amount', 'payment_mode', 'receipt_number', 'status', 'source']) },
    { name: 'deposit_refunds.csv', content: toCsv(ref.rows, ['id', 'refund_date', 'guest_name', 'deposit_amount', 'deductions', 'refund_amount', 'deduction_notes']) },
    { name: 'residents.csv', content: toCsv(guests.rows, ['id', 'name', 'room_number', 'join_date', 'leave_date', 'monthly_rent', 'deposit_amount', 'is_active']) },
    { name: 'rooms.csv', content: toCsv(rooms.rows, ['id', 'room_number', 'floor', 'total_beds', 'room_type', 'monthly_rent', 'is_active']) },
    { name: 'fixed_assets.csv', content: toCsv(assets.rows, ['id', 'name', 'category', 'value', 'purchase_date']) },
    { name: 'capital_transactions.csv', content: toCsv(capital.rows, ['id', 'transaction_date', 'amount', 'note']) },
    { name: 'README.txt', content: `Siri Mane PG accountant export\nPeriod: ${from} to ${to}\nGenerated: ${new Date().toISOString()}\n\nAmounts in INR. Only rows with status=confirmed count as income/expense; pending rows are included for completeness and marked in the status column.\nResidents and rooms are complete snapshots, not period-filtered.\n` }
  ];
  return buildZip(files);
}

// ── Scheduler: previous month's report on the 1st, 07:30 IST ─────────────
let lastRunMonth = null;
function startScheduler({ intervalMs = 60000, log = console.log } = {}) {
  const tick = async () => {
    try {
      const n = istNow();
      if (n.getUTCDate() !== 1 || n.getUTCHours() < 7 || (n.getUTCHours() === 7 && n.getUTCMinutes() < 30)) return;
      const prev = ym(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)));
      if (lastRunMonth === prev) return;
      lastRunMonth = prev;
      await getOwnerReport(prev, { force: true });
      log(`[owner] report for ${prev} generated`);
    } catch (e) { log('[owner] scheduler error: ' + e.message); }
  };
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  tick();
  return t;
}

module.exports = { computeOwnerFacts, computeAnomalies, forecastFromTrend, summarise, getOwnerReport, writeOwnerPdf, buildAccountantZip, buildZip, crc32, monthBounds, startScheduler, _resetScheduler: () => { lastRunMonth = null; } };
