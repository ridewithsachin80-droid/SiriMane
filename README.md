# 🏠 Siri Mane PG — Deployment Guide
## Railway + PostgreSQL + GoDaddy Domain (sirimane.in)

---

## 📁 Project Structure

```
siri-mane/
├── backend/
│   ├── server.js          ← Main Express server
│   ├── db.js              ← PostgreSQL connection
│   ├── package.json
│   ├── .env.example       ← Copy to .env
│   ├── middleware/
│   │   └── auth.js        ← JWT authentication
│   ├── routes/
│   │   ├── auth.js        ← Login / password
│   │   ├── dashboard.js   ← Stats
│   │   ├── guests.js      ← Guest CRUD
│   │   ├── rooms.js       ← Room CRUD
│   │   ├── payments.js    ← Payment records
│   │   └── expenses.js    ← Expense records
│   └── scripts/
│       ├── migrate.js     ← Create DB tables
│       └── seed.js        ← Create admin user
├── frontend/
│   └── public/
│       ├── home.html      ← Landing page (sirimane.in)
│       ├── index.html     ← Management login + dashboard
│       ├── guest.html     ← Guest self-service portal
│       ├── css/style.css
│       └── js/
│           ├── api.js     ← API helper functions
│           └── app.js     ← Full app logic
├── package.json
├── railway.toml
└── nixpacks.toml
```

---

## 🚀 STEP 1 — Push to GitHub

```bash
# Open terminal in the siri-mane folder
git init
git add .
git commit -m "Initial commit - Siri Mane PG System"

# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/siri-mane.git
git push -u origin main
```

---

## 🚂 STEP 2 — Deploy on Railway

1. Go to **https://railway.app** → Sign up / Login with GitHub
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your **siri-mane** repository
5. Railway will auto-detect and start building

### Add PostgreSQL Database:
1. Inside your Railway project, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway automatically sets `DATABASE_URL` ✅

### Set Environment Variables:
Click your service → **"Variables"** tab → Add:

| Variable | Value |
|---|---|
| `JWT_SECRET` | `SiriMane_Secret_2024_xK9mP3qR` (use something random!) |
| `NODE_ENV` | `production` |
| `FRONTEND_URL` | `https://sirimane.in` |

> **`DATABASE_URL`** is set automatically by Railway — don't touch it.

---

## 🗄️ STEP 3 — Run Database Setup

After Railway deploys, open the **Railway terminal** (or run locally with the Railway DATABASE_URL):

```bash
# In Railway dashboard → your service → "Shell" tab:
node backend/scripts/migrate.js
node backend/scripts/seed.js
```

This creates all tables and the admin user:
- **Username:** `admin`
- **Password:** `SiriMane@2024`

> ⚠️ **Change the password immediately after first login!**

---

## 🌐 STEP 4 — Connect GoDaddy Domain (sirimane.in)

### In Railway:
1. Go to your service → **"Settings"** tab
2. Click **"+ Custom Domain"**
3. Type `sirimane.in` → Click **"Add Domain"**
4. Railway shows you a **CNAME value** — copy it

### In GoDaddy:
1. Login to **GoDaddy** → **My Products** → **DNS**
2. Find `sirimane.in` → Click **"Manage DNS"**
3. Delete any existing **A** or **CNAME** records for `@` and `www`
4. Add these records:

| Type | Name | Value | TTL |
|---|---|---|---|
| CNAME | `@` | `your-app.railway.app` | 600 |
| CNAME | `www` | `your-app.railway.app` | 600 |

> Replace `your-app.railway.app` with the actual Railway URL shown in your dashboard.

5. Wait **5–15 minutes** for DNS to propagate
6. Railway automatically provisions **SSL/HTTPS** ✅

---

## 🔑 STEP 5 — First Login

Visit **https://sirimane.in/index.html**

- Username: `admin`
- Password: `SiriMane@2024`

**Immediately change your password:**
Go to Settings (inside the app) → Change Password

---

## 📱 Pages

| URL | What it does |
|---|---|
| `sirimane.in` | Landing page (Guest or Management) |
| `sirimane.in/guest.html` | Guests check their own payments |
| `sirimane.in/index.html` | Management dashboard |

---

## 🔄 How to Update the App

Just push to GitHub — Railway auto-deploys:
```bash
git add .
git commit -m "Update something"
git push
```

---

## 💾 Database Backup

```bash
# Run this periodically to backup your data:
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
```

Or use Railway's built-in backup feature in the PostgreSQL plugin settings.

---

## 🛠️ Local Development

```bash
# 1. Install dependencies
cd backend && npm install

# 2. Create .env file
cp .env.example .env
# Edit .env with your local PostgreSQL details

# 3. Run migrations
node scripts/migrate.js
node scripts/seed.js

# 4. Start server
npm run dev
# App runs at http://localhost:3000
```

---

## 🔐 Security Checklist

- [ ] Changed default admin password
- [ ] `JWT_SECRET` is a long random string (32+ chars)
- [ ] `NODE_ENV` is set to `production`
- [ ] GoDaddy DNS points to Railway
- [ ] HTTPS is working (green lock in browser)
- [ ] Test login works at sirimane.in

---

## 📞 Default Credentials (CHANGE THESE!)

```
Username: admin
Password: SiriMane@2024
```
