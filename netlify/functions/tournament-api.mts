import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// One tournament: /tournament-api/<code>/<resource>[/<id>]. Every call needs the tournament's PIN
// in the x-tournament-pin header. Storage layout is described in tournament-create.mts.
const store = () => getStore({ name: "tournament", consistency: "strong" });

type Meta = { name: string; pinSalt: string; pinHash: string; createdAt: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);
const CODE_RE = /^[a-z0-9]{6}$/;
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}

// Warm instances keep recent records, so a poll only downloads scores whose etag changed.
const cache = new Map<string, { etag: string; value: unknown }>();
async function readMap(prefix: string) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  const out: Record<string, unknown> = {};
  const todo = blobs.filter(b => {
    const hit = cache.get(b.key);
    if (hit && hit.etag === b.etag) { out[b.key.slice(prefix.length)] = hit.value; return false; }
    return true;
  });
  for (let i = 0; i < todo.length; i += 50) {
    await Promise.all(todo.slice(i, i + 50).map(async b => {
      const e = await s.getWithMetadata(b.key, { type: "json" });
      if (e === null) return;
      cache.set(b.key, { etag: e.etag ?? b.etag, value: e.data });
      out[b.key.slice(prefix.length)] = e.data;
    }));
  }
  return out;
}
async function deletePrefix(prefix: string) {
  const s = store();
  const { blobs } = await s.list({ prefix });
  for (let i = 0; i < blobs.length; i += 50) await Promise.all(blobs.slice(i, i + 50).map(b => s.delete(b.key)));
}

const scoreVal = (v: unknown) => v === "" || isInt(typeof v === "string" ? Number(v) : v, 0, 99) ? (v === "" ? "" : String(Number(v))) : null;

export default async (req: Request) => {
  const parts = new URL(req.url).pathname.replace(/^\/tournament-api\/?/, "").split("/").filter(Boolean);
  const [code, resource, id] = parts;
  if (!code || !CODE_RE.test(code)) return bad("Not found", 404);
  const s = store();
  const meta = (await s.get(`${code}/meta`, { type: "json" })) as Meta | null;
  if (!meta) return bad("There's no tournament with that code.", 404);
  const given = req.headers.get("x-tournament-pin") || "";
  if (!given || (await sha256(meta.pinSalt + given)) !== meta.pinHash) return bad("Wrong PIN", 401);
  const P = `${code}/`;
  const method = req.method;

  if (resource === "check-pin" && method === "POST") return json({ ok: true, name: meta.name });

  if (resource === "state" && method === "GET") {
    const [setup, ko, scores, koscores] = await Promise.all([
      s.get(P + "setup", { type: "json" }), s.get(P + "ko", { type: "json" }), readMap(P + "scores/"), readMap(P + "koscores/"),
    ]);
    return json({ name: meta.name, setup, ko, scores, koscores, at: Date.now() });
  }

  const setup = (await s.get(P + "setup", { type: "json" })) as any;
  if (!setup) return bad("This tournament has no schedule.", 404);

  if (resource === "score" && id) {
    const n = Number(id);
    if (!isInt(n, 0, setup.matches.length - 1)) return bad("Match not found", 404);
    if (method === "DELETE") { await s.delete(`${P}scores/${n}`); return json({ ok: true }); }
    if (method === "PUT") {
      const body = await readBody(req);
      const sa = Number(body?.sa), sb = Number(body?.sb);
      if (!isInt(sa, 0, 99) || !isInt(sb, 0, 99)) return bad("Enter both scores as whole numbers.");
      if (sa === sb) return bad("Scores can't be tied.");
      await s.setJSON(`${P}scores/${n}`, { sa: String(sa), sb: String(sb), at: Date.now() });
      return json({ ok: true });
    }
  }

  if (resource === "ko" && method === "POST") {
    if (setup.cfg?.format !== "rrko") return bad("This tournament has no knockout.");
    const body = await readBody(req);
    const seeds = body?.seeds;
    const np = setup.players.length;
    if (!Array.isArray(seeds) || ![2, 4, 8, 16, 32].includes(seeds.length)) return bad("Invalid draw.");
    const clean = seeds.map((t: any) => {
      if (t === null) return null;
      if (!Array.isArray(t?.pids) || t.pids.length !== 2 || !t.pids.every((v: unknown) => isInt(v, 0, np - 1))) return undefined;
      return { pids: t.pids, g: isInt(t.g, -1, 7) ? t.g : -1, pos: isInt(t.pos, 0, 31) ? t.pos : 0, tag: String(t.tag ?? "").slice(0, 4) };
    });
    if (clean.some((t: unknown) => t === undefined) || clean.filter(Boolean).length < 2) return bad("Invalid draw.");
    await deletePrefix(P + "koscores/");
    const ko = { seeds: clean, at: Date.now() };
    await s.setJSON(P + "ko", ko);
    return json(ko, 201);
  }

  if (resource === "koscore" && id && method === "PUT") {
    if (!/^\d{1,2}-\d{1,2}$/.test(id)) return bad("Match not found", 404);
    const body = await readBody(req);
    const sig = String(body?.sig ?? "");
    if (!/^[0-9.|a-z]{1,40}$/.test(sig) || !Array.isArray(body?.g) || body.g.length > 3) return bad("Invalid score.");
    const g = body.g.map((x: any) => (Array.isArray(x) && x.length === 2 ? [scoreVal(x[0] ?? ""), scoreVal(x[1] ?? "")] : ["", ""]));
    if (g.some((x: any[]) => x.includes(null))) return bad("Enter scores as whole numbers.");
    await s.setJSON(`${P}koscores/${id}`, { sig, g, at: Date.now() });
    return json({ ok: true });
  }

  return bad("Not found", 404);
};

export const config: Config = {
  path: "/tournament-api/*",
  // Allows a whole club on one wi-fi polling every 15s; slows anyone guessing a PIN.
  rateLimit: { windowLimit: 300, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
