"use strict";

/* ---------------- Config ---------------- */
// In dev (file:// or localhost) OTP is served directly on :8080. In production the
// page is served over https and nginx reverse-proxies the OTP API under same-origin /otp/.
const OTP_IS_LOCAL = !location.hostname || location.hostname === "localhost" || location.hostname === "127.0.0.1";
const OTP_URL = OTP_IS_LOCAL
  ? `${location.protocol.startsWith("http") ? location.protocol : "http:"}//${location.hostname || "localhost"}:8080/otp/gtfs/v1`
  : "/otp/gtfs/v1";
const PHOTON = "https://photon.komoot.io/api/"; // OSM-based autocomplete geocoder (type-ahead)
const NOMINATIM = "https://nominatim.openstreetmap.org/search"; // fallback
const DUBLIN_CENTER = [-6.26, 53.345];
const DUBLIN_VIEWBOX = "-6.55,53.65,-6.00,53.17"; // left,top,right,bottom (soft bias only)
const CONNECTOR_FEED = "msconn"; // gtfsId prefix that marks a Microsoft Connector leg

// Fixed company destination — staff use this app without accounts, so "Work" is a
// built-in shortcut to the Microsoft Dublin campus (One Microsoft Place).
const WORK_PLACE = { lat: 53.2689612, lon: -6.1949369, short: "Work", label: "One Microsoft Place" };

/* mode -> visual */
const MODE_STYLE = {
  WALK:    { ic: "walk",  color: "#8a94a6", label: "Walk" },
  BUS:     { ic: "bus",   color: "#0078d4", label: "Bus" },
  TRAM:    { ic: "tram",  color: "#107c10", label: "Luas" },
  RAIL:    { ic: "rail",  color: "#0ea5e9", label: "Rail" },
  SUBWAY:  { ic: "rail",  color: "#0ea5e9", label: "Rail" },
  FERRY:   { ic: "ferry", color: "#038387", label: "Ferry" },
  CONNECTOR: { ic: "connector", color: "#5c2d91", label: "Connector" },
};

/* ---------------- Icons (Material Symbols Rounded) ---------------- */
const ICON_NAME = {
  dot: "circle",
  walk: "directions_walk",
  bus: "directions_bus",
  tram: "tram",
  rail: "train",
  ferry: "directions_boat",
  connector: "airport_shuttle",
  flag: "flag",
  play: "play_arrow",
  swap: "swap_vert",
  recenter: "my_location",
  close: "close",
  map: "map",
  alert: "error",
  noroute: "search_off",
  "arrow-up": "straight",
  "turn-left": "turn_left",
  "turn-right": "turn_right",
  uturn: "u_turn_left",
};
function svgIcon(name, size = 20) {
  const g = ICON_NAME[name] || ICON_NAME.dot;
  return `<span class="msym" style="font-size:${size}px" aria-hidden="true">${g}</span>`;
}

/* ---------------- State ---------------- */
const state = {
  origin: null,      // { lat, lon, label }
  dest: null,
  itineraries: [],   // the Connector-available result list (what we display)
  comparison: null,  // { withBest, withoutBest, savesMinutes, publicFare, connectorWins, ... }
  selected: 0,
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  originInput: $("originInput"),
  destInput: $("destInput"),
  originSug: $("originSuggestions"),
  destSug: $("destSuggestions"),
  swapBtn: $("swapBtn"),
  planBtn: $("planBtn"),
  useLocationBtn: $("useLocationBtn"),
  timeMode: $("timeMode"),
  whenInput: $("whenInput"),
  sheet: $("resultsSheet"),
  resultsHead: $("resultsHead"),
  resultsTitle: $("resultsTitle"),
  resultsBody: $("resultsBody"),
  emptyState: $("emptyState"),
  clearPlanBtn: $("clearPlanBtn"),
  toast: $("toast"),
  navOverlay: $("navOverlay"),
  navIcon: $("navIcon"),
  navInstruction: $("navInstruction"),
  navSub: $("navSub"),
  navProgress: $("navProgress"),
  navEtaMain: $("navEtaMain"),
  navExit: $("navExit"),
  navRecenter: $("navRecenter"),
};

/* ---------------- Map ---------------- */
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: DUBLIN_CENTER,
  zoom: 11,
  attributionControl: { compact: true },
});

// Native-style "locate me" button with a live blue location dot (iOS-like).
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: false,
  showUserLocation: true,
  showAccuracyCircle: true,
});
map.addControl(geolocate, "bottom-right");

// The native geolocate control's blue dot represents "your location". When it
// fixes, use it as the origin (unless the user has chosen a custom start).
let forceOriginToMe = false;
geolocate.on("geolocate", (pos) => {
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  if (forceOriginToMe || !state.origin || state.origin.current) {
    state.origin = { lat, lon, short: "Your location", label: "Your location", current: true };
    els.originInput.value = "Your location";
    if (originMarker) { originMarker.remove(); originMarker = null; } // blue dot stands in for the pin
    updateLocBtn();
    if (state.dest) fitToPoints();
  }
  forceOriginToMe = false;
});
geolocate.on("error", () => {
  if (forceOriginToMe) toast("Could not get your location.");
  forceOriginToMe = false;
});

// Recolor the basemap toward an iOS Maps palette (soft blue water, muted greens).
function styleBasemapIOS() {
  const layers = (map.getStyle().layers) || [];
  for (const l of layers) {
    const sl = l["source-layer"];
    if (!sl || l.type !== "fill") continue;
    try {
      if (sl === "water") map.setPaintProperty(l.id, "fill-color", "#bfe0f5");
      else if (sl === "park" || sl === "landcover") map.setPaintProperty(l.id, "fill-color", "#dcecd6");
    } catch (e) { /* layer not paintable */ }
  }
}
map.on("load", () => {
  styleBasemapIOS();
  loadAllStops();
  // Show the blue "you are here" dot from the start and default the origin to it.
  forceOriginToMe = true;
  setTimeout(() => { try { geolocate.trigger(); } catch (e) { /* ignore */ } }, 300);
});

/* ---------------- Tappable stops & "Directions" ---------------- */
let stopPopup = null;

function setDestinationFromMap(name, lat, lon) {
  const place = { lat, lon, short: name, label: name };
  choosePlace("dest", place);
  els.destInput.value = name;
  if (stopPopup) { stopPopup.remove(); stopPopup = null; }
  toast(`Destination set: ${name}`);
}

function showPlacePopup(lngLat, name, lat, lon, glyph) {
  if (stopPopup) stopPopup.remove();
  const icon = glyph ? `<span class="msym map-pop-ic" style="font-size:18px">${glyph}</span>` : "";
  const html =
    `<div class="map-pop">` +
    `<div class="map-pop-name">${icon}${escapeHtml(name)}</div>` +
    `<button class="map-pop-btn" type="button"><span class="msym" style="font-size:18px">directions</span>Directions</button>` +
    `</div>`;
  stopPopup = new maplibregl.Popup({ closeButton: true, offset: 14, className: "stop-popup", maxWidth: "260px" })
    .setLngLat(lngLat).setHTML(html).addTo(map);
  const btn = stopPopup.getElement().querySelector(".map-pop-btn");
  if (btn) btn.addEventListener("click", () => setDestinationFromMap(name, lat, lon));
  return stopPopup;
}

async function reverseName(lat, lon) {
  try {
    const res = await fetch(`${PHOTON.replace("/api/", "/reverse")}?lat=${lat}&lon=${lon}`);
    const j = await res.json();
    const p = j.features && j.features[0] && j.features[0].properties;
    if (p) return photonLabels(p).short;
  } catch (e) { /* ignore */ }
  return "Dropped pin";
}

// Load every transit stop once and show them as dots at closer zoom.
const STOPS_QUERY = `{ stops { name lat lon vehicleMode } }`;

// Mode -> Material Symbol glyph + colour for the map stop icons.
const STOP_ICONS = {
  bus:     { glyph: "directions_bus",  color: "#0078d4" },
  tram:    { glyph: "tram",            color: "#107c10" },
  rail:    { glyph: "train",           color: "#0ea5e9" },
  ferry:   { glyph: "directions_boat", color: "#038387" },
  generic: { glyph: "place",           color: "#6e7682" },
};
function normMode(m) {
  switch (m) {
    case "BUS": case "TROLLEYBUS": case "COACH": return "bus";
    case "TRAM": return "tram";
    case "RAIL": case "SUBWAY": case "MONORAIL": return "rail";
    case "FERRY": return "ferry";
    default: return "generic";
  }
}

// Draw a Google-Maps-style pin: colored circle + white mode glyph, as a map image.
function makeStopIcon(glyph, color) {
  const dpr = 2, size = 30, r = 12, cx = size / 2, cy = size / 2;
  const c = document.createElement("canvas");
  c.width = size * dpr; c.height = size * dpr;
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = '16px "Material Symbols Rounded"';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(glyph, cx, cy + 1);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function registerStopImages() {
  try { await document.fonts.load('16px "Material Symbols Rounded"'); await document.fonts.ready; } catch (e) { /* ignore */ }
  for (const [key, def] of Object.entries(STOP_ICONS)) {
    const id = `stop-${key}`;
    if (!map.hasImage(id)) map.addImage(id, makeStopIcon(def.glyph, def.color), { pixelRatio: 2 });
  }
}

async function loadAllStops() {
  try {
    await registerStopImages();
    const res = await fetch(OTP_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: STOPS_QUERY }),
    });
    const json = await res.json();
    const stops = (json.data && json.data.stops) || [];
    const feats = stops
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => ({ type: "Feature",
        properties: { name: s.name || "Stop", mode: normMode(s.vehicleMode) },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] } }));
    if (map.getSource("all-stops")) {
      map.getSource("all-stops").setData({ type: "FeatureCollection", features: feats });
      return;
    }
    map.addSource("all-stops", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
    map.addLayer({
      id: "all-stops", type: "symbol", source: "all-stops", minzoom: 13,
      layout: {
        "icon-image": ["concat", "stop-", ["get", "mode"]],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.45, 16, 0.85],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.55, 14.5, 1],
      },
    });
  } catch (e) { console.warn("Could not load stops:", e); }
}

// Tap a stop (along a route or any nearby stop) to get a Directions popup.
["all-stops", "route-stops", "route-stops-major"].forEach((id) => {
  map.on("click", id, (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    e.preventDefault();
    const [lon, lat] = f.geometry.coordinates;
    const mode = f.properties.mode;
    const glyph = mode && STOP_ICONS[mode] ? STOP_ICONS[mode].glyph : undefined;
    showPlacePopup(f.geometry.coordinates, f.properties.name || "Stop", lat, lon, glyph);
  });
  map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
});

// Tap anywhere else on the map to drop a pin and set a destination.
map.on("click", (e) => {
  if (nav.active) return;
  const ids = ["all-stops", "route-stops", "route-stops-major"].filter((id) => map.getLayer(id));
  if (ids.length && map.queryRenderedFeatures(e.point, { layers: ids }).length) return;
  const { lng, lat } = e.lngLat;
  showPlacePopup([lng, lat], "Dropped pin", lat, lng);
  reverseName(lat, lng).then((n) => {
    if (!stopPopup) return;
    const el = stopPopup.getElement().querySelector(".map-pop-name");
    if (el) el.textContent = n;
    const btn = stopPopup.getElement().querySelector(".map-pop-btn");
    if (btn) { const clone = btn.cloneNode(true); btn.replaceWith(clone); clone.addEventListener("click", () => setDestinationFromMap(n, lat, lng)); }
  });
});

let originMarker = null;
let destMarker = null;

function makeMarker(which) {
  const el = document.createElement("div");
  el.className = "map-pin map-pin-" + which;
  el.innerHTML = '<span class="map-pin-core"></span>';
  return new maplibregl.Marker({ element: el, anchor: "center" });
}

function setMarker(which, pt) {
  // The blue geolocate dot represents "your location", so don't also draw a green origin pin.
  if (which === "origin" && state.origin && state.origin.current) {
    if (originMarker) { originMarker.remove(); originMarker = null; }
    return;
  }
  let m = which === "origin" ? originMarker : destMarker;
  if (!m) { m = makeMarker(which); if (which === "origin") originMarker = m; else destMarker = m; }
  m.setLngLat([pt.lon, pt.lat]).addTo(map);
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
}

/* ---------------- Geocoding ---------------- */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Where to bias suggestions: the user's location if known, else the map centre.
function biasPoint() {
  if (state.origin && state.origin.current) return [state.origin.lon, state.origin.lat];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// Build a short title + a secondary address line from a Photon feature.
function photonLabels(p) {
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street;
  const short = p.name || street || p.city || p.suburb || p.county || "Unknown";
  const rest = [];
  if (short !== street && street) rest.push(street);
  for (const k of ["suburb", "district", "city", "county", "postcode"]) {
    const v = p[k];
    if (v && !rest.includes(v) && v !== short) rest.push(v);
  }
  return { short, label: [short, ...rest].join(", ") };
}

async function geocodePhoton(query) {
  const [lon, lat] = biasPoint();
  // No hard bounding box — results are biased toward the user/map, not limited to it.
  const url = `${PHOTON}?q=${encodeURIComponent(query)}&limit=8&lang=en&lat=${lat}&lon=${lon}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("photon failed");
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const f of data.features || []) {
    const { short, label } = photonLabels(f.properties || {});
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], short, label });
  }
  return out;
}

async function geocodeNominatim(query) {
  // Soft bias toward Dublin via viewbox, but not bounded — results can be anywhere.
  const url = `${NOMINATIM}?format=jsonv2&limit=8&viewbox=${DUBLIN_VIEWBOX}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!res.ok) throw new Error("geocode failed");
  const data = await res.json();
  return data.map((d) => ({
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    label: d.display_name,
    short: d.name || d.display_name.split(",")[0],
  }));
}

// Primary geocoder is Photon (great for type-ahead); fall back to Nominatim.
async function geocode(query) {
  try {
    const r = await geocodePhoton(query);
    if (r.length) return r;
  } catch (e) { console.warn("Photon failed, falling back:", e); }
  return geocodeNominatim(query);
}

function wireSuggest(input, sugEl, which) {
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { sugEl.hidden = true; return; }
    try {
      const results = await geocode(q);
      sugEl.innerHTML = "";
      if (!results.length) { sugEl.hidden = true; return; }
      for (const r of results) {
        const li = document.createElement("li");
        const rest = r.label.replace(r.short, "").replace(/^,\s*/, "");
        li.innerHTML = `${escapeHtml(r.short)}${rest ? `<small>${escapeHtml(rest)}</small>` : ""}`;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choosePlace(which, r);
          input.value = r.short;
          sugEl.hidden = true;
        });
        sugEl.appendChild(li);
      }
      sugEl.hidden = false;
    } catch (err) {
      console.warn(err);
    }
  }, 220);
  input.addEventListener("input", run);
  input.addEventListener("blur", () => setTimeout(() => (sugEl.hidden = true), 150));
}

// Show the "Work" shortcut at the top of the To suggestions when it's focused & empty.
function showQuickDest() {
  if (els.destInput.value.trim()) return;
  els.destSug.innerHTML = "";
  const li = document.createElement("li");
  li.className = "quick";
  li.innerHTML =
    `<span class="quick-ic"><span class="msym">work</span></span>` +
    `<span class="quick-text">Work<small>One Microsoft Place</small></span>`;
  li.addEventListener("mousedown", (e) => {
    e.preventDefault();
    choosePlace("dest", { ...WORK_PLACE });
    els.destInput.value = "Work";
    els.destSug.hidden = true;
    onPlan();
  });
  els.destSug.appendChild(li);
  els.destSug.hidden = false;
}

function choosePlace(which, place) {
  state[which] = place;
  setMarker(which, place);
  if (which === "origin") updateLocBtn();
  if (state.origin && state.dest) fitToPoints();
}

// The "use my location" button is always available, in every scenario.
function updateLocBtn() {
  if (!els.useLocationBtn) return;
  els.useLocationBtn.classList.remove("loc-hidden");
}

function fitToPoints() {
  if (!state.origin || !state.dest) return;
  const b = new maplibregl.LngLatBounds(
    [state.origin.lon, state.origin.lat],
    [state.origin.lon, state.origin.lat]
  );
  b.extend([state.dest.lon, state.dest.lat]);
  map.fitBounds(b, { padding: { top: 220, bottom: 320, left: 60, right: 60 }, maxZoom: 15 });
}

/* ---------------- OTP query ---------------- */
const CONNECTOR_AGENCY_ID = "msconn:MSCONN"; // banned to compute the public-only option

const PLAN_QUERY = `
query Plan($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!, $arriveBy: Boolean!, $banned: InputBanned) {
  plan(
    from: $from, to: $to, date: $date, time: $time,
    arriveBy: $arriveBy, numItineraries: 6, banned: $banned,
    transportModes: [{mode: WALK}, {mode: TRANSIT}]
  ) {
    itineraries {
      startTime endTime duration walkDistance
      legs {
        mode duration distance startTime endTime
        legGeometry { points }
        trip { tripHeadsign }
        route { shortName longName color
          agency { name gtfsId } }
        from { name lat lon } to { name lat lon }
        intermediateStops { name lat lon }
        steps { distance relativeDirection absoluteDirection streetName lat lon }
      }
    }
  }
}`;

async function planTrip(from, to, dateStr, timeStr, arriveBy, banned = null) {
  const res = await fetch(OTP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: PLAN_QUERY,
      variables: {
        from: { lat: from.lat, lon: from.lon },
        to: { lat: to.lat, lon: to.lon },
        date: dateStr, time: timeStr, arriveBy, banned,
      },
    }),
  });
  if (!res.ok) throw new Error(`OTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.plan.itineraries || [];
}

/* Best (shortest-duration) itinerary from a list. */
function bestItinerary(list) {
  if (!list || !list.length) return null;
  return list.reduce((a, b) => (b.duration < a.duration ? b : a));
}

/* ---------------- Leg helpers ---------------- */
function isConnector(leg) {
  const id = leg.route?.agency?.gtfsId || "";
  return id.startsWith(CONNECTOR_FEED + ":");
}
function legStyle(leg) {
  if (isConnector(leg)) return MODE_STYLE.CONNECTOR;
  return MODE_STYLE[leg.mode] || MODE_STYLE.BUS;
}
function legLineName(leg) {
  const r = leg.route || {};
  return r.shortName || r.longName || legStyle(leg).label;
}
function itinHasConnector(it) { return it.legs.some(isConnector); }

/* ---------------- Polyline decode (Google encoded polyline) ---------------- */
function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 1; shift = 0;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/* ---------------- Map: draw selected itinerary ---------------- */
function clearRouteLayers() {
  ["route-line-casing", "route-line", "route-line-walk", "route-stops", "route-stops-major"].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource("route")) map.removeSource("route");
  if (map.getSource("stops")) map.removeSource("stops");
}

// Collect transit stops along the itinerary: boarding/alighting (major) + intermediate.
function stopFeatures(it) {
  const feats = [];
  const seen = new Set();
  const add = (name, lat, lon, color, major) => {
    if (lat == null || lon == null) return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    feats.push({
      type: "Feature",
      properties: { name: name || "Stop", color, major: major ? 1 : 0 },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  };
  for (const l of it.legs) {
    if (l.mode === "WALK") continue;
    const color = legStyle(l).color;
    (l.intermediateStops || []).forEach((s) => add(s.name, s.lat, s.lon, color, false));
    if (l.from) add(l.from.name, l.from.lat, l.from.lon, color, true);
    if (l.to) add(l.to.name, l.to.lat, l.to.lon, color, true);
  }
  return feats;
}

function drawItinerary(it) {
  clearRouteLayers();
  const features = it.legs
    .filter((l) => l.legGeometry?.points)
    .map((l) => ({
      type: "Feature",
      properties: { color: legStyle(l).color, walk: l.mode === "WALK" },
      geometry: { type: "LineString", coordinates: decodePolyline(l.legGeometry.points) },
    }));
  if (!features.length) return;
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: "route-line-casing", type: "line", source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.95 },
  });
  // Transit legs: solid colored line.
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    filter: ["!", ["get", "walk"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 5.5 },
  });
  // Walk legs: dashed line (line-dasharray must be a constant, not a data expression).
  map.addLayer({
    id: "route-line-walk", type: "line", source: "route",
    filter: ["get", "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 4, "line-dasharray": [1.5, 1.5] },
  });

  // Transit stops along the route.
  const stops = stopFeatures(it);
  if (stops.length) {
    map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: stops } });
    // Intermediate stops: small dots.
    map.addLayer({
      id: "route-stops", type: "circle", source: "stops",
      filter: ["==", ["get", "major"], 0],
      paint: {
        "circle-radius": 4,
        "circle-color": "#ffffff",
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2,
      },
    });
    // Board/alight stops: larger, with a label.
    map.addLayer({
      id: "route-stops-major", type: "circle", source: "stops",
      filter: ["==", ["get", "major"], 1],
      paint: {
        "circle-radius": 6.5,
        "circle-color": "#ffffff",
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 3,
      },
    });
  }

  // fit to the route
  const all = features.flatMap((f) => f.geometry.coordinates);
  const b = new maplibregl.LngLatBounds(all[0], all[0]);
  all.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: { top: 220, bottom: 300, left: 50, right: 50 }, maxZoom: 16 });
}

/* ---------------- Render results ---------------- */
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderResults() {
  const list = state.itineraries;
  els.emptyState.hidden = true;
  els.resultsHead.hidden = false;

  const best = list.length ? Math.min(...list.map((i) => i.duration)) : 0;
  const c = state.comparison;
  els.resultsTitle.textContent =
    `${list.length} route${list.length === 1 ? "" : "s"}` +
    (c && c.connectorWins ? " · Connector is faster" : "");

  els.resultsBody.innerHTML = "";
  if (c) els.resultsBody.innerHTML = comparisonBanner(c);
  list.forEach((it, idx) => {
    const card = document.createElement("div");
    card.className = "itin" + (idx === state.selected ? " selected" : "") +
      (itinHasConnector(it) ? " has-connector" : "");

    const fastest = it.duration === best;
    card.innerHTML = `
      <div class="itin-top">
        <span class="itin-time">${fmtTime(it.startTime)} → ${fmtTime(it.endTime)}</span>
        <span class="itin-dur"><b>${fmtDur(it.duration)}</b>${fastest ? " · fastest" : ""}</span>
      </div>
      ${badgeRow(it)}
      <div class="legs">${legChips(it)}</div>
      ${state.origin && state.origin.current ? `<button class="start-btn" type="button">${svgIcon("play", 15)}Start journey</button>` : ""}
      <div class="steps">${stepList(it)}</div>`;

    card.addEventListener("click", () => {
      state.selected = idx;
      renderResults();
      drawItinerary(it);
    });
    card.querySelector(".start-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selected = idx;
      startNavigation(it);
    });
    els.resultsBody.appendChild(card);
  });

  openSheet();
  if (list.length) drawItinerary(list[state.selected]);
}

function badgeRow(it) {
  const badges = [];
  if (itinHasConnector(it)) {
    badges.push(`<span class="badge">${svgIcon("connector", 14)} Microsoft Connector · free</span>`);
    const c = state.comparison;
    // Show the saving badge only on the winning Connector card, using the real delta.
    if (c && c.connectorWins && it === c.withBest && c.savesMinutes > 0) {
      const money = c.publicFare > 0 ? ` · €${c.publicFare.toFixed(2)}` : "";
      badges.push(`<span class="badge save">Saves ${c.savesMinutes} min${money}</span>`);
    }
  }
  if (!badges.length) return "";
  return `<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">${badges.join("")}</div>`;
}

/* Adult Leap (smart-card) single fares by OTP mode, € — approximate TFI 2026 fares.
   OTP's own fare output is unreliable for TFI, so we price legs ourselves. */
const LEAP_FARE_BY_MODE = {
  BUS: 2.0,     // Dublin Bus / Go-Ahead flat Leap fare
  TRAM: 2.1,    // Luas (short hop; longer trips cost more but this is a fair demo floor)
  RAIL: 2.5,    // DART / commuter rail, short Dublin hop
  SUBWAY: 2.5,
  FERRY: 3.0,
};
const TFI_DAILY_CAP = 8.0; // TFI Leap daily fare cap, €

/* Estimated Leap fare a staff member would pay for a *public-only* itinerary.
   Sums one fare per public (non-walk) leg, capped at the TFI daily cap. */
function estimateLeapFare(itin) {
  if (!itin) return 0;
  let total = 0;
  for (const leg of itin.legs) {
    if (leg.mode === "WALK") continue;
    if (isConnector(leg)) continue; // Connector is free to staff
    total += LEAP_FARE_BY_MODE[leg.mode] ?? 2.0;
  }
  return Math.min(total, TFI_DAILY_CAP);
}

/* Compare the best itinerary WITH the Connector available against the best
   itinerary with the Connector banned (public-only). Returns the real delta. */
function computeComparison(withList, withoutList) {
  const withBest = bestItinerary(withList);
  const withoutBest = bestItinerary(withoutList);

  // Does the Connector-available best actually use the Connector? If the public
  // option is already as good, OTP may return a non-Connector trip as "best".
  const usesConnector = withBest ? itinHasConnector(withBest) : false;

  const c = {
    withBest, withoutBest, usesConnector,
    savesMinutes: 0,
    publicFare: estimateLeapFare(withoutBest),
    connectorWins: false,
    publicOnly: !usesConnector,        // best trip doesn't need the shuttle
    noPublicAlternative: !withoutBest,  // shuttle is the only way we found
  };

  if (withBest && withoutBest) {
    c.savesMinutes = Math.round((withoutBest.duration - withBest.duration) / 60);
  }
  // The Connector "wins" only if it's actually used AND saves real time
  // (or is the only option that exists).
  c.connectorWins = usesConnector && (c.savesMinutes > 0 || c.noPublicAlternative);
  return c;
}

function comparisonBanner(c) {
  // Connector genuinely beats public transport.
  if (c.connectorWins && !c.noPublicAlternative) {
    const mins = c.savesMinutes;
    const money = c.publicFare > 0 ? ` and €${c.publicFare.toFixed(2)}` : "";
    return `
      <div class="compare win">
        <div class="compare-icon">${svgIcon("connector", 20)}</div>
        <div class="compare-text">
          <strong>Connector saves you ${mins} min${money}</strong>
          <span>vs the best public-transport route (${fmtDur(c.withoutBest.duration)}, free vs €${c.publicFare.toFixed(2)})</span>
        </div>
      </div>`;
  }
  // Connector is the only way we found there.
  if (c.connectorWins && c.noPublicAlternative) {
    return `
      <div class="compare win">
        <div class="compare-icon">${svgIcon("connector", 20)}</div>
        <div class="compare-text">
          <strong>Only the Connector gets you there</strong>
          <span>no comparable public-transport route was found — and it's free to staff</span>
        </div>
      </div>`;
  }
  // Public transport is as good or better — say so honestly.
  if (c.withBest) {
    const tie = c.withoutBest && c.savesMinutes <= 0;
    return `
      <div class="compare neutral">
        <div class="compare-icon">${svgIcon("bus", 20)}</div>
        <div class="compare-text">
          <strong>Public transport wins this trip</strong>
          <span>${tie ? "the Connector doesn't save time here" : "no faster Connector option for these points/time"} · best is ${fmtDur(c.withBest.duration)}${c.publicFare > 0 ? `, €${c.publicFare.toFixed(2)} on Leap` : ""}</span>
        </div>
      </div>`;
  }
  return "";
}

function legChips(it) {
  const parts = [];
  it.legs.forEach((leg, i) => {
    const st = legStyle(leg);
    const conn = isConnector(leg);
    const walk = leg.mode === "WALK";
    const cls = "leg-chip" + (conn ? " connector" : "") + (walk ? " walk" : "");
    const label = walk ? `${Math.round(leg.duration / 60)}m` : legLineName(leg);
    parts.push(`<span class="${cls}"><span class="ic">${svgIcon(st.ic, 15)}</span>${escapeHtml(label)}</span>`);
    if (i < it.legs.length - 1) parts.push(`<span class="leg-arrow">›</span>`);
  });
  return parts.join("");
}

function stepList(it) {
  const rows = [];
  it.legs.forEach((leg, i) => {
    const st = legStyle(leg);
    const conn = isConnector(leg);
    const last = i === it.legs.length - 1;
    const cls = "step " + (conn ? "connector" : leg.mode === "WALK" ? "walk" : "transit");
    let main, sub;
    if (leg.mode === "WALK") {
      main = `Walk to ${escapeHtml(leg.to.name)}`;
      sub = `${Math.round(leg.duration / 60)} min · ${Math.round(leg.distance)} m`;
    } else {
      const pill = `<span class="step-pill" style="background:${st.color}22;color:${st.color}">${svgIcon(st.ic, 13)} ${escapeHtml(st.label)}</span>`;
      main = `${pill}${escapeHtml(legLineName(leg))}`;
      const head = leg.trip?.tripHeadsign ? ` → ${escapeHtml(leg.trip.tripHeadsign)}` : "";
      sub = `${fmtTime(leg.startTime)} ${escapeHtml(leg.from.name)}${head} · ${Math.round(leg.duration / 60)} min`;
    }
    rows.push(`
      <div class="${cls}">
        <div class="step-rail">
          <span class="step-node"></span>
          ${last ? "" : '<span class="step-line"></span>'}
        </div>
        <div class="step-body">
          <div class="step-main">${main}</div>
          <div class="step-sub">${sub}</div>
        </div>
      </div>`);
  });
  return rows.join("");
}

/* ---------------- Sheet ---------------- */
function openSheet() { els.sheet.classList.add("open"); }
function toggleSheet() { els.sheet.classList.toggle("open"); }

// Clear the current plan and return the app to its default empty state.
function clearPlan() {
  if (nav.active) stopNavigation();
  state.itineraries = [];
  state.comparison = null;
  state.selected = 0;
  clearRouteLayers();
  if (destMarker) { destMarker.remove(); destMarker = null; }
  state.dest = null;
  els.destInput.value = "";
  els.resultsHead.hidden = true;
  els.resultsBody.innerHTML =
    '<div class="empty-state" id="emptyState">' +
    `<div class="empty-icon">${svgIcon("map", 40)}</div>` +
    '<p>Plan a trip across the Microsoft Connector shuttle <em>and</em> Dublin public transport in one search.</p>' +
    '</div>';
  els.emptyState = $("emptyState");
  els.sheet.classList.remove("open");
  // Recenter on the origin (or Dublin) so the map isn't left zoomed on a stale route.
  if (state.origin) map.easeTo({ center: [state.origin.lon, state.origin.lat], zoom: 13, duration: 400 });
  else map.easeTo({ center: DUBLIN_CENTER, zoom: 11, duration: 400 });
}

// Drag the bottom sheet up/down with touch or mouse to expand/collapse it.
function setupSheetDrag() {
  const sheet = els.sheet;
  const grip = sheet.querySelector(".sheet-grip");
  const handle = sheet.querySelector(".results-head") || grip;
  let startY = 0, startOpen = false, dragging = false, moved = 0, height = 0;

  const onDown = (e) => {
    dragging = true;
    moved = 0;
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    startOpen = sheet.classList.contains("open");
    height = sheet.getBoundingClientRect().height;
    sheet.style.transition = "none";
    if (grip) grip.style.cursor = "grabbing";
  };
  const onMove = (e) => {
    if (!dragging) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    moved = y - startY;
    // base offset for current state, then follow the finger (clamped)
    const collapsed = Math.max(0, height - 86);
    let offset = (startOpen ? 0 : collapsed) + moved;
    offset = Math.min(collapsed, Math.max(0, offset));
    sheet.style.transform = `translateY(${offset}px)`;
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (grip) grip.style.cursor = "";
    // Decide final state. Treat a tiny move as a tap (toggle).
    if (Math.abs(moved) < 6) {
      toggleSheet();
    } else if (moved > 40) {
      sheet.classList.remove("open");   // dragged down -> collapse
    } else if (moved < -40) {
      sheet.classList.add("open");      // dragged up -> expand
    } else {
      sheet.classList.toggle("open", startOpen); // snap back
    }
  };

  [grip, handle].forEach((el) => {
    if (!el) return;
    el.style.touchAction = "none";
    el.addEventListener("touchstart", onDown, { passive: true });
    el.addEventListener("mousedown", onDown);
  });
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchend", onUp);
  window.addEventListener("mouseup", onUp);
}

/* ---------------- Live navigation ---------------- */
const nav = { active: false, steps: [], idx: 0, watchId: null, last: null, follow: true, itin: null, legEnds: [], remainSecs: null };
let puckMarker = null;

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearingBetween(aLat, aLon, bLat, bLon) {
  const toRad = (x) => (x * Math.PI) / 180, toDeg = (x) => (x * 180) / Math.PI;
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function relText(dir) {
  const m = {
    DEPART: "Set off", CONTINUE: "Continue", LEFT: "Turn left", RIGHT: "Turn right",
    SLIGHTLY_LEFT: "Slight left", SLIGHTLY_RIGHT: "Slight right",
    HARD_LEFT: "Sharp left", HARD_RIGHT: "Sharp right",
    UTURN_LEFT: "Make a U-turn", UTURN_RIGHT: "Make a U-turn",
    CIRCLE_CLOCKWISE: "Take the roundabout", CIRCLE_COUNTERCLOCKWISE: "Take the roundabout",
    ELEVATOR: "Take the elevator",
  };
  return m[dir] || "Continue";
}
function dirIcon(dir) {
  if (!dir) return "arrow-up";
  if (dir.includes("UTURN")) return "uturn";
  if (dir.includes("LEFT")) return "turn-left";
  if (dir.includes("RIGHT")) return "turn-right";
  return "arrow-up";
}
function walkStepText(s) {
  const street = s.streetName && s.streetName.toLowerCase() !== "path" && s.streetName.toLowerCase() !== "road"
    ? ` onto ${s.streetName}` : "";
  return `${relText(s.relativeDirection)}${street}`;
}

/* Flatten an itinerary into a list of navigable maneuvers. */
function buildNavSteps(it) {
  const out = [];
  it.legs.forEach((leg, li) => {
    const st = legStyle(leg);
    if (leg.mode === "WALK") {
      const steps = leg.steps || [];
      if (steps.length) {
        steps.forEach((s) => out.push({
          lat: s.lat, lon: s.lon, icon: dirIcon(s.relativeDirection),
          text: walkStepText(s), sub: `${Math.round(s.distance)} m`, legIndex: li,
        }));
      } else if (leg.legGeometry?.points) {
        const c = decodePolyline(leg.legGeometry.points);
        const end = c[c.length - 1];
        out.push({ lat: end[1], lon: end[0], icon: "walk",
          text: `Walk to ${leg.to.name}`, sub: `${Math.round(leg.distance)} m`, legIndex: li });
      }
    } else if (leg.legGeometry?.points) {
      const c = decodePolyline(leg.legGeometry.points);
      const board = c[0], alight = c[c.length - 1];
      out.push({ lat: board[1], lon: board[0], icon: st.ic,
        text: `Board ${legLineName(leg)}`, sub: `at ${leg.from.name}`, legIndex: li });
      out.push({ lat: alight[1], lon: alight[0], icon: st.ic,
        text: `Ride to ${leg.to.name}`, sub: `${Math.round(leg.duration / 60)} min`, legIndex: li });
    }
  });
  // Final arrival marker
  const lastLeg = it.legs[it.legs.length - 1];
  if (lastLeg?.legGeometry?.points) {
    const c = decodePolyline(lastLeg.legGeometry.points);
    const end = c[c.length - 1];
    out.push({ lat: end[1], lon: end[0], icon: "flag",
      text: `Arrive at ${lastLeg.to.name}`, sub: "Destination", legIndex: it.legs.length - 1 });
  }
  return out;
}

// End coordinate [lat,lon] of each leg, for walk-distance estimation.
function buildLegEnds(it) {
  return it.legs.map((l) => {
    if (!l.legGeometry?.points) return null;
    const c = decodePolyline(l.legGeometry.points);
    const e = c[c.length - 1];
    return [e[1], e[0]];
  });
}

const WALK_SPEED_MPS = 1.35; // ~4.9 km/h

// Estimate seconds remaining to the destination: live walk distance for the
// current walking leg, scheduled times for transit, plus all later legs.
function navRemainingSeconds(lat, lon) {
  if (!nav.itin) return null;
  const legs = nav.itin.legs;
  const cur = nav.steps[nav.idx];
  if (!cur) return null;
  const li = cur.legIndex;
  let secs = 0;
  const curLeg = legs[li];
  if (curLeg) {
    if (curLeg.mode === "WALK") {
      const end = nav.legEnds[li];
      const d = end ? haversine(lat, lon, end[0], end[1]) : (curLeg.distance || 0);
      secs += d / WALK_SPEED_MPS;
    } else {
      // Transit: time until this leg's scheduled arrival.
      secs += Math.max(0, (curLeg.endTime - Date.now()) / 1000);
    }
  }
  for (let j = li + 1; j < legs.length; j++) secs += legs[j].duration || 0;
  return secs;
}

function fmtRemain(secs) {
  const m = Math.round(secs / 60);
  if (m < 1) return "Arriving";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function makePuck() {
  const el = document.createElement("div");
  el.className = "user-puck";
  el.innerHTML = '<div class="user-puck-cone"></div><div class="user-puck-dot"></div>';
  return new maplibregl.Marker({ element: el, rotationAlignment: "map" });
}

function startNavigation(it) {
  if (!navigator.geolocation) { toast("Location not available."); return; }
  const steps = buildNavSteps(it);
  if (!steps.length) { toast("No navigable steps for this route."); return; }
  nav.active = true; nav.steps = steps; nav.idx = 0; nav.last = null; nav.follow = true;
  nav.itin = it;
  nav.legEnds = buildLegEnds(it);
  nav.remainSecs = it.duration;
  document.body.classList.add("navigating");
  els.navOverlay.hidden = false;
  els.sheet.classList.remove("open");
  drawItinerary(it);
  updateNavBanner();
  if (!puckMarker) puckMarker = makePuck();

  // Center on the trip's first maneuver right away so the tilted view is useful
  // before GPS arrives…
  const first = nav.steps[0];
  if (first) map.easeTo({ center: [first.lon, first.lat], zoom: 17, pitch: 55, duration: 600 });
  // …then grab a quick one-shot fix to snap to the user, plus a live watch.
  navigator.geolocation.getCurrentPosition(onNavPosition, () => {}, {
    enableHighAccuracy: true, timeout: 8000, maximumAge: 5000,
  });
  nav.watchId = navigator.geolocation.watchPosition(
    onNavPosition,
    () => toast("Lost GPS signal."),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 }
  );
}

function stopNavigation() {
  nav.active = false;
  if (nav.watchId != null) { navigator.geolocation.clearWatch(nav.watchId); nav.watchId = null; }
  document.body.classList.remove("navigating");
  els.navOverlay.hidden = true;
  if (puckMarker) puckMarker.remove();
  // Restore the default planning view: bring back the sheet and re-fit the route.
  els.sheet.classList.add("open");
  map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
  const it = nav.itin || state.itineraries[state.selected];
  if (it) setTimeout(() => drawItinerary(it), 60);
}

function onNavPosition(pos) {
  if (!nav.active) return;
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  let bearing = pos.coords.heading;
  if (bearing == null || isNaN(bearing)) {
    bearing = nav.last ? bearingBetween(nav.last.lat, nav.last.lon, lat, lon) : (map.getBearing() || 0);
  }
  puckMarker.setLngLat([lon, lat]).setRotation(bearing).addTo(map);
  nav.last = { lat, lon };

  if (nav.follow) {
    map.easeTo({ center: [lon, lat], bearing, pitch: 55,
      zoom: Math.max(map.getZoom(), 16.5), duration: 500 });
  }

  const target = nav.steps[nav.idx];
  if (!target) return;
  const d = haversine(lat, lon, target.lat, target.lon);
  if (d < 25 && nav.idx < nav.steps.length - 1) {
    nav.idx++;
  }
  nav.remainSecs = navRemainingSeconds(lat, lon);
  updateNavBanner(d);
}

function updateNavBanner(distance) {
  const s = nav.steps[nav.idx];
  if (!s) return;
  els.navIcon.innerHTML = svgIcon(s.icon, 26);
  els.navInstruction.textContent = s.text;
  let sub = s.sub || "";
  if (distance != null && isFinite(distance)) {
    const dtxt = distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
    sub = sub ? `${dtxt} · ${sub}` : dtxt;
  }
  els.navSub.textContent = sub;
  if (nav.remainSecs != null && isFinite(nav.remainSecs)) {
    const eta = fmtTime(Date.now() + nav.remainSecs * 1000);
    els.navEtaMain.textContent = fmtRemain(nav.remainSecs);
    els.navProgress.textContent = `Arrive ${eta}`;
  } else {
    els.navEtaMain.textContent = "— min";
    els.navProgress.textContent = "Calculating…";
  }
}

/* ---------------- Plan action ---------------- */
async function onPlan() {
  if (!state.origin || !state.dest) {
    toast("Pick both a start and a destination.");
    return;
  }
  els.planBtn.classList.add("loading");
  els.emptyState.hidden = true;
  els.resultsHead.hidden = false;
  els.resultsTitle.textContent = "Searching…";
  els.resultsBody.innerHTML = '<div class="spinner"></div>';
  openSheet();

  const when = els.whenInput.value ? new Date(els.whenInput.value) : new Date();
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const arriveBy = els.timeMode.value === "arrive";

  try {
    // Headline feature: run the search twice — once normally (Connector available),
    // once with the Connector agency banned (public transport only) — then compare.
    const [withList, withoutList] = await Promise.all([
      planTrip(state.origin, state.dest, date, time, arriveBy, null),
      planTrip(state.origin, state.dest, date, time, arriveBy, { agencies: CONNECTOR_AGENCY_ID }),
    ]);

    state.comparison = computeComparison(withList, withoutList);
    // Sort journeys best -> worst: fastest, then earliest arrival, then fewest legs.
    withList.sort((a, b) =>
      (a.duration - b.duration) ||
      (a.endTime - b.endTime) ||
      (a.legs.length - b.legs.length));
    state.itineraries = withList;
    state.selected = 0;

    if (!withList.length) {
      state.comparison = null;
      els.resultsTitle.textContent = "No routes found";
      els.resultsBody.innerHTML =
        `<div class="empty-state"><div class="empty-icon">${svgIcon("noroute", 40)}</div><p>No itinerary for that time. Try another time or nearby points.</p></div>`;
    } else {
      // Select the Connector-winning itinerary by default so its map + badge show first.
      const winIdx = withList.indexOf(state.comparison.withBest);
      state.selected = winIdx >= 0 ? winIdx : 0;
      renderResults();
    }
  } catch (err) {
    console.error(err);
    els.resultsTitle.textContent = "Error";
    els.resultsBody.innerHTML =
      `<div class="empty-state"><div class="empty-icon">${svgIcon("alert", 40)}</div><p>${escapeHtml(err.message)}</p></div>`;
    toast("Could not reach the routing server.");
  } finally {
    els.planBtn.classList.remove("loading");
  }
}

/* ---------------- Misc ---------------- */
function pad(n) { return String(n).padStart(2, "0"); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function useMyLocation(silent = false) {
  if (!navigator.geolocation) { if (!silent) toast("Location not available."); return; }
  // Route through the native geolocate control so the blue location dot is shown.
  forceOriginToMe = true;
  try { geolocate.trigger(); } catch (e) { if (!silent) toast("Could not get your location."); }
}

function defaultWhen() {
  // default to next weekday 08:00 so demo trips hit Connector service hours
  const d = new Date();
  d.setSeconds(0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  els.whenInput.value = local.toISOString().slice(0, 16);
}

/* ---------------- Init ---------------- */
function init() {
  wireSuggest(els.originInput, els.originSug, "origin");
  wireSuggest(els.destInput, els.destSug, "dest");
  els.destInput.addEventListener("focus", showQuickDest);
  els.planBtn.addEventListener("click", onPlan);
  els.useLocationBtn.addEventListener("click", () => useMyLocation(false));
  els.swapBtn.addEventListener("click", () => {
    [state.origin, state.dest] = [state.dest, state.origin];
    [els.originInput.value, els.destInput.value] = [els.destInput.value, els.originInput.value];
    if (state.origin) setMarker("origin", state.origin);
    if (state.dest) setMarker("dest", state.dest);
    updateLocBtn();
  });
  document.querySelector(".sheet-grip").style.touchAction = "none";
  setupSheetDrag();
  defaultWhen();
  updateLocBtn();

  // Live navigation controls.
  els.navExit.addEventListener("click", stopNavigation);
  els.navRecenter.addEventListener("click", () => {
    nav.follow = true;
    if (nav.last) map.easeTo({ center: [nav.last.lon, nav.last.lat], zoom: 17, pitch: 55, duration: 400 });
  });
  // Clear the plan and return to the default empty state.
  els.clearPlanBtn.addEventListener("click", clearPlan);
  // If the user pans the map during navigation, stop auto-following until they re-center.
  map.on("dragstart", () => { if (nav.active) nav.follow = false; });

  // The origin defaults to your location via the geolocate control (triggered on map load).

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Debug hook: lets you set a trip from the console / tests without geocoding.
  window.__app = {
    setTrip(o, d) {
      choosePlace("origin", o); els.originInput.value = o.short || "Origin";
      choosePlace("dest", d); els.destInput.value = d.short || "Destination";
    },
    setWhen(iso) { els.whenInput.value = iso; },
    plan: onPlan,
    state,
  };
}
init();
