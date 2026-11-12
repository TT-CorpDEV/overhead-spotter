import { getStore } from "@netlify/blobs";

// GET /api/seen?hex=abc123 -> how often the logger has seen that aircraft over the watched area.
export default async (req) => {
  const hex = (new URL(req.url).searchParams.get("hex") || "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return Response.json({ error: "hex required" }, { status: 400 });
  const db = await getStore("traffic").get("seen", { type: "json" });
  const e = db && db.ac[hex];
  return Response.json(
    {
      area: process.env.AREA || "45.52,-122.68,25",
      since: db ? db.since : null,
      last: db ? db.last : null,
      known: db ? Object.keys(db.ac).length : 0,
      first: e ? e[0] : null,
      lastSeen: e ? e[1] : null,
      visits: e ? e[2] : 0,
    },
    { headers: { "cache-control": "public, max-age=60" } }
  );
};

export const config = { path: "/api/seen" };
