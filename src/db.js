import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST === "postgres" ? "localhost" : process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
});

export const query = (text, params) => pool.query(text, params);

// Creates the tables this app needs. Safe to run on every start.
export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS ac_units (
      crew_serial_number VARCHAR(32) PRIMARY KEY,
      brand              TEXT,
      in_charge          TEXT,
      school             TEXT,
      room_number        TEXT,
      amc                TEXT,
      amc_work_order_no  TEXT,
      amc_start_date     DATE,
      amc_end_date       DATE
    );

    CREATE SEQUENCE IF NOT EXISTS job_card_arn_seq START 1;

    CREATE TABLE IF NOT EXISTS job_cards (
      id                 SERIAL PRIMARY KEY,
      arn                VARCHAR(32) UNIQUE NOT NULL,
      first_name         TEXT NOT NULL,
      last_name          TEXT NOT NULL,
      email              TEXT NOT NULL,
      contact_number     TEXT NOT NULL,
      department         TEXT NOT NULL,
      section            TEXT NOT NULL,
      item_type          TEXT,
      crew_serial_number VARCHAR(32) REFERENCES ac_units(crew_serial_number),
      details_correct    BOOLEAN,
      description        TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'APPLICATION SUBMITTED',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Progress tracking: technician assignment, store material issue, closure.
    ALTER TABLE job_cards
      ADD COLUMN IF NOT EXISTS technician_name    TEXT,
      ADD COLUMN IF NOT EXISTS technician_phone   TEXT,
      ADD COLUMN IF NOT EXISTS assigned_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS materials_issued   TEXT,
      ADD COLUMN IF NOT EXISTS material_issued_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS closed_at          TIMESTAMPTZ;

    -- Technicians sign in with a passcode only. passcode_lookup is an HMAC of the
    -- passcode (keyed with PASSCODE_PEPPER) so we can find the account without
    -- trying every hash; passcode_hash is a bcrypt hash used to verify it.
    CREATE TABLE IF NOT EXISTS technician_accounts (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      phone            TEXT NOT NULL,
      section          TEXT NOT NULL,
      passcode_lookup  CHAR(64) UNIQUE NOT NULL,
      passcode_hash    TEXT NOT NULL,
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per signed-in device. Holds the hash of the current refresh token
    -- (rotated on every refresh) and the previous one for a short grace window.
    CREATE TABLE IF NOT EXISTS technician_sessions (
      id                 UUID PRIMARY KEY,
      technician_id      INTEGER NOT NULL REFERENCES technician_accounts(id) ON DELETE CASCADE,
      refresh_hash       CHAR(64) NOT NULL,
      prev_refresh_hash  CHAR(64),
      rotated_at         TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at         TIMESTAMPTZ NOT NULL,
      revoked_at         TIMESTAMPTZ,
      user_agent         TEXT,
      ip                 TEXT
    );
    CREATE INDEX IF NOT EXISTS technician_sessions_tech_idx ON technician_sessions(technician_id);

    ALTER TABLE job_cards
      ADD COLUMN IF NOT EXISTS technician_id INTEGER REFERENCES technician_accounts(id);

    CREATE TABLE IF NOT EXISTS job_card_attachments (
      id            SERIAL PRIMARY KEY,
      job_card_id   INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- INDENTOR_UPLOAD (sent with the application) or SIGNED_RECEIPT (from technician).
    ALTER TABLE job_card_attachments
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'INDENTOR_UPLOAD';
  `);

  // Sample AC records so the CREW number lookup can be tried out locally.
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM ac_units");
  if (rows[0].n === 0) {
    await query(`
      INSERT INTO ac_units VALUES
        ('AC-0001', 'Daikin',     'Dr. A. Sen',      'School of Chemical Sciences',  '201', 'Comprehensive', 'WO/2026/114', '2026-04-01', '2027-03-31'),
        ('AC-0002', 'Blue Star',  'Prof. R. Ghosh',  'School of Physical Sciences',  '115', 'Non-Comprehensive', 'WO/2026/087', '2026-01-01', '2026-12-31'),
        ('AC-0003', 'Voltas',     'Workshop Office', 'Workshop',                     'G-04', 'Comprehensive', 'WO/2025/301', '2025-07-01', '2026-06-30')
    `);
  }
}
