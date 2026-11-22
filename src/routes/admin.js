// Admin panel: sign-in, dashboard page and the JSON API behind its three cards
// (job cards, AC database, preventive services), plus protected file viewing.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { query, withTransaction, nextArnNumber } from "../db.js";
import {
  SECTIONS, STATUS, PS_STATUS, PREVENTIVE_TYPES, sectionLabel, itemTypeLabel, normalizeCrewSerial,
} from "../constants.js";
import { AC_FIELDS, validateAc } from "../ac-fields.js";
import { analyseCsv, templateCsv } from "../ac-import.js";
import { keytagPdf } from "../keytag.js";
import { jobCardPdf } from "../jobcard-pdf.js";
import { verifyAdmin, startSession, endSession, getAdmin, requireAdmin } from "../auth/admin-auth.js";
import { sameOriginOnly } from "../auth/session-auth.js";
import { UPLOAD_DIR } from "./api.js";

export const EXPORT_DIR = path.resolve("exports");
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const router = Router();
const PAGE_SIZE = 20;

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(sameOriginOnly);

// ---------- helpers ----------

const IST = { timeZone: "Asia/Kolkata" };
const fmt = (d) => (d ? new Date(d).toLocaleString("en-IN", { ...IST, dateStyle: "medium", timeStyle: "short" }) : null);
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", dateStyle: "medium" }) : null);
const likeArg = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const pageOf = (req) => Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
const text = (v, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const paged = (items, total, page) => ({ items, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// ---------- sign in / out ----------

const title = "Admin Login";
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) =>
    res.status(429).render("admin/login", { title, error: "Too many wrong attempts. Please wait 15 minutes and try again.", email: "" }),
});

router.get("/login", asyncRoute(async (req, res) => {
  if (await getAdmin(req, res)) return res.redirect("/admin");
  res.render("admin/login", { title, error: null, email: "" });
}));

router.post("/login", loginLimiter, asyncRoute(async (req, res) => {
  const email = text(req.body.email, 255);
  const admin = await verifyAdmin(email, String(req.body.password ?? ""));
  if (!admin) {
    return res.status(401).render("admin/login", { title, error: "Wrong email or password.", email });
  }
  await startSession(res, admin, req);
  res.redirect("/admin");
}));

router.post("/logout", asyncRoute(async (req, res) => {
  await endSession(req, res);
  res.redirect("/admin/login");
}));

// Everything below needs a signed-in admin.
router.use(requireAdmin);

router.get("/", (req, res) => {
  res.render("admin/dashboard", {
    title: "Admin",
    hideNotice: true,
    acFields: AC_FIELDS,
    preventiveTypes: PREVENTIVE_TYPES,
  });
});

// ---------- technicians ----------

async function techniciansFor(section) {
  const { rows } = await query(
    "SELECT id, name, phone FROM technician_accounts WHERE section = ? AND active = 1 ORDER BY name",
    [section],
  );
  return rows;
}

// ---------- job cards ----------

router.get("/api/job-cards", asyncRoute(async (req, res) => {
  const where = [];
  const args = [];
  const section = text(req.query.section, 32);
  if (SECTIONS.some((s) => s.value === section)) { where.push("jc.section = ?"); args.push(section); }

  const status = text(req.query.status, 16);
  if (status === "open") { where.push("jc.status <> ?"); args.push(STATUS.CLOSED); }
  else if (status === "unassigned") { where.push("jc.technician_id IS NULL AND jc.status <> ?"); args.push(STATUS.CLOSED); }
  else if (status === "closed") { where.push("jc.status = ?"); args.push(STATUS.CLOSED); }

  const q = text(req.query.q);
  if (q) {
    where.push("(jc.arn LIKE ? OR jc.crew_serial_number LIKE ? OR jc.crew_serial_number = ?)");
    args.push(likeArg(q), likeArg(q), normalizeCrewSerial(q));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = pageOf(req);

  const { rows: [{ n }] } = await query(`SELECT COUNT(*) AS n FROM job_cards jc ${whereSql}`, args);
  const { rows } = await query(
    `SELECT jc.arn, jc.created_at, jc.first_name, jc.last_name, jc.department, jc.section,
            jc.crew_serial_number, jc.status, jc.technician_id, jc.assigned_at, COALESCE(t.name, jc.technician_name) AS technician
       FROM job_cards jc LEFT JOIN technician_accounts t ON t.id = jc.technician_id
       ${whereSql}
      ORDER BY jc.created_at DESC
      LIMIT ? OFFSET ?`,
    [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  res.json(paged(rows.map((r) => ({
    arn: r.arn,
    submittedOn: fmt(r.created_at),
    indentor: `${r.first_name} ${r.last_name}`,
    department: r.department,
    section: sectionLabel(r.section),
    crewSerialNumber: r.crew_serial_number,
    status: r.status,
    technician: r.technician,
    receiptUrl: r.assigned_at ? `/admin/api/job-cards/${encodeURIComponent(r.arn)}/jobcard.pdf` : null,
  })), Number(n), page));
}));

// Printable job card (with the Materials Issued Sheet), once a technician is assigned.
router.get("/api/job-cards/:arn/jobcard.pdf", asyncRoute(async (req, res) => {
  const { rows: [jc] } = await query(
    `SELECT jc.*, COALESCE(t.name, jc.technician_name) AS tech_name, COALESCE(t.phone, jc.technician_phone) AS tech_phone,
            a.in_charge AS ac_in_charge, a.room_number AS ac_room_number, a.brand AS ac_brand, a.amc AS ac_amc,
            a.amc_work_order_no AS ac_amc_work_order_no, a.amc_start_date AS ac_amc_start_date, a.amc_end_date AS ac_amc_end_date
       FROM job_cards jc
       LEFT JOIN technician_accounts t ON t.id = jc.technician_id
       LEFT JOIN ac_units a ON a.crew_serial_number = jc.crew_serial_number
      WHERE jc.arn = ?`,
    [String(req.params.arn).toUpperCase()],
  );
  if (!jc) throw httpError(404, "Job card not found.");
  if (!jc.assigned_at) throw httpError(409, "Assign a technician first; the job card PDF is available after that.");
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="jobcard-${jc.arn}.pdf"` });
  jobCardPdf(jc).pipe(res);
}));

router.get("/api/job-cards/:arn", asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT jc.*, COALESCE(t.name, jc.technician_name) AS tech_name, COALESCE(t.phone, jc.technician_phone) AS tech_phone
       FROM job_cards jc LEFT JOIN technician_accounts t ON t.id = jc.technician_id
      WHERE jc.arn = ?`,
    [String(req.params.arn).toUpperCase()],
  );
  const jc = rows[0];
  if (!jc) throw httpError(404, "Job card not found.");
  const { rows: files } = await query(
    "SELECT id, original_name, mime_type, size_bytes, kind, uploaded_at FROM job_card_attachments WHERE job_card_id = ? ORDER BY id",
    [jc.id],
  );
  res.json({
    arn: jc.arn,
    status: jc.status,
    closed: jc.status === STATUS.CLOSED,
    section: jc.section,
    sectionLabel: sectionLabel(jc.section),
    indentor: `${jc.first_name} ${jc.last_name}`,
    email: jc.email,
    contact: jc.contact_number,
    department: jc.department,
    itemType: jc.item_type ? itemTypeLabel(jc.item_type) : null,
    crewSerialNumber: jc.crew_serial_number,
    detailsCorrect: jc.details_correct === null ? null : Boolean(jc.details_correct),
    description: jc.description,
    submittedOn: fmt(jc.created_at),
    technicianId: jc.technician_id,
    technician: jc.tech_name,
    technicianPhone: jc.tech_phone,
    assignedAt: fmt(jc.assigned_at),
    materials: jc.materials_issued,
    materialIssuedAt: fmt(jc.material_issued_at),
    closedAt: fmt(jc.closed_at),
    receiptUrl: jc.assigned_at ? `/admin/api/job-cards/${encodeURIComponent(jc.arn)}/jobcard.pdf` : null,
    files: files.map((f) => ({
      url: `/admin/files/attachment/${f.id}`,
      name: f.original_name,
      kind: f.kind === "SIGNED_RECEIPT" ? "Signed receipt" : "Indentor upload",
      sizeKb: Math.ceil(f.size_bytes / 1024),
    })),
    technicians: await techniciansFor(jc.section),
  });
}));

router.post("/api/job-cards/:arn/assign", asyncRoute(async (req, res) => {
  const arn = String(req.params.arn).toUpperCase();
  const technicianId = Number(req.body?.technicianId);
  if (!Number.isInteger(technicianId) || technicianId < 1) throw httpError(400, "Choose a technician.");

  const result = await withTransaction(async (tx) => {
    const { rows: [jc] } = await tx.query("SELECT id, section, status FROM job_cards WHERE arn = ? FOR UPDATE", [arn]);
    if (!jc) throw httpError(404, "Job card not found.");
    if (jc.status === STATUS.CLOSED) throw httpError(409, "This job card is already closed.");
    const { rows: [tech] } = await tx.query(
      "SELECT id, name, phone, section FROM technician_accounts WHERE id = ? AND active = 1",
      [technicianId],
    );
    if (!tech) throw httpError(400, "That technician is not available.");
    if (tech.section !== jc.section) throw httpError(400, "That technician works in a different section.");

    // A newly assigned job moves to TECHNICIAN ASSIGNED; a job already further
    // along (e.g. material issued) keeps its status when reassigned.
    const nextStatus = jc.status === STATUS.SUBMITTED ? STATUS.TECHNICIAN_ASSIGNED : jc.status;
    await tx.query(
      `UPDATE job_cards
          SET technician_id = ?, technician_name = ?, technician_phone = ?, assigned_at = UTC_TIMESTAMP(3),
              status = ?, updated_at = UTC_TIMESTAMP(3)
        WHERE id = ?`,
      [tech.id, tech.name, tech.phone, nextStatus, jc.id],
    );
    return { status: nextStatus, technician: tech.name };
  });
  res.json(result);
}));

// ---------- protected files ----------

function sendStored(res, storedName, mime, originalName) {
  const full = path.resolve(UPLOAD_DIR, storedName);
  if (!full.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(full)) throw httpError(404, "File not found.");
  res.set({
    "Content-Type": mime,
    "Content-Disposition": `inline; filename="${encodeURIComponent(originalName)}"`,
    "Content-Security-Policy": "sandbox", // never run anything inside an uploaded file
  });
  res.sendFile(full);
}

router.get("/files/attachment/:id", asyncRoute(async (req, res) => {
  const { rows: [f] } = await query(
    "SELECT stored_name, mime_type, original_name FROM job_card_attachments WHERE id = ?",
    [Number(req.params.id) || 0],
  );
  if (!f) throw httpError(404, "File not found.");
  sendStored(res, f.stored_name, f.mime_type, f.original_name);
}));

router.get("/files/preventive/:ref", asyncRoute(async (req, res) => {
  const { rows: [ps] } = await query(
    "SELECT receipt_stored_name, receipt_mime_type, receipt_original_name FROM preventive_services WHERE ref = ?",
    [String(req.params.ref).toUpperCase()],
  );
  if (!ps?.receipt_stored_name) throw httpError(404, "File not found.");
  sendStored(res, ps.receipt_stored_name, ps.receipt_mime_type, ps.receipt_original_name);
}));

// ---------- AC database ----------

const crewFor = (srNo) => `IACS/CREW/AC/${String(srNo).padStart(5, "0")}`;

// Highest SR No. + 1. FOR UPDATE locks the top of the index so two inserts in
// flight can't both read the same number.
async function nextSrNo(tx) {
  const { rows } = await tx.query("SELECT COALESCE(MAX(sr_no), 0) AS n FROM ac_units FOR UPDATE");
  return Number(rows[0].n) + 1;
}

// ---- Bulk import from CSV ----

router.get("/api/ac-units/template.csv", (_req, res) => {
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="ac-units-import-template.csv"' });
  res.send(templateCsv());
});

const csvBody = express.text({ type: ["text/csv", "text/plain", "application/vnd.ms-excel"], limit: "5mb" });
const readCsv = (req) => {
  if (typeof req.body !== "string" || !req.body.trim()) throw httpError(400, "Choose a CSV file to upload.");
  return req.body;
};
const allSrNos = async (q) => new Set((await q("SELECT sr_no FROM ac_units")).rows.map((r) => Number(r.sr_no)));

// Check a file and show what would happen; nothing is written.
router.post("/api/ac-units/import/preview", csvBody, asyncRoute(async (req, res) => {
  const result = analyseCsv(readCsv(req), await allSrNos(query));
  if (result.fatal) throw httpError(400, result.fatal);
  res.json({
    counts: result.counts,
    problems: result.problems.slice(0, 200),
    moreProblems: Math.max(0, result.problems.length - 200),
    unknownColumns: result.unknownColumns,
    missingColumns: result.missingColumns,
    total: result.rows.length,
    sample: result.rows.slice(0, 100).map((r) => ({
      line: r.line,
      action: r.action,
      crewSerialNumber: r.srNo ? crewFor(r.srNo) : null,
      brand: r.data.brand,
      roomNumber: r.data.room_number,
      inCharge: r.data.in_charge,
      school: r.data.school,
      amc: r.data.amc,
    })),
  });
}));

// Import for real: all rows or none. Re-checks the file inside the transaction.
router.post("/api/ac-units/import/commit", csvBody, asyncRoute(async (req, res) => {
  const text = readCsv(req);
  const outcome = await withTransaction(async (tx) => {
    // Lock the AC table's rows so numbering can't race with another import/add.
    const existing = new Set((await tx.query("SELECT sr_no FROM ac_units FOR UPDATE")).rows.map((r) => Number(r.sr_no)));
    const result = analyseCsv(text, existing);
    if (result.fatal) throw httpError(400, result.fatal);
    if (result.counts.error) throw httpError(400, `${result.counts.error} row(s) have problems. Fix them and preview again.`);

    let next = Math.max(0, ...existing, ...result.rows.map((r) => r.srNo ?? 0)) + 1;
    const insertCols = ["crew_serial_number", "sr_no", ...EDIT_COLS];
    const added = [];
    let updated = 0;
    for (const r of result.rows) {
      if (r.action === "update") {
        if (!r.provided.length) continue;
        await tx.query(
          `UPDATE ac_units SET ${r.provided.map((k) => `${k} = ?`).join(", ")}, updated_at = UTC_TIMESTAMP(3) WHERE sr_no = ?`,
          [...r.provided.map((k) => r.data[k]), r.srNo],
        );
        updated++;
      } else {
        const srNo = r.srNo ?? next++;
        await tx.query(
          `INSERT INTO ac_units (${insertCols.join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`,
          [crewFor(srNo), srNo, ...EDIT_COLS.map((k) => r.data[k])],
        );
        added.push(srNo);
      }
    }
    return { added: added.length, updated, newFrom: added.length ? crewFor(Math.min(...added)) : null, newTo: added.length ? crewFor(Math.max(...added)) : null };
  });
  res.json(outcome);
}));

// Printable keytag (PDF with a QR code of the CREW serial number). Not stored.
router.get("/api/ac-units/:sr/keytag.pdf", asyncRoute(async (req, res) => {
  const { rows: [ac] } = await query("SELECT crew_serial_number FROM ac_units WHERE sr_no = ?", [Number(req.params.sr) || 0]);
  if (!ac) throw httpError(404, "AC not found.");
  const file = `keytag-${ac.crew_serial_number.replace(/\//g, "-")}.pdf`;
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${file}"` });
  keytagPdf(ac.crew_serial_number).pipe(res);
}));

// The number the next new AC will get (shown in the Add AC form).
router.get("/api/ac-units/next", asyncRoute(async (_req, res) => {
  const { rows } = await query("SELECT COALESCE(MAX(sr_no), 0) + 1 AS n FROM ac_units");
  res.json({ srNo: Number(rows[0].n), crewSerialNumber: crewFor(Number(rows[0].n)) });
}));

// Search ACs by CREW number (full or just the number), room, in-charge, school or brand.
// `t` is an optional table alias such as "a.".
function acSearch(q, t = "") {
  if (!q) return { sql: "", args: [] };
  const like = likeArg(q);
  return {
    sql: `AND (${t}crew_serial_number LIKE ? OR ${t}crew_serial_number = ? OR ${t}room_number LIKE ?
              OR ${t}in_charge LIKE ? OR ${t}school LIKE ? OR ${t}brand LIKE ?)`,
    args: [like, normalizeCrewSerial(q), like, like, like, like],
  };
}

router.get("/api/ac-units", asyncRoute(async (req, res) => {
  const { sql, args } = acSearch(text(req.query.q));
  const page = pageOf(req);
  const { rows: [{ n }] } = await query(`SELECT COUNT(*) AS n FROM ac_units WHERE 1=1 ${sql}`, args);
  const { rows } = await query(
    `SELECT sr_no, crew_serial_number, brand, ac_type, capacity_tr, room_number, in_charge, school, amc
       FROM ac_units WHERE 1=1 ${sql}
      ORDER BY sr_no LIMIT ? OFFSET ?`,
    [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  res.json(paged(rows, Number(n), page));
}));

router.get("/api/ac-units/:sr", asyncRoute(async (req, res) => {
  const { rows: [ac] } = await query("SELECT * FROM ac_units WHERE sr_no = ?", [Number(req.params.sr) || 0]);
  if (!ac) throw httpError(404, "AC not found.");
  res.json(ac);
}));

const acErrors = (errors) => Object.assign(httpError(400, "Please correct the highlighted fields."), { errors });
const EDIT_COLS = AC_FIELDS.map((f) => f.key).filter((k) => k !== "sr_no");

// New ACs get the next number after the highest one in the database (like an
// auto-increment id): if the last is IACS/CREW/AC/00190 the next is ...00191.
// Two admins adding at the same moment can collide on the unique key, so retry.
router.post("/api/ac-units", asyncRoute(async (req, res) => {
  const { data, errors } = validateAc({ ...(req.body ?? {}), sr_no: "" });
  if (Object.keys(errors).length) throw acErrors(errors);
  const cols = ["crew_serial_number", "sr_no", ...EDIT_COLS];
  for (let attempt = 1; ; attempt++) {
    try {
      const created = await withTransaction(async (tx) => {
        const srNo = await nextSrNo(tx);
        await tx.query(
          `INSERT INTO ac_units (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          [crewFor(srNo), srNo, ...EDIT_COLS.map((k) => data[k])],
        );
        return { crewSerialNumber: crewFor(srNo), srNo };
      });
      return res.status(201).json(created);
    } catch (err) {
      if (err.code !== "ER_DUP_ENTRY" || attempt >= 3) throw err;
    }
  }
}));

router.put("/api/ac-units/:sr", asyncRoute(async (req, res) => {
  const srNo = Number(req.params.sr) || 0;
  const { data, errors } = validateAc({ ...(req.body ?? {}), sr_no: String(srNo) });
  if (Object.keys(errors).length) throw acErrors(errors);
  const { rowCount } = await query(
    `UPDATE ac_units SET ${EDIT_COLS.map((k) => `${k} = ?`).join(", ")}, updated_at = UTC_TIMESTAMP(3) WHERE sr_no = ?`,
    [...EDIT_COLS.map((k) => data[k]), srNo],
  );
  if (!rowCount) throw httpError(404, "AC not found.");
  res.json({ ok: true });
}));

router.delete("/api/ac-units/:sr", asyncRoute(async (req, res) => {
  const { rows: [ac] } = await query("SELECT crew_serial_number FROM ac_units WHERE sr_no = ?", [Number(req.params.sr) || 0]);
  if (!ac) throw httpError(404, "AC not found.");
  const { rows: [use] } = await query(
    `SELECT (SELECT COUNT(*) FROM job_cards WHERE crew_serial_number = ?) AS jobs,
            (SELECT COUNT(*) FROM preventive_services WHERE crew_serial_number = ?) AS services`,
    [ac.crew_serial_number, ac.crew_serial_number],
  );
  if (Number(use.jobs) || Number(use.services)) {
    throw httpError(409, `${ac.crew_serial_number} has ${use.jobs} job card(s) and ${use.services} preventive service(s), so it can't be deleted. Edit it instead.`);
  }
  await query("DELETE FROM ac_units WHERE crew_serial_number = ?", [ac.crew_serial_number]);
  res.json({ ok: true });
}));

// ---------- preventive services ----------

router.get("/api/technicians", asyncRoute(async (req, res) => {
  const section = text(req.query.section, 32);
  if (!SECTIONS.some((s) => s.value === section)) throw httpError(400, "Unknown section.");
  res.json(await techniciansFor(section));
}));

// ACs under AMC, with the service types already raised this year.
router.get("/api/preventive/acs", asyncRoute(async (req, res) => {
  const { sql, args } = acSearch(text(req.query.q), "a.");
  const page = pageOf(req);
  const amcSql = `WHERE a.amc = 'Yes' ${sql}`;
  const { rows: [{ n }] } = await query(`SELECT COUNT(*) AS n FROM ac_units a ${amcSql}`, args);
  const { rows } = await query(
    `SELECT a.sr_no, a.crew_serial_number, a.brand, a.capacity_tr, a.room_number, a.in_charge, a.school,
            a.amc_end_date, GROUP_CONCAT(ps.service_type ORDER BY ps.service_type) AS done
       FROM ac_units a LEFT JOIN preventive_services ps ON ps.crew_serial_number = a.crew_serial_number
       ${amcSql}
      GROUP BY a.crew_serial_number
      ORDER BY a.sr_no LIMIT ? OFFSET ?`,
    [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  res.json(paged(rows.map((r) => ({
    crewSerialNumber: r.crew_serial_number,
    brand: r.brand,
    capacity: r.capacity_tr,
    roomNumber: r.room_number,
    inCharge: r.in_charge,
    school: r.school,
    amcEnd: fmtDay(r.amc_end_date),
    done: r.done ? String(r.done).split(",").map(Number) : [],
  })), Number(n), page));
}));

router.post("/api/preventive/services", asyncRoute(async (req, res) => {
  const crew = normalizeCrewSerial(req.body?.crewSerialNumber);
  const serviceType = Number(req.body?.serviceType);
  const technicianId = Number(req.body?.technicianId);
  const errors = {};
  if (!PREVENTIVE_TYPES.some((t) => t.value === serviceType)) errors.serviceType = "Choose the preventive service type.";
  if (!Number.isInteger(technicianId) || technicianId < 1) errors.technicianId = "Choose a technician.";
  if (Object.keys(errors).length) throw Object.assign(httpError(400, "Please complete the form."), { errors });

  const admin = req.admin;
  const ref = await withTransaction(async (tx) => {
    const { rows: [ac] } = await tx.query("SELECT crew_serial_number, amc FROM ac_units WHERE crew_serial_number = ? FOR UPDATE", [crew]);
    if (!ac) throw httpError(404, "AC not found.");
    if (ac.amc !== "Yes") throw httpError(400, "This AC is not under AMC.");
    const { rows: [tech] } = await tx.query(
      "SELECT id, name, phone, section FROM technician_accounts WHERE id = ? AND active = 1", [technicianId],
    );
    if (!tech || tech.section !== "AC_REFRIGERATION") {
      throw Object.assign(httpError(400, "Choose an AC & Refrigeration technician."), { errors: { technicianId: "Choose an AC & Refrigeration technician." } });
    }
    const { rowCount: done } = await tx.query(
      "SELECT 1 FROM preventive_services WHERE crew_serial_number = ? AND service_type = ?", [crew, serviceType],
    );
    if (done) {
      throw Object.assign(httpError(409, `Preventive Service ${serviceType} has already been raised for this AC.`), { errors: { serviceType: "Already raised for this AC." } });
    }
    const year = new Date().getFullYear();
    const newRef = `PS${year}${String(await nextArnNumber(tx, year, "PS")).padStart(6, "0")}`;
    await tx.query(
      `INSERT INTO preventive_services
         (ref, crew_serial_number, service_type, status, requested_by_admin_id, requester_name, requester_email,
          requester_contact, requester_department, technician_id, technician_name, technician_phone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newRef, crew, serviceType, PS_STATUS.ASSIGNED, admin.id, admin.name, admin.email,
       admin.contact_number, admin.department, tech.id, tech.name, tech.phone],
    );
    return newRef;
  });
  res.status(201).json({ ref });
}));

router.get("/api/preventive/services", asyncRoute(async (req, res) => {
  const q = text(req.query.q);
  const where = q ? "WHERE (ps.ref LIKE ? OR ps.crew_serial_number LIKE ? OR ps.crew_serial_number = ?)" : "";
  const args = q ? [likeArg(q), likeArg(q), normalizeCrewSerial(q)] : [];
  const page = pageOf(req);
  const { rows: [{ n }] } = await query(`SELECT COUNT(*) AS n FROM preventive_services ps ${where}`, args);
  const { rows } = await query(
    `SELECT ps.*, a.room_number, a.school
       FROM preventive_services ps JOIN ac_units a ON a.crew_serial_number = ps.crew_serial_number
       ${where}
      ORDER BY ps.created_at DESC LIMIT ? OFFSET ?`,
    [...args, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );
  res.json(paged(rows.map((r) => ({
    ref: r.ref,
    crewSerialNumber: r.crew_serial_number,
    place: [r.room_number, r.school].filter(Boolean).join(", "),
    serviceType: `Preventive Service ${r.service_type}`,
    status: r.status,
    technician: r.technician_name,
    requestedBy: r.requester_name,
    requestedOn: fmt(r.created_at),
    closedOn: fmt(r.closed_at),
    receiptUrl: r.receipt_stored_name ? `/admin/files/preventive/${r.ref}` : null,
  })), Number(n), page));
}));

// --- yearly reset (download + empty) ---
//
// Allowed during April (India time), once per financial year. Set
// PS_RESET_ALWAYS_ENABLED=true only to test the reset outside April.

function resetWindow(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000); // shift so UTC getters read India time
  const y = ist.getUTCFullYear();
  const fyYear = ist.getUTCMonth() >= 3 ? y : y - 1;
  const fyStartUtc = new Date(Date.UTC(fyYear, 3, 1) - 5.5 * 3600 * 1000); // 1 April 00:00 IST
  return { inApril: ist.getUTCMonth() === 3, fyYear, fyStartUtc, fyLabel: `${fyYear}-${String((fyYear + 1) % 100).padStart(2, "0")}` };
}

async function resetStatus() {
  const w = resetWindow();
  const { rows: [last] } = await query(
    "SELECT reset_at, admin_name, rows_removed FROM preventive_service_resets ORDER BY reset_at DESC LIMIT 1",
  );
  const doneThisYear = Boolean(last && new Date(last.reset_at) >= w.fyStartUtc);
  const override = process.env.PS_RESET_ALWAYS_ENABLED === "true";
  const { rows: [counts] } = await query(
    "SELECT COUNT(*) AS total, SUM(status <> ?) AS open FROM preventive_services", [PS_STATUS.CLOSED],
  );
  let reason = null;
  if (!override) {
    if (!w.inApril) reason = "The reset opens on 1 April each year.";
    else if (doneThisYear) reason = `Already reset for ${w.fyLabel}.`;
  }
  return {
    enabled: !reason,
    reason,
    fyLabel: w.fyLabel,
    total: Number(counts.total),
    open: Number(counts.open ?? 0),
    lastReset: last ? { at: fmt(last.reset_at), by: last.admin_name, rows: last.rows_removed } : null,
  };
}

router.get("/api/preventive/reset-status", asyncRoute(async (_req, res) => {
  res.json(await resetStatus());
}));

const CSV_COLUMNS = [
  ["Reference", "ref"], ["CREW SR No.", "crew_serial_number"], ["Room No.", "room_number"], ["School", "school"],
  ["In-charge", "in_charge"], ["Service type", "service_type_label"], ["Status", "status"],
  ["Technician", "technician_name"], ["Technician phone", "technician_phone"],
  ["Requested by", "requester_name"], ["Requester email", "requester_email"], ["Requester extension", "requester_contact"],
  ["Requester department", "requester_department"], ["Requested on (IST)", "created_at_ist"],
  ["Closed on (IST)", "closed_at_ist"], ["Receipt file", "receipt_stored_name"],
];
function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.post("/api/preventive/reset", asyncRoute(async (req, res) => {
  const status = await resetStatus();
  if (!status.enabled) throw httpError(403, status.reason);
  if (req.body?.confirm !== "RESET") throw httpError(400, "Type RESET to confirm.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `preventive-services-FY${status.fyLabel}-${stamp}.csv`;

  const csv = await withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT ps.*, a.room_number, a.school, a.in_charge
         FROM preventive_services ps JOIN ac_units a ON a.crew_serial_number = ps.crew_serial_number
        ORDER BY ps.created_at FOR UPDATE`,
    );
    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(",")];
    for (const r of rows) {
      const row = { ...r, service_type_label: `Preventive Service ${r.service_type}`, created_at_ist: fmt(r.created_at), closed_at_ist: fmt(r.closed_at) };
      lines.push(CSV_COLUMNS.map(([, k]) => csvCell(row[k])).join(","));
    }
    const body = `﻿${lines.join("\r\n")}\r\n`; // BOM so Excel reads UTF-8
    // Keep a copy on the server before anything is deleted.
    fs.writeFileSync(path.join(EXPORT_DIR, fileName), body);
    await tx.query("DELETE FROM preventive_services");
    await tx.query(
      "INSERT INTO preventive_service_resets (admin_id, admin_name, rows_removed, export_file) VALUES (?,?,?,?)",
      [req.admin.id, req.admin.name, rows.length, fileName],
    );
    return body;
  });

  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${fileName}"` });
  res.send(csv);
}));

// JSON errors for the admin API.
router.use((err, req, res, next) => {
  if (!req.path.startsWith("/api/") && !req.path.startsWith("/files/")) return next(err);
  if (err.expose) return res.status(err.status).json({ error: err.message, errors: err.errors });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

export default router;
