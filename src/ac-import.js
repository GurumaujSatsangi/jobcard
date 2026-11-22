// Bulk import of ACs from a CSV file (admin panel → AC database → Import CSV).
//
// The template has one column per ac_units field plus "CREW Serial No.":
//   - blank CREW Serial No.  → a new AC, numbered automatically (highest + 1)
//   - CREW Serial No. given  → updates that AC if it exists (only the cells
//     filled in change; blank cells keep their current value), otherwise adds
//     it with that number
// Values are forgiving: dates as 2026-04-01, 01.04.2026, 01-04-2026 or
// 01/04/2026; Yes/No as Yes, Y, No, N, 1, 0; "Not Available" / "NA" / "-" = blank.
import { parse } from "csv-parse/sync";
import { AC_FIELDS, validateAc } from "./ac-fields.js";
import { normalizeCrewSerial } from "./constants.js";

export const MAX_IMPORT_ROWS = 5000;

const csvHeader = (f) => (f.group === "Replacement unit" && !/^replace/i.test(f.label) ? `Replacement - ${f.label}` : f.label);
const DATA_FIELDS = AC_FIELDS.filter((f) => f.key !== "sr_no");

// Template columns, in order.
export const TEMPLATE_COLUMNS = [
  { header: "CREW Serial No.", key: "crew" },
  ...DATA_FIELDS.map((f) => ({ header: csvHeader(f), key: f.key, field: f })),
];

export function templateCsv() {
  return `﻿${TEMPLATE_COLUMNS.map((c) => (/[",]/.test(c.header) ? `"${c.header}"` : c.header)).join(",")}\r\n`;
}

const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isBlank = (v) => !v || /^(not\s*ava[il]*able|n\/?a|nil|-+)$/i.test(v);

// Turn a cell into the shape validateAc() expects.
function normalise(field, raw) {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (isBlank(v)) return "";
  switch (field.type) {
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const m = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : v;
    }
    case "yesno":
      if (/^(y|yes|true|1)$/i.test(v)) return "1";
      if (/^(n|no|false|0)$/i.test(v)) return "0";
      return v;
    case "choice":
      return field.options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? v;
    case "money":
      return v.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    default:
      return v;
  }
}

/**
 * Parse and check a CSV. `existing` is a Set of SR Nos already in the database.
 * Returns { rows, counts, problems, unknownColumns, missingColumns } without
 * touching the database.
 */
export function analyseCsv(text, existing) {
  let records;
  try {
    records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return { fatal: `This file couldn't be read as CSV (${err.message}).` };
  }
  if (records.length < 2) return { fatal: "The file has no data rows. Fill in the template below the header row." };
  if (records.length - 1 > MAX_IMPORT_ROWS) return { fatal: `Import up to ${MAX_IMPORT_ROWS} rows at a time.` };

  // Match headers by template header or field key, ignoring case/spaces/punctuation.
  const lookup = new Map();
  for (const c of TEMPLATE_COLUMNS) {
    lookup.set(squash(c.header), c);
    lookup.set(squash(c.key), c);
    if (c.field) lookup.set(squash(c.field.label), lookup.get(squash(c.field.label)) ?? c);
  }
  lookup.set(squash("CREW SR No."), TEMPLATE_COLUMNS[0]);
  lookup.set(squash("CREW Serial Number"), TEMPLATE_COLUMNS[0]);

  const header = records[0];
  const columns = header.map((h) => lookup.get(squash(h)) ?? null);
  const unknownColumns = header.filter((h, i) => h && !columns[i]);
  if (!columns.some((c) => c && c.key !== "crew")) {
    return { fatal: "None of the column headings match the template. Download the template and use its header row." };
  }
  const seen = new Set(columns.filter(Boolean).map((c) => c.key));
  const missingColumns = TEMPLATE_COLUMNS.filter((c) => !seen.has(c.key)).map((c) => c.header);

  const rows = [];
  const usedSr = new Map(); // sr_no -> line, to catch duplicates in the file
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (!rec.some((v) => String(v).trim())) continue;
    const line = i + 1;
    const input = {};
    const provided = new Set();
    let crewRaw = "";
    columns.forEach((c, idx) => {
      if (!c) return;
      if (c.key === "crew") { crewRaw = String(rec[idx] ?? "").trim(); return; }
      const v = normalise(c.field, rec[idx]);
      input[c.key] = v;
      if (v !== "") provided.add(c.key);
    });

    const errors = {};
    let srNo = null;
    if (crewRaw && !isBlank(crewRaw)) {
      const crew = normalizeCrewSerial(crewRaw);
      const m = crew.match(/^IACS\/CREW\/AC\/(\d{5})$/);
      if (!m || Number(m[1]) < 1) errors.crew = `"${crewRaw}" isn't a CREW Serial No. (e.g. IACS/CREW/AC/00042 or 42).`;
      else srNo = Number(m[1]);
    }
    if (srNo !== null) {
      if (usedSr.has(srNo)) errors.crew = `Same CREW Serial No. as line ${usedSr.get(srNo)}.`;
      else usedSr.set(srNo, line);
    }

    const { data, errors: fieldErrors } = validateAc({ ...input, sr_no: "" });
    Object.assign(errors, fieldErrors);
    if (srNo === null && provided.size === 0 && !errors.crew) errors.row = "The row is empty.";

    const action = Object.keys(errors).length ? "error" : srNo !== null && existing.has(srNo) ? "update" : "add";
    rows.push({ line, action, srNo, data, provided: [...provided], errors });
  }

  const counts = { add: 0, update: 0, error: 0 };
  for (const r of rows) counts[r.action]++;
  const label = (k) => TEMPLATE_COLUMNS.find((c) => c.key === k)?.header ?? k;
  const problems = rows
    .filter((r) => r.action === "error")
    .flatMap((r) => Object.entries(r.errors).map(([k, msg]) => `Line ${r.line}${k === "row" ? "" : ` – ${label(k)}`}: ${msg}`));
  return { rows, counts, problems, unknownColumns, missingColumns };
}
