// scripts/migrate-accountability.js
// Additive-only migration: adds audit-trail columns and the deposit_refunds
// table needed for the staff-roles / audit-log / rent-due / move-out features.
// Safe to run multiple times and safe to run on the existing production DB —
// nothing here drops or rewrites existing data.
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running accountability migration...');

    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);`);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id);`);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`);
    console.log('✅ purchases: audit columns ready');

    await client.query(`ALTER TABLE collections ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);`);
    await client.query(`ALTER TABLE collections ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id);`);
    await client.query(`ALTER TABLE collections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`);
    console.log('✅ collections: audit columns ready');

    await client.query(`ALTER TABLE guests ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);`);
    console.log('✅ guests: created_by column ready');

    await client.query(`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS details TEXT;`);
    console.log('✅ activity_log: details column ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS deposit_refunds (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        guest_name VARCHAR(100) NOT NULL,
        room_number VARCHAR(20),
        deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        deductions DECIMAL(10,2) NOT NULL DEFAULT 0,
        deduction_notes TEXT,
        refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        refund_mode VARCHAR(50) DEFAULT 'cash',
        processed_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ deposit_refunds table ready');

    console.log('\n🎉 Accountability migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
