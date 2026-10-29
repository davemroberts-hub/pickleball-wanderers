import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// One record per key so two people saving at once never overwrite each other.
// Keys: <ladder>/players/<id> and <ladder>/matches/<id>. Only "main" exists for now.
const LADDER = "main";
const store = () => getStore({ name: "ladder", consistency: "strong" });

type Player = { id: string; name: string; dupr: number | null; createdAt: number };
type Match = { id: string; a: string[]; b: string[]; sa: number; sb: number; playedAt: string; createdAt: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

// Group PIN, stored only as a salted hash. A LADDER_PIN setting in Netlify overrides it.
const PIN_SALT = "ffbb8c3ee26d346e";
const PIN_HASH = "c877c6e765a0299c84a6124547f627bf2d9d83455eb4371cd3fe31649dd1c3af";
async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function pinOk(req: Request) {
  const given = req.headers.get("x-ladder-pin") || "";
  if (!given) return false;
  const override = Netlify.env.get("LADDER_PIN");
  if (override) return given === override;
  return (await sha256(PIN_SALT + given)) === PIN_HASH;
}

async function readAll<T>(prefix: string): Promise<T[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: `${LADDER}/${prefix}/` });
  const out: T[] = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const chunk = await Promise.all(blobs.slice(i, i + 50).map(b => s.get(b.key, { type: "json" })));
    chunk.forEach(v => { if (v) out.push(v as T); });
  }
  return out;
}

const validDupr = (v: unknown) => v === null || (typeof v === "number" && v >= 2 && v <= 8);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/ladder\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const method = req.method;
  const s = store();

  if (resource === "state" && method === "GET") {
    const [players, matches] = await Promise.all([readAll<Player>("players"), readAll<Match>("matches")]);
    return json({ players, matches });
  }

  if (resource === "check-pin" && method === "POST") {
    return (await pinOk(req)) ? json({ ok: true }) : bad("Wrong PIN", 401);
  }

  // Everything below changes data and needs the group PIN.
  if (!(await pinOk(req))) return bad("Group PIN required", 401);
  let body: any = {};
  if (method === "POST" || method === "PATCH") {
    try { body = await req.json(); } catch { return bad("Invalid request"); }
  }

  if (resource === "players") {
    if (method === "POST" && !id) {
      const name = String(body.name ?? "").trim().slice(0, 40);
      if (!name) return bad("Enter a name.");
      const dupr = body.dupr === undefined ? null : body.dupr;
      if (!validDupr(dupr)) return bad("DUPR should be between 2.0 and 8.0.");
      const existing = await readAll<Player>("players");
      if (existing.some(p => p.name.toLowerCase() === name.toLowerCase())) return bad(`${name} is already on the ladder.`, 409);
      const p: Player = { id: newId(), name, dupr, createdAt: Date.now() };
      await s.setJSON(`${LADDER}/players/${p.id}`, p);
      return json(p, 201);
    }
    if (id && method === "PATCH") {
      const p = (await s.get(`${LADDER}/players/${id}`, { type: "json" })) as Player | null;
      if (!p) return bad("Player not found", 404);
      if ("dupr" in body) { if (!validDupr(body.dupr)) return bad("DUPR should be between 2.0 and 8.0."); p.dupr = body.dupr; }
      if ("name" in body) { const n = String(body.name).trim().slice(0, 40); if (n) p.name = n; }
      await s.setJSON(`${LADDER}/players/${id}`, p);
      return json(p);
    }
    if (id && method === "DELETE") {
      const matches = await readAll<Match>("matches");
      if (matches.some(m => m.a.includes(id) || m.b.includes(id))) return bad("This player has recorded games, so they can't be removed.", 409);
      await s.delete(`${LADDER}/players/${id}`);
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
      const players = await readAll<Player>("players");
      if (!all.every(pid => players.some(p => p.id === pid))) return bad("One of those players isn't on the ladder.");
      const m: Match = { id: newId(), a, b, sa, sb, playedAt, createdAt: Date.now() };
      await s.setJSON(`${LADDER}/matches/${m.id}`, m);
      return json(m, 201);
    }
    if (id && method === "DELETE") {
      await s.delete(`${LADDER}/matches/${id}`);
      return json({ ok: true });
    }
  }

  return bad("Not found", 404);
};

export const config: Config = {
  path: "/ladder/api/*",
  // slows down anyone guessing the PIN; normal use is well under this
  rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
