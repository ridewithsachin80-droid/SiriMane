// frontend/public/js/speech-parser.js
// On-device parsing of what the warden says, so the common case never needs an
// LLM call at all. Loaded by management.html (window.SMParse) and by the
// backend tests (require). No dependencies.
//
//   SMParse.parseCollection("Priya room 12 six thousand UPI", residents)
//     → { guest, amount: 6000, mode: 'UPI', type: 'rent', leftover: '' }
//   SMParse.parseComplaint("water leaking in bathroom room 5")
//     → { category: 'Water', description: 'water leaking in bathroom room 5', room: '5' }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMParse = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ── Numbers: English words, Indian units, Kannada & Hindi transliterations ─
  const UNITS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    // Kannada (as Google speech transliterates it)
    ondu: 1, eradu: 2, mooru: 3, muru: 3, naalku: 4, nalku: 4, aidu: 5, aaru: 6, aru: 6,
    elu: 7, yelu: 7, entu: 8, ombattu: 9, hattu: 10, ippattu: 20, moovattu: 30, nalavattu: 40,
    aivattu: 50, aravattu: 60, eppattu: 70, embattu: 80, tombattu: 90,
    // Hindi
    ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7,
    aath: 8, nau: 9, das: 10, bees: 20, tees: 30, chalis: 40, pachas: 50, saath: 60, sattar: 70,
    assi: 80, nabbe: 90
  };
  const MULTIPLIERS = {
    hundred: 100, hundreds: 100, nooru: 100, sau: 100,
    thousand: 1000, thousands: 1000, saavira: 1000, savira: 1000, sasira: 1000, hazaar: 1000, hazar: 1000, hajar: 1000,
    lakh: 100000, lakhs: 100000, laksha: 100000
  };
  const HALF = { half: 0.5, ardha: 0.5, aadha: 0.5 };

  // Returns { amount, consumed:[start,end] } for the first amount in the text, or null.
  function extractAmount(text) {
    const lower = ' ' + text.toLowerCase().replace(/[,]/g, '') + ' ';
    // 1) Plain digits, possibly followed by a unit word: "6000", "6 thousand", "2.5 lakh", "1.5k"
    let m = lower.match(/\s(\d+(?:\.\d+)?)\s*(k\b|thousand|saavira|savira|hazaar|hazar|hajar|lakh|lakhs|laksha|hundred|nooru|sau)?\b/);
    if (m) {
      let n = parseFloat(m[1]);
      const unit = m[2] ? m[2].trim() : '';
      if (unit === 'k') n *= 1000;
      else if (unit) n *= MULTIPLIERS[unit];
      return { amount: Math.round(n), matched: m[0].trim() };
    }
    // 2) Number words: "six thousand", "aaru saavira", "chhe hazaar", "five hundred", "one and a half thousand"
    const words = lower.trim().split(/\s+/);
    let total = 0, current = 0, matchedWords = [], seenAny = false, pendingHalf = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-z.]/g, '');
      if (w in UNITS) { current += UNITS[w]; matchedWords.push(words[i]); seenAny = true; continue; }
      if (w in HALF) { pendingHalf = true; matchedWords.push(words[i]); continue; }
      if (w === 'and' || w === 'a') { if (seenAny) matchedWords.push(words[i]); continue; }
      if (w in MULTIPLIERS) {
        if (!seenAny && !pendingHalf) current = 1;
        if (pendingHalf) { current = (current || 0) + 0.5; pendingHalf = false; }
        current = current * MULTIPLIERS[w];
        total += current; current = 0; matchedWords.push(words[i]); seenAny = true;
        continue;
      }
      if (seenAny) break; // number phrase ended
      matchedWords = [];
    }
    total += current;
    if (!seenAny || total <= 0) return null;
    return { amount: Math.round(total), matched: matchedWords.join(' ') };
  }

  // ── Payment mode ────────────────────────────────────────────────────────
  const MODE_SYNONYMS = {
    'UPI': ['upi', 'gpay', 'g pay', 'google pay', 'phonepe', 'phone pe', 'paytm', 'online', 'scan'],
    'Bank Transfer': ['bank transfer', 'bank', 'neft', 'imps', 'rtgs', 'transfer', 'net banking', 'account'],
    'Cash': ['cash', 'hand', 'nagadu', 'nagad', 'note']
  };
  function extractMode(text) {
    const lower = ' ' + text.toLowerCase() + ' ';
    for (const mode of Object.keys(MODE_SYNONYMS)) {
      for (const syn of MODE_SYNONYMS[mode]) {
        if (lower.includes(' ' + syn + ' ')) return { mode, matched: syn };
      }
    }
    return null;
  }

  // ── Collection type ─────────────────────────────────────────────────────
  function extractType(text) {
    const lower = ' ' + text.toLowerCase() + ' ';
    if (/\b(deposit|thevani|jamanath|security)\b/.test(lower)) return 'deposit';
    if (/\b(advance|mungada|advance)\b/.test(lower)) return 'advance';
    return 'rent';
  }

  // ── Room number ─────────────────────────────────────────────────────────
  function extractRoom(text) {
    const m = text.match(/\b(?:room|rum|kone|kamra)\s*(?:no\.?|number)?\s*([a-z]?\d{1,3}[a-z]?)\b/i);
    return m ? { room: m[1].toUpperCase(), matched: m[0] } : null;
  }

  // ── Resident matching ───────────────────────────────────────────────────
  // residents: [{ id, name, room_number }]. Prefers the room if one was said,
  // then a full-name token match, then a leading-token (first name) match.
  function matchResident(text, residents, room) {
    if (!residents || !residents.length) return null;
    const tokens = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    const inRoom = room ? residents.filter(r => String(r.room_number || '').toUpperCase() === room.toUpperCase()) : [];
    if (inRoom.length === 1) return inRoom[0];
    const pool = inRoom.length > 1 ? inRoom : residents;
    let best = null, bestScore = 0;
    for (const r of pool) {
      const nameTokens = String(r.name || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!nameTokens.length) continue;
      let score = 0;
      for (const nt of nameTokens) {
        if (tokens.includes(nt)) score += 2;
        else if (nt.length >= 4 && tokens.some(t => t.length >= 4 && (nt.startsWith(t) || t.startsWith(nt)))) score += 1;
      }
      if (score > bestScore) { best = r; bestScore = score; }
    }
    if (bestScore === 0) return null;
    // Ambiguity guard: another resident with the same score means we can't be sure.
    const ties = pool.filter(r => r !== best && scoreOf(r, tokens) === bestScore);
    if (ties.length) return null;
    return best;
  }
  function scoreOf(r, tokens) {
    let score = 0;
    for (const nt of String(r.name || '').toLowerCase().split(/\s+/).filter(Boolean)) {
      if (tokens.includes(nt)) score += 2;
      else if (nt.length >= 4 && tokens.some(t => t.length >= 4 && (nt.startsWith(t) || t.startsWith(nt)))) score += 1;
    }
    return score;
  }

  function parseCollection(text, residents) {
    const raw = String(text || '').trim();
    if (!raw) return { guest: null, amount: null, mode: null, type: 'rent', room: null, leftover: '' };
    const room = extractRoom(raw);
    // Strip the room phrase first so "room 12" can never be read as ₹12.
    const withoutRoom = room ? raw.replace(room.matched, ' ') : raw;
    const amt = extractAmount(withoutRoom);
    const mode = extractMode(raw);
    const type = extractType(raw);
    const guest = matchResident(raw, residents, room && room.room);
    let leftover = raw;
    [room && room.matched, amt && amt.matched, mode && mode.matched].forEach(m => { if (m) leftover = leftover.replace(new RegExp(escape(m), 'i'), ' '); });
    if (guest) leftover = leftover.replace(new RegExp(escape(guest.name), 'i'), ' ');
    leftover = leftover.replace(/\b(rupees|rupaye|rupai|rs|paid|gave|collected|from|for|rent|deposit|advance|the|of|by|via|in|using)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { guest, amount: amt ? amt.amount : null, mode: mode ? mode.mode : null, type, room: room ? room.room : null, leftover };
  }

  // ── Complaints ──────────────────────────────────────────────────────────
  const COMPLAINT_CATEGORIES = {
    'Water': ['water', 'tap', 'geyser', 'heater', 'leak', 'leaking', 'bathroom', 'toilet', 'flush', 'drain', 'neeru', 'paani'],
    'Electrical': ['light', 'fan', 'switch', 'socket', 'power', 'electric', 'current', 'bulb', 'tube', 'charging', 'plug', 'wire'],
    'Wifi/Internet': ['wifi', 'wi-fi', 'internet', 'network', 'signal', 'router', 'net'],
    'Cleanliness': ['clean', 'dirty', 'garbage', 'dust', 'smell', 'stink', 'cockroach', 'insects', 'mosquito', 'mosquitoes', 'sweep', 'mop'],
    'Food': ['food', 'breakfast', 'lunch', 'dinner', 'meal', 'menu', 'rice', 'chapati', 'sambar', 'oota', 'khana'],
    'Furniture': ['bed', 'cot', 'mattress', 'cupboard', 'almirah', 'table', 'chair', 'door', 'lock', 'window', 'curtain', 'shelf'],
    'Security': ['security', 'safety', 'stranger', 'gate', 'cctv', 'theft', 'stolen', 'missing'],
    'Noise': ['noise', 'loud', 'shouting', 'music', 'disturb']
  };
  function parseComplaint(text) {
    const raw = String(text || '').trim();
    const lower = ' ' + raw.toLowerCase() + ' ';
    let category = 'Other', bestHits = 0;
    for (const cat of Object.keys(COMPLAINT_CATEGORIES)) {
      const hits = COMPLAINT_CATEGORIES[cat].filter(k => lower.includes(' ' + k)).length;
      if (hits > bestHits) { bestHits = hits; category = cat; }
    }
    const room = extractRoom(raw);
    return { category, description: raw, room: room ? room.room : null };
  }

  function escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  return { parseCollection, parseComplaint, extractAmount, extractMode, extractRoom, matchResident, COMPLAINT_CATEGORIES, MODE_SYNONYMS };
}));
