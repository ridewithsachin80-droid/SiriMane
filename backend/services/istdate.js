// backend/services/istdate.js — Sprint 18 (D-15-2): one clock.
//
// Siri Mane runs on India time, but Railway's Node and Postgres run in UTC, so
// between 00:00 and 05:30 IST "today" there is still yesterday. Every place
// that asks "what is today / which day was this" uses these instead of
// new Date().toISOString(), CURRENT_DATE or col::date.
//
// Stored data is NOT changed: `timestamp without time zone` columns keep the
// wall-clock time of the database session (UTC on Railway); istDateSql()
// converts through the session time zone, so it stays right whatever it is.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** India's calendar date now, 'YYYY-MM-DD'. */
function istToday(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** SQL: India's date now (a `date`). */
const IST_TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

/** SQL: the India date of a `timestamp without time zone` column. */
const istDateSql = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'Asia/Kolkata')::date`;

module.exports = { istToday, IST_TODAY_SQL, istDateSql, IST_OFFSET_MS };
