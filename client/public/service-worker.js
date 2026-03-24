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

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function broadcastDebugLog(event, details) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });

  const payload = {
    type: "pwa-debug-log",
    event,
    details,
    timestamp: new Date().toISOString(),
  };

  for (const client of clients) {
    client.postMessage(payload);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await broadcastDebugLog(
        "Service Worker Install",
        `version=${version} | cache=${cacheName} | assets=${precacheUrls.length}`,
      );
      const cache = await caches.open(cacheName);
      await cache.addAll(precacheUrls);
      await self.skipWaiting();
      await broadcastDebugLog(
        "Service Worker Install Complete",
        `cache=${cacheName}`,
      );
    })().catch(async (error) => {
      await broadcastDebugLog(
        "Service Worker Install Error",
        getErrorMessage(error),
      );
      throw error;
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const deletedCacheCount = (
        await Promise.all(
          keys.map((key) => (key !== cacheName ? caches.delete(key) : Promise.resolve(false))),
        )
      ).filter(Boolean).length;

      await self.clients.claim();
      await broadcastDebugLog(
        "Service Worker Activated",
        `cache=${cacheName} | deleted-caches=${deletedCacheCount}`,
      );
    })().catch(async (error) => {
      await broadcastDebugLog(
        "Service Worker Activate Error",
        getErrorMessage(error),
      );
      throw error;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    void broadcastDebugLog("Service Worker Skip Waiting");
    void self.skipWaiting();
    return;
  }

  if (event.data?.type !== "pwa-debug-snapshot") {
    return;
  }

  void broadcastDebugLog(
    "Service Worker Snapshot",
    `version=${version} | cache=${cacheName} | scope=${self.registration.scope}`,
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
        .catch(async (error) => {
          await broadcastDebugLog(
            "Service Worker Navigate Fallback",
            `${request.url} | ${getErrorMessage(error)}`,
          );
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
