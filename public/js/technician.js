// Technician pages: passcode login and signed-receipt upload.
(() => {
  "use strict";

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
      btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Logging in…';
      loginForm.submit();
    };
    otp?.addEventListener("complete.bs.otpInput", submit);
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (loginForm.passcode.value.length === 6) submit();
      else loginForm.passcode.focus();
    });
  }

  // Receipt upload: show a preview, then a big "Submit & Close Job" button.
  const MAX = 15 * 1024 * 1024;
  document.querySelectorAll(".receipt-form").forEach((form) => {
    const input = form.querySelector(".receipt-input");
    const pick = form.querySelector(".receipt-pick");
    const preview = form.querySelector(".receipt-preview");
    const thumb = form.querySelector(".receipt-thumb");
    const fileRow = form.querySelector(".receipt-file");
    let url = null;

    input.addEventListener("change", () => {
      const file = input.files[0];
      if (url) URL.revokeObjectURL(url);
      if (!file) return;
      if (file.size > MAX) {
        alert("This file is too big. Please choose a photo or PDF under 15 MB.");
        input.value = "";
        return;
      }
      const isImage = file.type.startsWith("image/");
      url = isImage ? URL.createObjectURL(file) : null;
      thumb.hidden = !isImage;
      if (isImage) thumb.src = url;
      fileRow.hidden = isImage;
      fileRow.querySelector("span").textContent = file.name;
      pick.hidden = true;
      preview.hidden = false;
      form.querySelector(".receipt-submit").focus();
    });

    form.addEventListener("submit", () => {
      const btn = form.querySelector(".receipt-submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Uploading… please wait';
    });
  });
})();
