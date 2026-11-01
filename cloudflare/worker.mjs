const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SITE_ORIGIN = 'https://luuzoe.github.io';
const MONITOR_NAME = 'matchday-espn-live';
const POLL_INTERVAL_MS = 10_000;
const HOT_REFRESH_MS = 10_000;
const COLD_REFRESH_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 30_000;
const HOT_BEFORE_KICKOFF_MS = 60 * 60_000;
const HOT_AFTER_KICKOFF_MS = 4 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_PARALLEL_FETCHES = 6;
const DAY_MS = 24 * 60 * 60_000;
const MYANMAR_OFFSET_MS = 390 * 60_000;
const LEAGUES = [
  'eng.1', 'eng.2', 'eng.3', 'eng.4', 'eng.fa', 'eng.league_cup',
  'esp.1', 'esp.2', 'esp.copa_del_rey', 'ger.1', 'ger.2', 'ger.dfb_pokal',
  'ita.1', 'ita.2', 'ita.coppa_italia', 'fra.1', 'fra.2', 'ned.1', 'por.1',
  'bel.1', 'sco.1', 'usa.1', 'mex.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf'
];

function dateCodeAt(timestamp) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function myanmarScoreboardDates(now = Date.now()) {
  const local = new Date(now + MYANMAR_OFFSET_MS);
  const startUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - MYANMAR_OFFSET_MS;
  return [...new Set([dateCodeAt(startUtc), dateCodeAt(startUtc + DAY_MS - 1)])];
}

function jsonResponse(body, status = 200, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
  if (!origin || origin === SITE_ORIGIN) headers['Access-Control-Allow-Origin'] = origin || SITE_ORIGIN;
  return new Response(JSON.stringify(body), { status, headers });
}

function corsOptions(request) {
  const origin = request.headers.get('Origin') || '';
  if (origin && origin !== SITE_ORIGIN) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || SITE_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  });
}

function safeDateCodes(raw) {
  const current = myanmarScoreboardDates();
  if (!raw) return current;
  const dates = raw.split(',').map(value => value.trim());
  if (dates.length < 1 || dates.length > 2 || dates.some(value => !/^\d{8}$/.test(value))) return null;
  return dates.join(',') === current.join(',') ? dates : null;
}

function getMonitor(env) {
  const id = env.SCORE_POLLERS.idFromName(MONITOR_NAME);
  return env.SCORE_POLLERS.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return corsOptions(request);
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    if (origin && origin !== SITE_ORIGIN) return jsonResponse({ error: 'Origin not allowed' }, 403, origin);

    if (url.pathname === '/health') {
      const response = await getMonitor(env).fetch('https://score-poller.internal/status');
      if (!response.ok) return jsonResponse({ ok: false, ready: false, error: 'Monitor status unavailable' }, 503, origin);
      return jsonResponse(await response.json(), 200, origin);
    }
    if (url.pathname !== '/api/live') return jsonResponse({ error: 'Not found' }, 404, origin);
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, origin);

    const dates = safeDateCodes(url.searchParams.get('dates'));
    if (!dates) return jsonResponse({ error: 'Only the current Myanmar matchday is available on the live monitor' }, 400, origin);
    const response = await getMonitor(env).fetch('https://score-poller.internal/snapshot');
    if (!response.ok) {
      return jsonResponse({ error: 'Live monitor is starting; retry shortly', provider: 'ESPN', dates: {} }, 503, origin);
    }
    const snapshot = await response.json();
    const datePayloads = Object.fromEntries(dates
      .filter(dateCode => snapshot.dates?.[dateCode] && Object.keys(snapshot.dates[dateCode].leagues || {}).length)
      .map(dateCode => [dateCode, snapshot.dates[dateCode]]));
    const available = Object.values(datePayloads);
    if (!available.length) {
      return jsonResponse({ error: 'Live monitor is starting; retry shortly', provider: 'ESPN', dates: {} }, 503, origin);
    }
    const updated = available.map(item => Date.parse(item.updatedAt)).filter(Number.isFinite);
    return jsonResponse({
      provider: 'ESPN',
      fetchedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
      partial: available.length !== dates.length,
      dates: datePayloads
    }, 200, origin);
  },

  async scheduled(_controller, env, context) {
    const responsePromise = getMonitor(env).fetch('https://score-poller.internal/ensure');
    context.waitUntil(responsePromise.then(response => {
      if (!response.ok) throw new Error(`Could not initialize scoreboard monitor: HTTP ${response.status}`);
    }));
  }
};

export class ScoreboardPoller {
  constructor(state, _env) {
    this.state = state;
    this.objectName = state.id.name || '';
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (this.objectName !== MONITOR_NAME) return new Response('Inactive monitor', { status: 404 });
    if (url.pathname === '/ensure') {
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return new Response('Monitor armed', { status: 200 });
    }
    if (url.pathname === '/status') return this.status();
    if (url.pathname !== '/snapshot') return new Response('Not found', { status: 404 });
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    const snapshot = await this.state.storage.get('snapshot');
    const ready = Object.values(snapshot?.dates || {}).some(day => Object.keys(day.leagues || {}).length > 0);
    if (!ready) return new Response('Monitor starting', { status: 503 });
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  async status() {
    const snapshot = await this.state.storage.get('snapshot');
    const alarm = await this.state.storage.getAlarm();
    const dates = myanmarScoreboardDates().map(dateCode => {
      const day = snapshot?.dates?.[dateCode];
      return {
        dateCode,
        cachedLeagues: Object.keys(day?.leagues || {}).length,
        lastUpdatedAt: day?.updatedAt || null,
        failedCount: day?.failedLeagues?.length || 0,
        failureSamples: Object.entries(day?.lastErrors || {}).slice(0, 3)
      };
    });
    return new Response(JSON.stringify({
      ok: true,
      provider: 'ESPN',
      monitor: 'Single Durable Object; 10-second alarms for hot competitions',
      ready: dates.some(day => day.cachedLeagues > 0),
      armed: alarm !== null,
      alarmAt: alarm ? new Date(alarm).toISOString() : null,
      monitors: dates
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  async alarm() {
    // Stop any old date-specific objects from the previous deployment. The single
    // aggregate monitor is the only object that keeps rescheduling itself.
    if (this.objectName !== MONITOR_NAME) return;
    try {
      await this.pollDueLeagues();
    } catch (error) {
      console.warn(`Scoreboard monitor failed:`, error?.name || 'Error');
    } finally {
      if (this.objectName === MONITOR_NAME) await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  async pollDueLeagues(now = Date.now()) {
    const dateCodes = myanmarScoreboardDates(now);
    const snapshot = await this.state.storage.get('snapshot') || { provider: 'ESPN', updatedAt: null, dates: {} };
    snapshot.dates ||= {};
    for (const oldDate of Object.keys(snapshot.dates)) if (!dateCodes.includes(oldDate)) delete snapshot.dates[oldDate];

    const due = [];
    for (const dateCode of dateCodes) {
      const day = snapshot.dates[dateCode] ||= { dateCode, updatedAt: null, leagues: {}, lastAttempts: {}, failedLeagues: [], lastErrors: {} };
      day.lastAttempts ||= {};
      day.lastErrors ||= {};
      for (const code of LEAGUES) {
        const previous = day.leagues[code];
        const lastAttempt = Number(day.lastAttempts[code]) || 0;
        const interval = previous
          ? (isHotBoard(previous.events, now) ? HOT_REFRESH_MS : COLD_REFRESH_MS)
          : FAILURE_RETRY_MS;
        if (!lastAttempt || now - lastAttempt >= interval) due.push({ code, dateCode });
      }
    }
    if (!due.length) return;

    const successesByDate = new Set();
    for (let offset = 0; offset < due.length; offset += MAX_PARALLEL_FETCHES) {
      const batch = due.slice(offset, offset + MAX_PARALLEL_FETCHES);
      const results = await Promise.all(batch.map(({ code, dateCode }) => fetchScoreboard(code, dateCode, now)));
      for (const result of results) {
        const day = snapshot.dates[result.dateCode];
        day.lastAttempts[result.code] = now;
        if (!result.ok) {
          const failed = new Set(day.failedLeagues || []);
          failed.add(result.code);
          day.failedLeagues = [...failed];
          day.lastErrors[result.code] = result.error;
          continue;
        }
        day.failedLeagues = (day.failedLeagues || []).filter(code => code !== result.code);
        delete day.lastErrors[result.code];
        day.leagues[result.code] = result.board;
        successesByDate.add(result.dateCode);
      }
    }
    for (const dateCode of successesByDate) snapshot.dates[dateCode].updatedAt = new Date(now).toISOString();
    if (successesByDate.size) snapshot.updatedAt = new Date(now).toISOString();
    await this.state.storage.put('snapshot', snapshot);
  }
}

function isHotBoard(events, now) {
  if (!Array.isArray(events)) return false;
  return events.some(event => {
    const kickoff = Date.parse(event?.date);
    if (!Number.isFinite(kickoff)) return false;
    const gameState = String(event?.status?.type?.state || '').toLowerCase();
    return gameState === 'in' || (kickoff >= now - HOT_AFTER_KICKOFF_MS && kickoff <= now + HOT_BEFORE_KICKOFF_MS);
  });
}

async function fetchScoreboard(code, dateCode, attemptedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${ESPN_BASE}/${encodeURIComponent(code)}/scoreboard?dates=${dateCode}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'MatchdayScoreMonitor/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const competitions = Array.isArray(payload.leagues) ? payload.leagues : [];
    const league = competitions.find(item => item.slug === code) || competitions[0] || {};
    const logos = Array.isArray(league.logos) ? league.logos : [];
    const logo = logos.find(item => Array.isArray(item.rel) && item.rel.includes('default')) || logos[0];
    return {
      ok: true,
      code,
      dateCode,
      board: {
        events: Array.isArray(payload.events) ? payload.events : [],
        logo: logo?.href || '',
        calendar: Array.isArray(league.calendar) ? league.calendar : [],
        seasonYear: Number(league.season?.year) || null,
        fetchedAt: new Date(attemptedAt).toISOString()
      }
    };
  } catch (error) {
    const note = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error?.name || 'fetch-error').slice(0, 80);
    return { ok: false, code, dateCode, error: note };
  } finally {
    clearTimeout(timer);
  }
}
