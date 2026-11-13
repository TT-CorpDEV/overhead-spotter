import { getStore } from "@netlify/blobs";
// GET /api/sky -> upcoming Vandenberg launches (kept fresh by sky-alerts) for the app to show.
export default async () => {
  const c = (await getStore({ name: "traffic", consistency: "strong" }).get("sky-launches", { type: "json" })) || {};
  return Response.json({ updated: c.t || null, launches: (c.list || []).filter((l) => l.net > Date.now() - 36e5) }, { headers: { "cache-control": "public, max-age=300" } });
};
export const config = { path: "/api/sky" };
