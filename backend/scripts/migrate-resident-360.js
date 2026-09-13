// backend/scripts/migrate-resident-360.js — Sprint 8
// Additive only. Expected checkout date (drives "leaving soon" and the
// departures line on Home), a stable resident number for the digital ID card,
// and a named emergency contact alongside the existing number.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS expected_checkout DATE`);
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(100)`);
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS resident_no VARCHAR(20)`);
    // Backfill a readable resident number once; never renumber an existing one.
    await client.query(`UPDATE guests SET resident_no = 'SM' || LPAD(id::text, 4, '0') WHERE resident_no IS NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_resident_no ON guests(resident_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_guests_expected_checkout ON guests(expected_checkout) WHERE expected_checkout IS NOT NULL`);
    console.log('✅ resident-360 migration complete (expected_checkout, resident_no, emergency_contact_name)');
  } catch (err) {
    console.error('❌ resident-360 migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
