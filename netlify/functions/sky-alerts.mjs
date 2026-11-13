import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import * as sat from "satellite.js";

// Runs every 10 minutes. Sends alerts a few minutes before something worth looking up at:
//   visible passes of the ISS and Tiangong, a fresh Starlink "train", objects about to reenter,
//   satellites people chose to watch, and evening or morning rocket launches from Vandenberg.
// Passes are worked out for the centre of the logger's area (AREA, default central Portland).
const AREA = (process.env.AREA || "45.52,-122.68,25").split(",").map(Number);
const TZ = process.env.AREA_TZ || "America/Los_Angeles";
const D = Math.PI / 180;
const LEAD_MIN = 4, LEAD_MAX = 16; // alert when a pass starts 4–16 minutes from now
const tfmt = (t) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(t);
const dir = (a) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(a / 45) % 8];

function sunEl(t, lat, lon) {
  const d = t / 864e5 - 0.5 + 2440588 - 2451545, e = D * 23.4397, phi = lat * D, th = D * (280.16 + 360.9856235 * d) + lon * D;
  const M = D * (357.5291 + 0.98560028 * d), L = M + D * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + D * 102.9372 + Math.PI;
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L)), de = Math.asin(Math.sin(e) * Math.sin(L)), H = th - ra;
  return Math.asin(Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(H)) / D;
}
function sunEci(t) {
  const d = t / 864e5 - 10957.5, L = (280.46 + 0.9856474 * d) * D, g = (357.528 + 0.9856003 * d) * D, l = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D, e = 23.439 * D;
  return [Math.cos(l), Math.sin(l) * Math.cos(e), Math.sin(l) * Math.sin(e)];
}
function sunlit(r, s) {
  const k = r.x * s[0] + r.y * s[1] + r.z * s[2];
  if (k > 0) return true;
  return Math.hypot(r.x - k * s[0], r.y - k * s[1], r.z - k * s[2]) > 6371;
}

// The next pass of one satellite that starts within the alert window, if it is high enough and visible.
export function upcomingPass(rec, now, lat, lon, minEl) {
  const gd = { longitude: lon * D, latitude: lat * D, height: 0.05 };
  let cur = null, ongoing = null;
  for (let t = now; t < now + (LEAD_MAX + 15) * 60000; t += 20000) {
    const d = new Date(t), pv = sat.propagate(rec, d);
    if (!pv || !pv.position) return null;
    const la = sat.ecfToLookAngles(gd, sat.eciToEcf(pv.position, sat.gstime(d)));
    const el = la.elevation / D, az = ((la.azimuth / D) + 360) % 360;
    if (ongoing === null) ongoing = el > 0; // already up when we start: skip that pass
    if (ongoing) { if (el <= 0) ongoing = false; continue; }
    if (el > 0) {
      if (!cur) cur = { start: t, az0: az, max: el, azMax: az, vis: false };
      if (el > cur.max) { cur.max = el; cur.azMax = az; }
      if (!cur.vis && sunlit(pv.position, sunEci(t)) && sunEl(t, lat, lon) < -6) cur.vis = true;
      cur.end = t; cur.az1 = az;
    } else if (cur) break;
  }
  if (!cur || cur.start < now + LEAD_MIN * 60000 || cur.start > now + LEAD_MAX * 60000) return null;
  return cur.max >= minEl && cur.vis ? cur : null;
}

async function tleText(q) {
  const r = await fetch("https://celestrak.org/NORAD/elements/gp.php?" + q + "&FORMAT=tle", { headers: { "user-agent": "OverheadSpotter/1.0 (+https://spotter.ttcorp.ai)" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("celestrak " + r.status);
  const L = (await r.text()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean), out = [];
  for (let i = 0; i + 2 < L.length; i += 3) out.push([L[i].replace(/\s*\(.*\)/, ""), L[i + 1], L[i + 2]]);
  return out;
}

// Orbits change slowly, so the catalog is refreshed every 8 hours and kept in Blobs.
async function catalog(store, want, now) {
  let c = (await store.get("sky-tle", { type: "json" })) || {};
  const stale = !c.t || now - c.t > 8 * 3600e3;
  const have = new Set((c.rows || []).map((r) => +r[1].slice(2, 7)));
  const missing = want.filter((n) => !have.has(n));
  if (!stale && !missing.length) return c.rows;
  const rows = [];
  const add = (list, grp) => { for (const r of list) if (!rows.some((x) => x[1].slice(2, 7) === r[1].slice(2, 7))) rows.push([...r, grp]); };
  try { add((await tleText("GROUP=stations")).filter((r) => /^(ISS|CSS)/.test(r[0])), "station"); } catch (e) { console.log(String(e)); }
  try {
    const sl = (await tleText("GROUP=last-30-days")).filter((r) => /^STARLINK/.test(r[0]));
    const newest = sl.map((r) => r[1].slice(9, 14)).sort().pop();
    add(sl.filter((r) => r[1].slice(9, 14) === newest).slice(0, 3), "starlink"); // a few from the train stand in for all of it
  } catch (e) { console.log(String(e)); }
  try { add((await tleText("SPECIAL=DECAYING")).slice(0, 15), "decay"); } catch (e) { console.log(String(e)); }
  for (const n of want.slice(0, 25)) {
    if (rows.some((r) => +r[1].slice(2, 7) === n)) continue;
    try { add(await tleText("CATNR=" + n), "watched"); } catch (e) {}
  }
  if (rows.length) { c = { t: now, rows }; await store.setJSON("sky-tle", c); }
  return c.rows || [];
}

// Upcoming Vandenberg launches from The Space Devs' free Launch Library 2, refreshed every 3 hours.
async function launches(store, now) {
  let c = (await store.get("sky-launches", { type: "json" })) || {};
  if (c.t && now - c.t < 3 * 3600e3) return c.list || [];
  try {
    const r = await fetch("https://ll.thespacedevs.com/2.2.0/launch/upcoming/?location__ids=11&limit=6&mode=list", { headers: { "user-agent": "OverheadSpotter/1.0 (+https://spotter.ttcorp.ai)" }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      const list = (j.results || []).map((x) => ({ id: x.id, name: x.name, net: Date.parse(x.net), status: x.status && (x.status.abbrev || x.status.name), pad: x.pad || x.location || "" }));
      c = { t: now, list };
      await store.setJSON("sky-launches", c);
    }
  } catch (e) { console.log("launches", String(e)); }
  return c.list || [];
}

export default async () => {
  const store = getStore({ name: "traffic", consistency: "strong" });
  const now = Date.now();
  const [lat, lon] = AREA;
  const p = await store.get("push", { type: "json" });
  const subs = p && p.subs ? Object.entries(p.subs) : [];
  const want = [...new Set(subs.flatMap(([, s]) => (Array.isArray(s.sats) ? s.sats : []).map(Number).filter((n) => n > 0)))];
  const events = [];

  const list = await launches(store, now); // keeps the launch list fresh for the app even when nobody subscribes
  if (!subs.length) return;
  const sent = (await store.get("sky-sent", { type: "json" })) || {};
  for (const k of Object.keys(sent)) if (now - sent[k] > 2 * 864e5) delete sent[k];

  // Satellite passes only matter when it is dark here soon.
  if (sunEl(now + LEAD_MAX * 60000, lat, lon) < -4) {
    for (const r of await catalog(store, [25544, 48274, ...want], now)) {
      let rec;
      try { rec = sat.twoline2satrec(r[1], r[2]); } catch (e) { continue; }
      const norad = +r[1].slice(2, 7), grp = r[3];
      const minEl = grp === "station" ? 20 : grp === "starlink" ? 25 : 15;
      const ps = upcomingPass(rec, now, lat, lon, minEl);
      if (!ps) continue;
      const key = (grp === "starlink" ? "train" : norad) + ":" + Math.round(ps.start / 6e5);
      if (sent[key]) continue;
      sent[key] = now;
      const name = grp === "station" ? (r[0].startsWith("ISS") ? "The ISS" : "Tiangong, China's space station") : grp === "starlink" ? "A Starlink train" : grp === "decay" ? r[0] + " (reentering soon)" : r[0];
      events.push({ kind: grp, norad, title: grp === "starlink" ? "Starlink train tonight" : grp === "decay" ? "Reentry watch" : "Sky alert",
        body: name + " passes at " + tfmt(ps.start) + ". Look " + dir(ps.az0) + ", rising to " + Math.round(ps.max) + "° in the " + dir(ps.azMax) + ", for about " + Math.max(1, Math.round((ps.end - ps.start) / 6e4)) + " min." });
    }
  }

  // Launches: a heads-up about 25 minutes before liftoff when the sky here is in twilight,
  // which is when a rocket plume catches sunlight and glows (the "jellyfish").
  for (const l of list) {
    const lead = (l.net - now) / 60000;
    if (lead < 18 || lead > 32 || /TBD|TBC|Hold/i.test(l.status || "")) continue;
    const s = sunEl(l.net, lat, lon);
    if (s > -2 || s < -20) continue;
    const key = "launch:" + l.id;
    if (sent[key]) continue;
    sent[key] = now;
    events.push({ kind: "launch", title: "Rocket launch at " + tfmt(l.net), body: (l.name || "A launch") + " from Vandenberg. In twilight the plume can glow low in the south. Look S to SSW after liftoff." });
  }
  await store.setJSON("sky-sent", sent);
  if (!events.length) return;

  webpush.setVapidDetails(process.env.URL || "https://example.com", p.keys.publicKey, p.keys.privateKey);
  let changed = false;
  for (const [id, s] of subs) {
    if (s.sky === false) continue;
    const mine = new Set((s.sats || []).map(Number));
    for (const ev of events) {
      if (ev.kind === "watched" && !mine.has(ev.norad)) continue;
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: ev.title, body: ev.body, tag: "overhead-sky-" + (ev.norad || ev.kind) }), { TTL: 900 });
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) { delete p.subs[id]; changed = true; break; }
      }
    }
  }
  if (changed) await store.setJSON("push", p);
};

export const config = { schedule: "*/10 * * * *" };
