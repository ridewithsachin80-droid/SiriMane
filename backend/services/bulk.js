// backend/services/bulk.js — Sprint 13
//
// Bulk actions with a preview. One rule shapes everything here:
//   the preview is the truth, and nothing happens until it is confirmed.
//
// Flow (shared by the sticky bar and the Copilot):
//   preview({ action, ids, args, user })  → what would happen, who is skipped
//                                           and why, and a proposal id
//   confirm (routes/bulk.js → copilot.confirm) → runs tools.bulk_execute once
//
// Limits (Sachin, Sprint 13): at most BULK_CAP in one go; above ACK_ABOVE the
// warden must confirm the count a second time. Both are enforced here on the
// server — the UI only repeats them.
//
// Money: a bulk reminder creates OUTBOX DRAFTS ONLY. It never touches
// collections, the ledger or rent-due, and the finance gate asserts that.
// Sending stays one tap per message through wa.me, exactly as before.
const pool = require('../db');
const routes = require('../routes/index');
const notify = require('./notify');

const BULK_CAP = 15;
const ACK_ABOVE = 8;

const fmt = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => ist().toISOString().slice(0, 10);

// Who may run which action. Reversible drafting is open to staff; posting a
// notice to a group and verifying documents are the owner's calls.
const ACTIONS = {
  reminders:    { role: 'staff', label: 'Draft reminders',       noun: 'resident', creates: 'draft' },
  announcement: { role: 'admin', label: 'Post notice to selected', noun: 'resident', creates: 'notice' },
  assign:       { role: 'staff', label: 'Assign to staff',       noun: 'request',  creates: 'assignment' },
  documents:    { role: 'admin', label: 'Mark documents',        noun: 'resident', creates: 'document status' },
  skip_drafts:  { role: 'staff', label: 'Skip drafts',           noun: 'draft',    creates: 'skip' }
};

function allowed(action, user) {
  const a = ACTIONS[action];
  return !!a && !!user && (a.role === 'staff' || user.role === 'admin');
}

function cleanIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0))];
}

// ── Reminder eligibility ─────────────────────────────────────────────────
// Every skip has a reason the warden can read; nothing is dropped silently.
async function reminderCandidates(ids) {
  const day = istToday();
  const [due, guests, recent, drafts] = await Promise.all([
    routes.computeRentDueList(),
    pool.query(`SELECT g.id, g.name, g.phone, g.join_date, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.id = ANY($1)`, [ids]),
    // "Reminded" = the warden tapped Send (outbox) or logged a Sprint 4 send.
    pool.query(`SELECT guest_id, MAX(at) AS last FROM (
                  SELECT guest_id, sent_at AS at FROM outbox WHERE status='sent' AND kind IN ('rent_due','rent_overdue') AND sent_at > NOW() - INTERVAL '7 days'
                  UNION ALL SELECT guest_id, sent_at FROM reminder_log WHERE sent_at > NOW() - INTERVAL '7 days') x
                WHERE guest_id = ANY($1) GROUP BY guest_id`, [ids]),
    pool.query(`SELECT guest_id, kind FROM outbox WHERE status='draft' AND kind IN ('rent_due','rent_overdue') AND guest_id = ANY($1)`, [ids])
  ]);
  const dueBy = new Map(due.map(d => [d.id, d]));
  const recentBy = new Map(recent.rows.map(r => [r.guest_id, r.last]));
  const draftBy = new Map(drafts.rows.map(r => [r.guest_id, r.kind]));
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  const eligible = [], skipped = [];
  for (const id of ids) {
    const g = guests.rows.find(x => x.id === id);
    if (!g) { skipped.push({ id, name: `#${id}`, reason: 'not an active resident' }); continue; }
    const d = dueBy.get(id) || {};
    const amountDue = Number(d.amount_due) || 0;
    const monthlyRent = Number(d.monthly_rent) || 0;
    const row = { id, name: g.name, room_number: g.room_number, amount_due: amountDue, monthly_rent: monthlyRent };
    if (!g.phone) { skipped.push({ ...row, reason: 'no phone number' }); continue; }
    if (amountDue <= 0) { skipped.push({ ...row, reason: 'nothing outstanding' }); continue; }
    // The standing rule: the ledger charges the joining month on day one, so
    // nobody who joined under 30 days ago is chased as overdue.
    if (g.join_date && new Date(g.join_date).getTime() > thirtyDaysAgo) { skipped.push({ ...row, reason: 'joined less than 30 days ago' }); continue; }
    if (recentBy.has(id)) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(recentBy.get(id)).getTime()) / 86400000));
      skipped.push({ ...row, reason: `reminded ${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}` }); continue;
    }
    if (draftBy.has(id)) { skipped.push({ ...row, reason: 'already has a draft waiting in the Outbox' }); continue; }
    const months = monthlyRent > 0 ? amountDue / monthlyRent : 0;
    eligible.push({ ...row, phone: g.phone, join_date: g.join_date, months: Math.round(months * 10) / 10, kind: months >= 1 ? 'rent_overdue' : 'rent_due', day });
  }
  return { eligible, skipped };
}

async function announcementCandidates(ids) {
  const guests = await pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.id = ANY($1)`, [ids]);
  const eligible = [], skipped = [];
  for (const id of ids) {
    const g = guests.rows.find(x => x.id === id);
    if (!g) skipped.push({ id, name: `#${id}`, reason: 'not an active resident' });
    else eligible.push({ id, name: g.name, room_number: g.room_number });
  }
  return { eligible, skipped };
}

async function assignCandidates(ids, args) {
  const to = Number(args.assigned_to);
  const [reqs, staff] = await Promise.all([
    pool.query(`SELECT c.id, c.category, c.room_number, c.status, c.assigned_to, c.description FROM complaints c WHERE c.id = ANY($1)`, [ids]),
    Number.isInteger(to) ? pool.query(`SELECT id, username FROM users WHERE id=$1`, [to]) : Promise.resolve({ rows: [] })
  ]);
  if (!staff.rows[0]) { const e = new Error('Choose a staff member to assign to'); e.status = 400; throw e; }
  const eligible = [], skipped = [];
  for (const id of ids) {
    const c = reqs.rows.find(x => x.id === id);
    const row = c ? { id, name: `#${c.id} ${c.category}${c.room_number ? ' · Room ' + c.room_number : ''}`, category: c.category, room_number: c.room_number, description: c.description } : { id, name: `#${id}` };
    if (!c) skipped.push({ ...row, reason: 'no such request' });
    else if (['resolved', 'closed'].includes(c.status)) skipped.push({ ...row, reason: `already ${c.status}` });
    else if (String(c.assigned_to) === String(to)) skipped.push({ ...row, reason: `already with ${staff.rows[0].username}` });
    else eligible.push(row);
  }
  return { eligible, skipped, assignee: staff.rows[0] };
}

const DOC_TYPES = ['ID proof', 'Address proof', 'Agreement', 'Deposit receipt'];
const DOC_STATUS = ['verified', 'pending'];
async function documentCandidates(ids, args) {
  if (!DOC_TYPES.includes(args.doc_type)) { const e = new Error(`doc_type must be one of ${DOC_TYPES.join(', ')}`); e.status = 400; throw e; }
  if (!DOC_STATUS.includes(args.status)) { const e = new Error('status must be verified or pending'); e.status = 400; throw e; }
  const [guests, docs] = await Promise.all([
    pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.id = ANY($1)`, [ids]),
    pool.query(`SELECT guest_id, status FROM resident_documents WHERE doc_type=$1 AND guest_id = ANY($2)`, [args.doc_type, ids])
  ]);
  const cur = new Map(docs.rows.map(d => [d.guest_id, d.status]));
  const eligible = [], skipped = [];
  for (const id of ids) {
    const g = guests.rows.find(x => x.id === id);
    if (!g) { skipped.push({ id, name: `#${id}`, reason: 'not an active resident' }); continue; }
    const row = { id, name: g.name, room_number: g.room_number };
    if ((cur.get(id) || 'pending') === args.status) skipped.push({ ...row, reason: `${args.doc_type} already ${args.status}` });
    else eligible.push(row);
  }
  return { eligible, skipped };
}

async function skipDraftCandidates(ids) {
  const rows = await pool.query(`SELECT id, guest_name, kind, status FROM outbox WHERE id = ANY($1)`, [ids]);
  const eligible = [], skipped = [];
  for (const id of ids) {
    const o = rows.rows.find(x => x.id === id);
    if (!o) skipped.push({ id, name: `#${id}`, reason: 'no such message' });
    else if (o.status !== 'draft') skipped.push({ id, name: o.guest_name, reason: `already ${o.status}` });
    else eligible.push({ id, name: o.guest_name, kind: o.kind });
  }
  return { eligible, skipped };
}

// ── Preview ──────────────────────────────────────────────────────────────
async function preview({ action, ids, args = {}, user }) {
  const def = ACTIONS[action];
  if (!def) { const e = new Error(`Unknown bulk action "${action}"`); e.status = 400; throw e; }
  if (!allowed(action, user)) { const e = new Error('That needs an admin login.'); e.status = 403; throw e; }
  const list = cleanIds(ids);
  if (!list.length) { const e = new Error('Select at least one first'); e.status = 400; throw e; }
  if (list.length > BULK_CAP) { const e = new Error(`At most ${BULK_CAP} in one go — you selected ${list.length}. Do it in batches.`); e.status = 400; throw e; }

  let c, extra = {};
  if (action === 'reminders') c = await reminderCandidates(list);
  else if (action === 'announcement') {
    if (!String(args.message || '').trim()) { const e = new Error('Write the notice first'); e.status = 400; throw e; }
    c = await announcementCandidates(list);
    extra = { title: String(args.title || String(args.message).split(/[.!\n]/)[0]).trim().slice(0, 60), message: String(args.message).trim().slice(0, 1000), priority: ['normal', 'important', 'urgent'].includes(args.priority) ? args.priority : 'normal' };
  }
  else if (action === 'assign') { c = await assignCandidates(list, args); extra = { assigned_to: Number(args.assigned_to), assignee: c.assignee.username }; }
  else if (action === 'documents') { c = await documentCandidates(list, args); extra = { doc_type: args.doc_type, status: args.status }; }
  else if (action === 'skip_drafts') c = await skipDraftCandidates(list);

  const { eligible, skipped } = c;
  const total = eligible.reduce((t, r) => t + (Number(r.amount_due) || 0), 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const lines = [`Selected: ${plural(list.length, def.noun)}`];
  if (action === 'reminders') lines.push(`${fmt(total)} outstanding across ${plural(eligible.length, 'reminder')} to draft`);
  else if (action === 'announcement') lines.push(`${extra.priority.toUpperCase()} · "${extra.title}" — one notice per resident, visible only to her`);
  else if (action === 'assign') lines.push(`${plural(eligible.length, 'request')} → ${extra.assignee}`);
  else if (action === 'documents') lines.push(`${extra.doc_type} → ${extra.status} for ${plural(eligible.length, 'resident')}`);
  else if (action === 'skip_drafts') lines.push(`${plural(eligible.length, 'draft')} will be marked skipped`);
  // Group the skips by reason so "3 have no phone number" reads as one line.
  const byReason = {};
  for (const s of skipped) (byReason[s.reason] = byReason[s.reason] || []).push(s);
  for (const [reason, rows] of Object.entries(byReason)) lines.push(`${rows.length} ${reason} — ${rows.length === 1 ? 'she' : 'they'} will be skipped`);
  if (action === 'reminders') lines.push('Drafts only. Nothing is sent until you tap Send on each message in the Outbox.');

  const requiresAck = eligible.length > ACK_ABOVE;
  const out = {
    action, label: def.label, selected: list.length, cap: BULK_CAP, ack_above: ACK_ABOVE,
    eligible, skipped, total_outstanding: Math.round(total), lines,
    requires_second_confirm: requiresAck, confirm_count: eligible.length,
    creates: def.creates, drafts_only: action === 'reminders', ...extra
  };
  return out;
}

// ── Execute (called ONLY from tools.bulk_execute, i.e. via a confirmed proposal) ──
async function execute({ action, ids, args = {}, acknowledged }, ctx) {
  const def = ACTIONS[action];
  if (!def) throw new Error(`Unknown bulk action "${action}"`);
  if (!allowed(action, ctx.user)) throw new Error('That needs an admin login.');
  const list = cleanIds(ids);
  if (list.length > BULK_CAP) throw new Error(`At most ${BULK_CAP} in one go.`);
  if (list.length > ACK_ABOVE && !acknowledged) throw new Error(`Confirm the count first — this touches ${list.length} ${def.noun}s.`);
  const tools = require('./tools');
  const done = [], failed = [];

  if (action === 'reminders') {
    // Re-check eligibility at execute time: someone may have paid, or been
    // reminded, in the minutes between preview and confirm.
    const { eligible } = await reminderCandidates(list);
    const st = Object.fromEntries((await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('pg_name','upi_vpa')`)).rows.map(x => [x.key, x.value]));
    const pg = st.pg_name || 'Siri Mane PG';
    for (const g of eligible) {
      const body = notify.TEMPLATES[g.kind]({ ...g, upi: st.upi_vpa }, pg);
      // Day-scoped key: the same bulk run twice today is a no-op, and a
      // double-tap on Confirm can never produce two drafts.
      const r = await pool.query(`INSERT INTO outbox(kind, guest_id, guest_name, phone, body, dedupe_key)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [g.kind, g.id, g.name, g.phone, body, `bulk:${g.kind}:${g.id}:${g.day}`]);
      if (r.rows[0]) done.push({ id: g.id, name: g.name, outbox_id: r.rows[0].id }); else failed.push({ id: g.id, name: g.name, reason: 'already drafted today' });
    }
    const skippedNow = list.length - eligible.length;
    return { text: `${done.length} reminder${done.length === 1 ? '' : 's'} drafted into the Outbox${skippedNow ? ` (${skippedNow} skipped)` : ''}. Send each one with a tap — nothing has been sent.`, record: { drafted: done, failed }, navigate: 'outbox' };
  }

  if (action === 'announcement') {
    for (const id of list) {
      try {
        const a = await tools.callRoute(ctx, 'POST', '/announcements', { title: args.title, message: args.message, priority: args.priority, target_type: 'resident', target_value: String(id) });
        done.push({ id, announcement_id: a.id });
      } catch (e) { failed.push({ id, reason: e.message }); }
    }
    return { text: `Notice posted to ${done.length} resident${done.length === 1 ? '' : 's'}${failed.length ? ` (${failed.length} failed)` : ''}.`, record: { posted: done, failed }, navigate: 'guest-messages' };
  }

  if (action === 'assign') {
    for (const id of list) {
      try { const c = await tools.callRoute(ctx, 'PUT', `/requests/${id}`, { assigned_to: Number(args.assigned_to) }); done.push({ id, status: c.status }); }
      catch (e) { failed.push({ id, reason: e.message }); }
    }
    return { text: `${done.length} request${done.length === 1 ? '' : 's'} assigned to ${args.assignee || 'staff'}${failed.length ? ` (${failed.length} failed)` : ''}.`, record: { assigned: done, failed }, navigate: 'complaints' };
  }

  if (action === 'documents') {
    for (const id of list) {
      try { await tools.callRoute(ctx, 'PUT', `/guests/${id}/documents`, { doc_type: args.doc_type, status: args.status }); done.push({ id }); }
      catch (e) { failed.push({ id, reason: e.message }); }
    }
    return { text: `${args.doc_type} marked ${args.status} for ${done.length} resident${done.length === 1 ? '' : 's'}${failed.length ? ` (${failed.length} failed)` : ''}.`, record: { updated: done, failed }, navigate: 'guests' };
  }

  if (action === 'skip_drafts') {
    for (const id of list) {
      try { await tools.callRoute(ctx, 'POST', `/outbox/${id}/skip`); done.push({ id }); }
      catch (e) { failed.push({ id, reason: e.message }); }
    }
    return { text: `${done.length} draft${done.length === 1 ? '' : 's'} skipped${failed.length ? ` (${failed.length} were no longer drafts)` : ''}.`, record: { skipped: done, failed }, navigate: 'outbox' };
  }
  throw new Error('Nothing to do');
}

module.exports = { ACTIONS, BULK_CAP, ACK_ABOVE, allowed, preview, execute, cleanIds, DOC_TYPES };
