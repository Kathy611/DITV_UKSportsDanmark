// ------------------------------------------------------------
// Den funktionelle del af prototypen
// ------------------------------------------------------------

// ------------------------------------------------------------
// Data + konstanter
// ------------------------------------------------------------
let tickets = []; // fyldes af loadTickets()

//Flere sports eller typer kan tilføjes senere
const SPORT_ORDER = ["Rugby", "Hockey", "Cricket"];

const DEFAULT_TYPE_OPTIONS = [
  "Størrelse",  "Levering",  "Anbefaling",
  "Reklamation", "Klubindkøb",  "Andet"
];

const ASSIGNEE_STAFF = "Medarbejder";
const ASSIGNEE_PETER = "Peter";

// Hvis sorteringen er tvivlsom (lav konfidens), skal den til medarbejder (ikke Peter)
const PETER_CONFIDENCE_THRESHOLD = 0.8;

// JSON-fil med dummy data fra Wizard Of Us testen
const TICKETS_DATA_URL = "./tickets_demo.json";

// ------------------------------------------------------------
// Filtre + navigation (state)
// ------------------------------------------------------------
const filterState = {
  searchText: "",
  monthFilter: "all",
  selectedTypes: new Set(DEFAULT_TYPE_OPTIONS),
  assigneeFilter: "Alle",
  statusFilter: "Alle",
  sortBy: "date_desc",

  // Aktiv sport (navigation): bestemmer hvilken sport vises først
  activeSport: SPORT_ORDER[0]
};

// ------------------------------------------------------------
// Detaljevisning + samtaletråd (prototype)
// ------------------------------------------------------------
let openTicketId = null;

// samtaletrådByTicketId[id] = [{ from, body, date, direction }]
// (En simpel samtaletråd pr. sag: afsender, tekst, dato og retning ind/ud)
const threadByTicketId = {};

// ------------------------------------------------------------
// Persistens i browseren (localStorage)
// ------------------------------------------------------------
const LOCAL_STORAGE_KEY = "uk_tickets_overrides_v1";
let overridesByTicketId = {};  // { [id]: { assignee, status, note, replies, types } }
const baselineByTicketId = {}; // baseline fra JSON: { [id]: { assignee, status, types } }

// ------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));

// Cache DOM-noder vi bruger ofte (fyldes i bindUI)
let ui = null;

/**
 * Cacher de DOM-elementer (knapper, felter, lister osv.) som UI’et hele tiden skal opdatere.
 * Bruges ved opstart, så resten af appen kan arbejde med `ui.*` i stedet for at slå elementer op igen og igen.
 */

function cacheUi() {
  ui = {
    // liste + filtre
    tickets: qs("#tickets"),
    ticketsScroll: qs("#ticketsScroll"),
    resultCount: qs("#resultCount"),
    searchInput: qs("#q"),
    btnSearch: qs("#btnSearch"),
    btnReset: qs("#btnReset"),
    month: qs("#month"),
    sortBy: qs("#sortBy"),

    // dashboard
    statSolved: qs("#statSolved"),
    statOpen: qs("#statOpen"),
    statTotal: qs("#statTotal"),

    // detaljevisning
    overlay: qs("#ticketOverlay"),
    ovClose: qs("#ovClose"),
    ovTicketTitle: qs("#ovTicketTitle"),
    ovTicketStatus: qs("#ovTicketStatus"),
    ovTicketType: qs("#ovTicketType"),
    ovTicketSport: qs("#ovTicketSport"),
    ovTicketBody: qs("#ovTicketBody"),
    ovTicketMeta: qs("#ovTicketMeta"),
    ovThread: qs("#ovThread"),
    ovReply: qs("#ovReply"),
    ovToast: qs("#ovToast"),
    ovSend: qs("#ovSend"),
    ovAssignee: qs("#ovAssignee"),
    ovSaveAssignee: qs("#ovSaveAssignee"),
    ovEscalate: qs("#ovEscalate"),
    ovStatus: qs("#ovStatus"),
    ovSaveStatus: qs("#ovSaveStatus"),
    ovTypeList: qs("#ovTypeList"),
    ovSaveType: qs("#ovSaveType"),

    // sport tabs
    tabs: qsa(".tab")
  };
}

// ------------------------------------------------------------
// Små utility-funktioner
// ------------------------------------------------------------
/**
 * Udleder måneds-nøglen `YYYY-MM` fra en dato.
 * Bruges til at gruppere og filtrere sager pr. måned i filteret.
 */

function getYearMonth(dateStr) {
  const s = String(dateStr || "");
  const yearMonth = s.slice(0, 7);
  return yearMonth;
}

/**
 * Parser en JSON-streng uden at hele appen går ned, hvis indholdet er ugyldigt.
 * Bruges især ved indlæsning fra localStorage eller andre kilder hvor data kan være fejlformateret.
 */

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Sammenligner to lister for at se om brugerens valg reelt har ændret sig.
 * Bruges fx til at undgå unødige gem/refresh, når filtre eller typer ikke er ændret.
 */

function arraysAreEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];

  if (aa.length !== bb.length) return false;

  for (let i = 0; i < aa.length; i++) {
    if (String(aa[i]) !== String(bb[i])) return false;
  }

  return true;
}

/**
 * Formatterer et “nu”-tidspunkt til brug i noter og historik.
 * Bruges når brugeren tilføjer en intern note eller opdatering på en sag.
 */

function formatNow() {
  const d = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");

  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());

  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());

  const datePart = `${year}-${month}-${day}`;
  const timePart = `${hours}:${minutes}`;

  return `${datePart} ${timePart}`;
}

/**
 * Gør tekst sikker at vise i UI ved at undgå at HTML bliver tolket.
 * Bruges når vi viser bruger- eller datafelter i UI, så indhold ikke kan “bryde” layoutet.
 */

function escapeHtml(str) {
  const s = String(str ?? "");
  const step1 = s.replaceAll("&", "&amp;");
  const step2 = step1.replaceAll("<", "&lt;");
  const step3 = step2.replaceAll(">", "&gt;");
  const step4 = step3.replaceAll('"', "&quot;");
  const step5 = step4.replaceAll("'", "&#039;");
  return step5;
}

/**
 * Finder den sag (i datastrukturen) som svarer til et givent id.
 * Bruges når brugeren klikker på et sagskort og vi skal åbne detaljevisningen.
 */

function getTicketById(id) {
  const idStr = String(id);
  return tickets.find(t => String(t.id) === idStr);
}

/**
 * Henter samtaletråden for en sag i et format som UI’et kan vise.
 * Bruges når detaljevisningen åbnes, så man kan læse historikken på sagen.
 */

function getThreadForTicket(ticketId) {
  const key = String(ticketId);
  if (!threadByTicketId[key]) threadByTicketId[key] = [];
  return threadByTicketId[key];
}

/**
 * Tilføjer en intern note/svar til en sag og opdaterer historikken.
 * Bruges når brugeren skriver i tekstfeltet i detaljevisningen og trykker send/gem.
 */

function appendNote(ticket, text, { withTime = true } = {}) {
  if (!ticket) return;

  const message = String(text);
  const line = withTime ? `${formatNow()} • ${message}` : message;

  const previous = String(ticket.note || "").trim();
  const combined = previous ? `${previous}\n${line}` : line;

  ticket.note = combined;
}

// ------------------------------------------------------------
// localStorage (overstyringer)
// ------------------------------------------------------------
/**
 * Indlæser tidligere manuelle rettelser (fx type, status eller ansvarlig) fra localStorage.
 * Bruges for at demo/prototype kan “huske” ændringer mellem side-loads.
 */

function loadOverridesFromStorage() {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
  const obj = safeJsonParse(raw, {});
  const ok = obj && typeof obj === "object";
  return ok ? obj : {};
}

/**
 * Gemmer manuelle rettelser (overstyringer) til localStorage.
 * Bruges efter brugeren ændrer en sag, så ændringen bevares ved genindlæsning.
 */

function saveOverridesToStorage() {
  const payload = JSON.stringify(overridesByTicketId);
  localStorage.setItem(LOCAL_STORAGE_KEY, payload);
}

/**
 * Afgør om en sag er blevet ændret siden sidste gang vi gemte/viste den.
 * Bruges til at beslutte om vi skal opdatere UI og gemme overstyringer.
 */

function ticketHasChanges(ticket) {
  const id = String(ticket?.id);
  const baseline = baselineByTicketId[id];

  const thread = getThreadForTicket(id);
  const hasThread = thread.length > 0;

  const noteText = String(ticket?.note || "").trim();
  const hasNote = noteText.length > 0;

  // Hvis vi ikke har baseline (burde ikke ske), så tjek kun note/svar
  if (!baseline) {
    return hasThread || hasNote;
  }

  const currentTypes = Array.isArray(ticket.types) ? ticket.types : [];
  const baselineTypes = Array.isArray(baseline.types) ? baseline.types : [];

  const assigneeChanged = String(ticket.assignee) !== String(baseline.assignee);
  const statusChanged = String(ticket.status) !== String(baseline.status);
  const typesChanged = !arraysAreEqual(currentTypes, baselineTypes);

  return assigneeChanged || statusChanged || typesChanged || hasThread || hasNote;
}

/**
 * Synkroniserer en ændret sag til overstyringer i localStorage.
 * Bruges efter brugerhandlinger (ændret type/status/ansvarlig), så demoen afspejler den nyeste tilstand.
 */

function syncTicketToStorage(ticket) {
  if (!ticket) return;

  const id = String(ticket.id);

  // Ingen ændringer? Så fjern override helt
  const changed = ticketHasChanges(ticket);
  if (!changed) {
    delete overridesByTicketId[id];
    saveOverridesToStorage();
    return;
  }

  const types = Array.isArray(ticket.types) ? ticket.types : [];
  const thread = getThreadForTicket(id);

  overridesByTicketId[id] = {
    assignee: ticket.assignee,
    status: ticket.status,
    note: ticket.note || "",
    replies: thread,
    types: types
  };

  saveOverridesToStorage();
}

// ------------------------------------------------------------
// Normalisering (sikrer ensartet format)
// ------------------------------------------------------------
/**
 * Ensretter feltet for ansvarlig, så filtrering og visning bliver stabil.
 * Bruges når vi indlæser sager, fordi kildedata kan have variationer i navne/format.
 */

function normalizeAssignee(ticket) {
  const confidence = Number(ticket?.confidence) || 0;
  const rawAssignee = String(ticket?.assignee || "").trim();

  const wantsPeter = rawAssignee === ASSIGNEE_PETER;
  const confidentEnough = confidence >= PETER_CONFIDENCE_THRESHOLD;

  // Kun Peter hvis der er høj konfidens
  if (wantsPeter && confidentEnough) return ASSIGNEE_PETER;

  // Alt andet -> Medarbejder
  return ASSIGNEE_STAFF;
}

/**
 * Sikrer at en sag har alle de felter UI’et forventer (med fornuftige standarder).
 * Bruges ved indlæsning, så rendering og filtre ikke fejler på manglende data.
 */

function normalizeTicket(ticket) {
  if (!ticket) return;

  // Sørg for note altid findes som string
  if (typeof ticket.note !== "string") ticket.note = "";

  // Type: tillad flere (sag.types). Bevar sag.type som "visningstekst"
  if (!Array.isArray(ticket.types)) {
    const rawType = (typeof ticket.type === "string") ? ticket.type : "";
    const parts = String(rawType)
      .split(/[,;+]/g)
      .map(s => s.trim())
      .filter(Boolean);

    const useParts = parts.length ? parts : (rawType ? [String(rawType).trim()] : []);
    ticket.types = useParts;
  } else {
    const cleaned = ticket.types.map(x => String(x).trim()).filter(Boolean);
    ticket.types = cleaned;
  }

  // Visningsfelt: "A + B"
  ticket.type = ticket.types.join(" + ");

  // Fordeling: aldrig ukendt — tvivl -> Medarbejder
  ticket.assignee = normalizeAssignee(ticket);
}

/**
 * Lægger manuelle rettelser oven på de indlæste sager.
 * Bruges efter indlæsning, så brugerens tidligere valg vises korrekt i liste og detaljevisning.
 */

function applyOverridesToTickets() {
  for (const [id, override] of Object.entries(overridesByTicketId)) {
    const ticket = getTicketById(id);
    if (!ticket || !override) continue;

    if (typeof override.assignee === "string") ticket.assignee = override.assignee;
    if (typeof override.status === "string") ticket.status = override.status;
    if (typeof override.note === "string") ticket.note = override.note;

    if (Array.isArray(override.types)) {
      const cleaned = override.types.map(x => String(x)).filter(Boolean);
      ticket.types = cleaned;
      ticket.type = ticket.types.join(" + ");
    }

    if (Array.isArray(override.replies)) {
      threadByTicketId[id] = override.replies;
    }

    // Efter overrides skal fordelingen stadig være medarbejder/peter
    ticket.assignee = normalizeAssignee(ticket);
  }
}

/**
 * Samler alle mulige sagstyper til filter/dropdown.
 * Bruges til at bygge UI for typevalg, så brugeren kan filtrere og justere klassificering.
 */

function getAllTypeOptions() {
  const options = DEFAULT_TYPE_OPTIONS.slice();
  const seen = new Set(options.map(x => String(x)));

  // Udvid med typer fra data (hvis der findes nye)
  for (const t of tickets) {
    const arr = Array.isArray(t.types)
      ? t.types
      : (typeof t.type === "string" ? [t.type] : []);

    for (const val of arr) {
      const opt = String(val || "").trim();
      if (!opt) continue;

      const already = seen.has(opt);
      if (!already) {
        seen.add(opt);
        options.push(opt);
      }
    }
  }

  return options;
}

// ------------------------------------------------------------
// Indlæs sager fra JSON
// Understøtter både: [ ...sager ] og { "sager": [ ... ] }
// ------------------------------------------------------------
/**
 * Indlæser sager fra JSON-filen og klargør dem til visning.
 * Bruges ved opstart (og evt. genindlæsning), så sagslisten, filtre og dashboard kan renderes.
 */

async function loadTickets(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const status = res.status;
      throw new Error(`Kunne ikke hente ${url} (${status})`);
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : data.tickets;

    if (!Array.isArray(list)) {
      throw new Error("JSON format skal være et array af tickets (eller {tickets:[...]})");
    }

    tickets = list;
    tickets.forEach(normalizeTicket);
  } catch (err) {
    console.error(err);

    const msg1 = "Kunne ikke loade tickets JSON.";
    const msg2 = "Tip: Kør via en lokal server (ikke file://).";
    const msg3 = String(err);

    alert(`${msg1}\n${msg2}\n\n${msg3}`);
    tickets = [];
  }
}

// ------------------------------------------------------------
// Filtrering + sortering (på tværs af ALLE sportsgrene)
// ------------------------------------------------------------
/**
 * Tjekker om en sag matcher fritekstsøgningen.
 * Bruges når brugeren søger, så vi kun viser relevante sager.
 */

function ticketMatchesSearch(ticket, searchText) {
  const q = String(searchText || "").trim().toLowerCase();
  if (!q) return true;

  const idText = String(ticket.id);
  const subjectText = String(ticket.subject || "").toLowerCase();
  const bodyText = String(ticket.body || "").toLowerCase();
  const senderText = String(ticket.sender || "").toLowerCase();
  const typeText = String(ticket.type || "").toLowerCase();
  const sportText = String(ticket.sport || "").toLowerCase();

  const matchId = idText.includes(q);
  const matchSubject = subjectText.includes(q);
  const matchBody = bodyText.includes(q);
  const matchSender = senderText.includes(q);
  const matchType = typeText.includes(q);
  const matchSport = sportText.includes(q);

  return matchId || matchSubject || matchBody || matchSender || matchType || matchSport;
}

/**
 * Tjekker om en sag ligger i den valgte måned.
 * Bruges i måned-filteret for at afgrænse sagslisten.
 */

function ticketMatchesMonth(ticket, monthFilter) {
  if (monthFilter === "all") return true;

  const ticketMonth = getYearMonth(ticket.date);
  const match = ticketMonth === monthFilter;

  return match;
}

/**
 * Tjekker om en sag matcher de valgte sagstyper.
 * Bruges i type-filteret, så man kan fokusere på bestemte henvendelsestyper.
 */

function ticketMatchesSelectedTypes(ticket, selectedTypesSet) {
  const typesArray = Array.isArray(ticket.types)
    ? ticket.types
    : (typeof ticket.type === "string" ? [ticket.type] : []);

  // Match hvis mindst én valgt type findes på ticketen
  for (const t of typesArray) {
    const typeName = String(t);
    if (selectedTypesSet.has(typeName)) return true;
  }

  return false;
}

/**
 * Tjekker om en sag matcher valgt ansvarlig.
 * Bruges i ansvarlig-filteret for at se Peters sager vs. teamets sager.
 */

function ticketMatchesAssignee(ticket, assigneeFilter) {
  if (assigneeFilter === "Alle") return true;
  return ticket.assignee === assigneeFilter;
}

/**
 * Tjekker om en sag matcher valgt status (åben/løst osv.).
 * Bruges i status-filteret for hurtigt at fokusere på uafsluttede sager.
 */

function ticketMatchesStatus(ticket, statusFilter) {
  if (statusFilter === "Alle") return true;
  return ticket.status === statusFilter;
}

/**
 * Sorterer sager efter det kriterie brugeren har valgt.
 * Bruges efter filtrering for at give et prioriteret og sammenligneligt overblik.
 */

function sortTickets(list, sortBy) {
  const items = list.slice();

  items.sort((a, b) => {
    const aId = Number(a.id);
    const bId = Number(b.id);

    const aDate = String(a.date);
    const bDate = String(b.date);

    if (sortBy === "date_asc") return aDate.localeCompare(bDate);
    if (sortBy === "date_desc") return bDate.localeCompare(aDate);
    if (sortBy === "id_asc") return aId - bId;
    if (sortBy === "id_desc") return bId - aId;

    return 0;
  });

  return items;
}

/**
 * Kører alle aktive filtre (søgning, måned, type, ansvarlig, status) og returnerer resultatet.
 * Bruges som “sandhedskilde” for hvad der skal vises i listen og summeres i dashboardet.
 */

function getFilteredTicketsAll() {
  // Start med alt
  let items = tickets.slice();

  // Søg
  const searchText = filterState.searchText;
  items = items.filter(t => ticketMatchesSearch(t, searchText));

  // Måned
  const monthFilter = filterState.monthFilter;
  items = items.filter(t => ticketMatchesMonth(t, monthFilter));

  // Type
  const selectedTypes = filterState.selectedTypes;
  items = items.filter(t => ticketMatchesSelectedTypes(t, selectedTypes));

  // Modtager
  const assigneeFilter = filterState.assigneeFilter;
  items = items.filter(t => ticketMatchesAssignee(t, assigneeFilter));

  // Status
  const statusFilter = filterState.statusFilter;
  items = items.filter(t => ticketMatchesStatus(t, statusFilter));

  // Sortering
  const sortBy = filterState.sortBy;
  items = sortTickets(items, sortBy);

  return items;
}

// ------------------------------------------------------------
// Render: sager som sektioner (Rugby → Hockey → Cricket)
// ------------------------------------------------------------
/**
 * Renderer/opfresher sagslisten ud fra aktuelle filtre og sortering.
 * Bruges når brugeren ændrer filtre, søger, eller når en sag bliver opdateret.
 */

function renderTickets() {
  ui.tickets.innerHTML = "";

  const items = getFilteredTicketsAll();
  ui.resultCount.textContent = `${items.length} resultater`;

  if (!items.length) {
    ui.tickets.innerHTML = `
      <div class="ticket">
        <div class="ticket__title">Ingen matches</div>
        <div class="ticket__body">Prøv at ændre filtre eller søgning.</div>
      </div>`;
    setupSectionObserver();
    return;
  }

  // Gruppér pr. sport (fast rækkefølge)
  const groupedBySport = {};
  for (const sport of SPORT_ORDER) groupedBySport[sport] = [];

  for (const t of items) {
    const sport = t.sport;
    if (!groupedBySport[sport]) groupedBySport[sport] = [];
    groupedBySport[sport].push(t);
  }

  // Vis den aktive sport først
  const active = SPORT_ORDER.includes(filterState.activeSport)
    ? filterState.activeSport
    : SPORT_ORDER[0];

  const renderOrder = [active, ...SPORT_ORDER.filter(s => s !== active)];

  for (const sport of renderOrder) {
    const sportItems = groupedBySport[sport] || [];
    const section = renderSportSection(sport, sportItems);
    ui.tickets.appendChild(section);
  }

  // Bind "mere"-knapper (åbner detaljevisning)
  const moreButtons = qsa(".more");
  moreButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const id = String(btn.dataset.id);
      openTicketOverlay(id);
    });
  });

  // (Gen)start observer efter DOM-ændringer
  setupSectionObserver();
}

/**
 * Renderer en sektion af sagslisten for en bestemt sport.
 * Bruges for at skabe et tydeligt overblik pr. sport og understøtte navigation mellem sektioner.
 */

function renderSportSection(sport, sportItems) {
  const section = document.createElement("section");
  section.className = "sportSection";
  section.dataset.sport = sport;
  section.id = `section-${sport}`;

  // Sticky sektionsheader
  const header = document.createElement("div");
  header.className = "sectionHeader";

  const badgeText = `${sportItems.length} tickets`;
  header.innerHTML = `
    <div>${sport}</div>
    <div class="sectionBadge">${badgeText}</div>
  `;
  section.appendChild(header);

  // Tom sektion (efter filtre)
  if (!sportItems.length) {
    const empty = document.createElement("div");
    empty.className = "ticket";

    const title = `Ingen tickets i ${sport}`;
    const body = "Filtre/søgning har filtreret alt væk i denne sektion.";

    empty.innerHTML = `
      <div class="ticket__title">${title}</div>
      <div class="ticket__body">${body}</div>
    `;

    section.appendChild(empty);
    return section;
  }

  // Sager
  for (const ticket of sportItems) {
    const card = renderTicketCard(ticket);
    section.appendChild(card);
  }

  return section;
}

/**
 * Bygger UI-kortet for én sag i listen.
 * Bruges når sagslisten renderes, så brugeren kan klikke ind på detaljerne.
 */

function renderTicketCard(ticket) {
  const body = String(ticket.body || "");
  const isLong = body.length > 140;

  const excerpt = isLong ? body.slice(0, 140) + "…" : body;

  const id = escapeHtml(ticket.id);
  const subject = escapeHtml(ticket.subject || "");
  const sport = escapeHtml(ticket.sport || "");
  const type = escapeHtml(ticket.type || "");
  const sender = escapeHtml(ticket.sender || "");
  const assignee = escapeHtml(ticket.assignee || "");
  const status = escapeHtml(ticket.status || "");
  const date = escapeHtml(ticket.date || "");

  const confidenceRaw = Number(ticket.confidence) || 0;
  const confidencePct = Math.round(confidenceRaw * 100);

  const note = escapeHtml(ticket.note || "");

  const moreBtn = isLong
    ? ` <button class="more" data-id="${id}">[Mere]</button>`
    : "";

  const el = document.createElement("article");
  el.className = "ticket ticketCard";
  el.dataset.id = String(ticket.id);
  el.tabIndex = 0;
  el.setAttribute("role", "button");

  el.innerHTML = `
    <div class="ticket__title">#${id} - ${subject}</div>
    <div class="ticket__body">
      ${escapeHtml(excerpt)}${moreBtn}
    </div>
    <div class="ticket__meta">
      <div class="metaItem"><b>Sport:</b> ${sport}</div>
      <div class="metaItem"><b>Type:</b> ${type}</div>
      <div class="metaItem"><b>Afsender:</b> ${sender}</div>
      <div class="metaItem"><b>Modtager:</b> ${assignee}</div>
      <div class="metaItem"><b>Status:</b> ${status}</div>
      <div class="metaItem"><b>Dato:</b> ${date}</div>
      <div class="metaItem"><b>Konfidens:</b> ${confidencePct}/100</div>
      <div class="metaItem metaNote"><b>Note:</b><div class="noteText">${note}</div></div>
    </div>
  `;

  return el;
}

// ------------------------------------------------------------
// Sport-tabs: flyt valgt sport øverst i listen
// ------------------------------------------------------------
/**
 * Opdaterer hvilket sport-filter/segment der er aktivt i UI.
 * Bruges når brugeren klikker på en sport eller når scroll gør en ny sektion “aktiv”.
 */

function setActiveSport(sport) {
  const isKnown = SPORT_ORDER.includes(sport);
  if (!isKnown) return;

  filterState.activeSport = sport;
  setActiveTab(sport);

  // Gen-render med den valgte sport først
  renderTickets();

  // Scroll til toppen efter omrokering
  ui.ticketsScroll?.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Sætter den valgte fane/tilstand som aktiv i UI (visuelt og i state).
 * Bruges når brugeren skifter mellem visninger/filtre, så UI afspejler valget.
 */

function setActiveTab(sport) {
  ui.tabs.forEach(btn => {
    const isActive = btn.dataset.sport === sport;
    btn.classList.toggle("is-active", isActive);
  });
}

// ------------------------------------------------------------
// IntersectionObserver: marker aktiv fane ud fra den sektion, der er synlig
// Rod-elementet er ticketsScroll (ikke hele browservinduet)
// ------------------------------------------------------------
let sectionObserver = null;

/**
 * Observerer scroll-positionen for sport-sektioner og skifter aktiv sport automatisk.
 * Bruges for at gøre navigationen mere intuitiv, når brugeren scroller i sagslisten.
 */

function setupSectionObserver() {
  const root = ui.ticketsScroll;
  if (!root) return;

  if (sectionObserver) {
    sectionObserver.disconnect();
    sectionObserver = null;
  }

  const sections = qsa(".sportSection");
  if (!sections.length) return;

  // Justér her, hvis sticky header/toolbar ændrer højde
  const TOP_OFFSET = 90;

  sectionObserver = new IntersectionObserver((entries) => {
    const rootTop = root.getBoundingClientRect().top;
    const targetTop = rootTop + TOP_OFFSET;

    const candidates = entries
      .filter(e => e.isIntersecting)
      .map(e => {
        const secTop = e.boundingClientRect.top;
        const dist = Math.abs(secTop - targetTop);
        const sport = e.target.dataset.sport;

        return { sport, dist };
      })
      .sort((a, b) => a.dist - b.dist);

    if (candidates.length) {
      const sport = candidates[0].sport;
      setActiveTab(sport);
    }
  }, {
    root,
    threshold: 0,
    rootMargin: `-${TOP_OFFSET}px 0px -70% 0px`
  });

  sections.forEach(sec => sectionObserver.observe(sec));
}

// ------------------------------------------------------------
// Dashboard (globalt – ændrer sig ikke)
// ------------------------------------------------------------
/**
 * Regner procent på en robust måde (inkl. håndtering af 0).
 * Bruges i dashboardet til at vise andele uden fejl/NaN.
 */

function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/**
 * Beregner nøgletal til dashboardet (fx antal åbne, løste og total).
 * Bruges når data eller filtre ændres, så overblikket altid matcher det brugeren ser.
 */

function computeGlobalDashboard() {
  const total = tickets.length;

  const solvedCount = tickets.filter(t => t.status === "Lukket").length;
  const openCount = total - solvedCount;

  const byType = {};
  const byAssignee = {};

  for (const t of tickets) {
    const type = t.type;
    const assignee = t.assignee;

    byType[type] = (byType[type] || 0) + 1;
    byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;
  }

  return { total, solvedCount, openCount, byType, byAssignee };
}

/**
 * Forbereder dataserier til søjlediagrammet i dashboardet.
 * Bruges før vi tegner grafen, så UI-tegningen kun skal fokusere på visning.
 */

function buildGlobalBarSeries() {
  // Simpel dummy-fordeling pr. måned
  const months = ["2026-01", "2026-02", "2026-03"];

  return months.map(m => {
    const count = tickets.filter(t => getYearMonth(t.date) === m).length;
    return { label: m, value: count };
  });
}

/**
 * Tegner/opfresher dashboardets tal og grafer.
 * Bruges når sagslisten ændrer sig (filtre, søgning eller opdateringer på en sag).
 */

function renderDashboard() {
  const d = computeGlobalDashboard();

  const solvedPct = percent(d.solvedCount, d.total);
  const openPct = percent(d.openCount, d.total);

  ui.statSolved.textContent = `${solvedPct}%`;
  ui.statOpen.textContent = `${openPct}%`;
  ui.statTotal.textContent = String(d.total);

  drawPie("#pieType", d.byType);
  drawPie("#pieAssignee", d.byAssignee);

  const series = buildGlobalBarSeries();
  drawBars("#barChart", series);
}

// ------------------------------------------------------------
// Detaljevisning (sag-detaljer, svar og ændringer)
// ------------------------------------------------------------
/**
 * Genererer de ansvarlig-valg der skal vises i filteret.
 * Bruges når UI’et bygges, så filteret matcher de muligheder prototypen understøtter.
 */

function getAssigneeOptions() {
  // Krav: "Modtager" skal altid være enten Medarbejder eller Peter
  return [ASSIGNEE_STAFF, ASSIGNEE_PETER];
}

/**
 * Viser en kort besked til brugeren som feedback (fx “Gemt”).
 * Bruges efter handlinger hvor brugeren forventer en kvittering uden at forlade siden.
 */

function showToast(msg) {
  ui.ovToast.textContent = msg || "";
  if (!msg) return;

  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => {
    ui.ovToast.textContent = "";
  }, 2200);
}

/**
 * Renderer samtaletråden i detaljevisningen for den valgte sag.
 * Bruges når man åbner en sag eller tilføjer en note, så historikken altid er opdateret.
 */

function renderThread(ticket) {
  ui.ovThread.innerHTML = "";

  const thread = getThreadForTicket(ticket.id);

  // Første kundebesked (ind)
  const messages = [{
    from: ticket.sender || "Kunde",
    date: ticket.date || "–",
    body: ticket.body || "",
    direction: "in"
  }];

  // Efterfølgende svar (ud)
  for (const r of thread) messages.push(r);

  for (const m of messages) {
    const box = document.createElement("div");
    const isOut = m.direction === "out";
    box.className = `msg ${isOut ? "msg--out" : ""}`;

    const top = document.createElement("div");
    top.className = "msg__top";
    top.textContent = `${m.from} • ${m.date}`;

    const body = document.createElement("div");
    body.className = "msg__body";
    body.textContent = String(m.body || "");

    box.appendChild(top);
    box.appendChild(body);

    ui.ovThread.appendChild(box);
  }
}

/**
 * Opdaterer de små badges i detaljevisningen (fx status, sport, type).
 * Bruges når en sag åbnes eller ændres, så brugeren med det samme kan se nøgleinfo.
 */

function renderOverlayBadges(ticket) {
  const status = ticket.status || "–";
  ui.ovTicketStatus.textContent = status;

  const isOpen = status === "Åben";
  const isClosed = status === "Lukket";

  ui.ovTicketStatus.classList.toggle("badge--open", isOpen);
  ui.ovTicketStatus.classList.toggle("badge--closed", isClosed);
}

/**
 * Opdaterer metadata-sektionen i detaljevisningen (fx dato, kundeinfo, id).
 * Bruges for at give kontekst til sagen uden at brugeren skal tilbage til listen.
 */

function renderOverlayMeta(ticket) {
  const sender = escapeHtml(ticket.sender);
  const date = escapeHtml(ticket.date);
  const assignee = escapeHtml(ticket.assignee);
  const status = escapeHtml(ticket.status);

  const confidenceRaw = Number(ticket.confidence) || 0;
  const confidencePct = Math.round(confidenceRaw * 100);

  const note = escapeHtml(ticket.note || "");

  ui.ovTicketMeta.innerHTML = `
    <div><b>Afsender:</b> ${sender}</div>
    <div><b>Dato:</b> ${date}</div>
    <div><b>Modtager:</b> ${assignee}</div>
    <div><b>Status:</b> ${status}</div>
    <div><b>Konfidens:</b> ${confidencePct}/100</div>
    <div class="metaNote"><b>Note:</b><div class="noteText">${note}</div></div>
  `;
}

/**
 * Bygger/redigerer UI for at ændre sagstype i detaljevisningen.
 * Bruges når brugeren skal kunne rette klassificeringen af en sag.
 */

function renderOverlayTypeEditor(ticket) {
  ui.ovTypeList.innerHTML = "";

  const options = getAllTypeOptions();
  const selected = new Set((Array.isArray(ticket?.types) ? ticket.types : []).map(x => String(x)));

  for (const opt of options) {
    const safeOpt = String(opt);
    const id = `type-${String(ticket.id)}-${safeOpt}`.replace(/\s+/g, "-");

    const lbl = document.createElement("label");
    lbl.className = "ovChk";
    lbl.setAttribute("for", id);

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.id = id;
    chk.value = safeOpt;
    chk.checked = selected.has(safeOpt);

    const span = document.createElement("span");
    span.textContent = safeOpt;

    lbl.appendChild(chk);
    lbl.appendChild(span);

    ui.ovTypeList.appendChild(lbl);
  }
}

/**
 * Åbner detaljevisningen for en sag og fylder den med indhold.
 * Bruges når brugeren klikker på et sagskort i listen.
 */

function openTicketOverlay(ticketId) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return;

  openTicketId = String(ticket.id);

  // Titel + badges
  const titleId = ticket.id;
  const titleSubject = ticket.subject || "";
  ui.ovTicketTitle.textContent = `#${titleId} — ${titleSubject}`;

  renderOverlayBadges(ticket);

  ui.ovTicketType.textContent = ticket.type || "–";
  ui.ovTicketSport.textContent = ticket.sport || "–";

  // Besked + meta
  ui.ovTicketBody.textContent = String(ticket.body || "");
  renderOverlayMeta(ticket);

  // Type editor (flere mulige)
  renderOverlayTypeEditor(ticket);

  // Assignee dropdown
  ui.ovAssignee.innerHTML = "";
  const assigneeOptions = getAssigneeOptions();

  for (const a of assigneeOptions) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    ui.ovAssignee.appendChild(opt);
  }

  ui.ovAssignee.value = String(ticket.assignee || ASSIGNEE_STAFF);

  // Status dropdown
  ui.ovStatus.value = String(ticket.status || "Åben");

  // Reply
  ui.ovReply.value = "";
  showToast("");

  // Samtaletråd
  renderThread(ticket);

  // Vis detaljevisning
  ui.overlay.classList.add("is-open");
  ui.overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("noScroll");

  window.setTimeout(() => ui.ovClose?.focus(), 0);
}

/**
 * Lukker detaljevisningen og rydder evt. midlertidig state.
 * Bruges når brugeren trykker luk eller klikker udenfor detaljevisninget.
 */

function closeTicketOverlay() {
  ui.overlay.classList.remove("is-open");
  ui.overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("noScroll");
  openTicketId = null;
}

/**
 * Finder hvilken sag der aktuelt er åbnet i detaljevisningen.
 * Bruges når vi skal opdatere detaljevisninget efter en ændring, uden at miste kontekst.
 */

function getOpenTicket() {
  if (!openTicketId) return null;
  return getTicketById(openTicketId);
}

/**
 * Opdaterer alle UI-dele efter en ændring på en sag (liste, dashboard og detaljevisning).
 * Bruges efter gem/overstyring, så alt på siden hænger sammen.
 */

function refreshAfterTicketChange(ticket, { updateOverlay = true } = {}) {
  syncTicketToStorage(ticket);

  renderDashboard();
  renderTickets();

  if (updateOverlay && openTicketId) {
    renderOverlayBadges(ticket);
    renderOverlayMeta(ticket);
  }
}

// ------------------------------------------------------------
// SVG-diagrammer: cirkeldiagrammer og søjlediagram
// ------------------------------------------------------------
/**
 * Opretter et SVG-element.
 * Bruges som byggesten til graferne i dashboardet (så vi kan tegne uden eksterne biblioteker).
 */

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
/**
 * Opretter et SVG-rect (firkant).
 * Bruges til søjler og baggrunde i dashboard-grafik.
 */

function svgRect(x, y, w, h, rx, fill, stroke) {
  return svgEl("rect", { x, y, width: w, height: h, rx, fill, stroke });
}
/**
 * Opretter en SVG-linje.
 * Bruges til akser/markeringer i dashboard-grafik.
 */

function svgLine(x1, y1, x2, y2, stroke) {
  return svgEl("line", { x1, y1, x2, y2, stroke, "stroke-width": 1 });
}
/**
 * Opretter SVG-tekst.
 * Bruges til labels og tal i dashboard-grafik.
 */

function svgText(x, y, text, size, color, anchor = "start") {
  const t = svgEl("text", { x, y, "font-size": size, fill: color, "text-anchor": anchor });
  t.textContent = text;
  return t;
}
/**
 * Opretter en SVG-path.
 * Bruges til cirkeldiagram-segmenter og andre former i dashboard-grafik.
 */

function svgPath(d, fill, stroke) {
  return svgEl("path", { d, fill, stroke, "stroke-width": 1 });
}
/**
 * Opretter en SVG-cirkel.
 * Bruges til små markører eller dekorative elementer i dashboard-grafik.
 */

function svgCircle(cx, cy, r, fill, stroke) {
  return svgEl("circle", { cx, cy, r, fill, stroke, "stroke-width": 1 });
}

// ------------------------------------------------------------
// Tema-farver til SVG-diagrammer
// (læses fra CSS-variabler så det matcher logo/tema)
// ------------------------------------------------------------
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function chartPalette() {
  const brand = cssVar("--brand", "#0b2d4d");
  const accent = cssVar("--accent", "#e11d48");
  const line = cssVar("--line", "#d9e2ef");
  const muted = cssVar("--muted", "#5b6b7f");
  const ink = cssVar("--ink", "#0b2d4d");

  // En sporty palette med navy/rød som primær, og et par stærke støttefarver.
  const fills = [
    accent,
    brand,
    "#1d4ed8", // blå
    "#0ea5e9", // cyan
    "#f59e0b", // amber
    "#22c55e"  // grøn
  ];

  return {
    brand,
    accent,
    line,
    muted,
    ink,
    fills,
    grid: "rgba(11,45,77,0.12)",
    stroke: "rgba(11,45,77,0.28)",
    donutFill: "rgba(255,255,255,0.88)",
    donutStroke: "rgba(11,45,77,0.25)"
  };
}

/**
 * Tegner et søjlediagram i dashboardet ud fra en dataserie.
 * Bruges til at visualisere fordeling/antal på tværs af kategorier.
 */

function drawBars(sel, series) {
  const svg = document.querySelector(sel);

  const theme = chartPalette();

  const W = 520;
  const H = 240;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";

  const pad = { l: 46, r: 18, t: 18, b: 34 };

  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const values = series.map(s => s.value);
  const maxV = Math.max(1, ...values);

  const band = plotW / series.length;
  const barW = band * 0.55;
  const gap = band * 0.45;

  // Baggrund
  svg.appendChild(svgRect(1, 1, W - 2, H - 2, 8, "#fff", theme.line));

  // Gitter + akse-etiketter
  for (let i = 0; i <= 3; i++) {
    const v = Math.round((maxV * (3 - i)) / 3);
    const y = pad.t + (plotH * i) / 3;

    svg.appendChild(svgLine(pad.l, y, W - pad.r, y, theme.grid));
    svg.appendChild(svgText(12, y + 4, String(v), 12, theme.muted));
  }

  // Søjler
  series.forEach((s, i) => {
    const x = pad.l + i * (barW + gap) + gap / 2;

    const ratio = s.value / maxV;
    const h = ratio * plotH;

    const y = pad.t + (plotH - h);

    const fill = theme.fills[i % theme.fills.length];

    svg.appendChild(svgRect(x, y, barW, h, 2, fill, "none"));
    svg.appendChild(svgText(x + barW / 2, H - 12, s.label, 11, theme.muted, "middle"));
  });
}

/**
 * Bygger et enkelt “slice” (segment) til et cirkeldiagram.
 * Bruges af cirkeldiagram-tegningen til at skabe hver del af kagen.
 */

function pieSlice(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);

  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);

  const largeArc = (a1 - a0) > Math.PI ? 1 : 0;

  const p1 = `M ${cx} ${cy}`;
  const p2 = `L ${x0} ${y0}`;
  const p3 = `A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`;
  const p4 = "Z";

  return `${p1} ${p2} ${p3} ${p4}`;
}

/**
 * Tegner et cirkeldiagram i dashboardet.
 * Bruges til at vise fordeling (fx åbne vs. løste) på en hurtig og visuel måde.
 */

function drawPie(sel, counts) {
  const svg = document.querySelector(sel);

  const theme = chartPalette();

  // Diagrammerne ligger på en mørk dashboard-baggrund, så legend-teksten
  // skal være lys og have en lille outline for læsbarhed.
  const onDark = Boolean(svg && svg.closest && svg.closest(".panel--dash"));
  const legendTextColor = onDark
    ? cssVar("--linkOnDark", "rgba(255,255,255,.92)")
    : theme.ink;

  const W = 280;
  const H = 160;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";

  const cx = 76;
  const cy = 80;
  const r = 56;

  const totalRaw = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = totalRaw || 1;

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const fills = theme.fills;

  let a0 = -Math.PI / 2;

  entries.forEach(([label, value], idx) => {
    const frac = value / total;
    const a1 = a0 + frac * 2 * Math.PI;

    const d = pieSlice(cx, cy, r, a0, a1);
    const fill = fills[idx % fills.length];

    svg.appendChild(svgPath(d, fill, theme.stroke));
    a0 = a1;
  });

  // Signatur (legend)
  const lx = 160;
  const ly = 26;

  entries.slice(0, 6).forEach(([label, value], i) => {
    const y = ly + i * 22;
    const fill = fills[i % fills.length];

    svg.appendChild(svgRect(lx, y - 10, 12, 12, 2, fill, theme.stroke));

    const t = svgText(lx + 18, y, `${label} (${value})`, 12, legendTextColor);
    t.setAttribute("font-weight", "600");
    if (onDark) {
      // Lille outline bag teksten giver markant bedre kontrast på mørk baggrund
      t.setAttribute("paint-order", "stroke");
      t.setAttribute("stroke", "rgba(0,0,0,.35)");
      t.setAttribute("stroke-width", "3");
      t.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(t);
  });

  // Donut-midte
  svg.appendChild(svgCircle(cx, cy, 22, theme.donutFill, theme.donutStroke));
}

// ------------------------------------------------------------
// UI-opkobling (events)
// ------------------------------------------------------------
/**
 * Nulstiller alle filtre tilbage til standard.
 * Bruges når brugeren trykker “Nulstil”, så man hurtigt kan starte forfra i overblikket.
 */

function resetFilters() {
  filterState.searchText = "";
  ui.searchInput.value = "";

  filterState.monthFilter = "all";
  ui.month.value = "all";

  filterState.selectedTypes = new Set(DEFAULT_TYPE_OPTIONS);
  qsa(".typeChk").forEach(chk => chk.checked = true);

  filterState.assigneeFilter = "Alle";
  qsa('input[name="assignee"]').forEach(r => r.checked = (r.value === "Alle"));

  filterState.statusFilter = "Alle";
  qsa('input[name="status"]').forEach(r => r.checked = (r.value === "Alle"));

  filterState.sortBy = "date_desc";
  ui.sortBy.value = "date_desc";

  renderTickets();
}

/**
 * Binder event handlers til UI-kontroller (søgning, filtre, knapper, detaljevisning).
 * Bruges ved opstart, så brugerens handlinger faktisk opdaterer liste, dashboard og detaljevisning.
 */

function bindUI() {
  cacheUi();

  // Sport tabs = navigation
  ui.tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      const sport = btn.dataset.sport;
      setActiveSport(sport);
    });
  });

  // Søgning
  ui.searchInput.addEventListener("input", (e) => {
    const text = e.target.value;
    filterState.searchText = text;
    renderTickets();
  });

  ui.btnSearch.addEventListener("click", () => renderTickets());

  // Måned
  ui.month.addEventListener("change", (e) => {
    const val = e.target.value;
    filterState.monthFilter = val;
    renderTickets();
  });

  // Type checkboxes
  qsa(".typeChk").forEach(chk => {
    chk.addEventListener("change", () => {
      const typeName = chk.value;

      if (chk.checked) filterState.selectedTypes.add(typeName);
      else filterState.selectedTypes.delete(typeName);

      renderTickets();
    });
  });

  // Assignee radios
  qsa('input[name="assignee"]').forEach(r => {
    r.addEventListener("change", () => {
      filterState.assigneeFilter = r.value;
      renderTickets();
    });
  });

  // Status radios
  qsa('input[name="status"]').forEach(r => {
    r.addEventListener("change", () => {
      filterState.statusFilter = r.value;
      renderTickets();
    });
  });

  // Sorting
  ui.sortBy.addEventListener("change", (e) => {
    filterState.sortBy = e.target.value;
    renderTickets();
  });

  // Nulstil
  ui.btnReset.addEventListener("click", resetFilters);

  // Klik på sag (åbn detaljevisning)
  ui.tickets.addEventListener("click", (e) => {
    const card = e.target.closest?.(".ticketCard");
    if (!card) return;

    const id = String(card.dataset.id);
    openTicketOverlay(id);
  });

  ui.tickets.addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".ticketCard");
    if (!card) return;

    const pressedEnter = e.key === "Enter";
    const pressedSpace = e.key === " ";

    if (pressedEnter || pressedSpace) {
      e.preventDefault();

      const id = String(card.dataset.id);
      openTicketOverlay(id);
    }
  });

  // Luk detaljevisning
  ui.ovClose.addEventListener("click", closeTicketOverlay);

  ui.overlay.addEventListener("click", (e) => {
    const wantsClose = e.target?.dataset?.close;
    if (wantsClose) closeTicketOverlay();
  });

  document.addEventListener("keydown", (e) => {
    const isOpen = ui.overlay.classList.contains("is-open");
    if (e.key === "Escape" && isOpen) closeTicketOverlay();
  });

  // Send svar
  ui.ovSend.addEventListener("click", () => {
    const ticket = getOpenTicket();
    if (!ticket) return;

    const text = ui.ovReply.value.trim();
    if (!text) {
      showToast("Skriv et svar først.");
      return;
    }

    const thread = getThreadForTicket(ticket.id);

    thread.push({
      from: "UK Sports (Admin)",
      date: formatNow(),
      body: text,
      direction: "out"
    });

    ui.ovReply.value = "";
    appendNote(ticket, "Svar sendt");

    refreshAfterTicketChange(ticket);
    renderThread(ticket);

    showToast("Svar sendt (prototype).");
  });

  // Gem modtager
  ui.ovSaveAssignee.addEventListener("click", () => {
    const ticket = getOpenTicket();
    if (!ticket) return;

    const newAssignee = ui.ovAssignee.value;
    const oldAssignee = String(ticket.assignee);

    if (oldAssignee === String(newAssignee)) {
      showToast("Ingen ændring.");
      return;
    }

    ticket.assignee = newAssignee;
    appendNote(ticket, `Modtager ændret til ${newAssignee}`);

    refreshAfterTicketChange(ticket);
    showToast("Modtager opdateret.");
  });

  // Gem status
  ui.ovSaveStatus.addEventListener("click", () => {
    const ticket = getOpenTicket();
    if (!ticket) return;

    const newStatus = ui.ovStatus.value;
    const oldStatus = String(ticket.status);

    if (oldStatus === String(newStatus)) {
      showToast("Ingen ændring.");
      return;
    }

    ticket.status = newStatus;
    appendNote(ticket, `Status ændret til ${newStatus}`);

    refreshAfterTicketChange(ticket);
    renderOverlayBadges(ticket);

    showToast("Status opdateret.");
  });

  // Gem type(r) (kan være flere)
  ui.ovSaveType.addEventListener("click", () => {
    const ticket = getOpenTicket();
    if (!ticket) return;

    const checks = qsa("#ovTypeList input[type=checkbox]");
    const selected = checks
      .filter(c => c.checked)
      .map(c => String(c.value));

    const finalSelection = selected.length ? selected : ["Andet"];
    const unique = Array.from(new Set(finalSelection));

    const changed = !arraysAreEqual(unique, ticket.types);
    if (!changed) {
      showToast("Ingen ændring.");
      return;
    }

    ticket.types = unique;
    ticket.type = ticket.types.join(" + ");

    ui.ovTicketType.textContent = ticket.type || "–";
    appendNote(ticket, `Type ændret til ${ticket.type}`);

    refreshAfterTicketChange(ticket);
    showToast("Type opdateret.");
  });

  // Hurtig eskalering
  ui.ovEscalate.addEventListener("click", () => {
    ui.ovAssignee.value = ASSIGNEE_PETER;
    ui.ovSaveAssignee.click();
  });
}

// ------------------------------------------------------------
// Initialisering
// ------------------------------------------------------------
/**
 * Starter prototypen: finder UI-elementer, binder events, indlæser data og laver første render.
 * Bruges én gang når siden loader.
 */

(async function init() {
  bindUI();

  await loadTickets(TICKETS_DATA_URL);

  // Baseline-snapshot (bruges til at se, om der er ændringer)
  for (const t of tickets) {
    const id = String(t.id);

    const baselineTypes = Array.isArray(t.types) ? t.types.slice() : [];

    baselineByTicketId[id] = {
      assignee: t.assignee,
      status: t.status,
      types: baselineTypes
    };
  }

  // Indlæs overstyringer fra localStorage
  overridesByTicketId = loadOverridesFromStorage();
  applyOverridesToTickets();

  // Første render
  renderDashboard(); // Globalt dashboard
  renderTickets();   // Sager med sektioner + observer
})();
