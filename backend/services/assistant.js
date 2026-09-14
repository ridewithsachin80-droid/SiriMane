// backend/services/assistant.js — Sprint 4
//
// The warden's assistant: morning brief, rent reminders, complaint priority
// and "ask Siri Mane". Design rule, in one line: FACTS COME FROM SQL AND THE
// SAME FUNCTIONS THE SCREENS USE; TEXT IS A TEMPLATE. No LLM is required for
// any of this to work — Groq only ever rewords a fact it was given, and every
// number in a message is one the app already showed on a screen. That is what
// makes the ai_reads cache safe: one computed fact, one wording, everywhere.
const pool = require('../db');
const routes = require('./../routes/index');

const fmt = n => '₹' + Math.round(parseFloat(n || 0)).toLocaleString('en-IN');
const istToday = () => routes.istToday();
function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function monthLabel(d) { return new Date(d).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }

async function getSetting(key, fallback) {
  const r = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return r.rows[0] && r.rows[0].value ? r.rows[0].value : fallback;
}

// ── ai_reads cache ───────────────────────────────────────────────────────
async function cacheGet(key) {
  const r = await pool.query('SELECT text, data, computed_at FROM ai_reads WHERE key=$1 AND (expires_at IS NULL OR expires_at > NOW())', [key]);
  return r.rows[0] || null;
}
async function cachePut(key, text, data, ttlMinutes) {
  await pool.query(
    `INSERT INTO ai_reads(key, text, data, computed_at, expires_at) VALUES($1,$2,$3,NOW(),NOW() + ($4 || ' minutes')::interval)
     ON CONFLICT (key) DO UPDATE SET text=EXCLUDED.text, data=EXCLUDED.data, computed_at=NOW(), expires_at=EXCLUDED.expires_at`,
    [key, text, JSON.stringify(data), String(ttlMinutes)]);
}

// ── Facts (SQL only) ─────────────────────────────────────────────────────
async function computeFacts() {
  const today = istToday();
  const yesterday = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const [rentDue, headcount, beds, complaints, clTotal, clYesterday, pendingApprovals, pendingClaims] = await Promise.all([
    routes.computeRentDueList(),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE is_active=true`),
    pool.query(`SELECT COALESCE(SUM(total_beds),0)::int AS total FROM rooms WHERE is_active=true`),
    pool.query(`SELECT status, category, COUNT(*)::int AS n FROM complaints WHERE status NOT IN ('resolved','closed') GROUP BY status, category`),
    pool.query(`SELECT COUNT(*)::int AS n FROM checklist_items WHERE is_active=true`),
    pool.query(`SELECT COUNT(*)::int AS n FROM checklist_log l JOIN checklist_items i ON i.id=l.item_id AND i.is_active=true WHERE l.log_date=$1 AND l.is_checked=true`, [yesterday]),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS total FROM collections WHERE is_deleted=false AND status='pending_approval'`),
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS total FROM collections WHERE is_deleted=false AND status='pending_verification'`)
  ]);
  const owing = rentDue.filter(g => g.amount_due > 0);
  const monthsBehind = g => g.monthly_rent > 0 ? g.amount_due / g.monthly_rent : 0;
  const overdue = owing.filter(g => monthsBehind(g) >= 1).sort((a, b) => b.amount_due - a.amount_due);
  const openComplaints = complaints.rows.reduce((t, r) => t + r.n, 0);
  const highCats = ['Water', 'Electrical', 'Security'];
  const urgentComplaints = complaints.rows.filter(r => highCats.includes(r.category)).reduce((t, r) => t + r.n, 0);
  return {
    date: today,
    headcount: headcount.rows[0].n,
    totalBeds: beds.rows[0].total,
    vacantBeds: Math.max(0, beds.rows[0].total - headcount.rows[0].n),
    rentDue: { count: owing.length, total: owing.reduce((t, g) => t + g.amount_due, 0) },
    overdue: overdue.map(g => ({ id: g.id, name: g.name, room_number: g.room_number, amount_due: g.amount_due, months: Math.round(monthsBehind(g) * 10) / 10 })),
    complaints: { open: openComplaints, urgent: urgentComplaints },
    checklist: { yesterdayDone: clYesterday.rows[0].n, total: clTotal.rows[0].n, yesterday },
    pendingApprovals: pendingApprovals.rows[0],
    pendingClaims: pendingClaims.rows[0]
  };
}

// ── Morning brief (deterministic template) ──────────────────────────────
function renderBrief(f) {
  const d = new Date(f.date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const lines = [`🏠 *Siri Mane — ${d}*`, ''];
  lines.push(`👥 ${f.headcount} residents · ${f.vacantBeds} bed${f.vacantBeds === 1 ? '' : 's'} vacant`);
  lines.push(f.rentDue.count
    ? `💰 Rent due: ${f.rentDue.count} resident${f.rentDue.count === 1 ? '' : 's'}, ${fmt(f.rentDue.total)}`
    : `💰 Rent due: none — all settled ✅`);
  if (f.overdue.length) {
    lines.push(`⚠️ A month or more behind:`);
    f.overdue.slice(0, 8).forEach(g => lines.push(`   • ${g.name}${g.room_number ? ' (Room ' + g.room_number + ')' : ''} — ${fmt(g.amount_due)}`));
    if (f.overdue.length > 8) lines.push(`   • …and ${f.overdue.length - 8} more`);
  }
  if (f.pendingClaims.n) lines.push(`⏳ ${f.pendingClaims.n} UPI payment${f.pendingClaims.n === 1 ? '' : 's'} (${fmt(f.pendingClaims.total)}) reported by residents — confirm in Payments`);
  if (f.pendingApprovals.n) lines.push(`📝 ${f.pendingApprovals.n} staff entr${f.pendingApprovals.n === 1 ? 'y' : 'ies'} (${fmt(f.pendingApprovals.total)}) awaiting admin approval`);
  lines.push(f.complaints.open
    ? `🛠️ ${f.complaints.open} open issue${f.complaints.open === 1 ? '' : 's'}${f.complaints.urgent ? ` (${f.complaints.urgent} water/electrical/security)` : ''}`
    : `🛠️ No open issues`);
  lines.push(f.checklist.total
    ? `✅ Yesterday's checklist: ${f.checklist.yesterdayDone}/${f.checklist.total} done`
    : `✅ Checklist not set up yet`);
  return lines.join('\n');
}

async function getBrief({ force } = {}) {
  const key = 'brief:' + istToday();
  if (!force) { const hit = await cacheGet(key); if (hit) return { text: hit.text, facts: hit.data, computed_at: hit.computed_at, cached: true }; }
  const facts = await computeFacts();
  const text = renderBrief(facts);
  await cachePut(key, text, facts, 24 * 60);
  return { text, facts, computed_at: new Date().toISOString(), cached: false };
}

// ── Rent reminders ───────────────────────────────────────────────────────
// Templates only. Numbers come from computeRentDueList — the same function
// behind the Rent Due screen — so the resident is never told a figure the
// warden hasn't seen.
function reminderText(g, lang, pgName, upi) {
  const amt = fmt(g.amount_due);
  const months = g.monthly_rent > 0 ? g.amount_due / g.monthly_rent : 0;
  const upiLine = upi ? (lang === 'kn' ? `\nUPI: ${upi}` : `\nUPI: ${upi}`) : '';
  if (lang === 'kn') {
    const tone = months >= 2
      ? `ನಿಮ್ಮ ಬಾಡಿಗೆ ${amt} ಬಾಕಿ ಇದೆ (${Math.floor(months)} ತಿಂಗಳಿಗಿಂತ ಹೆಚ್ಚು). ದಯವಿಟ್ಟು ಇಂದೇ ಪಾವತಿಸಿ.`
      : `ನಿಮ್ಮ ಬಾಡಿಗೆ ${amt} ಬಾಕಿ ಇದೆ. ದಯವಿಟ್ಟು ಬೇಗ ಪಾವತಿಸಿ.`;
    return `ನಮಸ್ಕಾರ ${g.name} 🙏\n${tone}${upiLine}\n— ${pgName}`;
  }
  const tone = months >= 2
    ? `your rent of ${amt} is pending for over ${Math.floor(months)} months. Please clear it today.`
    : months >= 1
      ? `your rent of ${amt} is now due. Please pay at your earliest.`
      : `a balance of ${amt} is pending on your account. Please clear it when convenient.`;
  return `Hi ${g.name} 🙏\nThis is a gentle reminder from ${pgName}: ${tone}${upiLine}\nThank you!`;
}

async function draftReminders(lang) {
  const [list, pgName, upi] = await Promise.all([routes.computeRentDueList(), getSetting('pg_name', 'Siri Mane PG'), getSetting('upi_vpa', null)]);
  const owing = list.filter(g => g.amount_due > 0);
  const sentRecently = await pool.query(`SELECT guest_id, MAX(sent_at) AS last FROM reminder_log WHERE sent_at > NOW() - INTERVAL '7 days' GROUP BY guest_id`);
  const lastMap = Object.fromEntries(sentRecently.rows.map(r => [r.guest_id, r.last]));
  return owing.map(g => ({
    guest_id: g.id, name: g.name, room_number: g.room_number, phone: g.phone,
    amount_due: g.amount_due, months_behind: g.monthly_rent > 0 ? Math.round(g.amount_due / g.monthly_rent * 10) / 10 : 0,
    text: reminderText(g, lang, pgName, upi),
    last_reminded: lastMap[g.id] || null
  }));
}

// ── Complaint priority (rule first, model optional) ──────────────────────
// Sprint 13: the same rule, explained. Returns { priority, why } so a screen
// can show the reason next to the badge instead of guessing at it.
function priorityWhy(category, description) {
  const d = String(description || '').toLowerCase();
  const kw = d.match(/spark|shock|fire|smoke|gas|leak.*(electric|wire)|stranger|theft|stolen|harass|unsafe|no water|no power|flood/);
  if (kw) return { priority: 'high', why: `The description mentions "${kw[0]}" — a safety word that is always high priority (2-hour clock).` };
  if (['Water', 'Electrical', 'Security'].includes(category)) return { priority: 'high', why: `${category} requests are always high priority (2-hour clock).` };
  if (['Cleanliness', 'Food', 'Furniture', 'Wifi/Internet'].includes(category)) return { priority: 'medium', why: `${category} requests start at medium priority (24-hour clock).` };
  return { priority: 'low', why: `${category || 'Other'} requests start at low priority (72-hour clock) unless the description mentions a safety word.` };
}

function rulePriority(category, description) {
  const d = String(description || '').toLowerCase();
  if (/spark|shock|fire|smoke|gas|leak.*(electric|wire)|stranger|theft|stolen|harass|unsafe|no water|no power|flood/.test(d)) return 'high';
  if (['Water', 'Electrical', 'Security'].includes(category)) return 'high';
  if (['Cleanliness', 'Food', 'Furniture', 'Wifi/Internet'].includes(category)) return 'medium';
  return 'low';
}

// ── Ask Siri Mane (fixed, read-only query templates) ─────────────────────
// No SQL is ever generated from text. A question is matched to one of these
// templates by keywords; anything else gets an honest "can't answer that yet".
const ASK_TEMPLATES = [
  { id: 'unpaid', test: /(who|which).*(not paid|unpaid|due|owe|pending|baaki|ಬಾಕಿ)|rent due|who owes/i,
    run: async () => { const l = (await routes.computeRentDueList()).filter(g => g.amount_due > 0); return l.length ? `${l.length} resident${l.length === 1 ? '' : 's'} owe ${fmt(l.reduce((t, g) => t + g.amount_due, 0))}:\n` + l.map(g => `• ${g.name}${g.room_number ? ' (Room ' + g.room_number + ')' : ''} — ${fmt(g.amount_due)}`).join('\n') : 'Nobody owes rent right now ✅'; } },
  { id: 'collected', test: /(how much|total).*(collect|receiv|income|rent).*(month|today|week)|collect.*(this|last) month|income (this|last) month/i,
    run: async (q) => { const last = /last month/i.test(q); const r = await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t, COUNT(*)::int AS n FROM collections WHERE is_deleted=false AND status='confirmed' AND date_trunc('month', collection_date) = date_trunc('month', (CURRENT_DATE + INTERVAL '5 hours 30 minutes')::date - ($1 || ' month')::interval)`, [last ? '1' : '0']); return `${last ? 'Last' : 'This'} month: ${fmt(r.rows[0].t)} collected across ${r.rows[0].n} confirmed payment${r.rows[0].n === 1 ? '' : 's'}.`; } },
  { id: 'spent', test: /(how much|total).*(spen|expense|purchase)|expenses? (this|last) month|purchases? (this|last) month/i,
    run: async (q) => { const last = /last month/i.test(q); const r = await pool.query(`SELECT COALESCE(SUM(amount),0)::float AS t, COUNT(*)::int AS n FROM purchases WHERE is_deleted=false AND date_trunc('month', purchase_date) = date_trunc('month', (CURRENT_DATE + INTERVAL '5 hours 30 minutes')::date - ($1 || ' month')::interval)`, [last ? '1' : '0']); return `${last ? 'Last' : 'This'} month: ${fmt(r.rows[0].t)} spent across ${r.rows[0].n} purchase${r.rows[0].n === 1 ? '' : 's'}.`; } },
  { id: 'occupancy', test: /occupan|vacan|empty (bed|room)|free (bed|room)|how many (bed|room|resident|guest|girl)|headcount/i,
    run: async () => { const f = await computeFacts(); return `${f.headcount} residents in ${f.totalBeds} beds — ${f.vacantBeds} vacant.`; } },
  { id: 'complaints', test: /complain|issue|problem|maintenance/i,
    run: async () => { const r = await pool.query(`SELECT category, COUNT(*)::int AS n FROM complaints WHERE status NOT IN ('resolved','closed') GROUP BY category ORDER BY n DESC`); const t = r.rows.reduce((a, b) => a + b.n, 0); return t ? `${t} open issue${t === 1 ? '' : 's'}: ` + r.rows.map(x => `${x.category} ${x.n}`).join(', ') + '.' : 'No open issues ✅'; } },
  { id: 'joined', test: /(who|anyone).*(join|new|check.?in|came)|new (resident|guest)s?/i,
    run: async () => { const r = await pool.query(`SELECT g.name, r.room_number, g.join_date FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.join_date > CURRENT_DATE - 30 ORDER BY g.join_date DESC`); return r.rows.length ? `Joined in the last 30 days:\n` + r.rows.map(g => `• ${g.name}${g.room_number ? ' (Room ' + g.room_number + ')' : ''} — ${new Date(g.join_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`).join('\n') : 'Nobody joined in the last 30 days.'; } },
  { id: 'deposits', test: /deposit.*(pending|due|not paid|balance)|(pending|due).*deposit/i,
    run: async () => { const r = await pool.query(`SELECT g.name, r.room_number, g.deposit_amount - COALESCE((SELECT SUM(amount) FROM collections c WHERE c.guest_id=g.id AND c.collection_type='deposit' AND c.is_deleted=false AND c.status='confirmed'),0) AS pending FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`); const l = r.rows.filter(x => parseFloat(x.pending) > 0.5); return l.length ? `Deposit pending from ${l.length}:\n` + l.map(x => `• ${x.name}${x.room_number ? ' (Room ' + x.room_number + ')' : ''} — ${fmt(x.pending)}`).join('\n') : 'All deposits are fully paid ✅'; } },
  { id: 'brief', test: /brief|summary|today|morning|what.?s (up|happening|new)/i,
    run: async () => (await getBrief()).text }
];
async function ask(question) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) return { answer: 'Ask me something like "who has not paid?" or "how much collected this month?"', template: null };
  for (const t of ASK_TEMPLATES) {
    if (t.test.test(q)) return { answer: await t.run(q), template: t.id };
  }
  return { answer: `I can't answer that yet. Try: who has not paid · how much collected this month · expenses this month · occupancy · open issues · who joined recently · deposits pending · today's brief.`, template: null };
}

// ── Scheduler: compute the brief once a day at the configured IST time ───
let lastRunDate = null;
let inFlight = null;
function startScheduler({ intervalMs = 60000, log = console.log } = {}) {
  // Ticks are serialised: if one is still computing, the next caller waits
  // for it instead of racing it (otherwise the start-up tick and the first
  // interval tick could overlap and the brief would be skipped for the day).
  const tick = () => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  };
  const run = async () => {
    try {
      const at = await getSetting('brief_time', '07:00');
      const now = istNow();
      const hhmm = now.toISOString().slice(11, 16);
      const today = now.toISOString().slice(0, 10);
      if (hhmm >= at && lastRunDate !== today) {
        lastRunDate = today;
        const b = await getBrief({ force: true });
        log(`[brief] computed for ${today}: ${b.facts.rentDue.count} due, ${b.facts.complaints.open} open issues`);
      }
    } catch (e) { log('[brief] scheduler error: ' + e.message); }
  };
  const h = setInterval(tick, intervalMs);
  if (h.unref) h.unref();
  tick();
  return { stop: () => clearInterval(h), tick };
}

module.exports = { computeFacts, renderBrief, getBrief, draftReminders, reminderText, rulePriority, priorityWhy, ask, ASK_TEMPLATES, startScheduler, cacheGet, cachePut, _resetScheduler: () => { lastRunDate = null; } };
