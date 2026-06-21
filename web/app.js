"use strict";

/* ---------------- Config ---------------- */
const OTP_URL = `${location.protocol}//${location.hostname}:8080/otp/gtfs/v1`;
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const DUBLIN_CENTER = [-6.26, 53.345];
const DUBLIN_VIEWBOX = "-6.55,53.65,-6.00,53.17"; // left,top,right,bottom
const CONNECTOR_FEED = "msconn"; // gtfsId prefix that marks a Microsoft Connector leg

/* mode -> visual */
const MODE_STYLE = {
  WALK:    { ic: "🚶", color: "#93a0b5", label: "Walk" },
  BUS:     { ic: "🚌", color: "#3b82f6", label: "Bus" },
  TRAM:    { ic: "🚊", color: "#22c55e", label: "Luas" },
  RAIL:    { ic: "🚆", color: "#0ea5e9", label: "Rail" },
  SUBWAY:  { ic: "🚇", color: "#0ea5e9", label: "Rail" },
  FERRY:   { ic: "⛴", color: "#06b6d4", label: "Ferry" },
  CONNECTOR: { ic: "🟣", color: "#7c3aed", label: "Connector" },
};

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
  useLocationBtn: $("useLocationBtn"),
  planBtn: $("planBtn"),
  timeMode: $("timeMode"),
  whenInput: $("whenInput"),
  sheet: $("resultsSheet"),
  resultsHead: $("resultsHead"),
  resultsTitle: $("resultsTitle"),
  resultsBody: $("resultsBody"),
  emptyState: $("emptyState"),
  toast: $("toast"),
};

/* ---------------- Map ---------------- */
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: DUBLIN_CENTER,
  zoom: 11,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

let originMarker = null;
let destMarker = null;

function makeMarker(color) {
  const el = document.createElement("div");
  el.style.cssText =
    `width:16px;height:16px;border-radius:50%;background:${color};` +
    `border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.5);`;
  return new maplibregl.Marker({ element: el });
}

function setMarker(which, pt) {
  const color = which === "origin" ? "#22c55e" : "#ef4444";
  let m = which === "origin" ? originMarker : destMarker;
  if (!m) { m = makeMarker(color); if (which === "origin") originMarker = m; else destMarker = m; }
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

/* ---------------- Geocoding (Nominatim) ---------------- */
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function geocode(query) {
  const url = `${NOMINATIM}?format=jsonv2&limit=6&countrycodes=ie` +
    `&viewbox=${DUBLIN_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
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

function wireSuggest(input, sugEl, which) {
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) { sugEl.hidden = true; return; }
    try {
      const results = await geocode(q);
      sugEl.innerHTML = "";
      if (!results.length) { sugEl.hidden = true; return; }
      for (const r of results) {
        const li = document.createElement("li");
        const rest = r.label.replace(r.short, "").replace(/^,\s*/, "");
        li.innerHTML = `${escapeHtml(r.short)}<small>${escapeHtml(rest)}</small>`;
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
  }, 300);
  input.addEventListener("input", run);
  input.addEventListener("blur", () => setTimeout(() => (sugEl.hidden = true), 150));
}

function choosePlace(which, place) {
  state[which] = place;
  setMarker(which, place);
  if (state.origin && state.dest) fitToPoints();
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
        from { name } to { name }
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
  ["route-line-casing", "route-line", "route-line-walk"].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource("route")) map.removeSource("route");
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
    paint: { "line-color": "#0b1220", "line-width": 8, "line-opacity": 0.6 },
  });
  // Transit legs: solid colored line.
  map.addLayer({
    id: "route-line", type: "line", source: "route",
    filter: ["!", ["get", "walk"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 5 },
  });
  // Walk legs: dashed line (line-dasharray must be a constant, not a data expression).
  map.addLayer({
    id: "route-line-walk", type: "line", source: "route",
    filter: ["get", "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 4, "line-dasharray": [1.5, 1.5] },
  });
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
      <div class="steps">${stepList(it)}</div>`;

    card.addEventListener("click", () => {
      state.selected = idx;
      renderResults();
      drawItinerary(it);
    });
    els.resultsBody.appendChild(card);
  });

  openSheet();
  if (list.length) drawItinerary(list[state.selected]);
}

function badgeRow(it) {
  const badges = [];
  if (itinHasConnector(it)) {
    badges.push(`<span class="badge">🟣 Microsoft Connector · free</span>`);
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
        <div class="compare-icon">🟣</div>
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
        <div class="compare-icon">🟣</div>
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
        <div class="compare-icon">🚌</div>
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
    parts.push(`<span class="${cls}"><span class="ic">${st.ic}</span>${escapeHtml(label)}</span>`);
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
      const pill = `<span class="step-pill" style="background:${st.color}22;color:${st.color}">${st.ic} ${escapeHtml(st.label)}</span>`;
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
    state.itineraries = withList;
    state.selected = 0;

    if (!withList.length) {
      state.comparison = null;
      els.resultsTitle.textContent = "No routes found";
      els.resultsBody.innerHTML =
        '<div class="empty-state"><div class="empty-icon">🤷</div><p>No itinerary for that time. Try another time or nearby points.</p></div>';
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
      `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${escapeHtml(err.message)}</p></div>`;
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

function useMyLocation() {
  if (!navigator.geolocation) { toast("Location not available."); return; }
  toast("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const place = { lat: pos.coords.latitude, lon: pos.coords.longitude, short: "My location", label: "My location" };
      state.origin = place;
      els.originInput.value = "My location";
      setMarker("origin", place);
      map.flyTo({ center: [place.lon, place.lat], zoom: 14 });
    },
    () => toast("Could not get your location."),
    { enableHighAccuracy: true, timeout: 8000 }
  );
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
  els.planBtn.addEventListener("click", onPlan);
  els.useLocationBtn.addEventListener("click", useMyLocation);
  els.swapBtn.addEventListener("click", () => {
    [state.origin, state.dest] = [state.dest, state.origin];
    [els.originInput.value, els.destInput.value] = [els.destInput.value, els.originInput.value];
    if (state.origin) setMarker("origin", state.origin);
    if (state.dest) setMarker("dest", state.dest);
  });
  document.querySelector(".sheet-grip").addEventListener("click", toggleSheet);
  defaultWhen();

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
