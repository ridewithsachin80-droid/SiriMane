// backend/scripts/migrate-staff-disable.js — Sprint 17 (S17-1)
// Additive only. A staff/admin account can be TURNED OFF instead of deleted:
// it can't log in and open sessions stop, but every entry it made and its
// audit-log history stay. NULL = on (every existing account stays on).
// Safe to re-run.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`);
    console.log('✅ users.disabled_at ready');
  } finally { client.release(); }
}

migrate().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
