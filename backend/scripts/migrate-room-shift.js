// backend/scripts/migrate-room-shift.js
// Creates guest_room_history — records every internal room/bed move a guest
// makes, including moves logged after the fact with a backdated effective
// date (e.g. "she actually shifted to Room 5 two weeks ago, just wasn't
// logged then").
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS guest_room_history (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        from_room_number VARCHAR(20),
        from_bed_number VARCHAR(20),
        to_room_id INTEGER REFERENCES rooms(id),
        to_room_number VARCHAR(20),
        to_bed_number VARCHAR(20),
        effective_from DATE NOT NULL,
        changed_by INTEGER REFERENCES users(id),
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ guest_room_history table ready');
    console.log('\n🎉 Room shift migration completed successfully!');
  } catch (err) {
    console.error('❌ Room shift migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
