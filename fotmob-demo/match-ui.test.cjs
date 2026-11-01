'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const browserStartup = appSource.indexOf("document.addEventListener('click'");
if (browserStartup < 0) throw new Error('Could not find browser-only app startup boundary');
const sandbox = { localStorage: { getItem: () => null, setItem: () => {} }, console };
vm.runInNewContext(`${appSource.slice(0, browserStartup)}
teamBadge = () => '<span class="test-team"></span>';
globalThis.matchUi = { kickoffTime, matchRow, matchesPage, feedFreshness, state, localDateKey, selectedDate };`, sandbox, { filename: 'app.js' });
const ui = sandbox.matchUi;

test('formats upcoming kickoff times in Myanmar Time regardless of host timezone', () => {
  assert.equal(ui.kickoffTime('2099-11-02T02:45:00Z'), '09:15');
});

test('shows kickoff and MMT on scheduled match cards instead of repeating Scheduled', () => {
  ui.state.favorites.clear();
  ui.state.stale = false;
  const html = ui.matchRow({
    id: 'fixture-1',
    home: 'Sassuolo',
    away: 'Fiorentina',
    homeLogo: '',
    awayLogo: '',
    kickoffUtc: '2099-11-02T02:45:00Z',
    status: 'STATUS_SCHEDULED',
    statusText: 'Scheduled',
    score: null,
  });
  assert.match(html, /09:15/);
  assert.match(html, /MMT/);
  assert.match(html, /SCHEDULED/);
  assert.doesNotMatch(html, />Scheduled</);
});

test('reports feed availability separately from match-in-progress status', () => {
  ui.state.dateOffset = 0;
  ui.state.eventsDate = ui.localDateKey(ui.selectedDate());
  ui.state.eventsFetchedAt = Date.now();
  ui.state.feedMode = 'live';
  ui.state.feedError = false;
  ui.state.loading = false;
  assert.equal(ui.feedFreshness(), 'FEED OK');
});

test('renders feed freshness without a misleading LIVE header badge', () => {
  ui.state.dateOffset = 0;
  ui.state.eventsDate = ui.localDateKey(ui.selectedDate());
  ui.state.eventsFetchedAt = Date.now();
  ui.state.feedMode = 'live';
  ui.state.feedError = false;
  ui.state.loading = false;
  ui.state.stale = false;
  ui.state.filter = 'All';
  ui.state.leagueFilter = null;
  ui.state.favorites.clear();
  ui.state.events = [{
    id: 'fixture-2', home: 'Sassuolo', away: 'Fiorentina', homeLogo: '', awayLogo: '',
    competitionId: 'ita.1', competition: 'Serie A', kickoffUtc: '2099-11-02T02:45:00Z',
    status: 'STATUS_SCHEDULED', statusText: 'Scheduled', score: null,
  }];
  const html = ui.matchesPage();
  assert.match(html, /feed-state-feed-ok/);
  assert.match(html, /FEED OK/);
  assert.doesNotMatch(html, /feed-state-live/);
});
