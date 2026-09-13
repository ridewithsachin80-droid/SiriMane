// backend/services/tools.js — Sprint 6
//
// The ONLY things the Copilot can do. Each tool declares:
//   name, description (what the model reads), args (validated before run),
//   role  ('staff' = staff+admin, 'admin' = admin only),
//   level ('inform' runs immediately · 'prepare' returns a preview the user
//          reviews · 'execute' needs an explicit confirm tap and is audited),
//   run(args, ctx) → result.
//
// EXECUTE tools never write SQL of their own. They call the same HTTP route
// the form calls, with the user's own token, on this same server — so role
// checks, validation, status rules, receipt numbers and the activity log are
// exactly what a hand-entered record gets. The model never touches the DB.
const pool = require('../db');
const routes = require('../routes/index');
const assistant = require('./assistant');
const owner = require('./owner');
const SMParse = require('../../frontend/public/js/speech-parser.js');

const fmt = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const isIsoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ── Self-call helper: same route the UI uses, same token, same rules ───────
async function callRoute(ctx, method, path, body) {
  const url = `http://127.0.0.1:${ctx.port}/api${path}`;
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', Authorization: ctx.authorization },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `Route ${method} ${path} failed (${res.status})`);
  return data;
}

// ── Resident resolution: by id, exact name, first name, or room ────────────
async function resolveResident({ id, name, room }) {
  const list = await routes.computeRentDueList();
  const all = await pool.query(`SELECT g.id, g.name, g.phone, r.room_number, g.monthly_rent FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`);
  const residents = all.rows.map(g => ({ ...g, amount_due: (list.find(x => x.id === g.id) || {}).amount_due || 0 }));
  if (id) return { match: residents.find(r => String(r.id) === String(id)) || null, candidates: [] };
  const text = [name, room ? 'room ' + room : ''].filter(Boolean).join(' ');
  const m = SMParse.matchResident(text, residents, room);
  if (m) return { match: m, candidates: [] };
  // Ambiguity: return the candidates so the caller can ask "which one?"
  const tokens = String(name || '').toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = residents.filter(r => tokens.some(t => t.length >= 3 && r.name.toLowerCase().includes(t)));
  return { match: null, candidates: candidates.slice(0, 5) };
}

const TOOLS = {
  // ═══════════════════ INFORM ═══════════════════
  get_today: {
    description: 'Today’s brief: headcount, vacancy, rent due, overdue residents, open issues, checklist, pending claims. Use for "what needs attention", "how are things", "morning brief".',
    args: {}, role: 'staff', level: 'inform',
    async run() { const b = await assistant.getBrief(); return { text: b.text, facts: b.facts }; }
  },
  get_outstanding_rent: {
    description: 'Residents who owe rent, optionally filtered. Use for "who has not paid", "who owes more than X", "overdue more than N days/months".',
    args: { min_amount: 'number?', min_months: 'number?', room: 'string?' }, role: 'staff', level: 'inform',
    async run(a) {
      let l = (await routes.computeRentDueList()).filter(g => g.amount_due > 0);
      if (a.min_amount) l = l.filter(g => g.amount_due >= a.min_amount);
      if (a.min_months) l = l.filter(g => g.monthly_rent > 0 && g.amount_due / g.monthly_rent >= a.min_months);
      if (a.room) l = l.filter(g => String(g.room_number || '').toUpperCase() === String(a.room).toUpperCase());
      const total = l.reduce((t, g) => t + g.amount_due, 0);
      return {
        text: l.length ? `${l.length} resident${l.length === 1 ? '' : 's'} owe ${fmt(total)}.` : 'Nobody matches — no rent outstanding for that filter.',
        rows: l.map(g => ({ id: g.id, name: g.name, room: g.room_number, amount_due: g.amount_due, months: g.monthly_rent > 0 ? Math.round(g.amount_due / g.monthly_rent * 10) / 10 : 0 })),
        total
      };
    }
  },
  search_residents: {
    description: 'Find residents by name, phone or room. Use for "find Priya", "who is in room 12", "Ananya’s number".',
    args: { query: 'string' }, role: 'staff', level: 'inform',
    async run(a) {
      const q = `%${String(a.query || '').trim()}%`;
      const r = await pool.query(`SELECT g.id, g.name, g.phone, r.room_number, g.bed_number, g.join_date, g.monthly_rent FROM guests g LEFT JOIN rooms r ON r.id=g.room_id
        WHERE g.is_active=true AND (g.name ILIKE $1 OR g.phone ILIKE $1 OR r.room_number ILIKE $1) ORDER BY g.name LIMIT 20`, [q]);
      const due = await routes.computeRentDueList();
      const rows = r.rows.map(g => ({ ...g, amount_due: (due.find(x => x.id === g.id) || {}).amount_due || 0 }));
      return { text: rows.length ? `${rows.length} match${rows.length === 1 ? '' : 'es'}.` : 'No resident matches.', rows };
    }
  },
  get_resident: {
    description: 'Everything about one resident: room, rent, balance, deposit, open issues. Use for "summarise Priya", "why is she overdue", or when the user is viewing a resident ("her", "this resident").',
    args: { resident_id: 'number?', name: 'string?' }, role: 'staff', level: 'inform',
    async run(a, ctx) {
      const { match, candidates } = await resolveResident({ id: a.resident_id || ctx.context?.resident_id, name: a.name });
      if (!match) return { clarify: candidates.length ? 'Which resident?' : 'I could not find that resident.', candidates };
      const [g, issues] = await Promise.all([
        pool.query(`SELECT g.*, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [match.id]),
        pool.query(`SELECT id, category, status, priority, created_at FROM complaints WHERE guest_id=$1 AND status<>'resolved' ORDER BY created_at DESC`, [match.id])
      ]);
      const ledger = await routes.computeGuestLedger(g.rows[0]);
      const x = g.rows[0];
      const due = ledger.currentBalance < 0 ? -ledger.currentBalance : 0;
      const months = x.monthly_rent > 0 ? Math.round(due / x.monthly_rent * 10) / 10 : 0;
      return {
        text: `${x.name}${x.room_number ? ' · Room ' + x.room_number : ''}${x.bed_number ? ' Bed ' + x.bed_number : ''} · rent ${fmt(x.monthly_rent)} · ${due > 0 ? `owes ${fmt(due)} (${months} month${months === 1 ? '' : 's'})` : 'nothing outstanding'} · deposit ${fmt(x.deposit_amount)} · ${issues.rows.length} open issue${issues.rows.length === 1 ? '' : 's'}.`,
        resident: { id: x.id, name: x.name, room: x.room_number, bed: x.bed_number, phone: x.phone, monthly_rent: parseFloat(x.monthly_rent), deposit: parseFloat(x.deposit_amount), join_date: x.join_date, amount_due: due, months_behind: months },
        issues: issues.rows
      };
    }
  },
  get_room_status: {
    description: 'Rooms and beds: who is in a room, free beds, open issues in the room. Use for "which rooms are available", "what’s wrong here" when viewing a room, "who is in 204".',
    args: { room: 'string?', only_vacant: 'boolean?' }, role: 'staff', level: 'inform',
    async run(a, ctx) {
      const room = a.room || ctx.context?.room_number;
      const r = await pool.query(`SELECT r.id, r.room_number, r.floor, r.total_beds, r.monthly_rent,
          (SELECT COUNT(*) FROM guests g WHERE g.room_id=r.id AND g.is_active=true)::int AS occupied,
          (SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'bed', g.bed_number)) FROM guests g WHERE g.room_id=r.id AND g.is_active=true) AS residents,
          (SELECT COUNT(*) FROM complaints c WHERE c.room_number=r.room_number AND c.status<>'resolved')::int AS open_issues
        FROM rooms r WHERE r.is_active=true ${room ? 'AND r.room_number ILIKE $1' : ''} ORDER BY r.floor, r.room_number`, room ? [room] : []);
      let rows = r.rows.map(x => ({ ...x, vacant: Math.max(0, x.total_beds - x.occupied), residents: x.residents || [] }));
      if (a.only_vacant) rows = rows.filter(x => x.vacant > 0);
      const vacantTotal = rows.reduce((t, x) => t + x.vacant, 0);
      let text;
      if (room && rows.length === 1) {
        const x = rows[0];
        text = `Room ${x.room_number}: ${x.occupied} of ${x.total_beds} beds occupied${x.residents.length ? ' (' + x.residents.map(z => z.name).join(', ') + ')' : ''} · ${x.open_issues} open issue${x.open_issues === 1 ? '' : 's'} · rent ${fmt(x.monthly_rent)}.`;
      } else text = a.only_vacant ? `${vacantTotal} vacant bed${vacantTotal === 1 ? '' : 's'} across ${rows.length} room${rows.length === 1 ? '' : 's'}.` : `${rows.length} rooms, ${vacantTotal} vacant bed${vacantTotal === 1 ? '' : 's'}.`;
      return { text, rows };
    }
  },
  get_open_requests: {
    description: 'Open maintenance requests / complaints, optionally by priority, room, or age. Use for "which complaint is taking too long", "open issues on floor 2".',
    args: { priority: 'string?', room: 'string?', older_than_days: 'number?' }, role: 'staff', level: 'inform',
    async run(a) {
      const p = []; let where = `status<>'resolved'`;
      if (['low', 'medium', 'high'].includes(a.priority)) { p.push(a.priority); where += ` AND priority=$${p.length}`; }
      if (a.room) { p.push(String(a.room)); where += ` AND room_number ILIKE $${p.length}`; }
      if (a.older_than_days) { p.push(Number(a.older_than_days)); where += ` AND created_at < NOW() - ($${p.length} || ' days')::interval`; }
      const r = await pool.query(`SELECT id, category, description, room_number, guest_name, status, priority, created_at, EXTRACT(EPOCH FROM (NOW()-created_at))/86400 AS age_days FROM complaints WHERE ${where} ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`, p);
      return { text: r.rows.length ? `${r.rows.length} open request${r.rows.length === 1 ? '' : 's'}; oldest is ${Math.floor(Math.max(...r.rows.map(x => x.age_days)))} day(s) old.` : 'No open requests ✅', rows: r.rows.map(x => ({ ...x, age_days: Math.round(x.age_days * 10) / 10 })) };
    }
  },
  get_month_performance: {
    description: 'Owner-level month performance: collected, spent, net, occupancy, dues, comparison with last month. ADMIN ONLY. Use for "how is this month vs last", "give me a report".',
    args: { month: 'string?' }, role: 'admin', level: 'inform',
    async run(a) {
      const cur = a.month && /^\d{4}-\d{2}$/.test(a.month) ? a.month : istToday().slice(0, 7);
      const rep = await owner.getOwnerReport(cur, { force: cur === istToday().slice(0, 7) });
      const prevMonth = rep.trend[rep.trend.length - 2];
      const delta = prevMonth ? rep.money.income - prevMonth.income : null;
      return {
        text: rep.summary + (delta != null ? `\nCollections ${delta >= 0 ? 'up' : 'down'} ${fmt(Math.abs(delta))} vs ${prevMonth.label}.` : ''),
        report: { month: rep.month, label: rep.label, money: rep.money, occupancy: rep.occupancy, dues: { residents: rep.dues.residents, total: rep.dues.total }, anomalies: rep.anomalies.slice(0, 5) },
        download: `/owner/report/pdf?month=${cur}`, filename: `owner-report-${cur}.pdf`, navigate: 'reports'
      };
    }
  },
  download_owner_report: {
    description: 'Link to the owner report PDF for a month. ADMIN ONLY.',
    args: { month: 'string?' }, role: 'admin', level: 'inform',
    async run(a) { const m = a.month || istToday().slice(0, 7); return { text: `Owner report for ${m}.`, download: `/owner/report/pdf?month=${m}`, filename: `owner-report-${m}.pdf` }; }
  },

  // ═══════════════════ PREPARE ═══════════════════
  prepare_payment: {
    description: 'Draft a rent/deposit payment record from a sentence like "record 8000 rent from Ananya by UPI". Returns a preview; the user confirms before anything is saved.',
    args: { name: 'string?', resident_id: 'number?', room: 'string?', amount: 'number?', mode: 'string?', type: 'string?', date: 'string?' }, role: 'staff', level: 'prepare',
    async run(a, ctx) {
      const { match, candidates } = await resolveResident({ id: a.resident_id || ctx.context?.resident_id, name: a.name, room: a.room });
      if (!match) return { clarify: candidates.length ? 'Which resident do you mean?' : 'I could not find that resident — check the name or room.', candidates };
      const amount = Number(a.amount);
      if (!amount || amount <= 0) return { clarify: `How much did ${match.name} pay?`, resident: match };
      const mode = ['Cash', 'UPI', 'Bank Transfer'].find(m => m.toLowerCase() === String(a.mode || '').toLowerCase()) || (SMParse.extractMode(String(a.mode || '')) || {}).mode || null;
      const type = ['rent', 'deposit', 'advance'].includes(a.type) ? a.type : 'rent';
      const date = isIsoDate(a.date) ? a.date : istToday();
      const month = new Date(date + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const preview = { guest_id: match.id, guest_name: match.name, amount, payment_mode: mode || 'Cash', collection_type: type, collection_date: date, collection_month: type === 'rent' ? month : '', description: '', source: 'copilot' };
      const note = match.amount_due > 0 && Math.abs(match.amount_due - amount) > 0.5 ? ` Her running balance is ${fmt(match.amount_due)}.` : '';
      return {
        text: `${fmt(amount)} ${type} from ${match.name}${match.room_number ? ' (Room ' + match.room_number + ')' : ''} by ${preview.payment_mode} on ${date}.${mode ? '' : ' Mode not stated — assuming Cash.'}${note}`,
        preview, execute: { tool: 'create_payment', label: 'Confirm payment', args: preview }
      };
    }
  },
  prepare_expense: {
    description: 'Draft an expense/purchase from a sentence like "500 rupees vegetables paid to Ramesh cash". Preview only.',
    args: { amount: 'number?', category: 'string?', paid_to: 'string?', mode: 'string?', description: 'string?', date: 'string?' }, role: 'staff', level: 'prepare',
    async run(a) {
      const amount = Number(a.amount);
      if (!amount || amount <= 0) return { clarify: 'How much was spent?' };
      const cats = ['Groceries', 'Maintenance', 'Electricity', 'Water', 'Internet', 'Cleaning', 'Salary', 'Building Rent', 'Furniture', 'Repairs', 'Other'];
      const category = cats.find(c => c.toLowerCase() === String(a.category || '').toLowerCase()) || cats.find(c => String(a.category || a.description || '').toLowerCase().includes(c.toLowerCase())) || 'Other';
      const mode = ['Cash', 'UPI', 'Bank Transfer', 'Card'].find(m => m.toLowerCase() === String(a.mode || '').toLowerCase()) || (SMParse.extractMode(String(a.mode || '')) || {}).mode || 'Cash';
      const preview = { amount, category, description: a.description || category, paid_to: a.paid_to || '', payment_mode: mode, purchase_date: isIsoDate(a.date) ? a.date : istToday(), source: 'copilot' };
      return { text: `${fmt(amount)} · ${category}${preview.paid_to ? ' · paid to ' + preview.paid_to : ''} · ${mode} on ${preview.purchase_date}.`, preview, execute: { tool: 'create_expense', label: 'Confirm expense', args: preview } };
    }
  },
  prepare_complaint: {
    description: 'Draft a maintenance request from a sentence like "geyser not working in room 5". Preview only.',
    args: { description: 'string', category: 'string?', room: 'string?', priority: 'string?' }, role: 'staff', level: 'prepare',
    async run(a) {
      const p = SMParse.parseComplaint(a.description || '');
      const category = a.category && Object.keys(SMParse.COMPLAINT_CATEGORIES).includes(a.category) ? a.category : p.category;
      const room = a.room || p.room;
      const priority = ['low', 'medium', 'high'].includes(a.priority) ? a.priority : assistant.rulePriority(category, a.description || '');
      const preview = { category, description: a.description, guest_name: room ? 'Room ' + room : null, priority, source: 'copilot' };
      return { text: `${category} · ${priority} priority${room ? ' · Room ' + room : ''}: "${a.description}"`, preview, execute: { tool: 'create_complaint', label: 'Log request', args: preview } };
    }
  },
  prepare_reminders: {
    description: 'Draft WhatsApp rent reminders for residents who owe, most overdue first. Use for "send reminders", "remind the late payers".',
    args: { min_months: 'number?', lang: 'string?', limit: 'number?' }, role: 'staff', level: 'prepare',
    async run(a) {
      let list = await assistant.draftReminders(a.lang === 'kn' ? 'kn' : 'en');
      if (a.min_months) list = list.filter(r => r.months_behind >= a.min_months);
      list.sort((x, y) => y.months_behind - x.months_behind);
      if (a.limit) list = list.slice(0, a.limit);
      return { text: list.length ? `${list.length} reminder${list.length === 1 ? '' : 's'} drafted — review and send from the Reminders screen.` : 'Nobody to remind ✅', reminders: list.map(r => ({ guest_id: r.guest_id, name: r.name, room: r.room_number, amount_due: r.amount_due, months_behind: r.months_behind, text: r.text })), navigate: 'reminders' };
    }
  },
  prepare_announcement: {
    description: 'Draft a notice to residents from a sentence ("water off tomorrow 10 to 12"). Preview only. ADMIN ONLY.',
    args: { message: 'string', title: 'string?', priority: 'string?' }, role: 'admin', level: 'prepare',
    async run(a) {
      const priority = ['normal', 'important', 'urgent'].includes(a.priority) ? a.priority : /urgent|immediately|emergency/i.test(a.message) ? 'urgent' : /tomorrow|today|off|closed|change/i.test(a.message) ? 'important' : 'normal';
      const title = a.title || String(a.message).split(/[.!\n]/)[0].slice(0, 60);
      const preview = { title, message: a.message, priority };
      return { text: `${priority.toUpperCase()} · ${title}`, preview, execute: { tool: 'post_announcement', label: 'Post notice', args: preview } };
    }
  },
  prepare_room_shift: {
    description: 'Draft moving a resident to another room. Preview only.',
    args: { name: 'string?', resident_id: 'number?', to_room: 'string', bed: 'string?', date: 'string?' }, role: 'staff', level: 'prepare',
    async run(a, ctx) {
      const { match, candidates } = await resolveResident({ id: a.resident_id || ctx.context?.resident_id, name: a.name });
      if (!match) return { clarify: candidates.length ? 'Which resident?' : 'I could not find that resident.', candidates };
      const room = await pool.query(`SELECT r.id, r.room_number, r.total_beds, (SELECT COUNT(*) FROM guests g WHERE g.room_id=r.id AND g.is_active=true)::int AS occupied FROM rooms r WHERE r.is_active=true AND r.room_number ILIKE $1`, [String(a.to_room || '')]);
      if (!room.rows[0]) return { clarify: `I don't know a room "${a.to_room}".` };
      const t = room.rows[0];
      if (t.occupied >= t.total_beds) return { clarify: `Room ${t.room_number} is full.` };
      const preview = { guest_id: match.id, room_id: t.id, bed_number: a.bed || null, effective_from: isIsoDate(a.date) ? a.date : istToday(), note: 'via Copilot' };
      return { text: `Move ${match.name} from Room ${match.room_number || '—'} to Room ${t.room_number}${a.bed ? ' Bed ' + a.bed : ''} from ${preview.effective_from}.`, preview, execute: { tool: 'shift_room', label: 'Confirm move', args: preview } };
    }
  },

  // ═══════════════════ EXECUTE (confirm required) ═══════════════════
  create_payment: {
    description: 'Save a payment (after confirmation).', args: {}, role: 'staff', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'POST', '/collections', a); return { text: `Payment ${fmt(r.amount)} recorded${r.status !== 'confirmed' ? ' (pending admin approval)' : ''}.`, record: r, navigate: 'payments' }; }
  },
  create_expense: {
    description: 'Save an expense (after confirmation).', args: {}, role: 'staff', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'POST', '/purchases', a); return { text: `Expense ${fmt(r.amount)} recorded${r.status !== 'confirmed' ? ' (pending admin approval)' : ''}.`, record: r, navigate: 'purchases' }; }
  },
  create_complaint: {
    description: 'Log a maintenance request (after confirmation).', args: {}, role: 'staff', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'POST', '/complaints', a); return { text: `Request #${r.id} logged (${r.category}, ${r.priority}).`, record: r, navigate: 'complaints' }; }
  },
  update_request_status: {
    description: 'Change a request’s status (after confirmation).', args: { id: 'number', status: 'string', note: 'string?' }, role: 'staff', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'PUT', `/complaints/${a.id}`, { status: a.status, resolution_notes: a.note }); return { text: `Request #${a.id} → ${a.status}.`, record: r, navigate: 'complaints' }; }
  },
  shift_room: {
    description: 'Move a resident (after confirmation).', args: {}, role: 'staff', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'POST', `/guests/${a.guest_id}/shift-room`, a); return { text: `Moved to Room ${r.history.to_room_number}.`, record: r, navigate: 'guests' }; }
  },
  post_announcement: {
    description: 'Post a notice to residents (after confirmation). ADMIN ONLY.', args: {}, role: 'admin', level: 'execute',
    async run(a, ctx) { const r = await callRoute(ctx, 'POST', '/announcements', a); return { text: `Notice posted: ${r.title}`, record: r, navigate: 'guest-messages' }; }
  }
};

// Role gate: 'admin' tools need admin; 'staff' tools need any logged-in user.
function allowed(tool, user) {
  if (!tool || !user) return false;
  return tool.role === 'staff' || user.role === 'admin';
}

// Light argument validation: coerce numbers, drop unknown keys, check required.
function validateArgs(tool, args) {
  const out = {}; const errors = [];
  for (const [k, spec] of Object.entries(tool.args || {})) {
    const optional = spec.endsWith('?'); const type = spec.replace('?', '');
    let v = args ? args[k] : undefined;
    if (v === undefined || v === null || v === '') { if (!optional) errors.push(`${k} is required`); continue; }
    if (type === 'number') { v = Number(String(v).replace(/[^\d.-]/g, '')); if (!Number.isFinite(v)) { errors.push(`${k} must be a number`); continue; } }
    else if (type === 'boolean') v = v === true || v === 'true' || v === 'yes';
    else v = String(v).trim().slice(0, 500);
    out[k] = v;
  }
  // execute tools receive the exact preview object; pass it through untouched
  if (tool.level === 'execute' && Object.keys(tool.args || {}).length === 0) return { args: args || {}, errors: [] };
  return { args: out, errors };
}

function catalogue(user) {
  return Object.entries(TOOLS).filter(([, t]) => allowed(t, user)).map(([name, t]) => ({ name, description: t.description, args: t.args, level: t.level }));
}

module.exports = { TOOLS, allowed, validateArgs, catalogue, resolveResident, callRoute };
