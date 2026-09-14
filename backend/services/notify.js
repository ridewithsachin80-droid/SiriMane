// backend/services/notify.js — Sprint 12
//
// One bell and one outbox.
//
// Two rules shape this file:
//   • Nothing is sent automatically. The outbox drafts messages; the warden
//     taps send, one by one, through wa.me. That is the choice Sachin made in
//     Sprint 4 and it still holds.
//   • Every generator builds a stable dedupe_key, so running the sweep twice
//     an hour — or twice a second — produces one notification, not two.
const pool = require('../db');
const routes = require('../routes/index');
const assistant = require('./assistant');
const owner = require('./owner');
const finance = require('./finance');

const fmt = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => ist().toISOString().slice(0, 10);
const LEVELS = ['critical', 'important', 'informational', 'digest'];

// ── Notifications ────────────────────────────────────────────────────────
async function push({ level, category, title, detail, action_page, dedupe_key, for_role = 'staff' }) {
  const r = await pool.query(`
    INSERT INTO notifications(level, category, title, detail, action_page, dedupe_key, for_role)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [LEVELS.includes(level) ? level : 'informational', category, title, detail || null, action_page || null, dedupe_key, for_role]);
  return r.rows[0] || null;
}

// Runs the generators. Safe to call as often as you like.
// `opts.now` (tests only) is an IST wall-clock moment expressed as a UTC Date,
// the same convention as ist(): new Date('2026-09-30T18:05:00Z') means 18:05 IST.
async function sweep(opts = {}) {
  const nowIst = opts.now ? new Date(opts.now) : ist();
  const day = nowIst.toISOString().slice(0, 10);
  const hour = nowIst.getUTCHours();
  const made = [];
  const add = async n => { const r = await push(n); if (r) made.push(n.dedupe_key); };

  const [facts, due, sla, closing, docs, maint] = await Promise.all([
    assistant.computeFacts(),
    routes.computeRentDueList(),
    pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE sla_due_at < NOW() AND status NOT IN ('resolved','closed')`),
    finance.getDayClosing(day),
    pool.query(`SELECT d.id, d.doc_type, d.expires_on, g.name FROM resident_documents d JOIN guests g ON g.id=d.guest_id
                 WHERE g.is_active=true AND d.expires_on IS NOT NULL AND d.expires_on <= CURRENT_DATE + 30`),
    pool.query(`SELECT id, task, vendor, next_due FROM maintenance_schedule WHERE is_active=true AND next_due <= CURRENT_DATE + 7`)
  ]);

  // Money
  const badly = due.filter(g => g.monthly_rent > 0 && g.amount_due >= 2 * g.monthly_rent);
  if (badly.length) await add({
    level: 'critical', category: 'finance', dedupe_key: `overdue2:${day}`, action_page: 'reminders',
    title: `${badly.length} resident${badly.length === 1 ? ' is' : 's are'} two months or more behind`,
    detail: `${fmt(badly.reduce((t, g) => t + g.amount_due, 0))} outstanding — ${badly.slice(0, 3).map(g => g.name).join(', ')}${badly.length > 3 ? ` +${badly.length - 3}` : ''}.`
  });
  if (facts.pendingClaims.n) await add({
    level: 'important', category: 'finance', dedupe_key: `claims:${day}`, action_page: 'payments', for_role: 'admin',
    title: `${facts.pendingClaims.n} UPI payment${facts.pendingClaims.n === 1 ? '' : 's'} waiting for confirmation`,
    detail: `${fmt(facts.pendingClaims.total)} reported by residents. It is not counted as income until you confirm it.`
  });
  // Yesterday's takings never counted
  const yest = new Date(new Date(day + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const yestClosing = await finance.getDayClosing(yest);
  const yestTotal = yestClosing.expected.cash + yestClosing.expected.upi + yestClosing.expected.bank;
  if (!yestClosing.closed && yestTotal > 0) await add({
    level: 'important', category: 'finance', dedupe_key: `notclosed:${yest}`, action_page: 'finance-overview',
    title: `${yest} was never counted`,
    detail: `${fmt(yestTotal)} was recorded that day and the cash-up was not done.`
  });

  // Operations
  if (sla.rows[0].n) await add({
    level: 'critical', category: 'requests', dedupe_key: `sla:${day}`, action_page: 'complaints',
    title: `${sla.rows[0].n} request${sla.rows[0].n === 1 ? ' is' : 's are'} past the promised time`,
    detail: 'Water, electrical and security requests are due within 2 hours.'
  });
  if (facts.checklist.total && facts.checklist.yesterdayDone / facts.checklist.total < 0.5) await add({
    level: 'important', category: 'operations', dedupe_key: `checklist:${day}`, action_page: 'daily-checklist',
    title: `Yesterday's checklist reached only ${facts.checklist.yesterdayDone} of ${facts.checklist.total}`,
    detail: 'Tasks left undone tend to become complaints.'
  });

  // Residents
  for (const d of docs.rows) {
    const expired = d.expires_on < day;
    await add({
      level: expired ? 'important' : 'informational', category: 'residents', dedupe_key: `doc:${d.id}:${d.expires_on}`, action_page: 'guests',
      title: `${d.name}'s ${d.doc_type} ${expired ? 'has expired' : 'expires soon'}`,
      detail: `Due ${d.expires_on}.`
    });
  }
  for (const m of maint.rows) await add({
    level: m.next_due < day ? 'important' : 'informational', category: 'operations', dedupe_key: `maint:${m.id}:${m.next_due}`, action_page: 'maintenance',
    title: `${m.task} ${m.next_due < day ? 'is overdue' : 'is due'}`,
    detail: `${m.vendor ? m.vendor + ' · ' : ''}due ${m.next_due}.`
  });

  // ── Sprint 13: three proactive nudges, each once per window ──────────
  // Afternoon (from 15:00 IST): one nudge, only if something is unresolved.
  if (hour >= 15) {
    const [highOpen, todayCollected, clToday] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE status NOT IN ('resolved','closed') AND priority='high'`),
      pool.query(`SELECT COUNT(*)::int AS n FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1`, [day]),
      pool.query(`SELECT COUNT(*)::int AS n FROM checklist_log l JOIN checklist_items i ON i.id=l.item_id AND i.is_active=true WHERE l.log_date=$1 AND l.is_checked=true`, [day])
    ]);
    const reasons = [];
    let action = 'daily-checklist';
    if (highOpen.rows[0].n) { reasons.push(`${highOpen.rows[0].n} high-priority request${highOpen.rows[0].n === 1 ? ' is' : 's are'} still open`); action = 'complaints'; }
    if (facts.rentDue.count && !todayCollected.rows[0].n) { reasons.push(`nothing collected yet today with ${fmt(facts.rentDue.total)} due from ${facts.rentDue.count}`); if (action === 'daily-checklist') action = 'collect'; }
    if (facts.checklist.total && clToday.rows[0].n / facts.checklist.total < 0.5) reasons.push(`the checklist is at ${clToday.rows[0].n} of ${facts.checklist.total}`);
    if (reasons.length) await add({
      level: 'important', category: 'operations', dedupe_key: `afternoon:${day}`, action_page: action,
      title: 'Afternoon check: still open',
      detail: reasons.map(r => r[0].toUpperCase() + r.slice(1)).join(' · ') + '. There is time before the evening summary.'
    });
  }
  // Month-end (last day of the month, from 18:00 IST): what is still out.
  const lastDay = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (day === lastDay && hour >= 18) {
    const owing = due.filter(g => g.amount_due > 0);
    await add({
      level: 'important', category: 'finance', dedupe_key: `monthend:${day.slice(0, 7)}`, action_page: 'rent-due',
      title: `Month-end: ${fmt(owing.reduce((t, g) => t + g.amount_due, 0))} still outstanding from ${owing.length}`,
      detail: `${owing.slice(0, 3).map(g => g.name).join(', ')}${owing.length > 3 ? ` +${owing.length - 3}` : ''}${owing.length ? '. ' : ''}The owner report for ${nowIst.toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })} is ready tomorrow morning.`
    });
  }
  // Before checkout (2 days ahead): everything to settle, so nothing is rushed.
  const soon = new Date(new Date(day + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const leaving = await pool.query(`SELECT g.id, g.name, g.deposit_amount, g.expected_checkout, r.room_number,
        (SELECT COUNT(*)::int FROM complaints c WHERE c.guest_id=g.id AND c.status NOT IN ('resolved','closed')) AS open_requests
      FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.expected_checkout=$1::date`, [soon]);
  for (const g of leaving.rows) {
    const bal = (due.find(d => d.id === g.id) || {}).amount_due || 0;
    await add({
      level: 'important', category: 'residents', dedupe_key: `checkout2:${g.id}:${soon}`, action_page: 'guests',
      title: `${g.name} checks out in 2 days${g.room_number ? ' (Room ' + g.room_number + ')' : ''}`,
      detail: `Deposit on file ${fmt(g.deposit_amount)} · ${bal > 0 ? fmt(bal) + ' still outstanding' : 'nothing outstanding'} · ${g.open_requests ? g.open_requests + ' open request' + (g.open_requests === 1 ? '' : 's') : 'no open requests'}. Settle these before the day, not on it.`
    });
  }

  // Owner-level anomalies, folded in at digest level so they do not shout.
  try {
    const flags = await owner.computeAnomalies();
    for (const f of flags.filter(x => x.level === 'high').slice(0, 5)) {
      await add({ level: 'digest', category: 'finance', dedupe_key: `flag:${f.id}:${f.title.slice(0, 40)}:${day}`, action_page: f.action, title: f.title, detail: f.detail, for_role: 'admin' });
    }
  } catch { /* anomalies are best-effort */ }

  return { created: made.length, keys: made };
}

async function list({ user, unreadOnly, limit = 60 }) {
  const p = [user.role === 'admin' ? ['staff', 'admin'] : ['staff']];
  let where = `for_role = ANY($1)`;
  if (unreadOnly) where += ` AND read_at IS NULL`;
  p.push(Math.min(limit, 200));
  const r = await pool.query(`SELECT * FROM notifications WHERE ${where}
    ORDER BY (read_at IS NOT NULL), CASE level WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'informational' THEN 2 ELSE 3 END, created_at DESC
    LIMIT $2`, p);
  const unread = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE for_role = ANY($1) AND read_at IS NULL`, [p[0]]);
  return { items: r.rows, unread: unread.rows[0].n };
}

// ── Outbox ───────────────────────────────────────────────────────────────
// Drafts only. Sending is the warden tapping wa.me, and we record that she did.
const TEMPLATES = {
  rent_due: (g, pg) => `Namaste ${g.name}, a gentle reminder that this month's rent of ${fmt(g.amount_due || g.monthly_rent)} is due at ${pg}. ${g.upi ? `You can pay by UPI to ${g.upi}. ` : ''}Thank you.`,
  rent_overdue: (g, pg) => `Namaste ${g.name}, your rent of ${fmt(g.amount_due)} at ${pg} is still pending. Please clear it at the earliest, or tell us if you need a few days. Thank you.`,
  payment_confirmed: (g, pg, extra) => `Namaste ${g.name}, we have received ${fmt(extra.amount)} towards your rent at ${pg}. Thank you!`,
  request_updated: (g, pg, extra) => `Namaste ${g.name}, your ${extra.category} request is now ${String(extra.status).replace('_', ' ')}.${extra.note ? ` ${extra.note}` : ''} — ${pg}`,
  welcome: (g, pg) => `Welcome to ${pg}, ${g.name}! Your room is ${g.room_number || 'ready'}. You can see your rent, pay online and report any issue at sirimane.in/guest — log in with your mobile number.`,
  checkout_reminder: (g, pg) => `Namaste ${g.name}, we have your checkout noted for ${g.expected_checkout}. Please let us know the time so we can settle the deposit. — ${pg}`
};

async function draftOutbox({ kinds } = {}) {
  const day = istToday();
  const [settings, due, guests] = await Promise.all([
    pool.query(`SELECT key, value FROM app_settings WHERE key IN ('pg_name','upi_vpa')`),
    routes.computeRentDueList(),
    pool.query(`SELECT g.id, g.name, g.phone, g.join_date, g.expected_checkout, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`)
  ]);
  const st = Object.fromEntries(settings.rows.map(x => [x.key, x.value]));
  const pg = st.pg_name || 'Siri Mane PG';
  const want = k => !kinds || kinds.includes(k);
  const dayNum = ist().getUTCDate();
  const drafted = [];
  const add = async (kind, g, body, key) => {
    if (!g.phone) return;
    const r = await pool.query(`INSERT INTO outbox(kind, guest_id, guest_name, phone, body, dedupe_key)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [kind, g.id, g.name, g.phone, body, key]);
    if (r.rows[0]) drafted.push({ id: r.rows[0].id, kind, guest_id: g.id });
  };

  const byId = new Map(guests.rows.map(g => [g.id, g]));
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  for (const d of due) {
    const g = { ...(byId.get(d.id) || {}), ...d, upi: st.upi_vpa };
    if (!g.phone) continue;
    // The ledger charges the joining month on day one, so someone who moved in
    // last week can read as "a month behind". Nobody is chased as overdue
    // before she has been here thirty days.
    const settled = g.join_date && new Date(g.join_date).getTime() <= thirtyDaysAgo;
    const months = (g.monthly_rent > 0 && settled) ? g.amount_due / g.monthly_rent : 0;
    // The 1st is the polite reminder; the 7th is the follow-up. Nothing else
    // is drafted, because one honest message beats a drip of them.
    if (want('rent_due') && dayNum <= 3 && g.amount_due > 0 && months < 1)
      await add('rent_due', g, TEMPLATES.rent_due(g, pg), `rent_due:${g.id}:${day.slice(0, 7)}`);
    if (want('rent_overdue') && dayNum >= 7 && months >= 1)
      await add('rent_overdue', g, TEMPLATES.rent_overdue(g, pg), `rent_overdue:${g.id}:${day.slice(0, 7)}`);
  }
  if (want('checkout_reminder')) {
    for (const g of guests.rows.filter(x => x.expected_checkout && String(x.expected_checkout).slice(0, 10) <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)))
      await add('checkout_reminder', g, TEMPLATES.checkout_reminder({ ...g, expected_checkout: String(g.expected_checkout).slice(0, 10) }, pg), `checkout:${g.id}:${String(g.expected_checkout).slice(0, 10)}`);
  }
  return { drafted: drafted.length, items: drafted };
}

// Called by the app when something happens that a resident should hear about.
async function queueMessage({ kind, guest_id, extra = {}, key }) {
  const g = await pool.query(`SELECT g.id, g.name, g.phone, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [guest_id]);
  const x = g.rows[0];
  if (!x || !x.phone || !TEMPLATES[kind]) return null;
  const st = await pool.query(`SELECT value FROM app_settings WHERE key='pg_name'`);
  const body = TEMPLATES[kind](x, st.rows[0]?.value || 'Siri Mane PG', extra);
  const r = await pool.query(`INSERT INTO outbox(kind, guest_id, guest_name, phone, body, dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [kind, x.id, x.name, x.phone, body, key || `${kind}:${x.id}:${Date.now()}`]);
  return r.rows[0] || null;
}

function waLink(phone, body) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  if (d.length < 11) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(body)}`;
}

// ── AI success metrics ───────────────────────────────────────────────────
// The point of this page: is Siri actually saving work, or just talking?
async function aiMetrics(days = 30) {
  const [asks, proposals, sources, corrections] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS asks,
                       COUNT(*) FILTER (WHERE proposal_id IS NOT NULL)::int AS prepared,
                       COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
                       COUNT(*) FILTER (WHERE interpretation->>'clarify' IS NOT NULL)::int AS clarifications,
                       ROUND(AVG(ms))::int AS avg_ms
                  FROM ai_actions WHERE created_at >= NOW() - ($1||' days')::interval AND request_text <> 'confirm'`, [days]),
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed
                  FROM ai_proposals WHERE created_at >= NOW() - ($1||' days')::interval`, [days]),
    pool.query(`SELECT 'collection' AS kind, COALESCE(source,'manual') AS source, COUNT(*)::int AS n FROM collections WHERE is_deleted=false AND created_at >= NOW() - ($1||' days')::interval GROUP BY source
                UNION ALL SELECT 'purchase', COALESCE(source,'manual'), COUNT(*)::int FROM purchases WHERE is_deleted=false AND created_at >= NOW() - ($1||' days')::interval GROUP BY source
                UNION ALL SELECT 'request', COALESCE(source,'manual'), COUNT(*)::int FROM complaints WHERE created_at >= NOW() - ($1||' days')::interval GROUP BY source`, [days]),
    pool.query(`SELECT COUNT(*)::int AS n FROM outbox WHERE status='sent' AND created_at >= NOW() - ($1||' days')::interval`, [days])
  ]);
  const a = asks.rows[0], p = proposals.rows[0];
  const byKind = {};
  for (const r of sources.rows) { byKind[r.kind] = byKind[r.kind] || {}; byKind[r.kind][r.source] = r.n; }
  const aiEntries = sources.rows.filter(r => r.source !== 'manual').reduce((t, r) => t + r.n, 0);
  const allEntries = sources.rows.reduce((t, r) => t + r.n, 0);
  return {
    days,
    asks: a.asks, prepared: a.prepared, errors: a.errors, clarifications: a.clarifications, avg_ms: a.avg_ms,
    proposals: p.total, confirmed: p.confirmed,
    acceptance_rate: p.total ? Math.round(p.confirmed * 100 / p.total) : null,
    clarification_rate: a.asks ? Math.round(a.clarifications * 100 / a.asks) : null,
    entries_by_source: byKind,
    ai_entry_share: allEntries ? Math.round(aiEntries * 100 / allEntries) : 0,
    reminders_sent: corrections.rows[0].n,
    note: 'Acceptance is proposals confirmed ÷ proposals shown. A low rate means Siri is guessing badly; a high clarification rate means she is asking rather than guessing, which is the safer failure.'
  };
}

// ── Sweep scheduler ──────────────────────────────────────────────────────
let lastSweep = null, inFlight = null;
function startScheduler({ intervalMs = 15 * 60 * 1000, log = console.log } = {}) {
  const run = async () => {
    try {
      const stamp = ist().toISOString().slice(0, 13); // hourly at most
      if (lastSweep === stamp) return;
      lastSweep = stamp;
      const r = await sweep();
      if (r.created) log(`[notify] ${r.created} new notification(s)`);
      await draftOutbox();
    } catch (e) { log('[notify] ' + e.message); }
  };
  const tick = () => { if (inFlight) return inFlight; inFlight = run().finally(() => { inFlight = null; }); return inFlight; };
  const h = setInterval(tick, intervalMs); if (h.unref) h.unref(); tick();
  return { stop: () => clearInterval(h), tick };
}

module.exports = { push, sweep, list, draftOutbox, queueMessage, waLink, aiMetrics, startScheduler, TEMPLATES, _reset: () => { lastSweep = null; } };
