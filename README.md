# IACS Online Job Card Portal

Express + EJS + PostgreSQL rebuild of the IACS CREW job card portal. Frontend is plain HTML, CSS and JS on **Bootstrap 6.0.0-alpha.1** (served from `node_modules`, no CDN).

## Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on change)
```

Open http://localhost:3000. Tables are created on first start (`src/db.js`), and three sample AC records (`AC-0001` to `AC-0003`) are seeded so the CREW lookup can be tried.

`.env` needs: `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST`, `DB_PORT`, optional `PORT`.

## Technicians

Technicians log in at `/technician/login` with a 6-digit passcode (no user ID). They see only open job cards that are **assigned to them** and in **their own section**. Uploading a photo or PDF of the signed receipt closes the job card (`APPLICATION CLOSED`).

Until the admin panel exists, manage accounts from the command line:

```bash
npm run technician -- create --name "Ramesh Das" --phone 2239 --section AC_REFRIGERATION
npm run technician -- reset-passcode --id 3
npm run technician -- deactivate --id 3
npm run technician -- list
```

The passcode is printed once and stored only as a hash. For local testing, `npm run seed:demo` creates two demo technicians and job cards (passcodes are at the top of `scripts/seed-demo.js`).

### How login works

- The passcode is found by HMAC (`PASSCODE_PEPPER`) and checked against a bcrypt hash. Wrong attempts are rate-limited (10 per 15 minutes per IP).
- A successful login creates a row in `technician_sessions` and sets two httpOnly, SameSite=Strict cookies:
  - `jc_tat`: access token, a JWT valid for 15 minutes.
  - `jc_trt`: refresh token, valid for 7 days, stored only as a SHA-256 hash.
- When the access token expires, the refresh token is swapped for a new pair (rotation). Replaying an old refresh token revokes the session.
- Logging out, resetting a passcode or deactivating a technician revokes their sessions at once.
- Set `NODE_ENV=production` so cookies are HTTPS-only, and `TRUST_PROXY=1` behind a reverse proxy.

## Structure

```
src/server.js         Express app, static files, EJS
src/db.js             pg pool + schema (ac_units, job_cards, job_card_attachments)
src/constants.js      Sections, item types, help-desk details
src/routes/api.js     JSON API + file uploads (multer -> uploads/)
src/routes/technician.js  Technician login, job list, receipt upload
src/auth/             Passcode check, JWT access + rotating refresh tokens
scripts/              Technician account CLI, demo seed
views/                index.ejs + partials (head, header, footer, two dialogs)
public/css/app.css    Theme on top of Bootstrap
public/js/app.js      Dialog logic, CREW lookup, validation, light/dark toggle
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ac/:crew` | AC details for a CREW Serial Number (+ any active job card ARN) |
| POST | `/api/job-cards` | Submit a job card (multipart, up to 5 files, 10 MB each, JPG/PNG/WEBP/PDF) |
| GET | `/api/job-cards/:arn` | Status of a job card |

ARNs look like `JC2026000001`. Only one open job card is allowed per AC.

## Bootstrap 6 notes

Bootstrap 6 is still alpha and differs from v5: modals are native `<dialog class="dialog">` opened with `data-bs-toggle="dialog"`; radios use `class="radio"`; buttons are `btn btn-solid theme-primary`; responsive classes use `md:col-6`; the JS bundle is an ES module (`<script type="module">`).
