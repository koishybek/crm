// Service worker Home Max Service (ТЗ п.23.6): уведомления на телефон (web push) и офлайн-оболочка.
// Регистрируется только после входа (src/data/serviceWorker.ts). Данные (Convex) не кешируются — только файлы сборки:
// /assets/* (имена с хэшем, неизменны) — из кеша; страницы — из сети, при ошибке сервера — сохранённая index.html,
// без сети — экран «Нет связи».
"use strict";

const SHELL = "hms-shell-v1";
const ASSETS = "hms-assets-v1";
const KEEP = [SHELL, ASSETS];
/** Файлов сборки в кеше — не больше: старые версии вытесняются. */
const MAX_ASSETS = 120;
const NAV_TIMEOUT_MS = 10000;

const OFFLINE_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Нет связи — Home Max Service</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f6f2;color:#1c1c1e;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:340px;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 20px;color:#57534e}
button{min-height:48px;padding:0 24px;border:0;border-radius:12px;background:#ffc629;color:#1c1c1e;font:600 16px system-ui,sans-serif;cursor:pointer}</style></head>
<body><main><h1>Нет связи</h1><p>Проверьте интернет — как только он появится, страница откроется сама.</p><button type="button" onclick="location.reload()">Повторить</button></main>
<script>addEventListener("online",function(){location.reload()})</script></body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/manifest.webmanifest", "/icons/icon-192.png"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("hms-") && !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function trimAssets() {
  const cache = await caches.open(ASSETS);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((k) => cache.delete(k)));
}

/** Файл сборки: из кеша, иначе из сети с сохранением. */
async function asset(request) {
  const cached = await caches.match(request, { cacheName: ASSETS });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, res.clone());
    trimAssets().catch(() => undefined);
  }
  return res;
}

const offline = () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

/** Страница: из сети (свежая index.html сохраняется); сервер ответил ошибкой — сохранённая; сети нет — «Нет связи». */
async function page(request) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NAV_TIMEOUT_MS);
  try {
    const res = await fetch(request, { signal: ctrl.signal });
    const html = (res.headers.get("content-type") || "").includes("text/html");
    if (res.ok && html) {
      const cache = await caches.open(SHELL);
      await cache.put("/index.html", res.clone());
      return res;
    }
    if (res.status >= 500) return (await caches.match("/index.html", { cacheName: SHELL })) || res;
    return res;
  } catch {
    return offline();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") event.respondWith(page(req));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(asset(req));
});

// ── Уведомления ──────────────────────────────────────────────────────────────

/** Только путь внутри приложения: внешние адреса из уведомления не открываем. */
const safeLink = (link) => (typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : "/");

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Home Max Service";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      lang: "ru",
      data: { link: safeLink(data.link) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = safeLink(event.notification.data && event.notification.data.link);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.focus().then((c) => (c && "navigate" in c ? c.navigate(link) : undefined));
      return self.clients.openWindow(link);
    }),
  );
});
