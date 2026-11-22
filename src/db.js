// MySQL / MariaDB access.
//
// All timestamps are stored as UTC DATETIMEs: the pool sets each session's
// time_zone to UTC and mysql2 reads/writes JS Dates as UTC (timezone: "Z").
// The app formats them for India time when displaying.
import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  host: process.env.DB_HOST === "mysql" ? "localhost" : process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
  dateStrings: ["DATE"], // plain DATE columns come back as "YYYY-MM-DD"
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  waitForConnections: true,
  enableKeepAlive: true,
  ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
});

pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// Runs one statement. Returns { rows, rowCount, insertId } like before, so
// callers don't need to know about mysql2's [result, fields] tuple.
async function run(conn, sql, params = []) {
  const [result] = await conn.query(sql, params);
  if (Array.isArray(result)) return { rows: result, rowCount: result.length, insertId: null };
  return { rows: [], rowCount: result.affectedRows, insertId: result.insertId };
}

export const query = (sql, params) => run(pool, sql, params);

// Runs fn inside a transaction on one connection. fn gets { query }.
// Commits if fn resolves, rolls back if it throws.
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn({ query: (sql, params) => run(conn, sql, params) });
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Next ARN number for a year (1, 2, 3, ...). Uses LAST_INSERT_ID(expr) so the
// increment is atomic without needing sequences, which MySQL does not have.
export async function nextArnNumber(tx, year) {
  await tx.query(
    `INSERT INTO arn_counters (year, last_value) VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)`,
    [year],
  );
  const { rows } = await tx.query("SELECT LAST_INSERT_ID() AS n");
  return Number(rows[0].n);
}

const TABLE_OPTS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

// Creates the tables this app needs. Safe to run on every start.
// Order matters because of the foreign keys.
const SCHEMA = [
  // AC inventory, one row per CREW serial number. Columns follow the IACS AC
  // data sheet ("FINAL DATA-SHEET -IACS-AC"); load it with `npm run import:ac`.
  `CREATE TABLE IF NOT EXISTS ac_units (
     crew_serial_number   VARCHAR(32)  NOT NULL PRIMARY KEY,  -- CREW SR No., e.g. IACS/CREW/AC/00001
     sr_no                INT UNSIGNED NOT NULL,              -- SR No. (the number part)
     gem_order_no         VARCHAR(64),                        -- GEM Order No.
     gem_order_date       DATE,                               -- Date
     unit_price           DECIMAL(12,2),                      -- Unit price
     capacity_tr          VARCHAR(16),                        -- AC Capacity (tons); text, e.g. "7.5 +7.5"
     indoor_serial_no     VARCHAR(64),                        -- Indoor Unit Serial Number
     outdoor_serial_no    VARCHAR(64),                        -- Outdoor Unit Serial Number
     brand                VARCHAR(64),                        -- Brand
     ac_type              VARCHAR(32),                        -- Split / Window / Cassette / Ductable ...
     timer_installed      TINYINT(1),                         -- Timer Installed (Yes/No)
     working_condition    VARCHAR(16),                        -- Working Condition as on 01-05-2023 (Yes/No/New)
     installation_date    DATE,                               -- Date of Installation
     room_number          VARCHAR(128),                       -- Room No.
     in_charge            VARCHAR(255),                       -- Faculty / Staff / In-charge
     school               VARCHAR(128),                       -- School
     under_warranty       TINYINT(1),                         -- Warranty (Yes/No)
     warranty_start_date  DATE,                               -- Start Date
     warranty_end_date    DATE,                               -- End Date
     amc                  VARCHAR(16),                        -- AMC (Yes/No/New)
     amc_work_order_no    VARCHAR(255),                       -- AMC Work Order No. (or note)
     amc_start_date       DATE,                               -- AMC Start Date
     amc_end_date         DATE,                               -- AMC End Date
     purchase_type        VARCHAR(64),                        -- Purchase under Replacement or New - details
     replaced             TINYINT(1),                         -- Replace (Y/N)
     replacement_capacity_tr       VARCHAR(16),               -- replacement unit: AC Capacity
     replacement_indoor_serial_no  VARCHAR(64),               -- replacement unit: Indoor Unit Serial Number
     replacement_outdoor_serial_no VARCHAR(64),               -- replacement unit: Outdoor Unit Serial Number
     replacement_brand             VARCHAR(64),               -- Replaced Brand
     replacement_gem_order         VARCHAR(255),              -- GeM Order Details
     replacement_installation_date DATE,                      -- replacement unit: Date of Installation
     replacement_unit_price        DECIMAL(12,2),             -- replacement unit: Unit Price
     created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY ac_units_sr_no_uq (sr_no)
   ) ${TABLE_OPTS}`,

  // Technicians sign in with a passcode only. passcode_lookup is an HMAC of the
  // passcode (keyed with PASSCODE_PEPPER) so the account can be found without
  // trying every hash; passcode_hash is a bcrypt hash used to verify it.
  `CREATE TABLE IF NOT EXISTS technician_accounts (
     id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     name             VARCHAR(255) NOT NULL,
     phone            VARCHAR(32)  NOT NULL,
     section          VARCHAR(32)  NOT NULL,
     passcode_lookup  CHAR(64)     NOT NULL,
     passcode_hash    VARCHAR(100) NOT NULL,
     active           TINYINT(1)   NOT NULL DEFAULT 1,
     created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY technician_passcode_lookup_uq (passcode_lookup)
   ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS job_cards (
     id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     arn                VARCHAR(32)  NOT NULL,
     first_name         VARCHAR(255) NOT NULL,
     last_name          VARCHAR(255) NOT NULL,
     email              VARCHAR(255) NOT NULL,
     contact_number     VARCHAR(32)  NOT NULL,
     department         VARCHAR(255) NOT NULL,
     section            VARCHAR(32)  NOT NULL,
     item_type          VARCHAR(32),
     crew_serial_number VARCHAR(32),
     details_correct    TINYINT(1),
     description        TEXT NOT NULL,
     status             VARCHAR(64)  NOT NULL DEFAULT 'APPLICATION SUBMITTED',
     technician_id      INT UNSIGNED,
     technician_name    VARCHAR(255),
     technician_phone   VARCHAR(32),
     assigned_at        DATETIME(3),
     materials_issued   TEXT,
     material_issued_at DATETIME(3),
     closed_at          DATETIME(3),
     created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY job_cards_arn_uq (arn),
     KEY job_cards_crew_status_idx (crew_serial_number, status),
     KEY job_cards_technician_idx (technician_id, section, status),
     CONSTRAINT job_cards_ac_fk FOREIGN KEY (crew_serial_number) REFERENCES ac_units (crew_serial_number),
     CONSTRAINT job_cards_technician_fk FOREIGN KEY (technician_id) REFERENCES technician_accounts (id)
   ) ${TABLE_OPTS}`,

  // One row per signed-in device. Holds the hash of the current refresh token
  // (rotated on every refresh) and the previous one for a short grace window.
  `CREATE TABLE IF NOT EXISTS technician_sessions (
     id                 CHAR(36)     NOT NULL PRIMARY KEY,
     technician_id      INT UNSIGNED NOT NULL,
     refresh_hash       CHAR(64)     NOT NULL,
     prev_refresh_hash  CHAR(64),
     rotated_at         DATETIME(3),
     created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     last_used_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     expires_at         DATETIME(3)  NOT NULL,
     revoked_at         DATETIME(3),
     user_agent         VARCHAR(300),
     ip                 VARCHAR(64),
     KEY technician_sessions_tech_idx (technician_id),
     CONSTRAINT technician_sessions_tech_fk FOREIGN KEY (technician_id)
       REFERENCES technician_accounts (id) ON DELETE CASCADE
   ) ${TABLE_OPTS}`,

  // kind: INDENTOR_UPLOAD (sent with the application) or SIGNED_RECEIPT (from technician).
  `CREATE TABLE IF NOT EXISTS job_card_attachments (
     id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     job_card_id   INT UNSIGNED NOT NULL,
     original_name VARCHAR(255) NOT NULL,
     stored_name   VARCHAR(255) NOT NULL,
     mime_type     VARCHAR(100) NOT NULL,
     size_bytes    INT UNSIGNED NOT NULL,
     kind          VARCHAR(32)  NOT NULL DEFAULT 'INDENTOR_UPLOAD',
     uploaded_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     KEY job_card_attachments_job_idx (job_card_id),
     CONSTRAINT job_card_attachments_job_fk FOREIGN KEY (job_card_id)
       REFERENCES job_cards (id) ON DELETE CASCADE
   ) ${TABLE_OPTS}`,

  // Per-year ARN counter: JC<year><6-digit number>.
  `CREATE TABLE IF NOT EXISTS arn_counters (
     year       SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
     last_value INT UNSIGNED NOT NULL
   ) ${TABLE_OPTS}`,
];

export async function initDb() {
  for (const statement of SCHEMA) await query(statement);

  // The first version of ac_units had only a few columns. `npm run import:ac`
  // upgrades it; until then, warn instead of failing later with odd SQL errors.
  if (await acUnitsNeedsUpgrade()) {
    console.warn("ac_units uses the old layout. Run `npm run import:ac -- <path to AC data sheet .csv>` to upgrade and load it.");
  }
}

// True when ac_units still has the original few-column layout.
export async function acUnitsNeedsUpgrade() {
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'ac_units' AND column_name = 'sr_no'`,
  );
  return !Number(rows[0].n);
}
