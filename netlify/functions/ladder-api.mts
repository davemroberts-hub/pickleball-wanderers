import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Storage layout (one record per key, so simultaneous saves never clobber each other):
//   <slug>/meta               { name, pinSalt, pinHash, createdAt }
//   <slug>/players/<id>       player
//   <slug>/matches/<id>       game
//   _admin/config             { salt, hash } — admin password, set once on first visit
// No secrets live in this file: the repository is public.
const store = () => getStore({ name: "ladder", consistency: "strong" });

type Meta = { name: string; pinSalt?: string; pinHash?: string; createdAt: number };
type Player = { id: string; name: string; dupr: number | null; createdAt: number };
type Match = { id: string; a: string[]; b: string[]; sa: number; sb: number; playedAt: string; createdAt: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED = new Set(["admin", "api", "app", "index", "new", "_admin"]);
const DEFAULT_MAIN_NAME = "Pickleball Ladder";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const salt = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const validDupr = (v: unknown) => v === null || (typeof v === "number" && v >= 2 && v <= 8);
const validPin = (p: unknown) => typeof p === "string" && /^\d{4,8}$/.test(p);

async function readAll<T>(prefix: string): Promise<T[]> {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const out: T[] = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const chunk = await Promise.all(blobs.slice(i, i + 50).map(b => s.get(b.key, { type: "json" })));
    chunk.forEach(v => { if (v) out.push(v as T); });
  }
  return out;
}

// The original ladder ("main") predates meta records, so it exists if it has any data.
async function getMeta(slug: string): Promise<Meta | null> {
  const m = (await store().get(`${slug}/meta`, { type: "json" })) as Meta | null;
  if (m) return m;
  if (slug === "main") return { name: DEFAULT_MAIN_NAME, createdAt: 0 };
  return null;
}

async function pinOk(meta: Meta, given: string | null) {
  if (!given || !meta.pinHash || !meta.pinSalt) return false;
  return (await sha256(meta.pinSalt + given)) === meta.pinHash;
}

async function adminOk(req: Request) {
  const given = req.headers.get("x-admin-key") || "";
  if (!given) return false;
  const cfg = (await store().get("_admin/config", { type: "json" })) as { salt: string; hash: string } | null;
  if (!cfg) return false;
  return (await sha256(cfg.salt + given)) === cfg.hash;
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}

/* ---------------- admin ---------------- */
async function handleAdmin(req: Request, parts: string[]) {
  const s = store();
  const [what, slugParam] = parts;
  const method = req.method;

  if (what === "status" && method === "GET") {
    const cfg = await s.get("_admin/config");
    return json({ claimed: cfg !== null });
  }
  if (what === "claim" && method === "POST") {
    const body = await readBody(req);
    const pw = String(body?.password ?? "");
    if (pw.length < 8) return bad("Use at least 8 characters for the admin password.");
    const sa = salt();
    const { modified } = await s.setJSON("_admin/config", { salt: sa, hash: await sha256(sa + pw) }, { onlyIfNew: true });
    if (!modified) return bad("An admin password has already been set.", 409);
    return json({ ok: true });
  }

  if (!(await adminOk(req))) return bad("Admin password required", 401);
  if (what === "check") return json({ ok: true });

  if (what === "ladders" && method === "GET" && !slugParam) {
    const { blobs } = await s.list();
    const counts = new Map<string, { players: number; games: number; hasMeta: boolean }>();
    for (const b of blobs) {
      const [slug, kind] = b.key.split("/");
      if (slug === "_admin") continue;
      const c = counts.get(slug) || { players: 0, games: 0, hasMeta: false };
      if (kind === "players") c.players++;
      else if (kind === "matches") c.games++;
      else if (kind === "meta") c.hasMeta = true;
      counts.set(slug, c);
    }
    if (!counts.has("main")) counts.set("main", { players: 0, games: 0, hasMeta: false });
    const ladders = await Promise.all([...counts].map(async ([slug, c]) => {
      const meta = await getMeta(slug);
      return { slug, name: meta?.name ?? slug, hasPin: !!meta?.pinHash, players: c.players, games: c.games, createdAt: meta?.createdAt ?? 0 };
    }));
    ladders.sort((a, b) => a.createdAt - b.createdAt);
    return json({ ladders });
  }

  if (what === "ladders" && method === "POST" && !slugParam) {
    const body = await readBody(req);
    const name = String(body?.name ?? "").trim().slice(0, 50);
    const slug = String(body?.slug ?? "").trim().toLowerCase();
    if (!name) return bad("Enter a name for the ladder.");
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return bad("Web address: 2–31 lowercase letters, numbers or dashes.");
    if (!validPin(body?.pin)) return bad("PIN: 4 to 8 digits.");
    if (await getMeta(slug)) return bad("A ladder with that address already exists.", 409);
    const ps = salt();
    const meta: Meta = { name, pinSalt: ps, pinHash: await sha256(ps + body.pin), createdAt: Date.now() };
    const { modified } = await s.setJSON(`${slug}/meta`, meta, { onlyIfNew: true });
    if (!modified) return bad("A ladder with that address already exists.", 409);
    return json({ slug, name }, 201);
  }

  if (what === "ladders" && slugParam && method === "PATCH") {
    const meta = await getMeta(slugParam);
    if (!meta) return bad("Ladder not found", 404);
    const body = await readBody(req);
    if (body?.name !== undefined) { const n = String(body.name).trim().slice(0, 50); if (!n) return bad("Enter a name."); meta.name = n; }
    if (body?.pin !== undefined) {
      if (!validPin(body.pin)) return bad("PIN: 4 to 8 digits.");
      meta.pinSalt = salt(); meta.pinHash = await sha256(meta.pinSalt + body.pin);
    }
    if (!meta.createdAt) meta.createdAt = Date.now();
    await s.setJSON(`${slugParam}/meta`, meta);
    return json({ ok: true });
  }

  if (what === "ladders" && slugParam && method === "DELETE") {
    if (!(await getMeta(slugParam))) return bad("Ladder not found", 404);
    const { blobs } = await s.list({ prefix: `${slugParam}/` });
    for (let i = 0; i < blobs.length; i += 50) await Promise.all(blobs.slice(i, i + 50).map(b => s.delete(b.key)));
    return json({ ok: true, deleted: blobs.length });
  }

  return bad("Not found", 404);
}

/* ---------------- one ladder ---------------- */
async function handleLadder(req: Request, slug: string, resource: string, id: string | undefined) {
  const s = store();
  const method = req.method;
  const meta = await getMeta(slug);
  if (!meta) return bad("This ladder doesn't exist.", 404);
  const P = `${slug}/`;

  if (resource === "state" && method === "GET") {
    const [players, matches] = await Promise.all([readAll<Player>(P + "players/"), readAll<Match>(P + "matches/")]);
    return json({ ladder: { slug, name: meta.name, hasPin: !!meta.pinHash }, players, matches });
  }
  if (resource === "manifest" && method === "GET") {
    return new Response(JSON.stringify({
      name: meta.name, short_name: meta.name.length > 12 ? "Ladder" : meta.name,
      description: `${meta.name}: ratings, fair teams and standings.`,
      start_url: `/ladder/${slug}/`, scope: "/ladder/", display: "standalone",
      background_color: "#f3f6f8", theme_color: "#1d5c9e",
      icons: [
        { src: "/ladder/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/ladder/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/ladder/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    }), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" } });
  }
  if (resource === "check-pin" && method === "POST") {
    if (!meta.pinHash) return bad("This ladder has no PIN yet. Ask the organiser to set one.", 403);
    return (await pinOk(meta, req.headers.get("x-ladder-pin"))) ? json({ ok: true }) : bad("Wrong PIN", 401);
  }

  // Everything below changes data and needs this ladder's PIN.
  if (!(await pinOk(meta, req.headers.get("x-ladder-pin")))) return bad("Group PIN required", 401);
  let body: any = {};
  if (method === "POST" || method === "PATCH") { body = await readBody(req); if (!body) return bad("Invalid request"); }

  if (resource === "players") {
    if (method === "POST" && !id) {
      const name = String(body.name ?? "").trim().slice(0, 40);
      if (!name) return bad("Enter a name.");
      const dupr = body.dupr === undefined ? null : body.dupr;
      if (!validDupr(dupr)) return bad("DUPR should be between 2.0 and 8.0.");
      const existing = await readAll<Player>(P + "players/");
      if (existing.some(p => p.name.toLowerCase() === name.toLowerCase())) return bad(`${name} is already on the ladder.`, 409);
      const p: Player = { id: newId(), name, dupr, createdAt: Date.now() };
      await s.setJSON(`${P}players/${p.id}`, p);
      return json(p, 201);
    }
    if (id && method === "PATCH") {
      const p = (await s.get(`${P}players/${id}`, { type: "json" })) as Player | null;
      if (!p) return bad("Player not found", 404);
      if ("dupr" in body) { if (!validDupr(body.dupr)) return bad("DUPR should be between 2.0 and 8.0."); p.dupr = body.dupr; }
      if ("name" in body) { const n = String(body.name).trim().slice(0, 40); if (n) p.name = n; }
      await s.setJSON(`${P}players/${id}`, p);
      return json(p);
    }
    if (id && method === "DELETE") {
      const matches = await readAll<Match>(P + "matches/");
      if (matches.some(m => m.a.includes(id) || m.b.includes(id))) return bad("This player has recorded games, so they can't be removed.", 409);
      await s.delete(`${P}players/${id}`);
      return json({ ok: true });
    }
  }

  if (resource === "matches") {
    if (method === "POST" && !id) {
      const a = Array.isArray(body.a) ? body.a.map(String) : [];
      const b = Array.isArray(body.b) ? body.b.map(String) : [];
      const sa = Number(body.sa), sb = Number(body.sb);
      if (!(a.length === b.length && (a.length === 1 || a.length === 2))) return bad("Pick every player on both teams.");
      const all = [...a, ...b];
      if (new Set(all).size !== all.length) return bad("A player can only appear once in a game.");
      if (![sa, sb].every(n => Number.isInteger(n) && n >= 0 && n <= 99)) return bad("Enter both scores as whole numbers.");
      if (sa === sb) return bad("Scores can't be tied.");
      const playedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(body.playedAt)) ? String(body.playedAt) : new Date().toISOString().slice(0, 10);
      const players = await readAll<Player>(P + "players/");
      if (!all.every(pid => players.some(p => p.id === pid))) return bad("One of those players isn't on the ladder.");
      const m: Match = { id: newId(), a, b, sa, sb, playedAt, createdAt: Date.now() };
      await s.setJSON(`${P}matches/${m.id}`, m);
      return json(m, 201);
    }
    if (id && method === "DELETE") {
      await s.delete(`${P}matches/${id}`);
      return json({ ok: true });
    }
  }

  return bad("Not found", 404);
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/ladder-api\/?/, "").split("/").filter(Boolean);
  const [first, ...rest] = parts;
  if (first === "_admin") return handleAdmin(req, rest);
  if (!first || !SLUG_RE.test(first)) return bad("Not found", 404);
  const [resource, id] = rest;
  return handleLadder(req, first, resource, id);
};

export const config: Config = {
  path: "/ladder-api/*",
  // slows down anyone guessing a PIN; normal use is well under this
  rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
