// Technician pages: passcode login, signed-receipt photo, service history.
// Same module URL as the page's Bootstrap script, so this is the same instance.
import { Dialog } from "/vendor/bootstrap/js/bootstrap.bundle.min.js";
import { openQrScanner } from "/js/qr-scan.js";

// Login: submit automatically once all 6 digits are entered.
const loginForm = document.getElementById("techLoginForm");
if (loginForm) {
  const otp = loginForm.querySelector("[data-bs-otp]");
  let submitted = false;
  const submit = () => {
    if (submitted) return;
    submitted = true;
    const btn = document.getElementById("techLoginBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Signing in…';
    loginForm.submit();
  };
  otp?.addEventListener("complete.bs.otpInput", submit);
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (loginForm.passcode.value.length === 6) submit();
    else loginForm.passcode.focus();
  });
}

// Receipt: the button opens the camera (capture="environment"). After the
// photo is taken it is shown in a dialog with "Retake photo" and
// "Submit and close job".
const dialogEl = document.getElementById("receiptDialog");
if (dialogEl) {
  const MAX = 15 * 1024 * 1024;
  const dialog = Dialog.getOrCreateInstance(dialogEl);
  const img = document.getElementById("receiptDialogImg");
  const noPreview = document.getElementById("receiptDialogNoPreview");
  const arnEl = document.getElementById("receiptDialogArn");
  const submitBtn = document.getElementById("receiptSubmitBtn");
  const retakeBtn = document.getElementById("receiptRetakeBtn");
  const submitLabel = submitBtn.innerHTML;

  let activeInput = null; // the job's <input type="file"> holding the photo
  let url = null;
  let submitting = false;

  const releasePreview = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    img.removeAttribute("src");
  };

  function showPhoto(input) {
    const file = input.files[0];
    if (!file) {
      // Camera was cancelled.
      if (dialogEl.open) dialog.hide();
      return;
    }
    if (!file.type.startsWith("image/")) {
      alert("Please take a photo of the signed receipt.");
      input.value = "";
      return;
    }
    if (file.size > MAX) {
      alert("This photo is too big. Please take it again.");
      input.value = "";
      return;
    }
    activeInput = input;
    releasePreview();
    url = URL.createObjectURL(file);
    img.hidden = false;
    noPreview.hidden = true;
    img.src = url;
    arnEl.textContent = input.dataset.arn;
    if (!dialogEl.open) dialog.show();
  }

  // Some phone formats (e.g. HEIC outside Safari) can't be previewed but still upload.
  img.addEventListener("error", () => {
    if (!img.getAttribute("src")) return;
    img.hidden = true;
    noPreview.hidden = false;
  });

  document.querySelectorAll(".receipt-input").forEach((input) => {
    input.addEventListener("change", () => showPhoto(input));
  });

  retakeBtn.addEventListener("click", () => activeInput?.click());

  submitBtn.addEventListener("click", () => {
    if (!activeInput?.files[0] || submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    retakeBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Uploading… please wait';
    activeInput.form.submit();
  });

  // Closed without submitting: forget the photo so nothing is uploaded by accident.
  dialogEl.addEventListener("hidden.bs.dialog", () => {
    if (submitting) return;
    if (activeInput) activeInput.value = "";
    activeInput = null;
    releasePreview();
    submitBtn.disabled = false;
    retakeBtn.disabled = false;
    submitBtn.innerHTML = submitLabel;
  });
}

// Service history: all job cards for one AC, by CREW number or keytag scan.
// Each job card is an accordion item (title: ARN, status, date; body: a table).
const historyForm = document.getElementById("historyForm");
if (historyForm) {
  const input = document.getElementById("historyCrew");
  const result = document.getElementById("historyResult");
  const btn = document.getElementById("historyFetchBtn");
  const label = btn.innerHTML;
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const dash = (v) => (v ? esc(v) : "—");
  const chevron = '<svg class="accordion-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const errorBox = (msg) => `<div class="flash flash-err mb-0" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(msg)}</span></div>`;

  function render({ ac, history }) {
    const summary = `
      <div class="history-ac">
        <div class="job-arn">${esc(ac.crewSerialNumber)}</div>
        <div class="small text-muted-2">${[ac.brand, ac.type].filter(Boolean).map(esc).join(" · ") || "—"}</div>
        <div class="small">${dash(ac.place)}${ac.inCharge ? ` · ${esc(ac.inCharge)}` : ""}</div>
      </div>`;
    if (!history.length) {
      return `${summary}<div class="empty"><i class="bi bi-inbox" aria-hidden="true"></i><strong>No job cards yet</strong>No job card has been raised for this AC.</div>`;
    }
    const items = history.map((h) => `
      <details class="accordion-item job">
        <summary class="accordion-header">
          <span class="history-title">
            <span class="job-arn">${esc(h.arn)}</span>
            <span class="pill ${h.closed ? "pill-done" : ""}">${esc(h.closed ? "Completed" : h.status)}</span>
            <span class="small text-muted-2">${dash(h.submittedOn)}</span>
          </span>
          ${chevron}
        </summary>
        <div class="accordion-body">
          <div class="table-responsive">
            <table class="kv-table"><tbody>
              <tr><th scope="row">ARN</th><td class="font-monospace">${esc(h.arn)}</td></tr>
              <tr><th scope="row">Issue</th><td>${dash(h.issue)}</td></tr>
              <tr><th scope="row">Material issued</th><td>${dash(h.materials)}</td></tr>
              <tr><th scope="row">Assigned on</th><td>${dash(h.assignedOn)}</td></tr>
              <tr><th scope="row">Completed on</th><td>${h.completedOn ? esc(h.completedOn) : "Not completed yet"}</td></tr>
              <tr><th scope="row">Assigned technician</th><td>${dash(h.technician)}</td></tr>
            </tbody></table>
          </div>
        </div>
      </details>`).join("");
    return `${summary}
      <p class="small text-muted-2 mt-4 mb-2">${history.length} job card${history.length === 1 ? "" : "s"}, newest first</p>
      <div class="accordion accordion-gap job-list">${items}</div>`;
  }

  async function load(crew) {
    if (!crew.trim()) {
      result.innerHTML = errorBox("Enter a CREW Serial Number or scan the keytag.");
      return input.focus();
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Loading…';
    try {
      const res = await fetch(`/technician/api/service-history?crew=${encodeURIComponent(crew)}`, { headers: { Accept: "application/json" } });
      if (res.status === 401) { location.href = "/technician/login"; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
      if (!data.ac) throw new Error("The server didn't send the history. Please reload the page and try again.");
      input.value = data.ac.crewSerialNumber;
      result.innerHTML = render(data);
    } catch (err) {
      result.innerHTML = errorBox(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  historyForm.addEventListener("submit", (e) => {
    e.preventDefault();
    load(input.value);
  });

  // Scanning fills the CREW number and shows the history straight away.
  document.getElementById("historyScanBtn").addEventListener("click", () => {
    openQrScanner((crew) => {
      input.value = crew;
      load(crew);
    });
  });

  // Start fresh each time the window opens.
  document.getElementById("historyDialog").addEventListener("show.bs.dialog", () => {
    historyForm.reset();
    result.innerHTML = "";
  });
}
