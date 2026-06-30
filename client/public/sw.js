// tradesnow.vip — Service Worker v3.5
// Strategy:
//   • Hashed JS/CSS bundles (e.g. index.Abc123.js) → Cache-First (immutable, safe)
//   • HTML / manifest / unlisted assets → Network-First with cache fallback
//   • /api/* and /api/trpc → Always network (never cache trading data)
//   • External fonts (fonts.googleapis.com, fonts.gstatic.com) → Cache-First (stable)

const CACHE_STATIC = "tradesnow-static-v25";   // hashed bundles + fonts
const CACHE_SHELL  = "tradesnow-shell-v25";    // HTML shell + manifest

const PRECACHE_URLS = ["/", "/manifest.json"];

// ── Install: pre-cache the app shell (wait for activation via client message) ─
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting(); // Force immediate activation — push new build
});

// ── Message: respond to SKIP_WAITING from client ──────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ── Activate: evict old caches ────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  const VALID = new Set([CACHE_STATIC, CACHE_SHELL]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !VALID.has(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Skip non-GET and all API/tRPC calls — never cache trading data
  if (
    req.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/api/trpc")
  ) {
    return;
  }

  // 2. Cache-First for hashed static bundles (Vite adds 8-char hex hash)
  const isHashedAsset = /\.[0-9a-f]{8,}\.(js|css|woff2?)(\?.*)?$/.test(url.pathname);
  // Google Fonts (CSS + woff2) are cross-origin/opaque — let the browser handle them natively.
  // Intercepting them in the SW produced synthetic 503s on opaque-response cache misses.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    return;
  }

  const isExternalFont = false;

  if (isHashedAsset || isExternalFont) {
    event.respondWith(
      caches.open(CACHE_STATIC).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const response = await fetch(req);
          if (response.ok) cache.put(req, response.clone());
          return response;
        } catch (err) {
          // Network failed (e.g. cross-origin font fetch rejected) — fall back to cache, else a clean error
          return (await cache.match(req)) || Response.error();
        }
      })
    );
    return;
  }

  // 3. Network-First for HTML, manifest, and everything else
  event.respondWith(
    fetch(req)
      .then((response) => {
        if (response.ok && (url.pathname === "/" || url.pathname === "/manifest.json")) {
          caches.open(CACHE_SHELL).then((cache) => cache.put(req, response.clone()));
        }
        return response;
      })
      .catch(() =>
        // Offline fallback: try cache, then app shell
        caches.match(req).then((r) => r || caches.match("/"))
      )
  );
});
