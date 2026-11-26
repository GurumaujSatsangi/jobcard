// Issue history of one inventory item (A4, black and white): item code and
// description on top, then every ARN it was issued to. Generated on request;
// nothing is stored.
import path from "node:path";
import PDFDocument from "pdfkit";

const LOGO = path.resolve("public", "img", "logo-bw.png");
const INK = "#000000";
const MUTED = "#555555";
const LINE = "#999999";
const HEAD_BG = "#e6e6e6";
const ZEBRA = "#f5f5f5";
const M = 40;

const fmtDateTime = (d) => new Date(d).toLocaleString("en-GB", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
});
const qty = (v) => String(Number(v));

/**
 * @param {object} item  inventory_items row
 * @param {object[]} rows issue lines: arn, issued_at, quantity, unit, mr_slip_no, crew_serial_number (AC only, else null)
 */
export function itemIssuesPdf(item, rows) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: M, bottom: 46, left: M, right: M },
    bufferPages: true,
    info: { Title: `Issue record ${item.item_code}`, Author: "IACS Workshop Online Job Card System" },
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
    .text("Workshop Store", M + 58, y + 22, { width: contentW - 58 });
  y += 58;
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(2).strokeColor(INK).stroke();
  y += 12;
  doc.font("Helvetica-Bold").fontSize(15).fillColor(INK).text("Item Issue Record", M, y, { width: contentW, align: "center" });
  y += 30;

  // ---- Item code + description ----
  const labelW = 120;
  for (const [label, value] of [["ITEM CODE", item.item_code], ["ITEM DESCRIPTION", item.item_name]]) {
    doc.font("Helvetica").fontSize(9.5);
    const h = Math.max(doc.heightOfString(value, { width: contentW - labelW - 12 }), 11) + 12;
    doc.rect(M, y, labelW, h).fill(ZEBRA);
    doc.rect(M, y, contentW, h).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.moveTo(M + labelW, y).lineTo(M + labelW, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(label, M + 6, y + 6, { width: labelW - 12 });
    doc.font(label === "ITEM CODE" ? "Courier-Bold" : "Helvetica").fontSize(9.5)
      .text(value, M + labelW + 6, y + 6, { width: contentW - labelW - 12 });
    y += h;
  }
  y += 22;

  // ---- Table ----
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(`Issued against job cards (${rows.length})`, M, y);
  y += 16;

  const cols = [
    { title: "#", w: 0.06 },
    { title: "ARN", w: 0.19 },
    { title: "Issued On", w: 0.22 },
    { title: "Quantity", w: 0.15, align: "right" },
    { title: "MR Slip No.", w: 0.17 },
    { title: "CREW Serial No.", w: 0.21 },
  ].map((c) => ({ ...c, w: c.w * contentW }));
  const pad = 5;

  const rowLines = (h) => {
    doc.rect(M, y, contentW, h).lineWidth(0.6).strokeColor(LINE).stroke();
    let x = M;
    for (let i = 0; i < cols.length - 1; i++) {
      x += cols[i].w;
      doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.6).strokeColor(LINE).stroke();
    }
  };
  const headerRow = () => {
    doc.font("Helvetica-Bold").fontSize(8.6);
    const h = Math.max(...cols.map((c) => doc.heightOfString(c.title, { width: c.w - pad * 2 }))) + 12;
    doc.rect(M, y, contentW, h).fill(HEAD_BG);
    let x = M;
    for (const c of cols) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.6).text(c.title, x + pad, y + 6, { width: c.w - pad * 2, align: c.align ?? "left" });
      x += c.w;
    }
    rowLines(h);
    y += h;
  };

  if (!rows.length) {
    doc.rect(M, y, contentW, 34).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("This item has not been issued against any job card yet.", M, y + 12, { width: contentW, align: "center" });
  } else {
    headerRow();
    rows.forEach((r, idx) => {
      const cells = [String(idx + 1), r.arn, fmtDateTime(r.issued_at), `${qty(r.quantity)} ${r.unit}`, r.mr_slip_no, r.crew_serial_number || "—"];
      doc.font("Helvetica").fontSize(8.6);
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: cols[i].w - pad * 2 }))) + pad * 2;
      if (y + h > bottomLimit) {
        doc.addPage();
        y = M;
        headerRow();
      }
      if (idx % 2 === 1) doc.rect(M, y, contentW, h).fill(ZEBRA);
      let x = M;
      cells.forEach((t, i) => {
        doc.fillColor(INK).font(i === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(8.6)
          .text(t, x + pad, y + pad, { width: cols[i].w - pad * 2, align: cols[i].align ?? "left" });
        x += cols[i].w;
      });
      rowLines(h);
      y += h;
    });

    // Total issued
    const total = rows.reduce((s, r) => s + Math.round(Number(r.quantity) * 1000), 0) / 1000;
    const h = 22;
    if (y + h > bottomLimit) { doc.addPage(); y = M; }
    doc.rect(M, y, contentW, h).fill(HEAD_BG);
    const qx = M + cols[0].w + cols[1].w + cols[2].w;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.6)
      .text("Total issued", M + pad, y + 7, { width: qx - M - pad * 2, align: "right" })
      .text(`${qty(total)} ${item.unit}`, qx + pad, y + 7, { width: cols[3].w - pad * 2, align: "right" });
    doc.rect(M, y, contentW, h).lineWidth(0.6).strokeColor(LINE).stroke();
  }

  // ---- Footer on every page ----
  const generated = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // footer sits in the margin; don't start a new page
    const fy = doc.page.height - 34;
    doc.moveTo(M, fy - 6).lineTo(W - M, fy - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font("Helvetica").fontSize(7.8).fillColor(MUTED)
      .text(`${item.item_code} · Generated ${generated}`, M, fy, { width: contentW / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, M + contentW / 2, fy, { width: contentW / 2, align: "right", lineBreak: false });
  }

  doc.end();
  return doc;
}
