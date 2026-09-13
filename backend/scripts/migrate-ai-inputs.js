// backend/scripts/migrate-ai-inputs.js — Sprint 3
// Additive only. Records HOW an entry was created (typed, spoken, or from a
// photo) so we can later measure how often the warden has to correct the AI,
// and creates the ai_reads cache used from Sprint 4 so the same fact is worded
// identically on the dashboard, in WhatsApp text and in the daily brief.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE collections ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual'`);
    await client.query(`ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual'`);
    await client.query(`ALTER TABLE complaints  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_reads (
        key TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        data JSONB,
        computed_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_reads_expires ON ai_reads(expires_at)`);
    console.log('✅ ai-inputs migration complete (source columns + ai_reads)');
  } catch (err) {
    console.error('❌ ai-inputs migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
