// backend/scripts/migrate-resident-experience.js — Sprint 11
// Additive only. Meal ratings, visitors, targeted notices with read receipts,
// and an anonymous monthly satisfaction card.
//
// Note on privacy: satisfaction_responses deliberately has NO guest_id. The
// card is anonymous, and a table that could de-anonymise it would make that a
// lie. Meal ratings do carry guest_id — a resident must be able to change her
// own rating — but nothing in the app shows a rating attributed to a person.
//
// Railway web console:  node backend/scripts/migrate-all.js
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS meal_ratings (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        rating_date DATE NOT NULL,
        meal_type VARCHAR(20) NOT NULL,
        stars SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment VARCHAR(120),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (guest_id, rating_date, meal_type)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_meal_ratings_date ON meal_ratings(rating_date DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id SERIAL PRIMARY KEY,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        visitor_name VARCHAR(100) NOT NULL,
        visitor_phone VARCHAR(20),
        relation VARCHAR(40),
        expected_at TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'expected',
        checked_in_at TIMESTAMP,
        checked_out_at TIMESTAMP,
        handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_visitors_guest ON visitors(guest_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status, expected_at)`);

    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) DEFAULT 'all'`);
    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS target_value VARCHAR(40)`);
    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS publish_at TIMESTAMP`);
    await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcement_reads (
        announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        read_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (announcement_id, guest_id)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS satisfaction_responses (
        id SERIAL PRIMARY KEY,
        month CHAR(7) NOT NULL,
        cleanliness SMALLINT CHECK (cleanliness BETWEEN 1 AND 5),
        food SMALLINT CHECK (food BETWEEN 1 AND 5),
        safety SMALLINT CHECK (safety BETWEEN 1 AND 5),
        staff SMALLINT CHECK (staff BETWEEN 1 AND 5),
        wifi SMALLINT CHECK (wifi BETWEEN 1 AND 5),
        comment VARCHAR(300),
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_satisfaction_month ON satisfaction_responses(month)`);
    // Who has answered is tracked without linking the answer to the person.
    await client.query(`
      CREATE TABLE IF NOT EXISTS satisfaction_submitted (
        guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        month CHAR(7) NOT NULL,
        submitted_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (guest_id, month)
      )`);
    console.log('✅ resident-experience migration complete (meal ratings, visitors, targeted notices, satisfaction)');
  } catch (err) {
    console.error('❌ resident-experience migration failed:', err.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
migrate();
