// backend/scripts/migrate-advance.js
// Adds advance_required to guests — the advance amount expected from a
// guest (e.g. one month's rent collected at joining). "Advance Pending" on
// the Rent Due page is this minus whatever's actually been logged as an
// 'advance' collection for that guest.
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE guests ADD COLUMN IF NOT EXISTS advance_required DECIMAL(10,2) DEFAULT 0;
    `);
    console.log('✅ guests.advance_required column ready');
    console.log('\n🎉 Advance migration completed successfully!');
  } catch (err) {
    console.error('❌ Advance migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
