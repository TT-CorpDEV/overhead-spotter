// Trains near you: Amtrak (free Amtraker feed) and, once a TriMet key is set, MAX light rail, WES and Portland Streetcar.
//   GET /api/trains?lat=45.52&lon=-122.68   ->  { trains: [...], trimet: true|false, t }
// Freight railroads publish no live positions, so they can't be shown.
const AMTRAK = "https://api-v3.amtraker.com/v3/trains";
const TRIMET = "https://developer.trimet.org/ws/v2/vehicles";
const RANGE_MI = 60;
// TriMet rail routes: MAX Red, Blue, Yellow, Green, Orange, WES, and Portland Streetcar NS, A, B loops.
const RAIL = { 90: ["MAX Red Line", "#d81526"], 100: ["MAX Blue Line", "#084c8d"], 190: ["MAX Yellow Line", "#ffc52f"], 200: ["MAX Green Line", "#008852"], 290: ["MAX Orange Line", "#d15f27"], 203: ["WES Commuter Rail", "#6d6e71"], 193: ["Portland Streetcar NS Line", "#84bd00"], 194: ["Portland Streetcar A Loop", "#c5007c"], 195: ["Portland Streetcar B Loop", "#0093b2"] };
const HDG = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

let amCache = { t: 0, data: null }, tmCache = { t: 0, data: null };
const miles = (a, b, c, d) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 7917.6 * Math.asin(Math.min(1, Math.sqrt(x)));
};
const mins = (a, b) => (a && b ? Math.round((Date.parse(a) - Date.parse(b)) / 60000) : null);

async function amtrak() {
  if (amCache.data && Date.now() - amCache.t < 45000) return amCache.data;
  const r = await fetch(AMTRAK, { headers: { "user-agent": "overhead-spotter (spotter.ttcorp.ai)" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("amtrak " + r.status);
  const j = await r.json();
  const out = [];
  for (const list of Object.values(j)) {
    for (const t of list || []) {
      if (typeof t.lat !== "number" || typeof t.lon !== "number" || t.trainState === "Predeparture") continue;
      const st = Array.isArray(t.stations) ? t.stations : [];
      const next = st.find((s) => s.status === "Enroute") || null;
      out.push({
        id: "t" + t.trainID, op: "Amtrak", line: t.routeName || "Amtrak", num: String(t.trainNum || ""), lat: t.lat, lon: t.lon,
        hdg: HDG[t.heading] ?? null, mph: Math.round(Number(t.velocity) || 0), from: t.origName || "", to: t.destName || "",
        next: next ? { name: next.name, eta: next.arr || next.schArr || null } : null,
        late: next ? mins(next.arr, next.schArr) : null, color: t.iconColor || "", upd: t.lastValTS || t.updatedAt || "",
      });
    }
  }
  amCache = { t: Date.now(), data: out };
  return out;
}

async function trimet() {
  const key = process.env.TRIMET_APPID;
  if (!key) return null;
  if (tmCache.data && Date.now() - tmCache.t < 25000) return tmCache.data;
  const r = await fetch(TRIMET + "?appID=" + encodeURIComponent(key) + "&routes=" + Object.keys(RAIL).join(","), { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("trimet " + r.status);
  const j = await r.json();
  const out = ((j.resultSet && j.resultSet.vehicle) || []).filter((v) => RAIL[v.routeNumber]).map((v) => ({
    id: "m" + v.vehicleID, op: "TriMet", line: RAIL[v.routeNumber][0], num: String(v.vehicleID), lat: v.latitude, lon: v.longitude,
    hdg: typeof v.bearing === "number" ? v.bearing : null, mph: null, from: "", to: String(v.signMessageLong || v.signMessage || "").replace(/^MAX \w+ Line to /, ""),
    next: null, late: typeof v.delay === "number" ? Math.round(-v.delay / 60) : null, color: RAIL[v.routeNumber][1], upd: v.time ? new Date(v.time).toISOString() : "",
  }));
  tmCache = { t: Date.now(), data: out };
  return out;
}

export default async (req) => {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !u.searchParams.get("lat")) return Response.json({ error: "lat and lon are needed" }, { status: 400 });
  const [am, tm] = await Promise.allSettled([amtrak(), trimet()]);
  const all = [...(am.status === "fulfilled" ? am.value : []), ...(tm.status === "fulfilled" && tm.value ? tm.value : [])];
  const trains = all.filter((t) => miles(lat, lon, t.lat, t.lon) <= RANGE_MI);
  return Response.json(
    { trains, trimet: tm.status === "fulfilled" && !!tm.value, amtrak: am.status === "fulfilled", t: Date.now() },
    // The CDN answers repeat requests for the same area for 20 seconds, so a crowd of phones costs one upstream call.
    { headers: { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, max-age=20, stale-while-revalidate=20" } }
  );
};

export const config = { path: "/api/trains" };
