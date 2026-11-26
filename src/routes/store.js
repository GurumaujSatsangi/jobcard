// Store management: sign-in, dashboard, and issuing items against a job card.
//
// Each issue is a "slip" (material_issues) with an MR Slip Number and items
// (material_issue_items). Stock in inventory_items is reduced in the same
// transaction. A job card can get more slips later, and a slip can be edited
// (stock is adjusted by the difference). After any change the job card's status
// becomes MATERIAL ISSUED BY STORE IN-CHARGE and its materials_issued text is
// rebuilt from all its slips, so the status tracker, PDFs and history show it.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { query, withTransaction } from "../db.js";
import { STATUS, STORE_UNITS, sectionLabel } from "../constants.js";
import { itemIssuesPdf } from "../item-issues-pdf.js";
import { verifyStore, startSession, endSession, getStoreUser, requireStore } from "../auth/store-auth.js";
import { sameOriginOnly } from "../auth/session-auth.js";

const router = Router();
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.use(sameOriginOnly);

// Items can only be issued for these job card statuses.
const ISSUABLE = [STATUS.TECHNICIAN_ASSIGNED, STATUS.MATERIAL_ISSUED];

// ---------- helpers ----------

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
const fmt = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : null);

// Quantities are handled as integer thousandths to avoid floating-point drift.
const toMilli = (v) => Math.round(Number(v) * 1000);
const fromMilli = (m) => (m / 1000).toFixed(3);
const pretty = (v) => String(Number(v)); // "15.460" -> "15.46", "2.000" -> "2"

const title = "Store Login";
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) =>
    res.status(429).render("store/login", { title, error: "Too many wrong attempts. Please wait 15 minutes and try again.", email: "" }),
});

// ---------- sign in / out ----------

router.get("/login", asyncRoute(async (req, res) => {
  if (await getStoreUser(req, res)) return res.redirect("/store");
  res.render("store/login", { title, error: null, email: "" });
}));

router.post("/login", loginLimiter, asyncRoute(async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().slice(0, 255) : "";
  const account = await verifyStore(email, String(req.body.password ?? ""));
  if (!account) return res.status(401).render("store/login", { title, error: "Wrong email or password.", email });
  await startSession(res, account, req);
  res.redirect("/store");
}));

router.post("/logout", asyncRoute(async (req, res) => {
  await endSession(req, res);
  res.redirect("/store/login");
}));

router.use(requireStore);

router.get("/", (_req, res) => res.render("store/dashboard", { title: "Store", hideNotice: true, STORE_UNITS }));

// ---------- data ----------

async function loadJobCard(q, arn, { lock = false } = {}) {
  const { rows: [jc] } = await q(
    `SELECT jc.id, jc.arn, jc.first_name, jc.last_name, jc.department, jc.section, jc.status,
            jc.crew_serial_number, jc.description, jc.assigned_at,
            COALESCE(t.name, jc.technician_name) AS tech_name, COALESCE(t.phone, jc.technician_phone) AS tech_phone, IF(t.id IS NULL, jc.technician_amc_name, t.amc_name) AS tech_amc,
            a.room_number, a.in_charge
       FROM job_cards jc
       LEFT JOIN technician_accounts t ON t.id = jc.technician_id
       LEFT JOIN ac_units a ON a.crew_serial_number = jc.crew_serial_number
      WHERE jc.arn = ? ${lock ? "FOR UPDATE" : ""}`,
    [String(arn).trim().toUpperCase()],
  );
  return jc ?? null;
}

async function loadSlips(q, jobCardId) {
  const { rows: slips } = await q(
    "SELECT * FROM material_issues WHERE job_card_id = ? ORDER BY issued_at, id",
    [jobCardId],
  );
  if (!slips.length) return [];
  const { rows: lines } = await q(
    `SELECT * FROM material_issue_items WHERE issue_id IN (${slips.map(() => "?").join(",")}) ORDER BY id`,
    slips.map((s) => s.id),
  );
  return slips.map((s) => ({
    id: s.id,
    mrSlipNo: s.mr_slip_no,
    issuedBy: s.issued_by_name,
    issuedAt: fmt(s.issued_at),
    updatedAt: fmt(s.updated_at),
    updatedBy: s.updated_by_name,
    items: lines.filter((l) => l.issue_id === s.id).map((l) => ({
      itemId: l.item_id, code: l.item_code, name: l.item_name, unit: l.unit, quantity: pretty(l.quantity),
    })),
  }));
}

// ARN details for the issue screen.
router.get("/api/job-cards/:arn", asyncRoute(async (req, res) => {
  const jc = await loadJobCard(query, req.params.arn);
  if (!jc) throw httpError(404, "No job card found with this ARN.");
  const issuable = ISSUABLE.includes(jc.status);
  res.json({
    arn: jc.arn,
    status: jc.status,
    issuable,
    notIssuableReason: issuable ? null
      : `Items can only be issued when the job card is "Technician Assigned" or "Material Issued by Store In-charge". This one is "${jc.status}".`,
    indentor: `${jc.first_name} ${jc.last_name}`,
    department: jc.department,
    section: sectionLabel(jc.section),
    crewSerialNumber: jc.section === "AC_REFRIGERATION" ? jc.crew_serial_number : null,
    roomNumber: jc.room_number,
    inCharge: jc.in_charge,
    technician: jc.tech_name ? `${jc.tech_name}${jc.tech_phone ? ` (Ext. ${jc.tech_phone})` : ""}` : null,
    technicianAmc: jc.tech_amc || null,
    description: jc.description,
    slips: await loadSlips(query, jc.id),
  });
}));

// Inventory for the item picker (active items; search is done in the browser,
// ?q= is also supported for large lists).
router.get("/api/items", asyncRoute(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await query(
    `SELECT id, item_code, item_name, make, unit, decimal_allowed, quantity FROM inventory_items
      WHERE active = 1 ${q ? "AND (item_code LIKE ? OR item_name LIKE ?)" : ""}
      ORDER BY item_name LIMIT 2000`,
    q ? [like, like] : [],
  );
  res.json(rows.map(itemJson));
}));

const itemJson = (r) => ({
  id: r.id, code: r.item_code, name: r.item_name, make: r.make, unit: r.unit,
  decimalAllowed: Boolean(r.decimal_allowed), available: pretty(r.quantity),
});

// ---------- inventory ----------

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max + 1) : "");

// Register a new item (starts with 0 in stock; stock comes from purchase records).
router.post("/api/items", asyncRoute(async (req, res) => {
  const code = str(req.body?.code, 64);
  const name = str(req.body?.name, 255);
  const make = str(req.body?.make, 120);
  const unit = STORE_UNITS.find((u) => u.value === req.body?.unit);
  const errors = {};
  if (!code) errors.code = "Item code is required.";
  else if (code.length > 64) errors.code = "Keep the item code under 64 characters.";
  if (!name) errors.name = "Item description is required.";
  else if (name.length > 255) errors.name = "Keep the description under 255 characters.";
  if (!unit) errors.unit = "Choose the unit of measurement.";
  if (!make) errors.make = "Make / brand name is required.";
  else if (make.length > 120) errors.make = "Keep the make / brand under 120 characters.";
  if (Object.keys(errors).length) throw httpError(400, Object.values(errors)[0], { errors });
  try {
    const { insertId } = await query(
      "INSERT INTO inventory_items (item_code, item_name, make, unit, decimal_allowed) VALUES (?,?,?,?,?)",
      [code, name, make, unit.value, unit.decimal ? 1 : 0],
    );
    const { rows: [item] } = await query("SELECT * FROM inventory_items WHERE id = ?", [insertId]);
    res.status(201).json(itemJson(item));
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") throw httpError(409, `Item code ${code} is already in use.`, { errors: { code: `Item code ${code} is already in use.` } });
    throw err;
  }
}));

async function findItem(id) {
  const { rows: [item] } = await query("SELECT * FROM inventory_items WHERE id = ?", [Number(id) || 0]);
  if (!item) throw httpError(404, "That item doesn't exist.");
  return item;
}

// One item with its purchase records (newest first).
router.get("/api/items/:id", asyncRoute(async (req, res) => {
  const item = await findItem(req.params.id);
  const { rows } = await query("SELECT * FROM inventory_purchases WHERE item_id = ? ORDER BY created_at DESC, id DESC", [item.id]);
  res.json({
    ...itemJson(item),
    purchases: rows.map((p) => ({
      id: p.id,
      purchaseHead: p.purchase_head,
      quantity: pretty(p.quantity),
      rate: p.rate === null ? null : Number(p.rate).toFixed(2),
      remarks: p.remarks,
      addedBy: p.added_by_name,
      addedAt: fmt(p.created_at),
      poFile: p.po_file ? `/store/api/purchases/${p.id}/po` : null,
      invoiceFile: p.invoice_file ? `/store/api/purchases/${p.id}/invoice` : null,
    })),
  });
}));

// Purchase documents (PO / indent, invoice): PDF or photo, kept on the server.
const PURCHASE_DIR = path.resolve("uploads", "store-purchases");
fs.mkdirSync(PURCHASE_DIR, { recursive: true });
const DOC_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const purchaseUpload = multer({
  storage: multer.diskStorage({
    destination: PURCHASE_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => (DOC_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error("Only PDF, JPG, PNG or WEBP files are allowed."), { field: file.fieldname, badType: true }))),
}).fields([{ name: "poFile", maxCount: 1 }, { name: "invoiceFile", maxCount: 1 }]);

const uploaded = (req) => Object.values(req.files ?? {}).flat();
const removeUploads = (req) => Promise.all(uploaded(req).map((f) => fs.promises.unlink(f.path).catch(() => {})));

// Add a purchase record: stock goes up by the quantity.
router.post("/api/items/:id/purchases", (req, res, next) => {
  purchaseUpload(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const msg = uploadErr.code === "LIMIT_FILE_SIZE" ? "Each file must be 10 MB or smaller."
          : uploadErr.badType ? uploadErr.message : "Couldn't read the attached files.";
        throw httpError(400, msg, { errors: { [uploadErr.field === "invoiceFile" ? "invoiceFile" : "poFile"]: msg } });
      }
      const item = await findItem(req.params.id);
      const body = req.body ?? {};
      const head = str(body.purchaseHead, 64);
      const qty = str(body.quantity, 20);
      const rate = str(body.rate, 20);
      const remarks = str(body.remarks, 2000);
      const errors = {};
      if (!head) errors.purchaseHead = "Purchase head is required.";
      else if (head.length > 64) errors.purchaseHead = "Keep the purchase head under 64 characters.";
      if (!qty) errors.quantity = "Quantity is required.";
      else if (!(item.decimal_allowed ? /^\d+(\.\d{1,3})?$/ : /^\d+$/).test(qty) || toMilli(qty) <= 0) {
        errors.quantity = item.decimal_allowed
          ? "Enter a quantity above 0 (up to 3 decimal places)."
          : `Enter a whole number above 0 (${item.unit}).`;
      } else if (toMilli(qty) > 99_999_999_999) errors.quantity = "That quantity is too large.";
      if (rate && !/^\d{1,12}(\.\d{1,2})?$/.test(rate)) errors.rate = "Enter the rate as a number, e.g. 250 or 249.50.";
      if (remarks.length > 2000) errors.remarks = "Keep the remarks under 2000 characters.";
      if (Object.keys(errors).length) throw httpError(400, Object.values(errors)[0], { errors });

      const po = req.files?.poFile?.[0];
      const inv = req.files?.invoiceFile?.[0];
      await withTransaction(async (tx) => {
        await tx.query("SELECT id FROM inventory_items WHERE id = ? FOR UPDATE", [item.id]);
        await tx.query(
          `INSERT INTO inventory_purchases
             (item_id, purchase_head, quantity, rate, po_file, po_file_original, po_file_mime,
              invoice_file, invoice_file_original, invoice_file_mime, remarks, added_by_store_id, added_by_name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [item.id, head, fromMilli(toMilli(qty)), rate || null,
            po?.filename ?? null, po?.originalname.slice(0, 255) ?? null, po?.mimetype ?? null,
            inv?.filename ?? null, inv?.originalname.slice(0, 255) ?? null, inv?.mimetype ?? null,
            remarks || null, req.store.id, req.store.name],
        );
        await tx.query(
          "UPDATE inventory_items SET quantity = quantity + ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
          [fromMilli(toMilli(qty)), item.id],
        );
      });
      const { rows: [fresh] } = await query("SELECT * FROM inventory_items WHERE id = ?", [item.id]);
      res.status(201).json(itemJson(fresh));
    } catch (err) {
      await removeUploads(req);
      next(err);
    }
  });
});

// View a purchase document.
router.get("/api/purchases/:id/:kind", asyncRoute(async (req, res) => {
  const k = { po: "po_file", invoice: "invoice_file" }[req.params.kind];
  if (!k) throw httpError(404, "File not found.");
  const { rows: [p] } = await query("SELECT * FROM inventory_purchases WHERE id = ?", [Number(req.params.id) || 0]);
  if (!p?.[k]) throw httpError(404, "File not found.");
  const full = path.resolve(PURCHASE_DIR, p[k]);
  if (!full.startsWith(PURCHASE_DIR + path.sep) || !fs.existsSync(full)) throw httpError(404, "File not found.");
  res.set({
    "Content-Type": p[`${k}_mime`],
    "Content-Disposition": `inline; filename="${encodeURIComponent(p[`${k}_original`] || "file")}"`,
    "Content-Security-Policy": "sandbox",
  });
  res.sendFile(full);
}));

// PDF: every ARN this item was issued to.
router.get("/api/items/:id/issues.pdf", asyncRoute(async (req, res) => {
  const item = await findItem(req.params.id);
  const { rows } = await query(
    `SELECT jc.arn, mi.issued_at, mii.quantity, mii.unit, mi.mr_slip_no,
            CASE WHEN jc.section = 'AC_REFRIGERATION' THEN jc.crew_serial_number END AS crew_serial_number
       FROM material_issue_items mii
       JOIN material_issues mi ON mi.id = mii.issue_id
       JOIN job_cards jc ON jc.id = mi.job_card_id
      WHERE mii.item_id = ?
      ORDER BY mi.issued_at, mi.id, mii.id`,
    [item.id],
  );
  const file = `issue-record-${item.item_code.replace(/[^\w.-]+/g, "-")}.pdf`;
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${file}"` });
  itemIssuesPdf(item, rows).pipe(res);
}));

// ---------- issuing ----------

// Check the posted slip: MR slip number + at least one item with a valid quantity.
function readSlip(body) {
  const mrSlipNo = typeof body?.mrSlipNo === "string" ? body.mrSlipNo.trim() : "";
  const errors = {};
  if (!mrSlipNo) errors.mrSlipNo = "MR Slip Number is required.";
  else if (mrSlipNo.length > 64) errors.mrSlipNo = "Keep the MR Slip Number under 64 characters.";

  const raw = Array.isArray(body?.items) ? body.items : [];
  const wanted = new Map(); // itemId -> milli
  for (const it of raw) {
    const id = Number(it?.itemId);
    const q = String(it?.quantity ?? "").trim();
    if (!Number.isInteger(id) || id < 1) continue;
    if (!/^\d+(\.\d{1,3})?$/.test(q) || toMilli(q) <= 0) {
      errors.items = "Each quantity must be a number above 0 (up to 3 decimal places).";
      continue;
    }
    wanted.set(id, (wanted.get(id) ?? 0) + toMilli(q));
  }
  if (!wanted.size && !errors.items) errors.items = "Add at least one item.";
  if (Object.keys(errors).length) throw httpError(400, Object.values(errors)[0], { errors });
  return { mrSlipNo, wanted };
}

// Apply stock changes: delta > 0 takes stock out, delta < 0 puts it back.
async function applyStock(tx, deltas) {
  const ids = [...deltas.keys()];
  if (!ids.length) return new Map();
  const { rows } = await tx.query(
    `SELECT id, item_code, item_name, unit, decimal_allowed, quantity, active FROM inventory_items
      WHERE id IN (${ids.map(() => "?").join(",")}) FOR UPDATE`,
    ids,
  );
  const items = new Map(rows.map((r) => [r.id, r]));
  for (const [id, delta] of deltas) {
    const item = items.get(id);
    if (!item) throw httpError(400, "One of the items no longer exists. Reload and try again.");
    if (delta > 0 && !item.active) throw httpError(400, `${item.item_name} is no longer in use.`);
    if (!item.decimal_allowed && delta % 1000 !== 0) {
      throw httpError(400, `${item.item_name} is issued in whole numbers only (${item.unit}).`);
    }
    if (delta > toMilli(item.quantity)) {
      throw httpError(409, `Only ${pretty(item.quantity)} ${item.unit} of ${item.item_name} in stock.`);
    }
  }
  for (const [id, delta] of deltas) {
    if (delta === 0) continue;
    await tx.query(
      "UPDATE inventory_items SET quantity = quantity - ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [fromMilli(delta), id],
    );
  }
  return items;
}

// Rebuild the job card's "materials issued" text from all its slips and set the status.
async function refreshJobCard(tx, jobCardId) {
  const { rows } = await tx.query(
    `SELECT mii.item_name, mii.unit, SUM(mii.quantity) AS qty
       FROM material_issue_items mii JOIN material_issues mi ON mi.id = mii.issue_id
      WHERE mi.job_card_id = ?
      GROUP BY mii.item_id, mii.item_name, mii.unit
      ORDER BY MIN(mi.issued_at), MIN(mii.id)`,
    [jobCardId],
  );
  const summary = rows.map((r) => `${r.item_name} (${pretty(r.qty)} ${r.unit})`).join(", ");
  await tx.query(
    `UPDATE job_cards
        SET status = ?, materials_issued = ?, material_issued_at = COALESCE(material_issued_at, UTC_TIMESTAMP(3)),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [STATUS.MATERIAL_ISSUED, summary || null, jobCardId],
  );
}

async function insertLines(tx, issueId, wanted, items) {
  for (const [id, milli] of wanted) {
    const it = items.get(id);
    await tx.query(
      `INSERT INTO material_issue_items (issue_id, item_id, item_code, item_name, unit, quantity)
       VALUES (?,?,?,?,?,?)`,
      [issueId, id, it.item_code, it.item_name, it.unit, fromMilli(milli)],
    );
  }
}

// New slip for an ARN (first issue, or issuing more later).
router.post("/api/job-cards/:arn/issues", asyncRoute(async (req, res) => {
  const { mrSlipNo, wanted } = readSlip(req.body);
  const result = await withTransaction(async (tx) => {
    const jc = await loadJobCard(tx.query, req.params.arn, { lock: true });
    if (!jc) throw httpError(404, "No job card found with this ARN.");
    if (!ISSUABLE.includes(jc.status)) throw httpError(409, `Items can't be issued for a job card that is "${jc.status}".`);
    const items = await applyStock(tx, wanted);
    const { insertId } = await tx.query(
      "INSERT INTO material_issues (job_card_id, mr_slip_no, issued_by_store_id, issued_by_name) VALUES (?,?,?,?)",
      [jc.id, mrSlipNo, req.store.id, req.store.name],
    );
    await insertLines(tx, insertId, wanted, items);
    await refreshJobCard(tx, jc.id);
    return { issueId: insertId, arn: jc.arn };
  });
  res.status(201).json(result);
}));

// Edit a slip: replace its items/MR number; stock moves by the difference.
router.put("/api/issues/:id", asyncRoute(async (req, res) => {
  const { mrSlipNo, wanted } = readSlip(req.body);
  const issueId = Number(req.params.id) || 0;
  const result = await withTransaction(async (tx) => {
    const { rows: [slip] } = await tx.query("SELECT * FROM material_issues WHERE id = ? FOR UPDATE", [issueId]);
    if (!slip) throw httpError(404, "That issue record doesn't exist.");
    const { rows: [jc] } = await tx.query("SELECT id, arn, status FROM job_cards WHERE id = ? FOR UPDATE", [slip.job_card_id]);
    if (!ISSUABLE.includes(jc.status)) throw httpError(409, `This job card is "${jc.status}", so its issues can't be changed.`);

    const { rows: oldLines } = await tx.query("SELECT item_id, quantity FROM material_issue_items WHERE issue_id = ?", [issueId]);
    const old = new Map();
    for (const l of oldLines) old.set(l.item_id, (old.get(l.item_id) ?? 0) + toMilli(l.quantity));
    const deltas = new Map();
    for (const id of new Set([...old.keys(), ...wanted.keys()])) deltas.set(id, (wanted.get(id) ?? 0) - (old.get(id) ?? 0));

    const items = await applyStock(tx, deltas);
    await tx.query("DELETE FROM material_issue_items WHERE issue_id = ?", [issueId]);
    await insertLines(tx, issueId, wanted, items);
    await tx.query(
      "UPDATE material_issues SET mr_slip_no = ?, updated_at = UTC_TIMESTAMP(3), updated_by_name = ? WHERE id = ?",
      [mrSlipNo, req.store.name, issueId],
    );
    await refreshJobCard(tx, jc.id);
    return { issueId, arn: jc.arn };
  });
  res.json(result);
}));

// ---------- memo record book ----------

const memoJson = (m) => ({
  id: m.id, memoDate: m.memo_date, description: m.description, addedBy: m.added_by_name, addedAt: fmt(m.created_at),
});

router.get("/api/memos", asyncRoute(async (_req, res) => {
  const { rows } = await query("SELECT * FROM store_memos ORDER BY memo_date DESC, id DESC");
  res.json(rows.map(memoJson));
}));

router.post("/api/memos", asyncRoute(async (req, res) => {
  const date = str(req.body?.memoDate, 10);
  const description = str(req.body?.description, 5000);
  const errors = {};
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  if (!date) errors.memoDate = "Memo date is required.";
  else if (!valid) errors.memoDate = "Enter a valid date.";
  if (!description) errors.description = "Description is required.";
  else if (description.length > 5000) errors.description = "Keep the description under 5000 characters.";
  if (Object.keys(errors).length) throw httpError(400, Object.values(errors)[0], { errors });
  const { insertId } = await query(
    "INSERT INTO store_memos (memo_date, description, added_by_store_id, added_by_name) VALUES (?,?,?,?)",
    [date, description, req.store.id, req.store.name],
  );
  const { rows: [memo] } = await query("SELECT * FROM store_memos WHERE id = ?", [insertId]);
  res.status(201).json(memoJson(memo));
}));

// JSON errors for the store API.
router.use((err, req, res, next) => {
  if (!req.path.startsWith("/api/")) return next(err);
  if (err.expose) return res.status(err.status).json({ error: err.message, errors: err.errors });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

export default router;
