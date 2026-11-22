# IACS Online Job Card Portal

Express + EJS + MySQL/MariaDB rebuild of the IACS CREW job card portal. Frontend is plain HTML, CSS and JS on **Bootstrap 6.0.0-alpha.1** (served from `node_modules`, no CDN).

## Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on change)
```

Open http://localhost:3000. Tables are created on first start (`src/db.js`), and three sample AC records (`AC-0001` to `AC-0003`) are seeded so the CREW lookup can be tried.

`.env` needs: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, `PASSCODE_PEPPER` (see `.env.example`).

> **PowerShell:** PowerShell drops the `--` in `npm run <script> -- <args>`, so npm swallows options like `--email`. In PowerShell run the scripts with node directly, e.g. `node scripts/admin.js list` instead of `npm run admin -- list`.

## Database

MySQL 8 or MariaDB 10.6+. Create an empty database with collation `utf8mb4_unicode_ci` and a user with all privileges on it. The app creates its tables on first start. Times are stored in UTC and shown in India time.

On cPanel:

- Create the database and user under **MySQL Databases** (cPanel adds your account prefix, e.g. `fcroveif_`).
- If the app runs on the same server (e.g. **Setup Node.js App**), use `DB_HOST=localhost`.
- If it runs elsewhere, add that machine's IP under **Remote MySQL** and use the server's hostname. The connection is unencrypted unless the server supports SSL and you set `DB_SSL=true`, so prefer running the app on the same server or connecting through an SSH tunnel.

### AC inventory

`ac_units` holds the IACS AC data sheet ("FINAL DATA-SHEET -IACS-AC"). Export its **AC** tab as CSV and load it:

```bash
npm run import:ac -- "path/to/FINAL DATA-SHEET -IACS-AC ... - AC.csv" --dry-run   # check first
npm run import:ac -- "path/to/FINAL DATA-SHEET -IACS-AC ... - AC.csv"
```

- Rows are added or updated by **CREW SR No.**, so re-running with an updated sheet is safe.
- Reserved numbers with no AC details are skipped; "Not Available" becomes empty.
- Values that can't be read (e.g. a date typed as `19.11.20224`) are left empty and listed so the sheet can be fixed.
- An AC listed on two rows (same unit for two rooms) is merged into one record.
- `QTY` and `Total` are not stored (always 1 / 1.00 in the sheet).

People can type the CREW number in full (`IACS/CREW/AC/00007`) or just the number (`7`, `00007`).

## Admin panel

Admins sign in at `/admin/login` with their official email and a password. The dashboard has three cards:

- **Manage job card applications**: every job card, filter by section and status, search by ARN or CREW number, view details and files, and assign or reassign a technician from that job's section.
- **Manage AC database**: search, add, edit and delete rows of `ac_units`. An AC with job cards or preventive services can't be deleted.
  - **Add AC** numbers the AC automatically: highest existing SR No. + 1 (e.g. after `IACS/CREW/AC/00190` comes `…00191`).
  - **Import CSV**: download the template, fill it in, upload it, check the preview, then **Import**. Blank CREW Serial No. = new AC (auto-numbered); a CREW Serial No. = update that AC (only filled-in cells change). All rows are imported together or not at all.
  - **Keytag**: a printable A6 PDF with the CREW serial number and a QR code, generated on the fly (not stored).
- **Scan QR on keytag** (job card form): reads the keytag's QR with the camera (HTTPS or localhost) or from a photo, fills the CREW Serial No. and fetches the AC details automatically.
- **Preventive service**: ACs with AMC = Yes; apply for Preventive Service 1–4 (each once per AC), assigned straight to an AC technician. The requester is the signed-in admin's profile. Technicians see these on My Jobs with a "Preventive Service" badge and close them with a receipt photo. The **Applications** tab lists all of them.
  - **Download & reset** is enabled during April (India time), once per financial year. It downloads the register as CSV, keeps a copy in `exports/`, and empties `preventive_services`. Set `PS_RESET_ALWAYS_ENABLED=true` only to test it outside April.

Manage admins from the command line (the profile is used on preventive services):

```bash
npm run admin -- create --name "Jane Doe" --email jane.doe@iacs.res.in --phone 1703 --department "Workshop"
npm run admin -- set-password --email jane.doe@iacs.res.in     # choose your own, typed hidden
npm run admin -- reset-password --email jane.doe@iacs.res.in   # random, printed once
npm run admin -- update --email jane.doe@iacs.res.in --phone 1704
npm run admin -- deactivate --email jane.doe@iacs.res.in
npm run admin -- list
```

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
src/db.js             mysql2 pool + schema (ac_units, job_cards, technicians, sessions, ARN counter)
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
