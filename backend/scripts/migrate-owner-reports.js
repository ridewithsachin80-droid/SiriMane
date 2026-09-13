// backend/scripts/migrate-owner-reports.js — Sprint 5
// Additive only. Stores each month's owner report once generated, so a past
// month's report is final and identical every time it is downloaded.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS owner_reports (
        month CHAR(7) PRIMARY KEY,
        facts JSONB NOT NULL,
        summary_text TEXT,
        generated_at TIMESTAMP DEFAULT NOW()
      )`);
    console.log('✅ owner-reports migration complete (owner_reports)');
  } catch (err) {
    console.error('❌ owner-reports migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
