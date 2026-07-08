// backend/scripts/migrate-checklist.js
// Creates the Daily Warden Checklist tables and seeds the default task list
// (from Siri_Mane_Daily_Checklist.md). Safe to re-run: tables use
// IF NOT EXISTS, and the seed only inserts if the items table is empty, so
// re-running this after items have been customized won't reset them.
const pool = require('../db');

// [section, time_label, task, sort_order]
const DEFAULT_ITEMS = [
  // Morning
  ['Morning', '7:00 AM', 'Walkthrough — corridors, mess, washrooms, gate area', 1],
  ['Morning', '7:00 AM', "Check yesterday's Closing Sheet for pending items", 2],
  ['Morning', '7:15 AM', 'Check stock — water, cleaning/kitchen supplies', 3],
  ['Morning', '7:15 AM', "Check-in with cook/housekeeping staff on day's plan", 4],
  ['Morning', '7:30 AM', 'Breakfast mess supervision — food count matches headcount', 5],
  ['Morning', '8:00 – 9:30 AM', 'Out-Register — log every girl leaving, with time-out', 6],
  ['Morning', '9:30 AM', 'Headcount check — present vs. total 51', 7],
  ['Morning', '9:30 AM', 'Visitor Register check — anyone still on premises from last night', 8],
  // Mid-Day
  ['Mid-Day', '—', 'Handle new admission enquiries (calls/walk-ins)', 1],
  ['Mid-Day', '—', 'Follow up on pending rent dues', 2],
  ['Mid-Day', '—', 'Maintenance round — washrooms, water, electrical, Wi-Fi', 3],
  ['Mid-Day', '—', 'Log any new issues in Complaint/Maintenance Register', 4],
  ['Mid-Day', '—', "Update status on yesterday's complaints (Open/In Progress/Resolved)", 5],
  ['Mid-Day', '—', 'Confirm housekeeping — rooms & common areas cleaned', 6],
  ['Mid-Day', '—', 'Log any courier/parcels received, notify resident', 7],
  // Evening
  ['Evening', '4:00 – 7:00 PM', 'In-Register — log return time as girls come back', 1],
  ['Evening', '4:00 – 7:00 PM', 'Flag anyone significantly late vs. expected return', 2],
  ['Evening', '—', 'Visitor Register — log any visitor (name, relation, time in/out)', 3],
  ['Evening', '7:30 PM', 'Dinner mess supervision — food count vs. headcount', 4],
  ['Evening', '7:30 PM', 'Curfew reminder circulated (WhatsApp group/notice board)', 5],
  ['Evening', '—', 'Address any maintenance requests raised during the day', 6],
  // Night / Gate Closing
  ['Night', '8:30 PM', 'Final headcount — tally in-house vs. 51 total', 1],
  ['Night', '8:30 PM', 'Call any resident not yet returned', 2],
  ['Night', '8:45 PM', 'Call emergency contact if beyond grace period', 3],
  ['Night', '9:00 PM', 'Log any late entries + reason in Late-Entry Log', 4],
  ['Night', '9:00 PM', 'Lock gate — note official lock time', 5],
  ['Night', '9:15 PM', 'Final round — corridors, terrace, common areas, lights off', 6],
  // Closing the Day
  ['Closing', '—', 'Total headcount confirmed (51 − approved overnight-outs)', 1],
  ['Closing', '—', 'Pending complaints noted for tomorrow', 2],
  ['Closing', '—', 'Rent follow-ups noted', 3],
  ['Closing', '—', 'New admission status noted', 4],
  ['Closing', '—', 'Any incident/issue recorded for your files', 5],
  ['Closing', '—', 'Gate locked, lights/appliances checked, keys in place', 6],
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS checklist_items (
        id SERIAL PRIMARY KEY,
        section VARCHAR(20) NOT NULL,
        time_label VARCHAR(30) DEFAULT '—',
        task TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ checklist_items table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS checklist_log (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
        log_date DATE NOT NULL,
        is_checked BOOLEAN DEFAULT FALSE,
        checked_by INTEGER REFERENCES users(id),
        checked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(item_id, log_date)
      );
    `);
    console.log('✅ checklist_log table ready');

    const existing = await client.query('SELECT COUNT(*) FROM checklist_items');
    if (parseInt(existing.rows[0].count) === 0) {
      for (const [section, time_label, task, sort_order] of DEFAULT_ITEMS) {
        await client.query(
          `INSERT INTO checklist_items(section, time_label, task, sort_order) VALUES($1,$2,$3,$4)`,
          [section, time_label, task, sort_order]
        );
      }
      console.log(`✅ Seeded ${DEFAULT_ITEMS.length} default checklist items`);
    } else {
      console.log('ℹ️  checklist_items already has data, skipped seeding');
    }

    console.log('\n🎉 Checklist migration completed successfully!');
  } catch (err) {
    console.error('❌ Checklist migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(process.exit.bind(process, 1));
