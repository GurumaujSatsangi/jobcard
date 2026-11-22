import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { query, withTransaction } from "../db.js";
import { STATUS, PS_STATUS, sectionLabel, normalizeCrewSerial } from "../constants.js";
import {
  PASSCODE_LENGTH,
  verifyPasscode,
  startSession,
  endSession,
  getTechnician,
  requireTechnician,
  sameOriginOnly,
} from "../auth/technician-auth.js";

export const RECEIPT_DIR = path.resolve("uploads", "receipts");
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// Receipts are photos taken with the phone camera.
const RECEIPT_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: RECEIPT_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, RECEIPT_MIME.has(file.mimetype)),
}).single("receipt");

const router = Router();

// Technician pages hold personal data; never cache them.
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(sameOriginOnly);

const title = "Technician Login";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) =>
    res.status(429).render("technician/login", {
      title,
      error: "Too many wrong attempts. Please wait 15 minutes and try again.",
    }),
});

router.get("/login", async (req, res, next) => {
  try {
    if (await getTechnician(req, res)) return res.redirect("/technician");
    res.render("technician/login", { title, error: null });
  } catch (err) {
    next(err);
  }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const passcode = String(req.body.passcode ?? "").trim();
    const tech = await verifyPasscode(passcode);
    if (!tech) {
      return res.status(401).render("technician/login", {
        title,
        error: "Wrong passcode. Please check and try again.",
      });
    }
    await startSession(res, tech, req);
    res.redirect("/technician");
  } catch (err) {
    next(err);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await endSession(req, res);
    res.redirect("/technician/login");
  } catch (err) {
    next(err);
  }
});

const fmt = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : null;

// Open jobs assigned to this technician, in their own section only.
async function openJobsFor(tech) {
  const { rows } = await query(
    `SELECT arn, first_name, last_name, contact_number, department, crew_serial_number,
            description, assigned_at
       FROM job_cards
      WHERE technician_id = ? AND section = ? AND status <> ? AND assigned_at IS NOT NULL
      ORDER BY assigned_at ASC`,
    [tech.id, tech.section, STATUS.CLOSED],
  );
  const jobs = rows.map((r) => ({
    kind: "job",
    arn: r.arn,
    action: `/technician/job-cards/${encodeURIComponent(r.arn)}/receipt`,
    indentor: `${r.first_name} ${r.last_name}`,
    contact: r.contact_number,
    department: r.department,
    crew: r.crew_serial_number,
    description: r.description,
    assignedAt: fmt(r.assigned_at),
    sortAt: r.assigned_at,
  }));

  // Preventive services (AC section only), shown with a "Preventive Service" badge.
  const { rows: ps } = await query(
    `SELECT ps.ref, ps.service_type, ps.assigned_at, ps.requester_name, ps.requester_contact,
            ps.crew_serial_number, a.room_number, a.school, a.in_charge
       FROM preventive_services ps JOIN ac_units a ON a.crew_serial_number = ps.crew_serial_number
      WHERE ps.technician_id = ? AND ps.status = ?`,
    [tech.id, PS_STATUS.ASSIGNED],
  );
  const services = ps.map((r) => ({
    kind: "preventive",
    arn: r.ref,
    action: `/technician/preventive-services/${encodeURIComponent(r.ref)}/receipt`,
    serviceType: `Preventive Service ${r.service_type}`,
    indentor: r.requester_name,
    contact: r.requester_contact,
    department: [r.room_number, r.school].filter(Boolean).join(", "),
    inCharge: r.in_charge,
    crew: r.crew_serial_number,
    assignedAt: fmt(r.assigned_at),
    sortAt: r.assigned_at,
  }));

  return [...jobs, ...services].sort((a, b) => new Date(a.sortAt) - new Date(b.sortAt));
}

// Service history of an AC: every job card raised for a CREW serial number,
// newest first. Typed in ("IACS/CREW/AC/00042", "42") or scanned from the keytag.
router.get("/api/service-history", requireTechnician, async (req, res, next) => {
  try {
    const crew = normalizeCrewSerial(typeof req.query.crew === "string" ? req.query.crew.slice(0, 40) : "");
    if (!/^IACS\/CREW\/AC\/\d{5}$/.test(crew)) {
      return res.status(400).json({ error: "Enter a CREW Serial Number, e.g. IACS/CREW/AC/00042 or just 42." });
    }
    const { rows: [ac] } = await query(
      "SELECT crew_serial_number, brand, ac_type, capacity_tr, room_number, in_charge, school FROM ac_units WHERE crew_serial_number = ?",
      [crew],
    );
    if (!ac) return res.status(404).json({ error: `No AC found for ${crew}.` });
    const { rows } = await query(
      `SELECT jc.arn, jc.description, jc.status, jc.materials_issued, jc.created_at, jc.assigned_at, jc.closed_at,
              COALESCE(t.name, jc.technician_name) AS tech_name, COALESCE(t.phone, jc.technician_phone) AS tech_phone
         FROM job_cards jc LEFT JOIN technician_accounts t ON t.id = jc.technician_id
        WHERE jc.crew_serial_number = ?
        ORDER BY jc.created_at DESC
        LIMIT 200`,
      [crew],
    );
    res.json({
      ac: {
        crewSerialNumber: ac.crew_serial_number,
        brand: ac.brand,
        type: [ac.ac_type, ac.capacity_tr && `${ac.capacity_tr} Ton`].filter(Boolean).join(", ") || null,
        place: [ac.room_number, ac.school].filter(Boolean).join(", ") || null,
        inCharge: ac.in_charge,
      },
      history: rows.map((r) => ({
        arn: r.arn,
        issue: r.description,
        status: r.status,
        closed: r.status === STATUS.CLOSED,
        materials: r.materials_issued,
        submittedOn: fmt(r.created_at),
        assignedOn: fmt(r.assigned_at),
        completedOn: fmt(r.closed_at),
        technician: r.tech_name ? `${r.tech_name}${r.tech_phone ? ` (Ext. ${r.tech_phone})` : ""}` : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// One-time messages after a POST (Post/Redirect/Get). Carried in a short-lived,
// signed, httpOnly cookie instead of the URL, and cleared as soon as it is shown.
const FLASH_COOKIE = "jc_flash";
const flashOpts = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/technician",
  signed: true,
};

function setFlash(res, flash) {
  res.cookie(FLASH_COOKIE, flash, { ...flashOpts, maxAge: 60 * 1000 });
}

function takeFlash(req, res) {
  const flash = req.signedCookies?.[FLASH_COOKIE];
  if (flash === undefined) return null;
  res.clearCookie(FLASH_COOKIE, flashOpts);
  return flash && typeof flash === "object" ? flash : null;
}

const ERRORS = {
  nofile: "Please take a photo of the signed receipt.",
  notfound: "This job is not assigned to you, or it is already closed.",
  upload: "The photo could not be uploaded. Please take it again.",
};

const fail = (res, code) => {
  setFlash(res, { type: "error", code });
  res.redirect("/technician");
};

router.get("/", requireTechnician, async (req, res, next) => {
  try {
    const flash = takeFlash(req, res);
    res.render("technician/dashboard", {
      title: "My Jobs",
      jobs: await openJobsFor(req.technician),
      sectionName: sectionLabel(req.technician.section),
      done: flash?.type === "done" ? flash.arn : null,
      error: flash?.type === "error" ? ERRORS[flash.code] ?? null : null,
    });
  } catch (err) {
    next(err);
  }
});

// Upload the signed receipt; this closes the job card.
router.post("/job-cards/:arn/receipt", requireTechnician, (req, res, next) => {
  receiptUpload(req, res, async (uploadErr) => {
    const arn = String(req.params.arn).toUpperCase();
    const file = req.file;
    const discard = () => file && fs.promises.unlink(file.path).catch(() => {});

    if (uploadErr) { await discard(); return fail(res, "upload"); }
    if (!file) return fail(res, "nofile");

    try {
      const closed = await withTransaction(async (tx) => {
        // Lock the job card, and only if it is this technician's open job.
        const { rows } = await tx.query(
          `SELECT id FROM job_cards
            WHERE arn = ? AND technician_id = ? AND section = ? AND status <> ? AND assigned_at IS NOT NULL
            FOR UPDATE`,
          [arn, req.technician.id, req.technician.section, STATUS.CLOSED],
        );
        if (!rows[0]) return false;
        await tx.query(
          "UPDATE job_cards SET status = ?, closed_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
          [STATUS.CLOSED, rows[0].id],
        );
        await tx.query(
          `INSERT INTO job_card_attachments (job_card_id, original_name, stored_name, mime_type, size_bytes, kind)
           VALUES (?, ?, ?, ?, ?, 'SIGNED_RECEIPT')`,
          [rows[0].id, file.originalname, `receipts/${file.filename}`, file.mimetype, file.size],
        );
        return true;
      });
      if (!closed) {
        await discard();
        return fail(res, "notfound");
      }
      setFlash(res, { type: "done", arn });
      res.redirect("/technician");
    } catch (err) {
      await discard();
      next(err);
    }
  });
});

// Upload the signed receipt for a preventive service; this closes it.
router.post("/preventive-services/:ref/receipt", requireTechnician, (req, res, next) => {
  receiptUpload(req, res, async (uploadErr) => {
    const ref = String(req.params.ref).toUpperCase();
    const file = req.file;
    const discard = () => file && fs.promises.unlink(file.path).catch(() => {});

    if (uploadErr) { await discard(); return fail(res, "upload"); }
    if (!file) return fail(res, "nofile");

    try {
      const { rowCount } = await query(
        `UPDATE preventive_services
            SET status = ?, closed_at = UTC_TIMESTAMP(3),
                receipt_original_name = ?, receipt_stored_name = ?, receipt_mime_type = ?, receipt_size_bytes = ?
          WHERE ref = ? AND technician_id = ? AND status = ?`,
        [PS_STATUS.CLOSED, file.originalname, `receipts/${file.filename}`, file.mimetype, file.size,
         ref, req.technician.id, PS_STATUS.ASSIGNED],
      );
      if (!rowCount) {
        await discard();
        return fail(res, "notfound");
      }
      setFlash(res, { type: "done", arn: ref });
      res.redirect("/technician");
    } catch (err) {
      await discard();
      next(err);
    }
  });
});

export default router;
