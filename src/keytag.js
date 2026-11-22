// Printable keytag for an AC: A6 PDF, navy and white, with a QR code holding
// the CREW serial number. Generated on request; nothing is stored.
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const NAVY = "#041353";
const NAVY_SOFT = "#e8ebf7";
const PORTAL_URL = "https://iacs-crew.netlify.app";
const HELP_EMAIL = "onlinejobcard@iacs.res.in";
const HELP_EXT = "1703";

// Draws the QR as vector squares so it prints sharp at any size.
function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 2; // modules of white margin inside the box
  const cell = size / (n + quiet * 2);
  doc.save().fillColor(NAVY);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        // Slight overlap avoids hairline gaps between squares in some viewers.
        doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.15, cell + 0.15).fill();
      }
    }
  }
  doc.restore();
}

/** Returns a PDFDocument (a readable stream); pipe it to the response. */
export function keytagPdf(crewSerialNumber) {
  const doc = new PDFDocument({
    size: "A6", // 297.64 x 419.53 pt
    margin: 0,
    info: { Title: `Keytag ${crewSerialNumber}`, Author: "IACS Workshop Online Job Card Portal" },
  });
  const W = doc.page.width;
  const H = doc.page.height;
  const inset = 12;
  const cardW = W - inset * 2;
  const cardH = H - inset * 2;
  const radius = 14;

  // Card: navy outer border, thin inner rule.
  doc.roundedRect(inset, inset, cardW, cardH, radius).lineWidth(3).strokeColor(NAVY).stroke();
  doc.roundedRect(inset + 6, inset + 6, cardW - 12, cardH - 12, radius - 4).lineWidth(0.6).strokeColor(NAVY).stroke();

  // Header band.
  const bandX = inset + 6;
  const bandY = inset + 6;
  const bandW = cardW - 12;
  const bandH = 108;
  doc.save();
  doc.roundedRect(bandX, bandY, bandW, bandH, radius - 4).clip();
  doc.rect(bandX, bandY, bandW, bandH).fill(NAVY);
  doc.restore();

  // Keyring hole marker.
  doc.circle(W / 2, bandY + 17, 6.5).lineWidth(1.4).strokeColor("#ffffff").stroke();

  // Title.
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(14.5)
    .text("Workshop Online Job Card Portal", bandX, bandY + 32, { width: bandW, align: "center" });

  // CREW serial number in a white-outlined pill.
  doc.font("Helvetica-Bold").fontSize(16);
  const serialW = doc.widthOfString(crewSerialNumber) + 30;
  const serialX = (W - serialW) / 2;
  const serialY = bandY + 60;
  doc.roundedRect(serialX, serialY, serialW, 30, 15).lineWidth(1.2).strokeColor("#ffffff").stroke();
  doc.fillColor("#ffffff").text(crewSerialNumber, serialX, serialY + 8, { width: serialW, align: "center", characterSpacing: 0.6 });

  // QR code on a soft panel with a navy frame.
  const qrSize = 146;
  const qrX = (W - qrSize) / 2;
  const qrY = bandY + bandH + 20;
  doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 10).fill(NAVY_SOFT);
  doc.roundedRect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 8, 6).fill("#ffffff");
  doc.roundedRect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 8, 6).lineWidth(1).strokeColor(NAVY).stroke();
  drawQr(doc, crewSerialNumber, qrX, qrY, qrSize);

  // Text: one centred line per phrase (mixing fonts on one centred line
  // misaligns in PDFKit), bold for the address, email and extension.
  const textX = inset + 16;
  const textW = cardW - 32;
  const line = (str, { bold = false, link } = {}) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.4).fillColor(NAVY)
      .text(str, textX, y, { width: textW, align: "center", link, lineBreak: false });
    y += 11.5;
  };
  let y = qrY + qrSize + 22;
  line("To submit a job card application, visit");
  line(PORTAL_URL, { bold: true, link: PORTAL_URL });
  y += 3;
  doc.moveTo(W / 2 - 36, y).lineTo(W / 2 + 36, y).lineWidth(0.6).strokeColor(NAVY).stroke();
  y += 6;
  line("In case of any query, reach out to us at");
  line(HELP_EMAIL, { bold: true, link: `mailto:${HELP_EMAIL}` });
  doc.font("Helvetica").fontSize(8.4);
  const pre = "or contact extension number ";
  const preW = doc.widthOfString(pre);
  doc.font("Helvetica-Bold");
  const extW = doc.widthOfString(`${HELP_EXT}.`);
  const startX = (W - preW - extW) / 2;
  doc.font("Helvetica").fillColor(NAVY).text(pre, startX, y, { lineBreak: false });
  doc.font("Helvetica-Bold").text(`${HELP_EXT}.`, startX + preW, y, { lineBreak: false });

  // Bottom navy strip.
  doc.save();
  doc.roundedRect(bandX, H - inset - 6 - 8, bandW, 8, 3).fill(NAVY);
  doc.restore();

  doc.end();
  return doc;
}
