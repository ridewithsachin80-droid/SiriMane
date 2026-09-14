// backend/routes/ai.js — Sprint 3
//
// The only place the app talks to an LLM. Rules enforced here, not in the UI:
//   • API keys never leave the server.
//   • Images are read from the request, sent to Gemini, and dropped. Nothing is
//     written to disk or the database, and nothing image-shaped is ever logged.
//   • The model only ever sees the minimum: for a bill, just the photo; for an
//     ID, just the photo; for a spoken phrase, the phrase plus resident names
//     and room numbers (never phone numbers, never ID numbers, never balances).
//   • The server proposes; the warden confirms. These routes never write to
//     collections/purchases/guests/complaints — the normal routes do that,
//     after the confirm tap, exactly as if she had typed it.
//
// Providers are plain fetch calls (no SDK dependency). Tests swap them via
// module.exports.providers.
const express = require('express');
const router = express.Router();
const pool = require('../db');
const auth = require('../middleware/auth');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // after the client's downscale a bill is ~150–400 kB
const AI_TIMEOUT_MS = 25000;

// Vision requests carry a base64 image, so this router gets its own body
// limit. The global 10 kb limit in server.js still applies to everything else.
router.use(express.json({ limit: '6mb' }));

function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

// ── Providers (swappable) ────────────────────────────────────────────────
const providers = {
  // Returns the model's text for an image + prompt.
  async geminiVision({ mimeType, base64, prompt }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set on the server');
    const t = timeoutSignal(AI_TIMEOUT_MS);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: t.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || 'request failed'}`);
      return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } finally { t.clear(); }
  },
  async geminiText({ prompt }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set on the server');
    const t = timeoutSignal(AI_TIMEOUT_MS);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: t.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || 'request failed'}`);
      return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } finally { t.clear(); }
  },
  // Groq is OpenAI-compatible. Returns the assistant text.
  async groqText({ system, user, json }) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY is not set on the server');
    const t = timeoutSignal(AI_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, signal: t.signal,
        body: JSON.stringify({
          model: GROQ_MODEL, temperature: 0, max_tokens: 400,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Groq ${res.status}: ${data.error?.message || 'request failed'}`);
      return data.choices?.[0]?.message?.content || '';
    } finally { t.clear(); }
  }
};

// Pull the first JSON object out of a model reply (they sometimes wrap it in ``` fences).
function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

function readImage(body) {
  const img = body && body.image;
  if (!img || typeof img !== 'string') return { error: 'image is required (data URL)' };
  const m = img.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { error: 'image must be a JPEG, PNG or WebP data URL' };
  const bytes = Math.floor(m[2].length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) return { error: 'image is too large — please retake the photo' };
  return { mimeType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2], bytes };
}

// Must match PURCHASE_CATEGORIES in frontend/public/js/app.js.
const PURCHASE_CATEGORIES = ['Groceries','Maintenance','Electricity','Water','Internet','Cleaning','Salary','Building Rent','Furniture','Repairs','Other'];

const BILL_PROMPT = `You are reading a photo of a shop bill / invoice / receipt from Tumakuru, Karnataka, India.
Extract ONLY these fields and reply with a single JSON object, nothing else:
{
  "amount": <total amount paid as a number, INR, no currency symbol, or null>,
  "paid_to": <shop or vendor name as printed, or null>,
  "purchase_date": <date on the bill as YYYY-MM-DD, or null>,
  "category": <one of: ${PURCHASE_CATEGORIES.join(' | ')}>,
  "description": <5-12 word summary of what was bought>,
  "payment_mode": <"Cash" | "UPI" | "Bank Transfer" | "Card" | null, only if printed on the bill>,
  "confidence": <"high" | "medium" | "low">
}
Use the grand total, not a sub-total. If the image is not a bill, set every field to null and confidence to "low".`;

const FAULT_PROMPT = `You are looking at a photo a resident or warden took of something broken in an Indian paying-guest hostel: a leak, a light, a fan, a door, a geyser, mould, an insect problem, a damaged fitting.
Reply with a single JSON object, nothing else:
{
  "category": <one of Water | Electrical | Wifi/Internet | Cleanliness | Food | Furniture | Security | Noise | Other>,
  "priority": <"low" | "medium" | "high" — water, electrical and security problems are usually high>,
  "likely_issue": <one short sentence naming the most likely cause, e.g. "Tap washer worn — dripping at the spout">,
  "description": <8-15 words describing what is visible, as a warden would write it>,
  "confidence": <"high" | "medium" | "low">
}
Do not guess at anything not visible. If the photo shows nothing broken, set category "Other", priority "low" and confidence "low".`;

const ID_PROMPT = `You are reading a photo of an Indian identity document (Aadhaar, Voter ID, Driving Licence, Passport or PAN).
Extract ONLY these fields and reply with a single JSON object, nothing else:
{
  "name": <full name as printed, or null>,
  "id_proof_type": <"Aadhaar" | "Voter ID" | "Driving Licence" | "Passport" | "PAN" | "Other">,
  "id_proof_number": <the document number as printed, digits and letters only, or null>,
  "address": <full postal address as printed if present, else null>,
  "confidence": <"high" | "medium" | "low">
}
Do not infer or invent anything that is not printed. If it is not an identity document, set every field to null and confidence to "low".`;

// ── GET /ai/status ── which AI inputs the UI may offer ──────────────────
router.get('/status', auth, (req, res) => {
  res.json({
    vision: !!process.env.GEMINI_API_KEY,
    text: !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
    models: { gemini: GEMINI_MODEL, groq: GROQ_MODEL }
  });
});

// ── GET /ai/probe ── admin-only live check that keys + model names work ──
router.get('/probe', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const out = { gemini: { ok: false }, groq: { ok: false } };
  const t0 = Date.now();
  try {
    const txt = await providers.geminiText({ prompt: 'Reply with exactly the word OK.' });
    out.gemini = { ok: /ok/i.test(txt), model: GEMINI_MODEL, ms: Date.now() - t0, reply: String(txt).slice(0, 40) };
  } catch (e) { out.gemini = { ok: false, model: GEMINI_MODEL, error: e.message }; }
  const t1 = Date.now();
  try {
    const txt = await providers.groqText({ system: 'Reply with exactly the word OK.', user: 'ping' });
    out.groq = { ok: /ok/i.test(txt), model: GROQ_MODEL, ms: Date.now() - t1, reply: String(txt).slice(0, 40) };
  } catch (e) { out.groq = { ok: false, model: GROQ_MODEL, error: e.message }; }
  res.json(out);
});

// ── POST /ai/vision ── { kind: 'bill'|'id', image: dataURL } ─────────────
router.post('/vision', auth, async (req, res) => {
  const kind = req.body && req.body.kind;
  if (!['bill', 'id', 'fault'].includes(kind)) return res.status(400).json({ error: 'kind must be "bill", "id" or "fault"' });
  const img = readImage(req.body);
  if (img.error) return res.status(400).json({ error: img.error });
  if (!process.env.GEMINI_API_KEY && !providers._stub) return res.status(503).json({ error: 'Photo scanning is not enabled on this server' });
  try {
    const prompt = kind === 'bill' ? BILL_PROMPT : kind === 'fault' ? FAULT_PROMPT : ID_PROMPT;
    const text = await providers.geminiVision({ mimeType: img.mimeType, base64: img.base64, prompt });
    const parsed = parseJsonLoose(text);
    if (!parsed) return res.status(502).json({ error: 'Could not read that photo — try again with better light' });
    const fields = kind === 'bill' ? normaliseBill(parsed) : kind === 'fault' ? normaliseFault(parsed) : normaliseId(parsed);
    // Never log the image or the extracted ID number. Log only that a scan happened.
    console.log(`[ai] vision ${kind} by user ${req.user.id} (${Math.round(img.bytes / 1024)} kB) confidence=${fields.confidence}`);
    res.json({ kind, fields });
  } catch (e) {
    const msg = /abort/i.test(e.message) ? 'The photo took too long to read — check your signal and try again' : e.message;
    res.status(502).json({ error: msg });
  }
});

function normaliseBill(p) {
  const amount = p.amount == null ? null : Number(String(p.amount).replace(/[^\d.]/g, ''));
  let cat = PURCHASE_CATEGORIES.find(c => c.toLowerCase() === String(p.category || '').toLowerCase()) || null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.purchase_date || '')) ? p.purchase_date : null;
  const mode = ['Cash', 'UPI', 'Bank Transfer', 'Card'].find(m => m.toLowerCase() === String(p.payment_mode || '').toLowerCase()) || null;
  return {
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null,
    paid_to: p.paid_to ? String(p.paid_to).trim().slice(0, 80) : null,
    purchase_date: date,
    category: cat,
    description: p.description ? String(p.description).trim().slice(0, 140) : null,
    payment_mode: mode,
    confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low'
  };
}

// A photo of a fault only ever *suggests*; the warden confirms, exactly as
// with a bill or an ID.
function normaliseFault(p) {
  const cats = ['Water', 'Electrical', 'Wifi/Internet', 'Cleanliness', 'Food', 'Furniture', 'Security', 'Noise', 'Other'];
  return {
    category: cats.find(c => c.toLowerCase() === String(p.category || '').toLowerCase()) || 'Other',
    priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
    likely_issue: p.likely_issue ? String(p.likely_issue).trim().slice(0, 160) : null,
    description: p.description ? String(p.description).trim().slice(0, 200) : null,
    confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low'
  };
}

function normaliseId(p) {
  const types = ['Aadhaar', 'Voter ID', 'Driving Licence', 'Passport', 'PAN', 'Other'];
  const type = types.find(t => t.toLowerCase() === String(p.id_proof_type || '').toLowerCase()) || (p.id_proof_type ? 'Other' : null);
  return {
    name: p.name ? String(p.name).trim().slice(0, 80) : null,
    id_proof_type: type,
    id_proof_number: p.id_proof_number ? String(p.id_proof_number).replace(/[^A-Za-z0-9]/g, '').slice(0, 30) : null,
    address: p.address ? String(p.address).trim().slice(0, 300) : null,
    confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low'
  };
}

// ── POST /ai/parse ── { kind: 'collection'|'complaint', text } ────────────
// Fallback for phrases the on-device parser could not resolve. Sends the
// phrase plus resident NAMES and ROOM NUMBERS only.
router.post('/parse', auth, async (req, res) => {
  const { kind, text } = req.body || {};
  if (!['collection', 'complaint'].includes(kind)) return res.status(400).json({ error: 'kind must be "collection" or "complaint"' });
  if (!text || typeof text !== 'string' || text.length > 500) return res.status(400).json({ error: 'text is required (max 500 chars)' });
  const hasProvider = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || providers._stub;
  if (!hasProvider) return res.status(503).json({ error: 'AI parsing is not enabled on this server' });
  try {
    let system, user;
    if (kind === 'collection') {
      const g = await pool.query(`SELECT g.id, g.name, r.room_number FROM guests g LEFT JOIN rooms r ON r.id=g.room_id WHERE g.is_active=true ORDER BY g.name`);
      const roster = g.rows.map(r => `${r.id}|${r.name}|${r.room_number || ''}`).join('\n');
      system = `You turn a PG warden's spoken sentence (English, Kannada or Hindi words, possibly transliterated) into a rent collection entry. Reply ONLY with JSON: {"guest_id": <id from the roster or null>, "amount": <number in INR or null>, "mode": <"Cash"|"UPI"|"Bank Transfer"|null>, "type": <"rent"|"deposit"|"advance">}. Roster lines are id|name|room. Match by name or room; if unsure, guest_id null.`;
      user = `Roster:\n${roster}\n\nSentence: ${text}`;
    } else {
      system = `You classify a PG resident's complaint. Reply ONLY with JSON: {"category": <one of Water|Electrical|Wifi/Internet|Cleanliness|Food|Furniture|Security|Noise|Other>, "priority": <"low"|"medium"|"high">, "description": <the complaint rewritten as one clear English sentence>}. Water, electrical and security problems are usually high.`;
      user = text;
    }
    const reply = process.env.GROQ_API_KEY || providers._stub
      ? await providers.groqText({ system, user, json: true })
      : await providers.geminiText({ prompt: system + '\n\n' + user });
    const parsed = parseJsonLoose(reply);
    if (!parsed) return res.status(502).json({ error: 'Could not understand that — please fill the form' });
    if (kind === 'collection') {
      const amount = parsed.amount == null ? null : Number(parsed.amount);
      res.json({ guest_id: parsed.guest_id ? Number(parsed.guest_id) : null, amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        mode: ['Cash', 'UPI', 'Bank Transfer'].includes(parsed.mode) ? parsed.mode : null, type: ['rent', 'deposit', 'advance'].includes(parsed.type) ? parsed.type : 'rent' });
    } else {
      const cats = ['Water', 'Electrical', 'Wifi/Internet', 'Cleanliness', 'Food', 'Furniture', 'Security', 'Noise', 'Other'];
      res.json({ category: cats.includes(parsed.category) ? parsed.category : 'Other', priority: ['low', 'medium', 'high'].includes(parsed.priority) ? parsed.priority : 'medium',
        description: parsed.description ? String(parsed.description).slice(0, 500) : text });
    }
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
module.exports.providers = providers;
module.exports._internal = { parseJsonLoose, normaliseBill, normaliseId, normaliseFault, readImage, PURCHASE_CATEGORIES };
