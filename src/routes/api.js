import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { pool, query } from "../db.js";
import { SECTIONS, AC_ITEM_TYPES, OFFICIAL_EMAIL_DOMAIN, STATUS, sectionLabel, itemTypeLabel } from "../constants.js";

export const UPLOAD_DIR = path.resolve("uploads");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only JPG, PNG, WEBP or PDF files are allowed.")),
});

const router = Router();

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : null;

function acView(row) {
  return {
    crewSerialNumber: row.crew_serial_number,
    brand: row.brand,
    inCharge: row.in_charge,
    school: row.school,
    roomNumber: row.room_number,
    amc: row.amc,
    amcWorkOrderNo: row.amc_work_order_no,
    amcStartDate: fmtDate(row.amc_start_date),
    amcEndDate: fmtDate(row.amc_end_date),
  };
}

// Look up an AC by its CREW serial number.
router.get("/ac/:crew", async (req, res, next) => {
  try {
    const crew = req.params.crew.trim().toUpperCase();
    const { rows } = await query("SELECT * FROM ac_units WHERE UPPER(crew_serial_number) = $1", [crew]);
    if (!rows[0]) {
      return res.status(404).json({ error: "No Air Conditioner found for this CREW Serial Number." });
    }
    const active = await query(
      "SELECT arn FROM job_cards WHERE crew_serial_number = $1 AND status <> $2 LIMIT 1",
      [rows[0].crew_serial_number, STATUS.CLOSED],
    );
    res.json({ ac: acView(rows[0]), activeArn: active.rows[0]?.arn ?? null });
  } catch (err) {
    next(err);
  }
});

// Check the status of a job card by ARN.
router.get("/job-cards/:arn", async (req, res, next) => {
  try {
    const arn = req.params.arn.trim().toUpperCase();
    const { rows } = await query(
      `SELECT jc.*, ta.name AS ta_name, ta.phone AS ta_phone
         FROM job_cards jc LEFT JOIN technician_accounts ta ON ta.id = jc.technician_id
        WHERE jc.arn = $1`,
      [arn],
    );
    const jc = rows[0];
    if (!jc) {
      return res.status(404).json({ error: "No Job Card Application found for this ARN." });
    }
    const ts = (d) =>
      d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : null;

    // A step counts as done once its timestamp is set.
    const steps = [
      { key: "submitted", title: "Application Submitted", at: ts(jc.created_at) },
      {
        key: "assigned",
        title: "Technician Assigned",
        at: ts(jc.assigned_at),
        details: jc.assigned_at
          ? { technician: jc.ta_name ?? jc.technician_name, phone: jc.ta_phone ?? jc.technician_phone }
          : null,
      },
      {
        key: "material",
        title: "Material Issued by Store In-Charge",
        at: ts(jc.material_issued_at),
        details: jc.material_issued_at ? { materials: jc.materials_issued } : null,
      },
      { key: "closed", title: "Application Closed", at: ts(jc.closed_at) },
    ].map((s) => ({ ...s, done: Boolean(s.at) }));

    res.json({
      arn: jc.arn,
      indentor: `${jc.first_name} ${jc.last_name}`,
      section: sectionLabel(jc.section),
      crewSerialNumber: jc.section === "AC_REFRIGERATION" ? jc.crew_serial_number : null,
      description: jc.description,
      status: jc.status,
      steps,
    });
  } catch (err) {
    next(err);
  }
});

function validate(body) {
  const errors = {};
  const s = (k) => (typeof body[k] === "string" ? body[k].trim() : "");
  const data = {
    firstName: s("firstName"),
    lastName: s("lastName"),
    email: s("email").toLowerCase(),
    contactNumber: s("contactNumber"),
    department: s("department"),
    section: s("section"),
    itemType: s("itemType") || null,
    crewSerialNumber: s("crewSerialNumber").toUpperCase() || null,
    detailsCorrect: s("detailsCorrect"),
    description: s("description"),
  };

  if (!data.firstName) errors.firstName = "First name is required.";
  if (!data.lastName) errors.lastName = "Last name is required.";
  if (!new RegExp(`^[^\\s@]+@${OFFICIAL_EMAIL_DOMAIN.replace(".", "\\.")}$`).test(data.email))
    errors.email = `Please enter your official @${OFFICIAL_EMAIL_DOMAIN} email.`;
  if (!/^\d{2,6}$/.test(data.contactNumber)) errors.contactNumber = "Enter a valid IACS extension number.";
  if (!data.department) errors.department = "This field is required.";
  if (!SECTIONS.some((x) => x.value === data.section)) errors.section = "Please select a section.";
  if (data.description.length < 5) errors.description = "Please describe the issue.";

  if (data.section === "AC_REFRIGERATION") {
    if (!AC_ITEM_TYPES.some((x) => x.value === data.itemType)) errors.itemType = "Please select the item type.";
    if (data.itemType === "AIR_CONDITIONER") {
      if (!data.crewSerialNumber) errors.crewSerialNumber = "CREW Serial Number is required.";
      if (!["yes", "no"].includes(data.detailsCorrect)) errors.detailsCorrect = "Please confirm the details.";
    } else {
      data.crewSerialNumber = null;
    }
  } else {
    data.itemType = null;
    data.crewSerialNumber = null;
  }
  data.detailsCorrect = data.crewSerialNumber ? data.detailsCorrect === "yes" : null;
  return { data, errors };
}

const removeFiles = (files = []) =>
  Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));

// Submit a new job card application.
router.post("/job-cards", (req, res, next) => {
  upload.array("attachments", 5)(req, res, async (uploadErr) => {
    if (uploadErr) {
      await removeFiles(req.files);
      const msg =
        uploadErr.code === "LIMIT_FILE_SIZE" ? "Each file must be 10 MB or smaller."
        : uploadErr.code === "LIMIT_FILE_COUNT" ? "You can attach up to 5 files."
        : uploadErr.field || uploadErr.message;
      return res.status(400).json({ error: msg, errors: { attachments: msg } });
    }

    const { data, errors } = validate(req.body);
    if (Object.keys(errors).length) {
      await removeFiles(req.files);
      return res.status(400).json({ error: "Please correct the highlighted fields.", errors });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (data.crewSerialNumber) {
        const ac = await client.query("SELECT 1 FROM ac_units WHERE crew_serial_number = $1", [data.crewSerialNumber]);
        if (!ac.rowCount) {
          throw Object.assign(new Error("Invalid CREW Serial Number."), { status: 400, field: "crewSerialNumber" });
        }
        const active = await client.query(
          "SELECT arn FROM job_cards WHERE crew_serial_number = $1 AND status <> $2 LIMIT 1",
          [data.crewSerialNumber, STATUS.CLOSED],
        );
        if (active.rowCount) {
          throw Object.assign(
            new Error(`A Job Card (${active.rows[0].arn}) for this Air Conditioner is already active and not yet completed.`),
            { status: 409, field: "crewSerialNumber" },
          );
        }
      }

      const seq = await client.query("SELECT nextval('job_card_arn_seq') AS n");
      const arn = `JC${new Date().getFullYear()}${String(seq.rows[0].n).padStart(6, "0")}`;

      const inserted = await client.query(
        `INSERT INTO job_cards
          (arn, first_name, last_name, email, contact_number, department, section,
           item_type, crew_serial_number, details_correct, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [arn, data.firstName, data.lastName, data.email, data.contactNumber, data.department,
         data.section, data.itemType, data.crewSerialNumber, data.detailsCorrect, data.description],
      );

      for (const f of req.files ?? []) {
        await client.query(
          `INSERT INTO job_card_attachments (job_card_id, original_name, stored_name, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5)`,
          [inserted.rows[0].id, f.originalname, f.filename, f.mimetype, f.size],
        );
      }

      await client.query("COMMIT");
      res.status(201).json({ arn });
    } catch (err) {
      await client.query("ROLLBACK");
      await removeFiles(req.files);
      if (err.status) {
        return res.status(err.status).json({ error: err.message, errors: { [err.field]: err.message } });
      }
      next(err);
    } finally {
      client.release();
    }
  });
});

export default router;
