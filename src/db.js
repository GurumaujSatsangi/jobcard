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

// Next reference number for a prefix and year (1, 2, 3, ...): "JC" for job
// cards, "PS" for preventive services. Uses LAST_INSERT_ID(expr) so the
// increment is atomic without needing sequences, which MySQL does not have.
export async function nextArnNumber(tx, year, prefix = "JC") {
  await tx.query(
    `INSERT INTO arn_counters (prefix, year, last_value) VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_value = LAST_INSERT_ID(last_value + 1)`,
    [prefix, year],
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

  // Per-year reference counters: JC<year><6 digits> for job cards,
  // PS<year><6 digits> for preventive services.
  `CREATE TABLE IF NOT EXISTS arn_counters (
     prefix     VARCHAR(8)        NOT NULL DEFAULT 'JC',
     year       SMALLINT UNSIGNED NOT NULL,
     last_value INT UNSIGNED      NOT NULL,
     PRIMARY KEY (prefix, year)
   ) ${TABLE_OPTS}`,

  // Admins sign in with official email + password. Their profile (name,
  // email, extension, department) is used as the indentor on preventive services.
  `CREATE TABLE IF NOT EXISTS admin_accounts (
     id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     name            VARCHAR(255) NOT NULL,
     email           VARCHAR(255) NOT NULL,
     contact_number  VARCHAR(32)  NOT NULL,
     department      VARCHAR(255) NOT NULL,
     password_hash   VARCHAR(100) NOT NULL,
     active          TINYINT(1)   NOT NULL DEFAULT 1,
     created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY admin_accounts_email_uq (email)
   ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS admin_sessions (
     id                 CHAR(36)     NOT NULL PRIMARY KEY,
     admin_id           INT UNSIGNED NOT NULL,
     refresh_hash       CHAR(64)     NOT NULL,
     prev_refresh_hash  CHAR(64),
     rotated_at         DATETIME(3),
     created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     last_used_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     expires_at         DATETIME(3)  NOT NULL,
     revoked_at         DATETIME(3),
     user_agent         VARCHAR(300),
     ip                 VARCHAR(64),
     KEY admin_sessions_admin_idx (admin_id),
     CONSTRAINT admin_sessions_admin_fk FOREIGN KEY (admin_id)
       REFERENCES admin_accounts (id) ON DELETE CASCADE
   ) ${TABLE_OPTS}`,

  // Preventive services for ACs under AMC, raised by an admin and assigned
  // straight to an AC technician. Each type (1-4) can be raised once per AC per
  // year; the table is downloaded and emptied every April (see admin panel).
  // Requester details are copied from the admin profile at the time of request.
  `CREATE TABLE IF NOT EXISTS preventive_services (
     id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     ref                  VARCHAR(32)  NOT NULL,
     crew_serial_number   VARCHAR(32)  NOT NULL,
     service_type         TINYINT UNSIGNED NOT NULL,
     status               VARCHAR(32)  NOT NULL DEFAULT 'ASSIGNED',
     requested_by_admin_id INT UNSIGNED,
     requester_name       VARCHAR(255) NOT NULL,
     requester_email      VARCHAR(255) NOT NULL,
     requester_contact    VARCHAR(32)  NOT NULL,
     requester_department VARCHAR(255) NOT NULL,
     technician_id        INT UNSIGNED NOT NULL,
     technician_name      VARCHAR(255) NOT NULL,
     technician_phone     VARCHAR(32)  NOT NULL,
     assigned_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     closed_at            DATETIME(3),
     receipt_original_name VARCHAR(255),
     receipt_stored_name   VARCHAR(255),
     receipt_mime_type     VARCHAR(100),
     receipt_size_bytes    INT UNSIGNED,
     created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY preventive_services_ref_uq (ref),
     UNIQUE KEY preventive_services_ac_type_uq (crew_serial_number, service_type),
     KEY preventive_services_tech_idx (technician_id, status),
     CONSTRAINT preventive_services_ac_fk FOREIGN KEY (crew_serial_number) REFERENCES ac_units (crew_serial_number),
     CONSTRAINT preventive_services_tech_fk FOREIGN KEY (technician_id) REFERENCES technician_accounts (id),
     CONSTRAINT preventive_services_admin_fk FOREIGN KEY (requested_by_admin_id)
       REFERENCES admin_accounts (id) ON DELETE SET NULL
   ) ${TABLE_OPTS}`,

  // One row per yearly reset of preventive_services (download + empty).
  `CREATE TABLE IF NOT EXISTS preventive_service_resets (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     reset_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     admin_id    INT UNSIGNED,
     admin_name  VARCHAR(255) NOT NULL,
     rows_removed INT UNSIGNED NOT NULL,
     export_file VARCHAR(255) NOT NULL
   ) ${TABLE_OPTS}`,

  // ---- Store management ----

  // Store in-charges sign in with official email + password.
  `CREATE TABLE IF NOT EXISTS store_accounts (
     id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     name            VARCHAR(255) NOT NULL,
     email           VARCHAR(255) NOT NULL,
     contact_number  VARCHAR(32)  NOT NULL,
     password_hash   VARCHAR(100) NOT NULL,
     active          TINYINT(1)   NOT NULL DEFAULT 1,
     created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY store_accounts_email_uq (email)
   ) ${TABLE_OPTS}`,

  `CREATE TABLE IF NOT EXISTS store_sessions (
     id                 CHAR(36)     NOT NULL PRIMARY KEY,
     store_id           INT UNSIGNED NOT NULL,
     refresh_hash       CHAR(64)     NOT NULL,
     prev_refresh_hash  CHAR(64),
     rotated_at         DATETIME(3),
     created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     last_used_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     expires_at         DATETIME(3)  NOT NULL,
     revoked_at         DATETIME(3),
     user_agent         VARCHAR(300),
     ip                 VARCHAR(64),
     KEY store_sessions_store_idx (store_id),
     CONSTRAINT store_sessions_store_fk FOREIGN KEY (store_id)
       REFERENCES store_accounts (id) ON DELETE CASCADE
   ) ${TABLE_OPTS}`,

  // Store inventory. quantity is the stock in hand, in the item's unit;
  // decimal_allowed = 1 for items issued in fractions (e.g. 15.46 cm of pipe).
  `CREATE TABLE IF NOT EXISTS inventory_items (
     id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     item_code        VARCHAR(64)  NOT NULL,
     item_name        VARCHAR(255) NOT NULL,
     make             VARCHAR(120),
     unit            VARCHAR(32)  NOT NULL DEFAULT 'Nos',
     decimal_allowed  TINYINT(1)   NOT NULL DEFAULT 0,
     quantity         DECIMAL(14,3) NOT NULL DEFAULT 0,
     active           TINYINT(1)   NOT NULL DEFAULT 1,
     created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     UNIQUE KEY inventory_items_code_uq (item_code),
     KEY inventory_items_name_idx (item_name)
   ) ${TABLE_OPTS}`,

  // One row per issue ("slip") against a job card. A job card can have several
  // (issuing more later); a slip can be edited, adjusting stock by the difference.
  `CREATE TABLE IF NOT EXISTS material_issues (
     id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     job_card_id        INT UNSIGNED NOT NULL,
     mr_slip_no         VARCHAR(64)  NOT NULL,
     issued_by_store_id INT UNSIGNED,
     issued_by_name     VARCHAR(255) NOT NULL,
     issued_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at         DATETIME(3),
     updated_by_name    VARCHAR(255),
     KEY material_issues_job_idx (job_card_id),
     CONSTRAINT material_issues_job_fk FOREIGN KEY (job_card_id) REFERENCES job_cards (id),
     CONSTRAINT material_issues_store_fk FOREIGN KEY (issued_by_store_id)
       REFERENCES store_accounts (id) ON DELETE SET NULL
   ) ${TABLE_OPTS}`,

  // Items on a slip. Code/name/unit are copied so the record stays readable
  // even if the inventory item is renamed later.
  `CREATE TABLE IF NOT EXISTS material_issue_items (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     issue_id    INT UNSIGNED NOT NULL,
     item_id     INT UNSIGNED NOT NULL,
     item_code   VARCHAR(64)  NOT NULL,
     item_name   VARCHAR(255) NOT NULL,
     unit        VARCHAR(32)  NOT NULL,
     quantity    DECIMAL(14,3) NOT NULL,
     KEY material_issue_items_issue_idx (issue_id),
     KEY material_issue_items_item_idx (item_id),
     CONSTRAINT material_issue_items_issue_fk FOREIGN KEY (issue_id)
       REFERENCES material_issues (id) ON DELETE CASCADE,
     CONSTRAINT material_issue_items_item_fk FOREIGN KEY (item_id) REFERENCES inventory_items (id)
   ) ${TABLE_OPTS}`,

  // Stock received for an item (a purchase). Adds to inventory_items.quantity.
  // Files (PO / indent, invoice) are kept in uploads/store-purchases/.
  `CREATE TABLE IF NOT EXISTS inventory_purchases (
     id                    INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     item_id               INT UNSIGNED NOT NULL,
     purchase_head         VARCHAR(64)  NOT NULL,
     quantity              DECIMAL(14,3) NOT NULL,
     rate                  DECIMAL(14,2),
     po_file               VARCHAR(255),
     po_file_original      VARCHAR(255),
     po_file_mime          VARCHAR(100),
     invoice_file          VARCHAR(255),
     invoice_file_original VARCHAR(255),
     invoice_file_mime     VARCHAR(100),
     remarks               TEXT,
     added_by_store_id     INT UNSIGNED,
     added_by_name         VARCHAR(255) NOT NULL,
     created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     KEY inventory_purchases_item_idx (item_id),
     CONSTRAINT inventory_purchases_item_fk FOREIGN KEY (item_id) REFERENCES inventory_items (id),
     CONSTRAINT inventory_purchases_store_fk FOREIGN KEY (added_by_store_id)
       REFERENCES store_accounts (id) ON DELETE SET NULL
   ) ${TABLE_OPTS}`,

  // Mobile numbers people shared with the Telegram bot (one row per number),
  // used to check that a new technician is in the technicians' group.
  `CREATE TABLE IF NOT EXISTS telegram_contacts (
     mobile            VARCHAR(10)  NOT NULL PRIMARY KEY,
     telegram_user_id  BIGINT       NOT NULL,
     first_name        VARCHAR(255),
     username          VARCHAR(64),
     updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ${TABLE_OPTS}`,

  // Store memo record book: a date and a description per memo.
  `CREATE TABLE IF NOT EXISTS store_memos (
     id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     memo_date         DATE         NOT NULL,
     description       TEXT         NOT NULL,
     added_by_store_id INT UNSIGNED,
     added_by_name     VARCHAR(255) NOT NULL,
     created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     KEY store_memos_date_idx (memo_date),
     CONSTRAINT store_memos_store_fk FOREIGN KEY (added_by_store_id)
       REFERENCES store_accounts (id) ON DELETE SET NULL
   ) ${TABLE_OPTS}`,
];

async function columnExists(table, column) {
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  return Number(rows[0].n) > 0;
}

export async function initDb() {
  // arn_counters first had only (year, last_value); add the prefix so
  // preventive services get their own PS numbers. Existing rows become "JC".
  const { rows: hasCounters } = await query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'arn_counters'",
  );
  if (Number(hasCounters[0].n) && !(await columnExists("arn_counters", "prefix"))) {
    await query(
      `ALTER TABLE arn_counters
         ADD COLUMN prefix VARCHAR(8) NOT NULL DEFAULT 'JC' FIRST,
         DROP PRIMARY KEY,
         ADD PRIMARY KEY (prefix, year)`,
    );
  }

  for (const statement of SCHEMA) await query(statement);

  // Technicians: IACS or AMC staff (with the AMC's name), mobile number and
  // Telegram link. `phone` keeps holding the (now optional) extension.
  if (!(await columnExists("technician_accounts", "staff_type"))) {
    await query(
      `ALTER TABLE technician_accounts
         ADD COLUMN staff_type VARCHAR(8) NOT NULL DEFAULT 'IACS' AFTER name,
         ADD COLUMN amc_name VARCHAR(120) NULL AFTER staff_type,
         ADD COLUMN mobile VARCHAR(10) NULL AFTER amc_name,
         ADD COLUMN telegram_user_id BIGINT NULL AFTER mobile`,
    );
  }
  // Non-AC job cards: Room / Lab number (Electrical, Intercom) and the
  // Faculty / Guide / Lab In-Charge (all sections except AC).
  if (!(await columnExists("job_cards", "lab_in_charge"))) {
    await query(
      `ALTER TABLE job_cards
         ADD COLUMN room_number VARCHAR(64) NULL AFTER details_correct,
         ADD COLUMN lab_in_charge VARCHAR(255) NULL AFTER room_number`,
    );
  }
  // Job cards keep the AMC name of the technician as it was when assigned.
  if (!(await columnExists("job_cards", "technician_amc_name"))) {
    await query("ALTER TABLE job_cards ADD COLUMN technician_amc_name VARCHAR(120) NULL AFTER technician_phone");
  }

  // inventory_items got a make/brand column after it was first created.
  if (!(await columnExists("inventory_items", "make"))) {
    await query("ALTER TABLE inventory_items ADD COLUMN make VARCHAR(120) AFTER item_name");
  }

  // The first version of ac_units had only a few columns. `npm run import:ac`
  // upgrades it; until then, warn instead of failing later with odd SQL errors.
  if (await acUnitsNeedsUpgrade()) {
    console.warn("ac_units uses the old layout. Run `npm run import:ac -- <path to AC data sheet .csv>` to upgrade and load it.");
  }
}

// True when ac_units still has the original few-column layout.
export async function acUnitsNeedsUpgrade() {
  return !(await columnExists("ac_units", "sr_no"));
}
