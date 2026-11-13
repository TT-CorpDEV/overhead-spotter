import { getStore } from "@netlify/blobs";
import webpush from "web-push";

// Runs every 2 minutes on Netlify. Keeps a running record of the aircraft seen
// over the watched area: visit counts, busiest hours, recent tracks, and alerts.
// Area format: "latitude,longitude,radius in nautical miles".
// Change it by setting an AREA environment variable in the Netlify project.
const AREA = (process.env.AREA || "45.52,-122.68,25").split(",").map(Number);
const TZ = process.env.AREA_TZ || "America/Los_Angeles";
const GAP = 30 * 60 * 1000; // a new visit starts after 30 quiet minutes
const KEEP_TRACK = 3 * 60 * 60 * 1000; // positions are kept for 3 hours
const EMERGENCY = new Set(["7500", "7600", "7700"]);
const RARE = new Set(["A388", "A124", "A225", "A3ST", "BLCF", "B744", "B748", "B742", "MD11", "DC10", "CONC", "C17", "C5M", "C130", "C30J", "K35R", "KC46", "B52", "B1", "B2", "E3TF", "E6", "P8", "U2", "F15", "F16", "F18", "F22", "F35", "A10", "V22", "H47", "H64", "GLF6", "GLEX", "GL7T"]);

// Fire season: air tankers, scoopers and fire helicopters, by type or by who operates them.
const FIRE_T = new Set(["DC10", "MD87", "B461", "B462", "B463", "RJ85", "L188", "P3", "CL2T", "CL41", "AT8T", "S64", "KMAX"]);
const FIRE_OWN = /10 TANKER|AERO AIR|NEPTUNE AVIATION|ERICKSON (INC|AERO|AIR)|COULSON|AERO-?FLITE|AIR SPRAY|CONAIR|FOREST SERVICE|FORESTRY|BUREAU OF LAND MANAGEMENT|DEPT OF NATURAL RESOURCES|DEPARTMENT OF NATURAL RESOURCES|CAL FIRE|FIRE PROTECTION|BRIDGER AEROSPACE/;

// "What's circling?": an aircraft that stays inside a small circle for several minutes while still moving.
const CIRC_WINDOW = 16 * 60 * 1000;
const CIRC_MIN_SPAN = 8 * 60 * 1000;
const CIRC_MAX_R = 2.5; // nautical miles from the middle of its recent track
const CIRC_REPEAT = 45 * 60 * 1000;
const R_NM = 3440.065;
const D = Math.PI / 180;
const nmBetween = (la1, lo1, la2, lo2) => {
  const a = Math.sin(((la2 - la1) * D) / 2) ** 2 + Math.cos(la1 * D) * Math.cos(la2 * D) * Math.sin(((lo2 - lo1) * D) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
};
const bearing = (la1, lo1, la2, lo2) => {
  const y = Math.sin((lo2 - lo1) * D) * Math.cos(la2 * D), x = Math.cos(la1 * D) * Math.sin(la2 * D) - Math.sin(la1 * D) * Math.cos(la2 * D) * Math.cos((lo2 - lo1) * D);
  return (Math.atan2(y, x) / D + 360) % 360;
};
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

const hourOf = (t) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(t)) % 24;
const dayOf = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(t);

async function readFeed(lat, lon, nm) {
  const urls = [
    "https://opendata.adsb.fi/api/v2/lat/" + lat + "/lon/" + lon + "/dist/" + nm,
    "https://api.adsb.lol/v2/point/" + lat + "/" + lon + "/" + nm,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "overhead-spotter-logger" } });
      if (!res.ok) continue;
      const j = await res.json();
      const list = j.aircraft || j.ac;
      if (list) return list;
    } catch (e) {}
  }
  return null;
}

// Folds one feed snapshot into the stored record. Returns the events worth alerting on.
function update(db, tracks, list, now) {
  db.ac = db.ac || {};
  db.hours = db.hours || new Array(24).fill(0);
  db.days = db.days || {};
  db.emg = db.emg || {};
  const h = hourOf(now);
  const d = dayOf(now);
  const day = (db.days[d] = db.days[d] || { v: 0, n: 0 });
  const events = [];
  for (const a of list) {
    if (!a.hex || !/^[0-9a-f]{6}$/.test(a.hex) || a.alt_baro === "ground") continue;
    if (typeof a.lat === "number" && typeof a.lon === "number") {
      (tracks[a.hex] = tracks[a.hex] || []).push([now, +a.lat.toFixed(4), +a.lon.toFixed(4), typeof a.alt_baro === "number" ? a.alt_baro : 0]);
    }
    let e = db.ac[a.hex];
    let fresh = false;
    if (!e) {
      e = db.ac[a.hex] = [now, now, 1];
      fresh = true;
      day.n++;
    } else if (now - e[1] > GAP) {
      e[2]++;
      fresh = true;
    }
    e[1] = now;
    e[3] = a.r || e[3] || "";
    e[4] = a.t || e[4] || "";
    e[5] = a.dbFlags || e[5] || 0;
    if (fresh) {
      db.hours[h]++;
      day.v++;
    }
    const emg = EMERGENCY.has(a.squawk) && now - (db.emg[a.hex] || 0) > GAP;
    if (emg) db.emg[a.hex] = now;
    if (fresh || emg) {
      events.push({ hex: a.hex, reg: a.r || "", type: a.t || "", cs: (a.flight || "").trim(), mil: ((a.dbFlags || 0) & 1) === 1, rare: RARE.has(a.t), fire: FIRE_T.has(a.t) || FIRE_OWN.test(String(a.ownOp || "").toUpperCase()), emg, sq: a.squawk || "" });
    }
  }
  db.circ = db.circ || {};
  const here = new Map(list.map((a) => [a.hex, a]));
  for (const [hex, pts] of Object.entries(tracks)) {
    const a = here.get(hex);
    if (!a || a.alt_baro === "ground" || (typeof a.alt_baro === "number" && a.alt_baro > 8000)) continue;
    const w = pts.filter((x) => now - x[0] <= CIRC_WINDOW);
    if (w.length < 5 || w[w.length - 1][0] - w[0][0] < CIRC_MIN_SPAN || now - w[w.length - 1][0] > 3 * 60 * 1000) continue;
    const cl = w.reduce((t, x) => t + x[1], 0) / w.length, cn = w.reduce((t, x) => t + x[2], 0) / w.length;
    let maxR = 0, path = 0;
    for (let i = 0; i < w.length; i++) {
      maxR = Math.max(maxR, nmBetween(cl, cn, w[i][1], w[i][2]));
      if (i) path += nmBetween(w[i - 1][1], w[i - 1][2], w[i][1], w[i][2]);
    }
    if (maxR > CIRC_MAX_R || path < 3 || path < 3 * Math.max(maxR, 0.3)) continue;
    if (now - (db.circ[hex] || 0) < CIRC_REPEAT) continue;
    db.circ[hex] = now;
    events.push({ hex, reg: a.r || "", type: a.t || "", cs: (a.flight || "").trim(), circ: true, lat: cl, lon: cn, mins: Math.round((w[w.length - 1][0] - w[0][0]) / 60000), mil: false, rare: false, fire: false, emg: false, sq: "" });
  }
  for (const k of Object.keys(db.circ)) if (now - db.circ[k] > 6 * 60 * 60 * 1000) delete db.circ[k];
  for (const k of Object.keys(tracks)) {
    const p = tracks[k].filter((x) => now - x[0] < KEEP_TRACK);
    if (p.length) tracks[k] = p;
    else delete tracks[k];
  }
  for (const k of Object.keys(db.emg)) if (now - db.emg[k] > 6 * GAP) delete db.emg[k];
  const days = Object.keys(db.days).sort();
  while (days.length > 120) delete db.days[days.shift()];
  const keys = Object.keys(db.ac);
  if (keys.length > 60000) {
    keys.sort((x, y) => db.ac[x][1] - db.ac[y][1]).slice(0, keys.length - 50000).forEach((k) => delete db.ac[k]);
  }
  db.runs = (db.runs || 0) + 1;
  db.last = now;
  return events;
}

// Airports from the app's own place list, so pattern work and training circuits don't count as circling.
let AIRPORTS = null;
async function nearAirport(lat, lon) {
  if (!AIRPORTS) {
    try {
      const r = await fetch((process.env.URL || "https://spotter.ttcorp.ai") + "/places.json", { signal: AbortSignal.timeout(5000) });
      AIRPORTS = (await r.json()).filter((p) => "LMS".includes(p[2]));
    } catch (e) {
      AIRPORTS = [];
    }
  }
  return AIRPORTS.some((p) => nmBetween(lat, lon, p[3], p[4]) < 2);
}

// Registered owner names (public FAA data via adsbdb), cached for 30 days.
async function ownersFor(store, hexes) {
  const cache = (await store.get("owners", { type: "json" })) || {};
  const now = Date.now();
  const need = hexes.filter((h) => !cache[h] || now - cache[h][1] > 30 * 864e5).slice(0, 8);
  await Promise.all(
    need.map(async (h) => {
      try {
        const r = await fetch("https://api.adsbdb.com/v0/aircraft/" + h, { headers: { "user-agent": "overhead-spotter-logger" }, signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        const a = j && j.response && j.response.aircraft;
        cache[h] = [(a && a.registered_owner) || "", now];
      } catch (e) {}
    })
  );
  if (need.length) {
    for (const k of Object.keys(cache)) if (now - cache[k][1] > 60 * 864e5) delete cache[k];
    await store.setJSON("owners", cache);
  }
  return (h) => (cache[h] && cache[h][0]) || "";
}

async function notify(store, events) {
  if (!events.length) return;
  const p = await store.get("push", { type: "json" });
  if (!p || !p.keys || !p.subs) return;
  const ids = Object.keys(p.subs);
  if (!ids.length) return;
  // Drop circling events over airports before anyone is told.
  for (const ev of events) if (ev.circ && (await nearAirport(ev.lat, ev.lon))) ev.circ = false;
  const night = (() => { const h = hourOf(Date.now()); return h >= 22 || h < 7; })();
  const plan = [];
  for (const id of ids) {
    const s = p.subs[id];
    const watch = new Set((s.watch || []).map((w) => String(w).toLowerCase()));
    const watched = (ev) => watch.has(ev.hex) || (ev.reg && watch.has(ev.reg.toLowerCase()));
    const c = s.circ && s.circ.r ? s.circ : null;
    const home = c && typeof c.lat === "number" ? [c.lat, c.lon] : [AREA[0], AREA[1]];
    const circHit = (ev) => ev.circ && c && !(c.q && night) && nmBetween(home[0], home[1], ev.lat, ev.lon) * 1.1508 <= c.r;
    const hits = events.filter((ev) => (s.emg && ev.emg) || watched(ev) || circHit(ev) || (s.fire !== false && ev.fire) || (s.mil && ev.mil) || (s.rare && ev.rare));
    if (hits.length) plan.push({ id, s, hits, watched, circHit, home });
  }
  if (!plan.length) return;
  const owner = await ownersFor(store, [...new Set(plan.flatMap((x) => x.hits.map((ev) => ev.hex)))]);
  webpush.setVapidDetails(process.env.URL || "https://example.com", p.keys.publicKey, p.keys.privateKey);
  let changed = false;
  for (const { id, s, hits, watched, circHit, home } of plan) {
    const name = (ev) => (ev.cs || ev.reg || ev.hex.toUpperCase()) + (ev.type ? " (" + ev.type + ")" : "") + (owner(ev.hex) ? " · " + owner(ev.hex).slice(0, 40) : "");
    const where = (ev) => {
      const mi = nmBetween(home[0], home[1], ev.lat, ev.lon) * 1.1508;
      return (mi < 0.3 ? "overhead" : mi.toFixed(1) + " mi " + COMPASS[Math.round(bearing(home[0], home[1], ev.lat, ev.lon) / 45) % 8]) + " for " + ev.mins + " min";
    };
    const label = (ev) => (ev.emg ? "Emergency " + ev.sq + ": " : circHit(ev) ? "Circling " + where(ev) + ": " : watched(ev) ? "Watchlist: " : ev.fire ? "Fire aircraft: " : ev.mil ? "Military: " : "Rare: ") + name(ev);
    const body = hits.slice(0, 3).map(label).join("\n") + (hits.length > 3 ? "\n+" + (hits.length - 3) + " more" : "");
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: hits.some(circHit) && hits.length === 1 ? "What's circling?" : "Overhead now", body, tag: "overhead-" + hits[0].hex }), { TTL: 600 });
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        delete p.subs[id];
        changed = true;
      } else console.log("push failed", err && err.statusCode);
    }
  }
  if (changed) await store.setJSON("push", p);
}

// Pick-up mode: check each followed flight, alert when it reaches approach, landing and the gate.
const pickPhase = (a, apt) => {
  if (!a || a.lat == null) return null;
  const d = nmBetween(a.lat, a.lon, apt.lat, apt.lon), gnd = a.alt_baro === "ground", alt = gnd ? 0 : Number(a.alt_baro) || 0, gs = Number(a.gs) || 0;
  if ((gnd || alt < 150) && d < 4) return gs < 4 ? 4 : 3;
  if (d < 35 && alt < 12000) return 2;
  return 1;
};
async function pickups(store) {
  const p = await store.get("push", { type: "json" });
  if (!p || !p.subs || !p.keys) return;
  const now = Date.now(), want = new Set();
  for (const s of Object.values(p.subs)) if (s.pick && s.pick.ph < 4 && now - s.pick.t < 864e5) want.add(s.pick.cs);
  if (!want.size) return;
  const live = {};
  await Promise.all([...want].slice(0, 20).map(async (cs) => {
    try {
      const r = await fetch("https://opendata.adsb.fi/api/v2/callsign/" + cs, { headers: { "user-agent": "overhead-spotter-logger" }, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const j = await r.json(); live[cs] = (j.ac || j.aircraft || []).find((x) => x.lat != null) || null; }
    } catch (e) {}
  }));
  webpush.setVapidDetails(process.env.URL || "https://example.com", p.keys.publicKey, p.keys.privateKey);
  let changed = false;
  for (const [id, s] of Object.entries(p.subs)) {
    const k = s.pick;
    if (!k) continue;
    if (k.ph >= 4 || now - k.t > 864e5) { delete s.pick; changed = true; continue; }
    if (!(k.cs in live)) continue; // the feed did not answer: try again next run
    const a = live[k.cs];
    let ph = pickPhase(a, k);
    if (!a && k.ph >= 3) ph = 4; // transponder off after landing: parked
    if (!ph || ph <= k.ph) continue;
    k.ph = ph;
    changed = true;
    if (ph < 2) continue;
    let tail = "";
    if (ph === 2 && a && Number(a.gs) > 60) tail = ", about " + Math.round((nmBetween(a.lat, a.lon, k.lat, k.lon) / Number(a.gs)) * 60 + 3) + " min out";
    const body = k.cs + (ph === 2 ? " is on approach to " + k.code + tail : ph === 3 ? " landed at " + k.code + ". Taxiing in." : " is at the gate at " + k.code + ". Head to arrivals.");
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: "Pick-up", body, tag: "overhead-" + ((a && a.hex) || "pick") }), { TTL: 900 });
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) delete p.subs[id];
    }
  }
  if (changed) {
    // Merge into the latest copy so a subscription saved meanwhile is not lost.
    const cur = (await store.get("push", { type: "json" })) || p;
    for (const id of Object.keys(cur.subs || {})) {
      if (!p.subs[id]) delete cur.subs[id];
      else if (cur.subs[id].pick && p.subs[id].pick && cur.subs[id].pick.cs === p.subs[id].pick.cs) cur.subs[id].pick.ph = Math.max(cur.subs[id].pick.ph || 0, p.subs[id].pick.ph);
      else if (cur.subs[id].pick && !p.subs[id].pick && (cur.subs[id].pick.ph >= 4 || cur.subs[id].pick.t <= now - 864e5)) delete cur.subs[id].pick;
    }
    await store.setJSON("push", cur);
  }
}

export default async () => {
  const [lat, lon, nm] = AREA;
  const list = await readFeed(lat, lon, nm);
  if (!list) {
    console.log("no feed answered");
    return;
  }
  const store = getStore({ name: "traffic", consistency: "strong" });
  const now = Date.now();
  const [seen, tr] = await Promise.all([store.get("seen", { type: "json" }), store.get("tracks", { type: "json" })]);
  const db = seen || { since: now, ac: {} };
  const tracks = tr || {};
  const events = update(db, tracks, list, now);
  await Promise.all([store.setJSON("seen", db), store.setJSON("tracks", tracks)]);
  try {
    await notify(store, events);
  } catch (e) {
    console.log("notify error", String(e));
  }
  try {
    await pickups(store);
  } catch (e) {
    console.log("pickup error", String(e));
  }
  console.log("logged", list.length, "aircraft;", Object.keys(db.ac).length, "known;", events.length, "events");
};

export const config = { schedule: "*/2 * * * *" };
