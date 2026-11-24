import { getStore } from "@netlify/blobs";

// Nearby spotters: people who turned it on can see other spotters near them and connect.
// Strictly opt-in, adults only, and built so nobody can be located:
//   - a location is stored only as a ~1 km grid square, and is deleted after 3 hours without a check-in
//   - others see only a distance band (under 2 mi, 2-5 mi, 5-10 mi), never a point, direction or history
//   - a contact line is shown only after both people accept the connection
//   - anyone can block (hides both ways, for good) or report
//   POST /api/nearby/here    {pid, token, lat, lon, adult, contact?}  turn on or check in
//   POST /api/nearby/list    {pid, token}                            spotters near you + your requests and friends
//   POST /api/nearby/connect|accept|decline|remove|block|report  {pid, token, target, reason?}
//   POST /api/nearby/off     {pid, token}                            hide me now
import { createHash } from "node:crypto";

const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const STALE = 3 * 60 * 60 * 1000;
const RANGE_MI = 10;
const MAX_PENDING = 20;
const cell = (v) => Math.round(Number(v) * 100) / 100; // about 1.1 km north-south, 0.8 km east-west here
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const miles = (a, b) => {
  const R = 3958.8, r = Math.PI / 180, x = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};
const band = (d) => (d < 2 ? "Under 2 mi" : d < 5 ? "2–5 mi" : "5–10 mi");
const links = (c) => ({ friends: [], inbox: [], sent: [], blocked: [], ...(c || {}) });
const drop = (arr, x) => arr.filter((y) => y !== x);

export async function handle(req, nearby, club) {
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  const op = new URL(req.url).pathname.split("/").pop();
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad request" }, 400);
  }
  const pid = String(body.pid || "").replace(/[^A-Za-z0-9_-]/g, "");
  const me = pid && (await club.get("p/" + pid, { type: "json" }));
  if (!me || me.tok !== hash(body.token)) return json({ error: "Join the leaderboard first. Nearby spotters uses your club name." }, 403);
  const getL = async (id) => links(await nearby.get("c/" + id, { type: "json" }));
  const setL = (id, l) => nearby.setJSON("c/" + id, l);
  const now = Date.now();

  if (op === "here") {
    if (body.adult !== true) return json({ error: "Nearby spotters is for adults (18+)." }, 400);
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || body.lat == null || body.lon == null) return json({ error: "Location is needed to find spotters near you." }, 400);
    const old = (await nearby.get("p/" + pid, { type: "json" })) || {};
    // A random offset of up to about half a mile, fixed for each check-in session, so distance bands can't be used to home in on someone.
    const j = old.j || [(Math.random() - 0.5) * 0.014, (Math.random() - 0.5) * 0.018];
    await nearby.setJSON("p/" + pid, { cell: [cell(lat + j[0]), cell(lon + j[1])], j, t: now, since: old.since || now });
    if (body.contact !== undefined) { const l0 = await getL(pid); l0.contact = clean(body.contact, 60); await setL(pid, l0); }
  } else if (op === "off") {
    await nearby.delete("p/" + pid);
    return json({ ok: true, on: false });
  } else if (["connect", "accept", "decline", "remove", "block", "report"].includes(op)) {
    const target = String(body.target || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!target || target === pid || !(await club.get("p/" + target, { type: "json" }))) return json({ error: "That spotter isn't around anymore." }, 404);
    const a = await getL(pid), b = await getL(target);
    if (op === "report") {
      const reports = (await nearby.get("reports", { type: "json" })) || [];
      reports.push({ from: pid, about: target, reason: clean(body.reason, 200), t: now });
      await nearby.setJSON("reports", reports.slice(-500));
    }
    if (op === "connect") {
      if (a.blocked.includes(target) || b.blocked.includes(pid)) return json({ error: "That spotter isn't available." }, 403);
      const mine = await nearby.get("p/" + pid, { type: "json" }), theirs = await nearby.get("p/" + target, { type: "json" });
      if (!mine || !theirs || now - theirs.t > STALE || miles(mine.cell, theirs.cell) > RANGE_MI + 1) return json({ error: "You can only connect with spotters near you right now." }, 403);
      if (a.inbox.includes(target)) {
        a.inbox = drop(a.inbox, target); b.sent = drop(b.sent, pid);
        a.friends = [...new Set([...a.friends, target])]; b.friends = [...new Set([...b.friends, pid])];
      } else if (!a.friends.includes(target) && !a.sent.includes(target)) {
        if (a.sent.length >= MAX_PENDING) return json({ error: "You have too many requests waiting. Give them time." }, 429);
        a.sent.push(target); b.inbox = [...new Set([...b.inbox, pid])];
      }
    }
    if (op === "accept" && a.inbox.includes(target)) {
      a.inbox = drop(a.inbox, target); b.sent = drop(b.sent, pid);
      a.friends = [...new Set([...a.friends, target])]; b.friends = [...new Set([...b.friends, pid])];
    }
    if (op === "decline") { a.inbox = drop(a.inbox, target); b.sent = drop(b.sent, pid); }
    if (op === "remove" || op === "block" || op === "report") {
      a.friends = drop(a.friends, target); b.friends = drop(b.friends, pid);
      a.inbox = drop(a.inbox, target); a.sent = drop(a.sent, target); b.inbox = drop(b.inbox, pid); b.sent = drop(b.sent, pid);
      if (op !== "remove") a.blocked = [...new Set([...a.blocked, target])];
    }
    await setL(pid, a);
    await setL(target, b);
  } else if (op !== "list") return json({ error: "not found" }, 404);

  // The list: who is near you, plus your requests and connections.
  const mine = await nearby.get("p/" + pid, { type: "json" });
  const l = await getL(pid);
  const out = [];
  const { blobs } = await nearby.list({ prefix: "p/" });
  for (const bl of blobs) {
    const id = bl.key.slice(2);
    const p = await nearby.get(bl.key, { type: "json" });
    if (!p) continue;
    if (now - p.t > STALE) { await nearby.delete(bl.key); continue; }
    if (id === pid || !mine) continue;
    const d = miles(mine.cell, p.cell);
    const related = l.friends.includes(id) || l.inbox.includes(id) || l.sent.includes(id);
    if (d > RANGE_MI && !related) continue;
    if (l.blocked.includes(id)) continue;
    const theirL = await getL(id);
    if (theirL.blocked.includes(pid)) continue;
    const c = await club.get("p/" + id, { type: "json" });
    if (!c) continue;
    const friend = l.friends.includes(id);
    out.push({ pid: id, name: c.name, lvl: c.lvl || 1, pts: c.pts || 0, badges: c.badges || 0, best: c.best ? { name: c.best.name, tier: c.best.tier } : null,
      band: d > RANGE_MI ? "Not nearby now" : band(d), near: d <= RANGE_MI, status: friend ? "friend" : l.inbox.includes(id) ? "asked-you" : l.sent.includes(id) ? "sent" : "none", contact: friend ? theirL.contact || "" : undefined });
  }
  // Connections who are not checked in still appear in your list, without a distance.
  for (const id of [...l.friends, ...l.inbox]) {
    if (out.some((x) => x.pid === id)) continue;
    const c = await club.get("p/" + id, { type: "json" });
    if (!c) continue;
    const fr = l.friends.includes(id);
    out.push({ pid: id, name: c.name, lvl: c.lvl || 1, pts: c.pts || 0, badges: c.badges || 0, best: c.best ? { name: c.best.name, tier: c.best.tier } : null, band: "Not nearby now", near: false, status: fr ? "friend" : "asked-you", contact: fr ? (await getL(id)).contact || "" : undefined });
  }
  const order = { "asked-you": 0, friend: 1, sent: 2, none: 3 };
  out.sort((x, y) => order[x.status] - order[y.status] || (y.near - x.near) || y.pts - x.pts);
  return json({ on: !!mine, contact: l.contact || "", requests: l.inbox.length, spotters: out.slice(0, 60) });
}

export default async (req) => handle(req, getStore({ name: "nearby", consistency: "strong" }), getStore({ name: "club", consistency: "strong" }));

export const config = { path: ["/api/nearby/here", "/api/nearby/list", "/api/nearby/connect", "/api/nearby/accept", "/api/nearby/decline", "/api/nearby/remove", "/api/nearby/block", "/api/nearby/report", "/api/nearby/off"] };
