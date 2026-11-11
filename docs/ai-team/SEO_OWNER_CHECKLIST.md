# Siri Mane PG — SEO: what Sachin does (step by step)

The website side (title, H1, structured data, FAQ, canonical address, sitemap, noindex on the app) is done in Sprint 23. Everything below needs an owner login or a phone with photos, so it is yours. Do them in this order; 1–3 matter most.

## Before ANY change to hostnames, DNS, redirects or Railway domains (2 min)
Run this in the Railway console (Production service → Console) and release only when every line is ✅:
```
node backend/scripts/check-live.js www.sirimane.in sirimane.in
```
It looks up each name in DNS and fetches /health. On 11 Nov a redirect to a name with no DNS record took the site down for 30 minutes; this check would have caught it. The redirect itself is now the Railway variable `CANONICAL_HOST` (set it to `www.sirimane.in` on Production if you want the bare domain to forward once it has a DNS record; leave it unset otherwise).

## 0. Confirm three facts first (5 min)
These are now written on the website. Tell me if any is wrong and I will change it the same day.
- Enquiry hours shown: **9 am – 8 pm, every day**.
- Address shown: **5th Cross, Gangotri Road, S.I.T. Extension, Tumakuru 572103**. Phone **98802 17627** (also WhatsApp).
- FAQ says: electricity is included in rent · there is a resident warden · "walking distance of SIT" · residents are both students and working women.

## 1. Google Business Profile (the map result) — 30 min + verification wait
1. On your phone, open Google Maps and search **Siri Mane Ladies PG**. If a pin exists, tap it → "Claim this business". If not, in Maps tap your profile picture → "Add your business".
2. Business name exactly: **Siri Mane Ladies PG** (no extra words — Google suspends profiles with keywords stuffed into the name).
3. Category: primary **Hostel** or **Women's hostel** if offered; secondary **Boarding house**. Do not choose "Hotel".
4. Address, phone, website: use exactly the ones in section 0 and **https://www.sirimane.in** (with www — that is the address that exists; the bare domain has no DNS record).
5. Hours: 9:00 am – 8:00 pm, Monday to Sunday (or your real hours — then tell me).
6. Verification: Google will offer a video call, a video of the premises, or a postcard (5–14 days). Choose video if offered; it is fastest. Show the name board, the entrance and the street.
7. After verification, fill in:
   - **Description** (750 chars max). Use: "Siri Mane is a ladies-only paying guest accommodation in S.I.T. Extension, Tumakuru, a short walk from Siddaganga Institute of Technology. Furnished 2, 3 and 4-sharing rooms with home-cooked South Indian meals, high-speed WiFi, housekeeping, washing machines and 24/7 CCTV security. Suitable for students and working women. Rent includes food, WiFi and electricity. Call or WhatsApp 98802 17627 to enquire."
   - **Services**: Ladies PG in Tumakuru · PG near SIT Extension · Furnished rooms with food · Women's hostel Tumkur · Working women's accommodation.
   - **Attributes**: Women-owned (if true), Wi-Fi, Security.
8. **Photos**: 10–15 photos, bright, landscape, taken in daylight. Rooms (made beds), dining area with food, kitchen, entrance with name board, CCTV, washing machines, study area. Before uploading, rename each file on your phone or laptop like `siri-mane-ladies-pg-tumakuru-2-sharing-room.jpg`. Send me the same photos — I will put them on the website with proper alt text.
9. Turn on **Messaging** and **Q&A**; answer the FAQ questions yourself there (same six as on the website).

## 2. Reviews — ongoing, the single biggest ranking factor
1. In the Business Profile, tap "Ask for reviews" → copy the short link.
2. Send it on WhatsApp to current residents and recent leavers with one line: "If you've been happy here, a Google review helps other girls and parents find us 🙏".
3. Aim for 5 reviews in the first two weeks, then 2–3 a month. Never offer money or rent discounts for reviews (Google removes them).
4. Reply to every review within a day or two, in a few words, by name.
5. Once the profile is live, tell me: I can add a "Review us on Google" button to the resident app and the website.

## 3. Google Search Console — 15 min
1. Go to https://search.google.com/search-console → Add property → choose **Domain** → type `sirimane.in`.
2. Google gives you a TXT record. In GoDaddy DNS for sirimane.in, add a TXT record with host `@` and that value. Wait 10–30 min, then click Verify.
3. In Search Console: Sitemaps → enter `sitemap.xml` → Submit.
4. URL Inspection → paste `https://www.sirimane.in/` → "Request indexing".
5. Come back in a week: Performance shows which searches show the site. Send me a screenshot of the top queries; I will tune the words on the page to match.

## 4. Local directories — 1 hour, once
Use the **same** name, address and phone everywhere (Google compares them).
- Justdial: justdial.com → "Free listing".
- Sulekha: sulekha.com → "List your business" (PG / Hostel).
- MagicBricks PG and 99acres PG: list the rooms with photos and rent.
- Facebook page + Instagram account named Siri Mane Ladies PG, with the website link and the same photos.
- WhatsApp Business: set up the business profile on 98802 17627 with address, hours and the website.

## 5. Mentions and links — over the coming months
- Ask SIT and Tumkur University hostel offices / women's cells whether they keep a list of approved outside PGs; ask to be added with the website link.
- Post the website in Tumakuru student and newcomer Facebook/WhatsApp groups when someone asks for a ladies PG.
- A short post on your own LinkedIn/Facebook linking to sirimane.in.

## 6. What to watch
- Search "ladies PG Tumakuru" and "PG near SIT Tumkur" on your phone once a month and note the position.
- If a competitor shows above with more reviews, the fix is more reviews, not more website changes.

## Not recommended
- Paying an "SEO agency" for backlinks. For a single PG in one town, the Business Profile and reviews do almost all of the work.
- Adding "Tumakuru" or "PG" to the Google Business name. Google penalises it.
