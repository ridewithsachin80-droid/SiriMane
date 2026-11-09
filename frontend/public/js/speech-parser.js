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

  // ── Kannada script → the Latin spellings the rest of this file knows (S21) ─
  // With the mic set to ಕನ್ನಡ, Chrome writes "ಈರುಳ್ಳಿ 100 ರೂಪಾಯಿ". Everything
  // downstream (amounts, names, the item dictionary) reads a–z, so the script
  // is spelt out the way people type Kannada on WhatsApp: ಈರುಳ್ಳಿ → eerulli,
  // ಜಾನವಿ → jaanavi, ನೂರು → nooru. Text with no Kannada letters is returned
  // exactly as given, so typed English is never touched.
  const KN_VOWELS = { 'ಅ': 'a', 'ಆ': 'aa', 'ಇ': 'i', 'ಈ': 'ee', 'ಉ': 'u', 'ಊ': 'oo', 'ಋ': 'ru', 'ೠ': 'ru', 'ಎ': 'e', 'ಏ': 'e', 'ಐ': 'ai', 'ಒ': 'o', 'ಓ': 'o', 'ಔ': 'au' };
  const KN_SIGNS = { 'ಾ': 'aa', 'ಿ': 'i', 'ೀ': 'ee', 'ು': 'u', 'ೂ': 'oo', 'ೃ': 'ru', 'ೄ': 'ru', 'ೆ': 'e', 'ೇ': 'e', 'ೈ': 'ai', 'ೊ': 'o', 'ೋ': 'o', 'ೌ': 'au' };
  const KN_CONS = {
    'ಕ': 'k', 'ಖ': 'kh', 'ಗ': 'g', 'ಘ': 'gh', 'ಙ': 'n', 'ಚ': 'ch', 'ಛ': 'chh', 'ಜ': 'j', 'ಝ': 'jh', 'ಞ': 'n',
    'ಟ': 't', 'ಠ': 'th', 'ಡ': 'd', 'ಢ': 'dh', 'ಣ': 'n', 'ತ': 't', 'ಥ': 'th', 'ದ': 'd', 'ಧ': 'dh', 'ನ': 'n',
    'ಪ': 'p', 'ಫ': 'ph', 'ಬ': 'b', 'ಭ': 'bh', 'ಮ': 'm', 'ಯ': 'y', 'ರ': 'r', 'ಱ': 'r', 'ಲ': 'l', 'ವ': 'v',
    'ಶ': 'sh', 'ಷ': 'sh', 'ಸ': 's', 'ಹ': 'h', 'ಳ': 'l', 'ೞ': 'l'
  };
  const VIRAMA = '್', NUKTA = '಼', ANUSVARA = 'ಂ', VISARGA = 'ಃ';
  const HAS_KN = /[ಀ-೿]/;
  // English words Chrome writes in Kannada letters, and Kannada words that
  // need one fixed spelling. Applied to transliterated text only.
  const KN_LOAN = [
    [/\bgoo?gal\s*pe\b/g, 'google pay'], [/\bphon\s*pe\b/g, 'phonepe'], [/\bpetiem\b/g, 'paytm'],
    [/\byu\s*pi\s*ai\b|\byupiai\b|\byupiyai\b|\byupi\b/g, 'upi'], [/\bkyaash\b|\bkyash\b|\bkyaas\b/g, 'cash'], [/\bbyaank\b|\bbyank\b/g, 'bank'],
    [/\b(roopaayi|rupaayi|roopaay|rupaay|roopayi|rupayi)\b/g, 'rupees'], [/\bnambar\b/g, 'number'], [/\bkothadi\b|\bkotadi\b/g, 'room'],
    [/\bdepaasit\b|\bdipaasit\b/g, 'deposit'], [/\badvaans\b|\badvaansu\b/g, 'advance'], [/\brent\b|\brentu\b/g, 'rent'],
    [/\blaitu?\b/g, 'light'], [/\bphyaanu?\b|\bphaanu?\b/g, 'fan'], [/\bvaiphai\b|\bvaipai\b/g, 'wifi'], [/\bkarentu?\b/g, 'current'],
    [/\bgeesar\b|\bgijar\b|\bgeejar\b/g, 'geyser'], [/\btyaapu?\b/g, 'tap'], [/\bpaipu?\b/g, 'pipe'], [/\bbalbu?\b/g, 'bulb'], [/\bsvichu?\b/g, 'switch'],
    [/\btaayilet\b|\btaaylet\b|\btaayletu\b/g, 'toilet'], [/\bbaat\s*room\b|\bbaatroom\b/g, 'bathroom'], [/\bbred\b|\bbredu\b/g, 'bread'],
    [/\bgyaasu?\b/g, 'gas'], [/\bsilindar\b|\bsilindaru\b/g, 'cylinder'], [/\bphinaayil\b|\bphinaail\b/g, 'phenyl'], [/\bbaket\b|\bbakettu\b/g, 'bucket'],
    [/\bplambar\b|\bplambaru\b/g, 'plumber'], [/\belektrishiyan\b|\belektrishan\b/g, 'electrician'], [/\bkyaan\b/g, 'can'], [/\bke\.?\s?ji\b/g, 'kg'], [/\bpyaaket\b|\bpaaket\b/g, 'packet'], [/\bleetar\b|\blitar\b/g, 'litre'], [/\bdajan\b/g, 'dozen'], [/\broo\.?(?=\s|$)/g, 'rupees'], [/\bbil\b|\bbillu\b/g, 'bill'],
    [/\baaniyan\b|\baaniyanu\b/g, 'onion'], [/\btomyaato\b|\btometo\b|\btomeeto\b|\btomaato\b|\btomyaatoo\b/g, 'tomato'], [/\bpoteto\b|\bpoteeto\b/g, 'potato'],
    [/\bditarjent\b|\bditarjentu\b/g, 'detergent'], [/\bsopu\b/g, 'soap'], [/\bkaaphi\b|\bkaapi\b/g, 'coffee'], [/\btee\b/g, 'tea'], [/\bmilk\b/g, 'milk']
  ];
  function toLatin(text) {
    const s0 = String(text == null ? '' : text);
    if (!HAS_KN.test(s0)) return s0;
    // Review S21: only Kannada words are spelt out (and lower-cased); English
    // words typed in the same message keep her capitals. NFC first, in case the
    // text arrives decomposed.
    let lat = s0.normalize('NFC').replace(/[\u200C\u200D]/g, '').split(/(\s+)/).map(tok => HAS_KN.test(tok) ? knWord(tok) : tok).join('');
    for (const [re, to] of KN_LOAN) lat = lat.replace(re, to);
    return lat.replace(/\s+/g, ' ').trim();
  }
  function knWord(tok) {
    const ch = Array.from(tok);
    let out = '';
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (c >= '೦' && c <= '೯') { out += String(c.charCodeAt(0) - 0x0CE6); continue; }
      if (KN_VOWELS[c]) { out += KN_VOWELS[c]; continue; }
      if (KN_CONS[c]) {
        let base = KN_CONS[c];
        let j = i + 1;
        if (ch[j] === NUKTA) { base = base === 'ph' ? 'f' : base === 'j' ? 'z' : base; j++; }
        const next = ch[j];
        if (next === VIRAMA) { out += base; i = j; continue; }
        if (KN_SIGNS[next]) { out += base + KN_SIGNS[next]; i = j; continue; }
        out += base + 'a'; i = j - 1; continue;
      }
      if (c === ANUSVARA) {
        // ಸಂಬಳ → sambala, ತೊಂಬತ್ತು → tombattu; ಎಂಟು → entu; at a word's end → m.
        const nx = ch[i + 1];
        out += (!nx || !KN_CONS[nx]) ? 'm' : /^(p|ph|b|bh|m)$/.test(KN_CONS[nx]) ? 'm' : 'n';
        continue;
      }
      if (c === VISARGA) { out += 'h'; continue; }
      if (c === VIRAMA || c === NUKTA || KN_SIGNS[c] || c === '\u0CD5' || c === '\u0CD6') continue;   // stray or length mark
      out += c;
    }
    return out.toLowerCase();
  }

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
    // S21: as spelt out from Kannada script (ಎರಡು → eradu, ಏಳು → elu …),
    // teens, and the hundreds that Kannada says as one word (ಐನೂರು = 500).
    naalku: 4, onbattu: 9, ombattu: 9, moovattu: 30, muvattu: 30, nalavattu: 40, tombhattu: 90,
    hannondu: 11, hanneradu: 12, hadimooru: 13, hadinaalku: 14, hadinaidu: 15, hadinaaru: 16, hadinelu: 17, hadinentu: 18, hattombattu: 19,
    innooru: 200, innuru: 200, munnooru: 300, munnuru: 300, naanooru: 400, nanuru: 400, ainooru: 500, ainuru: 500,
    aarunooru: 600, aaraanooru: 600, elunooru: 700, entunooru: 800, ombainooru: 900, onbainooru: 900,
    // Hindi
    ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7,
    aath: 8, nau: 9, das: 10, bees: 20, tees: 30, chalis: 40, pachas: 50, saath: 60, sattar: 70,
    assi: 80, nabbe: 90
  };
  const MULTIPLIERS = {
    hundred: 100, hundreds: 100, nooru: 100, noora: 100, sau: 100,
    thousand: 1000, thousands: 1000, saavira: 1000, savira: 1000, sasira: 1000, hazaar: 1000, hazar: 1000, hajar: 1000,
    saavirada: 1000, saviradha: 1000, savirada: 1000,
    lakh: 100000, lakhs: 100000, laksha: 100000
  };
  const HALF = { half: 0.5, ardha: 0.5, aadha: 0.5 };

  // ── Review S21 (B1, S4, S6): Kannada numbers as people say them ─────────
  // ಐದೂವರೆ (aidoovare) = 5½ · ಇಪ್ಪತ್ತೈದು (ippattaidu) = 25 · ನೂರೈವತ್ತು
  // (nooraivattu) = 150 · ಇನ್ನೂರ ಐವತ್ತು (innoora aivattu) = 250 · ಆರ್ ಸಾವಿರ
  // (aar saavira) = 6000 · ಐದು ಕೆಜಿ ಅಕ್ಕಿ ಐನೂರು: the 5 is kilos, the price is 500.
  const ONES = { ondu: 1, eradu: 2, mooru: 3, naalku: 4, nalku: 4, aidu: 5, aaru: 6, elu: 7, entu: 8, ombattu: 9, onbattu: 9 };
  const TENS = { ippatt: 20, moovatt: 30, muvatt: 30, nalavatt: 40, aivatt: 50, aravatt: 60, eppatt: 70, embatt: 80, tombatt: 90 };
  const HUNDREDS = { ombainoor: 900, onbainoor: 900, entunoor: 800, elunoor: 700, elnoor: 700, aarunoor: 600, aaranoor: 600, aaraanoor: 600, ainoor: 500, naanoor: 400, munnoor: 300, innoor: 200, noor: 100 };
  const HUNDRED_KEYS = Object.keys(HUNDREDS).sort((a, b) => b.length - a.length);
  // A spoken unit word right after a number makes it a quantity, not rupees.
  const QTY = /^(kg|kgs|kilo|kilos|kilogram|kilograms|keji|g|gm|gms|gram|grams|graam|l|ltr|ltrs|litre|litres|liter|liters|leetar|ml|packet|packets|pkt|pkts|pyaaket|paaket|pocket|pockets|dozen|dajan|doz|box|boxes|bag|bags|chiil|pcs|pc|piece|pieces|bottle|bottles|tin|tins|bundle|bundles|kattu|meter|metre|meters|metres|mitar)$/;
  function tensOnes(w) {
    if (w in UNITS) return UNITS[w];
    for (const t of Object.keys(TENS)) {
      // ippatt+aidu → ippattaidu; ippat+mooru → ippatmooru (the double t drops before a consonant)
      for (const stem of [t, t.slice(0, -1)]) {
        if (!w.startsWith(stem)) continue;
        const rest = w.slice(stem.length);
        if (rest === '' || rest === 'u') return TENS[t];
        if (rest in ONES) return TENS[t] + ONES[rest];
        if (('u' + rest) in ONES) continue;
      }
    }
    return null;
  }
  function numberWord(w) {
    if (!w) return null;
    let v = tensOnes(w);
    if (v != null) return v;
    // ನೂರೈವತ್ತು (nooraivattu), ಐನೂರೈವತ್ತು, ನೂರ (noora) as a joining form
    for (const h of HUNDRED_KEYS) {
      if (!w.startsWith(h)) continue;
      const rest = w.slice(h.length);
      if (rest === '' || rest === 'u' || rest === 'a') { if (h === 'noor') return null; return HUNDREDS[h]; }   // bare ನೂರು is the ×100 multiplier ("aidu nooru" = 500)
      const r = tensOnes(rest) != null ? tensOnes(rest) : tensOnes(rest.replace(/^[au]/, ''));
      if (r != null && r < 100) return HUNDREDS[h] + r;
    }
    // ಐದೂವರೆ (aidoovare), ಒಂದೂವರೆ, aiduvare → n½
    const half = w.match(/^(.+?)(oo|u|o)vare$/);
    if (half) { const b = tensOnes(half[1] + 'u'); if (b != null) return b + 0.5; }
    return null;
  }
  // Short spoken forms — ಆರ್ ಸಾವಿರ (aar saavira) — only count right before a multiplier.
  function shortForm(w) { return w.length >= 3 && (w + 'u') in ONES ? ONES[w + 'u'] : null; }
  // Words that may stand before a bare "thousand" without making it a guess.
  // (ನೂರು alone is a plain 100 — "haalu nooru" — so only ಸಾವಿರ is strict.)
  const KN_MULT = new Set(['saavira', 'savira', 'sasira', 'saavirada', 'savirada', 'saviradha']);
  const ONE_OK = new Set(['a', 'an', 'and', 'one', 'ek', 'ondu', 'rs', 'rs.', 'rupees', 'rupee', 'inr']);

  // Returns { amount, matched } for the first amount in the text that is not
  // a quantity ("5 kg"), or null. A multiplier after a word we cannot read
  // ("ಐದ್ಓವರೆ ಸಾವಿರ" misheard) gives null — ask her, never guess ₹1,000.
  function extractAmount(text) {
    const lower = ' ' + text.toLowerCase().replace(/[,]/g, '') + ' ';
    // 1) Plain digits, possibly followed by a unit word: "6000", "6 thousand", "2.5 lakh", "1.5k"
    const re = /\s(\d+(?:\.\d+)?)\s*(k\b|thousand|saavira|savira|hazaar|hazar|hajar|lakh|lakhs|laksha|hundred|nooru|sau)?(?=\s|[^a-z0-9.]|$)/g;
    let m;
    while ((m = re.exec(lower))) {
      const after = lower.slice(m.index + m[0].length).trim().split(/\s+/)[0] || '';
      const glued = (lower.slice(m.index + 1).match(/^\d+(?:\.\d+)?([a-z]+)/) || [])[1] || '';
      if (!m[2] && (QTY.test(after.replace(/[^a-z]/g, '')) || QTY.test(glued))) continue;   // "5 kg", "5kg"
      let n = parseFloat(m[1]);
      const unit = m[2] ? m[2].trim() : '';
      if (unit === 'k') n *= 1000;
      else if (unit) n *= MULTIPLIERS[unit];
      return { amount: Math.round(n), matched: m[0].trim() };
    }
    // 2) Number words: "six thousand", "aaru saavira", "chhe hazaar", "five hundred", "one and a half thousand"
    const words = lower.trim().split(/\s+/);
    let total = 0, current = 0, matchedWords = [], seenAny = false, pendingHalf = false;
    const reset = () => { total = 0; current = 0; matchedWords = []; seenAny = false; pendingHalf = false; };
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-z.]/g, '');
      const nextW = (words[i + 1] || '').replace(/[^a-z.]/g, '');
      const nv = numberWord(w);
      if (nv != null) { current += nv; matchedWords.push(words[i]); seenAny = true; continue; }
      if (!seenAny && shortForm(w) != null && nextW in MULTIPLIERS) { current += shortForm(w); matchedWords.push(words[i]); seenAny = true; continue; }
      if (w in HALF) { pendingHalf = true; matchedWords.push(words[i]); continue; }
      if (w === 'and' || w === 'a') { if (seenAny) matchedWords.push(words[i]); continue; }
      if (w in MULTIPLIERS) {
        if (!seenAny && !pendingHalf) {
          const prev = (words[i - 1] || '').replace(/[^a-z.]/g, '');
          // B1: a Kannada ಸಾವಿರ/ನೂರು after a word we could not read ("ಐದೂವ್ರೆ ಸಾವಿರ") is a
          // number we missed — no amount, so she is asked. English "onion hundred" stays ₹100.
          if (KN_MULT.has(w) && prev && !ONE_OK.has(prev) && /[a-z]/.test(prev)) return null;
          current = 1;
        }
        if (pendingHalf) { current = (current || 0) + 0.5; pendingHalf = false; }
        current = current * MULTIPLIERS[w];
        total += current; current = 0; matchedWords.push(words[i]); seenAny = true;
        continue;
      }
      if (seenAny) {
        if (QTY.test(w)) { reset(); continue; }   // "aidu keji" — that was kilos; keep looking for the price
        break; // number phrase ended
      }
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
    const raw = toLatin(String(text || '').trim());
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
    'Water': ['water', 'tap', 'geyser', 'heater', 'leak', 'leaking', 'bathroom', 'toilet', 'flush', 'drain', 'neeru', 'niru', 'paani', 'nalli', 'bisi', 'sorut'],
    'Electrical': ['light', 'fan', 'switch', 'socket', 'power', 'electric', 'current', 'bulb', 'tube', 'charging', 'plug', 'wire', 'karent', 'deepa'],
    'Wifi/Internet': ['wifi', 'wi-fi', 'internet', 'network', 'signal', 'router', 'net'],
    'Cleanliness': ['clean', 'dirty', 'garbage', 'dust', 'smell', 'stink', 'cockroach', 'insects', 'mosquito', 'mosquitoes', 'sweep', 'mop', 'kasa', 'galeej', 'vaasane', 'vasane', 'jirale', 'solle', 'gaba'],
    'Food': ['food', 'breakfast', 'lunch', 'dinner', 'meal', 'menu', 'rice', 'chapati', 'sambar', 'oota', 'khana', 'tindi', 'thindi', 'anna', 'saaru', 'palya'],
    'Furniture': ['bed', 'cot', 'mattress', 'cupboard', 'almirah', 'table', 'chair', 'door', 'lock', 'window', 'curtain', 'shelf', 'mancha', 'bagilu', 'kitaki', 'beega', 'kurchi', 'meju'],
    'Security': ['security', 'safety', 'stranger', 'gate', 'cctv', 'theft', 'stolen', 'missing', 'kalla', 'kaanutilla'],
    'Noise': ['noise', 'loud', 'shouting', 'music', 'disturb', 'galate', 'shabda']
  };
  function parseComplaint(text) {
    const raw = String(text || '').trim();
    // The description stays exactly as she said it (Kannada script reads fine
    // to staff); only the matching uses the spelt-out form.
    const lat = toLatin(raw);
    const lower = ' ' + lat.toLowerCase() + ' ';
    let category = 'Other', bestHits = 0;
    for (const cat of Object.keys(COMPLAINT_CATEGORIES)) {
      const hits = COMPLAINT_CATEGORIES[cat].filter(k => lower.includes(' ' + k)).length;
      if (hits > bestHits) { bestHits = hits; category = cat; }
    }
    const room = extractRoom(lat);
    return { category, description: raw, room: room ? room.room : null };
  }

  function escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  return { parseCollection, parseComplaint, extractAmount, extractMode, extractRoom, matchResident, toLatin, COMPLAINT_CATEGORIES, MODE_SYNONYMS };
}));
