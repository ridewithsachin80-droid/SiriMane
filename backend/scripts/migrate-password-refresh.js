// backend/scripts/migrate-password-refresh.js — Hotfix 19.2
// Additive only. guests.must_change_password: when true, her next login (with
// her CURRENT password) goes straight to "choose a new password". Set for all
// residents by backend/scripts/require-password-change.js after the 19.1 leak.
// Safe to re-run.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false`);
    console.log('✅ guests.must_change_password ready');
  } finally { client.release(); }
}

migrate().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
