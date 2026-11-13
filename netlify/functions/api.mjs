import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { createHash } from "node:crypto";

// Read side of the area log, plus alert sign-up.
//   GET  /api/log        summary for the Area log screen
//   GET  /api/export     the whole log as CSV
//   GET  /api/track?hex= recent positions for one aircraft
//   GET  /api/push-key   public key the app needs to subscribe to alerts
//   POST /api/subscribe  save or remove an alert subscription
const json = (o, status = 200, headers = {}) => Response.json(o, { status, headers });
const CACHE = { "cache-control": "public, max-age=60" };

export default async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;
  const store = getStore("traffic");

  if (p === "/api/track") {
    const hex = (url.searchParams.get("hex") || "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "hex required" }, 400);
    const t = await store.get("tracks", { type: "json" });
    return json({ pts: (t && t[hex]) || [] }, 200, CACHE);
  }

  if (p === "/api/log" || p === "/api/export") {
    const db = await store.get("seen", { type: "json" });
    if (!db) return json({ since: null });
    const rows = Object.entries(db.ac).map(([hex, e]) => ({ hex, first: e[0], last: e[1], visits: e[2], reg: e[3] || "", type: e[4] || "", mil: (e[5] || 0) & 1 }));
    if (p === "/api/export") {
      const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
      const lines = ["ICAO hex,Tail number,Type code,Military,Visits,First seen (UTC),Last seen (UTC)"].concat(
        rows.sort((a, b) => b.visits - a.visits).map((r) => [r.hex, r.reg, r.type, r.mil ? "yes" : "no", r.visits, new Date(r.first).toISOString(), new Date(r.last).toISOString()].map(q).join(","))
      );
      return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="overhead-area-log.csv"' } });
    }
    const types = {};
    let visits = 0;
    for (const r of rows) {
      visits += r.visits;
      if (r.type) types[r.type] = (types[r.type] || 0) + r.visits;
    }
    const days = Object.keys(db.days || {}).sort().slice(-14).map((d) => [d, db.days[d].v, db.days[d].n]);
    return json(
      {
        area: process.env.AREA || "45.52,-122.68,25",
        since: db.since,
        last: db.last,
        runs: db.runs || 0,
        known: rows.length,
        visits,
        hours: db.hours || [],
        days,
        top: [...rows].sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, 15),
        fresh: [...rows].sort((a, b) => b.first - a.first).slice(0, 15),
        mil: rows.filter((r) => r.mil).sort((a, b) => b.last - a.last).slice(0, 10),
        types: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 10),
      },
      200,
      CACHE
    );
  }

  const strong = getStore({ name: "traffic", consistency: "strong" });

  if (p === "/api/push-key") {
    const ps = (await strong.get("push", { type: "json" })) || { subs: {} };
    if (!ps.keys) {
      ps.keys = webpush.generateVAPIDKeys();
      await strong.setJSON("push", ps);
    }
    return json({ key: ps.keys.publicKey });
  }

  if (p === "/api/subscribe" && req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: "bad request" }, 400);
    }
    const sub = body && body.sub;
    if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys) return json({ error: "subscription required" }, 400);
    const ps = (await strong.get("push", { type: "json" })) || { subs: {} };
    ps.subs = ps.subs || {};
    const id = createHash("sha256").update(sub.endpoint).digest("hex").slice(0, 24);
    if (body.off) delete ps.subs[id];
    else {
      if (!ps.subs[id] && Object.keys(ps.subs).length >= 200) return json({ error: "alert list is full" }, 429);
      ps.subs[id] = { sub: { endpoint: sub.endpoint, keys: sub.keys }, watch: (Array.isArray(body.watch) ? body.watch : []).slice(0, 200).map(String), mil: !!body.mil, rare: !!body.rare, emg: !!body.emg, fire: body.fire !== false, sats: (Array.isArray(body.sats) ? body.sats : []).slice(0, 25).map(Number).filter((n) => n > 0), t: Date.now() };
    }
    await strong.setJSON("push", ps);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: ["/api/log", "/api/export", "/api/track", "/api/push-key", "/api/subscribe"] };
