// backend/services/schema-check.js — Sprint 5
// Compares the live database with what this version of the code needs and
// says so loudly if a migration hasn't been run. Read-only; never migrates.
// Keep REQUIRED in step with backend/scripts/migrate-*.js.
const pool = require('../db');

const REQUIRED = {
  tables: ['users', 'rooms', 'guests', 'collections', 'purchases', 'guest_rent_history', 'guest_room_history', 'deposit_refunds',
    'fixed_assets', 'capital_transactions', 'app_settings', 'daily_menu', 'announcements', 'inbox_messages', 'activity_log',
    'checklist_items', 'checklist_log', 'complaints', 'ai_reads', 'reminder_log', 'owner_reports', 'ai_proposals', 'ai_actions', 'request_comments', 'request_photos'],
  columns: { guests: ['password_hash', 'address', 'advance_required', 'rent_variance_approved', 'expected_checkout', 'resident_no'], collections: ['status', 'source'],
    purchases: ['status', 'source'], complaints: ['source', 'priority', 'assigned_to', 'sla_due_at'], rooms: ['status'], checklist_items: ['assigned_to'] }
};

let last = { checkedAt: null, missing: [], ok: null };

async function checkSchema(required = REQUIRED) {
  const missing = [];
  const t = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  const have = new Set(t.rows.map(r => r.table_name));
  for (const name of required.tables) if (!have.has(name)) missing.push(`table ${name}`);
  const c = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`);
  const cols = new Set(c.rows.map(r => `${r.table_name}.${r.column_name}`));
  for (const [table, list] of Object.entries(required.columns)) {
    if (!have.has(table)) continue; // already reported as a missing table
    for (const col of list) if (!cols.has(`${table}.${col}`)) missing.push(`column ${table}.${col}`);
  }
  last = { checkedAt: new Date().toISOString(), missing, ok: missing.length === 0 };
  return last;
}

function logResult(result, log = console.log) {
  if (result.ok) { log('✅ Database schema is up to date'); return; }
  log('');
  log('⚠️  ══════════════════════════════════════════════════════════════');
  log('⚠️  DATABASE IS MISSING WHAT THIS VERSION NEEDS:');
  for (const m of result.missing) log(`⚠️    • ${m}`);
  log('⚠️  Run in the Railway console:  node backend/scripts/migrate-all.js');
  log('⚠️  ══════════════════════════════════════════════════════════════');
  log('');
}

module.exports = { REQUIRED, checkSchema, logResult, lastResult: () => last };
