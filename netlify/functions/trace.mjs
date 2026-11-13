// Whole current flight for one aircraft, from the OpenSky Network's public tracks API
// (free for personal, non-commercial use; credited in the app). Browsers cannot call it directly, so this relays it.
//   GET /api/trace?hex=a1b2c3  ->  { pts: [[time ms, lat, lon, alt ft, onGround]], cs, start }
const json = (o, status = 200, maxAge = 0) =>
  Response.json(o, { status, headers: { "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store" } });

export default async (req) => {
  const hex = String(new URL(req.url).searchParams.get("hex") || "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "bad hex" }, 400);
  let r;
  try {
    r = await fetch("https://opensky-network.org/api/tracks/all?icao24=" + hex + "&time=0", {
      headers: { "user-agent": "OverheadSpotter/1.0 (+https://spotter.ttcorp.ai)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return json({ error: "unreachable" }, 502);
  }
  if (r.status === 404) return json({ pts: [] }, 200, 120);
  if (!r.ok) return json({ error: "upstream " + r.status }, 502);
  const j = await r.json().catch(() => null);
  const pts = (j && Array.isArray(j.path) ? j.path : [])
    .filter((p) => p && p[1] != null && p[2] != null)
    .map((p) => [p[0] * 1000, +p[1], +p[2], Math.round((+p[3] || 0) / 0.3048), p[5] ? 1 : 0]);
  return json({ pts, cs: String((j && j.callsign) || "").trim(), start: j && j.startTime ? j.startTime * 1000 : null }, 200, 60);
};

export const config = { path: "/api/trace" };
