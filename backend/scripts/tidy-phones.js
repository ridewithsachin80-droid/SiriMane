// backend/scripts/tidy-phones.js — Sprint 16 (S16-7), owner-approved 8 Nov 2026
//
// Rewrites resident phone numbers saved as "98765 43210", "+91 98765 43210",
// "098765-43210" … to the plain 10 digits that Sprint 15.4 stores for every
// new resident. Login already works either way; this makes search, WhatsApp
// links, reports and the one-number-per-resident rule see one format.
//
// DRY RUN BY DEFAULT — prints what it would change and changes nothing.
//   Railway console:  node backend/scripts/tidy-phones.js
//   then, to change:  node backend/scripts/tidy-phones.js --apply
//
// Never changes a row that would:
//   · not reduce to exactly 10 digits (landline, foreign number, typo), or
//   · give an ACTIVE resident the same number as another active resident.
// Those are listed for the warden to fix by hand. Safe to re-run.
const pool = require('../db');

const APPLY = process.argv.includes('--apply');

function tenDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  // Same rule as the app (routes/index.js normPhone): +91 / leading 0 dropped,
  // giving India's 10-digit national number.
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT g.id, g.name, g.phone, g.is_active, ro.room_number
       FROM guests g LEFT JOIN rooms ro ON ro.id = g.room_id
      WHERE g.phone IS NOT NULL AND g.phone <> '' AND g.phone !~ '^[0-9]{10}$'
      ORDER BY g.id`);

  const change = [], skipped = [];
  for (const g of rows) {
    // Two numbers in one field ("93333/93334"), notes or letters: never guess (review)
    if (/[^\d\s+().-]/.test(g.phone)) { skipped.push({ ...g, why: 'has other characters (two numbers? a note?) — check it by hand' }); continue; }
    const next = tenDigits(g.phone);
    // A resident's number is her login, so it should be an Indian mobile (starts 6–9).
    // Anything else — foreign, a landline without its 0, a typo — is for the warden to check.
    if (next.length !== 10 || !/^[6-9]/.test(next)) { skipped.push({ ...g, why: 'not an Indian mobile number — check it by hand' }); continue; }
    if (g.is_active) {
      const clash = await pool.query(
        `SELECT id, name FROM guests WHERE is_active = true AND id <> $1
           AND right(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $2 LIMIT 1`, [g.id, next]);
      if (clash.rows[0]) { skipped.push({ ...g, why: `same number as ${clash.rows[0].name} (id ${clash.rows[0].id}) — give one of them her own number` }); continue; }
    }
    change.push({ ...g, next });
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing is changed'} · ${rows.length} resident(s) have a phone that is not plain 10 digits\n`);
  for (const g of change) console.log(`  change  #${g.id} ${g.name}${g.room_number ? ` (Room ${g.room_number})` : ''}${g.is_active ? '' : ' [checked out]'}:  "${g.phone}"  →  ${g.next}`);
  for (const g of skipped) console.log(`  SKIP    #${g.id} ${g.name}${g.room_number ? ` (Room ${g.room_number})` : ''}:  "${g.phone}"  — ${g.why}`);

  if (APPLY && change.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const g of change) {
        // Only if it still holds the value we looked at (someone may have edited it since)
        await client.query('UPDATE guests SET phone = $1 WHERE id = $2 AND phone = $3', [g.next, g.id, g.phone]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  console.log(`\n${APPLY ? 'Changed' : 'Would change'}: ${change.length} · Skipped (fix by hand): ${skipped.length}`);
  if (!APPLY && change.length) console.log('Run again with --apply to make these changes.');
}

main().then(() => pool.end()).catch(e => { console.error('❌', e.message); pool.end(); process.exit(1); });
