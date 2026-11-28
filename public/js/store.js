// Store: issue items against an ARN (add-to-cart style), issue more later, or
// edit an earlier issue (slip). Quantities may be decimal where the item allows.
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dash = (v) => (v ? esc(v) : "—");
// ARNs contain "/"; in URLs they are written with "-" (the server turns them back).
const arnPath = (arn) => encodeURIComponent(String(arn).trim().replaceAll("/", "-"));

// Quantities as integer thousandths (avoids 0.1 + 0.2 problems).
const toMilli = (v) => Math.round(Number(v) * 1000);
const show = (milli) => String(Number((milli / 1000).toFixed(3)));

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/store/login"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

const flash = (kind, msg) =>
  `<div class="flash flash-${kind}" role="${kind === "err" ? "alert" : "status"}"><i class="bi bi-${kind === "err" ? "exclamation-circle" : "check-circle"}" aria-hidden="true"></i><span>${esc(msg)}</span></div>`;

const dialog = $("issueDialog");
const state = {
  job: null,          // current job card (from /api/job-cards/:arn)
  items: [],          // inventory
  cart: new Map(),    // itemId -> milli
  editing: null,      // slip being edited, or null
};

const byId = (id) => state.items.find((i) => i.id === id);

// Stock this screen may use for an item: in stock + what the slip being edited already holds.
function maxFor(item) {
  const onSlip = state.editing?.items.filter((l) => l.itemId === item.id).reduce((s, l) => s + toMilli(l.quantity), 0) ?? 0;
  return toMilli(item.available) + onSlip;
}

/* ---------- ARN ---------- */

async function loadJob(arn, note) {
  $("arnError").innerHTML = "";
  const btn = $("arnFindBtn");
  btn.disabled = true;
  try {
    const [job, items] = await Promise.all([api(`/store/api/job-cards/${arnPath(arn)}`), api("/store/api/items")]);
    state.job = job;
    state.items = items;
    state.cart.clear();
    state.editing = null;
    $("arnInput").value = job.arn;
    renderJob(note);
  } catch (err) {
    state.job = null;
    $("jobArea").hidden = true;
    $("arnError").innerHTML = flash("err", err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderJob(note) {
  const j = state.job;
  $("jobDetails").innerHTML = [
    ["ARN", `<span class="font-monospace fw-semibold">${esc(j.arn)}</span>`],
    ["Status", `<span class="pill ${j.issuable ? "" : "pill-err"}">${esc(j.status)}</span>`],
    ["Indentor", esc(j.indentor)],
    ["Section", esc(j.section)],
    j.crewSerialNumber && ["CREW Serial Number", `<span class="font-monospace">${esc(j.crewSerialNumber)}</span>`],
    ["Room / Lab No.", dash(j.roomNumber)],
    j.inCharge && ["Faculty / In-Charge", esc(j.inCharge)],
    ["School / Department", dash(j.department)],
    ["Assigned technician", `${dash(j.technician)}${j.technicianAmc ? ' <span class="pill pill-amc">AMC Staff</span>' : ""}`],
    j.technicianAmc && ["AMC", esc(j.technicianAmc)],
    ["Issue", dash(j.description)],
  ].filter(Boolean).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join("");

  // Earlier slips
  $("slipsSection").hidden = !j.slips.length;
  $("slipsList").innerHTML = j.slips.map((s) => `
    <article class="slip">
      <div class="slip-head">
        <div>
          <strong>MR Slip ${esc(s.mrSlipNo)}</strong>
          <div class="small text-muted-2">Issued ${esc(s.issuedAt)} by ${esc(s.issuedBy)}${s.updatedAt ? ` · edited ${esc(s.updatedAt)} by ${esc(s.updatedBy)}` : ""}</div>
        </div>
        ${j.issuable ? `<button type="button" class="btn btn-outline theme-primary btn-sm" data-edit-slip="${s.id}"><i class="bi bi-pencil" aria-hidden="true"></i> Edit</button>` : ""}
      </div>
      <table class="data-table"><thead><tr><th>Code</th><th>Item</th><th class="text-end">Quantity</th></tr></thead>
        <tbody>${s.items.map((l) => `<tr><td class="font-monospace">${esc(l.code)}</td><td>${esc(l.name)}</td><td class="text-end">${esc(l.quantity)} ${esc(l.unit)}</td></tr>`).join("")}</tbody>
      </table>
    </article>`).join("");

  // Issue form (only for allowed statuses)
  $("issueSection").hidden = false;
  $("issueError").hidden = true;
  if (!j.issuable) {
    $("issueSection").hidden = true;
    $("arnError").innerHTML = flash("err", j.notIssuableReason);
  } else if (note) {
    $("arnError").innerHTML = flash("ok", note);
  }
  setEditing(null);
  $("jobArea").hidden = false;
}

$("arnForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const arn = $("arnInput").value.trim();
  if (!arn) { $("arnError").innerHTML = flash("err", "Enter an ARN."); return $("arnInput").focus(); }
  loadJob(arn);
});

/* ---------- editing an earlier slip ---------- */

function setEditing(slip) {
  state.editing = slip;
  state.cart.clear();
  if (slip) for (const l of slip.items) state.cart.set(l.itemId, (state.cart.get(l.itemId) ?? 0) + toMilli(l.quantity));
  $("mrSlipNo").value = slip ? slip.mrSlipNo : "";
  $("mrSlipNo").classList.remove("is-invalid");
  $("mrSlipFeedback").classList.remove("d-block");
  $("issueHeading").textContent = slip ? `Editing MR Slip ${slip.mrSlipNo}` : state.job?.slips.length ? "Issue more items" : "Issue items";
  $("cancelEditBtn").hidden = !slip;
  $("issueSubmitBtn").textContent = slip ? "Save changes" : "Issue items";
  $("itemSearch").value = "";
  renderItems();
  renderCart();
}

$("slipsList").addEventListener("click", (e) => {
  const id = Number(e.target.closest("[data-edit-slip]")?.dataset.editSlip);
  if (!id) return;
  setEditing(state.job.slips.find((s) => s.id === id));
  $("issueSection").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("cancelEditBtn").addEventListener("click", () => setEditing(null));

/* ---------- inventory list with − / + ---------- */

function renderItems() {
  const q = $("itemSearch").value.trim().toLowerCase();
  const list = state.items.filter((i) => !q || i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  if (!state.items.length) {
    $("itemList").innerHTML = '<div class="list-msg">No items in the inventory yet.</div>';
    return;
  }
  if (!list.length) {
    $("itemList").innerHTML = `<div class="list-msg">No items match "${esc(q)}".</div>`;
    return;
  }
  $("itemList").innerHTML = list.map((i) => {
    const inCart = state.cart.get(i.id) ?? 0;
    const max = maxFor(i);
    const out = max <= 0;
    return `
      <div class="item-row ${inCart ? "in-cart" : ""}" data-id="${i.id}">
        <div class="item-info">
          <div class="item-name">${esc(i.name)}</div>
          <div class="small text-muted-2"><span class="font-monospace">${esc(i.code)}</span> · ${out ? '<span class="text-danger">Out of stock</span>' : `Available: <strong>${esc(show(max))}</strong> ${esc(i.unit)}`}</div>
        </div>
        <div class="qty-ctl" role="group" aria-label="Quantity of ${esc(i.name)}">
          <button type="button" class="qty-btn" data-step="-1" aria-label="Less" ${inCart <= 0 ? "disabled" : ""}>−</button>
          <input type="text" class="qty-input" inputmode="${i.decimalAllowed ? "decimal" : "numeric"}" value="${inCart ? esc(show(inCart)) : ""}"
                 placeholder="0" aria-label="Quantity" ${out && !inCart ? "disabled" : ""}>
          <button type="button" class="qty-btn" data-step="1" aria-label="More" ${inCart + 1000 > max ? "disabled" : ""}>+</button>
          <span class="qty-unit">${esc(i.unit)}</span>
        </div>
      </div>`;
  }).join("");
}

function setQty(item, milli, { rerenderRow = true } = {}) {
  const max = maxFor(item);
  milli = Math.max(0, Math.min(milli, max));
  if (milli) state.cart.set(item.id, milli); else state.cart.delete(item.id);
  if (rerenderRow) {
    const row = $("itemList").querySelector(`.item-row[data-id="${item.id}"]`);
    if (row) {
      row.classList.toggle("in-cart", milli > 0);
      row.querySelector(".qty-input").value = milli ? show(milli) : "";
      row.querySelector('[data-step="-1"]').disabled = milli <= 0;
      row.querySelector('[data-step="1"]').disabled = milli + 1000 > max;
    }
  }
  renderCart();
}

$("itemSearch").addEventListener("input", renderItems);

$("itemList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-step]");
  if (!btn) return;
  const item = byId(Number(btn.closest(".item-row").dataset.id));
  setQty(item, (state.cart.get(item.id) ?? 0) + Number(btn.dataset.step) * 1000);
});

// Typing a quantity: allow decimals (up to 3 places) only where the item allows.
$("itemList").addEventListener("input", (e) => {
  if (!e.target.classList.contains("qty-input")) return;
  const row = e.target.closest(".item-row");
  const item = byId(Number(row.dataset.id));
  const raw = e.target.value.trim();
  const ok = raw === "" || (item.decimalAllowed ? /^\d*(\.\d{0,3})?$/ : /^\d*$/).test(raw);
  e.target.classList.toggle("is-invalid", !ok);
  if (!ok) return;
  const milli = raw === "" || raw === "." ? 0 : toMilli(raw);
  const max = maxFor(item);
  if (milli > max) {
    e.target.classList.add("is-invalid");
    e.target.title = `Only ${show(max)} ${item.unit} available`;
    return;
  }
  e.target.title = "";
  setQty(item, milli, { rerenderRow: false });
  row.classList.toggle("in-cart", milli > 0);
  row.querySelector('[data-step="-1"]').disabled = milli <= 0;
  row.querySelector('[data-step="1"]').disabled = milli + 1000 > max;
});
$("itemList").addEventListener("change", (e) => {
  if (e.target.classList.contains("qty-input") && !e.target.classList.contains("is-invalid")) renderItems();
});

/* ---------- cart ---------- */

function renderCart() {
  const lines = [...state.cart].map(([id, milli]) => ({ item: byId(id), milli })).filter((l) => l.item);
  $("cartCount").textContent = `${lines.length} item${lines.length === 1 ? "" : "s"}`;
  $("cartLines").innerHTML = lines.length
    ? lines.map(({ item, milli }) => `
        <li>
          <span class="cart-name">${esc(item.name)}<span class="small text-muted-2 font-monospace d-block">${esc(item.code)}</span></span>
          <span class="cart-qty">${esc(show(milli))} ${esc(item.unit)}</span>
          <button type="button" class="btn-close" data-remove="${item.id}" aria-label="Remove ${esc(item.name)}"></button>
        </li>`).join("")
    : '<li class="cart-empty">Use + or type a quantity to add items.</li>';
  $("issueSubmitBtn").disabled = !lines.length;
}

$("cartLines").addEventListener("click", (e) => {
  const id = Number(e.target.closest("[data-remove]")?.dataset.remove);
  if (!id) return;
  setQty(byId(id), 0);
});

/* ---------- submit ---------- */

$("issueSubmitBtn").addEventListener("click", async () => {
  const mr = $("mrSlipNo").value.trim();
  $("issueError").hidden = true;
  if (!mr) {
    $("mrSlipNo").classList.add("is-invalid");
    $("mrSlipFeedback").classList.add("d-block");
    return $("mrSlipNo").focus();
  }
  const body = {
    mrSlipNo: mr,
    items: [...state.cart].map(([itemId, milli]) => ({ itemId, quantity: show(milli) })),
  };
  const btn = $("issueSubmitBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Saving…';
  try {
    const editing = state.editing;
    if (editing) await api(`/store/api/issues/${editing.id}`, { method: "PUT", body });
    else await api(`/store/api/job-cards/${arnPath(state.job.arn)}/issues`, { method: "POST", body });
    await loadJob(state.job.arn, editing ? `MR Slip ${mr} updated.` : `Items issued on MR Slip ${mr}.`);
  } catch (err) {
    $("issueError").innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span>`;
    $("issueError").hidden = false;
    btn.disabled = false;
    btn.textContent = label;
  }
});

$("mrSlipNo").addEventListener("input", () => {
  $("mrSlipNo").classList.remove("is-invalid");
  $("mrSlipFeedback").classList.remove("d-block");
});

// Fresh start each time the window opens.
dialog.addEventListener("show.bs.dialog", () => {
  state.job = null;
  state.cart.clear();
  state.editing = null;
  $("arnInput").value = "";
  $("arnError").innerHTML = "";
  $("jobArea").hidden = true;
  setTimeout(() => $("arnInput").focus(), 50);
});
