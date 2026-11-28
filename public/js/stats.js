// Home page charts: two donut charts drawn as SVG from /api/stats, refreshed
// every 10 minutes (and when the tab comes back after being hidden that long).
// Colours are CSS variables (--chart-*) so light and dark mode each get their
// own blues. Hover, tap or focus a slice (or a legend row) for the exact number
// and percentage.
const REFRESH_MS = 10 * 60 * 1000;

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("en-IN");
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1).replace(/\.0$/, "")}%` : "0%");

const root = document.getElementById("stats");
const tip = document.getElementById("chartTip");
let lastLoad = 0;

// ---------- donut geometry ----------

const R = 90;   // outer radius
const r = 58;   // inner radius
const C = 100;  // centre (viewBox 0 0 200 200)

const pt = (radius, a) => [C + radius * Math.sin(a), C - radius * Math.cos(a)];
function slicePath(a0, a1) {
  // A full circle can't be one arc: draw it as two halves.
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    return `${slicePath(a0, a0 + Math.PI)} ${slicePath(a0 + Math.PI, a1)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
  return `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${large} 0 ${x3} ${y3} Z`;
}

function renderDonut(card, { items, totalLabel }) {
  const body = card.querySelector(".chart-body");
  const total = items.reduce((s, i) => s + i.count, 0);
  if (!total) {
    body.innerHTML = '<p class="chart-empty">No applications yet.</p>';
    return;
  }
  let a = 0;
  const slices = items.map((it, i) => {
    const a0 = a;
    a += (it.count / total) * Math.PI * 2;
    return it.count
      ? `<path d="${slicePath(a0, a)}" class="chart-slice" style="fill: var(${it.color})" data-i="${i}" tabindex="0"
           aria-label="${esc(it.label)}: ${nf.format(it.count)} (${pct(it.count, total)})"></path>`
      : "";
  }).join("");

  body.innerHTML = `
    <div class="chart-wrap">
      <svg viewBox="0 0 200 200" class="chart-svg" role="img" aria-label="${esc(card.querySelector(".chart-title").textContent)}">
        ${slices}
        <text x="100" y="98" class="chart-total" text-anchor="middle">${nf.format(total)}</text>
        <text x="100" y="118" class="chart-total-label" text-anchor="middle">${esc(totalLabel)}</text>
      </svg>
      <ul class="chart-legend">
        ${items.map((it, i) => `
          <li data-i="${i}" tabindex="0">
            <span class="chart-swatch" style="background: var(${it.color})" aria-hidden="true"></span>
            <span class="chart-legend-label">${esc(it.label)}</span>
            <span class="chart-legend-value">${nf.format(it.count)} <span>· ${pct(it.count, total)}</span></span>
          </li>`).join("")}
      </ul>
    </div>`;

  body.chartData = { items, total };
}

// Hover / tap / focus: highlight the slice and show the tooltip. Wired once
// per chart; reads the current data, so refreshes don't add listeners.
function wire(card) {
  const body = card.querySelector(".chart-body");
  const show = (i, x, y) => {
    const { items, total } = body.chartData;
    const it = items[i];
    body.querySelectorAll("[data-i]").forEach((el) => el.classList.toggle("is-dim", Number(el.dataset.i) !== i));
    tip.innerHTML = `<span class="chart-swatch" style="background: var(${it.color})"></span>
      <strong>${esc(it.label)}</strong><br>${nf.format(it.count)} of ${nf.format(total)} · <strong>${pct(it.count, total)}</strong>`;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(8, x - w / 2), innerWidth - w - 8)}px`;
    tip.style.top = `${Math.max(8, y - h - 14)}px`;
  };
  const hide = () => {
    body.querySelectorAll(".is-dim").forEach((el) => el.classList.remove("is-dim"));
    tip.hidden = true;
  };
  body.addEventListener("pointermove", (e) => {
    const el = e.target.closest("[data-i]");
    if (el) show(Number(el.dataset.i), e.clientX, e.clientY); else hide();
  });
  body.addEventListener("pointerleave", hide);
  body.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-i]");
    if (!el) return;
    const b = el.getBoundingClientRect();
    show(Number(el.dataset.i), b.left + b.width / 2, b.top);
  });
  body.addEventListener("focusout", hide);
}

// ---------- data ----------

async function load() {
  lastLoad = Date.now();
  try {
    const res = await fetch("/api/stats", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error();
    const d = await res.json();
    renderDonut(root.querySelector('[data-chart="ac"]'), {
      totalLabel: "total",
      items: [
        { label: "Job cards by users", count: d.ac.jobCards, color: "--chart-ac-1" },
        { label: "Preventive services", count: d.ac.preventive, color: "--chart-ac-2" },
      ],
    });
    renderDonut(root.querySelector('[data-chart="sections"]'), {
      totalLabel: "job cards",
      items: d.sections.map((s, i) => ({ label: s.label.replace(/ Section$/, ""), count: s.count, color: `--chart-${i + 1}` })),
    });
    const at = new Date(d.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    document.getElementById("statsUpdated").textContent = `Last updated ${at} · refreshes every 10 minutes`;
  } catch {
    document.getElementById("statsUpdated").textContent = "Couldn't load the latest numbers. Retrying in 10 minutes.";
  }
}

if (root) {
  root.querySelectorAll("[data-chart]").forEach(wire);
  addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastLoad >= REFRESH_MS) load();
  });
}
