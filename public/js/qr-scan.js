// Shared "scan the QR on the keytag" dialog, used by the job card form and the
// technician's service history. Needs views/partials/qr-scan-dialog.ejs and
// the jsQR script on the page.
//
// Live camera needs HTTPS (or localhost); otherwise, or if the camera is
// refused, the person takes a photo of the keytag and it's read from that.
//
//   openQrScanner((crew) => { ...use the CREW serial number... });
import { Dialog } from "/vendor/bootstrap/js/bootstrap.bundle.min.js";

const CREW_RE = /^(?:IACS\s*\/\s*CREW\s*\/\s*AC\s*\/\s*)?\d{1,5}$/i;
let scanner = null;

function setup() {
  const $ = (id) => document.getElementById(id);
  const dialogEl = $("qrScanDialog");
  const dialog = Dialog.getOrCreateInstance(dialogEl);
  const video = $("qrVideo");
  const viewport = $("qrViewport");
  const canvas = $("qrCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const status = $("qrStatus");
  const photoInput = $("qrPhotoInput");
  const photoLabel = $("qrPhotoLabel");
  let stream = null;
  let timer = null;
  let onCode = null;

  const setStatus = (msg, isError = false) => {
    status.textContent = msg;
    status.classList.toggle("text-danger", isError);
  };

  function stopCamera() {
    clearTimeout(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  // Read a QR code from whatever is currently drawn on the canvas.
  function decode(w, h, thorough) {
    if (typeof window.jsQR !== "function") return null;
    const img = ctx.getImageData(0, 0, w, h);
    return window.jsQR(img.data, w, h, { inversionAttempts: thorough ? "attemptBoth" : "dontInvert" });
  }

  function handle(text) {
    const value = String(text || "").trim();
    if (!CREW_RE.test(value)) {
      setStatus("That QR code isn't from a CREW keytag. Try again.", true);
      return false;
    }
    stopCamera();
    dialog.hide();
    onCode?.(value.toUpperCase());
    return true;
  }

  function scanFrame() {
    if (!stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 640 / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const code = decode(w, h, false);
      if (code && handle(code.data)) return;
    }
    timer = setTimeout(scanFrame, 120);
  }

  async function startCamera() {
    viewport.hidden = true;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      photoLabel.textContent = "Take a photo of the QR";
      setStatus("Take a clear photo of the QR code on the keytag.");
      return;
    }
    photoLabel.textContent = "Take a photo instead";
    setStatus("Starting the camera…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (!dialogEl.open) return stopCamera(); // closed while waiting for permission
      video.srcObject = stream;
      await video.play();
      viewport.hidden = false;
      setStatus("Point the camera at the QR code on the keytag.");
      scanFrame();
    } catch {
      stopCamera();
      photoLabel.textContent = "Take a photo of the QR";
      setStatus("The camera couldn't be opened here. Take a photo of the QR code instead.");
    }
  }

  // createImageBitmap where available (fast, honours photo rotation);
  // otherwise an <img>, which older phone browsers support.
  async function loadImage(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file); } catch { /* fall back below */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    photoInput.value = "";
    if (!file) return;
    setStatus("Reading the photo…");
    try {
      const image = await loadImage(file);
      const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
      const w = Math.round(image.width * scale);
      const h = Math.round(image.height * scale);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(image, 0, 0, w, h);
      const code = decode(w, h, true);
      if (!code) setStatus("No QR code found in that photo. Hold the phone closer and try again.", true);
      else handle(code.data);
    } catch {
      setStatus("That photo couldn't be read. Please try again.", true);
    }
  });

  dialogEl.addEventListener("hidden.bs.dialog", stopCamera);

  return {
    open(callback) {
      onCode = callback;
      dialog.show();
      startCamera();
    },
  };
}

export function openQrScanner(onCode) {
  scanner ??= setup();
  scanner.open(onCode);
}
