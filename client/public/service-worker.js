const version = new URL(self.location.href).searchParams.get("v") || "dev";
const cacheName = `rehearsal-partner-${version}`;
const appShellUrl = new URL("./index.html", self.registration.scope).toString();
const precacheUrls = [
  new URL("./", self.registration.scope).toString(),
  appShellUrl,
  new URL("./manifest.webmanifest", self.registration.scope).toString(),
  new URL("./favicon.png", self.registration.scope).toString(),
  new URL("./app-icon.svg", self.registration.scope).toString(),
  new URL("./app-icon-maskable.svg", self.registration.scope).toString(),
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(cacheName).then((cache) => cache.addAll(precacheUrls)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => (key !== cacheName ? caches.delete(key) : Promise.resolve(false))),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          void caches.open(cacheName).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(cacheName);
          return (await cache.match(request)) || (await cache.match(appShellUrl));
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            void caches.open(cacheName).then((cache) => cache.put(request, responseClone));
          }
          return response;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkFetch;
    }),
  );
});
