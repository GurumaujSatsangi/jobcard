// Technician pages: passcode login and signed-receipt photo.
// Same module URL as the page's Bootstrap script, so this is the same instance.
import { Dialog } from "/vendor/bootstrap/js/bootstrap.bundle.min.js";

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
