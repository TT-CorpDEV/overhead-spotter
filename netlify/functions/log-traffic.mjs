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
      events.push({ hex: a.hex, reg: a.r || "", type: a.t || "", cs: (a.flight || "").trim(), mil: ((a.dbFlags || 0) & 1) === 1, rare: RARE.has(a.t), emg, sq: a.squawk || "" });
    }
  }
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

async function notify(store, events) {
  if (!events.length) return;
  const p = await store.get("push", { type: "json" });
  if (!p || !p.keys || !p.subs) return;
  const ids = Object.keys(p.subs);
  if (!ids.length) return;
  webpush.setVapidDetails(process.env.URL || "https://example.com", p.keys.publicKey, p.keys.privateKey);
  let changed = false;
  for (const id of ids) {
    const s = p.subs[id];
    const watch = new Set((s.watch || []).map((w) => String(w).toLowerCase()));
    const watched = (ev) => watch.has(ev.hex) || (ev.reg && watch.has(ev.reg.toLowerCase()));
    const hits = events.filter((ev) => (s.emg && ev.emg) || watched(ev) || (s.mil && ev.mil) || (s.rare && ev.rare));
    if (!hits.length) continue;
    const label = (ev) => (ev.emg ? "Emergency " + ev.sq + ": " : watched(ev) ? "Watchlist: " : ev.mil ? "Military: " : "Rare: ") + (ev.cs || ev.reg || ev.hex.toUpperCase()) + (ev.type ? " (" + ev.type + ")" : "");
    const body = hits.slice(0, 3).map(label).join("\n") + (hits.length > 3 ? "\n+" + (hits.length - 3) + " more" : "");
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: "Overhead now", body, tag: "overhead-" + hits[0].hex }), { TTL: 600 });
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        delete p.subs[id];
        changed = true;
      } else console.log("push failed", err && err.statusCode);
    }
  }
  if (changed) await store.setJSON("push", p);
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
  console.log("logged", list.length, "aircraft;", Object.keys(db.ac).length, "known;", events.length, "events");
};

export const config = { schedule: "*/2 * * * *" };
