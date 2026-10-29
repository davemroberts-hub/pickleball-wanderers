// Keeps the app shell available offline; ladder data always comes fresh from /ladder-api.
const CACHE = "ladder-shell-v3";
const SHELL = ["/ladder/app.html", "/ladder/", "/ladder/icon.svg", "/ladder/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/ladder/")) return;
  // network first so updates show straight away; offline, any ladder address falls back to the cached app
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === "navigate" ? caches.match(url.pathname === "/ladder/" ? "/ladder/" : "/ladder/app.html") : undefined))));
});
