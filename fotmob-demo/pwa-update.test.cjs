'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const workerSource = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const pwaSource = fs.readFileSync(path.join(__dirname, 'pwa.js'), 'utf8');

test('refresh-shell message updates cached app assets and acknowledges completion', async () => {
  const handlers = {};
  const cached = new Map();
  const replies = [];
  let fetchCount = 0;
  const cache = {
    async put(url, response) { cached.set(url, response); },
    async match(url) { return cached.get(url); },
  };
  const self = {
    location: { href: 'https://luuzoe.github.io/moksobo-1752-web-test/fotmob-demo/sw.js' },
    addEventListener(type, listener) { handlers[type] = listener; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(workerSource, {
    self,
    URL,
    Promise,
    Response,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async url => {
      fetchCount += 1;
      return { ok: true, type: 'basic', url, clone() { return { url }; } };
    },
  }, { filename: 'sw.js' });

  let refreshFinished;
  handlers.message({
    data: { type: 'REFRESH_SHELL' },
    ports: [{ postMessage(message) { replies.push(message); } }],
    waitUntil(promise) { refreshFinished = promise; },
  });
  await refreshFinished;

  assert.ok(fetchCount >= 15, 'refreshes the full app shell, including match data');
  assert.equal(cached.size, fetchCount);
  assert.deepEqual(replies.map(reply => reply.type), ['SHELL_REFRESHED']);
  assert.ok([...cached.keys()].some(url => url.endsWith('/data/matches.json')));
});

test('refresh-shell keeps the old cache and reports failure when a required asset is missing', async () => {
  const handlers = {};
  const cached = new Map([['https://luuzoe.github.io/moksobo-1752-web-test/fotmob-demo/app.js', { version: 'old' }]]);
  const replies = [];
  const cache = {
    async put(url, response) { cached.set(url, response); },
    async match(url) { return cached.get(url); },
  };
  const self = {
    location: { href: 'https://luuzoe.github.io/moksobo-1752-web-test/fotmob-demo/sw.js' },
    addEventListener(type, listener) { handlers[type] = listener; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(workerSource, {
    self,
    URL,
    Promise,
    Response,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async url => ({
      ok: !url.endsWith('/app.js'),
      type: 'basic',
      url,
      clone() { return { url, version: 'new' }; },
    }),
  }, { filename: 'sw.js' });

  let refreshFinished;
  handlers.message({
    data: { type: 'REFRESH_SHELL' },
    ports: [{ postMessage(message) { replies.push(message); } }],
    waitUntil(promise) { refreshFinished = promise; },
  });
  await refreshFinished;

  assert.deepEqual(replies.map(reply => reply.type), ['SHELL_REFRESH_FAILED']);
  assert.deepEqual(cached.get('https://luuzoe.github.io/moksobo-1752-web-test/fotmob-demo/app.js'), { version: 'old' });
  assert.equal(cached.size, 1, 'does not partially replace the current shell');
});

test('installed PWA checks for app and site updates every five minutes', async () => {
  const storage = new Map();
  const clock = { now: 1_000_000 };
  const intervals = [];
  let fetchCount = 0;
  const registration = {
    waiting: null,
    installing: null,
    async update() {},
    addEventListener() {},
  };
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { hidden: true, addEventListener() {}, focus() {} });
      return elements.get(id);
    },
    addEventListener() {},
    visibilityState: 'hidden',
  };
  const window = {
    location: { reload() {} },
    matchMedia() { return { matches: true, addEventListener() {} }; },
    addEventListener() {},
    setInterval(callback, milliseconds) { intervals.push({ callback, milliseconds }); },
    setTimeout() {},
  };
  const navigator = {
    userAgent: 'Test browser',
    platform: 'Linux',
    maxTouchPoints: 0,
    onLine: true,
    serviceWorker: {
      controller: {},
      addEventListener() {},
      async register() { return registration; },
    },
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  class TestDate extends Date {
    static now() { return clock.now; }
  }

  vm.runInNewContext(pwaSource, {
    document,
    window,
    navigator,
    localStorage,
    location: { protocol: 'https:', hostname: 'luuzoe.github.io' },
    fetch: async () => {
      fetchCount += 1;
      return { ok: true, async json() { return [{ sha: 'version-1' }]; } };
    },
    Date: TestDate,
    console: { warn() {} },
  }, { filename: 'pwa.js' });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 5 * 60 * 1000);
  assert.equal(fetchCount, 1);

  clock.now += 5 * 60 * 1000 - 1;
  await intervals[0].callback();
  assert.equal(fetchCount, 1, 'does not fetch the site version before five minutes');

  clock.now += 1;
  await intervals[0].callback();
  assert.equal(fetchCount, 2, 'fetches the site version once five minutes have elapsed');
});

test('does not reload after a failed shell refresh and offers a retry', async () => {
  const storage = new Map([['matchday-site-version', 'version-old']]);
  const listeners = new Map();
  const elements = new Map();
  let reloadCount = 0;
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: true,
        disabled: false,
        textContent: '',
        addEventListener(type, callback) { listeners.set(id, callback); },
        focus() {},
      });
    }
    return elements.get(id);
  };
  const activeWorker = {
    postMessage(message, ports) {
      assert.equal(message.type, 'REFRESH_SHELL');
      ports[0].postMessage({ type: 'SHELL_REFRESH_FAILED' });
    },
  };
  const registration = { waiting: null, installing: null, async update() {}, addEventListener() {} };
  const document = {
    getElementById: element,
    addEventListener() {},
    visibilityState: 'hidden',
  };
  const window = {
    location: { reload() { reloadCount += 1; } },
    matchMedia() { return { matches: true, addEventListener() {} }; },
    addEventListener() {},
    setInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  const navigator = {
    userAgent: 'Test browser',
    platform: 'Linux',
    maxTouchPoints: 0,
    onLine: true,
    serviceWorker: {
      controller: activeWorker,
      addEventListener() {},
      async register() { return registration; },
    },
  };
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = {
        postMessage: data => this.port1.onmessage && this.port1.onmessage({ data }),
        close() {},
      };
    }
  }

  vm.runInNewContext(pwaSource, {
    document,
    window,
    navigator,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    location: { protocol: 'https:', hostname: 'luuzoe.github.io' },
    fetch: async () => ({ ok: true, async json() { return [{ sha: 'version-new' }]; } }),
    MessageChannel: TestMessageChannel,
    console: { warn() {} },
  }, { filename: 'pwa.js' });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('pwa-update-banner').hidden, false, 'shows the available update');
  listeners.get('pwa-update-action')();

  assert.equal(reloadCount, 0, 'keeps the currently loaded app open');
  assert.equal(element('pwa-update-action').disabled, false);
  assert.equal(element('pwa-update-action').textContent, 'Try again');
  assert.equal(storage.get('matchday-site-version'), 'version-old', 'does not mark a failed update as installed');
});
