// backend/scripts/migrate-all.js
// Runs every migration in the correct order, in one command. Safe to re-run
// at any time — every script underneath uses CREATE TABLE IF NOT EXISTS /
// ADD COLUMN IF NOT EXISTS and never drops or rewrites data.
//
// Railway web console:   node backend/scripts/migrate-all.js
//
// Order matters: the base tables must exist before the additive scripts run,
// and guest-migration must run before anything that reads password_hash.
// Each script is run as a separate Node process (they each open and close
// their own pool), so one failing script stops the chain and the exit code
// is non-zero — Railway will show it in red.
const { spawnSync } = require('child_process');
const path = require('path');

const ORDER = [
  'migrate.js',                 // base tables (users, rooms, guests, collections, purchases, menu, announcements, inbox, activity_log)
  'guest-migration.js',         // guests.password_hash
  'migrate-accountability.js',  // created_by / soft-delete / status / rent history / deposit refunds / settings / assets / capital
  'migrate-advance.js',         // guests.advance_required
  'migrate-guest-address.js',   // guests.address
  'migrate-room-shift.js',      // guest_room_history
  'migrate-checklist.js',       // checklist_items + checklist_log (+ default tasks on first run)
  'migrate-complaints.js',      // complaints
  'migrate-ai-inputs.js'        // Sprint 3: source columns + ai_reads cache
];

let failed = false;
for (const file of ORDER) {
  const full = path.join(__dirname, file);
  console.log(`\n▶ ${file}`);
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) {
    console.error(`\n❌ ${file} exited with code ${r.status}. Stopping here — fix the error above and re-run.`);
    failed = true;
    break;
  }
}

if (!failed) console.log('\n🎉 All migrations are up to date.');
process.exit(failed ? 1 : 0);
