// Service history of one AC (A4, black and white): AC details on top, then a
// table of every job card for it. Generated on request; nothing is stored.
import path from "node:path";
import PDFDocument from "pdfkit";

const LOGO = path.resolve("public", "img", "logo-bw.png");
const INK = "#000000";
const MUTED = "#555555";
const LINE = "#999999";
const HEAD_BG = "#e6e6e6";
const ZEBRA = "#f5f5f5";
const M = 40;

const fmtDay = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const fmtDateTime = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : null);
const val = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));

/**
 * @param {object} ac    ac_units row
 * @param {object[]} jobs job_cards rows for that AC (arn, created_at, closed_at, status, description, materials_issued)
 */
export function serviceHistoryPdf(ac, jobs) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: M, bottom: 46, left: M, right: M },
    bufferPages: true, // so "Page x of y" can be added at the end
    info: { Title: `Service history ${ac.crew_serial_number}`, Author: "IACS Workshop Online Job Card System" },
  });
  const W = doc.page.width;
  const contentW = W - M * 2;
  const bottomLimit = doc.page.height - 56;

  // ---- Header ----
  let y = 32;
  try { doc.image(LOGO, M, y, { width: 46 }); } catch { /* no logo */ }
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13)
    .text("Indian Association for the Cultivation of Science", M + 58, y + 4, { width: contentW - 58 });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
    .text("Workshop Online Job Card System", M + 58, y + 22, { width: contentW - 58 });
  y += 58;
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(2).strokeColor(INK).stroke();
  y += 12;
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text("Service History", M, y, { width: contentW, align: "center" });
  y += 20;
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(ac.crew_serial_number, M, y, { width: contentW, align: "center" });
  y += 24;

  // ---- AC details: 2 label/value pairs per row, bordered ----
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text("Air Conditioner Details", M, y);
  y += 16;
  const amcDates = ac.amc_start_date || ac.amc_end_date ? `${fmtDay(ac.amc_start_date)} to ${fmtDay(ac.amc_end_date)}` : "—";
  const details = [
    ["CREW Serial Number", ac.crew_serial_number],
    ["Brand", ac.brand],
    ["Type / Capacity", [ac.ac_type, ac.capacity_tr && `${ac.capacity_tr} Ton`].filter(Boolean).join(", ")],
    ["School / Department / Section / Unit", ac.school],
    ["Faculty / Staff / In-charge", ac.in_charge],
    ["Room No.", ac.room_number],
    ["AMC", ac.amc],
    ["AMC Work Order No.", ac.amc_work_order_no],
    ["AMC Period", amcDates],
    ["Warranty", ac.under_warranty === 1 ? `Yes${ac.warranty_end_date ? `, until ${fmtDay(ac.warranty_end_date)}` : ""}` : ac.under_warranty === 0 ? "No" : null],
  ];
  const colW = contentW / 2;
  const labelW = 0.42 * colW;
  doc.fontSize(8.6);
  for (let i = 0; i < details.length; i += 2) {
    const pair = details.slice(i, i + 2);
    const heights = pair.map(([l, v]) => Math.max(
      doc.font("Helvetica-Bold").heightOfString(l, { width: labelW - 10 }),
      doc.font("Helvetica").heightOfString(val(v), { width: colW - labelW - 10 }),
    ));
    const h = Math.max(...heights) + 10;
    pair.forEach(([l, v], j) => {
      const x = M + j * colW;
      doc.rect(x, y, labelW, h).fill(ZEBRA);
      doc.rect(x, y, colW, h).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.moveTo(x + labelW, y).lineTo(x + labelW, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.6).text(l, x + 5, y + 5, { width: labelW - 10 });
      doc.font("Helvetica").text(val(v), x + labelW + 5, y + 5, { width: colW - labelW - 10 });
    });
    y += h;
  }
  y += 22;

  // ---- Job card table ----
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK)
    .text(`Job Card Applications (${jobs.length})`, M, y);
  y += 16;

  const cols = [
    { title: "ARN", w: 0.17 },
    { title: "Submitted On", w: 0.13 },
    { title: "Completed On", w: 0.13 },
    { title: "Description of Work", w: 0.32 },
    { title: "Materials Issued", w: 0.25 },
  ].map((c) => ({ ...c, w: c.w * contentW }));
  const pad = 5;

  // Heading row grows to fit headings that wrap (e.g. "Completed On").
  const headerRow = () => {
    doc.font("Helvetica-Bold").fontSize(8.4);
    const h = Math.max(...cols.map((c) => doc.heightOfString(c.title, { width: c.w - pad * 2 }))) + 12;
    doc.rect(M, y, contentW, h).fill(HEAD_BG);
    let x = M;
    for (const c of cols) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.4).text(c.title, x + pad, y + 6, { width: c.w - pad * 2 });
      x += c.w;
    }
    doc.rect(M, y, contentW, h).lineWidth(0.6).strokeColor(LINE).stroke();
    x = M;
    for (let i = 0; i < cols.length - 1; i++) {
      x += cols[i].w;
      doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
    }
    y += h;
  };

  if (!jobs.length) {
    doc.rect(M, y, contentW, 34).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("No job card applications have been made for this AC.", M, y + 12, { width: contentW, align: "center" });
  } else {
    headerRow();
    jobs.forEach((j, idx) => {
      const completed = j.closed_at ? fmtDateTime(j.closed_at) : `Not completed (${String(j.status || "").toLowerCase()})`;
      const cells = [j.arn, fmtDateTime(j.created_at), completed, val(j.description), val(j.materials_issued)];
      doc.font("Helvetica").fontSize(8.4);
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(String(t), { width: cols[i].w - pad * 2 }))) + pad * 2;
      if (y + h > bottomLimit) {
        doc.addPage();
        y = M;
        headerRow();
      }
      if (idx % 2 === 1) doc.rect(M, y, contentW, h).fill(ZEBRA);
      let x = M;
      cells.forEach((t, i) => {
        doc.fillColor(i === 2 && !j.closed_at ? MUTED : INK)
          .font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(8.4)
          .text(String(t), x + pad, y + pad, { width: cols[i].w - pad * 2 });
        x += cols[i].w;
      });
      // Cell borders
      doc.rect(M, y, contentW, h).lineWidth(0.6).strokeColor(LINE).stroke();
      x = M;
      for (let i = 0; i < cols.length - 1; i++) {
        x += cols[i].w;
        doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
      }
      y += h;
    });
  }

  // ---- Footer on every page ----
  const generated = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin; without this PDFKit would
    // treat it as overflow and start a new (blank) page.
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 34;
    doc.moveTo(M, fy - 6).lineTo(W - M, fy - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font("Helvetica").fontSize(7.8).fillColor(MUTED)
      .text(`${ac.crew_serial_number} · Generated ${generated}`, M, fy, { width: contentW / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, M + contentW / 2, fy, { width: contentW / 2, align: "right", lineBreak: false });
  }

  doc.end();
  return doc;
}
