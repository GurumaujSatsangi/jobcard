// Load the IACS AC data sheet (exported as CSV) into ac_units.
//
//   npm run import:ac -- "path/to/FINAL DATA-SHEET -IACS-AC ... - AC.csv"
//   npm run import:ac -- "path/to/sheet.csv" --dry-run     (check only, change nothing)
//
// - Safe to run again with an updated sheet: rows are inserted or updated by
//   CREW SR No.; ACs missing from the sheet are left as they are.
// - Rows with only an SR No. / CREW SR No. (reserved numbers, no AC yet) are skipped.
// - "Not Available", "NIL" and blanks become empty (NULL).
// - Values that can't be read (e.g. a date like 19.11.20224) are left empty and
//   listed at the end so the sheet can be corrected.
// - If one CREW SR No. appears on several rows (same AC listed for two rooms),
//   the rows are merged and differing values are joined with " / ".
import "dotenv/config";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "csv-parse/sync";
import { pool, query, withTransaction, initDb, acUnitsNeedsUpgrade } from "../src/db.js";

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean", default: false } },
});
const file = positionals[0];
if (!file) {
  console.error('Usage: npm run import:ac -- "path/to/AC sheet.csv" [--dry-run]');
  process.exit(1);
}

// Sheet column position -> ac_units column and how to read it. Positions are
// used because the sheet repeats some headings ("AC Capicity", "Indoor Unit
// Serial Number", ...) for the replacement unit.
const COLUMNS = [
  [0, "sr_no", "int", "SR No."],
  [1, "crew_serial_number", "text", "CREW SR No."],
  [2, "gem_order_no", "text", "GEM Order No."],
  [3, "gem_order_date", "date", "Date"],
  [4, "unit_price", "money", "Unit price"],
  // 5 QTY and 6 Total are always 1 / 1.00 in the sheet, so they are not stored.
  [7, "capacity_tr", "text", "AC Capicity"],
  [8, "indoor_serial_no", "text", "Indoor Unit Serial Number"],
  [9, "outdoor_serial_no", "text", "Outdoor Unit Serial Number"],
  [10, "brand", "text", "Brand"],
  [11, "ac_type", "acType", "Split/ Window"],
  [12, "timer_installed", "yesNo", "Timer Installed (Yes/ No)"],
  [13, "working_condition", "yesNoNew", "Working Conditions as on 01-05-2023"],
  [14, "installation_date", "date", "Date of Installation"],
  [15, "room_number", "text", "Room No."],
  [16, "in_charge", "text", "Faculty / Staff / In-charge"],
  [17, "school", "text", "School"],
  [18, "under_warranty", "yesNo", "Warranty (In Years)"],
  [19, "warranty_start_date", "date", "Start Date"],
  [20, "warranty_end_date", "date", "End Date"],
  [21, "amc", "yesNoNew", "AMC"],
  [22, "amc_work_order_no", "text", "AMC Work Order No."],
  [23, "amc_start_date", "date", "AMC Start Date"],
  [24, "amc_end_date", "date", "AMC End Date"],
  [25, "purchase_type", "text", "Purchase under Replacement or New - details"],
  [26, "replaced", "yesNo", "Replace (Y/N)"],
  [27, "replacement_capacity_tr", "text", "AC Capicity (replacement)"],
  [28, "replacement_indoor_serial_no", "text", "Indoor Unit Serial Number (replacement)"],
  [29, "replacement_outdoor_serial_no", "text", "Outdoor Unit Serial Number (replacement)"],
  [30, "replacement_brand", "text", "Replaced Brand"],
  [31, "replacement_gem_order", "text", "GeM Order Details"],
  [32, "replacement_installation_date", "date", "Date of Installation (replacement)"],
  [33, "replacement_unit_price", "money", "Unit Price (replacement)"],
];
const DB_COLS = COLUMNS.map(([, col]) => col);

const AC_TYPES = {
  split: "Split", window: "Window", casset: "Cassette", cassette: "Cassette",
  ductabel: "Ductable", ductable: "Ductable", ditabel: "Ductable", "daktabel unit": "Ductable",
  package: "Package", "air handling unit": "Air Handling Unit",
};

const problems = [];
const isBlank = (v) => !v || /^(not\s*ava[il]*able|nil|n\/?a|-+)$/i.test(v);

function read(kind, raw, ctx) {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (isBlank(v)) return null;
  const bad = () => { problems.push(`${ctx.crew} – ${ctx.label}: "${v}" could not be read, left empty`); return null; };
  switch (kind) {
    case "int": return /^\d+$/.test(v) ? Number(v) : bad();
    case "money": return /^\d+(\.\d+)?$/.test(v) ? Number(v).toFixed(2) : bad(); // rounded to paise
    case "date": {
      const m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (!m) return bad();
      const [, d, mo, y] = m.map(Number);
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCMonth() !== mo - 1 || y < 1990 || y > 2100) return bad();
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    case "yesNo": {
      if (/^(y|yes)$/i.test(v)) return 1;
      if (/^(n|no)$/i.test(v)) return 0;
      return bad();
    }
    case "yesNoNew": {
      if (/^(y|yes)$/i.test(v)) return "Yes";
      if (/^(n|no)$/i.test(v)) return "No";
      if (/^new$/i.test(v)) return "New";
      return bad();
    }
    case "acType": return AC_TYPES[v.toLowerCase()] ?? v;
    default: return v;
  }
}

const rows = parse(fs.readFileSync(file, "utf8"), { relax_column_count: true, bom: true, skip_empty_lines: true });
const header = rows.shift();
if (header.length < 34 || !/crew/i.test(header[1])) {
  console.error(`This doesn't look like the AC data sheet (expected 34 columns with "CREW SR No." second, got ${header.length}).`);
  process.exit(1);
}

let skippedEmpty = 0;
const byCrew = new Map();
for (const [i, r] of rows.entries()) {
  const crewRaw = (r[1] ?? "").trim();
  if (!crewRaw) continue;
  if (!r.slice(2).some((v) => !isBlank(String(v ?? "").trim()))) { skippedEmpty++; continue; }

  const ctx = { crew: crewRaw };
  const rec = {};
  for (const [pos, col, kind, label] of COLUMNS) rec[col] = read(kind, r[pos], { ...ctx, label });
  if (rec.crew_serial_number === null || rec.sr_no === null) {
    problems.push(`line ${i + 2}: missing SR No. or CREW SR No., row skipped`);
    continue;
  }

  const prev = byCrew.get(rec.crew_serial_number);
  if (!prev) { byCrew.set(rec.crew_serial_number, rec); continue; }
  // Same AC on another row: keep both values where they differ.
  for (const col of DB_COLS) {
    if (rec[col] === null || rec[col] === prev[col]) continue;
    if (prev[col] === null) prev[col] = rec[col];
    else if (typeof prev[col] === "string" && !prev[col].split(" / ").includes(rec[col])) prev[col] = `${prev[col]} / ${rec[col]}`;
  }
  problems.push(`${rec.crew_serial_number}: listed on more than one row, merged into one record`);
}

const records = [...byCrew.values()];
console.log(`Sheet: ${rows.length} rows · ${records.length} ACs to load · ${skippedEmpty} reserved numbers with no data skipped`);

if (opts["dry-run"]) {
  printProblems();
  console.log("Dry run: nothing was written.");
  await pool.end();
  process.exit(0);
}

await initDb();
try {
  if (await acUnitsNeedsUpgrade()) await upgradeOldTable();

  let inserted = 0;
  let updated = 0;
  await withTransaction(async (tx) => {
    const placeholders = `(${DB_COLS.map(() => "?").join(",")})`;
    const updates = DB_COLS.filter((c) => c !== "crew_serial_number")
      .map((c) => `${c} = VALUES(${c})`).join(", ");
    for (let i = 0; i < records.length; i += 200) {
      const batch = records.slice(i, i + 200);
      const before = await tx.query(
        `SELECT COUNT(*) AS n FROM ac_units WHERE crew_serial_number IN (${batch.map(() => "?").join(",")})`,
        batch.map((r) => r.crew_serial_number),
      );
      await tx.query(
        `INSERT INTO ac_units (${DB_COLS.join(", ")}) VALUES ${batch.map(() => placeholders).join(",")}
         ON DUPLICATE KEY UPDATE ${updates}, updated_at = UTC_TIMESTAMP(3)`,
        batch.flatMap((r) => DB_COLS.map((c) => r[c])),
      );
      const existed = Number(before.rows[0].n);
      updated += existed;
      inserted += batch.length - existed;
    }
  });
  console.log(`Done: ${inserted} added, ${updated} updated.`);
  printProblems();
} finally {
  await pool.end();
}

function printProblems() {
  if (!problems.length) return console.log("No problems found in the sheet.");
  console.log(`\n${problems.length} things to check in the sheet:`);
  for (const p of problems) console.log(`  - ${p}`);
}

// Replace the first, few-column ac_units table with the new layout. Only done
// when it holds the original sample rows (AC-0001...), never real data.
async function upgradeOldTable() {
  const { rows: old } = await query("SELECT crew_serial_number FROM ac_units");
  const onlySamples = old.every((r) => /^AC-\d{4}$/.test(r.crew_serial_number));
  if (!onlySamples) {
    throw new Error("ac_units has the old layout but contains non-sample rows; upgrade it by hand before importing.");
  }
  const { rows: refs } = await query(
    "SELECT arn FROM job_cards WHERE crew_serial_number IN (SELECT crew_serial_number FROM ac_units)",
  );
  if (refs.length) {
    throw new Error(
      `Job cards ${refs.map((r) => r.arn).join(", ")} point at sample ACs. ` +
      "Delete them or point them at real CREW numbers first.",
    );
  }
  console.log(`Upgrading ac_units to the new layout (removing ${old.length} sample rows)...`);
  // job_cards has a foreign key to ac_units, so MySQL refuses a plain DROP.
  // No job card points at these rows (checked above), so switch the check off
  // for this one connection, drop, and recreate with the same key column.
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    await conn.query("DROP TABLE ac_units");
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
    conn.release();
  }
  await initDb(); // recreates ac_units with the new columns
}
