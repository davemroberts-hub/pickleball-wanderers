import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public "Create a tournament" endpoint, kept separate from tournament-api for a tighter rate limit.
// Storage layout (store "tournament"):
//   <code>/meta              { name, pinSalt, pinHash, createdAt }
//   <code>/setup             players, teams, groups and the round robin schedule (fixed once created)
//   <code>/scores/<matchId>  { sa, sb, at }
//   <code>/ko                { seeds, at }  — knockout draw
//   <code>/koscores/<id>     { sig, g, at }
// One record per score so people entering results at the same time never overwrite each other.
// No secrets live in this file: the repository is public.
const store = () => getStore({ name: "tournament", consistency: "strong" });

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => ALPHABET[b % ALPHABET.length]).join("");
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const pick = (v: unknown, allowed: string[], fallback: string) => (allowed.includes(String(v)) ? String(v) : fallback);

// Rebuild the schedule from known fields only, checking every reference.
function cleanSetup(x: any) {
  if (!x || typeof x !== "object") return null;
  const mode = x.mode === "fixed" || x.mode === "rotating" ? x.mode : null;
  if (!mode || !Array.isArray(x.players) || !Array.isArray(x.units) || !Array.isArray(x.groups) || !Array.isArray(x.matches)) return null;
  if (x.players.length < 4 || x.players.length > 32) return null;
  const players = x.players.map((p: any, i: number) => ({ id: i, name: String(p?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) }));
  if (players.some((p: any) => !p.name)) return null;
  const pidsOk = (a: unknown, len: number) => Array.isArray(a) && a.length === len && a.every(v => isInt(v, 0, players.length - 1)) && new Set(a).size === a.length;
  const unitSize = mode === "fixed" ? 2 : 1;
  if (x.units.length > 32) return null;
  const units = x.units.map((u: any, i: number) => (pidsOk(u?.pids, unitSize) ? { id: i, pids: u.pids } : null));
  if (units.some((u: any) => !u)) return null;
  if (x.groups.length < 1 || x.groups.length > 8) return null;
  const groups = x.groups.map((g: any, i: number) =>
    Array.isArray(g?.ids) && g.ids.every((v: unknown) => isInt(v, 0, units.length - 1)) ? { name: "ABCDEFGH"[i], ids: g.ids } : null);
  if (groups.some((g: any) => !g)) return null;
  if (x.matches.length < 1 || x.matches.length > 400) return null;
  const matches = x.matches.map((m: any, i: number) => {
    if (!isInt(m?.round, 1, 999) || !isInt(m?.court, 1, 16) || !isInt(m?.g, 0, groups.length - 1)) return null;
    if (!pidsOk(m.a, 2) || !pidsOk(m.b, 2) || new Set([...m.a, ...m.b]).size !== 4) return null;
    const out: any = { id: i, round: m.round, court: m.court, g: m.g, a: m.a, b: m.b };
    if (mode === "fixed") {
      if (!isInt(m.ua, 0, units.length - 1) || !isInt(m.ub, 0, units.length - 1)) return null;
      out.ua = m.ua; out.ub = m.ub;
    }
    return out;
  });
  if (matches.some((m: any) => !m)) return null;
  const c = x.cfg || {};
  const cfg = {
    mode,
    format: pick(c.format, ["rr", "rrko"], "rr"),
    groups: String(groups.length),
    courts: String(isInt(Number(c.courts), 1, 16) ? Number(c.courts) : 1),
    rrPts: pick(c.rrPts, ["11", "15"], "11"),
    qual: String(isInt(Number(c.qual), 1, 8) ? Number(c.qual) : 2),
    koPts: pick(c.koPts, ["11", "15"], "11"),
    koBo: pick(c.koBo, ["1", "3", "f3"], "1"),
  };
  return { mode, cfg, players, units, groups, matches };
}

export default async (req: Request) => {
  if (req.method !== "POST") return bad("Not found", 404);
  let body: any;
  try { body = await req.json(); } catch { return bad("Invalid request"); }
  if (body?.website) return bad("Couldn't create the tournament."); // hidden field bots fill in

  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const pin = body?.pin;
  if (name.length < 2) return bad("Give the tournament a name.");
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return bad("PIN: 4 to 8 digits.");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin))
    return bad("Choose a PIN that's harder to guess than repeated or sequential digits.");
  const setup = cleanSetup(body?.setup);
  if (!setup) return bad("The schedule couldn't be read. Reload the page and try again.");

  const s = store();
  const ps = hex(12);
  const meta = { name, pinSalt: ps, pinHash: await sha256(ps + pin), createdAt: Date.now() };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    // The site's @netlify/blobs (v8) has no conditional writes, so check first.
    // Codes are random from ~887 million options, so a clash in between is not a real risk.
    if ((await s.get(`${code}/meta`)) !== null) continue;
    await s.setJSON(`${code}/meta`, meta);
    await s.setJSON(`${code}/setup`, setup);
    return json({ code, name }, 201);
  }
  return bad("Couldn't create the tournament. Please try again.", 500);
};

export const config: Config = {
  path: "/tournament-create",
  method: "POST",
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
