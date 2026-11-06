// Last One Pays — Telegram Mini App.
//
// Identity is Telegram's signed initData, sent with every API call. All game
// rules (arrivals, verdicts, tabs) are decided by the server; this file only
// presents them and collects input.
import { LiveMap, statusFor, VEHICLE_ART, colorFor } from "./map.js";

const CFG = window.LOP_CONFIG || {};
const tg = window.Telegram?.WebApp;
const BOT = () => S.bot || CFG.botUsername || "";

const S = {
  me: null,
  bot: null,
  meetups: [],
  cleanup: [],      // per-screen teardown (timers, map)
  backHandler: null,
};

// ------------------------------------------------------------------ utilities
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function zoneOk(zone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function fmtWhen(iso, zone) {
  const z = zoneOk(zone) ? zone : "UTC";
  return new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short", month: "short",
    day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
function fmtClock(iso, zone) {
  const z = zoneOk(zone) ? zone : "UTC";
  return new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "numeric", minute: "2-digit" })
    .format(new Date(iso));
}
/** The creator's time is authoritative (as on iOS); show local time too if it differs. */
function fmtMeetTime(m) {
  const main = fmtWhen(m.meet_at, m.time_zone);
  const mine = localZone();
  if (!zoneOk(m.time_zone) || mine === m.time_zone) return main;
  const a = fmtClock(m.meet_at, m.time_zone), b = fmtClock(m.meet_at, mine);
  return a === b ? main : `${main} · ${b} your time`;
}
function fmtStakes(label, amount, currency) {
  const parts = [];
  if (label) parts.push(label);
  if (amount !== null && amount !== undefined && amount !== "") {
    try {
      parts.push(new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount)));
    } catch { parts.push(`${Number(amount).toFixed(2)} ${currency}`); }
  }
  return parts.join(" · ") || "The tab";
}
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
function fmtDistance(meters, units) {
  if (!Number.isFinite(meters)) return "";
  if (units === "mi") {
    const mi = meters / 1609.34;
    return mi < 0.1 ? `${Math.round(meters * 3.281)} ft` : `${mi.toFixed(1)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function haptic(kind) {
  try {
    if (kind === "success" || kind === "error" || kind === "warning") tg?.HapticFeedback?.notificationOccurred(kind);
    else tg?.HapticFeedback?.impactOccurred(kind || "light");
  } catch { /* optional */ }
}

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/** Bottom sheet with buttons; resolves with the chosen button's value. */
function sheet({ title, body, buttons }) {
  const el = document.getElementById("modal");
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <h2>${esc(title)}</h2><p>${body}</p>
    ${buttons.map((b, i) => `<button class="btn ${b.style || "btn-dark"}" data-i="${i}">${esc(b.text)}</button>`).join("")}
  </div>`;
  el.hidden = false;
  return new Promise((resolve) => {
    el.onclick = (e) => {
      const btn = e.target.closest("button[data-i]");
      if (!btn && e.target !== el) return;
      el.hidden = true;
      el.onclick = null;
      resolve(btn ? buttons[Number(btn.dataset.i)].value : null);
    };
  });
}

function openLink(url) {
  if (tg?.openTelegramLink && /^https:\/\/t\.me\//.test(url)) tg.openTelegramLink(url);
  else window.open(url, "_blank", "noopener");
}
const inviteLink = (code) => `https://t.me/${BOT()}?start=join_${code}`;
const groupLink = (code) => `https://t.me/${BOT()}?startgroup=link_${code}`;
const botChat = () => `https://t.me/${BOT()}`;

// ------------------------------------------------------------------ API
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${CFG.apiBase}/api${path}`, {
      method,
      headers: { authorization: `tma ${tg.initData}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach Last One Pays. Check your connection and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* fallthrough */ }
  if (!res.ok || !data?.ok) {
    throw new ApiError(res.status, data?.error || "Something went wrong. Please try again.");
  }
  return data;
}

// ------------------------------------------------------------------ routing
function go(hash, replace = false) {
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  route();
}

function teardown() {
  for (const fn of S.cleanup.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  document.getElementById("modal").hidden = true;
}

function setBack(handler) {
  if (S.backHandler) tg?.BackButton?.offClick(S.backHandler);
  S.backHandler = handler;
  if (handler) {
    tg?.BackButton?.onClick(handler);
    tg?.BackButton?.show();
  } else {
    tg?.BackButton?.hide();
  }
}

function mount(html) {
  const app = document.getElementById("app");
  app.innerHTML = html;
  window.scrollTo(0, 0);
  return app;
}

async function route() {
  teardown();
  const hash = location.hash || "#/";
  const [, name = "", arg = ""] = hash.match(/^#\/?([a-z]*)\/?([A-Za-z0-9-]*)/) || [];
  try {
    if (!S.me?.profile_set && name !== "profile") return renderProfile(true);
    switch (name) {
      case "": return await renderHome();
      case "create": return renderCreate();
      case "profile": return renderProfile(false);
      case "m": return await renderMeetup(arg);
      case "live": return await renderLive(arg);
      case "result": return await renderResult(arg);
      default: return go("#/", true);
    }
  } catch (error) {
    renderError(error);
  }
}

function renderError(error) {
  setBack(() => go("#/"));
  mount(`<div class="screen"><div class="card" style="margin-top:40px;text-align:center">
    <h2>Something's not right</h2><p class="sub">${esc(error?.message || error)}</p>
    <button class="btn btn-dark" style="margin-top:18px" id="retry">Try Again</button></div></div>`);
  document.getElementById("retry").onclick = () => route();
}

// ------------------------------------------------------------------ profile
function vehiclePicker(selected) {
  const names = { car: "Car", motorbike: "Motorbike", bicycle: "Bicycle", mrt: "Train" };
  return `<div class="vehicles" role="group" aria-label="Vehicle">${Object.keys(names).map((v) =>
    `<button type="button" class="vehicle" data-vehicle="${v}" aria-pressed="${v === selected}">
       <img src="${VEHICLE_ART[v]}" alt=""><span>${names[v]}</span></button>`).join("")}</div>`;
}

function chipGroup(name, options, selected) {
  return `<div class="chips" role="group" data-group="${name}">${options.map(([value, label]) =>
    `<button type="button" class="chip" data-value="${esc(value)}" aria-pressed="${String(value) === String(selected)}">${esc(label)}</button>`).join("")}</div>`;
}

function wireChips(root, onChange) {
  root.querySelectorAll(".chips[data-group]").forEach((group) => {
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      group.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      haptic("light");
      onChange?.(group.dataset.group, chip.dataset.value);
    });
  });
}
const chipValue = (root, name) =>
  root.querySelector(`.chips[data-group="${name}"] .chip[aria-pressed="true"]`)?.dataset.value;

function renderProfile(firstRun) {
  setBack(firstRun ? null : () => go("#/"));
  const me = S.me;
  const app = mount(`<div class="screen">
    <div class="topbar"><span class="wordmark">LAST ONE PAYS</span></div>
    <h1 style="margin-top:14px">${firstRun ? "Pick Your Vehicle" : "Your Profile"}</h1>
    <p class="sub">${firstRun ? "This is how your friends will see you on the live map." : "Change how you appear on the map."}</p>
    <div style="margin-top:18px">${vehiclePicker(me.vehicle)}</div>
    <label class="field"><span>Your Name</span>
      <input class="input" id="name" maxlength="32" autocomplete="nickname" value="${esc(me.display_name)}"></label>
    <label class="field"><span>How You Usually Travel</span></label>
    ${chipGroup("mode", [["driving", "Driving"], ["transit", "Transit"], ["cycling", "Cycling"], ["walking", "Walking"]], me.travel_mode)}
    <label class="field"><span>Distances</span></label>
    ${chipGroup("units", [["km", "Kilometres"], ["mi", "Miles"]], me.units)}
    <p class="error" id="err"></p>
    <button class="btn btn-primary" id="save">${firstRun ? "Let's Go" : "Save"}</button>
    ${firstRun ? "" : `<p class="small" style="margin-top:22px;text-align:center">
      Bot notifications: <b>${me.can_dm && !me.blocked_bot ? "On" : "Off"}</b></p>`}
    <p class="small" style="margin-top:12px;text-align:center">
      <a href="privacy.html" style="color:var(--dim)" id="privacy">Privacy Policy</a>
      ${firstRun ? "" : ` · Delete your data by sending /deletemydata to the bot`}</p>
  </div>`);
  let vehicle = me.vehicle;
  app.querySelector(".vehicles").addEventListener("click", (e) => {
    const btn = e.target.closest(".vehicle");
    if (!btn) return;
    vehicle = btn.dataset.vehicle;
    app.querySelectorAll(".vehicle").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    haptic("light");
  });
  wireChips(app);
  app.querySelector("#privacy").onclick = (e) => {
    e.preventDefault();
    const url = new URL("privacy.html", location.href).toString();
    if (tg?.openLink) tg.openLink(url); else window.open(url, "_blank", "noopener");
  };
  app.querySelector("#save").onclick = async (e) => {
    const err = app.querySelector("#err");
    err.textContent = "";
    e.target.disabled = true;
    try {
      const { me: updated } = await api("PUT", "/me", {
        display_name: app.querySelector("#name").value,
        vehicle, travel_mode: chipValue(app, "mode"), units: chipValue(app, "units"),
      });
      S.me = updated;
      haptic("success");
      if (!updated.can_dm) await askWriteAccess();
      go(firstRun ? (pendingDeepLink() || "#/") : "#/", true);
    } catch (error) {
      err.textContent = error.message;
      haptic("error");
      e.target.disabled = false;
    }
  };
}

/** Notifications need the bot to be allowed to message you. */
function askWriteAccess() {
  return new Promise((resolve) => {
    if (!tg?.requestWriteAccess || !tg.isVersionAtLeast?.("6.9")) return resolve(false);
    try {
      tg.requestWriteAccess((granted) => {
        if (granted) api("GET", "/me").then((d) => { S.me = d.me; }).catch(() => {});
        resolve(granted);
      });
    } catch { resolve(false); }
  });
}

// ------------------------------------------------------------------ home
function statusPill(m) {
  const now = Date.now();
  if (m.status === "cancelled") return `<span class="pill">Cancelled</span>`;
  if (m.status === "verdict" || m.status === "settled") {
    if (m.result_outcome === "all_on_time") return `<span class="pill good">All On Time</span>`;
    if (m.tab && m.tab.status !== "settled" && m.tab.status !== "waived") {
      const mine = m.tab.debtor_id === S.me.tg_id;
      return `<span class="pill warn">${mine ? "You Owe" : "Tab Open"}</span>`;
    }
    return `<span class="pill">${m.result_outcome === "incomplete" ? "No Result" : "Settled"}</span>`;
  }
  if (now >= Date.parse(m.window_opens)) return `<span class="pill is-live">Live</span>`;
  return `<span class="pill">In ${fmtDuration(Date.parse(m.meet_at) - now).replace(/ \d+s$/, "")}</span>`;
}

function meetupCard(m) {
  return `<button class="card meetup-card" data-code="${esc(m.code)}">
    <div class="row"><div class="grow"><div class="title ellipsis">${esc(m.title)}</div>
      <div class="meta ellipsis">${esc(m.venue_name)}</div>
      <div class="meta">${esc(fmtWhen(m.meet_at, m.time_zone))} · ${m.participant_count} ${m.participant_count === 1 ? "person" : "people"}</div></div>
      ${statusPill(m)}</div></button>`;
}

async function renderHome() {
  setBack(null);
  const draw = () => {
    const open = S.meetups.filter((m) => m.status === "lobby" || m.status === "live");
    const live = open.filter((m) => Date.now() >= Date.parse(m.window_opens));
    const upcoming = open.filter((m) => Date.now() < Date.parse(m.window_opens));
    const past = S.meetups.filter((m) => !(m.status === "lobby" || m.status === "live"));
    const owed = past.find((m) => m.tab && m.tab.debtor_id === S.me.tg_id &&
      (m.tab.status === "open" || m.tab.status === "disputed"));
    const app = mount(`<div class="screen">
      <div class="topbar"><span class="wordmark">LAST ONE PAYS</span>
        <button class="chip-btn" id="profile" aria-label="Your profile">
          <img src="${VEHICLE_ART[S.me.vehicle]}" alt="" style="transform:rotate(90deg)">${esc(S.me.display_name)}</button></div>
      <section class="hero">
        <div class="fleet" aria-hidden="true">${["car", "motorbike", "bicycle", "mrt"].map((v) => `<img src="${VEHICLE_ART[v]}" alt="">`).join("")}</div>
        <h1>Where Are You All Headed To?</h1>
        <p class="sub">Meet on time or pick up the tab.</p>
        <button class="btn btn-primary" style="margin-top:18px" id="create">Create A Meetup</button>
      </section>
      ${owed ? `<button class="card meetup-card tab-card" data-result="${esc(owed.id)}" style="margin-top:12px">
        <div class="title">You owe ${esc(owed.tab.creditor_name)}</div>
        <div class="meta">${esc(fmtStakes(owed.tab.label, owed.tab.amount, owed.tab.currency))} · ${esc(owed.title)}</div></button>` : ""}
      ${live.length ? `<h3>Live Now</h3>${live.map(meetupCard).join("")}` : ""}
      ${upcoming.length ? `<h3>Upcoming</h3>${upcoming.map(meetupCard).join("")}` : ""}
      ${past.length ? `<h3>Past</h3>${past.slice(0, 20).map(meetupCard).join("")}` : ""}
      ${S.meetups.length === 0 ? `<h3>How It Works</h3><div class="card"><ol class="steps">
        <li><b>Create a meetup</b> and set what the tab covers.</li>
        <li><b>Invite friends</b> with a link or add the bot to your group chat.</li>
        <li><b>Share your Live Location</b> on the way. Last one there picks up the tab.</li>
      </ol></div>` : ""}
    </div>`);
    app.querySelector("#create").onclick = () => { haptic("medium"); go("#/create"); };
    app.querySelector("#profile").onclick = () => go("#/profile");
    app.querySelectorAll("[data-code]").forEach((b) => (b.onclick = () => go(`#/m/${b.dataset.code}`)));
    app.querySelectorAll("[data-result]").forEach((b) => (b.onclick = () => go(`#/result/${b.dataset.result}`)));
  };
  const data = await api("GET", "/meetups");
  S.meetups = data.meetups || [];
  draw();
  const timer = setInterval(() => api("GET", "/meetups").then((d) => { S.meetups = d.meetups || []; draw(); })
    .catch(() => {}), 30_000);
  S.cleanup.push(() => clearInterval(timer));
}

// ------------------------------------------------------------------ create
function nextHourLocal() {
  const d = new Date(Date.now() + 90 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The meetup's money follows where it happens, so the time zone beats the UI language. */
function defaultCurrency() {
  const zone = localZone();
  const byZone = [
    [/^Asia\/Singapore$/, "SGD"], [/^Europe\/London$/, "GBP"], [/^Europe\//, "EUR"],
    [/^Australia\//, "AUD"], [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina)$/, "CAD"],
    [/^America\//, "USD"], [/^Pacific\/Honolulu$/, "USD"], [/^Asia\/(Kuala_Lumpur|Kuching)$/, "MYR"],
    [/^Asia\/(Kolkata|Calcutta)$/, "INR"], [/^Asia\/Tokyo$/, "JPY"],
  ];
  for (const [pattern, currency] of byZone) if (pattern.test(zone)) return currency;
  const region = (navigator.language || "en-US").split("-")[1] || "US";
  return { SG: "SGD", GB: "GBP", AU: "AUD", CA: "CAD", MY: "MYR", IN: "INR", JP: "JPY" }[region] || "USD";
}
const CURRENCIES = ["USD", "SGD", "EUR", "GBP", "AUD", "CAD", "MYR", "INR", "JPY"];

function renderCreate() {
  setBack(() => go("#/"));
  const cur = defaultCurrency();
  const app = mount(`<div class="screen">
    <h1 style="margin-top:6px">Create A Meetup</h1>
    <p class="sub">Last one there picks up the tab. If everyone's on time, nobody pays.</p>
    <label class="field"><span>Meetup Name</span>
      <input class="input" id="title" maxlength="80" placeholder="Friday Dinner"></label>
    <label class="field"><span>Where Are You All Headed?</span>
      <input class="input" id="venue-q" maxlength="120" placeholder="Search for a place" autocomplete="off"></label>
    <div id="venue-results"></div>
    <div id="venue-picked"></div>
    <label class="field"><span>When</span>
      <input class="input" id="when" type="datetime-local" value="${nextHourLocal()}"></label>
    <p class="small" style="margin:6px 2px 0">Time zone: ${esc(localZone())}</p>
    <label class="field"><span>Grace Period</span></label>
    ${chipGroup("grace", [["0", "None"], ["5", "5 min"], ["10", "10 min"], ["15", "15 min"]], "5")}
    <label class="field"><span>What Does The Tab Cover?</span></label>
    ${chipGroup("label", [["Coffee", "Coffee"], ["First Round", "First Round"], ["Dinner", "Dinner"], ["Dessert", "Dessert"], ["", "Custom"]], "Dinner")}
    <input class="input hidden" id="label-custom" maxlength="40" placeholder="e.g. Movie tickets" style="margin-top:10px">
    <label class="field"><span>Amount (Optional)</span>
      <div class="money"><input class="input" id="amount" inputmode="decimal" placeholder="20.00">
        <select class="input" id="currency">${CURRENCIES.map((c) => `<option ${c === cur ? "selected" : ""}>${c}</option>`).join("")}</select></div></label>
    <label class="field"><span>Arrival Radius</span></label>
    ${chipGroup("fence", [["50", "Small · 50 m"], ["80", "Standard · 80 m"], ["150", "Large · 150 m"]], "80")}
    <p class="error" id="err"></p>
    <button class="btn btn-primary" id="submit">Create Meetup</button>
  </div>`);

  let venue = null;
  let preview = null;
  wireChips(app, (group, value) => {
    if (group === "label") app.querySelector("#label-custom").classList.toggle("hidden", value !== "");
    if (group === "fence" && preview) preview.setFence(Number(value));
  });

  const q = app.querySelector("#venue-q");
  const results = app.querySelector("#venue-results");
  let searchTimer = 0, searchSeq = 0;
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    venue = null;
    app.querySelector("#venue-picked").innerHTML = "";
    preview?.destroy(); preview = null;
    const text = q.value.trim();
    if (text.length < 3) { results.innerHTML = ""; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const places = await searchPlaces(text);
        if (seq !== searchSeq) return;
        results.innerHTML = places.length ? `<div class="results">${places.map((p, i) =>
          `<button type="button" data-i="${i}"><div class="name">${esc(p.name)}</div>
           <div class="addr">${esc(p.address)}</div></button>`).join("")}</div>`
          : `<p class="small" style="margin:8px 2px">No places found. Try adding the city.</p>`;
        results.querySelectorAll("button").forEach((b) => (b.onclick = () => {
          venue = places[Number(b.dataset.i)];
          q.value = venue.name;
          results.innerHTML = "";
          const picked = app.querySelector("#venue-picked");
          picked.innerHTML = `<p class="small" style="margin:8px 2px 0">${esc(venue.address)}</p><div class="venue-preview" id="vp"></div>`;
          preview = venuePreview(picked.querySelector("#vp"), venue, Number(chipValue(app, "fence")));
          haptic("light");
        }));
      } catch {
        if (seq === searchSeq) results.innerHTML = `<p class="small" style="margin:8px 2px">Search isn't available right now.</p>`;
      }
    }, 320);
  });
  S.cleanup.push(() => { clearTimeout(searchTimer); preview?.destroy(); });

  app.querySelector("#submit").onclick = async (e) => {
    const err = app.querySelector("#err");
    err.textContent = "";
    const whenValue = app.querySelector("#when").value;
    const meetAt = whenValue ? new Date(whenValue) : null;
    const label = chipValue(app, "label") === "" ? app.querySelector("#label-custom").value.trim()
                                                 : chipValue(app, "label");
    if (!app.querySelector("#title").value.trim()) return (err.textContent = "Give your meetup a name");
    if (!venue) return (err.textContent = "Search for the destination and pick it from the list");
    if (!meetAt || Number.isNaN(meetAt.getTime())) return (err.textContent = "Pick a date and time");
    if (meetAt.getTime() < Date.now()) return (err.textContent = "Pick a time in the future");
    e.target.disabled = true;
    try {
      const { meetup } = await api("POST", "/meetups", {
        title: app.querySelector("#title").value,
        venue_name: venue.name, venue_address: venue.address,
        venue_lat: venue.lat, venue_lng: venue.lng,
        meet_at: meetAt.toISOString(), time_zone: localZone(),
        grace_minutes: Number(chipValue(app, "grace")),
        geofence_m: Number(chipValue(app, "fence")),
        tab_label: label || null,
        tab_amount: app.querySelector("#amount").value.trim().replace(",", ".") || null,
        currency: app.querySelector("#currency").value,
      });
      haptic("success");
      go(`#/m/${meetup.code}`, true);
      setTimeout(() => promptInvite(meetup), 350);
    } catch (error) {
      err.textContent = error.message;
      haptic("error");
      e.target.disabled = false;
    }
  };
}

async function searchPlaces(text) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", text);
  url.searchParams.set("limit", "6");
  const lang = (navigator.language || "en").slice(0, 2);
  if (["en", "de", "fr"].includes(lang)) url.searchParams.set("lang", lang);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("search failed");
  const data = await res.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const address = [street, p.city || p.town || p.village || p.district, p.state, p.country]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
    return { name: (p.name || street || address || "Pinned place").slice(0, 120),
             address: address.slice(0, 200), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function venuePreview(el, venue, fence) {
  if (!window.maplibregl) return { setFence() {}, destroy() {} };
  const map = new LiveMap(el, { venue: { lat: venue.lat, lng: venue.lng, name: venue.name },
                                geofence: fence, interactive: false, preview: true });
  return { setFence: (m) => map.setFence(m), destroy: () => map.destroy() };
}

async function promptInvite(meetup) {
  const choice = await sheet({
    title: "Invite Your Crew",
    body: "Send the invite link, or add the bot to your group chat so it can post arrivals and the result there.",
    buttons: [
      { text: "Share Invite Link", style: "btn-primary", value: "share" },
      { text: "Add To Group Chat", value: "group" },
      { text: "Later", style: "btn-ghost", value: null },
    ],
  });
  if (choice === "share") shareInvite(meetup);
  if (choice === "group") openLink(groupLink(meetup.code));
}

function shareInvite(m) {
  const text = `Join "${m.title}" at ${m.venue_name}, ${fmtWhen(m.meet_at, m.time_zone)}. ` +
    `Last one there picks up the tab: ${fmtStakes(m.tab_label, m.tab_amount, m.currency)}.`;
  openLink(`https://t.me/share/url?url=${encodeURIComponent(inviteLink(m.code))}&text=${encodeURIComponent(text)}`);
}

/**
 * Telegram never lets an app switch on someone's Live Location, so this makes
 * the one manual step as short as possible: the bot posts the exact steps at
 * the bottom of its chat, and we take the person straight there, next to 📎.
 */
async function shareLocation(m) {
  haptic("medium");
  let sent = false;
  try {
    sent = (await api("POST", `/meetups/${m.id}/share-help`)).sent;
    if (!sent && await askWriteAccess()) sent = (await api("POST", `/meetups/${m.id}/share-help`)).sent;
  } catch { /* still take them to the chat */ }
  await sheet({
    title: "Share Your Location",
    body: (sent ? "I've put the steps at the bottom of the bot chat. " : "") +
          "In the chat, tap <b>📎</b> → <b>Location</b> → <b>Share My Live Location</b> → <b>8 hours</b>. " +
          "I'll reply ✅ when it's working.",
    buttons: [{ text: "Go To The Chat", style: "btn-primary", value: true }],
  });
  openLink(botChat());
  // On phones the chat opens over the Mini App; close it so it isn't in the way.
  setTimeout(() => { try { tg?.close?.(); } catch { /* desktop keeps it open */ } }, 250);
}

function locationCard(m, liveNow) {
  if (m.my_sharing) {
    return `<div class="card"><div class="row"><span style="font-size:26px">✅</span><div class="grow">
      <b>You're sharing your location</b><div class="small">You can switch apps or lock your phone.
      Stop it any time in the bot chat.</div></div></div></div>`;
  }
  return `<div class="card">
    <b>${liveNow ? "Share your location now" : "Share your location when you set off"}</b>
    <p class="sub" style="margin-top:4px">${liveNow
      ? "So the crew can see you on the way and your arrival counts automatically."
      : "I'll remind you when the live map opens, 1 hour before."}</p>
    <button class="btn ${liveNow ? "btn-primary" : "btn-dark"}" style="margin-top:14px" id="share-loc">Share My Location</button>
    <p class="small" style="margin:12px 2px 0">No location? Tap <b>I'm Here</b> on the live map when you arrive.</p>
  </div>`;
}

// ------------------------------------------------------------------ meetup
async function renderMeetup(code) {
  if (!/^[a-f0-9]{18}$/.test(code)) return go("#/", true);
  setBack(() => go("#/"));
  let m = (await api("GET", `/meetups/code/${code}`)).meetup;
  if (!m.joined) return renderPreview(m);

  const draw = () => {
    const now = Date.now();
    const opens = Date.parse(m.window_opens), closes = Date.parse(m.window_closes);
    const isHost = m.host_id === S.me.tg_id;
    const finished = m.status === "verdict" || m.status === "settled";
    const cancelled = m.status === "cancelled";
    const liveNow = !finished && !cancelled && now >= opens && now < closes;
    const graceOver = now >= Date.parse(m.meet_at) + m.grace_minutes * 60_000;

    let status;
    if (cancelled) status = `<h2>Cancelled</h2><p class="sub">The host cancelled this meetup. No tab.</p>`;
    else if (finished) status = `<h2>The Result Is In</h2><button class="btn btn-primary" style="margin-top:14px" id="result">See Result</button>`;
    else if (liveNow) status = `<div class="row"><h2 class="grow">Live Now</h2><span class="pill is-live">Live</span></div>
      <button class="btn btn-primary" style="margin-top:14px" id="live">Open Live Map</button>`;
    else status = `<div class="small">Live map opens in</div><div class="countdown" id="countdown">${fmtDuration(opens - now)}</div>
      <p class="sub">That's 1 hour before the meet time. I'll message you when it opens.</p>`;

    const crew = (m.participants || []).map((p) => {
      const arrived = p.arrived_at ? `Arrived ${esc(fmtClock(p.arrived_at, m.time_zone))}` : "";
      return `<div class="crew-item"><span class="dot" style="background:${colorFor(p.color_index)}"></span>
        <img src="${VEHICLE_ART[p.vehicle] || VEHICLE_ART.car}" alt="">
        <div class="grow"><b>${esc(p.name)}</b>${p.id === m.host_id ? ` <span class="small">· Host</span>` : ""}
        ${p.id === S.me.tg_id ? ` <span class="small">· You</span>` : ""}</div>
        <span class="small">${arrived}</span></div>`;
    }).join("");

    const app = mount(`<div class="screen">
      <h1 style="margin-top:6px">${esc(m.title)}</h1>
      <div class="facts">
        <div class="fact"><span class="ico">📍</span><div><b>${esc(m.venue_name)}</b>${m.venue_address ? `<div class="small">${esc(m.venue_address)}</div>` : ""}</div></div>
        <div class="fact"><span class="ico">🕒</span><div>${esc(fmtMeetTime(m))}<div class="small">${m.grace_minutes ? `${m.grace_minutes} min grace period` : "No grace period"}</div></div></div>
        <div class="fact"><span class="ico">🧾</span><div>Last one there pays: <b>${esc(fmtStakes(m.tab_label, m.tab_amount, m.currency))}</b></div></div>
      </div>
      <div class="card" style="margin-top:18px">${status}</div>
      ${!finished && !cancelled ? `<h3>Invite</h3><div class="card">
        <button class="btn btn-dark" id="share">Share Invite Link</button>
        <button class="btn btn-dark" id="group">${m.group_linked ? `Linked To ${esc(m.group_title || "Group")} · Change` : "Add To Group Chat"}</button>
      </div>
      <h3>Your Location</h3>${locationCard(m, liveNow)}` : ""}
      <h3>Crew · ${(m.participants || []).length}</h3><div class="card">${crew}</div>
      ${!finished && !cancelled ? `<div style="margin-top:22px">
        ${isHost ? `<button class="btn btn-danger" id="cancel">Cancel Meetup</button>` : ""}
        ${isHost && m.status === "live" && graceOver ? `<button class="btn btn-dark" id="end">End Meetup Now</button>` : ""}
        ${!isHost && now < opens ? `<button class="btn btn-ghost" id="leave">Leave Meetup</button>` : ""}
      </div>` : ""}
    </div>`);

    const on = (id, fn) => { const el = app.querySelector(`#${id}`); if (el) el.onclick = fn; };
    on("result", () => go(`#/result/${m.id}`));
    on("live", () => go(`#/live/${m.id}`));
    on("share", () => shareInvite(m));
    on("group", () => openLink(groupLink(m.code)));
    on("share-loc", () => shareLocation(m));
    on("cancel", async () => {
      const started = m.status === "live";
      const ok = await sheet({ title: "Cancel This Meetup?",
        body: started ? "It's already started. Everyone will be told you cancelled it, and nobody pays the tab. This can't be undone."
                      : "Everyone will be told it's off. This can't be undone.",
        buttons: [{ text: "Cancel Meetup", style: "btn-danger", value: true }, { text: "Keep It", style: "btn-ghost", value: false }] });
      if (!ok) return;
      try { await api("POST", `/meetups/${m.id}/cancel`); haptic("success"); await refresh(); }
      catch (e) { toast(e.message); haptic("error"); }
    });
    on("end", async () => {
      const ok = await sheet({ title: "End The Meetup Now?",
        body: "The result will be decided from the arrivals so far. Anyone who hasn't arrived counts as not arriving.",
        buttons: [{ text: "End And Decide", style: "btn-primary", value: true }, { text: "Not Yet", style: "btn-ghost", value: false }] });
      if (!ok) return;
      try { await api("POST", `/meetups/${m.id}/end`); haptic("success"); go(`#/result/${m.id}`, true); }
      catch (e) { toast(e.message); haptic("error"); }
    });
    on("leave", async () => {
      const ok = await sheet({ title: "Leave This Meetup?", body: "You can rejoin with the invite link before the live map opens.",
        buttons: [{ text: "Leave", style: "btn-danger", value: true }, { text: "Stay", style: "btn-ghost", value: false }] });
      if (!ok) return;
      try { await api("POST", `/meetups/${m.id}/leave`); go("#/", true); }
      catch (e) { toast(e.message); }
    });
  };

  const refresh = async () => { m = (await api("GET", `/meetups/code/${code}`)).meetup; draw(); };
  draw();
  const tick = setInterval(() => {
    const el = document.getElementById("countdown");
    if (!el) return;
    const left = Date.parse(m.window_opens) - Date.now();
    if (left <= 0) refresh().catch(() => {});
    else el.textContent = fmtDuration(left);
  }, 1000);
  const poll = setInterval(() => refresh().catch(() => {}), 15_000);
  S.cleanup.push(() => { clearInterval(tick); clearInterval(poll); });
}

function renderPreview(m) {
  const closed = !(m.status === "lobby" || m.status === "live") || Date.now() >= Date.parse(m.window_closes);
  const app = mount(`<div class="screen">
    <p class="small" style="margin-top:6px">${esc(m.host_name)} invited you to</p>
    <h1>${esc(m.title)}</h1>
    <div class="facts">
      <div class="fact"><span class="ico">📍</span><div><b>${esc(m.venue_name)}</b>${m.venue_address ? `<div class="small">${esc(m.venue_address)}</div>` : ""}</div></div>
      <div class="fact"><span class="ico">🕒</span><div>${esc(fmtMeetTime(m))}</div></div>
      <div class="fact"><span class="ico">👥</span><div>${m.participant_count} going</div></div>
    </div>
    <div class="card" style="margin-top:18px"><h2>The Deal</h2><ol class="steps">
      <li>Last one there picks up the tab: <b>${esc(fmtStakes(m.tab_label, m.tab_amount, m.currency))}</b>.</li>
      <li>${m.grace_minutes ? `Arrive within <b>${m.grace_minutes} minutes</b> of the meet time to count as on time.` : "There's no grace period: be there on time."}</li>
      <li>If everyone's on time, <b>nobody pays</b>.</li>
      <li>Your location is shared with this group only while the live map is open.</li>
    </ol></div>
    <p class="error" id="err"></p>
    ${closed ? `<div class="card empty">This meetup has ${m.status === "cancelled" ? "been cancelled" : "finished"}.</div>`
             : `<button class="btn btn-primary" id="join">Join Meetup</button>`}
  </div>`);
  const join = app.querySelector("#join");
  if (join) join.onclick = async () => {
    join.disabled = true;
    try {
      await api("POST", `/meetups/code/${m.code}/join`);
      haptic("success");
      if (!S.me.can_dm) await askWriteAccess();
      route();
    } catch (e) {
      app.querySelector("#err").textContent = e.message;
      join.disabled = false;
      haptic("error");
    }
  };
}

// ------------------------------------------------------------------ live map
async function getFix() {
  const lm = tg?.LocationManager;
  if (lm && tg.isVersionAtLeast?.("8.0")) {
    if (!lm.isInited) await new Promise((r) => lm.init(r));
    if (lm.isLocationAvailable) {
      const data = await new Promise((r) => lm.getLocation(r));
      if (data) return { lat: data.latitude, lng: data.longitude, accuracy: data.horizontal_accuracy };
      const err = new Error("Location access is off for Telegram.");
      err.code = "denied";
      throw err;
    }
  }
  if (!navigator.geolocation) throw new Error("This device can't share its location.");
  return await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => {
      const err = new Error(e.code === 1 ? "Location access is off." : "Couldn't get your location. Try again outside.");
      err.code = e.code === 1 ? "denied" : "unavailable";
      reject(err);
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }));
}

async function checkIn(meetup, onDone) {
  const el = document.getElementById("modal");
  el.innerHTML = `<div class="sheet"><h2>Checking You In…</h2><p>Reading your location twice to make sure you're really there.</p>
    <div class="boot" style="min-height:60px"><div class="spinner"></div></div></div>`;
  el.hidden = false;
  el.onclick = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const fix = await getFix();
      try {
        result = (await api("POST", `/meetups/${meetup.id}/checkin`, fix)).checkin;
      } catch (e) {
        if (e.status === 429) { await wait(3500); attempt--; continue; }
        throw e;
      }
      if (result.arrived || !result.inside) break;
      await wait(4000);
    }
    el.hidden = true;
    if (result?.arrived) {
      haptic("success");
      toast("You're checked in ✅");
    } else if (result && !result.inside) {
      haptic("warning");
      await sheet({ title: "Not There Yet",
        body: `You're about <b>${esc(fmtDistance(result.distance_m, S.me.units))}</b> from ${esc(meetup.venue_name)}. ` +
              `Check in when you're within ${esc(fmtDistance(result.geofence_m, S.me.units))} of it.`,
        buttons: [{ text: "OK", style: "btn-dark", value: true }] });
    } else {
      toast("Couldn't confirm yet. Try again in a moment.");
    }
  } catch (e) {
    el.hidden = true;
    haptic("error");
    const buttons = [{ text: "OK", style: "btn-dark", value: null }];
    if (e.code === "denied" && tg?.LocationManager?.openSettings) {
      buttons.unshift({ text: "Open Location Settings", style: "btn-primary", value: "settings" });
    }
    const choice = await sheet({ title: "Couldn't Check You In", body: esc(e.message), buttons });
    if (choice === "settings") tg.LocationManager.openSettings();
  }
  onDone?.();
}

function safetyNotice(meetup) {
  const key = `lop_safety_${S.me.tg_id}_${meetup.code}`;
  try { if (localStorage.getItem(key)) return; } catch { /* private mode */ }
  sheet({ title: "Travel Safely",
    body: "Follow traffic rules and travel at a safe pace. If you're driving, check this map only when stopped " +
          "or ask a passenger. ETAs are estimates for planning, never a reason to hurry.",
    buttons: [{ text: "Got It", style: "btn-primary", value: true }] })
    .then(() => { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } });
}

async function renderLive(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return go("#/", true);
  let state = (await api("GET", `/meetups/${id}/live`)).live;
  setBack(() => go(`#/m/${state.code}`));
  if (!state.window_open && (state.status === "verdict" || state.status === "settled")) {
    return go(`#/result/${id}`, true);
  }
  if (tg?.isVersionAtLeast?.("7.7")) {
    tg.disableVerticalSwipes();
    S.cleanup.push(() => tg.enableVerticalSwipes());
  }

  const app = mount(`<div class="live-screen">
    <div id="map"></div>
    <div class="top">
      <span class="glass">${esc(state.title)} · ${esc(state.venue_name)}</span>
      <span class="glass" id="meet-pill">${esc(fmtClock(state.meet_at, state.time_zone))}</span>
    </div>
    <div class="dock">
      <div class="rail" id="rail" role="group" aria-label="Crew"></div>
      <div class="status-card glass">
        <div class="row"><div class="grow"><div class="line1" id="l1"></div><div class="line2" id="l2"></div></div>
          <div class="seg glass" role="group" aria-label="Camera">
            <button id="cam-me" aria-pressed="true">Me</button><button id="cam-all" aria-pressed="false">All</button></div></div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary" id="checkin">I'm Here</button>
          <button class="btn btn-dark" id="share-loc">Share My Location</button></div>
      </div>
    </div></div>`);

  let map = null;
  if (window.maplibregl && maplibregl.supported?.({ failIfMajorPerformanceCaveat: false }) !== false) {
    map = new LiveMap(app.querySelector("#map"), {
      venue: { lat: state.venue_lat, lng: state.venue_lng, name: state.venue_name },
      geofence: state.geofence_m, interactive: true, units: S.me.units,
      onSelect: (pid) => drawRail(pid),
    });
    S.cleanup.push(() => map.destroy());
  } else {
    app.querySelector("#map").innerHTML = `<div class="map-fallback">The live map needs WebGL, which this device doesn't support. Arrivals still work.</div>`;
  }

  let selected = null;
  const drawRail = (pid) => {
    if (pid !== undefined) selected = pid;
    const rail = app.querySelector("#rail");
    rail.innerHTML = state.participants.map((p) => {
      const st = statusFor(p, state, map?.etaFor(p.id), S.me.units);
      return `<button class="rail-chip glass" data-id="${p.id}" aria-pressed="${p.id === selected}">
        <img src="${VEHICLE_ART[p.vehicle] || VEHICLE_ART.car}" alt="">
        <span><span style="color:${p.is_me ? "var(--yel)" : colorFor(p.color_index)}">${esc(p.is_me ? "You" : p.name)}</span>
        <span class="st">${esc(st.short)}</span></span></button>`;
    }).join("");
    rail.querySelectorAll(".rail-chip").forEach((b) => (b.onclick = () => {
      selected = Number(b.dataset.id);
      map?.focus(selected);
      setCam(null);
      drawRail();
      haptic("light");
    }));
  };

  const setCam = (mode) => {
    app.querySelector("#cam-me").setAttribute("aria-pressed", String(mode === "me"));
    app.querySelector("#cam-all").setAttribute("aria-pressed", String(mode === "all"));
    if (mode && map) map.setMode(mode === "me" ? "follow" : "overview");
  };
  app.querySelector("#cam-me").onclick = () => { selected = null; setCam("me"); drawRail(); };
  app.querySelector("#cam-all").onclick = () => { selected = null; setCam("all"); drawRail(); };

  const drawStatus = () => {
    const me = state.participants.find((p) => p.is_me);
    const st = statusFor(me, state, map?.etaFor(me?.id), S.me.units);
    const finished = state.status === "verdict" || state.status === "settled";
    let l1, l2 = st.detail;
    if (finished) { l1 = "The Result Is In"; l2 = "Tap to see who picks up the tab."; }
    else if (!state.window_open) { l1 = "Live Map Closed"; l2 = "This meetup's live window has ended."; }
    else if (me?.arrived_at) l1 = "You've Arrived";
    else if (!me?.lat) l1 = me?.sharing ? "Waiting For Your Location" : "Not Sharing Yet";
    else l1 = S.me.travel_mode === "driving" ? "Drive Safely" : "On Your Way";
    if (!finished && state.window_open && !me?.arrived_at && S.me.travel_mode === "driving" && me?.lat) {
      l2 = `${st.detail} · Check updates when stopped`;
    }
    app.querySelector("#l1").textContent = l1;
    app.querySelector("#l2").textContent = l2;
    const checkinBtn = app.querySelector("#checkin");
    const shareBtn = app.querySelector("#share-loc");
    if (finished) {
      checkinBtn.textContent = "See Result";
      checkinBtn.onclick = () => go(`#/result/${id}`);
      shareBtn.classList.add("hidden");
      return;
    }
    checkinBtn.classList.toggle("hidden", Boolean(me?.arrived_at) || !state.window_open);
    shareBtn.classList.toggle("hidden", Boolean(me?.sharing) || Boolean(me?.arrived_at) || !state.window_open);
  };

  app.querySelector("#checkin").onclick = () => checkIn(state, () => refresh());
  app.querySelector("#share-loc").onclick = () => shareLocation(state);

  let wasFinished = state.status === "verdict" || state.status === "settled";
  const apply = () => {
    map?.update(state);
    drawRail();
    drawStatus();
  };
  const refresh = async () => {
    try {
      state = (await api("GET", `/meetups/${id}/live`)).live;
      apply();
      const finished = state.status === "verdict" || state.status === "settled";
      if (finished && !wasFinished) { haptic("success"); toast("The result is in"); }
      wasFinished = finished;
    } catch (e) {
      if (e.status === 403 || e.status === 404) go("#/", true);
    }
  };
  apply();
  map?.setMode("follow");
  safetyNotice(state);
  const poll = setInterval(refresh, 4000);
  const relabel = setInterval(() => { drawRail(); drawStatus(); }, 15_000);
  const onActive = () => refresh();
  tg?.onEvent?.("activated", onActive);
  S.cleanup.push(() => { clearInterval(poll); clearInterval(relabel); tg?.offEvent?.("activated", onActive); });
}

// ------------------------------------------------------------------ result
async function renderResult(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return go("#/", true);
  let r = (await api("GET", `/meetups/${id}/result`)).result;
  setBack(() => go("#/"));
  const decided = r.status === "verdict" || r.status === "settled";
  if (!decided) return go(`#/m/${r.code}`, true);

  const draw = () => {
    const tab = r.tab;
    const myId = S.me.tg_id;
    const stakes = fmtStakes(r.tab_label, r.tab_amount, r.currency);
    let icon, head, sub;
    if (r.result_outcome === "all_on_time") { icon = "🎉"; head = "Everyone Made It"; sub = "No tab today."; }
    else if (r.result_outcome === "tab_owed" && tab) {
      icon = "🧾";
      head = tab.debtor_id === myId ? "You Pick Up The Tab" : `${tab.debtor_name} Picks Up The Tab`;
      sub = `${stakes} for ${tab.creditor_id === myId ? "you" : tab.creditor_name}`;
    } else { icon = "🤷"; head = "No Result"; sub = "Not enough people arrived for a tab."; }

    const rows = r.participants.map((p, i) => {
      const when = p.arrived_at ? fmtClock(p.arrived_at, r.time_zone) : "Didn't arrive";
      const late = p.arrived_at ? (p.late_minutes > 0 ? `${p.late_minutes} min after grace` : "On time") : "";
      return `<div class="crew-item"><span class="rank ${p.is_last ? "last" : ""}">${p.rank || i + 1}</span>
        <img src="${VEHICLE_ART[p.vehicle] || VEHICLE_ART.car}" alt="">
        <div class="grow"><b>${esc(p.name)}</b>${p.id === myId ? ` <span class="small">· You</span>` : ""}
          <div class="small">${esc(late)}</div></div><span class="small">${esc(when)}</span></div>`;
    }).join("");

    let tabHtml = "";
    if (tab) {
      const label = { open: "Not paid yet", marked_paid: "Marked as paid", settled: "Settled", waived: "Waived", disputed: "Disputed" }[tab.status];
      const isDebtor = tab.debtor_id === myId, isCreditor = tab.creditor_id === myId;
      const actions = [];
      if (isDebtor && (tab.status === "open" || tab.status === "disputed")) actions.push(["mark_paid", "I've Paid", "btn-primary"]);
      if (isCreditor && tab.status === "marked_paid") actions.push(["confirm", "Confirm Received", "btn-primary"]);
      if (isCreditor && ["open", "disputed", "marked_paid"].includes(tab.status)) actions.push(["waive", "Waive The Tab", "btn-dark"]);
      if ((isDebtor || isCreditor) && (tab.status === "open" || tab.status === "marked_paid")) actions.push(["dispute", "Dispute", "btn-ghost"]);
      tabHtml = `<div class="card tab-card"><div class="row"><div class="grow"><b>${esc(tab.debtor_name)} → ${esc(tab.creditor_name)}</b>
        <div class="small">${esc(stakes)}</div></div><span class="pill ${tab.status === "settled" || tab.status === "waived" ? "good" : "warn"}">${esc(label)}</span></div>
        ${actions.length ? `<div style="margin-top:14px">${actions.map(([a, t, s]) => `<button class="btn ${s}" data-act="${a}">${t}</button>`).join("")}</div>` : ""}
        <p class="small" style="margin:12px 2px 0">Settle up however you like; Last One Pays never handles money.</p></div>`;
    }

    const app = mount(`<div class="screen">
      <div class="verdict-head"><div class="big">${icon}</div><h1>${esc(head)}</h1><p class="sub">${esc(sub)}</p>
        <p class="small">${esc(r.title)} · ${esc(r.venue_name)}</p></div>
      ${tabHtml}
      <h3>Arrivals</h3><div class="card">${rows}</div>
      <button class="btn btn-dark" style="margin-top:18px" id="share">Share Result</button>
    </div>`);
    app.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
      if (b.dataset.act === "dispute" || b.dataset.act === "waive") {
        const ok = await sheet({ title: b.dataset.act === "waive" ? "Waive This Tab?" : "Dispute This Tab?",
          body: b.dataset.act === "waive" ? "Nobody will owe anything for this meetup." : "The other person will be told you disagree.",
          buttons: [{ text: b.textContent, style: "btn-primary", value: true }, { text: "Back", style: "btn-ghost", value: false }] });
        if (!ok) return;
      }
      b.disabled = true;
      try {
        await api("POST", `/tabs/${tab.id}/${b.dataset.act}`);
        haptic("success");
        r = (await api("GET", `/meetups/${id}/result`)).result;
        draw();
      } catch (e) { toast(e.message); haptic("error"); b.disabled = false; }
    }));
    app.querySelector("#share").onclick = () => {
      const text = r.result_outcome === "tab_owed" && tab
        ? `${tab.debtor_name} was last in at ${r.title} and picks up the tab: ${stakes} 🧾`
        : r.result_outcome === "all_on_time" ? `Everyone made it to ${r.title} on time 🎉` : `${r.title} wrapped up.`;
      openLink(`https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${BOT()}`)}&text=${encodeURIComponent(text)}`);
    };
  };
  draw();
}

// ------------------------------------------------------------------ boot
let deepLink = null;
function pendingDeepLink() {
  const link = deepLink;
  deepLink = null;
  return link;
}

function parseDeepLink() {
  const params = new URLSearchParams(location.search);
  let code = params.get("m");
  const screen = params.get("s");
  const start = tg?.initDataUnsafe?.start_param || "";
  const fromStart = /^(?:m_|join_)?([a-f0-9]{18})$/.exec(start);
  if (!code && fromStart) code = fromStart[1];
  if (!code || !/^[a-f0-9]{18}$/.test(code)) return null;
  return { code, screen };
}

async function resolveDeepLink(link) {
  if (!link) return null;
  if (link.screen === "live" || link.screen === "result") {
    try {
      const { meetup } = await api("GET", `/meetups/code/${link.code}`);
      if (meetup.joined) return `#/${link.screen}/${meetup.id}`;
    } catch { /* fall back to the meetup page */ }
  }
  return `#/m/${link.code}`;
}

function renderNoTelegram() {
  const bot = CFG.botUsername;
  mount(`<div class="screen" style="text-align:center;padding-top:80px">
    <div class="wordmark">LAST ONE PAYS</div>
    <h1 style="margin-top:20px">Open This In Telegram</h1>
    <p class="sub">Last One Pays runs inside Telegram so your friends can find you and the bot can confirm arrivals.</p>
    ${bot ? `<a class="btn btn-primary" style="margin-top:24px" href="https://t.me/${esc(bot)}">Open @${esc(bot)}</a>` : ""}
  </div>`);
}

async function boot() {
  if (!tg || !tg.initData) return renderNoTelegram();
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#10111A");
    tg.setBackgroundColor?.("#10111A");
    tg.setBottomBarColor?.("#10111A");
  } catch { /* older clients */ }

  try {
    const data = await api("GET", "/me");
    S.me = data.me;
    S.bot = data.bot_username;
  } catch (error) {
    return renderError(error);
  }
  window.addEventListener("popstate", route);
  const target = await resolveDeepLink(parseDeepLink());
  if (target && S.me.profile_set) history.replaceState(null, "", target);
  else if (target) deepLink = target;
  route();
}

boot();
