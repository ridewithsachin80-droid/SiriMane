// backend/test/fakeclock.js — Sprint 18 test helper (not loaded by the app).
// Shifts Date by FAKE_SHIFT_MS so the gate can run at chosen hours, e.g. 01:00
// IST on the 1st:  NODE_OPTIONS="--require ./backend/test/fakeclock.js" FAKE_SHIFT_MS=...
// The browser suites install the same shift in every page (pageClock below).
const off = Number(process.env.FAKE_SHIFT_MS || 0);
function install(target, ms) {
  const RD = target.Date;
  function FD(...a) {
    if (!(this instanceof FD)) return new RD(RD.now() + ms).toString();
    return a.length ? new RD(...a) : new RD(RD.now() + ms);
  }
  FD.prototype = RD.prototype; FD.now = () => RD.now() + ms; FD.UTC = RD.UTC; FD.parse = RD.parse;
  target.Date = FD;
}
if (off) install(global, off);
// For page.evaluateOnNewDocument: the same function body, run in the page.
module.exports.pageClock = `(${install.toString()})(window, ${off});`;
module.exports.active = !!off;
