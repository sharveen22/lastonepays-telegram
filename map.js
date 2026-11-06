// Live map for the Mini App: MapLibre with the same dark 3D treatment as the
// iOS hero map, a glowing venue fence, each person's vehicle, and a route to
// the venue for an ETA. Labels follow the iOS rules: arrivals are confirmed
// facts, everything else is an estimate, and stale data says so.

export const VEHICLE_ART = {
  car: "art/car.png", motorbike: "art/motorbike.png", bicycle: "art/bicycle.png", mrt: "art/mrt.png",
};
// Yellow is reserved for "you", so the shared palette starts elsewhere.
const PALETTE = ["#4CD7FF", "#4CD964", "#A78BFA", "#FF5A4E", "#FF9F43", "#F78FB3", "#7BED9F",
                 "#70A1FF", "#ECCC68", "#C56CF0"];
export const colorFor = (index) => PALETTE[((index ?? 0) % PALETTE.length + PALETTE.length) % PALETTE.length];

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const ROUTER = "https://routing.openstreetmap.de";
const PROFILE = { driving: "car", cycling: "bike", walking: "foot" };
// Fallback speeds for straight-line ETAs (km/h), with a road-detour factor.
const SPEED = { driving: 30, transit: 22, cycling: 15, walking: 4.8 };
const DETOUR = 1.35;

const R = 6371000;
export function meters(a, b) {
  const x = (b.lng - a.lng) * Math.PI / 180 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  const y = (b.lat - a.lat) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R;
}
function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
            Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
            Math.cos((b.lng - a.lng) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function fmtDist(m, units) {
  if (!Number.isFinite(m)) return "";
  if (units === "mi") { const mi = m / 1609.34; return mi < 0.1 ? `${Math.round(m * 3.281)} ft` : `${mi.toFixed(1)} mi`; }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Short and long status text for one participant. */
export function statusFor(p, state, eta, units = "km") {
  if (!p) return { short: "", detail: "" };
  if (p.arrived_at) return { short: "Arrived", tag: "ARRIVED", detail: "You're here. Nice." };
  if (!state.window_open) return { short: "Map closed", tag: "", detail: "" };
  if (p.lat == null) {
    return p.sharing
      ? { short: "Waiting", tag: "WAITING FOR LOCATION", detail: "Waiting for the first Live Location update" }
      : { short: "Not sharing", tag: "NOT SHARING YET", detail: "Share your Live Location in the bot chat" };
  }
  const ageMin = (Date.parse(state.server_now) - Date.parse(p.recorded_at)) / 60000;
  const dist = meters({ lat: p.lat, lng: p.lng }, { lat: state.venue_lat, lng: state.venue_lng });
  if (!p.sharing && ageMin > 2) {
    const ago = Math.round(ageMin);
    return { short: `Seen ${ago}m ago`, tag: "LOCATION OUT OF DATE",
             detail: `Sharing stopped · last seen ${ago} min ago` };
  }
  if (ageMin > 15) {
    const ago = Math.round(ageMin);
    return { short: `Seen ${ago}m ago`, tag: "LOCATION OUT OF DATE", detail: `Last update ${ago} min ago` };
  }
  if (dist <= state.geofence_m) {
    return { short: "Checking arrival", tag: "CHECKING ARRIVAL…", detail: "At the venue · confirming your arrival" };
  }
  if (eta && Number.isFinite(eta.seconds)) {
    const mins = Math.max(1, Math.ceil(eta.seconds / 60));
    const unit = mins === 1 ? "min" : "mins";
    return { short: `~${mins} ${unit} away`, tag: `~${mins} ${unit.toUpperCase()} AWAY`,
             detail: `${fmtDist(dist, units)} to go · ~${mins} ${unit} away` };
  }
  return { short: fmtDist(dist, units), tag: fmtDist(dist, units).toUpperCase(), detail: `${fmtDist(dist, units)} to go` };
}

function circle(center, radius, steps = 72) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radius * Math.cos(a)) / 111320;
    const dLng = (radius * Math.sin(a)) / (111320 * Math.cos(center.lat * Math.PI / 180));
    ring.push([center.lng + dLng, center.lat + dLat]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

/** One routing request at a time, at most one a second: the public router is fair-use. */
class RouteQueue {
  constructor() { this.jobs = []; this.busy = false; this.last = 0; }
  push(job) {
    if (this.jobs.some((j) => j.key === job.key)) return;
    this.jobs.push(job);
    this.run();
  }
  async run() {
    if (this.busy) return;
    this.busy = true;
    while (this.jobs.length) {
      const wait = Math.max(0, this.last + 1100 - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const job = this.jobs.shift();
      this.last = Date.now();
      try { await job.fn(); } catch { /* fallback ETA covers failures */ }
    }
    this.busy = false;
  }
  clear() { this.jobs.length = 0; }
}

export class LiveMap {
  constructor(el, opts) {
    this.opts = opts;
    this.venue = opts.venue;
    this.fence = opts.geofence || 80;
    this.units = opts.units || "km";
    this.people = new Map();
    this.routes = new Map();
    this.queue = new RouteQueue();
    this.mode = opts.preview ? "preview" : "follow";
    this.focusId = null;
    this.state = null;
    this.ready = false;
    this.dead = false;

    this.map = new maplibregl.Map({
      container: el, style: STYLE, center: [this.venue.lng, this.venue.lat],
      zoom: opts.preview ? 15.6 : 14.5, pitch: opts.preview ? 45 : 50, bearing: 0,
      maxPitch: 75, interactive: opts.interactive !== false, attributionControl: false,
      dragRotate: true, pitchWithRotate: true,
      // Only for local visual tests (?capture=1); keeping frames costs GPU time.
      preserveDrawingBuffer: new URLSearchParams(location.search).has("capture"),
    });
    if (new URLSearchParams(location.search).has("capture")) window.__lopMap = this.map;
    // OpenStreetMap credit must stay visible. Top-right keeps it clear of the
    // dock's buttons; it starts collapsed to the (i) button.
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
    this.map.once("styledata", () => {
      el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });
    // `load` waits on a sprite pattern this style never resolves; `style.load`
    // is what actually means the layers can be edited.
    this.map.on("style.load", () => this.onStyle());
    this.map.on("zoom", () => this.resize());
    for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
      this.map.on(ev, (e) => { if (e.originalEvent && !opts.preview) this.mode = "explore"; });
    }

    const pin = document.createElement("div");
    pin.className = "lop-pin";
    pin.innerHTML = `<img src="art/icon.png" alt="${String(this.venue.name || "Destination").replace(/"/g, "")}">`;
    this.venueMarker = new maplibregl.Marker({ element: pin }).setLngLat([this.venue.lng, this.venue.lat]).addTo(this.map);

    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  onStyle() {
    const m = this.map;
    try {
      m.setPaintProperty("background", "background-color", "#0A0B12");
      for (const layer of m.getStyle().layers) {
        if (layer.type === "symbol") m.setLayoutProperty(layer.id, "visibility", "none");
      }
      const paint = {
        water: ["fill-color", "#0B1622"], landuse_residential: ["fill-color", "#0E1017"],
        landuse_park: ["fill-color", "#0E1712"], landcover_wood: ["fill-color", "#101A14"],
        highway_path: ["line-color", "#242833"], highway_minor: ["line-color", "#2B3140"],
        highway_major_casing: ["line-color", "#12151C"], highway_major_inner: ["line-color", "#3A4152"],
        highway_major_subtle: ["line-color", "#2B3140"], highway_motorway_casing: ["line-color", "#161A23"],
        highway_motorway_inner: ["line-color", "#454D60"], highway_motorway_subtle: ["line-color", "#333A49"],
      };
      for (const [id, [prop, value]] of Object.entries(paint)) {
        if (m.getLayer(id)) m.setPaintProperty(id, prop, value);
      }
      if (m.getLayer("building")) m.removeLayer("building");
      m.setLight({ anchor: "viewport", color: "#AEC0EA", intensity: 0.38, position: [1.3, 210, 32] });
      m.addLayer({
        id: "lop-buildings", source: "openmaptiles", "source-layer": "building", type: "fill-extrusion",
        minzoom: 13.5, paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
                                   0, "#1A2030", 40, "#222A3C", 120, "#2D3852"],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.95,
        },
      });
    } catch { /* a style change upstream must not break the map */ }

    m.addSource("lop-fence", { type: "geojson", data: circle(this.venue, this.fence) });
    m.addLayer({ id: "lop-fence-fill", source: "lop-fence", type: "fill",
                 paint: { "fill-color": "#FFD22E", "fill-opacity": 0.07 } });
    m.addLayer({ id: "lop-fence-line", source: "lop-fence", type: "line",
                 paint: { "line-color": "#FFD22E", "line-opacity": 0.55, "line-width": 1.4, "line-dasharray": [2, 3] } });
    this.ready = true;
    if (this.state) this.update(this.state);
  }

  setFence(radius) {
    this.fence = radius;
    this.map.getSource("lop-fence")?.setData(circle(this.venue, radius));
  }

  carPixels() {
    return Math.max(24, Math.min(96, 44 * Math.pow(2, (this.map.getZoom() - 14.5) * 0.4)));
  }

  resize() {
    const px = this.carPixels();
    for (const p of this.people.values()) {
      p.vehEl.style.width = p.vehEl.style.height = `${px.toFixed(0)}px`;
      p.tag.setOffset([0, -px * 0.35]);
    }
  }

  update(state) {
    this.state = state;
    this.units = state.units || this.units;
    if (!this.ready || this.dead) return;
    const seen = new Set();
    for (const p of state.participants) {
      seen.add(p.id);
      const has = p.lat != null && p.lng != null && state.window_open;
      let rec = this.people.get(p.id);
      if (!has) {
        if (rec) { rec.veh.remove(); rec.tag.remove(); this.people.delete(p.id); this.dropRoute(p.id); }
        continue;
      }
      const target = { lat: p.lat, lng: p.lng };
      if (!rec) rec = this.addPerson(p, target);
      else if (rec.to.lat !== target.lat || rec.to.lng !== target.lng) {
        const moved = meters(rec.to, target);
        rec.from = { ...rec.shown };
        rec.to = target;
        rec.t0 = performance.now();
        if (Number.isInteger(p.heading)) rec.bearing = p.heading;
        else if (moved > 8) rec.bearing = bearing(rec.from, target);
      }
      rec.p = p;
      this.label(rec);
      if (p.arrived_at) this.dropRoute(p.id);
      else this.requestRoute(p);
    }
    for (const [id, rec] of this.people) {
      if (!seen.has(id)) { rec.veh.remove(); rec.tag.remove(); this.people.delete(id); this.dropRoute(id); }
    }
    this.camera(false);
  }

  addPerson(p, at) {
    const vehEl = document.createElement("div");
    vehEl.className = "lop-veh";
    const color = p.is_me ? "#FFD22E" : colorFor(p.color_index);
    vehEl.innerHTML = `<div class="halo" style="background:radial-gradient(closest-side, ${color}66, transparent 72%)"></div>
      <img src="${VEHICLE_ART[p.vehicle] || VEHICLE_ART.car}" alt="">`;
    vehEl.addEventListener("click", () => this.opts.onSelect?.(p.id));
    const veh = new maplibregl.Marker({ element: vehEl, rotationAlignment: "map", pitchAlignment: "map" })
      .setLngLat([at.lng, at.lat]).addTo(this.map);

    const tagEl = document.createElement("div");
    tagEl.className = "lop-tag";
    tagEl.innerHTML = `<span class="nm${p.is_me ? " me" : ""}"></span><span class="eta"></span>`;
    const tag = new maplibregl.Marker({ element: tagEl, anchor: "bottom" }).setLngLat([at.lng, at.lat]).addTo(this.map);

    const rec = { p, veh, vehEl, tag, tagEl, from: at, to: at, shown: { ...at }, t0: 0,
                  bearing: Number.isInteger(p.heading) ? p.heading : bearing(at, this.venue) };
    this.people.set(p.id, rec);
    this.resize();
    return rec;
  }

  label(rec) {
    const st = statusFor(rec.p, this.state, this.etaFor(rec.p.id), this.units);
    const nm = rec.tagEl.querySelector(".nm");
    nm.textContent = rec.p.is_me ? "You" : rec.p.name;
    nm.style.boxShadow = rec.p.is_me ? "" : `0 0 0 1px ${colorFor(rec.p.color_index)}b0`;
    const eta = rec.tagEl.querySelector(".eta");
    eta.textContent = st.tag || "";
    eta.style.display = st.tag ? "" : "none";
  }

  frame(now) {
    if (this.dead) return;
    for (const rec of this.people.values()) {
      const t = rec.t0 ? Math.min(1, (now - rec.t0) / 1400) : 1;
      const k = t * t * (3 - 2 * t);
      rec.shown = { lat: rec.from.lat + (rec.to.lat - rec.from.lat) * k,
                    lng: rec.from.lng + (rec.to.lng - rec.from.lng) * k };
      rec.veh.setLngLat([rec.shown.lng, rec.shown.lat]);
      rec.veh.setRotation(rec.bearing);
      rec.tag.setLngLat([rec.shown.lng, rec.shown.lat]);
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- routes / ETA
  requestRoute(p) {
    const origin = { lat: p.lat, lng: p.lng };
    const cached = this.routes.get(p.id);
    const mode = p.travel_mode || "driving";
    const fresh = cached && cached.mode === mode && meters(cached.origin, origin) < 150 &&
                  Date.now() - cached.at < 180_000;
    if (fresh) return;
    if (!PROFILE[mode]) {
      this.setRoute(p, { origin, mode, at: Date.now(), coords: [[p.lng, p.lat], [this.venue.lng, this.venue.lat]],
                         seconds: null, straight: true });
      return;
    }
    this.queue.push({ key: p.id, fn: async () => {
      if (this.dead) return;
      const profile = PROFILE[mode];
      const url = `${ROUTER}/routed-${profile}/route/v1/${profile === "car" ? "driving" : profile}/` +
        `${origin.lng},${origin.lat};${this.venue.lng},${this.venue.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error("route");
      const data = await res.json();
      const route = data.routes?.[0];
      if (!route) throw new Error("no route");
      this.setRoute(p, { origin, mode, at: Date.now(), coords: route.geometry.coordinates,
                         seconds: route.duration, straight: false });
    } });
  }

  setRoute(p, route) {
    if (this.dead || !this.ready) return;
    this.routes.set(p.id, route);
    const id = `lop-route-${p.id}`;
    const data = { type: "Feature", geometry: { type: "LineString", coordinates: route.coords }, properties: {} };
    const color = p.is_me ? "#FFD22E" : colorFor(p.color_index);
    if (this.map.getSource(id)) {
      this.map.getSource(id).setData(data);
    } else {
      this.map.addSource(id, { type: "geojson", data });
      const before = this.map.getLayer("lop-fence-fill") ? "lop-fence-fill" : undefined;
      this.map.addLayer({ id: `${id}-glow`, source: id, type: "line", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-opacity": 0.25, "line-blur": 8,
                 "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 9, 15, 15, 18, 34] } }, before);
      this.map.addLayer({ id: `${id}-core`, source: id, type: "line", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": color, "line-opacity": 0.9,
                 "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 2.6, 15, 4.5, 18, 10],
                 ...(route.straight ? { "line-dasharray": [1.5, 2] } : {}) } }, before);
    }
    const rec = this.people.get(p.id);
    if (rec) this.label(rec);
  }

  dropRoute(pid) {
    const id = `lop-route-${pid}`;
    for (const layer of [`${id}-glow`, `${id}-core`]) if (this.map.getLayer(layer)) this.map.removeLayer(layer);
    if (this.map.getSource(id)) this.map.removeSource(id);
    this.routes.delete(pid);
  }

  /** ETA from the last route, scaled by how much closer they are since; otherwise a straight-line estimate. */
  etaFor(pid) {
    const p = this.state?.participants.find((x) => x.id === pid);
    if (!p || p.lat == null || p.arrived_at) return null;
    const here = { lat: p.lat, lng: p.lng };
    const crow = meters(here, this.venue);
    const route = this.routes.get(pid);
    if (route && Number.isFinite(route.seconds)) {
      const then = meters(route.origin, this.venue);
      const scale = then > 0 ? Math.min(1.5, crow / then) : 1;
      return { seconds: route.seconds * scale, approx: false };
    }
    const speed = SPEED[p.travel_mode] || SPEED.driving;
    return { seconds: (crow * DETOUR) / (speed / 3.6), approx: true };
  }

  // ---------------------------------------------------------------- camera
  setMode(mode) {
    this.mode = mode;
    this.focusId = null;
    this.camera(true);
  }

  focus(pid) {
    this.mode = "follow";
    this.focusId = pid;
    this.camera(true);
  }

  camera(force) {
    if (!this.ready || this.mode === "explore" || this.mode === "preview") return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduce ? 0 : force ? 900 : 1200;
    const pad = { top: 90, bottom: 270, left: 40, right: 40 };
    if (this.mode === "follow") {
      const target = this.focusId != null
        ? this.people.get(this.focusId)
        : [...this.people.values()].find((r) => r.p.is_me);
      if (target) {
        this.map.easeTo({ center: [target.to.lng, target.to.lat], zoom: 15.6, pitch: 55,
                          bearing: target.bearing, padding: pad, duration });
        return;
      }
    }
    const points = [[this.venue.lng, this.venue.lat], ...[...this.people.values()].map((r) => [r.to.lng, r.to.lat])];
    if (points.length === 1) {
      this.map.easeTo({ center: points[0], zoom: 15, pitch: 45, bearing: 0, padding: pad, duration });
      return;
    }
    const bounds = points.reduce((b, pt) => b.extend(pt), new maplibregl.LngLatBounds(points[0], points[0]));
    this.map.fitBounds(bounds, { padding: pad, maxZoom: 16, pitch: 40, bearing: 0, duration });
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.queue.clear();
    try { this.map.remove(); } catch { /* already gone */ }
  }
}
