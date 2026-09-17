// backend/services/quick.js — Sprint 14: Quick Entry
//
// Turns a bare phrase into a tool call with NO verb required:
//   "onion 100rs"            → prepare_expense  (Groceries)
//   "jhanavi 500"            → prepare_payment  (then asks the mode)
//   "jhanavi paid rs5000 upi"→ prepare_payment
//   "tap leaking room 106"   → prepare_complaint
//   "300"                    → asks "for what?"
//
// Rules, in order — a resident's name is the strongest signal:
//   1. Questions are not entries (who / what / which / how / ? …) → null, so
//      the existing Copilot handles them.
//   2. A resident's name in the text → a collection for her.
//   3. Fault words and no amount → a request.
//   4. An amount → an expense; the category comes from (a) this PG's own past
//      purchases, (b) a dictionary of Indian household items, (c) the model —
//      which sees ONLY the item words, never a name or a rupee figure.
//
// Everything here is deterministic and runs with no API keys. The model is a
// tie-breaker for categories, nothing else. Nothing is saved from here: the
// result is a prepare-level tool call, so the preview → confirm → execute path
// in copilot.js / tools.js is unchanged and every entry lands in ai_actions.
const pool = require('../db');
const SMParse = require('../../frontend/public/js/speech-parser.js');
const ai = require('../routes/ai');

const CATEGORIES = ['Groceries', 'Maintenance', 'Electricity', 'Water', 'Internet', 'Cleaning', 'Salary', 'Building Rent', 'Furniture', 'Repairs', 'Other'];

// ── Dictionary: what a PG in Karnataka actually buys ──────────────────────
const DICT = {
  Groceries: 'onion onions tomato tomatoes potato potatoes rice dal dhal toor moong urad chana rajma wheat atta maida rava sooji semolina sugar jaggery salt oil sunflower groundnut coconut ghee butter milk curd paneer eggs egg bread biscuit biscuits tea coffee chai spices masala chilli chili turmeric haldi coriander dhania jeera cumin mustard tamarind vegetables vegetable veg veggies fruits fruit banana apple mango grapes lemon ginger garlic sambar rasam idli dosa batter noodles maggi pasta poha upma vermicelli sevai ragi jowar bajra millets groceries grocery kirana provisions ration gas cylinder lpg refill water can bisleri sabzi tarkari terkari eerulli tomoto eeruli beans carrot beetroot cabbage cauliflower gobi brinjal capsicum drumstick pumpkin cucumber spinach palak methi greens soppu curry leaves mint pudina chicken mutton fish meat non-veg nonveg snacks chips namkeen mixture sweets pickle papad'.split(/\s+/),
  Cleaning: 'phenyl phenyle harpic lizol detergent surf ariel rin soap dettol broom mop bucket dustbin garbage bags brush toilet cleaner floor cleaner scrubber scrub sponge vim dishwash liquid tissue napkin sanitizer sanitiser handwash naphthalene odonil room freshener cleaning cleaner sweeper sweeping'.split(/\s+/),
  Electricity: 'bescom electricity current bill power bill electric bill eb bill units meter'.split(/\s+/),
  Water: 'bwssb water bill tanker water tanker borewell motor water supply tank cleaning'.split(/\s+/),
  Internet: 'wifi wi-fi internet broadband act jio airtel bsnl fibre fiber router recharge dth cable tv'.split(/\s+/),
  Repairs: 'plumber plumbing tap taps pipe pipes leak leakage geyser heater electrician wiring switch socket bulb bulbs tube tubelight light fan fans repair repairs fix fixed fixing motor pump welding carpenter painter painting paint cement sand bricks tiles door lock locks hinge glass window mesh ac servicing service servicing fridge washing machine ro filter'.split(/\s+/),
  Maintenance: 'maintenance amc pest control termite lift generator diesel garden gardener security guard cctv camera fire extinguisher'.split(/\s+/),
  Furniture: 'cot cots bed beds mattress mattresses pillow pillows bedsheet bedsheets blanket blankets curtain curtains table chair chairs almirah cupboard wardrobe shelf rack bucket mug stool furniture'.split(/\s+/),
  Salary: 'salary wages wage staff pay cook maid watchman advance to staff'.split(/\s+/),
  'Building Rent': 'building rent owner rent lease'.split(/\s+/)
};
const DICT_INDEX = new Map();
for (const [cat, words] of Object.entries(DICT)) for (const w of words) if (!DICT_INDEX.has(w)) DICT_INDEX.set(w, cat);

const FAULT_WORDS = /\b(leak\w*|not working|not workin|notworking|broken|broke|damaged|jammed|stuck|no water|no power|no current|no light|no wifi|no internet|blocked|clogged|overflow\w*|smell\w*|noise|noisy|repair needed|complaint|complain|problem|issue|fused|flicker\w*|sparking|dripping)\b/i;
const QUESTION = /^(who|what|which|how|when|where|why|is|are|do|does|did|can|could|should|show|list|find|tell|give|any|whats|what's)\b|\?\s*$/i;
const MODE_WORDS = /\b(upi|gpay|google pay|phonepe|phone pe|paytm|cash|nagadu|bank|neft|imps|transfer|card)\b/gi;
const NOISE = /\b(rs\.?|rupees?|rupaye|rupai|inr|paid|pay|payment|gave|give|given|got|received|collected|collect|for|of|to|the|a|an|and|today|yesterday|bought|brought|bougt|buy|purchased|purchsed|purchase|spent|expense|expenses|bill|by|via|from|on|in|at|rent|deposit|advance)\b/gi;

// "100rs", "rs100", "rs.100", "₹100", "100/-", "1k" → a number the parser sees.
function normaliseAmount(text) {
  return String(text || '')
    .replace(/₹\s*/g, ' ')
    .replace(/\b(rs\.?|inr|rupees?)\s*(\d)/gi, ' $2')
    .replace(/(\d)\s*(rs\.?|rupees?|inr|\/-)(?=\s|$|[^a-z])/gi, '$1 ')
    .replace(/(\d)(k)\b/gi, '$1 $2')
    .replace(/\s+/g, ' ').trim();
}

function tokens(text) { return String(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean); }

// ── History: what THIS PG has filed before ─────────────────────────────────
let histCache = { at: 0, map: new Map() };
async function historyIndex() {
  if (Date.now() - histCache.at < 5 * 60 * 1000) return histCache.map;
  const map = new Map();
  try {
    const { rows } = await pool.query(`SELECT LOWER(description) AS d, category, COUNT(*)::int AS n FROM purchases WHERE COALESCE(is_deleted,false)=false AND description IS NOT NULL AND description<>'' GROUP BY 1,2`);
    for (const r of rows) for (const t of tokens(r.d)) {
      if (t.length < 3 || NOISE.test(' ' + t + ' ')) continue;
      const e = map.get(t) || {}; e[r.category] = (e[r.category] || 0) + r.n; map.set(t, e);
    }
  } catch (e) { /* no purchases table yet, or a cold DB — the dictionary still works */ }
  histCache = { at: Date.now(), map };
  return map;
}
function invalidateHistory() { histCache.at = 0; }

// ── Category: history → dictionary → model ─────────────────────────────────
async function categorise(item, opts = {}) {
  const words = tokens(item).filter(w => w.length >= 2);
  if (!words.length) return { category: null, basis: 'no item words' };
  // (a) this PG's own past purchases outweigh everything
  const hist = await historyIndex();
  const votes = {};
  for (const w of words) { const e = hist.get(w); if (e) for (const [c, n] of Object.entries(e)) votes[c] = (votes[c] || 0) + n; }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return { category: ranked[0][0], basis: `you have filed "${words.find(w => hist.get(w))}" under ${ranked[0][0]} ${ranked[0][1]} time${ranked[0][1] === 1 ? '' : 's'}` };
  // (b) the dictionary
  for (const w of words) { const c = DICT_INDEX.get(w); if (c) return { category: c, basis: `"${w}" is usually ${c}` }; }
  for (const w of words) for (const [dw, c] of DICT_INDEX) if (dw.length >= 4 && w.length >= 4 && (dw.startsWith(w) || w.startsWith(dw))) return { category: c, basis: `"${w}" looks like ${dw} (${c})` };
  // (c) the model — item words only. Never a name, never a rupee figure.
  if (opts.allowModel !== false && (process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || ai.providers._stub)) {
    try {
      const system = `Classify a paying-guest hostel expense into exactly one category from this list: ${CATEGORIES.join(', ')}. Reply ONLY with JSON {"category": "<one of the list>"}.`;
      const user = `Item: ${words.join(' ')}`;
      const reply = process.env.GROQ_API_KEY || ai.providers._stub ? await ai.providers.groqText({ system, user, json: true }) : await ai.providers.geminiText({ prompt: system + '\n\n' + user });
      const parsed = typeof reply === 'string' ? JSON.parse(reply.replace(/```json|```/g, '').trim()) : reply;
      const c = CATEGORIES.find(x => x.toLowerCase() === String(parsed && parsed.category || '').toLowerCase());
      if (c) return { category: c, basis: 'suggested by the model from the item words', via: 'model' };
    } catch (e) { /* fall through */ }
  }
  return { category: null, basis: 'not recognised' };
}

// ── The classifier ─────────────────────────────────────────────────────────
// ── Voice repair (14.1) ────────────────────────────────────────────────────
// Chrome hears "union hundred rupees" for "onion 100" and "Janvi" for
// "Jhanavi". Typed text is what she meant and is never touched; a SPOKEN
// phrase that the deterministic pass could not place is sent to the model
// with Chrome's alternatives, the resident names and the category list —
// the same "search through AI" step FitLife does for food — and comes back
// as one clean phrase, which is then classified exactly like typed text.
// The model sees names and rooms (allowed), never a phone or an ID.
function modelReady() { return !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || ai.providers._stub); }
async function repairVoice(raw, alternatives, residents) {
  if (!modelReady()) return null;
  const alts = [raw, ...(alternatives || [])].map(a => String(a || '').trim()).filter(Boolean).filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 5);
  const roster = residents.map(r => `${r.name}${r.room_number ? ' (room ' + r.room_number + ')' : ''}`).join('; ');
  const system = `A paying-guest hostel warden in Karnataka spoke to her phone. Chrome's transcripts are listed best-first; they may contain mis-heard English, Kannada or Hindi words and spoken numbers. Decide what she most likely said and rewrite it as ONE short phrase in exactly one of these shapes:
- "<item> <amount> [upi|cash|bank]"  for something bought (item in plain English, e.g. onion, phenyl, plumber, bescom, wifi)
- "<resident name exactly as in the list> <amount> [upi|cash|bank] [deposit|advance]"  for money a resident paid
- "<fault> room <number>"  for a complaint
Residents: ${roster || '(none)'}
Expense categories, for context only: ${CATEGORIES.join(', ')}
Reply ONLY with JSON {"phrase": "<the phrase>", "confidence": "high"|"low"}. Never invent an amount that was not spoken.`;
  const user = `Transcripts:\n${alts.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
  try {
    const reply = process.env.GROQ_API_KEY || ai.providers._stub ? await ai.providers.groqText({ system, user, json: true }) : await ai.providers.geminiText({ prompt: system + '\n\n' + user });
    const parsed = typeof reply === 'string' ? JSON.parse(reply.replace(/```json|```/g, '').trim()) : reply;
    const phrase = String(parsed && parsed.phrase || '').trim().slice(0, 200);
    return phrase && phrase.toLowerCase() !== raw.toLowerCase() ? { phrase, confidence: parsed.confidence === 'high' ? 'high' : 'low' } : null;
  } catch (e) { return null; }
}
function weak(i) {
  if (!i) return true;
  if (i.kind === 'expense' && i.tool && (!i.args.category || i.args.category === 'Other')) return true;   // item nobody recognised
  if (i.kind === 'collection' && i.tool && !i.args.resident_id) return true;                                // name not resolved
  if (!i.tool && i.clarify) return true;                                                                    // e.g. only a number was heard
  return false;
}

// Typed: one deterministic pass, model only for an unknown category.
// Spoken: deterministic pass with NO model; if it is weak, repair the
// transcript once and classify the repaired phrase (model allowed there).
// A clearly-heard "onion 100" therefore never touches the model at all.
async function intent(text, user, context, opts = {}) {
  if (!opts.voice) return classify(text, user, context, { allowModel: true });
  const first = await classify(text, user, context, { allowModel: false });
  if (!weak(first)) return first;
  const { rows: residents } = await pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`);
  const fix = await repairVoice(String(text || '').trim(), opts.alternatives, residents);
  if (fix) {
    const second = await classify(fix.phrase, user, context, { allowModel: true });
    if (second) return { ...second, heard: String(text || '').trim(), understood: fix.phrase, repair_confidence: fix.confidence };
  }
  // No repair possible: give the item one chance at a model category, as typed text gets.
  return classify(text, user, context, { allowModel: true });
}

async function classify(text, user, context, copts = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 200) return null;
  if (QUESTION.test(raw)) return null;
  const norm = normaliseAmount(raw);
  // Read the room FIRST and take it out — "room 106" is not ₹106.
  const roomHit = SMParse.extractRoom(norm);
  const room = roomHit ? (typeof roomHit === 'string' ? roomHit : roomHit.room) : null;
  const sansRoom = roomHit && roomHit.matched ? norm.replace(roomHit.matched, ' ') : norm;
  const amt = SMParse.extractAmount(sansRoom);
  const amount = amt ? amt.amount : null;
  const modeHit = SMParse.extractMode(norm);
  const mode = modeHit ? modeHit.mode : null;

  // 2. A resident's name wins.
  const { rows: residents } = await pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true`);
  const nameText = norm.replace(MODE_WORDS, ' ');
  const match = SMParse.matchResident(nameText, residents, room);
  const type = /\bdeposit\b/i.test(norm) ? 'deposit' : /\badvance\b/i.test(norm) ? 'advance' : 'rent';
  if (match) {
    return { tool: 'prepare_payment', args: { resident_id: match.id, amount: amount || undefined, mode: mode || undefined, type }, via: 'quick', kind: 'collection' };
  }
  // Two residents called Jhanavi → this is still a collection; it must ask
  // "which one?", never fall through and become an expense named "jhanavi".
  const partial = residents.filter(r => nameScore(r, nameText) > 0);
  if (partial.length >= 2) {
    const said = tokens(nameText).find(t => partial.every(r => String(r.name).toLowerCase().split(/\s+/).some(nt => nt === t || (nt.length >= 4 && t.length >= 4 && (nt.startsWith(t) || t.startsWith(nt)))))) || tokens(nameText)[0];
    return { tool: 'prepare_payment', args: { name: said, amount: amount || undefined, mode: mode || undefined, type }, via: 'quick', kind: 'collection' };
  }

  // 3. Fault words and no money → a request.
  if (FAULT_WORDS.test(norm) && !amount) {
    return { tool: 'prepare_complaint', args: { description: raw, room: room || undefined }, via: 'quick', kind: 'request' };
  }

  // 3b. A name that is nearly a resident's ("janavi" → Jhanavi) → still a
  //     collection: hand the candidates to prepare_payment, which asks
  //     "Did you mean…?" with taps. Never an expense called "janavi".
  const near = fuzzyResidents(nameText, residents, await historyIndex());
  if (near.length) {
    const said = tokens(nameText).find(w => near.some(r => String(r.name).toLowerCase().split(/\s+/).some(p => similarity(w, p) >= 0.75 || phoneticKey(w) === phoneticKey(p)))) || tokens(nameText)[0];
    return { tool: 'prepare_payment', args: { name: said, amount: amount || undefined, mode: mode || undefined, type }, via: 'quick', kind: 'collection', fuzzy: near.map(r => ({ id: r.id, name: r.name, room_number: r.room_number, why: r.why })) };
  }

  // 4. Money without a name → an expense.
  if (amount) {
    const item = sansRoom.replace(amt.matched, ' ').replace(MODE_WORDS, ' ').replace(NOISE, ' ').replace(/\b(room|rum)\s*[a-z]?\d{1,3}[a-z]?\b/gi, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!item) {
      // Decision 2: never file a blind rupee figure.
      return { tool: null, clarify: `What was ₹${amount.toLocaleString('en-IN')} for? Say the item too — e.g. "onion ${amount}".`, retry_text: raw + ' ', via: 'quick', kind: 'expense' };
    }
    const vendor = await matchVendor(item);
    const { category, basis, via } = await categorise(vendor ? item.replace(new RegExp(vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ') : item, { allowModel: copts.allowModel !== false });
    return { tool: 'prepare_expense', args: { amount, category: category || 'Other', description: item, mode: mode || undefined, paid_to: vendor || undefined }, via: 'quick', kind: 'expense', category_basis: basis, category_via: via || (category ? 'local' : 'none') };
  }
  return null;
}

// ── Fuzzy resident matching (14.2) ──────────────────────────────────────────
// "janavi", "jhanvi", "jahnavi", "janvi" are all Jhanavi. Indian names have
// many spellings and Chrome invents more; a one-letter miss must SUGGEST the
// resident, not file a ₹5,000 expense called "janavi". Two signals:
//   1. a phonetic key that folds the usual variants (jh→j, bh→b, ee→i, v→w,
//      double letters, trailing a/aa/ah, y/i)
//   2. edit-distance similarity on the raw tokens
// A token that is a known expense item (dictionary or this PG's history) is
// never treated as a name — "rice 500" stays an expense even if Riya lives here.
function phoneticKey(w) {
  return String(w || '').toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/(jh|zh)/g, 'j').replace(/bh/g, 'b').replace(/dh/g, 'd').replace(/th/g, 't').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/ph/g, 'f').replace(/ch/g, 'c').replace(/sh/g, 's')
    .replace(/ee|ea/g, 'i').replace(/oo/g, 'u').replace(/w/g, 'v').replace(/y/g, 'i').replace(/z/g, 'j').replace(/ck|q/g, 'k').replace(/x/g, 'ks')
    .replace(/(.)\1+/g, '$1')
    .replace(/(a|ah|aa)$/,'').replace(/h(?=[^aeiou]|$)/g, '');
}
function editDistance(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function similarity(a, b) { a = String(a).toLowerCase(); b = String(b).toLowerCase(); const L = Math.max(a.length, b.length); return L ? 1 - editDistance(a, b) / L : 0; }

// Residents whose name is CLOSE to something in the text, best first.
// Returns [] when nothing is close enough — never a wild guess.
function fuzzyResidents(text, residents, hist) {
  const words = tokens(text).filter(w => w.length >= 3 && !NOISE.test(' ' + w + ' ') && !DICT_INDEX.has(w) && !(hist && hist.has(w)));
  const out = [];
  for (const r of residents) {
    const parts = String(r.name || '').toLowerCase().split(/\s+/).filter(p => p.length >= 3);
    let best = 0, via = '';
    for (const w of words) for (const p of parts) {
      const sim = similarity(w, p);
      const kw = phoneticKey(w), kp = phoneticKey(p);
      const ph = kw === kp && kp.length >= 3;
      // "janvi" ↔ "jhanavi": same consonants once the vowels go (jnv). Needs
      // three consonants so two-letter skeletons cannot collide.
      const sk = kp.replace(/[aeiou]/g, ''), skw = kw.replace(/[aeiou]/g, '');
      const skel = sk.length >= 3 && sk === skw && w.length >= 4;
      const score = ph ? Math.max(0.9, sim) : skel ? Math.max(0.8, sim) : sim;
      if (score > best) { best = score; via = ph ? `sounds like ${p}` : `${w} ≈ ${p}`; }
    }
    if (best >= 0.75) out.push({ ...r, score: Math.round(best * 100) / 100, why: via });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

function nameScore(r, text) {
  const ts = tokens(text);
  let score = 0;
  for (const nt of String(r.name || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (ts.includes(nt)) score += 2;
    else if (nt.length >= 4 && ts.some(t => t.length >= 4 && (nt.startsWith(t) || t.startsWith(nt)))) score += 1;
  }
  return score;
}

// A name that is not a resident but has been paid before → paid_to.
async function matchVendor(item) {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT paid_to FROM purchases WHERE paid_to IS NOT NULL AND paid_to<>'' LIMIT 500`);
    const its = tokens(item);
    for (const r of rows) { const vt = tokens(r.paid_to); if (vt.length && vt.every(w => its.includes(w))) return r.paid_to; }
  } catch (e) { /* ignore */ }
  return null;
}

module.exports = { intent, classify, repairVoice, fuzzyResidents, phoneticKey, similarity, categorise, normaliseAmount, historyIndex, invalidateHistory, CATEGORIES, DICT, FAULT_WORDS, QUESTION };
