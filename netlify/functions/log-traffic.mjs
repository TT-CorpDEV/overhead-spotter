import { getStore } from "@netlify/blobs";

// Runs every 2 minutes on Netlify and keeps a running count of how often each
// aircraft has been seen over the watched area.
// Area format: "latitude,longitude,radius in nautical miles".
// Change it by setting an AREA environment variable in the Netlify project.
const AREA = (process.env.AREA || "45.52,-122.68,25").split(",").map(Number);
const GAP = 30 * 60 * 1000; // a new visit starts after 30 quiet minutes

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

export default async () => {
  const [lat, lon, nm] = AREA;
  const list = await readFeed(lat, lon, nm);
  if (!list) {
    console.log("no feed answered");
    return;
  }
  const store = getStore({ name: "traffic", consistency: "strong" });
  const now = Date.now();
  const db = (await store.get("seen", { type: "json" })) || { since: now, ac: {} };
  for (const a of list) {
    if (!a.hex || !/^[0-9a-f]{6}$/.test(a.hex) || a.alt_baro === "ground") continue;
    const e = db.ac[a.hex];
    if (!e) db.ac[a.hex] = [now, now, 1];
    else {
      if (now - e[1] > GAP) e[2]++;
      e[1] = now;
    }
  }
  const keys = Object.keys(db.ac);
  if (keys.length > 60000) {
    keys.sort((x, y) => db.ac[x][1] - db.ac[y][1]).slice(0, keys.length - 50000).forEach((k) => delete db.ac[k]);
  }
  db.runs = (db.runs || 0) + 1;
  db.last = now;
  await store.setJSON("seen", db);
  console.log("logged", list.length, "aircraft;", keys.length, "known");
};

export const config = { schedule: "*/2 * * * *" };
