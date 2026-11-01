import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { myanmarScoreboardDates, ScoreboardPoller } from './worker.mjs';

const MONITOR_NAME = 'matchday-espn-live';

class FakeStorage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}

function poller(name = MONITOR_NAME) {
  const storage = new FakeStorage();
  const instance = new ScoreboardPoller({ id: { name }, storage }, {});
  return { instance, storage };
}

test('Myanmar matchday spans the expected pair of UTC scoreboard dates', () => {
  const now = Date.UTC(2026, 10, 1, 19, 56);
  assert.deepEqual(myanmarScoreboardDates(now), ['20261101', '20261102']);
});

test('ensure arms one aggregate alarm and rejects obsolete date-specific objects', async () => {
  const { instance, storage } = poller();
  const good = await instance.fetch(new Request('https://internal/ensure'));
  assert.equal(good.status, 200);
  assert.ok(storage.alarm > Date.now());
  const first = storage.alarm;
  await instance.fetch(new Request('https://internal/ensure'));
  assert.equal(storage.alarm, first);
  const obsolete = poller('matchday-espn-20261101');
  assert.equal((await obsolete.instance.fetch(new Request('https://internal/ensure'))).status, 404);
});

test('first snapshot read arms monitoring, then caches both UTC dates and hot leagues refresh quickly', async () => {
  const { instance, storage } = poller();
  const starting = await instance.fetch(new Request('https://internal/snapshot'));
  assert.equal(starting.status, 503);
  assert.ok(storage.alarm > Date.now());

  const now = Date.UTC(2026, 10, 1, 19, 56);
  const dates = myanmarScoreboardDates(now);
  const previousFetch = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async value => {
    const url = new URL(String(value));
    const code = url.pathname.match(/soccer\/([^/]+)\/scoreboard/)?.[1] || '';
    const dateCode = url.searchParams.get('dates');
    calls.push(`${code}:${dateCode}`);
    const events = code === 'eng.1' && dateCode === dates[0]
      ? [{ id: 'game-1', date: new Date(now + 5 * 60_000).toISOString(), status: { type: { state: 'pre' } } }]
      : [];
    return new Response(JSON.stringify({ events, leagues: [{ slug: code, season: { year: 2026 }, logos: [] }] }), { status: 200 });
  };
  try {
    await instance.pollDueLeagues(now);
    assert.equal(calls.length, 52);
    const saved = await storage.get('snapshot');
    assert.equal(saved.dates[dates[0]].leagues['eng.1'].events[0].id, 'game-1');
    assert.equal(saved.dates[dates[0]].leagues['eng.1'].seasonYear, 2026);
    assert.ok(saved.dates[dates[1]].leagues['eng.1']);
    calls = [];
    await instance.pollDueLeagues(now + 11_000);
    assert.deepEqual(calls, [`eng.1:${dates[0]}`]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('public API returns both date snapshots using one Durable Object read and restricts CORS', async () => {
  const dates = myanmarScoreboardDates();
  let doReads = 0;
  const snapshot = {
    provider: 'ESPN',
    updatedAt: new Date().toISOString(),
    dates: Object.fromEntries(dates.map(dateCode => [dateCode, {
      dateCode, updatedAt: new Date().toISOString(), leagues: { 'eng.1': { events: [] } }
    }]))
  };
  const env = { SCORE_POLLERS: {
    idFromName(name) { assert.equal(name, MONITOR_NAME); return name; },
    get() { return { fetch: async request => {
      doReads += 1;
      const requestUrl = typeof request === 'string' ? request : request.url;
      if (new URL(requestUrl).pathname === '/status') {
        return new Response(JSON.stringify({ ok: true, ready: true, monitors: dates.map(dateCode => ({ dateCode, cachedLeagues: 26 })) }), { status: 200 });
      }
      return new Response(JSON.stringify(snapshot), { status: 200 });
    } }; }
  } };
  const allowed = await worker.fetch(new Request(`https://worker.example/api/live?dates=${dates.join(',')}`, { headers: { Origin: 'https://luuzoe.github.io' } }), env);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://luuzoe.github.io');
  const body = await allowed.json();
  assert.deepEqual(Object.keys(body.dates), dates);
  assert.equal(doReads, 1);
  const health = await worker.fetch(new Request('https://worker.example/health', { headers: { Origin: 'https://luuzoe.github.io' } }), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ready, true);
  assert.equal(doReads, 2);
  const denied = await worker.fetch(new Request('https://worker.example/api/live', { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(denied.status, 403);
  assert.equal(doReads, 2);
});
