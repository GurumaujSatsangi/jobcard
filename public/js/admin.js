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
      render: (j, i) => `<button type="button" class="btn btn-outline theme-primary btn-sm" data-row="${i}">${j.technician || /CLOSED/.test(j.status) ? "View" : "Assign"}</button>`,
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
      <h3 class="h5 mb-4 font-monospace">${esc(j.arn)}</h3>
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
    return `<input type="${type}" class="form-control" id="${id}" name="${f.key}" ${mode} ${f.max ? `maxlength="${f.max}"` : ""} ${f.required ? "required" : ""}>`;
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
      render: (_a, i) => `<button type="button" class="btn btn-outline theme-primary btn-sm" data-row="${i}">Edit</button>`,
      onClick: (a) => openForm(a.sr_no),
    },
  });

  async function openForm(srNo) {
    form.reset();
    clearFormError(form);
    editing = srNo ?? null;
    const srInput = form.elements.sr_no;
    srInput.readOnly = editing !== null;
    $("[data-delete]", form).hidden = editing === null;
    $("[data-form-title]", form).textContent = editing === null ? "Add AC" : "Edit AC";
    $("[data-form-sub]", form).textContent = editing === null ? "Fill in what you know; only SR No. is required." : "Loading…";
    showView(dialog, "detail");
    if (editing === null) return srInput.focus();
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
      if (editing === null) await api("/admin/api/ac-units", { method: "POST", body });
      else await api(`/admin/api/ac-units/${editing}`, { method: "PUT", body });
      setBusy(btn, false);
      showView(dialog, "list");
      list.reload();
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
