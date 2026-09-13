// backend/services/copilot.js — Sprint 6
//
// The orchestrator. A question or instruction comes in with the user's role
// and the screen they are on; it leaves as an answer + evidence + action
// buttons. Rules enforced here:
//   • The model only ever chooses a tool name and arguments (JSON). Every
//     tool is role-checked and argument-validated before it runs.
//   • inform → runs now. prepare → returns a preview and a proposal id.
//     execute → only via confirm(), once, by the same user, within 10 min.
//   • Every ask and every confirm writes an ai_actions row.
//   • No model key → the on-device parser and Sprint 4 templates handle the
//     common cases. The Copilot never becomes a single point of failure.
const crypto = require('crypto');
const pool = require('../db');
const ai = require('../routes/ai');
const assistant = require('./assistant');
const tools = require('./tools');
const SMParse = require('../../frontend/public/js/speech-parser.js');

const PROPOSAL_TTL_MIN = 10;
const fmt = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istToday = () => istNow().toISOString().slice(0, 10);

function modelAvailable() { return !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || ai.providers._stub); }

// ── 1. Intent: which tool, with what arguments ────────────────────────────
// Local first (no network, no cost): a handful of unambiguous patterns and
// the Sprint 4 templates. Then the model, given only the tool catalogue the
// user is allowed to use plus a one-line screen context.
function localIntent(text, user, context) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  if (!t) return null;
  // Record a payment: "record 8000 rent from Ananya by UPI", "Priya room 12 6000 upi"
  if (/\b(record|collect|received|paid|got)\b.*\b(rent|deposit|advance|rupees|rs\.?|₹)|\b\d{3,6}\b.*\b(upi|cash|gpay|phonepe|bank)\b/i.test(t) && !/expense|purchase|bought|spent/i.test(t)) {
    return { tool: 'prepare_payment', args: { raw: t }, via: 'local' };
  }
  if (/\b(expense|purchase|bought|spent|bill)\b/i.test(t) && /\d/.test(t)) return { tool: 'prepare_expense', args: { raw: t }, via: 'local' };
  if (/^(log|report|raise|note)\b.*\b(issue|complaint|problem|leak|not working|broken)|\b(not working|leaking|broken|no water|no power)\b/i.test(t)) return { tool: 'prepare_complaint', args: { description: t }, via: 'local' };
  if (/\b(send|draft|prepare)\b.*\bremind/i.test(t) || /^remind/i.test(lower)) {
    const m = t.match(/(\d+)\s*\+?\s*months?/i);
    return { tool: 'prepare_reminders', args: m ? { min_months: Number(m[1]) } : {}, via: 'local' };
  }
  {
    const m = t.match(/\b(?:mark|set|close|resolve|reopen|update)?\s*(?:request|complaint|issue|ticket)\s*#?\s*(\d+)\b.*?\b(resolved|done|fixed|closed|in progress|started|working|open|reopen(?:ed)?)\b/i)
      || t.match(/\b(?:resolve|close|fix)\s+(?:request|complaint|issue|ticket)\s*#?\s*(\d+)\b/i);
    if (m) return { tool: 'prepare_request_status', args: { id: Number(m[1]), status: m[2] || 'resolved', note: (t.match(/[—–-]\s*(.+)$/) || [])[1] }, via: 'local' };
  }
  // Move-in: "Ananya Sharma joining room 204 tomorrow, rent 8000, deposit 16000"
  if (/\b(joining|move.?in|new resident|new guest|admit)\b/i.test(t) && !/\b(shift|transfer)\b/i.test(t))
    return { tool: 'prepare_resident', args: { text: t }, via: 'local' };
  // Checkout: "Ananya is checking out tomorrow"
  if (/\b(check(?:ing)?.?out|checkout|vacating|leaving|moving out)\b/i.test(t)) {
    const name = (t.match(/^([a-z .]+?)\s+(?:is|will be)?\s*(?:check|vacat|leav|mov)/i) || [])[1];
    const date = /\btomorrow\b/i.test(t) ? new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10) : (t.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1];
    return { tool: 'prepare_checkout', args: { name: name ? name.trim() : undefined, date }, via: 'local' };
  }
  if (/\bread(y|iness)\b.*\broom\b|\broom\s*[a-z]?\d{1,3}[a-z]?\b.*\bready\b/i.test(t)) {
    const rm = (t.match(/room\s*([a-z]?\d{1,3}[a-z]?)/i) || [])[1];
    if (rm) return { tool: 'room_readiness', args: { room: rm }, via: 'local' };
  }
  if (/\b(move|shift)\b.*\b(room|to)\b/i.test(t)) {
    const room = (t.match(/\b(?:to|into)\s+(?:room\s*)?([a-z]?\d{1,3}[a-z]?)\b/i) || [])[1];
    const name = (t.match(/^(?:move|shift)\s+([a-z ]+?)\s+(?:to|into|from)\b/i) || [])[1];
    if (room) return { tool: 'prepare_room_shift', args: { name, to_room: room }, via: 'local' };
  }
  // Pronouns follow what is open: "she/her/this resident" → the resident,
  // "here/this room" → the room. A resident view carries her room too, so
  // the resident check must come first.
  if (context && /\b(her|she|this resident|summari[sz]e)\b/i.test(t) && context.resident_id) return { tool: 'get_resident', args: { resident_id: context.resident_id }, via: 'local' };
  if (context && /\b(here|this room)\b/i.test(t)) {
    if (context.room_number) return { tool: 'get_room_status', args: { room: context.room_number }, via: 'local' };
    if (context.resident_id) return { tool: 'get_resident', args: { resident_id: context.resident_id }, via: 'local' };
  }
  if (/\b(vacan\w*|available|free|empty)\b.*\b(room|bed)|\b(room|bed)s?\b.*\b(vacan\w*|available|free|empty)\b/i.test(t)) return { tool: 'get_room_status', args: { only_vacant: true }, via: 'local' };
  if (/\bwho\b.*\b(in|is in)\s+room\s*([a-z]?\d{1,3}[a-z]?)/i.test(t)) return { tool: 'get_room_status', args: { room: (t.match(/room\s*([a-z]?\d{1,3}[a-z]?)/i) || [])[1] }, via: 'local' };
  if (/\b(not paid|unpaid|owe|owes|overdue|late|baaki|ಬಾಕಿ|rent due)\b/i.test(t)) {
    const args = {};
    const amt = t.match(/more than\s*(?:rs\.?|₹)?\s*([\d,]+)/i); if (amt) args.min_amount = Number(amt[1].replace(/,/g, ''));
    const mon = t.match(/(\d+)\s*\+?\s*months?/i); if (mon) args.min_months = Number(mon[1]);
    if (/repeat|again|always|usually/i.test(t)) args.min_months = Math.max(args.min_months || 0, 2);
    return { tool: 'get_outstanding_rent', args, via: 'local' };
  }
  if (/\b(complain|issue|request|maintenance|taking too long|overdue request)/i.test(t)) {
    const args = {}; const d = t.match(/(\d+)\s*days?/i); if (d) args.older_than_days = Number(d[1]);
    if (/high/i.test(t)) args.priority = 'high';
    return { tool: 'get_open_requests', args, via: 'local' };
  }
  if (/\b(find|search|show|who is|number|phone)\b/i.test(t) && /[A-Z][a-z]+/.test(t)) return { tool: 'search_residents', args: { query: t.replace(/\b(find|search|show me|show|who is|number|phone|of|the)\b/gi, ' ').trim() }, via: 'local' };
  if (/\b(report|performance|this month|last month|compare)\b/i.test(t) && user.role === 'admin') return { tool: 'get_month_performance', args: {}, via: 'local' };
  if (/\b(attention|brief|today|morning|what.?s (up|happening)|priorit)/i.test(t)) return { tool: 'get_today', args: {}, via: 'local' };
  return null;
}

async function modelIntent(text, user, context) {
  if (!modelAvailable()) return null;
  const cat = tools.catalogue(user).map(t => `- ${t.name}: ${t.description} args=${JSON.stringify(t.args)}`).join('\n');
  const ctxLine = context ? `Screen: ${context.page || 'unknown'}${context.resident_name ? `; viewing resident ${context.resident_name} (id ${context.resident_id})` : ''}${context.room_number ? `; viewing room ${context.room_number}` : ''}.` : '';
  const system = `You route a PG (paying-guest hostel) warden's request to exactly one tool. Reply ONLY with JSON: {"tool": <name or null>, "args": {...}, "clarify": <question or null>}. Use the screen context for words like "here", "her", "this room". If the request is ambiguous, set tool null and ask a short clarifying question. Never invent residents, rooms or amounts. Tools:\n${cat}`;
  const user_ = `${ctxLine}\nRequest: ${text}`;
  try {
    const reply = process.env.GROQ_API_KEY || ai.providers._stub
      ? await ai.providers.groqText({ system, user: user_, json: true })
      : await ai.providers.geminiText({ prompt: system + '\n\n' + user_ });
    const parsed = ai._internal.parseJsonLoose(reply);
    if (!parsed) return null;
    return { tool: parsed.tool || null, args: parsed.args || {}, clarify: parsed.clarify || null, via: 'model' };
  } catch (e) { return { error: e.message, via: 'model' }; }
}

// prepare_* tools built from a raw sentence use the on-device parser to fill args.
async function enrichRawArgs(toolName, args, context) {
  if (!args.raw) return args;
  const raw = args.raw; delete args.raw;
  if (toolName === 'prepare_payment') {
    const roster = (await pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`)).rows;
    const p = SMParse.parseCollection(raw, roster);
    return { ...args, resident_id: p.guest ? p.guest.id : context?.resident_id, name: p.guest ? undefined : raw.replace(/[^a-z ]/gi, ' ').replace(/\b(record|collect|received|paid|got|rent|deposit|advance|rupees|from|by|via|upi|cash|gpay|phonepe|bank|transfer)\b/gi, ' ').trim() || undefined, amount: p.amount, mode: p.mode, type: p.type, room: p.room };
  }
  if (toolName === 'prepare_expense') {
    const amt = SMParse.extractAmount(raw);
    const mode = SMParse.extractMode(raw);
    const paid = (raw.match(/\b(?:to|paid to)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/) || [])[1];
    return { ...args, amount: amt ? amt.amount : undefined, mode: mode ? mode.mode : undefined, paid_to: paid, description: raw.replace(/\b(expense|purchase|bought|spent|bill|rupees|rs)\b/gi, ' ').replace(/\s+/g, ' ').trim() };
  }
  return args;
}

// ── 2. Ask ────────────────────────────────────────────────────────────────
async function ask({ user, text, context, authorization, port }) {
  const t0 = Date.now();
  const q = String(text || '').trim().slice(0, 500);
  const audit = { user_id: user.id, request_text: q, context: context || null, interpretation: null, tools_read: [], proposal_id: null, result_text: null, error: null };
  const finish = async (out) => {
    audit.result_text = (out.answer || '').slice(0, 500);
    audit.interpretation = audit.interpretation || { tool: out.tool || null, via: out.via || null };
    await pool.query(`INSERT INTO ai_actions(user_id, request_text, context, interpretation, tools_read, proposal_id, result_text, error, ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [audit.user_id, audit.request_text, audit.context, audit.interpretation, audit.tools_read, audit.proposal_id, audit.result_text, audit.error, Date.now() - t0]).catch(() => {});
    return out;
  };
  if (!q) return finish({ answer: 'Try: "who has not paid?", "record 6000 rent from Priya by UPI", "what\'s wrong here?"', actions: [], confidence: 'high' });

  let intent = localIntent(q, user, context);
  if (!intent) intent = await modelIntent(q, user, context);
  if (intent && intent.error) audit.error = intent.error;
  if (!intent || (!intent.tool && !intent.clarify)) {
    // Last resort: Sprint 4 templates (pure keyword, read-only)
    const a = await assistant.ask(q);
    if (a.template) { audit.interpretation = { tool: 'template:' + a.template, via: 'template' }; return finish({ answer: a.answer, actions: [], evidence: [], confidence: 'medium', via: 'template' }); }
    return finish({ answer: modelAvailable() ? `I'm not sure what to do with that. Try "who has not paid?", "record 6000 rent from Priya by UPI", or "what needs attention?"` : `I can answer these without AI keys: who has not paid · vacant rooms · open requests · record a payment/expense · draft reminders · today's brief.`, actions: [], clarify: intent?.clarify || null, confidence: 'low', via: intent?.via || 'none' });
  }
  if (!intent.tool && intent.clarify) { audit.interpretation = { tool: null, via: intent.via, clarify: intent.clarify }; return finish({ answer: intent.clarify, clarify: intent.clarify, actions: [], confidence: 'low', via: intent.via }); }

  const tool = tools.TOOLS[intent.tool];
  audit.interpretation = { tool: intent.tool, args: intent.args, via: intent.via };
  if (!tool) return finish({ answer: `I don't have a "${intent.tool}" action.`, actions: [], confidence: 'low', tool: intent.tool, via: intent.via });
  if (!tools.allowed(tool, user)) { audit.error = 'forbidden'; return finish({ answer: `That needs an admin login.`, actions: [], forbidden: true, confidence: 'high', tool: intent.tool, via: intent.via }); }
  if (tool.level === 'execute') { audit.error = 'execute-without-confirm'; return finish({ answer: `That changes records, so it needs a preview first. Tell me the details and I'll prepare it for you to confirm.`, actions: [], confidence: 'high', tool: intent.tool, via: intent.via }); }

  let args = await enrichRawArgs(intent.tool, { ...intent.args }, context);
  const v = tools.validateArgs(tool, args);
  if (v.errors.length) return finish({ answer: `I need a bit more: ${v.errors.join(', ')}.`, clarify: v.errors.join(', '), actions: [], confidence: 'low', tool: intent.tool, via: intent.via });
  const ctx = { user, context, authorization, port };
  let result;
  try { result = await tool.run(v.args, ctx); } catch (e) { audit.error = e.message; return finish({ answer: `Could not do that: ${e.message}`, actions: [], confidence: 'low', tool: intent.tool, via: intent.via }); }
  audit.tools_read = [intent.tool];

  if (result.clarify) {
    return finish({ answer: result.clarify, clarify: result.clarify, candidates: result.candidates || [], actions: (result.candidates || []).map(c => ({ label: `${c.name}${c.room_number ? ' (Room ' + c.room_number + ')' : ''}`, tool: intent.tool, args: { ...v.args, name: undefined, resident_id: c.id }, level: 'prepare' })), confidence: 'low', tool: intent.tool, via: intent.via });
  }

  const out = { answer: result.text, evidence: result.rows || result.reminders || result.issues || [], data: result.resident || result.report || result.facts || null, actions: [], confidence: intent.via === 'local' ? 'high' : 'medium', tool: intent.tool, level: tool.level, via: intent.via };
  if (result.openWizard) out.openWizard = result.openWizard;
  if (result.checks) out.checks = result.checks;
  if (result.preview && !result.execute) out.preview = result.preview;
  if (result.download) out.actions.push({ label: 'Download', download: result.download, filename: result.filename, level: 'inform' });
  if (result.navigate) out.actions.push({ label: 'Open', navigate: result.navigate, level: 'inform' });
  if (Array.isArray(result.actions)) out.actions.push(...result.actions);
  if (tool.level === 'prepare' && result.execute) {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_proposals(id, user_id, tool, args, preview_text, expires_at) VALUES($1,$2,$3,$4,$5,NOW() + ($6 || ' minutes')::interval)`,
      [id, user.id, result.execute.tool, result.execute.args, result.text, String(PROPOSAL_TTL_MIN)]);
    audit.proposal_id = id;
    out.proposal = { id, tool: result.execute.tool, preview: result.preview, expires_in_minutes: PROPOSAL_TTL_MIN };
    out.actions.unshift({ label: result.execute.label, confirm: id, level: 'execute' });
  }
  return finish(out);
}

// ── 3. Confirm: run an execute tool for a proposal, once ──────────────────
async function confirm({ user, proposal_id, authorization, port }) {
  const t0 = Date.now();
  if (!/^[0-9a-f-]{36}$/i.test(String(proposal_id))) { const e = new Error('That proposal does not exist.'); e.status = 404; throw e; }
  const r = await pool.query(`SELECT * FROM ai_proposals WHERE id=$1`, [proposal_id]);
  const p = r.rows[0];
  const fail = async (msg, code) => {
    await pool.query(`INSERT INTO ai_actions(user_id, request_text, interpretation, proposal_id, error, ms) VALUES($1,$2,$3,$4,$5,$6)`, [user.id, 'confirm', { tool: p?.tool || null }, proposal_id, code, Date.now() - t0]).catch(() => {});
    const e = new Error(msg); e.status = code === 'forbidden' ? 403 : code === 'not-found' ? 404 : 409; throw e;
  };
  if (!p) return fail('That proposal does not exist.', 'not-found');
  if (String(p.user_id) !== String(user.id)) return fail('That proposal belongs to another user.', 'forbidden');
  if (p.confirmed_at) return fail('That was already confirmed.', 'already-confirmed');
  if (new Date(p.expires_at) < new Date()) return fail('That proposal has expired — ask again.', 'expired');
  const tool = tools.TOOLS[p.tool];
  if (!tool || tool.level !== 'execute') return fail('Not an executable action.', 'invalid');
  if (!tools.allowed(tool, user)) return fail('That needs an admin login.', 'forbidden');
  // Claim it atomically so a double-tap cannot run it twice.
  const claim = await pool.query(`UPDATE ai_proposals SET confirmed_at=NOW() WHERE id=$1 AND confirmed_at IS NULL RETURNING id`, [proposal_id]);
  if (!claim.rows[0]) return fail('That was already confirmed.', 'already-confirmed');
  try {
    const result = await tool.run(p.args, { user, authorization, port });
    await pool.query(`UPDATE ai_proposals SET result=$2 WHERE id=$1`, [proposal_id, result.record || null]);
    await pool.query(`INSERT INTO ai_actions(user_id, request_text, interpretation, proposal_id, confirmed_at, result_text, ms) VALUES($1,'confirm',$2,$3,NOW(),$4,$5)`, [user.id, { tool: p.tool, args: p.args }, proposal_id, result.text, Date.now() - t0]);
    return { answer: result.text, record: result.record || null, actions: result.navigate ? [{ label: 'Open', navigate: result.navigate, level: 'inform' }] : [] };
  } catch (e) {
    // Release the claim so the user can retry after fixing the cause.
    await pool.query(`UPDATE ai_proposals SET confirmed_at=NULL, last_error=$2 WHERE id=$1`, [proposal_id, e.message]);
    await pool.query(`INSERT INTO ai_actions(user_id, request_text, interpretation, proposal_id, error, ms) VALUES($1,'confirm',$2,$3,$4,$5)`, [user.id, { tool: p.tool }, proposal_id, e.message, Date.now() - t0]).catch(() => {});
    const err = new Error(e.message); err.status = 400; throw err;
  }
}

// ── 4. Property health score (explainable) ────────────────────────────────
// Each component is a plain rule the owner can check. "Resident experience"
// is null until Sprint 11 gives us ratings, and the overall ignores nulls.
function healthScore(f, extra = {}) {
  const c = {};
  const occ = f.totalBeds ? Math.round(f.headcount * 100 / f.totalBeds) : 0;
  c.occupancy = { score: Math.min(100, occ), why: `${f.headcount} of ${f.totalBeds} beds occupied (${occ}%)` };
  const billed = extra.monthlyBilled || 0;
  const dueRatio = billed ? Math.min(1, f.rentDue.total / billed) : (f.rentDue.count ? 0.5 : 0);
  const collections = Math.round(100 - dueRatio * 100);
  c.collections = { score: collections, why: f.rentDue.count ? `${fmt(f.rentDue.total)} outstanding from ${f.rentDue.count} resident${f.rentDue.count === 1 ? '' : 's'}${billed ? ` (${Math.round(dueRatio * 100)}% of a month's rent roll)` : ''}` : 'Nothing outstanding' };
  const ops = f.checklist.total ? Math.round(f.checklist.yesterdayDone * 100 / f.checklist.total) : 100;
  c.operations = { score: ops, why: f.checklist.total ? `Yesterday's checklist ${f.checklist.yesterdayDone}/${f.checklist.total}` : 'Checklist not set up' };
  const maint = Math.max(0, 100 - f.complaints.open * 8 - f.complaints.urgent * 12);
  c.maintenance = { score: maint, why: f.complaints.open ? `${f.complaints.open} open request${f.complaints.open === 1 ? '' : 's'}, ${f.complaints.urgent} water/electrical/security` : 'No open requests' };
  c.experience = extra.satisfaction != null ? { score: Math.round(extra.satisfaction * 20), why: `Resident satisfaction ${extra.satisfaction}/5` } : { score: null, why: 'Not measured yet (arrives with resident feedback)' };
  const parts = Object.values(c).filter(x => x.score != null);
  const overall = Math.round(parts.reduce((t, x) => t + x.score, 0) / parts.length);
  return { overall, components: c };
}

// ── 5. Brief v2: what changed, attention by level, recommendations ────────
async function whatChanged(f) {
  const y = f.checklist.yesterday;
  const [collected, newIssues, resolved, joined, left, checkoutsSoon] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1`, [y]),
    pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE created_at::date=$1`, [y]),
    pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE resolved_at::date=$1`, [y]),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE join_date=$1`, [y]),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE leave_date=$1`, [y]),
    pool.query(`SELECT g.name, r.room_number, g.leave_date FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true AND g.leave_date BETWEEN $1 AND ($1::date + 7) ORDER BY g.leave_date`, [f.date])
  ]);
  const lines = [];
  if (collected.rows[0].n) lines.push(`${fmt(collected.rows[0].t)} collected yesterday (${collected.rows[0].n} payment${collected.rows[0].n === 1 ? '' : 's'})`);
  if (newIssues.rows[0].n) lines.push(`${newIssues.rows[0].n} new request${newIssues.rows[0].n === 1 ? '' : 's'} reported`);
  if (resolved.rows[0].n) lines.push(`${resolved.rows[0].n} request${resolved.rows[0].n === 1 ? '' : 's'} resolved`);
  if (joined.rows[0].n) lines.push(`${joined.rows[0].n} resident${joined.rows[0].n === 1 ? '' : 's'} joined`);
  if (left.rows[0].n) lines.push(`${left.rows[0].n} resident${left.rows[0].n === 1 ? '' : 's'} checked out`);
  if (checkoutsSoon.rows.length) lines.push(`${checkoutsSoon.rows.length} checkout${checkoutsSoon.rows.length === 1 ? '' : 's'} in the next 7 days`);
  return { lines: lines.length ? lines : ['Quiet day yesterday — nothing recorded'], checkoutsSoon: checkoutsSoon.rows };
}

function attentionAndRecommendations(f, user) {
  const high = [], medium = [], low = [], recs = [];
  if (f.complaints.urgent) { high.push(`${f.complaints.urgent} water/electrical/security request${f.complaints.urgent === 1 ? '' : 's'} open`); recs.push({ text: 'Resolve the urgent requests first', action: { label: 'Open requests', navigate: 'complaints' } }); }
  if (f.overdue.length) { (f.overdue.some(g => g.months >= 2) ? high : medium).push(`${f.overdue.length} resident${f.overdue.length === 1 ? '' : 's'} a month or more behind (${fmt(f.overdue.reduce((t, g) => t + g.amount_due, 0))})`); recs.push({ text: `Send reminders to the ${f.overdue.length} most overdue`, action: { label: 'Draft reminders', ask: 'send reminders to residents 1+ months behind' } }); }
  else if (f.rentDue.count) medium.push(`${fmt(f.rentDue.total)} rent outstanding from ${f.rentDue.count}`);
  if (f.pendingClaims.n) { medium.push(`${f.pendingClaims.n} UPI payment${f.pendingClaims.n === 1 ? '' : 's'} (${fmt(f.pendingClaims.total)}) awaiting your confirmation`); if (user?.role === 'admin') recs.push({ text: 'Confirm the resident UPI claims', action: { label: 'Open payments', navigate: 'payments' } }); }
  if (f.pendingApprovals.n && user?.role === 'admin') { low.push(`${f.pendingApprovals.n} staff entr${f.pendingApprovals.n === 1 ? 'y' : 'ies'} awaiting approval`); }
  if (f.checklist.total && f.checklist.yesterdayDone / f.checklist.total < 0.5) { medium.push(`Checklist only ${f.checklist.yesterdayDone}/${f.checklist.total} yesterday`); recs.push({ text: "Start today's checklist early", action: { label: 'Open checklist', navigate: 'daily-checklist' } }); }
  if (f.complaints.open && !f.complaints.urgent) low.push(`${f.complaints.open} open request${f.complaints.open === 1 ? '' : 's'}`);
  if (f.vacantBeds >= 2) low.push(`${f.vacantBeds} beds vacant`);
  if (!recs.length) recs.push({ text: 'Nothing urgent — a good day to fill vacant beds or clear small requests', action: { label: "Today's checklist", navigate: 'daily-checklist' } });
  return { attention: { high, medium, low }, recommendations: recs.slice(0, 3) };
}

async function monthlyBilled() { const r = await pool.query(`SELECT COALESCE(SUM(monthly_rent),0)::float AS t FROM guests WHERE is_active=true`); return r.rows[0].t; }

async function briefV2({ user, force } = {}) {
  const key = `brief2:${istToday()}:${user?.role || 'staff'}`;
  if (!force) { const hit = await assistant.cacheGet(key); if (hit) return { ...hit.data, cached: true, computed_at: hit.computed_at }; }
  const base = await assistant.getBrief({ force });
  const f = base.facts;
  const [changed, billed] = await Promise.all([whatChanged(f), monthlyBilled()]);
  const health = healthScore(f, { monthlyBilled: billed });
  const { attention, recommendations } = attentionAndRecommendations(f, user);
  const greeting = (() => { const h = istNow().getUTCHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })();
  const dateLabel = new Date(f.date + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const text = [
    `🏠 *Siri Mane — ${dateLabel}*`, `Property health ${health.overall}/100`, '',
    '*What changed*', ...changed.lines.map(l => '• ' + l), '',
    '*Needs attention*',
    ...(attention.high.length ? ['High:', ...attention.high.map(l => '  🔴 ' + l)] : []),
    ...(attention.medium.length ? ['Medium:', ...attention.medium.map(l => '  🟠 ' + l)] : []),
    ...(attention.low.length ? ['Low:', ...attention.low.map(l => '  🟢 ' + l)] : []),
    ...(!attention.high.length && !attention.medium.length && !attention.low.length ? ['  ✅ Nothing needs attention'] : []),
    '', '*Siri recommends*', ...recommendations.map((r, i) => `${i + 1}. ${r.text}`)
  ].join('\n');
  const out = { date: f.date, greeting, dateLabel, health, changed: changed.lines, checkoutsSoon: changed.checkoutsSoon, attention, recommendations, facts: f, text, legacyText: base.text };
  await assistant.cachePut(key, text, out, 24 * 60);
  return { ...out, cached: false, computed_at: new Date().toISOString() };
}

// ── 6. Evening summary ────────────────────────────────────────────────────
async function eveningSummary({ force } = {}) {
  const today = istToday();
  const key = `evening:${today}`;
  if (!force) { const hit = await assistant.cacheGet(key); if (hit) return { ...hit.data, cached: true }; }
  const tomorrow = new Date(new Date(today + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const [collected, byMode, resolved, newIssues, checklist, clTotal, arrivals, departures, f] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1`, [today]),
    pool.query(`SELECT payment_mode, COALESCE(SUM(amount),0)::float AS t FROM collections WHERE is_deleted=false AND status='confirmed' AND collection_date=$1 GROUP BY payment_mode`, [today]),
    pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE resolved_at::date=$1`, [today]),
    pool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE created_at::date=$1`, [today]),
    pool.query(`SELECT COUNT(*)::int AS n FROM checklist_log l JOIN checklist_items i ON i.id=l.item_id AND i.is_active=true WHERE l.log_date=$1 AND l.is_checked=true`, [today]),
    pool.query(`SELECT COUNT(*)::int AS n FROM checklist_items WHERE is_active=true`),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE join_date=$1`, [tomorrow]),
    pool.query(`SELECT COUNT(*)::int AS n FROM guests WHERE is_active=true AND leave_date=$1`, [tomorrow]),
    assistant.computeFacts()
  ]);
  const remaining = Math.max(0, clTotal.rows[0].n - checklist.rows[0].n);
  const modes = byMode.rows.map(m => `${m.payment_mode} ${fmt(m.t)}`).join(' · ');
  const lines = [
    `🌙 *Siri Mane — ${new Date(today + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })} summary*`, '',
    `💰 ${fmt(collected.rows[0].t)} collected${collected.rows[0].n ? ` (${collected.rows[0].n} payment${collected.rows[0].n === 1 ? '' : 's'}${modes ? ': ' + modes : ''})` : ''}`,
    `🛠️ ${resolved.rows[0].n} resolved, ${newIssues.rows[0].n} new, ${f.complaints.open} still open`,
    `✅ Checklist ${checklist.rows[0].n}/${clTotal.rows[0].n}${remaining ? ` — ${remaining} left` : ' — complete'}`,
    `👥 ${f.headcount} residents · ${f.vacantBeds} bed${f.vacantBeds === 1 ? '' : 's'} vacant`,
    `📌 ${fmt(f.rentDue.total)} still outstanding from ${f.rentDue.count}`,
    '', '*Tomorrow*',
    `• ${arrivals.rows[0].n} check-in${arrivals.rows[0].n === 1 ? '' : 's'}, ${departures.rows[0].n} checkout${departures.rows[0].n === 1 ? '' : 's'}`,
    ...(f.pendingClaims.n ? [`• ${f.pendingClaims.n} UPI claim${f.pendingClaims.n === 1 ? '' : 's'} to confirm`] : []),
    ...(f.overdue.length ? [`• Follow up with ${f.overdue.slice(0, 3).map(g => g.name).join(', ')}${f.overdue.length > 3 ? ` +${f.overdue.length - 3}` : ''}`] : [])
  ];
  const out = { date: today, text: lines.join('\n'), collected: collected.rows[0], resolved: resolved.rows[0].n, newIssues: newIssues.rows[0].n, checklist: { done: checklist.rows[0].n, total: clTotal.rows[0].n }, tomorrow: { arrivals: arrivals.rows[0].n, departures: departures.rows[0].n } };
  await assistant.cachePut(key, out.text, out, 12 * 60);
  return { ...out, cached: false };
}

// ── 7. Evening scheduler ──────────────────────────────────────────────────
let lastEvening = null;
let eveningInFlight = null;
function startEveningScheduler({ intervalMs = 60000, log = console.log } = {}) {
  // Serialised like the brief scheduler: overlapping ticks join the one in
  // flight instead of racing it.
  const tick = () => { if (eveningInFlight) return eveningInFlight; eveningInFlight = run().finally(() => { eveningInFlight = null; }); return eveningInFlight; };
  const run = async () => {
    try {
      const r = await pool.query(`SELECT value FROM app_settings WHERE key='evening_time'`);
      const at = r.rows[0]?.value || '20:00';
      const now = istNow(); const hhmm = now.toISOString().slice(11, 16); const today = now.toISOString().slice(0, 10);
      if (hhmm >= at && lastEvening !== today) { lastEvening = today; await eveningSummary({ force: true }); log(`[evening] summary computed for ${today}`); }
    } catch (e) { log('[evening] ' + e.message); }
  };
  const h = setInterval(tick, intervalMs); if (h.unref) h.unref(); tick();
  return { stop: () => clearInterval(h), tick };
}

module.exports = { ask, confirm, localIntent, modelIntent, healthScore, briefV2, eveningSummary, attentionAndRecommendations, startEveningScheduler, modelAvailable, _reset: () => { lastEvening = null; } };
