// Add password to guests table
// Run: node guest-migration.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Adding password to guests...');

    // Add password_hash column to guests
    await client.query(`
      ALTER TABLE guests 
      ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)
    `);
    console.log('✅ password_hash column added');

    // Set default password = mobile number for existing guests
    const guests = await client.query('SELECT id, phone FROM guests WHERE password_hash IS NULL AND phone IS NOT NULL');
    for (const g of guests.rows) {
      const hash = await bcrypt.hash(g.phone, 10);
      await client.query('UPDATE guests SET password_hash=$1 WHERE id=$2', [hash, g.id]);
      console.log(`✅ Password set for guest ${g.id} → phone: ${g.phone}`);
    }

    console.log('\n🎉 Guest migration done!');
    console.log('Default password = mobile number for all guests');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
