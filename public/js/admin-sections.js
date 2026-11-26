// Admin: the five sections and their technicians (add, edit, reset passcode,
// delete/deactivate). A technician is only saved once they have shared their
// mobile number with the Telegram bot (so job alerts reach them); otherwise
// the admin can retry after 120 s.
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dash = (v) => (v ? esc(v) : "—");
const RETRY_SECONDS = 120;

const dialog = $("sectionsDialog");
const form = $("techForm");
const state = { sections: [], section: null, techs: [], editing: null };

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/admin/login"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), data);
  return data;
}

function show(view) {
  for (const v of dialog.querySelectorAll("[data-view]")) v.hidden = v.dataset.view !== view;
  dialog.querySelector(".dialog-body").scrollTop = 0;
}

const flash = (kind, html) =>
  `<div class="flash flash-${kind}" role="${kind === "err" ? "alert" : "status"}"><i class="bi bi-${kind === "err" ? "exclamation-circle" : "check-circle"}" aria-hidden="true"></i><div>${html}</div></div>`;

dialog.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (go === "sections") { show("sections"); loadSections(); }
  if (go === "techs") { stopCountdown(); show("techs"); }
});

/* ---------- sections ---------- */

async function loadSections() {
  $("sectionGrid").innerHTML = '<div class="list-msg">Loading…</div>';
  try {
    state.sections = await api("/admin/api/sections");
    $("sectionGrid").innerHTML = state.sections.map((s) => `
      <article class="section-tile">
        <h4><i class="bi bi-${esc(s.icon)}" aria-hidden="true"></i> <span>${esc(s.label)}</span></h4>
        <div class="small text-muted-2">Help desk Ext. ${esc(s.extension)}</div>
        <div class="small">${s.technicians} technician${s.technicians === 1 ? "" : "s"}${s.amcTechnicians ? ` · ${s.amcTechnicians} AMC` : ""}</div>
        <button type="button" class="btn btn-outline theme-primary btn-sm" data-section="${esc(s.value)}"><i class="bi bi-people" aria-hidden="true"></i> Manage technicians</button>
      </article>`).join("");
  } catch (err) {
    $("sectionGrid").innerHTML = flash("err", esc(err.message));
  }
}

$("sectionGrid").addEventListener("click", (e) => {
  const value = e.target.closest("[data-section]")?.dataset.section;
  if (!value) return;
  state.section = state.sections.find((s) => s.value === value);
  $("techNote").innerHTML = "";
  openSection();
});

/* ---------- technicians of a section ---------- */

async function openSection() {
  $("techSectionTitle").textContent = state.section.label;
  show("techs");
  await loadTechs();
}

async function loadTechs() {
  $("techMsg").innerHTML = '<div class="list-msg">Loading…</div>';
  $("techRows").innerHTML = "";
  try {
    state.techs = await api(`/admin/api/sections/${encodeURIComponent(state.section.value)}/technicians`);
    $("techMsg").innerHTML = state.techs.length ? "" : '<div class="list-msg">No technicians in this section yet.</div>';
    $("techRows").innerHTML = state.techs.map((t) => `
      <tr class="${t.active ? "" : "is-inactive"}">
        <td>
          <strong>${esc(t.name)}</strong>
          ${t.staffType === "AMC" ? '<span class="pill pill-amc">AMC Staff</span>' : '<span class="pill">IACS Staff</span>'}
          ${t.active ? "" : '<span class="pill pill-muted">Inactive</span>'}
          ${t.amcName ? `<div class="small">AMC: ${esc(t.amcName)}</div>` : ""}
        </td>
        <td class="text-nowrap">${dash(t.mobile)}${t.mobile && !t.telegramLinked ? '<div class="small text-danger">Telegram not linked: no job alerts</div>' : ""}</td>
        <td class="text-nowrap">${dash(t.extension)}</td>
        <td class="text-end">
          <span class="row-actions">
            ${t.active ? `
              <button type="button" class="btn btn-outline theme-primary btn-sm" data-edit="${t.id}">Edit</button>
              <button type="button" class="btn btn-subtle theme-secondary btn-sm" data-reset="${t.id}">Reset passcode</button>
              <button type="button" class="btn btn-subtle theme-danger btn-sm" data-delete="${t.id}"><i class="bi bi-trash" aria-hidden="true"></i> Delete</button>`
              : `<button type="button" class="btn btn-outline theme-primary btn-sm" data-reactivate="${t.id}">Reactivate</button>`}
          </span>
        </td>
      </tr>`).join("");
  } catch (err) {
    $("techMsg").innerHTML = flash("err", esc(err.message));
  }
}

const passcodeNote = (name, code, what) => flash("ok",
  `${esc(what)} Passcode for <strong>${esc(name)}</strong>: <span class="passcode">${esc(code)}</span>
   <div class="small">Give this to the technician now; it is stored only as a hash and can't be shown again.</div>`);

$("techRows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = Number(btn.dataset.edit || btn.dataset.reset || btn.dataset.delete || btn.dataset.reactivate);
  const t = state.techs.find((x) => x.id === id);
  if (!t) return;
  if (btn.dataset.edit) return openForm(t);
  try {
    if (btn.dataset.reset) {
      if (!confirm(`Give ${t.name} a new passcode? Their old passcode stops working and they are signed out.`)) return;
      const { passcode } = await api(`/admin/api/technicians/${id}/reset-passcode`, { method: "POST" });
      $("techNote").innerHTML = passcodeNote(t.name, passcode, "New passcode created.");
    } else if (btn.dataset.delete) {
      if (!confirm(`Delete ${t.name}? If they have job history the account is deactivated instead.`)) return;
      const r = await api(`/admin/api/technicians/${id}`, { method: "DELETE" });
      $("techNote").innerHTML = flash("ok", esc(r.message));
    } else if (btn.dataset.reactivate) {
      await api(`/admin/api/technicians/${id}/reactivate`, { method: "POST" });
      $("techNote").innerHTML = flash("ok", `${esc(t.name)} can sign in again with their existing passcode.`);
    }
    await loadTechs();
  } catch (err) {
    $("techNote").innerHTML = flash("err", esc(err.message));
  }
});

/* ---------- add / edit form ---------- */

function syncAmc() {
  const amc = form.staffType.value === "AMC";
  $("amcField").hidden = !amc;
  $("tAmc").required = amc;
}
form.addEventListener("change", (e) => { if (e.target.name === "staffType") syncAmc(); });

function clearErrors() {
  form.querySelector("[data-form-error]").hidden = true;
  for (const el of form.querySelectorAll(".is-invalid")) el.classList.remove("is-invalid");
  for (const fb of form.querySelectorAll(".invalid-feedback")) { fb.textContent = ""; fb.classList.remove("d-block"); }
}

function showErrors(err) {
  const box = form.querySelector("[data-form-error]");
  box.innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span>`;
  box.hidden = false;
  for (const [name, msg] of Object.entries(err.errors ?? {})) {
    const fb = form.querySelector(`.invalid-feedback[data-for="${name}"]`);
    if (fb) { fb.textContent = msg; fb.classList.add("d-block"); }
    for (const el of form.querySelectorAll(`[name="${name}"]`)) el.classList.add("is-invalid");
  }
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function openForm(tech = null) {
  state.editing = tech;
  form.reset();
  clearErrors();
  stopCountdown();
  $("telegramBlock").hidden = true;
  $("techFormTitle").textContent = tech ? `Edit ${tech.name}` : "Add technician";
  $("techFormSub").textContent = tech
    ? `${state.section.label}. A new mobile number must first be shared with the Telegram bot.`
    : `${state.section.label}. The technician must first share this mobile number with the Telegram bot; job alerts are sent there.`;
  if (tech) {
    $("tName").value = tech.name;
    form.querySelector(`[name="staffType"][value="${tech.staffType}"]`).checked = true;
    $("tAmc").value = tech.amcName ?? "";
    $("tMobile").value = tech.mobile ?? "";
    $("tExt").value = tech.extension ?? "";
  }
  syncAmc();
  $("techSubmit").textContent = tech ? "Save changes" : "Submit";
  show("techForm");
  setTimeout(() => $("tName").focus(), 50);
}

$("techAddBtn").addEventListener("click", () => openForm());

// ---- Telegram retry countdown ----
// While it runs, Submit is locked too, unless the mobile number is changed
// (so a mistyped number can be corrected straight away).
let timer = null;
let blockedMobile = null;
const lockSubmit = () => { $("techSubmit").disabled = blockedMobile !== null && $("tMobile").value.trim() === blockedMobile; };
$("tMobile").addEventListener("input", lockSubmit);
function stopCountdown() { clearInterval(timer); timer = null; blockedMobile = null; lockSubmit(); }
function startCountdown() {
  stopCountdown();
  let left = RETRY_SECONDS;
  blockedMobile = $("tMobile").value.trim();
  lockSubmit();
  const retry = $("telegramRetry");
  const tick = () => {
    if (left <= 0) { blockedMobile = null; lockSubmit(); }
    retry.disabled = left > 0;
    retry.textContent = left > 0 ? "Retry" : "Retry now";
    $("telegramCountdown").textContent = left > 0
      ? `You can retry in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
      : "Ready to check again.";
    if (left-- <= 0) stopCountdown();
  };
  tick();
  timer = setInterval(tick, 1000);
}
$("telegramRetry").addEventListener("click", () => { stopCountdown(); form.requestSubmit(); });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();
  const body = {
    name: $("tName").value.trim(),
    staffType: form.staffType.value,
    amcName: $("tAmc").value.trim(),
    mobile: $("tMobile").value.trim(),
    extension: $("tExt").value.trim(),
  };
  const errors = {};
  if (!body.name) errors.name = "Name of the technician is required.";
  if (!body.staffType) errors.staffType = "Choose IACS Staff or AMC Staff.";
  if (body.staffType === "AMC" && !body.amcName) errors.amcName = "Enter the name of the AMC.";
  const digits = body.mobile.replace(/\D/g, "");
  if (!body.mobile) errors.mobile = "Mobile number is required.";
  else if (!/^[6-9]\d{9}$/.test(digits.length > 10 && /^(91|0)/.test(digits) ? digits.slice(-10) : digits)) errors.mobile = "Enter a valid 10-digit mobile number.";
  if (Object.keys(errors).length) return showErrors({ message: "Please correct the highlighted fields.", errors });

  const btn = $("techSubmit");
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Checking Telegram…';
  $("telegramRetry").disabled = true;
  try {
    const editing = state.editing;
    const r = editing
      ? await api(`/admin/api/technicians/${editing.id}`, { method: "PUT", body })
      : await api("/admin/api/technicians", { method: "POST", body: { ...body, section: state.section.value } });
    stopCountdown();
    $("techNote").innerHTML = editing
      ? flash("ok", `${esc(r.technician.name)} updated.`)
      : passcodeNote(r.technician.name, r.passcode, "Technician account created.");
    show("techs");
    await loadTechs();
  } catch (err) {
    if (err.telegram) {
      // Number not shared with the bot yet: don't save; allow retry after 120 s.
      $("telegramMsg").textContent = err.message;
      $("telegramBlock").hidden = false;
      form.querySelector("[data-form-error]").hidden = true;
      $("telegramBlock").scrollIntoView({ block: "nearest", behavior: "smooth" });
      alert(`Account not created.\n\n${err.message}\n\nYou can retry after ${RETRY_SECONDS} seconds.`);
      startCountdown();
    } else {
      showErrors(err);
    }
  } finally {
    btn.textContent = label;
    btn.disabled = false;
    lockSubmit();
  }
});

/* ---------- open ---------- */

dialog.addEventListener("show.bs.dialog", () => {
  stopCountdown();
  show("sections");
  loadSections();
});
dialog.addEventListener("hidden.bs.dialog", stopCountdown);
