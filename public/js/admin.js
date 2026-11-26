// Admin dashboard: job cards, AC database and preventive services.
// Each card opens a dialog with a list view and a detail/form view.
const DATA = JSON.parse(document.getElementById("adminData").textContent);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : esc(v));

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/admin/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { errors: data.errors || {} });
  return data;
}

const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

function showView(dialog, name) {
  $$("[data-view]", dialog).forEach((v) => (v.hidden = v.dataset.view !== name));
  $(".dialog-body", dialog).scrollTop = 0;
}

function setBusy(btn, busy, label = "Saving…") {
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-sm" aria-hidden="true"></span> ${label}`;
  } else if (btn.dataset.label) {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
  }
}

function showFormError(form, err) {
  const box = $("[data-form-error]", form);
  box.innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span>`;
  box.hidden = false;
  $$(".is-invalid", form).forEach((el) => el.classList.remove("is-invalid"));
  $$(".invalid-feedback", form).forEach((el) => el.classList.remove("d-block"));
  for (const [name, msg] of Object.entries(err.errors || {})) {
    $$(`[name="${name}"]`, form).forEach((el) => el.classList.add("is-invalid"));
    const fb = $(`.invalid-feedback[data-for="${name}"]`, form);
    if (fb) { fb.textContent = msg; fb.classList.add("d-block"); }
  }
  box.scrollIntoView({ block: "nearest" });
}

function clearFormError(form) {
  $("[data-form-error]", form).hidden = true;
  $$(".is-invalid", form).forEach((el) => el.classList.remove("is-invalid"));
  $$(".invalid-feedback", form).forEach((el) => el.classList.remove("d-block"));
}

// A searchable, paged list inside a dialog.
function createList({ dialog, url, columns, empty, rowAction }) {
  const area = $("[data-list]", dialog);
  const filters = $("[data-filters]", dialog);
  let page = 1;
  let seq = 0;

  async function load(p = page) {
    page = p;
    const params = new URLSearchParams({ page: String(page) });
    for (const el of $$("input, select", filters)) if (el.name && el.value) params.set(el.name, el.value);
    const mine = ++seq;
    area.innerHTML = '<div class="list-msg"><span class="spinner-border spinner-sm" aria-hidden="true"></span> Loading…</div>';
    try {
      const data = await api(`${typeof url === "function" ? url() : url}?${params}`);
      if (mine !== seq) return; // a newer search started
      render(data);
    } catch (err) {
      if (mine === seq) area.innerHTML = `<div class="flash flash-err"><i class="bi bi-exclamation-circle"></i><span>${esc(err.message)}</span></div>`;
    }
  }

  function render({ items, total, pages }) {
    const cols = typeof columns === "function" ? columns() : columns;
    if (!items.length) {
      area.innerHTML = `<div class="list-msg">${esc(typeof empty === "function" ? empty() : empty)}</div>`;
      return;
    }
    area.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join("")}<th></th></tr></thead>
          <tbody>${items.map((it, i) => `<tr>${cols.map((c) => `<td data-label="${esc(c.label)}">${c.render(it)}</td>`).join("")}
            <td class="text-end">${rowAction ? rowAction.render(it, i) : ""}</td></tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="pager">
        <span class="text-muted-2 small">${total} result${total === 1 ? "" : "s"} · page ${page} of ${pages}</span>
        <span class="d-flex gap-2">
          <button type="button" class="btn btn-subtle theme-secondary btn-sm" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Previous</button>
          <button type="button" class="btn btn-subtle theme-secondary btn-sm" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button>
        </span>
      </div>`;
    if (rowAction) {
      $$("[data-row]", area).forEach((btn) =>
        btn.addEventListener("click", () => rowAction.onClick(items[Number(btn.dataset.row)])),
      );
    }
  }

  area.addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b && !b.disabled) load(Number(b.dataset.page));
  });
  const reload = debounce(() => load(1));
  filters.addEventListener("input", reload);
  filters.addEventListener("change", reload);
  filters.addEventListener("submit", (e) => { e.preventDefault(); load(1); });

  return { load, reload: () => load(page) };
}

// Download button for the printable job card: a link when available,
// a disabled button (with a reason on hover) until a technician is assigned.
const receiptButton = (url, size) => url
  ? `<a class="btn btn-subtle theme-secondary ${size}" href="${esc(url)}" target="_blank" rel="noopener" title="Download the job card PDF"><i class="bi bi-file-earmark-arrow-down" aria-hidden="true"></i> Receipt</a>`
  : `<button type="button" class="btn btn-subtle theme-secondary ${size}" disabled title="Available after a technician is assigned"><i class="bi bi-file-earmark-arrow-down" aria-hidden="true"></i> Receipt</button>`;

const statusPill = (s) =>
  `<span class="pill ${/CLOSED/.test(s) ? "pill-done" : ""}">${esc(s)}</span>`;

/* ================= Job cards ================= */
{
  const dialog = $("#jobsDialog");
  const detail = $("[data-detail]", dialog);

  const list = createList({
    dialog,
    url: "/admin/api/job-cards",
    empty: "No job cards match.",
    columns: [
      { label: "ARN", render: (j) => `<span class="font-monospace fw-semibold">${esc(j.arn)}</span>` },
      { label: "Submitted", render: (j) => dash(j.submittedOn) },
      { label: "Indentor", render: (j) => `${esc(j.indentor)}<div class="small text-muted-2">${esc(j.department)}</div>` },
      { label: "Section", render: (j) => esc(j.section) },
      { label: "CREW No.", render: (j) => dash(j.crewSerialNumber) },
      { label: "Status", render: (j) => statusPill(j.status) },
      { label: "Technician", render: (j) => dash(j.technician) },
    ],
    rowAction: {
      // "Receipt" (the printable job card) is enabled once a technician is assigned.
      render: (j, i) => `<span class="row-actions">
        ${receiptButton(j.receiptUrl, "btn-sm")}
        <button type="button" class="btn btn-outline theme-primary btn-sm" data-row="${i}">${j.technician || /CLOSED/.test(j.status) ? "View" : "Assign"}</button>
      </span>`,
      onClick: (j) => openJob(j.arn),
    },
  });

  async function openJob(arn) {
    showView(dialog, "detail");
    detail.innerHTML = '<div class="list-msg"><span class="spinner-border spinner-sm"></span> Loading…</div>';
    try {
      renderJob(await api(`/admin/api/job-cards/${encodeURIComponent(arn)}`));
    } catch (err) {
      detail.innerHTML = `<div class="flash flash-err"><span>${esc(err.message)}</span></div>`;
    }
  }

  function renderJob(j) {
    const rows = [
      ["Status", statusPill(j.status)],
      ["Section", esc(j.sectionLabel)],
      ["Indentor", `${esc(j.indentor)}<div class="small text-muted-2">${esc(j.email)} · Ext. ${esc(j.contact)}</div>`],
      ["School / Department / Section / Unit", esc(j.department)],
      j.itemType && ["Item type", esc(j.itemType)],
      j.crewSerialNumber && ["CREW serial no.", esc(j.crewSerialNumber)],
      j.detailsCorrect === false && ["AC details", "Indentor said the AC details were <strong>not</strong> correct"],
      ["Description", esc(j.description)],
      ["Submitted", dash(j.submittedOn)],
      ["Technician", j.technician ? `${esc(j.technician)} · Ext. ${esc(j.technicianPhone)}<div class="small text-muted-2">Assigned ${dash(j.assignedAt)}</div>` : "Not assigned yet"],
      j.materials && ["Materials issued", `${esc(j.materials)}<div class="small text-muted-2">${dash(j.materialIssuedAt)}</div>`],
      j.closedAt && ["Closed", dash(j.closedAt)],
      ["Files", j.files.length
        ? j.files.map((f) => `<div><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a> <span class="small text-muted-2">${esc(f.kind)} · ${f.sizeKb} KB</span></div>`).join("")
        : "None"],
    ].filter(Boolean);

    const options = j.technicians.map((t) =>
      `<option value="${t.id}" ${t.id === j.technicianId ? "selected" : ""}>${esc(t.name)} (Ext. ${esc(t.phone)})</option>`).join("");

    detail.innerHTML = `
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-4">
        <h3 class="h5 mb-0 font-monospace">${esc(j.arn)}</h3>
        ${receiptButton(j.receiptUrl, "")}
      </div>
      <div class="table-responsive mb-6"><table class="kv-table"><tbody>
        ${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("")}
      </tbody></table></div>
      ${j.closed ? "" : `
      <form class="assign-box" data-assign novalidate>
        <div class="flash flash-err" data-form-error role="alert" hidden></div>
        <label class="form-label" for="assignTech">${j.technician ? "Reassign to" : "Assign technician"} <span class="text-muted-2 fw-normal">(${esc(j.sectionLabel)})</span></label>
        ${j.technicians.length ? `
        <div class="input-group">
          <select class="form-control" id="assignTech" name="technicianId">
            ${j.technicianId ? "" : '<option value="">Choose a technician…</option>'}${options}
          </select>
          <button type="submit" class="btn btn-solid theme-primary">${j.technician ? "Reassign" : "Assign"}</button>
        </div>` : '<p class="text-muted-2 mb-0">No active technicians in this section yet.</p>'}
        <div class="flash flash-ok mt-3" data-ok hidden></div>
      </form>`}`;

    const form = $("[data-assign]", detail);
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearFormError(form);
      const btn = $("button[type=submit]", form);
      const technicianId = Number(form.technicianId.value);
      if (!technicianId) return showFormError(form, { message: "Choose a technician." });
      setBusy(btn, true, "Assigning…");
      try {
        await api(`/admin/api/job-cards/${encodeURIComponent(j.arn)}/assign`, { method: "POST", body: { technicianId } });
        await openJob(j.arn);
        const ok = $("[data-ok]", detail);
        if (ok) { ok.innerHTML = '<i class="bi bi-check-circle"></i><span>Technician assigned. It now shows on their My Jobs page.</span>'; ok.hidden = false; }
        list.reload();
      } catch (err) {
        setBusy(btn, false);
        showFormError(form, err);
      }
    });
  }

  $$("[data-back]", dialog).forEach((b) => b.addEventListener("click", () => showView(dialog, "list")));
  dialog.addEventListener("show.bs.dialog", () => { showView(dialog, "list"); list.load(1); });
}

/* ================= AC database ================= */
{
  const dialog = $("#acDialog");
  const form = $("#acForm");
  const fieldsBox = $("[data-fields]", form);
  let editing = null; // sr_no when editing, null when adding

  // Build the form from the shared field list, grouped into sections.
  const groups = [...new Set(DATA.acFields.map((f) => f.group))];
  fieldsBox.innerHTML = groups.map((g) => `
    <div class="form-section">
      <div class="form-section-title">${esc(g)}</div>
      <div class="row g-4">
        ${DATA.acFields.filter((f) => f.group === g).map((f) => `
          <div class="col-12 sm:col-6 lg:col-4">
            <label class="form-label" for="ac_${f.key}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>
            ${input(f)}
            ${f.help ? `<div class="form-text">${esc(f.help)}</div>` : ""}
            <div class="invalid-feedback" data-for="${f.key}"></div>
          </div>`).join("")}
      </div>
    </div>`).join("");

  function input(f) {
    const id = `ac_${f.key}`;
    if (f.type === "yesno" || f.type === "choice") {
      const opts = f.type === "yesno" ? [["1", "Yes"], ["0", "No"]] : f.options.map((o) => [o, o]);
      return `<select class="form-control" id="${id}" name="${f.key}"><option value="">—</option>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>`;
    }
    const type = f.type === "date" ? "date" : "text";
    const mode = f.type === "int" ? 'inputmode="numeric"' : f.type === "money" ? 'inputmode="decimal"' : "";
    // Auto-numbered fields are shown but never typed in.
    return `<input type="${type}" class="form-control" id="${id}" name="${f.key}" ${mode} ${f.max ? `maxlength="${f.max}"` : ""} ${f.required ? "required" : ""} ${f.auto ? "readonly tabindex=\"-1\"" : ""}>`;
  }

  const list = createList({
    dialog,
    url: "/admin/api/ac-units",
    empty: "No ACs match.",
    columns: [
      { label: "CREW No.", render: (a) => `<span class="font-monospace">${esc(a.crew_serial_number)}</span>` },
      { label: "Brand", render: (a) => dash(a.brand) },
      { label: "Type", render: (a) => dash([a.ac_type, a.capacity_tr && `${a.capacity_tr} T`].filter(Boolean).join(", ")) },
      { label: "Room", render: (a) => dash(a.room_number) },
      { label: "In-charge", render: (a) => dash(a.in_charge) },
      { label: "School", render: (a) => dash(a.school) },
      { label: "AMC", render: (a) => dash(a.amc) },
    ],
    rowAction: {
      render: (a, i) => `<span class="row-actions">
        <a class="btn btn-subtle theme-secondary btn-sm" href="/admin/api/ac-units/${a.sr_no}/keytag.pdf" target="_blank" rel="noopener"
           title="Printable keytag with QR code for ${esc(a.crew_serial_number)}"><i class="bi bi-qr-code" aria-hidden="true"></i> Keytag</a>
        <a class="btn btn-subtle theme-secondary btn-sm" href="/admin/api/ac-units/${a.sr_no}/history.pdf" target="_blank" rel="noopener"
           title="Service history PDF for ${esc(a.crew_serial_number)}"><i class="bi bi-clock-history" aria-hidden="true"></i> View service history</a>
        <button type="button" class="btn btn-outline theme-primary btn-sm" data-row="${i}">Edit</button>
      </span>`,
      onClick: (a) => openForm(a.sr_no),
    },
  });

  async function openForm(srNo) {
    form.reset();
    clearFormError(form);
    editing = srNo ?? null;
    $("[data-delete]", form).hidden = editing === null;
    $("[data-form-title]", form).textContent = editing === null ? "Add AC" : "Edit AC";
    $("[data-form-sub]", form).textContent = editing === null ? "Fill in what you know; every field is optional." : "Loading…";
    showView(dialog, "detail");
    if (editing === null) {
      // Show the number this AC will get (the server assigns it on save).
      try {
        const next = await api("/admin/api/ac-units/next");
        form.elements.sr_no.value = next.srNo;
        $("[data-form-sub]", form).textContent = `Will be added as ${next.crewSerialNumber}. Every field is optional.`;
      } catch { /* the server still assigns it */ }
      return form.elements.brand.focus();
    }
    try {
      const ac = await api(`/admin/api/ac-units/${editing}`);
      $("[data-form-sub]", form).textContent = ac.crew_serial_number;
      for (const f of DATA.acFields) {
        const el = form.elements[f.key];
        const v = ac[f.key];
        el.value = v === null || v === undefined ? "" : String(v);
      }
    } catch (err) {
      showFormError(form, err);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormError(form);
    const body = Object.fromEntries(DATA.acFields.map((f) => [f.key, form.elements[f.key].value]));
    const btn = $("[data-save]", form);
    setBusy(btn, true);
    try {
      let note;
      if (editing === null) {
        const created = await api("/admin/api/ac-units", { method: "POST", body });
        note = `Added ${created.crewSerialNumber}.`;
      } else {
        await api(`/admin/api/ac-units/${editing}`, { method: "PUT", body });
        note = `Saved ${$("[data-form-sub]", form).textContent}.`;
      }
      setBusy(btn, false);
      showView(dialog, "list");
      list.reload();
      listNote(note);
    } catch (err) {
      setBusy(btn, false);
      showFormError(form, err);
    }
  });

  $("[data-delete]", form).addEventListener("click", async (e) => {
    const crew = $("[data-form-sub]", form).textContent;
    if (!confirm(`Delete ${crew} from the AC database? This can't be undone.`)) return;
    const btn = e.currentTarget;
    setBusy(btn, true, "Deleting…");
    try {
      await api(`/admin/api/ac-units/${editing}`, { method: "DELETE" });
      setBusy(btn, false);
      showView(dialog, "list");
      list.reload();
    } catch (err) {
      setBusy(btn, false);
      showFormError(form, err);
    }
  });

  // A short success message above the list.
  function listNote(msg) {
    const note = document.createElement("div");
    note.className = "flash flash-ok";
    note.innerHTML = `<i class="bi bi-check-circle" aria-hidden="true"></i><span>${esc(msg)}</span>`;
    $("[data-list]", dialog).before(note);
    setTimeout(() => note.remove(), 6000);
  }

  /* ---- Bulk import from CSV ---- */
  const importView = $('[data-view="import"]', dialog);
  const fileInput = $("#acCsvFile");
  const previewBox = $("[data-import-preview]", importView);
  const importError = $("[data-import-error]", importView);
  let csvText = null;

  const actionPill = (a) =>
    a === "add" ? '<span class="pill pill-done">New</span>'
    : a === "update" ? '<span class="pill">Update</span>'
    : '<span class="pill pill-err">Problem</span>';

  function showImportError(msg) {
    importError.innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(msg)}</span>`;
    importError.hidden = false;
  }

  function resetImport() {
    csvText = null;
    fileInput.value = "";
    previewBox.innerHTML = "";
    importError.hidden = true;
    $("[data-file-name]", importView).textContent = "Nothing is saved until you click Import.";
  }

  async function postCsv(url) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/csv", Accept: "application/json" }, body: csvText });
    if (res.status === 401) { location.href = "/admin/login"; throw new Error("Signed out"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    importError.hidden = true;
    previewBox.innerHTML = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return showImportError("That file is over 5 MB. Split it into smaller files.");
    $("[data-file-name]", importView).textContent = file.name;
    csvText = await file.text();
    previewBox.innerHTML = '<div class="list-msg"><span class="spinner-border spinner-sm"></span> Checking the file…</div>';
    try {
      renderPreview(await postCsv("/admin/api/ac-units/import/preview"));
    } catch (err) {
      previewBox.innerHTML = "";
      showImportError(err.message);
    }
  });

  function renderPreview(p) {
    const { add, update, error } = p.counts;
    const notes = [
      p.unknownColumns.length && `Ignored columns not in the template: ${p.unknownColumns.join(", ")}.`,
      p.missingColumns.length && p.missingColumns.length < 10 && `Columns not in your file (left unchanged / empty): ${p.missingColumns.join(", ")}.`,
    ].filter(Boolean);
    previewBox.innerHTML = `
      <div class="form-section">
        <div class="form-section-title">3. Preview</div>
        <p class="mb-3"><strong>${p.total}</strong> row${p.total === 1 ? "" : "s"}:
          <strong>${add}</strong> new, <strong>${update}</strong> update${update === 1 ? "" : "s"}${error ? `, <strong class="text-danger">${error}</strong> with problems` : ""}.</p>
        ${notes.map((n) => `<p class="small text-muted-2 mb-2">${esc(n)}</p>`).join("")}
        ${error ? `<div class="flash flash-err"><i class="bi bi-exclamation-circle"></i><span>Fix these in the file, then choose it again. Nothing has been imported.</span></div>
          <ul class="problem-list">${p.problems.map((x) => `<li>${esc(x)}</li>`).join("")}${p.moreProblems ? `<li>…and ${p.moreProblems} more</li>` : ""}</ul>` : ""}
        <div class="table-responsive">
          <table class="data-table">
            <thead><tr><th>Line</th><th>Action</th><th>CREW No.</th><th>Brand</th><th>Room</th><th>In-charge</th><th>School</th><th>AMC</th></tr></thead>
            <tbody>${p.sample.map((r) => `<tr>
              <td>${r.line}</td><td>${actionPill(r.action)}</td>
              <td class="font-monospace">${r.crewSerialNumber ? esc(r.crewSerialNumber) : '<span class="text-muted-2">next number</span>'}</td>
              <td>${dash(r.brand)}</td><td>${dash(r.roomNumber)}</td><td>${dash(r.inCharge)}</td><td>${dash(r.school)}</td><td>${dash(r.amc)}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        ${p.total > p.sample.length ? `<p class="small text-muted-2 mt-2">Showing the first ${p.sample.length} of ${p.total} rows.</p>` : ""}
      </div>
      <div class="form-actions">
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-subtle theme-secondary" data-import-cancel>Cancel</button>
        <button type="button" class="btn btn-solid theme-primary" data-import-go ${error || !(add + update) ? "disabled" : ""}>
          Import ${add + update} AC${add + update === 1 ? "" : "s"}
        </button>
      </div>`;

    $("[data-import-cancel]", previewBox).addEventListener("click", resetImport);
    $("[data-import-go]", previewBox).addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, true, "Importing…");
      try {
        const r = await postCsv("/admin/api/ac-units/import/commit");
        resetImport();
        showView(dialog, "list");
        list.load(1);
        listNote(`Imported: ${r.added} added${r.newFrom ? ` (${r.newFrom}${r.newTo !== r.newFrom ? ` to ${r.newTo}` : ""})` : ""}, ${r.updated} updated.`);
      } catch (err) {
        setBusy(btn, false);
        showImportError(err.message);
      }
    });
  }

  $("[data-import]", dialog).addEventListener("click", () => { resetImport(); showView(dialog, "import"); });
  $("[data-add]", dialog).addEventListener("click", () => openForm(null));
  $$("[data-back]", dialog).forEach((b) => b.addEventListener("click", () => showView(dialog, "list")));
  dialog.addEventListener("show.bs.dialog", () => { showView(dialog, "list"); list.load(1); });
}

/* ================= Preventive service ================= */
{
  const dialog = $("#psDialog");
  const form = $("#psForm");
  const resetForm = $("#psResetForm");
  const typesBox = $("[data-types]", form);
  const techSelect = $("#psTechnician");
  let tab = "acs";
  let current = null; // the AC being applied for
  let resetInfo = null;

  const doneChips = (done) => DATA.preventiveTypes
    .map((t) => `<span class="chip-ps ${done.includes(t.value) ? "is-done" : ""}" title="${esc(t.label)}${done.includes(t.value) ? " – raised" : ""}">PS${t.value}</span>`)
    .join("");

  const columns = {
    acs: [
      { label: "CREW No.", render: (a) => `<span class="font-monospace">${esc(a.crewSerialNumber)}</span>` },
      { label: "Room", render: (a) => dash(a.roomNumber) },
      { label: "In-charge", render: (a) => dash(a.inCharge) },
      { label: "School", render: (a) => dash(a.school) },
      { label: "AMC till", render: (a) => dash(a.amcEnd) },
      { label: "Raised", render: (a) => `<span class="chips">${doneChips(a.done)}</span>` },
    ],
    services: [
      { label: "Reference", render: (s) => `<span class="font-monospace fw-semibold">${esc(s.ref)}</span>` },
      { label: "CREW No.", render: (s) => `<span class="font-monospace">${esc(s.crewSerialNumber)}</span>` },
      { label: "Place", render: (s) => dash(s.place) },
      { label: "Type", render: (s) => esc(s.serviceType) },
      { label: "Status", render: (s) => statusPill(s.status) },
      { label: "Technician", render: (s) => dash(s.technician) },
      { label: "Requested", render: (s) => `${dash(s.requestedOn)}<div class="small text-muted-2">${esc(s.requestedBy)}</div>` },
      { label: "Closed", render: (s) => (s.closedOn ? `${esc(s.closedOn)}${s.receiptUrl ? `<div><a href="${esc(s.receiptUrl)}" target="_blank" rel="noopener">Receipt</a></div>` : ""}` : "—") },
    ],
  };

  const list = createList({
    dialog,
    url: () => (tab === "acs" ? "/admin/api/preventive/acs" : "/admin/api/preventive/services"),
    empty: () => (tab === "acs" ? "No ACs under AMC match." : "No preventive service applications yet."),
    columns: () => columns[tab],
    rowAction: {
      render: (a, i) => {
        if (tab !== "acs") return "";
        const all = a.done.length >= DATA.preventiveTypes.length;
        return `<button type="button" class="btn btn-outline theme-primary btn-sm" data-row="${i}" ${all ? "disabled title=\"All four raised\"" : ""}>Apply</button>`;
      },
      onClick: (a) => openApply(a),
    },
  });

  function setTab(next) {
    tab = next;
    $$("[data-tab]", dialog).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $("[data-filters] input", dialog).placeholder = tab === "acs"
      ? "Search CREW number, room, in-charge or school" : "Search reference or CREW number";
    list.load(1);
  }
  $$("[data-tab]", dialog).forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  async function openApply(ac) {
    current = ac;
    form.reset();
    clearFormError(form);
    $("[data-ac-summary]", form).innerHTML = [
      ["CREW serial no.", `<span class="font-monospace">${esc(ac.crewSerialNumber)}</span>`],
      ["Brand / capacity", dash([ac.brand, ac.capacity && `${ac.capacity} Ton`].filter(Boolean).join(", "))],
      ["Room", dash(ac.roomNumber)], ["In-charge", dash(ac.inCharge)], ["School", dash(ac.school)], ["AMC till", dash(ac.amcEnd)],
    ].map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("");

    typesBox.innerHTML = DATA.preventiveTypes.map((t) => {
      const done = ac.done.includes(t.value);
      return `<label class="choice ${done ? "is-disabled" : ""}" for="psType${t.value}">
        <input class="radio" type="radio" name="serviceType" id="psType${t.value}" value="${t.value}" ${done ? "disabled" : ""}>
        <span>${esc(t.label)}${done ? ' <span class="small text-muted-2">(already raised)</span>' : ""}</span></label>`;
    }).join("");

    techSelect.innerHTML = '<option value="">Loading…</option>';
    showView(dialog, "apply");
    try {
      const techs = await api("/admin/api/technicians?section=AC_REFRIGERATION");
      techSelect.innerHTML = techs.length
        ? `<option value="">Choose a technician…</option>${techs.map((t) => `<option value="${t.id}">${esc(t.name)} (Ext. ${esc(t.phone)})</option>`).join("")}`
        : '<option value="">No active AC technicians</option>';
    } catch (err) {
      showFormError(form, err);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormError(form);
    const body = {
      crewSerialNumber: current.crewSerialNumber,
      technicianId: Number(techSelect.value) || null,
      serviceType: Number(form.serviceType.value) || null,
    };
    const errors = {};
    if (!body.technicianId) errors.technicianId = "Choose a technician.";
    if (!body.serviceType) errors.serviceType = "Choose the preventive service type.";
    if (Object.keys(errors).length) return showFormError(form, { message: "Please complete the form.", errors });

    const btn = $("[data-save]", form);
    setBusy(btn, true, "Applying…");
    try {
      const { ref } = await api("/admin/api/preventive/services", { method: "POST", body });
      setBusy(btn, false);
      showView(dialog, "list");
      list.reload();
      refreshReset();
      flashList(`Preventive service ${ref} raised and sent to the technician.`);
    } catch (err) {
      setBusy(btn, false);
      showFormError(form, err);
    }
  });

  function flashList(msg) {
    const area = $("[data-list]", dialog);
    const note = document.createElement("div");
    note.className = "flash flash-ok";
    note.innerHTML = `<i class="bi bi-check-circle"></i><span>${esc(msg)}</span>`;
    area.before(note);
    setTimeout(() => note.remove(), 6000);
  }

  // --- yearly reset ---
  async function refreshReset() {
    const btn = $("[data-reset]", dialog);
    const note = $("[data-reset-note]", dialog);
    try {
      resetInfo = await api("/admin/api/preventive/reset-status");
      btn.disabled = !resetInfo.enabled;
      btn.title = resetInfo.reason || `Download and empty the ${resetInfo.fyLabel} register`;
      note.textContent = resetInfo.lastReset
        ? `Last reset ${resetInfo.lastReset.at} by ${resetInfo.lastReset.by}`
        : resetInfo.reason || "";
    } catch {
      btn.disabled = true;
    }
  }

  $("[data-reset]", dialog).addEventListener("click", () => {
    if (!resetInfo?.enabled) return;
    resetForm.reset();
    clearFormError(resetForm);
    $("[data-save]", resetForm).disabled = true;
    $("[data-reset-summary]", resetForm).innerHTML =
      `The register has <strong>${resetInfo.total}</strong> application${resetInfo.total === 1 ? "" : "s"}` +
      (resetInfo.open ? `, of which <strong>${resetInfo.open}</strong> ${resetInfo.open === 1 ? "is" : "are"} still open and will disappear from technicians' lists.` : ".");
    showView(dialog, "reset");
    $("#psResetConfirm").focus();
  });

  $("#psResetConfirm").addEventListener("input", (e) => {
    $("[data-save]", resetForm).disabled = e.target.value.trim() !== "RESET";
  });

  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormError(resetForm);
    const btn = $("[data-save]", resetForm);
    setBusy(btn, true, "Resetting…");
    try {
      const res = await fetch("/admin/api/preventive/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/csv, application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Reset failed.");
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "preventive-services.csv";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setBusy(btn, false);
      showView(dialog, "list");
      list.load(1);
      refreshReset();
      flashList(`Downloaded ${name} and emptied the register.`);
    } catch (err) {
      setBusy(btn, false);
      showFormError(resetForm, err);
    }
  });

  $$("[data-back]", dialog).forEach((b) => b.addEventListener("click", () => showView(dialog, "list")));
  dialog.addEventListener("show.bs.dialog", () => { showView(dialog, "list"); setTab("acs"); refreshReset(); });
}
