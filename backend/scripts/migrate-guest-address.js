// backend/scripts/migrate-guest-address.js
// Adds a home/permanent address field to guests (separate from the PG's own
// address used on receipts). Safe to re-run — ADD COLUMN IF NOT EXISTS.
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS address TEXT;`);
    console.log('✅ guests.address column ready');
    console.log('\n🎉 Guest address migration completed successfully!');
  } catch (err) {
    console.error('❌ Guest address migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
