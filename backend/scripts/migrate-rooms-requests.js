// backend/scripts/migrate-rooms-requests.js — Sprint 9
// Additive only. Room condition, request ownership and a clock, comments,
// photos, and per-staff checklist tasks.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);
    await client.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_inspected DATE`);
    await client.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMP`);
    await client.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP`);
    await client.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS likely_issue TEXT`);
    // Existing open requests get a clock from their priority, counted from
    // when they were raised — so the list is honest on day one.
    await client.query(`UPDATE complaints
        SET sla_due_at = created_at + (CASE COALESCE(priority,'medium') WHEN 'high' THEN INTERVAL '2 hours' WHEN 'low' THEN INTERVAL '72 hours' ELSE INTERVAL '24 hours' END)
      WHERE sla_due_at IS NULL AND status <> 'resolved'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_comments (
        id SERIAL PRIMARY KEY,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        author_guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_request_comments_complaint ON request_comments(complaint_id, created_at)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS request_photos (
        id SERIAL PRIMARY KEY,
        complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        mime_type VARCHAR(30) NOT NULL,
        bytes INTEGER NOT NULL,
        data BYTEA NOT NULL,
        uploaded_by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
        uploaded_by_guest INTEGER REFERENCES guests(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_request_photos_complaint ON request_photos(complaint_id)`);
    await client.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS due_time VARCHAR(10)`);
    console.log('✅ rooms-requests migration complete (room status, SLA, assignment, comments, photos, staff tasks)');
  } catch (err) {
    console.error('❌ rooms-requests migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
