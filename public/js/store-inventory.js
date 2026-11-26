// Store: Manage inventory. All items with stock, register a new item, add a
// purchase record (adds stock) and open an item's issue record PDF.
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dash = (v) => (v ? esc(v) : "—");

const dialog = $("inventoryDialog");
const state = { items: [], item: null };

async function api(url, { method = "GET", body, form } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) { location.href = "/store/login"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { errors: data.errors });
  return data;
}

/* ---------- views ---------- */

function show(view) {
  for (const el of dialog.querySelectorAll("[data-inv-view]")) el.hidden = el.dataset.invView !== view;
  dialog.querySelector(".dialog-body").scrollTop = 0;
}

function note(msg) {
  $("invNote").innerHTML = msg ? `<i class="bi bi-check-circle" aria-hidden="true"></i><span>${esc(msg)}</span>` : "";
  $("invNote").hidden = !msg;
}

dialog.addEventListener("click", (e) => {
  if (e.target.closest("[data-inv-back]")) { show("list"); renderList(); }
});

/* ---------- list ---------- */

async function loadList() {
  $("invMsg").innerHTML = '<div class="list-msg">Loading…</div>';
  $("invRows").innerHTML = "";
  try {
    state.items = await api("/store/api/items");
    renderList();
  } catch (err) {
    $("invMsg").innerHTML = `<div class="list-msg text-danger">${esc(err.message)}</div>`;
  }
}

function renderList() {
  const q = $("invSearch").value.trim().toLowerCase();
  const list = state.items.filter((i) => !q || i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  $("invMsg").innerHTML = !state.items.length
    ? '<div class="list-msg">No items yet. Use <strong>Register new item</strong> to add the first one.</div>'
    : !list.length ? `<div class="list-msg">No items match "${esc(q)}".</div>` : "";
  $("invRows").innerHTML = list.map((i) => `
    <tr>
      <td class="font-monospace text-nowrap">${esc(i.code)}</td>
      <td>${esc(i.name)}${i.make ? `<div class="small text-muted-2">${esc(i.make)}</div>` : ""}</td>
      <td class="text-end text-nowrap ${Number(i.available) > 0 ? "" : "text-danger"}"><strong>${esc(i.available)}</strong> ${esc(i.unit)}</td>
      <td class="text-end">
        <span class="row-actions">
          <button type="button" class="btn btn-outline theme-primary btn-sm" data-add="${i.id}"><i class="bi bi-plus-circle" aria-hidden="true"></i> Add inventory record</button>
          <a class="btn btn-subtle theme-secondary btn-sm" href="/store/api/items/${i.id}/issues.pdf" target="_blank" rel="noopener"
             title="PDF of the ARNs ${esc(i.code)} was issued to"><i class="bi bi-file-earmark-pdf" aria-hidden="true"></i> Issued ARNs</a>
        </span>
      </td>
    </tr>`).join("");
}

$("invSearch").addEventListener("input", renderList);
$("invRows").addEventListener("click", (e) => {
  const id = Number(e.target.closest("[data-add]")?.dataset.add);
  if (id) openPurchase(id);
});

/* ---------- form helpers ---------- */

function clearErrors(form) {
  form.querySelector("[data-form-error]").hidden = true;
  for (const el of form.querySelectorAll(".is-invalid")) el.classList.remove("is-invalid");
  for (const fb of form.querySelectorAll(".invalid-feedback")) { fb.textContent = ""; fb.classList.remove("d-block"); }
}

function showErrors(form, err) {
  const box = form.querySelector("[data-form-error]");
  box.innerHTML = `<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span>`;
  box.hidden = false;
  let first = null;
  for (const [name, msg] of Object.entries(err.errors ?? {})) {
    const fb = form.querySelector(`.invalid-feedback[data-for="${name}"]`);
    if (fb) { fb.textContent = msg; fb.classList.add("d-block"); }
    for (const input of form.querySelectorAll(`[name="${name}"]`)) input.classList.add("is-invalid");
    first ??= form.querySelector(`[name="${name}"]`);
  }
  (first ?? box).scrollIntoView({ block: "center", behavior: "smooth" });
}

async function submitting(form, fn) {
  const btn = form.querySelector('[type="submit"]');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Saving…';
  try { await fn(); } catch (err) { showErrors(form, err); } finally { btn.disabled = false; btn.innerHTML = label; }
}

/* ---------- register new item ---------- */

$("invNewBtn").addEventListener("click", () => {
  const form = $("newItemForm");
  form.reset();
  clearErrors(form);
  show("new");
  setTimeout(() => $("niCode").focus(), 50);
});

$("newItemForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  const data = Object.fromEntries(new FormData(form));
  const errors = {};
  if (!data.code?.trim()) errors.code = "Item code is required.";
  if (!data.name?.trim()) errors.name = "Item description is required.";
  if (!data.unit) errors.unit = "Choose the unit of measurement.";
  if (!data.make?.trim()) errors.make = "Make / brand name is required.";
  if (Object.keys(errors).length) return showErrors(form, { message: "Please fill in the highlighted fields.", errors });
  submitting(form, async () => {
    const item = await api("/store/api/items", { method: "POST", body: data });
    await loadList();
    show("list");
    note(`${item.code} registered. Use "Add inventory record" to add its stock.`);
  });
});

/* ---------- add inventory (purchase) record ---------- */

async function openPurchase(id) {
  const form = $("purchaseForm");
  form.reset();
  clearErrors(form);
  note("");
  try {
    state.item = await api(`/store/api/items/${id}`);
  } catch (err) {
    $("invMsg").innerHTML = `<div class="flash flash-err" role="alert"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span>${esc(err.message)}</span></div>`;
    return;
  }
  renderPurchase();
  show("purchase");
  setTimeout(() => $("pHead").focus(), 50);
}

function renderPurchase() {
  const i = state.item;
  $("pItem").innerHTML = `<tr>
    <td class="font-monospace text-nowrap">${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td>
    <td>${dash(i.make)}</td><td class="text-end text-nowrap"><strong>${esc(i.available)}</strong> ${esc(i.unit)}</td></tr>`;
  $("pQtyUnit").textContent = `(${i.unit}${i.decimalAllowed ? "" : ", whole numbers"})`;
  $("pQty").inputMode = i.decimalAllowed ? "decimal" : "numeric";
  $("pHistorySection").hidden = !i.purchases.length;
  $("pHistory").innerHTML = i.purchases.map((p) => `<tr>
    <td class="text-nowrap">${esc(p.addedAt)}<div class="small text-muted-2">${esc(p.addedBy)}</div></td>
    <td>${esc(p.purchaseHead)}</td>
    <td class="text-end text-nowrap">${esc(p.quantity)} ${esc(i.unit)}</td>
    <td class="text-end text-nowrap">${p.rate ? `₹${esc(p.rate)}` : "—"}</td>
    <td class="text-nowrap">${[
      p.poFile && `<a href="${p.poFile}" target="_blank" rel="noopener">PO / Indent</a>`,
      p.invoiceFile && `<a href="${p.invoiceFile}" target="_blank" rel="noopener">Invoice</a>`,
    ].filter(Boolean).join(" · ") || "—"}</td>
    <td>${dash(p.remarks)}</td></tr>`).join("");
}

$("purchaseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  const i = state.item;
  const head = $("pHead").value.trim();
  const qty = $("pQty").value.trim();
  const rate = $("pRate").value.trim();
  const errors = {};
  if (!head) errors.purchaseHead = "Purchase head is required.";
  if (!qty) errors.quantity = "Quantity is required.";
  else if (!(i.decimalAllowed ? /^\d+(\.\d{1,3})?$/ : /^\d+$/).test(qty) || Number(qty) <= 0) {
    errors.quantity = i.decimalAllowed ? "Enter a quantity above 0 (up to 3 decimal places)." : `Enter a whole number above 0 (${i.unit}).`;
  }
  if (rate && !/^\d{1,12}(\.\d{1,2})?$/.test(rate)) errors.rate = "Enter the rate as a number, e.g. 250 or 249.50.";
  for (const f of [$("pPo"), $("pInvoice")]) {
    if (f.files[0]?.size > 10 * 1024 * 1024) errors[f.name] = "Each file must be 10 MB or smaller.";
  }
  if (Object.keys(errors).length) return showErrors(form, { message: "Please correct the highlighted fields.", errors });
  submitting(form, async () => {
    const updated = await api(`/store/api/items/${i.id}/purchases`, { method: "POST", form: new FormData(form) });
    await loadList();
    show("list");
    note(`Added ${qty} ${i.unit} to ${i.code}. Now in stock: ${updated.available} ${i.unit}.`);
  });
});

/* ---------- open ---------- */

dialog.addEventListener("show.bs.dialog", () => {
  $("invSearch").value = "";
  note("");
  show("list");
  loadList();
});
