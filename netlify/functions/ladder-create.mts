import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public "Start a ladder" endpoint. Kept separate from ladder-api so it can have a much
// tighter rate limit. Same storage layout: <slug>/meta = { name, pinSalt, pinHash, createdAt }.
const store = () => getStore({ name: "ladder", consistency: "strong" });

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED = new Set(["admin", "api", "app", "index", "new", "main", "start", "create", "ladders", "_admin", "_list"]);

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const salt = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

export default async (req: Request) => {
  if (req.method !== "POST") return bad("Not found", 404);
  let body: any;
  try { body = await req.json(); } catch { return bad("Invalid request"); }

  // Hidden field real people never see or fill in; bots usually do.
  if (body?.website) return bad("Couldn't create the ladder.");

  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  const pin = body?.pin;
  if (name.length < 3) return bad("Give your ladder a name of at least 3 characters.");
  if (!SLUG_RE.test(slug)) return bad("Web address: 2–31 lowercase letters, numbers or dashes.");
  if (RESERVED.has(slug)) return bad("That web address is reserved. Try another.", 409);
  if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) return bad("PIN: 4 to 8 digits.");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) return bad("Choose a PIN that's harder to guess than repeated or sequential digits.");

  const s = store();
  if ((await s.get(`${slug}/meta`)) !== null) return bad("A ladder with that web address already exists. Try another.", 409);
  const ps = salt();
  await s.setJSON(`${slug}/meta`, { name, pinSalt: ps, pinHash: await sha256(ps + pin), createdAt: Date.now(), createdVia: "public" });
  return json({ slug, name }, 201);
};

export const config: Config = {
  path: "/ladder-create",
  method: "POST",
  rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
