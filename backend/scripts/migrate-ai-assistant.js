// backend/scripts/migrate-ai-assistant.js — Sprint 4
// Additive only: complaint priority, and a log of reminders actually sent.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'medium'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_complaints_priority ON complaints(priority)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS reminder_log (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sent_at TIMESTAMP DEFAULT NOW(),
        channel VARCHAR(20) DEFAULT 'whatsapp',
        lang VARCHAR(5) DEFAULT 'en',
        text TEXT
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reminder_log_guest ON reminder_log(guest_id, sent_at DESC)`);
    console.log('✅ ai-assistant migration complete (complaints.priority + reminder_log)');
  } catch (err) {
    console.error('❌ ai-assistant migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
