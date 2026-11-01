const CACHE_NAME = 'matchday-shell-v12';
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './clock.js',
  './news.js',
  './league.js',
  './pwa.js',
  './app.js',
  './manifest.webmanifest',
  './brand-options.html',
  './icons/matchday-180.png',
  './icons/matchday-192.png',
  './icons/matchday-512.png',
  './icons/matchday-maskable-512.png',
  './icons/option-a-football-badge.svg',
  './icons/option-b-ball-m.svg',
  './data/news.json',
  './data/matches.json'
];

function cacheKeyFor(request, scopeURL) {
  const url = new URL(request.url);
  if (request.mode === 'navigate' && url.pathname !== new URL('./brand-options.html', scopeURL).pathname) {
    url.pathname = new URL('./index.html', scopeURL).pathname;
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_FILES.map(async path => {
      try {
        const url = new URL(path, self.location.href);
        const response = await fetch(url.href, { cache: 'reload' });
        if (response.ok) await cache.put(url.href, response.clone());
      } catch (_) {
        // Keep installation available if a nonessential shell asset is temporarily unreachable.
      }
    }));
    // Install the update monitor promptly; later site revisions are announced in-app.
    await self.skipWaiting();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (!event.data || event.data.type !== 'REFRESH_SHELL') return;
  const replyPort = event.ports && event.ports[0];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_FILES.map(async path => {
      try {
        const url = new URL(path, self.location.href);
        const response = await fetch(url.href, { cache: 'reload' });
        if (response.ok && response.type === 'basic') await cache.put(url.href, response.clone());
      } catch (_) {
        // Retain the cached file if a refresh is temporarily unavailable.
      }
    }));
    if (replyPort) replyPort.postMessage({ type: 'SHELL_REFRESHED' });
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('matchday-shell-') && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestURL = new URL(request.url);
  const scopeURL = new URL('./', self.location.href);
  if (requestURL.origin !== scopeURL.origin || !requestURL.pathname.startsWith(scopeURL.pathname)) return;

  const key = cacheKeyFor(request, scopeURL);
  const cachePromise = caches.open(CACHE_NAME);
  const refreshPromise = fetch(request).then(async response => {
    if (response && response.ok && response.type === 'basic') {
      const cache = await cachePromise;
      await cache.put(key, response.clone());
    }
    return response;
  });

  // Keep the background refresh alive after returning a cached response.
  event.waitUntil(refreshPromise.then(() => undefined).catch(() => undefined));
  event.respondWith((async () => {
    const cache = await cachePromise;
    const cached = await cache.match(key);
    if (cached && request.cache !== 'no-store') return cached;

    try {
      const fresh = await refreshPromise;
      if (fresh && fresh.ok) return fresh;
      if (cached) return cached;
      return fresh;
    } catch (_) {
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const offlinePage = await cache.match(new URL('./index.html', scopeURL).href);
        if (offlinePage) return offlinePage;
      }
      return new Response('Matchday is offline and this item is not cached yet.', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
