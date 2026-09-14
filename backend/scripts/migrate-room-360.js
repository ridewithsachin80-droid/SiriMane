// backend/scripts/migrate-room-360.js — Sprint 13
// Additive only. One table: a room inspection with a note and a condition.
// rooms.last_inspected already exists (Sprint 9); recording an inspection
// keeps it in step.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_inspections (
        id SERIAL PRIMARY KEY,
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        inspected_on DATE NOT NULL DEFAULT CURRENT_DATE,
        inspected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        condition VARCHAR(12) NOT NULL DEFAULT 'ok',
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_room_inspections_room ON room_inspections(room_id, inspected_on DESC)`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_inspected DATE`);
    console.log('✅ room-360 migration complete (room_inspections)');
  } catch (err) {
    console.error('❌ room-360 migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
migrate();
