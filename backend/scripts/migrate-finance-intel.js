// backend/scripts/migrate-finance-intel.js — Sprint 10
// Additive only. Daily cash-up (what was counted vs what was recorded) and
// the variances that come out of it. Nothing here alters a collection: a
// closing is a statement about a day, not a change to it.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS day_closings (
        close_date DATE PRIMARY KEY,
        cash_counted NUMERIC(12,2) NOT NULL DEFAULT 0,
        upi_counted NUMERIC(12,2) NOT NULL DEFAULT 0,
        bank_counted NUMERIC(12,2) NOT NULL DEFAULT 0,
        expected_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
        expected_upi NUMERIC(12,2) NOT NULL DEFAULT 0,
        expected_bank NUMERIC(12,2) NOT NULL DEFAULT 0,
        note TEXT,
        closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        closed_at TIMESTAMP DEFAULT NOW(),
        reopened_at TIMESTAMP,
        reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS collection_variances (
        id SERIAL PRIMARY KEY,
        close_date DATE NOT NULL,
        mode VARCHAR(20) NOT NULL,
        expected NUMERIC(12,2) NOT NULL,
        counted NUMERIC(12,2) NOT NULL,
        difference NUMERIC(12,2) NOT NULL,
        note TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_variances_date ON collection_variances(close_date DESC)`);
    console.log('✅ finance-intel migration complete (day_closings, collection_variances)');
  } catch (err) {
    console.error('❌ finance-intel migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
