// backend/scripts/require-password-change.js — Hotfix 19.2 (owner-approved 9 Nov 2026)
//
// After the 19.1 leak (a public address returned residents' password hashes),
// every current resident is asked to choose a new password at her next login.
// She logs in with her CURRENT password as usual; the app then shows "choose a
// new password". Nothing is wiped and nobody is locked out.
//
// DRY RUN BY DEFAULT — prints what it would change and changes nothing.
//   Railway console:  node backend/scripts/require-password-change.js
//   then, to change:  node backend/scripts/require-password-change.js --apply
// Needs the database update first:  node backend/scripts/migrate-all.js
// Safe to re-run: a resident who already chose a new password is asked again
// only if you run --apply again.
const pool = require('../db');
const APPLY = process.argv.includes('--apply');

async function main() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS residents,
            count(*) FILTER (WHERE must_change_password)::int AS already
       FROM guests WHERE is_active = true`);
  const { residents, already } = rows[0];
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing is changed'}`);
  console.log(`Active residents: ${residents} · already asked: ${already} · would ask now: ${residents - already}`);
  if (APPLY) {
    const r = await pool.query(`UPDATE guests SET must_change_password = true WHERE is_active = true AND must_change_password = false`);
    console.log(`Asked: ${r.rowCount} resident(s). Each chooses a new password at her next login.`);
  } else if (residents - already > 0) console.log('Run again with --apply to ask them.');
}

main().then(() => pool.end()).catch(e => {
  console.error('❌', /must_change_password/.test(e.message) ? 'Run node backend/scripts/migrate-all.js first.' : e.message);
  pool.end(); process.exit(1);
});
