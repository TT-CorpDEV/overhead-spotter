import { getStore } from "@netlify/blobs";
import { createHash, randomBytes } from "node:crypto";

// Friends leaderboard. One club per site, joined with an invite code.
//   POST /api/club/create  {name}                       start the club (only once)
//   POST /api/club/join    {name}                       join the club (open to anyone)
//   POST /api/club/sync    {code, pid, token, log, badges, name?}  upload your catches
//   GET  /api/club/board?code=                          the ranked board
//   POST /api/club/leave   {code, pid, token}           leave the club
// Points are recomputed here from the uploaded catches, so the board uses one scoring rule.
const PTS = [0, 10, 25, 60, 150];
const MAX_PLAYERS = 50;
// The club's invite code. Earlier codes keep working so nobody who already joined is locked out.
const CODE = "666";
const json = (o, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
const id = (n) => randomBytes(n).toString("base64url");

function score(log) {
  const seen = new Set();
  let pts = 0, best = null;
  const out = [];
  for (const c of Array.isArray(log) ? log.slice(-3000) : []) {
    if (!c || typeof c.k !== "string" || seen.has(c.k)) continue;
    seen.add(c.k);
    const tier = Math.min(4, Math.max(1, Math.round(Number(c.tier) || 1)));
    pts += PTS[tier];
    const e = { cs: String(c.cs || "").slice(0, 12), name: String(c.name || "").slice(0, 40), tier, t: Number(c.t) || 0 };
    out.push(e);
    if (!best || tier > best.tier || (tier === best.tier && e.t > best.t)) best = e;
  }
  const last = out.reduce((a, e) => (!a || e.t > a.t ? e : a), null);
  return { pts, n: seen.size, lvl: Math.floor(Math.sqrt(pts / 50)) + 1, best, last };
}

async function board(store) {
  const { blobs } = await store.list({ prefix: "p/" });
  const players = [];
  for (const b of blobs) {
    const p = await store.get(b.key, { type: "json" });
    if (p) players.push({ pid: b.key.slice(2), name: p.name, pts: p.pts || 0, n: p.n || 0, lvl: p.lvl || 1, badges: p.badges || 0, best: p.best || null, last: p.last || null, updated: p.updated || 0 });
  }
  players.sort((a, b) => b.pts - a.pts || b.badges - a.badges || a.updated - b.updated);
  return players;
}

export async function handle(req, store) {
  const url = new URL(req.url);
  const op = url.pathname.split("/").pop();
  let meta = await store.get("meta", { type: "json" });
  if (meta && meta.code !== CODE) {
    meta = { ...meta, old: [...new Set([...(meta.old || []), meta.code])], code: CODE };
    await store.setJSON("meta", meta);
  }
  const ok = (c) => !!meta && (c === meta.code || (meta.old || []).includes(c));

  if (op === "board") {
    if (!ok(url.searchParams.get("code"))) return json({ error: "That invite code is not valid." }, 403);
    return json({ code: meta.code, players: await board(store) });
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "bad request" }, 400);
  }

  if (op === "create" || op === "join") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Enter a name for the leaderboard." }, 400);
    let code;
    if (op === "create") {
      if (meta) return json({ error: "A club already exists. Ask its owner for the invite link." }, 409);
      code = CODE;
      await store.setJSON("meta", { code, created: Date.now() });
    } else {
      // Open club: anyone with the app can join, no invite code needed.
      if (!meta) {
        meta = { code: CODE, created: Date.now() };
        await store.setJSON("meta", meta);
      }
      code = meta.code;
      const { blobs } = await store.list({ prefix: "p/" });
      if (blobs.length >= MAX_PLAYERS) return json({ error: "The club is full." }, 409);
    }
    const pid = id(8), token = id(18);
    await store.setJSON("p/" + pid, { name, tok: hash(token), pts: 0, n: 0, lvl: 1, badges: 0, joined: Date.now(), updated: Date.now() });
    return json({ code, pid, token, name });
  }

  if (!ok(body.code)) return json({ error: "That invite code is not valid." }, 403);
  const key = "p/" + String(body.pid || "").replace(/[^A-Za-z0-9_-]/g, "");
  const p = await store.get(key, { type: "json" });
  if (!p || p.tok !== hash(body.token)) return json({ error: "Your club membership was not found. Join again with the invite link." }, 403);

  if (op === "sync") {
    const s = score(body.log);
    const name = cleanName(body.name) || p.name;
    await store.setJSON(key, { ...p, name, ...s, badges: Math.min(99, Math.max(0, Number(body.badges) || 0)), updated: Date.now() });
    return json({ code: meta.code, players: await board(store) });
  }
  if (op === "leave") {
    await store.delete(key);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

export default async (req) => handle(req, getStore({ name: "club", consistency: "strong" }));

export const config = { path: ["/api/club/create", "/api/club/join", "/api/club/sync", "/api/club/board", "/api/club/leave"] };
