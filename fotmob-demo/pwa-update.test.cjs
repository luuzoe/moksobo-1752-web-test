'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const workerSource = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

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
