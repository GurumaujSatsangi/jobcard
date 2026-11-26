// Same module URL as the page's Bootstrap script, so this is the same instance.
import { Dialog } from "/vendor/bootstrap/js/bootstrap.bundle.min.js";
import { openQrScanner } from "/js/qr-scan.js";

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function api(url, options) {
    const res = await fetch(url, options);
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) throw Object.assign(new Error(body.error || "Request failed. Please try again."), { body, status: res.status });
    return body;
  }

  function setLoading(btn, loading, text) {
    if (loading) {
      btn.dataset.html = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-sm" aria-hidden="true"></span> ${text}`;
    } else if (btn.dataset.html) {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.html;
    }
  }

  /* ---------- Light / dark mode ---------- */
  $("#themeToggle")?.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-bs-theme", next);
    try { localStorage.setItem("jc-theme", next); } catch { /* storage unavailable */ }
  });

  /* ---------- Check status ---------- */
  const statusForm = $("#statusForm");
  const arnInput = $("#arnInput");
  const statusResult = $("#statusResult");

  function stepDetails(step) {
    const d = step.details;
    if (!d) return "";
    if (step.key === "assigned") {
      return `<div class="step-details">
        <div><span class="label">Technician:</span> ${esc(d.technician) || "—"}${d.amcName ? ' <span class="pill pill-amc">AMC Staff</span>' : ""}</div>
        ${d.amcName ? `<div><span class="label">AMC:</span> ${esc(d.amcName)}</div>` : ""}
        <div><span class="label">Contact:</span> ${d.phone ? `Ext. ${esc(d.phone)}` : "—"}</div>
      </div>`;
    }
    if (step.key === "material") {
      return `<div class="step-details">
        <div><span class="label">Materials:</span> ${esc(d.materials) || "—"}</div>
      </div>`;
    }
    return "";
  }

  function renderStatus(d) {
    // The first step not yet done is the one in progress.
    const currentIdx = d.steps.findIndex((s) => !s.done);
    const stepper = d.steps
      .map((s, i) => {
        const state = s.done ? "done" : i === currentIdx ? "current" : "pending";
        const label = s.done ? s.at : i === currentIdx ? "In progress" : "Pending";
        return `<li class="stepper-item ${s.done ? "active" : ""} is-${state}" ${i === currentIdx ? 'aria-current="step"' : ""}>
          <div class="step-body">
            <div class="step-title">${esc(s.title)}</div>
            <div class="step-time">${esc(label)}</div>
            ${stepDetails(s)}
          </div>
        </li>`;
      })
      .join("");

    const rows = [
      ["Name of Indentor", esc(d.indentor)],
      d.crewSerialNumber && ["CREW Serial Number", esc(d.crewSerialNumber)],
      ["Application Reference Number (ARN)", `<span class="font-monospace fw-semibold">${esc(d.arn)}</span>`],
      ["Description of Issue", esc(d.description)],
    ].filter(Boolean);

    return `
      <div class="status-head">
        <h3>${esc(d.section)}</h3>
        <span class="pill ${d.steps[3].done ? "pill-done" : ""}">${esc(d.status)}</span>
      </div>
      <ol class="stepper job-stepper" aria-label="Job card progress">${stepper}</ol>
      <div class="table-responsive">
        <table class="kv-table">
          <tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("")}</tbody>
        </table>
      </div>`;
  }

  statusForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const arn = arnInput.value.trim();
    arnInput.classList.toggle("is-invalid", !arn);
    $("#arnFeedback").classList.toggle("d-block", !arn);
    if (!arn) return arnInput.focus();

    const btn = $("#statusFetchBtn");
    setLoading(btn, true, "Fetching…");
    statusResult.hidden = false;
    const backBtn = cameFromEmail
      ? '<button type="button" class="btn btn-subtle theme-secondary btn-sm mb-4" data-back-to-email><i class="bi bi-arrow-left" aria-hidden="true"></i> Back to all applications</button>'
      : "";
    try {
      const d = await api(`/api/job-cards/${encodeURIComponent(arn)}`);
      statusResult.innerHTML = backBtn + renderStatus(d);
    } catch (err) {
      statusResult.innerHTML = `${backBtn}<div class="flash flash-err mb-0" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span></div>`;
    } finally {
      setLoading(btn, false);
      cameFromEmail = false;
    }
  });

  /* Search by email: list the indentor's applications, each with "View status". */
  const emailForm = $("#emailSearchForm");
  let mode = "arn";
  let cameFromEmail = false;
  let emailResultsHtml = ""; // kept so "Back to all applications" can restore it

  function setMode(next, { keepResult = false } = {}) {
    mode = next;
    $$("[data-status-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.statusMode === mode)));
    statusForm.hidden = mode !== "arn";
    emailForm.hidden = mode !== "email";
    if (!keepResult) {
      statusResult.hidden = true;
      statusResult.innerHTML = "";
    }
    (mode === "arn" ? arnInput : emailForm.email).focus();
  }
  $$("[data-status-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.statusMode)));

  emailForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailForm.email.value.trim();
    if (!email) return emailForm.email.focus();
    const btn = $("#emailSearchBtn");
    setLoading(btn, true, "Finding…");
    statusResult.hidden = false;
    try {
      const { results } = await api(`/api/job-cards-by-email?email=${encodeURIComponent(email)}`);
      emailResultsHtml = results.length
        ? `<p class="small text-muted-2 mb-2">${results.length} application${results.length === 1 ? "" : "s"} for ${esc(email)}</p>
          <div class="table-responsive">
            <table class="data-table">
              <thead><tr><th scope="col">ARN</th><th scope="col">Indentor</th><th scope="col">Section</th><th scope="col">Submitted</th><th></th></tr></thead>
              <tbody>${results.map((r) => `<tr>
                <td class="font-monospace fw-semibold">${esc(r.arn)}</td>
                <td>${esc(r.indentor)}</td>
                <td>${esc(r.section)}</td>
                <td>${esc(r.submittedOn)}</td>
                <td class="text-end"><button type="button" class="btn btn-outline theme-primary btn-sm" data-view-arn="${esc(r.arn)}">View status</button></td>
              </tr>`).join("")}</tbody>
            </table>
          </div>`
        : `<p class="text-muted-2 mb-0">No applications found for ${esc(email)}. Check the spelling, or search by ARN.</p>`;
      statusResult.innerHTML = emailResultsHtml;
    } catch (err) {
      statusResult.innerHTML = `<div class="flash flash-err mb-0" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span></div>`;
    } finally {
      setLoading(btn, false);
    }
  });

  statusResult.addEventListener("click", (e) => {
    const view = e.target.closest("[data-view-arn]");
    if (view) {
      // Show this ARN's tracker, with a way back to the list.
      setMode("arn", { keepResult: true });
      arnInput.value = view.dataset.viewArn;
      cameFromEmail = true;
      statusForm.requestSubmit();
      return;
    }
    if (e.target.closest("[data-back-to-email]")) {
      setMode("email", { keepResult: true });
      statusResult.innerHTML = emailResultsHtml;
    }
  });

  // Each time the dialog opens, start on "By ARN" with nothing filled in.
  $("#statusDialog")?.addEventListener("show.bs.dialog", () => {
    statusForm.reset();
    emailForm.reset();
    emailResultsHtml = "";
    setMode("arn");
  });

  /* ---------- New job card ---------- */
  const form = $("#jobCardForm");
  if (!form) return;

  const itemTypeGroup = $("#itemTypeGroup");
  const crewGroup = $("#crewGroup");
  const crewInput = $("#crewSerialNumber");
  const acDetails = $("#acDetails");
  const fileInput = $("#attachments");
  const fileList = $("#fileList");
  const formError = $("#formError");
  let selectedFiles = [];
  let fetchedCrew = null;

  const isAC = () => form.section.value === "AC_REFRIGERATION";
  const needsCrew = () => isAC() && form.itemType.value === "AIR_CONDITIONER";

  function showFieldError(name, message) {
    const fb = $(`.invalid-feedback[data-for="${name}"]`, form);
    if (fb) {
      if (message) fb.textContent = message;
      fb.classList.add("d-block");
    }
    $$(`[name="${name}"]`, form).forEach((el) => el.classList.add("is-invalid"));
  }

  function clearErrors() {
    formError.hidden = true;
    $$(".invalid-feedback", form).forEach((el) => el.classList.remove("d-block"));
    $$(".is-invalid", form).forEach((el) => el.classList.remove("is-invalid"));
  }

  function resetAcLookup() {
    fetchedCrew = null;
    acDetails.hidden = true;
    $$('[name="detailsCorrect"]', form).forEach((r) => (r.checked = false));
    $("#detailsNoHint").hidden = true;
  }

  function syncConditionalFields() {
    itemTypeGroup.hidden = !isAC();
    if (!isAC()) $$('[name="itemType"]', form).forEach((r) => (r.checked = false));
    crewGroup.hidden = !needsCrew();
    if (!needsCrew()) {
      crewInput.value = "";
      resetAcLookup();
    }
  }

  form.addEventListener("change", (e) => {
    const { name } = e.target;
    if (name === "section" || name === "itemType") syncConditionalFields();
    if (name === "detailsCorrect") $("#detailsNoHint").hidden = e.target.value !== "no";
    if (name) {
      $$(`[name="${name}"]`, form).forEach((el) => el.classList.remove("is-invalid"));
      $(`.invalid-feedback[data-for="${name}"]`, form)?.classList.remove("d-block");
    }
  });

  crewInput.addEventListener("input", () => {
    if (fetchedCrew && crewInput.value.trim().toUpperCase() !== fetchedCrew) resetAcLookup();
  });
  crewInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#crewFetchBtn").click(); }
  });

  $("#crewFetchBtn").addEventListener("click", async (e) => {
    const crew = crewInput.value.trim().toUpperCase();
    crewInput.classList.remove("is-invalid");
    $('.invalid-feedback[data-for="crewSerialNumber"]', form).classList.remove("d-block");
    resetAcLookup();
    if (!crew) return showFieldError("crewSerialNumber", "Please enter the CREW Serial Number.");

    const btn = e.currentTarget;
    setLoading(btn, true, "Fetching…");
    try {
      const { ac, activeArn } = await api(`/api/ac/${encodeURIComponent(crew)}`);
      if (activeArn) {
        return showFieldError("crewSerialNumber",
          `A Job Card (${activeArn}) for this Air Conditioner is already active and not yet completed.`);
      }
      const rows = [
        ["CREW Serial No.", ac.crewSerialNumber],
        ["Brand", ac.brand],
        ["Type / Capacity", ac.type],
        ["Faculty / Staff / In-charge", ac.inCharge],
        ["School", ac.school],
        ["Room No.", ac.roomNumber],
        ["Warranty", ac.warranty],
        ["AMC", ac.amc],
        ["AMC Work Order No.", ac.amcWorkOrderNo],
        ["AMC Start Date", ac.amcStartDate],
        ["AMC End Date", ac.amcEndDate],
      ];
      $("#acDetailsBody").innerHTML = rows
        .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${esc(v) || "—"}</td></tr>`)
        .join("");
      fetchedCrew = ac.crewSerialNumber.toUpperCase();
      crewInput.value = ac.crewSerialNumber;
      acDetails.hidden = false;
    } catch (err) {
      showFieldError("crewSerialNumber", err.message);
    } finally {
      setLoading(btn, false);
    }
  });

  /* "Forgot the CREW Serial Number?": search ACs by the in-charge's name.
     The search dialog opens on top of the job card dialog (shown directly, not
     via data-bs-toggle, so the form underneath stays open with its answers). */
  const searchDialogEl = $("#crewSearchDialog");
  const searchDialog = Dialog.getOrCreateInstance(searchDialogEl);
  const searchForm = $("#crewSearchForm");
  const searchResult = $("#crewSearchResult");

  $("#crewForgotBtn").addEventListener("click", () => {
    searchDialog.show();
    setTimeout(() => searchForm.name.focus(), 50);
  });

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = searchForm.name.value.trim();
    if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 3) {
      searchResult.innerHTML = '<p class="text-muted-2 mb-0">Type at least 3 letters of the name.</p>';
      return searchForm.name.focus();
    }
    const btn = $("#crewSearchBtn");
    setLoading(btn, true, "Searching…");
    try {
      const { results, more } = await api(`/api/ac-search?name=${encodeURIComponent(name)}`);
      if (!results.length) {
        searchResult.innerHTML = `<p class="text-muted-2 mb-0">No AC found for “${esc(name)}”. Try part of the name, e.g. just the surname, or call the Help Desk.</p>`;
        return;
      }
      searchResult.innerHTML = `
        <p class="small text-muted-2 mb-2">${results.length}${more ? "+" : ""} AC${results.length === 1 ? "" : "s"} found. Choose yours to fill in the CREW Serial Number.</p>
        <div class="table-responsive">
          <table class="data-table">
            <thead><tr>
              <th scope="col">CREW Serial No.</th><th scope="col">School / Department / Section / Unit</th>
              <th scope="col">Room No.</th><th scope="col">Brand</th><th scope="col">In-charge</th><th></th>
            </tr></thead>
            <tbody>${results.map((r, i) => `<tr>
              <td class="font-monospace">${esc(r.crewSerialNumber)}</td>
              <td>${esc(r.school) || "—"}</td>
              <td>${esc(r.roomNumber) || "—"}</td>
              <td>${esc(r.brand) || "—"}</td>
              <td>${esc(r.inCharge) || "—"}</td>
              <td class="text-end"><button type="button" class="btn btn-outline theme-primary btn-sm" data-pick="${i}">Use this</button></td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        ${more ? '<p class="small text-muted-2 mt-2 mb-0">Showing the first 50. Type more of the name to narrow it down.</p>' : ""}`;
      $$("[data-pick]", searchResult).forEach((b) =>
        b.addEventListener("click", () => useCrew(results[Number(b.dataset.pick)].crewSerialNumber)),
      );
    } catch (err) {
      searchResult.innerHTML = `<div class="flash flash-err mb-0" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span></div>`;
    } finally {
      setLoading(btn, false);
    }
  });

  // Put the chosen number in the job card form and load its details.
  function useCrew(crew) {
    searchDialog.hide();
    crewInput.value = crew;
    crewInput.dispatchEvent(new Event("input"));
    $("#crewFetchBtn").click();
  }

  // Start clean each time the search opens.
  searchDialogEl.addEventListener("hidden.bs.dialog", () => {
    searchForm.reset();
    searchResult.innerHTML = "";
  });

  /* "Scan QR on keytag": fill the CREW field from the keytag and fetch the AC
     details straight away (shared scanner in qr-scan.js). */
  $("#crewScanBtn").addEventListener("click", () => {
    openQrScanner((crew) => {
      crewInput.value = crew;
      crewInput.dispatchEvent(new Event("input"));
      $("#crewFetchBtn").click();
    });
  });

  /* Attachments */
  const MAX_FILES = 5;
  const MAX_SIZE = 10 * 1024 * 1024;
  const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  function renderFiles() {
    fileList.innerHTML = selectedFiles
      .map((f, i) => `<li><i class="bi bi-paperclip"></i><span class="name">${esc(f.name)}</span>
        <span class="text-muted-2">${fmtSize(f.size)}</span>
        <button type="button" class="btn-close" data-remove="${i}" aria-label="Remove ${esc(f.name)}"></button></li>`)
      .join("");
  }

  function addFiles(files) {
    const fb = $('.invalid-feedback[data-for="attachments"]', form);
    fb.classList.remove("d-block");
    const problems = [];
    for (const f of files) {
      if (!/\.(jpe?g|png|webp|pdf)$/i.test(f.name)) problems.push(`${f.name}: unsupported type`);
      else if (f.size > MAX_SIZE) problems.push(`${f.name}: larger than 10 MB`);
      else if (selectedFiles.length >= MAX_FILES) problems.push(`Only ${MAX_FILES} files allowed`);
      else selectedFiles.push(f);
    }
    if (problems.length) showFieldError("attachments", [...new Set(problems)].join(" · "));
    renderFiles();
  }

  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  fileList.addEventListener("click", (e) => {
    const i = e.target.closest("[data-remove]")?.dataset.remove;
    if (i !== undefined) { selectedFiles.splice(Number(i), 1); renderFiles(); }
  });
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("is-dragover"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("is-dragover"); }));
  dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  /* Client-side validation mirrors the server rules */
  function validate() {
    clearErrors();
    let ok = true;
    const fail = (name, msg) => { ok = false; showFieldError(name, msg); };

    ["firstName", "lastName", "email", "contactNumber", "department", "description"].forEach((n) => {
      const el = form.elements[n];
      el.value = el.value.trim();
      if (!el.checkValidity()) fail(n);
    });
    if (!form.section.value) fail("section");
    if (isAC() && !form.itemType.value) fail("itemType");
    if (needsCrew()) {
      if (!fetchedCrew) fail("crewSerialNumber", "Please enter the CREW Serial Number and press Fetch Data.");
      else if (!form.detailsCorrect.value) fail("detailsCorrect");
    }
    if (!ok) {
      formError.innerHTML = '<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>Please correct the highlighted fields.</span>';
      formError.hidden = false;
      $(".is-invalid", form)?.focus();
    }
    return ok;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const fd = new FormData(form);
    fd.delete("attachments");
    selectedFiles.forEach((f) => fd.append("attachments", f));

    const btn = $("#jobCardSubmitBtn");
    setLoading(btn, true, "Submitting…");
    try {
      const { arn } = await api("/api/job-cards", { method: "POST", body: fd });
      $("#successArn").textContent = arn;
      form.hidden = true;
      $("#jobCardSuccess").hidden = false;
      btn.hidden = true;
      $("#jobCardNewBtn").hidden = false;
      $("#jobCardCancelBtn").textContent = "Close";
    } catch (err) {
      Object.entries(err.body?.errors ?? {}).forEach(([k, v]) => showFieldError(k, v));
      formError.innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span>`;
      formError.hidden = false;
      formError.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } finally {
      setLoading(btn, false);
    }
  });

  function resetJobCard() {
    form.reset();
    clearErrors();
    selectedFiles = [];
    renderFiles();
    syncConditionalFields();
    form.hidden = false;
    $("#jobCardSuccess").hidden = true;
    $("#jobCardSubmitBtn").hidden = false;
    $("#jobCardNewBtn").hidden = true;
    $("#jobCardCancelBtn").textContent = "Cancel";
  }

  $("#jobCardNewBtn").addEventListener("click", resetJobCard);
  // Start fresh next time the dialog opens after a successful submission.
  $("#newJobCardDialog").addEventListener("hidden.bs.dialog", () => {
    if (form.hidden) resetJobCard();
  });

  $("#copyArnBtn").addEventListener("click", async (e) => {
    const icon = e.currentTarget.querySelector("i");
    try {
      await navigator.clipboard.writeText($("#successArn").textContent);
      icon.className = "bi bi-check2";
      setTimeout(() => (icon.className = "bi bi-copy"), 1500);
    } catch { /* clipboard unavailable */ }
  });
})();
