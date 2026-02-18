// ------------------------------------------------------------
// Ticket data (loaded from JSON)
// ------------------------------------------------------------
let TICKETS = []; // fyldes af loadTickets()

const SPORTS_ORDER = ["Rugby", "Hockey", "Cricket"];

// Læg JSON-filen i samme mappe som index.html
// (fx tickets_demo.json)
const TICKETS_JSON_URL = "./tickets_demo.json";

// ------------------------------------------------------------
// State (sport tabs er navigation, ikke filter)
// ------------------------------------------------------------
const state = {
  q: "",
  month: "all",
  typeSet: new Set(["Størrelse", "Levering", "Anbefaling", "Reklamation", "Klubindkøb", "Andet"]),
  assignee: "Alle",
  status: "Alle",
  sortBy: "date_desc"
};

// ------------------------------------------------------------
// Ticket overlay state (details + reply + reassignment)
// ------------------------------------------------------------
let overlayTicketId = null;

// Simple in-memory thread (prototype)
// repliesById[id] = [{ from, body, date, direction }]
const repliesById = {};

// ------------------------------------------------------------
// Persistens (localStorage)
// ------------------------------------------------------------
const LS_KEY = "uk_tickets_overrides_v1";
let overridesById = {}; // { [id]: { assignee, status, note, replies: [...] } }
const originalById = {}; // baseline fra JSON: { [id]: { assignee, status } }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function monthOf(dateStr) { return String(dateStr).slice(0, 7); }

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function loadOverrides() {
  const raw = localStorage.getItem(LS_KEY);
  const obj = safeJsonParse(raw, {});
  return (obj && typeof obj === "object") ? obj : {};
}

function saveOverrides() {
  localStorage.setItem(LS_KEY, JSON.stringify(overridesById));
}

function hasChanges(ticket) {
  const id = String(ticket?.id);
  const base = originalById[id];
  const replies = ensureTicketThread(id);
  if (!base) return replies.length > 0; // fallback
  return (
    String(ticket.assignee) !== String(base.assignee) ||
    String(ticket.status) !== String(base.status) ||
    replies.length > 0
  );
}

function ensureNote(ticket, actionText) {
  if (!ticket) return;
  if (!hasChanges(ticket)) {
    ticket.note = "";
    return;
  }
  const prefix = actionText ? String(actionText) : "Ændret";
  ticket.note = `${prefix} • ${fmtNow()}`;
}

function syncTicketToStorage(ticket) {
  if (!ticket) return;
  const id = String(ticket.id);

  if (!hasChanges(ticket)) {
    delete overridesById[id];
    saveOverrides();
    return;
  }

  // hvis der er ændringer men note er tom, så sæt en generel note
  if (!ticket.note) ensureNote(ticket, "Ændret");

  overridesById[id] = {
    assignee: ticket.assignee,
    status: ticket.status,
    note: ticket.note || "",
    replies: ensureTicketThread(id)
  };
  saveOverrides();
}

function applyOverridesToTickets() {
  for (const [id, ov] of Object.entries(overridesById)) {
    const t = TICKETS.find(x => String(x.id) === String(id));
    if (!t || !ov) continue;

    if (typeof ov.assignee === "string") t.assignee = ov.assignee;
    if (typeof ov.status === "string") t.status = ov.status;
    t.note = typeof ov.note === "string" ? ov.note : (t.note || "");
    if (Array.isArray(ov.replies)) repliesById[id] = ov.replies;
  }
}

// ------------------------------------------------------------
// Load tickets from JSON
// Supports both: [ ...tickets ] and { "tickets": [ ... ] }
// ------------------------------------------------------------
async function loadTickets(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Kunne ikke hente ${url} (${res.status})`);

    const data = await res.json();
    const tickets = Array.isArray(data) ? data : data.tickets;

    if (!Array.isArray(tickets)) {
      throw new Error("JSON format skal være et array af tickets (eller {tickets:[...]})");
    }

    // Gem som systemets dataset (ændrer ikke felter/struktur)
    TICKETS = tickets;

  } catch (err) {
    console.error(err);
    alert(
      "Kunne ikke loade tickets JSON.\n" +
      "Tip: Kør via en lokal server (ikke file://).\n\n" +
      String(err)
    );
    TICKETS = [];
  }
}

// ------------------------------------------------------------
// Filtering + sorting (på tværs af ALLE sports)
// ------------------------------------------------------------
function getFilteredTicketsAll() {
  let items = TICKETS.slice();

  if (state.q.trim()) {
    const q = state.q.trim().toLowerCase();
    items = items.filter(t =>
      String(t.id).includes(q) ||
      String(t.subject || "").toLowerCase().includes(q) ||
      String(t.body || "").toLowerCase().includes(q) ||
      String(t.sender || "").toLowerCase().includes(q) ||
      String(t.type || "").toLowerCase().includes(q) ||
      String(t.sport || "").toLowerCase().includes(q)
    );
  }

  if (state.month !== "all") {
    items = items.filter(t => monthOf(t.date) === state.month);
  }

  items = items.filter(t => state.typeSet.has(t.type));

  if (state.assignee !== "Alle") {
    items = items.filter(t => t.assignee === state.assignee);
  }

  if (state.status !== "Alle") {
    items = items.filter(t => t.status === state.status);
  }

  items.sort((a, b) => {
    switch (state.sortBy) {
      case "date_asc": return String(a.date).localeCompare(String(b.date));
      case "date_desc": return String(b.date).localeCompare(String(a.date));
      case "id_asc": return Number(a.id) - Number(b.id);
      case "id_desc": return Number(b.id) - Number(a.id);
      default: return 0;
    }
  });

  return items;
}

// ------------------------------------------------------------
// Render: tickets som sektioner (Rugby -> Hockey -> Cricket)
// ------------------------------------------------------------
function renderTickets() {
  const container = $("#tickets");
  container.innerHTML = "";

  const items = getFilteredTicketsAll();
  $("#resultCount").textContent = `${items.length} resultater`;

  if (!items.length) {
    container.innerHTML = `
      <div class="ticket">
        <div class="ticket__title">Ingen matches</div>
        <div class="ticket__body">Prøv at ændre filtre eller søgning.</div>
      </div>`;
    return;
  }

  // group by sport (fixed order)
  const bySport = {};
  for (const s of SPORTS_ORDER) bySport[s] = [];
  for (const t of items) (bySport[t.sport] ||= []).push(t);

  for (const sport of SPORTS_ORDER) {
    const sportItems = bySport[sport] || [];

    // section wrapper (observer target)
    const section = document.createElement("section");
    section.className = "sportSection";
    section.dataset.sport = sport;
    section.id = `section-${sport}`;

    // sticky section header
    const sh = document.createElement("div");
    sh.className = "sectionHeader";
    sh.innerHTML = `
      <div>${sport}</div>
      <div class="sectionBadge">${sportItems.length} tickets</div>
    `;
    section.appendChild(sh);

    // if empty after filters, show small note (but keep section so observer/tab nav still works)
    if (!sportItems.length) {
      const empty = document.createElement("div");
      empty.className = "ticket";
      empty.innerHTML = `
        <div class="ticket__title">Ingen tickets i ${sport}</div>
        <div class="ticket__body">Filtre/søgning har filtreret alt væk i denne sektion.</div>
      `;
      section.appendChild(empty);
      container.appendChild(section);
      continue;
    }

    // render tickets
    for (const t of sportItems) {
      const body = String(t.body || "");
      const excerpt = body.length > 140 ? body.slice(0, 140) + "…" : body;

      const el = document.createElement("article");
      el.className = "ticket ticketCard";
      el.dataset.id = String(t.id);
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.innerHTML = `
        <div class="ticket__title">#${escapeHtml(t.id)} - ${escapeHtml(t.subject)}</div>
        <div class="ticket__body">
          ${escapeHtml(excerpt)}
          ${body.length > 140 ? ` <button class="more" data-id="${escapeHtml(t.id)}">[Mere]</button>` : ``}
        </div>
        <div class="ticket__meta">
          <div class="metaItem"><b>Sport:</b> ${escapeHtml(t.sport)}</div>
          <div class="metaItem"><b>Type:</b> ${escapeHtml(t.type)}</div>
          <div class="metaItem"><b>Afsender:</b> ${escapeHtml(t.sender)}</div>
          <div class="metaItem"><b>Modtager:</b> ${escapeHtml(t.assignee)}</div>
          <div class="metaItem"><b>Status:</b> ${escapeHtml(t.status)}</div>
          <div class="metaItem"><b>Dato:</b> ${escapeHtml(t.date)}</div>
          <div class="metaItem"><b>Sikkerhed:</b> ${Math.round((Number(t.confidence) || 0) * 100)}/100</div>
          <div class="metaItem"><b>Note:</b> ${escapeHtml(t.note || "")}</div>
        </div>
      `;
      section.appendChild(el);
    }

    container.appendChild(section);
  }

  // bind "mere" (opens overlay)
  $$(".more").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = String(btn.dataset.id);
      openTicketOverlay(id);
    });
  });

  // (re)start observer after DOM changes
  setupSectionObserver();
}

// ------------------------------------------------------------
// Overlay helpers
// ------------------------------------------------------------
function getAssigneeOptions() {
  const base = ["Medarbejder", "Peter", "Ukendt"];
  const seen = new Set(base);
  for (const t of TICKETS) {
    const a = String(t.assignee || "").trim();
    if (a && !seen.has(a)) { seen.add(a); base.push(a); }
  }
  return base;
}

function ensureTicketThread(id) {
  if (!repliesById[id]) repliesById[id] = [];
  return repliesById[id];
}

function fmtNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function showToast(msg) {
  const el = $("#ovToast");
  if (!el) return;
  el.textContent = msg;
  if (!msg) return;
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => { el.textContent = ""; }, 2200);
}

function renderThread(ticket) {
  const host = $("#ovThread");
  if (!host) return;
  host.innerHTML = "";

  const msgs = [];
  // initial customer message
  msgs.push({
    from: ticket.sender || "Kunde",
    date: ticket.date || "–",
    body: ticket.body || "",
    direction: "in"
  });
  // replies
  const id = String(ticket.id);
  for (const r of ensureTicketThread(id)) msgs.push(r);

  for (const m of msgs) {
    const box = document.createElement("div");
    box.className = `msg ${m.direction === "out" ? "msg--out" : ""}`;
    const top = document.createElement("div");
    top.className = "msg__top";
    top.textContent = `${m.from} • ${m.date}`;
    const body = document.createElement("div");
    body.className = "msg__body";
    body.textContent = String(m.body || "");
    box.appendChild(top);
    box.appendChild(body);
    host.appendChild(box);
  }
}

function renderOverlayMeta(t) {
  if (!t) return;
  $("#ovTicketMeta").innerHTML = `
    <div><b>Afsender:</b> ${escapeHtml(t.sender)}</div>
    <div><b>Dato:</b> ${escapeHtml(t.date)}</div>
    <div><b>Modtager:</b> ${escapeHtml(t.assignee)}</div>
    <div><b>Status:</b> ${escapeHtml(t.status)}</div>
    <div><b>Sikkerhed:</b> ${Math.round((Number(t.confidence) || 0) * 100)}/100</div>
    <div><b>Note:</b> ${escapeHtml(t.note || "")}</div>
  `;
}

function renderOverlayBadges(t) {
  const st = $("#ovTicketStatus");
  st.textContent = t.status || "–";
  st.classList.toggle("badge--open", t.status === "Åben");
  st.classList.toggle("badge--closed", t.status === "Lukket");
}

function openTicketOverlay(id) {
  const t = TICKETS.find(x => String(x.id) === String(id));
  if (!t) return;

  overlayTicketId = String(t.id);

  // title + badges
  $("#ovTicketTitle").textContent = `#${t.id} — ${t.subject || ""}`;
  renderOverlayBadges(t);
  $("#ovTicketType").textContent = t.type || "–";
  $("#ovTicketSport").textContent = t.sport || "–";

  // full body + meta
  $("#ovTicketBody").textContent = String(t.body || "");
  renderOverlayMeta(t);

  // assignee select
  const sel = $("#ovAssignee");
  sel.innerHTML = "";
  for (const a of getAssigneeOptions()) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    sel.appendChild(opt);
  }
  sel.value = String(t.assignee || "Medarbejder");

  // status select
  const ss = $("#ovStatus");
  if (ss) ss.value = String(t.status || "Åben");

  // reply box
  $("#ovReply").value = "";
  showToast("");

  // thread
  renderThread(t);

  // show
  const ov = $("#ticketOverlay");
  ov.classList.add("is-open");
  ov.setAttribute("aria-hidden", "false");
  document.body.classList.add("noScroll");
  window.setTimeout(() => $("#ovClose")?.focus(), 0);
}

function closeTicketOverlay() {
  const ov = $("#ticketOverlay");
  ov.classList.remove("is-open");
  ov.setAttribute("aria-hidden", "true");
  document.body.classList.remove("noScroll");
  overlayTicketId = null;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ------------------------------------------------------------
// Dashboard (GLOBALT – ændrer sig ikke ved sport navigation)
// ------------------------------------------------------------
function computeDashboardGlobal() {
  const total = TICKETS.length;
  const solved = TICKETS.filter(t => t.status === "Lukket").length;
  const open = total - solved;

  const byType = {};
  const byAssignee = {};
  for (const t of TICKETS) {
    byType[t.type] = (byType[t.type] || 0) + 1;
    byAssignee[t.assignee] = (byAssignee[t.assignee] || 0) + 1;
  }
  return { total, solved, open, byType, byAssignee };
}

function renderDashboard() {
  const d = computeDashboardGlobal();
  $("#statSolved").textContent = `${pct(d.solved, d.total)}%`;
  $("#statOpen").textContent = `${pct(d.open, d.total)}%`;
  $("#statTotal").textContent = String(d.total);

  drawPie("#pieType", d.byType);
  drawPie("#pieAssignee", d.byAssignee);
  drawBars("#barChart", buildBarSeriesGlobal());
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function buildBarSeriesGlobal() {
  // total pr måned (mock)
  const months = ["2026-01", "2026-02", "2026-03"];
  return months.map(m => ({
    label: m,
    value: TICKETS.filter(t => monthOf(t.date) === m).length
  }));
}

// ------------------------------------------------------------
// SVG charts (samme som før)
// ------------------------------------------------------------
function drawBars(sel, series) {
  const svg = document.querySelector(sel);
  const W = 520, H = 240;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";

  const pad = { l: 46, r: 18, t: 18, b: 34 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const maxV = Math.max(1, ...series.map(s => s.value));
  const barW = plotW / series.length * 0.55;
  const gap = plotW / series.length * 0.45;

  svg.appendChild(svgRect(1, 1, W - 2, H - 2, 8, "#fff", "#d7d7d7"));

  for (let i = 0; i <= 3; i++) {
    const v = Math.round((maxV * (3 - i)) / 3);
    const y = pad.t + (plotH * i) / 3;
    svg.appendChild(svgLine(pad.l, y, W - pad.r, y, "#e9e9e9"));
    svg.appendChild(svgText(12, y + 4, String(v), 12, "#6c6c6c"));
  }

  series.forEach((s, i) => {
    const x0 = pad.l + i * (barW + gap) + gap / 2;
    const h = (s.value / maxV) * plotH;
    const y0 = pad.t + (plotH - h);
    const fill = (i % 2 === 0) ? "#bdbdbd" : "#222";
    svg.appendChild(svgRect(x0, y0, barW, h, 2, fill, "none"));
    svg.appendChild(svgText(x0 + barW / 2, H - 12, s.label, 11, "#6c6c6c", "middle"));
  });
}

function drawPie(sel, counts) {
  const svg = document.querySelector(sel);
  const W = 280, H = 160;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";

  const cx = 76, cy = 80, r = 56;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const fills = ["#e6e6e6", "#cfcfcf", "#a9a9a9", "#111", "#dcdcdc", "#bdbdbd"];

  let a0 = -Math.PI / 2;
  entries.forEach(([label, value], idx) => {
    const frac = value / total;
    const a1 = a0 + frac * 2 * Math.PI;
    svg.appendChild(svgPath(pieSlice(cx, cy, r, a0, a1), fills[idx % fills.length], "#777"));
    a0 = a1;
  });

  const lx = 160, ly = 26;
  entries.slice(0, 6).forEach(([label, value], i) => {
    const y = ly + i * 22;
    svg.appendChild(svgRect(lx, y - 10, 12, 12, 2, fills[i % fills.length], "#777"));
    svg.appendChild(svgText(lx + 18, y, `${label} (${value})`, 11, "#111"));
  });

  svg.appendChild(svgCircle(cx, cy, 22, "#f5f5f5", "#bbb"));
}

function pieSlice(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const largeArc = (a1 - a0) > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
}

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function svgRect(x, y, w, h, rx, fill, stroke) { return svgEl("rect", { x, y, width: w, height: h, rx, fill, stroke }); }
function svgLine(x1, y1, x2, y2, stroke) { return svgEl("line", { x1, y1, x2, y2, stroke, "stroke-width": 1 }); }
function svgText(x, y, text, size, color, anchor = "start") {
  const t = svgEl("text", { x, y, "font-size": size, fill: color, "text-anchor": anchor });
  t.textContent = text; return t;
}
function svgPath(d, fill, stroke) { return svgEl("path", { d, fill, stroke, "stroke-width": 1 }); }
function svgCircle(cx, cy, r, fill, stroke) { return svgEl("circle", { cx, cy, r, fill, stroke, "stroke-width": 1 }); }

// ------------------------------------------------------------
// Sport tabs: scroll til sektion i ticketsScroll
// ------------------------------------------------------------
function scrollToSport(sport) {
  const root = $("#ticketsScroll");
  const section = document.getElementById(`section-${sport}`);
  if (!root || !section) return;

  // Scroll inside the tickets pane only
  root.scrollTo({
    top: section.offsetTop - 8,
    behavior: "smooth"
  });
}

function setActiveTab(sport) {
  $$(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.sport === sport));
}

// ------------------------------------------------------------
// IntersectionObserver: marker aktiv tab baseret på sektion i view
// Root = ticketsScroll (ikke window)
// ------------------------------------------------------------
let sectionObserver = null;

function setupSectionObserver() {
  const root = $("#ticketsScroll"); // scroll-containeren
  if (!root) return;

  if (sectionObserver) {
    sectionObserver.disconnect();
    sectionObserver = null;
  }

  const sections = $$(".sportSection");
  if (!sections.length) return;

  // Justér denne hvis din sticky header/toolbar fylder mere/mindre
  const TOP_OFFSET = 90; // px

  sectionObserver = new IntersectionObserver((entries) => {
    // Find den sektion hvis top er nærmest "TOP_OFFSET" linjen i root
    // (dvs. den sektion du reelt kigger på i toppen)
    const candidates = entries
      .filter(e => e.isIntersecting)
      .map(e => {
        const dist = Math.abs(e.boundingClientRect.top - (root.getBoundingClientRect().top + TOP_OFFSET));
        return { sport: e.target.dataset.sport, dist };
      })
      .sort((a, b) => a.dist - b.dist);

    if (candidates.length) {
      setActiveTab(candidates[0].sport);
    }
  }, {
    root,
    threshold: 0,                 // trigger så snart noget krydser
    rootMargin: `-${TOP_OFFSET}px 0px -70% 0px` // "aktiver" når section top rammer under header
  });

  sections.forEach(sec => sectionObserver.observe(sec));
}

// ------------------------------------------------------------
// UI wiring
// ------------------------------------------------------------
function bindUI() {
  // sport tabs = navigation
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => scrollToSport(btn.dataset.sport));
  });

  // search
  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderTickets();
  });
  $("#btnSearch").addEventListener("click", () => renderTickets());

  // month
  $("#month").addEventListener("change", (e) => {
    state.month = e.target.value;
    renderTickets();
  });

  // type checkboxes
  $$(".typeChk").forEach(chk => {
    chk.addEventListener("change", () => {
      const v = chk.value;
      if (chk.checked) state.typeSet.add(v);
      else state.typeSet.delete(v);
      renderTickets();
    });
  });

  // assignee radios
  $$('input[name="assignee"]').forEach(r => {
    r.addEventListener("change", () => {
      state.assignee = r.value;
      renderTickets();
    });
  });

  // status radios
  $$('input[name="status"]').forEach(r => {
    r.addEventListener("change", () => {
      state.status = r.value;
      renderTickets();
    });
  });

  // sorting
  $("#sortBy").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderTickets();
  });

  // reset
  $("#btnReset").addEventListener("click", () => resetFilters());

  $("#btnFilter").addEventListener("click", () => {
    alert("Filter-panelet er allerede åbent i denne prototype 🙂");
  });

  // Ticket overlay events
  const ticketsHost = $("#tickets");
  ticketsHost.addEventListener("click", (e) => {
    const card = e.target.closest?.(".ticketCard");
    if (!card) return;
    openTicketOverlay(String(card.dataset.id));
  });
  ticketsHost.addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".ticketCard");
    if (!card) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTicketOverlay(String(card.dataset.id));
    }
  });

  // close handlers
  $("#ovClose").addEventListener("click", closeTicketOverlay);
  $("#ticketOverlay").addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeTicketOverlay();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const ov = $("#ticketOverlay");
      if (ov?.classList.contains("is-open")) closeTicketOverlay();
    }
  });

  // reply send
  $("#ovSend").addEventListener("click", () => {
    if (!overlayTicketId) return;
    const text = $("#ovReply").value.trim();
    if (!text) { showToast("Skriv et svar først."); return; }

    ensureTicketThread(overlayTicketId).push({
      from: "UK Sports (Admin)",
      date: fmtNow(),
      body: text,
      direction: "out"
    });

    $("#ovReply").value = "";
    const t = TICKETS.find(x => String(x.id) === overlayTicketId);
    if (t) {
      ensureNote(t, "Svar sendt");
      syncTicketToStorage(t);
      renderThread(t);
      renderOverlayMeta(t);
      renderTickets();
      renderDashboard();
    }
    showToast("Svar sendt (prototype).");
  });

  // save assignee
  $("#ovSaveAssignee").addEventListener("click", () => {
    if (!overlayTicketId) return;
    const t = TICKETS.find(x => String(x.id) === overlayTicketId);
    if (!t) return;

    const newA = $("#ovAssignee").value;
    if (String(t.assignee) === String(newA)) {
      showToast("Ingen ændring.");
      return;
    }

    t.assignee = newA;
    ensureNote(t, `Modtager ændret til ${newA}`);
    syncTicketToStorage(t);
    renderDashboard();
    renderTickets();
    renderOverlayMeta(t);
    showToast("Modtager opdateret.");
  });

  // save status
  $("#ovSaveStatus").addEventListener("click", () => {
    if (!overlayTicketId) return;
    const t = TICKETS.find(x => String(x.id) === overlayTicketId);
    if (!t) return;

    const newS = $("#ovStatus").value;
    if (String(t.status) === String(newS)) {
      showToast("Ingen ændring.");
      return;
    }

    t.status = newS;
    ensureNote(t, `Status ændret til ${newS}`);
    syncTicketToStorage(t);
    renderOverlayBadges(t);
    renderOverlayMeta(t);
    renderDashboard();
    renderTickets();
    showToast("Status opdateret.");
  });

  // quick escalate
  $("#ovEscalate").addEventListener("click", () => {
    $("#ovAssignee").value = "Peter";
    $("#ovSaveAssignee").click();
  });
}

function resetFilters() {
  state.q = "";
  $("#q").value = "";

  state.month = "all";
  $("#month").value = "all";

  state.typeSet = new Set(["Størrelse", "Levering", "Anbefaling", "Reklamation", "Klubindkøb", "Andet"]);
  $$(".typeChk").forEach(chk => chk.checked = true);

  state.assignee = "Alle";
  $$('input[name="assignee"]').forEach(r => r.checked = (r.value === "Alle"));

  state.status = "Alle";
  $$('input[name="status"]').forEach(r => r.checked = (r.value === "Alle"));

  state.sortBy = "date_desc";
  $("#sortBy").value = "date_desc";

  renderTickets();
}

// ------------------------------------------------------------
// Init (load JSON first, then render)
// ------------------------------------------------------------
(async function init() {
  bindUI();

  await loadTickets(TICKETS_JSON_URL);

  // baseline snapshot (til at afgøre om der er sket ændringer)
  for (const t of TICKETS) {
    const id = String(t.id);
    originalById[id] = { assignee: t.assignee, status: t.status };
    if (typeof t.note !== "string") t.note = "";
  }

  // load overrides (replies/assignee/status/note) from localStorage
  overridesById = loadOverrides();
  applyOverridesToTickets();

  renderDashboard();   // GLOBAL dashboard, unchanged by sport navigation
  renderTickets();     // tickets with sections + observer
})();
