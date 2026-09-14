// backend/scripts/migrate-notify-docs.js — Sprint 12
// Additive only. One bell, one outbox, document status, and a short list of
// things that need doing every few months.
//
// dedupe_key is what stops the same alert arriving twice: a generator builds a
// stable key per trigger per day, and the unique index refuses the duplicate.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        level VARCHAR(16) NOT NULL DEFAULT 'informational',
        category VARCHAR(24) NOT NULL DEFAULT 'system',
        title TEXT NOT NULL,
        detail TEXT,
        action_page VARCHAR(40),
        dedupe_key TEXT NOT NULL,
        for_role VARCHAR(10) NOT NULL DEFAULT 'staff',
        read_at TIMESTAMP,
        read_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(30) NOT NULL,
        guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
        guest_name VARCHAR(100),
        phone VARCHAR(20),
        body TEXT NOT NULL,
        lang VARCHAR(5) DEFAULT 'en',
        status VARCHAR(12) NOT NULL DEFAULT 'draft',
        dedupe_key TEXT NOT NULL,
        sent_at TIMESTAMP,
        sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedupe ON outbox(dedupe_key)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS resident_documents (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        doc_type VARCHAR(30) NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        expires_on DATE,
        note TEXT,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (guest_id, doc_type)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_schedule (
        id SERIAL PRIMARY KEY,
        task VARCHAR(120) NOT NULL,
        vendor VARCHAR(100),
        every_days INTEGER NOT NULL DEFAULT 90,
        last_done DATE,
        next_due DATE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    // A starting list the warden can edit or delete; seeded once only.
    const seeded = await client.query('SELECT COUNT(*)::int AS n FROM maintenance_schedule');
    if (seeded.rows[0].n === 0) {
      for (const [task, days] of [['Water tank cleaning', 90], ['Pest control', 120], ['RO / water purifier service', 90], ['Fire extinguisher check', 365]]) {
        await client.query(`INSERT INTO maintenance_schedule(task, every_days, next_due) VALUES($1,$2,CURRENT_DATE + ($2::int))`, [task, days]);
      }
      console.log('   seeded 4 recurring maintenance tasks');
    }
    console.log('✅ notify-docs migration complete (notifications, outbox, resident_documents, maintenance_schedule)');
  } catch (err) {
    console.error('❌ notify-docs migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
