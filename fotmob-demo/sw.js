const CACHE_NAME = 'matchday-shell-v1';
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
  './icons/matchday-180.png',
  './icons/matchday-192.png',
  './icons/matchday-512.png',
  './icons/matchday-maskable-512.png',
  './data/news.json',
  './data/matches.json',
  './data/espn/teams.json'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_FILES.map(async path => {
      try {
        const url = new URL(path, self.location.href);
        const response = await fetch(url.href, { cache: 'reload' });
        if (response.ok) await cache.put(url.href, response.clone());
      } catch (_) {
        // Keep installation available even if a nonessential shell asset is temporarily unreachable.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('matchday-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const requestURL = new URL(request.url);
  const scopeURL = new URL('./', self.location.href);
  if (requestURL.origin !== scopeURL.origin || !requestURL.pathname.startsWith(scopeURL.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      const cached = await cache.match(request, { ignoreSearch: true });
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
