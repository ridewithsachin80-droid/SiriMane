// backend/scripts/migrate-complaints.js
// Creates the Complaint / Maintenance Register table. Guests can raise
// issues from the resident portal; staff/admin can also log issues found
// during rounds (matches the "Log any new issues in Complaint/Maintenance
// Register" and "Update status on yesterday's complaints" checklist tasks).
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        guest_name VARCHAR(100),
        room_number VARCHAR(20),
        category VARCHAR(50) DEFAULT 'other',
        description TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'open',
        raised_by VARCHAR(20) DEFAULT 'staff',
        created_by INTEGER REFERENCES users(id),
        resolution_notes TEXT,
        resolved_at TIMESTAMP,
        resolved_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ complaints table ready');
    console.log('\n🎉 Complaints migration completed successfully!');
  } catch (err) {
    console.error('❌ Complaints migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
