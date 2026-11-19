# IACS Online Job Card Portal

Express + EJS + PostgreSQL rebuild of the IACS CREW job card portal. Frontend is plain HTML, CSS and JS on **Bootstrap 6.0.0-alpha.1** (served from `node_modules`, no CDN).

## Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on change)
```

Open http://localhost:3000. Tables are created on first start (`src/db.js`), and three sample AC records (`AC-0001` to `AC-0003`) are seeded so the CREW lookup can be tried.

`.env` needs: `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST`, `DB_PORT`, optional `PORT`.

## Structure

```
src/server.js         Express app, static files, EJS
src/db.js             pg pool + schema (ac_units, job_cards, job_card_attachments)
src/constants.js      Sections, item types, help-desk details
src/routes/api.js     JSON API + file uploads (multer -> uploads/)
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
