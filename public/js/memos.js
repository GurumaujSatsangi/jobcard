// Memo record book (store and admin dashboards). List of all memos (newest
// memo date first) and a form to add one. The dialog says which API to use.
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD

const dialog = $("memoDialog");
const API = dialog.dataset.api;
const LOGIN = dialog.dataset.login;
let memos = [];

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = LOGIN; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), { errors: data.errors });
  return data;
}

function show(view) {
  for (const el of dialog.querySelectorAll("[data-memo-view]")) el.hidden = el.dataset.memoView !== view;
  dialog.querySelector(".dialog-body").scrollTop = 0;
}

function note(msg) {
  $("memoNote").innerHTML = msg ? `<i class="bi bi-check-circle" aria-hidden="true"></i><span>${esc(msg)}</span>` : "";
  $("memoNote").hidden = !msg;
}

/* ---------- list ---------- */

async function loadList() {
  $("memoMsg").innerHTML = '<div class="list-msg">Loading…</div>';
  $("memoRows").innerHTML = "";
  try {
    memos = await api(API);
    renderList();
  } catch (err) {
    $("memoMsg").innerHTML = `<div class="list-msg text-danger">${esc(err.message)}</div>`;
  }
}

function renderList() {
  const q = $("memoSearch").value.trim().toLowerCase();
  const list = memos.filter((m) => !q || m.description.toLowerCase().includes(q) || day(m.memoDate).toLowerCase().includes(q));
  $("memoMsg").innerHTML = !memos.length
    ? '<div class="list-msg">No memos yet. Use <strong>Add memo</strong> to record the first one.</div>'
    : !list.length ? `<div class="list-msg">No memos match "${esc(q)}".</div>` : "";
  $("memoRows").innerHTML = list.map((m) => `
    <tr>
      <td class="text-nowrap"><strong>${esc(day(m.memoDate))}</strong></td>
      <td><div class="memo-text">${esc(m.description)}</div>
        <div class="small text-muted-2 mt-1">Added by ${esc(m.addedBy)} · ${esc(m.addedAt)}</div></td>
    </tr>`).join("");
}

$("memoSearch").addEventListener("input", renderList);

/* ---------- add ---------- */

const form = $("memoForm");

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
    form.querySelector(`[name="${name}"]`)?.classList.add("is-invalid");
  }
  form.querySelector(".is-invalid")?.focus();
}

$("memoNewBtn").addEventListener("click", () => {
  form.reset();
  clearErrors();
  $("memoDate").value = today();
  show("new");
  setTimeout(() => $("memoDesc").focus(), 50);
});

dialog.addEventListener("click", (e) => {
  if (e.target.closest("[data-memo-back]")) show("list");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();
  const body = { memoDate: $("memoDate").value, description: $("memoDesc").value.trim() };
  const errors = {};
  if (!body.memoDate) errors.memoDate = "Memo date is required.";
  if (!body.description) errors.description = "Description is required.";
  if (Object.keys(errors).length) return showErrors({ message: "Please fill in the highlighted fields.", errors });

  const btn = form.querySelector('[type="submit"]');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-sm" aria-hidden="true"></span> Saving…';
  try {
    const memo = await api(API, { method: "POST", body });
    await loadList();
    show("list");
    note(`Memo dated ${day(memo.memoDate)} saved.`);
  } catch (err) {
    showErrors(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
});

/* ---------- open ---------- */

dialog.addEventListener("show.bs.dialog", () => {
  $("memoSearch").value = "";
  note("");
  show("list");
  loadList();
});
