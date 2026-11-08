// backend/scripts/fix-id-type.js — Sprint 16 (S16-8), owner-approved 8 Nov 2026
//
// Before Sprint 15, moving a resident in without choosing an ID type saved the
// dropdown's placeholder text "— select —" AS her ID type. Those residents look
// like they have an ID type, and the "ID proof missing" reminder skips them.
// This clears ONLY that field (sets it to empty/NULL). Nothing else changes.
//
// DRY RUN BY DEFAULT — prints what it would change and changes nothing.
//   Railway console:  node backend/scripts/fix-id-type.js
//   then, to change:  node backend/scripts/fix-id-type.js --apply
// Safe to re-run.
const pool = require('../db');

const APPLY = process.argv.includes('--apply');
// "— select —", "-- select --", "– Select –", "select" … in any case
const PLACEHOLDER = `lower(btrim(id_proof_type)) ~ '^[-—–\\s]*select[-—–\\s]*$'`;

async function main() {
  const { rows } = await pool.query(
    `SELECT g.id, g.name, g.id_proof_type, g.is_active, ro.room_number
       FROM guests g LEFT JOIN rooms ro ON ro.id = g.room_id
      WHERE ${PLACEHOLDER} ORDER BY g.id`);
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing is changed'} · ${rows.length} resident(s) have a placeholder as their ID type\n`);
  for (const g of rows) console.log(`  #${g.id} ${g.name}${g.room_number ? ` (Room ${g.room_number})` : ''}${g.is_active ? '' : ' [checked out]'}:  "${g.id_proof_type}"  →  (empty)`);
  if (APPLY && rows.length) {
    const r = await pool.query(`UPDATE guests SET id_proof_type = NULL WHERE ${PLACEHOLDER}`);
    console.log(`\nCleared: ${r.rowCount}`);
  } else {
    console.log(`\nWould clear: ${rows.length}${rows.length ? ' — run again with --apply to make these changes.' : ''}`);
  }
}

main().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
