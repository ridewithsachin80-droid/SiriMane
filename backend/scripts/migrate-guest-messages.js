// backend/scripts/migrate-guest-messages.js — Sprint 16.3 (S16.3-7)
// Additive only. Links a message sent from the resident app to her account so
// she can see the reply under Help → My messages. Messages from the public
// form (no login) keep guest_id NULL. Safe to re-run.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE inbox_messages ADD COLUMN IF NOT EXISTS guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_guest ON inbox_messages(guest_id, created_at DESC)`);
    console.log('✅ inbox_messages.guest_id ready');
  } finally { client.release(); }
}

migrate().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
