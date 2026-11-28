// Printable job card (A4, black and white), available once a technician is
// assigned. Page 1: the job card with signature lines. Page 2: the store's
// Materials Issued Sheet. Generated on request; nothing is stored.
import path from "node:path";
import PDFDocument from "pdfkit";
import { sectionLabel } from "./constants.js";

const LOGO = path.resolve("public", "img", "logo-bw.png"); // greyscale copy of logo.png
const INK = "#000000";
const MUTED = "#555555";
const RULE = "#333333";
const BAND = "#f2f2f2";

const M = 42; // page margin
const fmtLong = (d) => (d ? new Date(d).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", month: "long", day: "numeric", year: "numeric" }) : "");
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC" }).replace(/\//g, ".") : "—");

/**
 * @param {object} jc  job_cards row joined with ac_units (ac_*) and technician (tech_name, tech_phone)
 * @returns PDFDocument stream
 */
export function jobCardPdf(jc) {
  const doc = new PDFDocument({
    size: "A4", // 595.28 x 841.89 pt
    margins: { top: M, bottom: 24, left: M, right: M },
    info: { Title: `Job Card ${jc.arn}`, Author: "IACS Workshop Online Job Card System" },
  });
  const W = doc.page.width;
  const contentW = W - M * 2;
  const isAc = jc.section === "AC_REFRIGERATION";

  const rule = (y, weight = 0.8, color = RULE) =>
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(weight).strokeColor(color).stroke();

  // ---------------- Page 1: job card ----------------
  let y = 34;
  try {
    doc.image(LOGO, (W - 62) / 2, y, { width: 62 });
  } catch { /* logo missing: carry on without it */ }
  y += 70;
  doc.fillColor(INK).font("Helvetica").fontSize(13)
    .text("Indian Association for the Cultivation of Science", M, y, { width: contentW, align: "center" });
  y += 22;
  doc.fontSize(11.5).fillColor(MUTED).text("Workshop Online Job Card System", M, y, { width: contentW, align: "center" });
  y += 24;

  // Grey band: section + ARN
  doc.rect(0, y, W, 62).fill(BAND);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11)
    .text(sectionLabel(jc.section), M, y + 12, { width: contentW, align: "center" });
  doc.fontSize(15).text(`Application Reference Number: ${jc.arn}`, M, y + 32, { width: contentW, align: "center" });
  y += 62;
  doc.moveTo(M + 6, y + 1).lineTo(W - M - 6, y + 1).lineWidth(2.4).strokeColor(INK).stroke();
  y += 14;

  // Label / value rows
  const labelW = 205;
  const valueX = M + labelW + 10;
  const valueW = contentW - labelW - 10;
  const row = (label, value, { bold = false } = {}) => {
    const v = value === null || value === undefined || value === "" ? "—" : String(value);
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(INK).text(label, M + 4, y, { width: labelW });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").text(v, valueX, y, { width: valueW });
    const h = Math.max(doc.heightOfString(label, { width: labelW }), doc.heightOfString(v, { width: valueW }));
    y += h + 11;
  };

  row("Name of Indentor", `${jc.first_name} ${jc.last_name}`, { bold: true });
  row("Email", jc.email);
  row("Name of the School/Department/Section/Unit", jc.department);
  row("Contact Number (Extension)", jc.contact_number);
  if (isAc && jc.crew_serial_number) {
    row("CREW Serial Number", jc.crew_serial_number);
    row("Faculty / Staff / In-charge", jc.ac_in_charge);
    row("Room No.", jc.ac_room_number);
  }
  if (!isAc) {
    if (jc.room_number) row("Room Number / Lab Number", jc.room_number);
    if (jc.lab_in_charge) row("Faculty / Guide / Lab In-Charge", jc.lab_in_charge);
  }
  row("Details of Work", jc.description);

  y += 2;
  rule(y);
  y += 11;
  row("Assigned Date", fmtLong(jc.assigned_at));
  const techText = jc.tech_name ? `${jc.tech_name}${jc.tech_phone ? ` (Ext. ${jc.tech_phone})` : ""}` : "";
  const techY = y;
  row("Technician", techText);
  if (jc.tech_name && jc.tech_amc) {
    // Black "AMC STAFF" badge right after the technician's name.
    doc.font("Helvetica").fontSize(9.5);
    const nameW = doc.widthOfString(techText);
    doc.font("Helvetica-Bold").fontSize(7.5);
    const badgeW = doc.widthOfString("AMC STAFF") + 10;
    if (nameW + 8 + badgeW <= valueW) {
      const bx = valueX + nameW + 8;
      doc.roundedRect(bx, techY - 1.5, badgeW, 12.5, 3).fill(INK);
      doc.fillColor("#ffffff").text("AMC STAFF", bx + 5, techY + 1.2, { lineBreak: false });
      doc.fillColor(INK);
    }
    row("AMC (Technician's Employer)", `${jc.tech_amc} (AMC Staff)`, { bold: true });
  }
  y += 1;
  rule(y);

  // AC strip: AMC / brand / work order / dates
  if (isAc && jc.crew_serial_number) {
    y += 10;
    const cols = [
      ["AMC", (jc.ac_amc || "—").toUpperCase()],
      ["Brand", jc.ac_brand || "—"],
      ["AMC Work Order No.", jc.ac_amc_work_order_no || "—"],
      ["AMC Start Date", fmtDay(jc.ac_amc_start_date)],
      ["AMC End Date", fmtDay(jc.ac_amc_end_date)],
    ];
    const widths = [0.12, 0.17, 0.33, 0.19, 0.19].map((f) => f * contentW);
    let x = M + 4;
    let tallest = 0;
    cols.forEach(([label, value], i) => {
      const w = widths[i] - 8;
      doc.font("Helvetica").fontSize(7.8).fillColor(MUTED).text(label, x, y, { width: w });
      const lh = doc.heightOfString(label, { width: w });
      doc.font("Helvetica-Bold").fontSize(8.8).fillColor(INK).text(value, x, y + lh + 2, { width: w });
      tallest = Math.max(tallest, lh + 2 + doc.heightOfString(value, { width: w }));
      x += widths[i];
    });
    y += tallest + 10;
    rule(y);
  }

  // Materials / gate pass
  y += 14;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("Materials Required:", M + 4, y);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("If Gate Pass Issued, GATE PASS NO.:", M + contentW * 0.52, y);
  // Ruled writing lines for the technician.
  for (let i = 1; i <= 5; i++) {
    const ly = y + 6 + i * 22;
    doc.moveTo(M + 4, ly).lineTo(M + contentW * 0.48, ly).lineWidth(0.4).strokeColor("#bbbbbb").stroke();
  }
  doc.moveTo(M + contentW * 0.52 + 190, y + 11).lineTo(W - M - 4, y + 11).lineWidth(0.4).strokeColor("#bbbbbb").stroke();

  // Signatures at the bottom of the page.
  const pageBottom = doc.page.height - 34;
  let sy = Math.max(y + 150, pageBottom - 150);
  const sigLabels = isAc
    ? ["Signature of Technician", "Signature of In-charge - AMC / Internal AC Section", "Signature of T.O. - Electrical"]
    : ["Signature of Technician", "Signature of Section In-charge"];
  const sigW = contentW / sigLabels.length;
  sigLabels.forEach((label, i) => {
    const x = M + i * sigW;
    doc.moveTo(x + 10, sy).lineTo(x + sigW - 10, sy).lineWidth(0.7).strokeColor(INK).stroke();
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(label, x + 6, sy + 5, { width: sigW - 12, align: "center" });
  });
  sy += 38;
  if (isAc) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text("Service performed by AMC staff was found to be correct, and all replaced parts are genuine and certified.", M + 4, sy, { width: contentW - 8, align: "right" });
    sy += 16;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text("Inspected by AC Section, Workshop.", M + 4, sy, { width: contentW - 8, align: "right" });
    sy += 24;
  } else {
    sy += 16;
  }
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Work Done Successfully : ", M + 4, sy, { continued: true })
    .font("Helvetica-Bold").fillColor(INK).text("Signature of Indentor");
  doc.moveTo(M + 230, sy + 11).lineTo(M + 400, sy + 11).lineWidth(0.6).strokeColor(INK).stroke();

  // ---------------- Page 2: materials issued sheet ----------------
  doc.addPage();
  y = 70;
  doc.font("Helvetica-Bold").fontSize(14).fillColor(INK)
    .text("Materials Issued Sheet", M, y, { width: contentW, align: "center", underline: true });
  y += 40;
  const kv = (label, value) => {
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(label, M + 4, y, { width: 200 });
    doc.font("Helvetica").fontSize(10.5).text(value, valueX, y, { width: valueW });
    y += 24;
  };
  kv("Application Reference Number", jc.arn);
  kv("Assigned Date", fmtLong(jc.assigned_at));
  if (jc.crew_serial_number) kv("CREW Serial Number", jc.crew_serial_number);
  y += 2;
  rule(y, 1.2, INK);
  y += 22;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text("For Store Use Only.", M + 4, y);
  y += 34;

  for (let i = 1; i <= 5; i++) {
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    let x = M + 4;
    const put = (s) => { doc.text(s, x, y, { lineBreak: false }); x += doc.widthOfString(s); };
    const blank = (w) => { doc.moveTo(x + 2, y + 9).lineTo(x + w, y + 9).lineWidth(0.5).strokeColor(INK).stroke(); x += w + 4; };
    put(`${i}.  Item Code:`); blank(128);
    put("Qty."); blank(44);
    put("MR Slip No."); blank(66);
    doc.rect(x + 4, y - 0.5, 9, 9).lineWidth(0.7).strokeColor(INK).stroke();
    doc.text("Item not available in stock", x + 18, y, { lineBreak: false });
    y += 36;
  }

  y += 30;
  const sigX = W - M - 250;
  doc.moveTo(sigX, y).lineTo(sigX + 130, y).lineWidth(0.7).strokeColor(INK).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("Signature of Store In-charge", sigX, y + 5, { width: 130, align: "center" });
  doc.text("Date:", sigX + 150, y - 10, { lineBreak: false });
  doc.moveTo(sigX + 176, y).lineTo(W - M - 4, y).lineWidth(0.7).strokeColor(INK).stroke();

  doc.end();
  return doc;
}
