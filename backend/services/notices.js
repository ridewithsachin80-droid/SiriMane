// backend/services/notices.js — Sprint 20 (S20-5)
// Which notices a resident may see: published, not expired, active, and aimed
// at everyone, her room, her floor or her. One rule for every resident screen
// (the portal used to list every active notice, ignoring the targeting).
// Query params: $1 = guest id, $2 = her room number, $3 = her floor.
const pool = require('../db');

function noticeWhere(alias = 'a') {
  return `COALESCE(${alias}.is_active, true)
      AND (${alias}.publish_at IS NULL OR ${alias}.publish_at <= NOW())
      AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > NOW())
      AND (COALESCE(${alias}.target_type,'all') = 'all'
        OR (${alias}.target_type='room' AND ${alias}.target_value = $2)
        OR (${alias}.target_type='floor' AND ${alias}.target_value = $3)
        OR (${alias}.target_type='resident' AND ${alias}.target_value = $1::text))`;
}

async function residentContext(guestId) {
  const r = await pool.query(`SELECT g.id, g.name, g.room_id, g.bed_number, r.room_number, r.floor
                                FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.id=$1`, [guestId]);
  const x = r.rows[0] || {};
  return { id: guestId, name: x.name, room_number: x.room_number || null, floor: x.floor == null ? null : String(x.floor) };
}

module.exports = { noticeWhere, residentContext };
