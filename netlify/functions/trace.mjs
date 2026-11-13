// Whole current flight for one aircraft, from the OpenSky Network's public tracks API
// (free for personal, non-commercial use; credited in the app). Browsers cannot call it directly, so this relays it.
//   GET /api/trace?hex=a1b2c3  ->  { pts: [[time ms, lat, lon, alt ft, onGround]], cs, start }
// With OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET set (a free OpenSky API client), requests are authenticated.
const json = (o, status = 200, maxAge = 0) =>
  Response.json(o, { status, headers: { "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store" } });
let TOKEN = null, TOKEN_EXP = 0;
async function token() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (TOKEN && Date.now() < TOKEN_EXP) return TOKEN;
  const r = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("auth " + r.status);
  const j = await r.json();
  TOKEN = j.access_token;
  TOKEN_EXP = Date.now() + Math.max(60, (j.expires_in || 1800) - 120) * 1000;
  return TOKEN;
}

export default async (req) => {
  const url = new URL(req.url), debug = url.searchParams.has("debug");
  const hex = String(url.searchParams.get("hex") || "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "bad hex" }, 400);
  const t0 = Date.now();
  let r, tok = null;
  try {
    tok = await token();
    const headers = { "user-agent": "OverheadSpotter/1.0 (+https://spotter.ttcorp.ai)" };
    if (tok) headers.authorization = "Bearer " + tok;
    r = await fetch("https://opensky-network.org/api/tracks/all?icao24=" + hex + "&time=0", { headers, signal: AbortSignal.timeout(9000) });
  } catch (e) {
    return json({ error: "unreachable", ...(debug ? { why: String(e && (e.cause && e.cause.code || e.name)) + ": " + String(e && e.message), ms: Date.now() - t0, auth: !!tok } : {}) }, 502);
  }
  if (r.status === 404) return json({ pts: [] }, 200, 120);
  if (!r.ok) return json({ error: "upstream " + r.status, ...(debug ? { ms: Date.now() - t0, auth: !!tok } : {}) }, 502);
  const j = await r.json().catch(() => null);
  const pts = (j && Array.isArray(j.path) ? j.path : [])
    .filter((p) => p && p[1] != null && p[2] != null)
    .map((p) => [p[0] * 1000, +p[1], +p[2], Math.round((+p[3] || 0) / 0.3048), p[5] ? 1 : 0]);
  return json({ pts, cs: String((j && j.callsign) || "").trim(), start: j && j.startTime ? j.startTime * 1000 : null }, 200, 60);
};

export const config = { path: "/api/trace" };
