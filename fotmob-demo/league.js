'use strict';

(function () {
  const OPENLIGA = 'https://api.openligadb.de';
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
  const TEAM_SNAPSHOT = './data/espn/teams.json';
  const ALERT_KEY = 'matchday_league_score_alerts_v1';
  const DATA_CACHE_PREFIX = 'matchday_league_season_v1:';
  const DATA_MAX_AGE = 3 * 60 * 1000;
  const NOTIFY_DELAY = 0;
  const models = new Map();
  let leagueIndexPromise = null;
  let renderQueued = false;
  let alertIds = readAlertIds();

  const COMPETITIONS = {
    'eng.1': { name: 'Premier League', country: 'England', mark: 'PL', matches: row => row.leagueShortcut === 'pl' && /premier league/i.test(row.leagueName || '') },
    'esp.1': { name: 'LaLiga', country: 'Spain', mark: 'LL', matches: row => row.leagueShortcut === 'la1' && /(laliga|la liga)/i.test(row.leagueName || '') },
    'ger.1': { name: 'Bundesliga', country: 'Germany', mark: 'BL', matches: row => row.leagueShortcut === 'bl1' && /bundesliga/i.test(row.leagueName || '') && !/2\./.test(row.leagueName || '') },
    'ita.1': { name: 'Serie A', country: 'Italy', mark: 'SA', matches: row => row.leagueShortcut === 'it1' && /serie a/i.test(row.leagueName || '') },
    'fra.1': { name: 'Ligue 1', country: 'France', mark: 'L1', matches: row => row.leagueShortcut === 'fr1' && /ligue 1/i.test(row.leagueName || '') },
    'uefa.champions': { name: 'UEFA Champions League', country: 'Europe', mark: 'UCL', matches: row => /champions league/i.test(row.leagueName || '') && (/^ucl(?:\d{2,4})?$/.test(row.leagueShortcut || '') || /^cl1$/.test(row.leagueShortcut || '')) },
    'uefa.europa': { name: 'Europa League', country: 'Europe', mark: 'UEL', matches: row => /europa league/i.test(row.leagueName || '') && (/^uel(?:\d{2,4})?$/.test(row.leagueShortcut || '') || /^el\d{0,4}$/.test(row.leagueShortcut || '')) },
    'uefa.europa.conf': { name: 'Conference League', country: 'Europe', mark: 'UECL', matches: row => /(conference league|conference)/i.test(row.leagueName || '') && (/^uecl(?:\d{2,4})?$/.test(row.leagueShortcut || '') || /^uefaconf\d{2,4}$/.test(row.leagueShortcut || '')) }
  };

  const TABS = [
    ['Overview', 'Overview'], ['Standings', 'Standings'], ['Fixtures', 'Fixtures'],
    ['Teams', 'Teams'], ['Player Stats', 'Player Stats'], ['Team Stats', 'Team Stats'],
    ['Transfers', 'Transfers'], ['TOTW', 'TOTW'], ['Seasons', 'Seasons']
  ];

  function readAlertIds() {
    try {
      const values = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]');
      return new Set(Array.isArray(values) ? values.map(String) : []);
    } catch (_) { return new Set(); }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function notify() {
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      window.dispatchEvent(new Event('matchday-league-updated'));
    }, 0);
  }

  function safeLogo(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' ? value : '';
    } catch (_) { return ''; }
  }

  async function fetchJSON(url, timeoutMs = 20000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  function modelFor(id, comp) {
    let model = models.get(id);
    if (!model) {
      model = {
        id,
        comp: comp || null,
        tab: 'Standings',
        selectedYear: Number(comp?.season) || new Date().getFullYear(),
        userPickedSeason: false,
        split: 'overall',
        standingsMode: 'full',
        fixtureMode: 'fixtures',
        round: '',
        fixtureLimit: 36,
        teamQuery: '',
        showAllPlayers: false,
        seasons: [],
        seasonsLoaded: false,
        seasonsLoading: false,
        seasonsError: false,
        stats: null,
        statsFor: null,
        statsLoading: false,
        statsLoadedFor: null,
        statsError: false,
        teams: [],
        teamsFor: null,
        teamsLoading: false,
        teamsLoadedFor: null,
        teamsError: false,
        standings: [],
        matches: [],
        dataLoadedFor: null,
        dataLoading: false,
        dataError: false,
        dataSource: '',
        updatedAt: 0,
        notice: ''
      };
      models.set(id, model);
    }
    if (comp) {
      model.comp = comp;
      if (!model.userPickedSeason && Number(comp.season) && model.selectedYear !== Number(comp.season)) {
        model.selectedYear = Number(comp.season);
      }
    }
    return model;
  }

  function officialSeason(comp, id) {
    if (!comp || !Number(comp.season) || !comp.shortcut) return null;
    return {
      year: Number(comp.season),
      shortcut: String(comp.shortcut),
      leagueName: String(comp.sourceName || comp.name || `${Number(comp.season)} season`),
      provider: 'OpenLigaDB'
    };
  }

  function matchesCompetition(row, id) {
    const config = COMPETITIONS[id];
    if (!config || !row || !row.leagueShortcut) return false;
    const shortcut = String(row.leagueShortcut).toLowerCase();
    const name = String(row.leagueName || '').toLowerCase();
    if (!config.matches({ ...row, leagueShortcut: shortcut, leagueName: name })) return false;
    const sport = String(row.sport?.sportName || '').toLowerCase();
    return !sport || /fußball|fussball|soccer|football/.test(sport);
  }

  function seasonPreference(candidate, previous, comp) {
    const current = officialSeason(comp, '');
    if (!previous) return candidate;
    if (current && candidate.year === current.year) {
      if (candidate.shortcut === current.shortcut) return candidate;
      if (previous.shortcut !== current.shortcut && candidate.shortcut === previous.shortcut) return candidate;
    }
    const base = comp?.shortcut ? String(comp.shortcut).replace(/\d+$/, '') : '';
    const candidateBase = String(candidate.shortcut || '').replace(/\d+$/, '');
    const previousBase = String(previous.shortcut || '').replace(/\d+$/, '');
    if (base && candidateBase === base && previousBase !== base) return candidate;
    return previous;
  }

  async function fetchLeagueIndex() {
    if (!leagueIndexPromise) {
      leagueIndexPromise = fetchJSON(`${OPENLIGA}/getavailableleagues`).catch(error => {
        leagueIndexPromise = null;
        throw error;
      });
    }
    return leagueIndexPromise;
  }

  function addSeasonOption(model, option) {
    if (!option || !Number(option.year)) return;
    const index = model.seasons.findIndex(item => Number(item.year) === Number(option.year));
    if (index < 0) model.seasons.push(option);
    else model.seasons[index] = seasonPreference(option, model.seasons[index], model.comp);
    model.seasons.sort((a, b) => Number(b.year) - Number(a.year));
  }

  async function loadSeasons(model) {
    if (model.seasonsLoading || model.seasonsLoaded) return;
    model.seasonsLoading = true;
    notify();
    try {
      const available = await fetchLeagueIndex();
      model.seasons = [];
      for (const row of Array.isArray(available) ? available : []) {
        if (!matchesCompetition(row, model.id)) continue;
        const year = Number(row.leagueSeason);
        if (!year) continue;
        addSeasonOption(model, {
          year,
          shortcut: String(row.leagueShortcut),
          leagueName: String(row.leagueName || `${year}`),
          provider: 'OpenLigaDB'
        });
      }
      model.seasonsError = false;
    } catch (error) {
      model.seasonsError = true;
      console.warn(`OpenLigaDB season list unavailable for ${model.id}:`, error);
    }
    const current = officialSeason(model.comp, model.id);
    if (current) addSeasonOption(model, current);
    if (model.stats?.season?.year) {
      const statsYear = Number(model.stats.season.year);
      if (statsYear && !model.seasons.some(item => Number(item.year) === statsYear)) {
        addSeasonOption(model, {
          year: statsYear,
          shortcut: '',
          leagueName: String(model.stats.season.displayName || model.stats.season.name || `${statsYear} season`),
          provider: 'ESPN'
        });
      }
    }
    if (!model.userPickedSeason) {
      const preferred = Number(current?.year || model.stats?.season?.year || model.seasons[0]?.year);
      if (preferred) model.selectedYear = preferred;
    }
    if (model.selectedYear && !model.seasons.some(item => Number(item.year) === Number(model.selectedYear))) {
      addSeasonOption(model, {
        year: Number(model.selectedYear),
        shortcut: '',
        leagueName: String(model.stats?.season?.displayName || `${model.selectedYear}`),
        provider: model.stats?.season?.year === Number(model.selectedYear) ? 'ESPN' : 'Not listed'
      });
    }
    model.seasonsLoading = false;
    model.seasonsLoaded = true;
    notify();
  }

  function seasonFor(model) {
    return model.seasons.find(item => Number(item.year) === Number(model.selectedYear)) ||
      officialSeason(model.comp, model.id) || {
        year: Number(model.selectedYear), shortcut: '', leagueName: String(model.selectedYear), provider: 'Not listed'
      };
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function rawScore(match) {
    if (match && match.score && typeof match.score === 'object') {
      const home = numberOrNull(match.score.home);
      const away = numberOrNull(match.score.away);
      if (home !== null && away !== null) return { home, away, kind: match.score.kind || 'reported' };
    }
    const results = Array.isArray(match?.matchResults) ? match.matchResults : [];
    const valid = results.filter(item => numberOrNull(item?.pointsTeam1) !== null && numberOrNull(item?.pointsTeam2) !== null);
    const finalKinds = new Set(['After90Minutes', 'AfterExtraTime', 'AfterPenalties']);
    const finals = valid.filter(item => finalKinds.has(String(item.resultTypeKind || '')));
    if (match?.matchIsFinished || match?.finished) {
      if (!finals.length) return null;
      const result = finals.reduce((best, item) => Number(item.resultOrderID || 0) > Number(best.resultOrderID || 0) ? item : best);
      return { home: Number(result.pointsTeam1), away: Number(result.pointsTeam2), kind: result.resultTypeKind || result.resultName || 'reported' };
    }
    return null;
  }

  function normalizedSnapshotMatch(item) {
    return {
      id: String(item.id ?? ''),
      kickoffUtc: String(item.kickoffUtc || ''),
      round: String(item.round || ''),
      groupOrderId: numberOrNull(item.groupOrderId),
      home: String(item.home || 'Home team'),
      away: String(item.away || 'Away team'),
      homeTeamId: item.homeTeamId ?? null,
      awayTeamId: item.awayTeamId ?? null,
      homeLogo: safeLogo(item.homeLogo || ''),
      awayLogo: safeLogo(item.awayLogo || ''),
      finished: Boolean(item.finished),
      score: rawScore(item),
      goals: Array.isArray(item.goals) ? item.goals : [],
      sourceUpdatedAt: item.sourceUpdatedAt || ''
    };
  }

  function normalizedOpenLigaMatch(item) {
    return {
      id: String(item.matchID ?? ''),
      kickoffUtc: String(item.matchDateTimeUTC || item.matchDateTime || ''),
      round: String(item.group?.groupName || ''),
      groupOrderId: numberOrNull(item.group?.groupOrderID),
      home: String(item.team1?.teamName || 'Home team'),
      away: String(item.team2?.teamName || 'Away team'),
      homeTeamId: item.team1?.teamId ?? null,
      awayTeamId: item.team2?.teamId ?? null,
      homeLogo: safeLogo(item.team1?.teamIconUrl || ''),
      awayLogo: safeLogo(item.team2?.teamIconUrl || ''),
      finished: Boolean(item.matchIsFinished),
      score: rawScore(item),
      goals: Array.isArray(item.goals) ? item.goals : [],
      sourceUpdatedAt: item.lastUpdateDateTime || ''
    };
  }

  function normalizeStandings(rows) {
    return (Array.isArray(rows) ? rows : []).filter(row => row && row.teamName).map((row, index) => ({
      position: index + 1,
      team: String(row.teamName),
      shortName: String(row.shortName || ''),
      logoUrl: safeLogo(row.teamIconUrl || ''),
      played: numberOrNull(row.matches),
      won: numberOrNull(row.won),
      drawn: numberOrNull(row.draw),
      lost: numberOrNull(row.lost),
      goalsFor: numberOrNull(row.goals),
      goalsAgainst: numberOrNull(row.opponentGoals),
      goalDifference: numberOrNull(row.goalDiff),
      points: numberOrNull(row.points)
    }));
  }

  function cacheKey(shortcut, year, type) {
    return `${DATA_CACHE_PREFIX}${encodeURIComponent(shortcut)}:${Number(year)}:${type}`;
  }

  function readDataCache(shortcut, year, type) {
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey(shortcut, year, type)) || 'null');
      if (!saved || Date.now() - Number(saved.savedAt || 0) > 7 * 86400000) return null;
      return saved.data;
    } catch (_) { return null; }
  }

  function writeDataCache(shortcut, year, type, data) {
    try { localStorage.setItem(cacheKey(shortcut, year, type), JSON.stringify({ savedAt: Date.now(), data })); } catch (_) {}
  }

  function snapshotFallback(model, year) {
    const comp = model.comp;
    if (!comp || Number(comp.season) !== Number(year)) return { standings: [], matches: [] };
    return {
      standings: Array.isArray(comp.standings) ? comp.standings : [],
      matches: Array.isArray(comp.matches) ? comp.matches.map(normalizedSnapshotMatch) : []
    };
  }

  async function loadSeasonData(model, force = false) {
    const year = Number(model.selectedYear);
    if (!year || model.dataLoading) return;
    if (!force && model.dataLoadedFor === year && Date.now() - model.updatedAt < DATA_MAX_AGE) return;
    const season = seasonFor(model);
    model.dataLoading = true;
    model.dataLoadedFor = null;
    model.standings = [];
    model.matches = [];
    model.dataError = false;
    model.dataSource = '';
    notify();

    let table = null;
    let matchRows = null;
    let tableError = null;
    let matchError = null;
    if (season.shortcut) {
      const base = `${OPENLIGA}/`;
      const [tableResult, matchesResult] = await Promise.allSettled([
        fetchJSON(`${base}getbltable/${encodeURIComponent(season.shortcut)}/${year}`),
        fetchJSON(`${base}getmatchdata/${encodeURIComponent(season.shortcut)}/${year}`)
      ]);
      if (tableResult.status === 'fulfilled' && Array.isArray(tableResult.value)) {
        table = normalizeStandings(tableResult.value);
        writeDataCache(season.shortcut, year, 'table', table);
      } else {
        tableError = tableResult.reason || new Error('Standings response unavailable');
        table = readDataCache(season.shortcut, year, 'table');
      }
      if (matchesResult.status === 'fulfilled' && Array.isArray(matchesResult.value)) {
        matchRows = matchesResult.value.map(normalizedOpenLigaMatch).filter(match => match.kickoffUtc && Number.isFinite(Date.parse(match.kickoffUtc)));
        writeDataCache(season.shortcut, year, 'matches', matchRows);
      } else {
        matchError = matchesResult.reason || new Error('Fixture response unavailable');
        matchRows = readDataCache(season.shortcut, year, 'matches');
      }
    }

    const fallback = snapshotFallback(model, year);
    if ((!table || !table.length) && fallback.standings.length) {
      table = fallback.standings;
      model.dataSource = 'OpenLigaDB saved snapshot';
    }
    if ((!matchRows || !matchRows.length) && fallback.matches.length) {
      matchRows = fallback.matches;
      model.dataSource = 'OpenLigaDB saved snapshot';
    }
    model.standings = Array.isArray(table) ? table : [];
    model.matches = Array.isArray(matchRows) ? matchRows : [];
    model.dataError = Boolean(tableError || matchError);
    if (!model.dataSource) {
      model.dataSource = season.shortcut && !model.dataError ? 'OpenLigaDB' : season.shortcut ? 'OpenLigaDB cached data' : 'No OpenLigaDB season mapping';
    }
    model.dataLoadedFor = year;
    model.dataLoading = false;
    model.updatedAt = Date.now();
    notify();
  }

  async function loadPlayerStats(model, force = false) {
    const year = Number(model.selectedYear);
    if (!year || model.statsLoading) return;
    if (!force && model.statsLoadedFor === year) return;
    model.statsLoading = true;
    model.statsError = false;
    notify();
    try {
      model.stats = await fetchJSON(`${ESPN}/${encodeURIComponent(model.id)}/statistics?season=${year}`);
      model.statsLoadedFor = year;
    } catch (error) {
      model.statsError = true;
      model.stats = null;
      model.statsLoadedFor = year;
      console.warn(`ESPN player statistics unavailable for ${model.id}/${year}:`, error);
    } finally {
      model.statsLoading = false;
      const currentYear = Number(model.stats?.season?.year);
      if (currentYear) {
        const existingCurrent = model.seasons.find(item => Number(item.year) === currentYear);
        if (!existingCurrent || existingCurrent.provider === 'Not listed') {
          addSeasonOption(model, {
            year: currentYear,
            shortcut: '',
            leagueName: String(model.stats.season.displayName || model.stats.season.name || `${currentYear}`),
            provider: 'ESPN'
          });
        }
      }
      notify();
    }
  }

  function getTeamsFromPayload(payload) {
    const league = payload?.sports?.[0]?.leagues?.[0] || payload?.leagues?.[0] || {};
    const teams = Array.isArray(league.teams) ? league.teams : [];
    const year = Number(league.year || league.season?.year || payload?.season?.year) || null;
    const mapped = teams.map(row => row.team || row).filter(team => team && (team.displayName || team.name)).map(team => {
      const logos = Array.isArray(team.logos) ? team.logos : [];
      const preferred = logos.find(logo => Array.isArray(logo.rel) && logo.rel.includes('default')) || logos[0];
      return {
        name: String(team.displayName || team.name || team.shortDisplayName),
        shortName: String(team.shortDisplayName || team.abbreviation || ''),
        abbreviation: String(team.abbreviation || ''),
        logo: safeLogo(team.logo || preferred?.href || ''),
        id: String(team.id || '')
      };
    });
    return { year, teams: mapped };
  }

  async function loadTeams(model, force = false) {
    const year = Number(model.selectedYear);
    if (!year || model.teamsLoading) return;
    if (!force && model.teamsLoadedFor === year) return;
    model.teamsLoading = true;
    model.teamsError = false;
    notify();
    try {
      const payload = await fetchJSON(`${ESPN}/${encodeURIComponent(model.id)}/teams?limit=500`);
      const result = getTeamsFromPayload(payload);
      model.teams = result.teams;
      model.teamsFor = result.year;
      model.teamsLoadedFor = year;
      if (!model.teams.length) throw new Error('ESPN did not return team records');
    } catch (error) {
      model.teamsError = true;
      try {
        const fallback = await fetchJSON(`${TEAM_SNAPSHOT}?v=${Math.floor(Date.now() / 86400000)}`);
        const result = getTeamsFromPayload(fallback.leagues?.[model.id]);
        if (result.teams.length) {
          model.teams = result.teams;
          model.teamsFor = result.year;
          model.teamsError = false;
        }
      } catch (_) {}
      model.teamsLoadedFor = year;
      console.warn(`ESPN team directory unavailable for ${model.id}:`, error);
    } finally {
      model.teamsLoading = false;
      notify();
    }
  }

  function formattedDate(value, options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date not supplied';
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }

  function normalizedTeam(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/\b(?:fc|cf|afc|ac|sc|cd|club|football|futbol|deportivo)\b/g, ' ')
      .replace(/[^a-z0-9]/g, '');
  }

  function findScoreboardMatch(match, props) {
    const events = Array.isArray(props.events) ? props.events : [];
    const day = String(match.kickoffUtc || '').slice(0, 10);
    return events.find(event => event.competitionId === props.id &&
      String(event.kickoffUtc || '').slice(0, 10) === day &&
      normalizedTeam(event.home) === normalizedTeam(match.home) &&
      normalizedTeam(event.away) === normalizedTeam(match.away));
  }

  function teamButton(name, id, logo, abbr, props, size = 'small') {
    const team = { name, leagueCode: id, logo: safeLogo(logo || ''), abbr: abbr || '' };
    if (typeof props.teamControl === 'function') return props.teamControl(team, size);
    const text = esc(abbr || name.slice(0, 3).toUpperCase());
    return `<span class="league-team-fallback">${text}</span><span>${esc(name)}</span>`;
  }

  function makeRecord(team) {
    return { team, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0, form: [] };
  }

  function computeTable(matches, split = 'overall') {
    const records = new Map();
    const formEvents = new Map();
    const get = team => {
      if (!records.has(team)) records.set(team, makeRecord(team));
      return records.get(team);
    };
    const ordered = matches.filter(match => match.finished && match.score && match.home && match.away)
      .slice().sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc));
    for (const match of ordered) {
      const homeGoals = Number(match.score.home);
      const awayGoals = Number(match.score.away);
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
      if (split !== 'away') {
        const home = get(match.home);
        home.played += 1;
        home.goalsFor += homeGoals;
        home.goalsAgainst += awayGoals;
        if (homeGoals > awayGoals) { home.won += 1; home.points += 3; }
        else if (homeGoals === awayGoals) { home.drawn += 1; home.points += 1; }
        else home.lost += 1;
        if (!formEvents.has(match.home)) formEvents.set(match.home, []);
        formEvents.get(match.home).push(homeGoals > awayGoals ? 'W' : homeGoals === awayGoals ? 'D' : 'L');
      }
      if (split !== 'home') {
        const away = get(match.away);
        away.played += 1;
        away.goalsFor += awayGoals;
        away.goalsAgainst += homeGoals;
        if (awayGoals > homeGoals) { away.won += 1; away.points += 3; }
        else if (awayGoals === homeGoals) { away.drawn += 1; away.points += 1; }
        else away.lost += 1;
        if (!formEvents.has(match.away)) formEvents.set(match.away, []);
        formEvents.get(match.away).push(awayGoals > homeGoals ? 'W' : awayGoals === homeGoals ? 'D' : 'L');
      }
    }
    const rows = [...records.values()].map(row => ({
      ...row,
      goalDifference: row.goalsFor - row.goalsAgainst,
      form: (formEvents.get(row.team) || []).slice(-5)
    }));
    rows.sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor || a.team.localeCompare(b.team));
    return rows.map((row, index) => ({ ...row, position: index + 1 }));
  }

  function formFor(matches, split) {
    const table = computeTable(matches, split);
    return new Map(table.map(row => [row.team, row.form]));
  }

  function currentStandingRows(model) {
    const available = model.dataLoadedFor === Number(model.selectedYear) ? model.standings : [];
    return available;
  }

  function rowsForStandings(model) {
    const official = currentStandingRows(model);
    if (model.split === 'overall' && model.standingsMode !== 'form' && official.length) return official;
    if (model.standingsMode === 'form' && model.split === 'overall' && official.length) {
      const forms = formFor(model.matches, 'overall');
      return official.map(row => ({ ...row, form: forms.get(row.team) || [] }));
    }
    return computeTable(model.matches, model.split);
  }

  function unavailable(title, description, source = 'Not supplied by connected sources') {
    return `<div class="league-empty"><span class="league-empty-icon">–</span><strong>${esc(title)}</strong><p>${esc(description)}</p><small>${esc(source)}</small></div>`;
  }

  function loadingCard(label) {
    return `<div class="league-loading"><span class="league-loader-dot"></span><span>${esc(label)}</span></div>`;
  }

  function formatClub(row, props) {
    const logo = row.logoUrl || props.teamLogoFor?.(row.team, props.id) || '';
    return teamButton(row.team, props.id, logo, row.shortName, props, 'table');
  }

  function standingsTable(model, props) {
    const rows = rowsForStandings(model);
    if (model.dataLoading && !model.standings.length && !model.matches.length) return loadingCard(`Loading ${model.selectedYear} standings and results…`);
    if (!rows.length) return unavailable('Standings unavailable', model.split === 'overall'
      ? `OpenLigaDB returned no table or usable finished match results for ${seasonFor(model).leagueName}.`
      : `There are no source-reported finished match results to calculate the ${model.split} split for this season.`);

    const mode = model.standingsMode;
    const headers = mode === 'short'
      ? '<th># Team</th><th>P</th><th>GD</th><th>Pts</th>'
      : mode === 'form'
        ? '<th># Team</th><th>Last 5</th><th>Pts</th>'
        : '<th># Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF–GA</th><th>GD</th><th>Pts</th>';
    const body = rows.map((row, index) => {
      const place = row.position ?? index + 1;
      const team = `<span class="standing-club"><span class="position">${esc(place)}</span>${formatClub(row, props)}</span>`;
      if (mode === 'short') return `<tr><td>${team}</td><td>${esc(row.played ?? '–')}</td><td>${esc(row.goalDifference ?? '–')}</td><td><strong>${esc(row.points ?? '–')}</strong></td></tr>`;
      if (mode === 'form') {
        const form = Array.isArray(row.form) ? row.form : [];
        return `<tr><td>${team}</td><td><span class="league-form-list">${form.length ? form.map(value => `<span class="league-form-chip ${value.toLowerCase()}">${value}</span>`).join('') : '<span class="league-no-form">—</span>'}</span></td><td><strong>${esc(row.points ?? '–')}</strong></td></tr>`;
      }
      return `<tr><td>${team}</td><td>${esc(row.played ?? '–')}</td><td>${esc(row.won ?? '–')}</td><td>${esc(row.drawn ?? '–')}</td><td>${esc(row.lost ?? '–')}</td><td>${esc(row.goalsFor ?? '–')}–${esc(row.goalsAgainst ?? '–')}</td><td>${esc(row.goalDifference ?? '–')}</td><td><strong>${esc(row.points ?? '–')}</strong></td></tr>`;
    }).join('');
    const derived = model.split !== 'overall' || mode === 'form';
    const note = derived
      ? `${model.split === 'overall' ? 'Last-five form' : `${model.split === 'home' ? 'Home' : 'Away'} split`} calculated only from OpenLigaDB-reported completed match scores.`
      : 'Official overall table fields supplied by OpenLigaDB.';
    return `<section class="league-data-card"><div class="league-card-heading"><div><h2>${mode === 'form' ? 'Recent form' : 'Standings'}</h2><p>${esc(seasonFor(model).leagueName)} · ${model.split === 'overall' ? 'Overall' : model.split === 'home' ? 'Home' : 'Away'}</p></div><span class="league-source-chip">${derived ? 'Calculated' : 'OpenLigaDB'}</span></div><div class="standings-wrap"><table class="standings league-standings"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div><p class="league-data-note">${esc(note)}</p></section>`;
  }

  function controlButtons(labels, current, attr, id) {
    return `<div class="league-segmented" role="group">${labels.map(([value, label]) => `<button type="button" class="league-segment ${current === value ? 'active' : ''}" data-${attr}="${esc(value)}" data-league-id="${esc(id)}" aria-pressed="${current === value}">${esc(label)}</button>`).join('')}</div>`;
  }

  function standingsTab(model, props) {
    const dataControls = `<div class="league-control-stack">${controlButtons([['short', 'Short'], ['full', 'Full'], ['form', 'Form']], model.standingsMode, 'league-mode', props.id)}${controlButtons([['overall', 'Overall'], ['home', 'Home'], ['away', 'Away']], model.split, 'league-split', props.id)}</div>`;
    return `<div class="league-tab-content">${dataControls}${standingsTable(model, props)}<p class="league-footnote">Home/away rows and form are calculated from completed OpenLigaDB match records, not presented as source-published standings splits.</p></div>`;
  }

  function findSnapshotEvent(match, props) {
    const event = findScoreboardMatch(match, props);
    return event ? `<button type="button" class="league-open-match" data-action="open-match" data-id="${esc(event.id)}">Open match details</button>` : '';
  }

  function fixtureCard(match, props) {
    const finished = Boolean(match.finished);
    const score = match.score;
    const status = finished ? (score ? 'Final' : 'Final · score not supplied') : (Date.parse(match.kickoffUtc) < Date.now() ? 'Not marked finished by source' : 'Scheduled');
    const homeLogo = match.homeLogo || props.teamLogoFor?.(match.home, props.id) || '';
    const awayLogo = match.awayLogo || props.teamLogoFor?.(match.away, props.id) || '';
    const round = match.round ? ` · ${match.round}` : '';
    return `<article class="league-fixture-card"><div class="league-fixture-meta"><span>${esc(status)}</span><time>${esc(formattedDate(match.kickoffUtc))}</time><span>${esc(round.replace(/^ · /, ''))}</span></div><div class="league-fixture-pair"><div class="league-fixture-side">${teamButton(match.home, props.id, homeLogo, '', props)}<strong>${score ? esc(score.home) : '–'}</strong></div><div class="league-fixture-side">${teamButton(match.away, props.id, awayLogo, '', props)}<strong>${score ? esc(score.away) : '–'}</strong></div></div>${findSnapshotEvent(match, props)}</article>`;
  }

  function fixtureRows(model, props, limit = model.fixtureLimit) {
    const all = model.matches.slice().sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc));
    let matches = all;
    if (model.fixtureMode === 'results') matches = matches.filter(match => match.finished);
    if (model.fixtureMode === 'fixtures') matches = matches.filter(match => !match.finished);
    if (model.round) matches = matches.filter(match => String(match.groupOrderId ?? match.round) === model.round);
    if (model.fixtureMode === 'results') matches = matches.slice().reverse();
    const visible = matches.slice(0, limit);
    const rounds = [...new Map(all.map(match => { const key = String(match.groupOrderId ?? match.round); const label = match.round || `Round ${match.groupOrderId}`; return [key, { key, label }]; }).filter(([, row]) => row.label)).values()];
    rounds.sort((a, b) => Number(a.key) - Number(b.key) || a.label.localeCompare(b.label));
    return { all, matches, visible, rounds };
  }

  function fixturesTab(model, props) {
    if (model.dataLoading && !model.matches.length) return `<div class="league-tab-content">${loadingCard(`Loading ${model.selectedYear} fixtures and results…`)}</div>`;
    const { matches, visible, rounds } = fixtureRows(model, props);
    if (!model.matches.length) {
      const live = (props.events || []).filter(event => event.competitionId === props.id);
      if (live.length) {
        return `<div class="league-tab-content"><section class="league-data-card"><div class="league-card-heading"><div><h2>Scoreboard fixtures</h2><p>ESPN’s currently loaded date only · ${esc(props.eventsDate || '')}</p></div><span class="league-source-chip">ESPN</span></div>${live.map(event => `<div class="league-scoreboard-row"><span>${esc(formattedDate(event.kickoffUtc))}</span><strong>${esc(event.home)} ${event.score ? `${esc(event.score.home)}–${esc(event.score.away)}` : 'vs'} ${esc(event.away)}</strong><button data-action="open-match" data-id="${esc(event.id)}">Details</button></div>`).join('')}</section>${unavailable('Season archive unavailable','This competition has no verified OpenLigaDB fixture archive connected. ESPN match cards above are only for the currently loaded date.')}</div>`;
      }
      return `<div class="league-tab-content">${unavailable('Fixtures and results unavailable', `No source-listed OpenLigaDB match data was returned for ${seasonFor(model).leagueName}; the page will not invent a schedule.`)}</div>`;
    }
    const roundOptions = `<option value="">All rounds</option>${rounds.map(round => `<option value="${esc(round.key)}" ${model.round === round.key ? 'selected' : ''}>${esc(round.label)}</option>`).join('')}`;
    const list = visible.length ? visible.map(match => fixtureCard(match, props)).join('') : `<div class="league-inline-empty">No ${model.fixtureMode === 'results' ? 'results' : model.fixtureMode === 'fixtures' ? 'fixtures' : 'matches'} in this filter.</div>`;
    const more = matches.length > visible.length ? `<button class="league-load-more" data-league-action="more-fixtures" data-league-id="${esc(props.id)}">Load ${Math.min(36, matches.length - visible.length)} more · ${matches.length - visible.length} remaining</button>` : '';
    const source = model.dataSource || 'OpenLigaDB';
    return `<div class="league-tab-content"><div class="league-fixture-tools">${controlButtons([['all', 'All'], ['results', 'Results'], ['fixtures', 'Fixtures']], model.fixtureMode, 'league-fixture-mode', props.id)}<label class="league-round-select"><span>Round</span><select data-league-round data-league-id="${esc(props.id)}">${roundOptions}</select></label></div><section class="league-fixture-list">${list}</section>${more}<p class="league-data-note">${esc(source)} · ${model.matches.length} source-listed fixtures · ${model.matches.filter(match => match.finished).length} marked finished. No missing scores are inferred.</p></div>`;
  }

  function overviewTab(model, props) {
    if (model.dataLoading && !model.standings.length && !model.matches.length) return `<div class="league-tab-content">${loadingCard(`Loading verified ${model.selectedYear} league data…`)}</div>`;
    const rows = model.standings.length ? model.standings.slice(0, 4) : computeTable(model.matches, 'overall').slice(0, 4);
    const upcoming = model.matches.filter(match => !match.finished).sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc)).slice(0, 3);
    const results = model.matches.filter(match => match.finished).sort((a, b) => Date.parse(b.kickoffUtc) - Date.parse(a.kickoffUtc)).slice(0, 3);
    const leaders = model.statsLoadedFor === Number(model.selectedYear) && Number(model.stats?.season?.year) === Number(model.selectedYear)
      ? (model.stats.stats || []).filter(group => Array.isArray(group.leaders) && group.leaders.length).slice(0, 1).flatMap(group => group.leaders.slice(0, 3).map(leader => ({ group, leader }))) : [];
    const standingContent = rows.length
      ? `<section class="league-data-card"><div class="league-card-heading"><div><h2>Standings snapshot</h2><p>${esc(seasonFor(model).leagueName)}</p></div><button class="league-link-button" data-league-tab="Standings" data-league-id="${esc(props.id)}">View all</button></div><div class="league-overview-table">${rows.map((row, index) => `<div class="league-overview-row"><span class="position">${esc(row.position ?? index + 1)}</span>${teamButton(row.team, props.id, row.logoUrl || props.teamLogoFor?.(row.team, props.id) || '', row.shortName, props, 'table')}<strong>${esc(row.points ?? '–')} pts</strong></div>`).join('')}</div></section>`
      : unavailable('Standings unavailable', `No table rows were returned for ${seasonFor(model).leagueName}.`);
    const fixtureContent = upcoming.length || results.length
      ? `<section class="league-data-card"><div class="league-card-heading"><div><h2>Fixtures & results</h2><p>${model.matches.length} records returned by OpenLigaDB</p></div><button class="league-link-button" data-league-tab="Fixtures" data-league-id="${esc(props.id)}">View all</button></div>${[...upcoming.slice(0, 2), ...results.slice(0, 1)].map(match => `<div class="league-overview-fixture"><span>${esc(formattedDate(match.kickoffUtc))}</span><strong>${esc(match.home)} ${match.score ? `${esc(match.score.home)}–${esc(match.score.away)}` : 'vs'} ${esc(match.away)}</strong></div>`).join('')}</section>`
      : unavailable('Fixtures/results unavailable', 'No source-listed match records are available for this selected competition and season.');
    const leaderContent = leaders.length
      ? `<section class="league-data-card"><div class="league-card-heading"><div><h2>${esc(leaders[0].group.displayName || leaders[0].group.name || 'Player leaders')}</h2><p>ESPN · ${esc(model.stats.season.displayName || model.stats.season.year)}</p></div><button class="league-link-button" data-league-tab="Player Stats" data-league-id="${esc(props.id)}">View all</button></div>${leaders.map(({ group, leader }) => `<div class="league-leader-row"><span>${esc(leader.athlete?.displayName || 'Player name unavailable')}</span><strong>${esc(leader.value ?? leader.displayValue ?? '–')}</strong></div>`).join('')}</section>`
      : '';
    return `<div class="league-tab-content">${standingContent}${fixtureContent}${leaderContent}<p class="league-data-note">Only source-reported facts are shown. ${esc(model.dataSource || 'OpenLigaDB')} standings/fixtures are separate from ESPN player data.</p></div>`;
  }

  function teamsTab(model, props) {
    if (model.teamsLoading && !model.teams.length) return `<div class="league-tab-content">${loadingCard('Loading the ESPN team directory and badges…')}</div>`;
    if (!model.teams.length) return `<div class="league-tab-content">${unavailable('Teams unavailable', 'ESPN did not return a team directory for this competition. Team badges and names are not invented.')}</div>`;
    if (model.teamsFor && Number(model.teamsFor) !== Number(model.selectedYear)) {
      return `<div class="league-tab-content">${unavailable('Teams unavailable for this season', `ESPN returned the team directory for ${model.teamsFor}, not the selected ${model.selectedYear} season. The current roster is not shown as historical data.`)}</div>`;
    }
    const query = model.teamQuery.trim().toLowerCase();
    const teams = model.teams.filter(team => !query || `${team.name} ${team.shortName} ${team.abbreviation}`.toLowerCase().includes(query));
    const list = teams.map(team => `<div class="league-team-row">${teamButton(team.name, props.id, team.logo, team.abbreviation, props, 'score')}<span class="league-team-row-meta">${esc(team.shortName || team.abbreviation || '')}</span></div>`).join('');
    return `<div class="league-tab-content"><section class="league-data-card"><div class="league-card-heading"><div><h2>Teams</h2><p>${model.teams.length} ESPN-listed teams · ${esc(model.teamsFor || 'season not supplied')}</p></div><span class="league-source-chip">ESPN</span></div><label class="league-search"><span>Search teams</span><input type="search" data-league-team-search data-league-id="${esc(props.id)}" value="${esc(model.teamQuery)}" placeholder="Type a team name"></label><div class="league-team-list">${list || '<div class="league-inline-empty">No teams match this search.</div>'}</div><p class="league-data-note">Team names and badges are from ESPN’s league directory. Tap a team to open the existing team page.</p></section></div>`;
  }

  function playerStatsTab(model, props) {
    if (model.statsLoading && model.statsLoadedFor !== Number(model.selectedYear)) return `<div class="league-tab-content">${loadingCard('Loading ESPN player statistics…')}</div>`;
    const data = model.statsLoadedFor === Number(model.selectedYear) ? model.stats : null;
    const returnedYear = Number(data?.season?.year);
    if (!data || returnedYear !== Number(model.selectedYear)) {
      const detail = data?.season?.displayName || (returnedYear ? String(returnedYear) : 'a different season');
      return `<div class="league-tab-content">${unavailable('Player statistics unavailable', `ESPN returned ${detail}, not the selected ${model.selectedYear} season. No statistics are copied from another year.`)}</div>`;
    }
    const groups = (Array.isArray(data.stats) ? data.stats : []).filter(group => Array.isArray(group.leaders) && group.leaders.length);
    if (!groups.length) return `<div class="league-tab-content">${unavailable('Player statistics unavailable', `ESPN returned no player leader categories for ${data.season.displayName || model.selectedYear}.`)}</div>`;
    const categoryHtml = groups.map(group => {
      const all = group.leaders;
      const leaders = model.showAllPlayers ? all : all.slice(0, 20);
      const rows = leaders.map((leader, index) => {
        const athlete = leader.athlete || {};
        const team = leader.team?.displayName || leader.team?.name || athlete.team?.displayName || '';
        const value = leader.value ?? leader.displayValue ?? leader.shortDisplayValue ?? '–';
        return `<div class="league-player-stat-row"><span class="league-player-rank">${index + 1}</span><div class="league-player-detail"><strong>${esc(athlete.displayName || athlete.fullName || 'Player name unavailable')}</strong>${team ? `<small>${esc(team)}</small>` : ''}${leader.displayValue ? `<small>${esc(leader.displayValue)}</small>` : ''}</div><strong class="league-player-value">${esc(value)}</strong></div>`;
      }).join('');
      return `<section class="league-data-card"><div class="league-card-heading"><div><h2>${esc(group.displayName || group.name || 'Player stats')}</h2><p>${esc(data.season.displayName || `${model.selectedYear} season`)}</p></div><span class="league-source-chip">ESPN</span></div><div class="league-player-list">${rows}</div>${all.length > 20 ? `<button class="league-load-more" data-league-action="players-more" data-league-id="${esc(props.id)}">${model.showAllPlayers ? 'Show top 20' : `Show all ${all.length}`}</button>` : ''}</section>`;
    }).join('');
    return `<div class="league-tab-content">${categoryHtml}<p class="league-data-note">Only categories and leaders returned by ESPN for the selected season are shown. If ESPN does not supply a category, Matchday does not add one.</p></div>`;
  }

  function teamStatsTab(model, props) {
    if (model.dataLoading && !model.matches.length) return `<div class="league-tab-content">${loadingCard('Loading completed match records for team stats…')}</div>`;
    const rows = computeTable(model.matches, 'overall');
    if (!rows.length) return `<div class="league-tab-content">${unavailable('Team statistics unavailable', `No usable completed OpenLigaDB results were returned for ${seasonFor(model).leagueName}.`)}</div>`;
    const body = rows.map(row => {
      const winPct = row.played ? `${Math.round(row.won * 100 / row.played)}%` : '–';
      return `<tr><td><span class="standing-club">${teamButton(row.team, props.id, props.teamLogoFor?.(row.team, props.id) || '', '', props, 'table')}</span></td><td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td>${row.goalsFor}</td><td>${row.goalsAgainst}</td><td>${row.goalDifference}</td><td>${winPct}</td><td><strong>${row.points}</strong></td></tr>`;
    }).join('');
    return `<div class="league-tab-content"><section class="league-data-card"><div class="league-card-heading"><div><h2>Team statistics</h2><p>${esc(seasonFor(model).leagueName)} · completed matches only</p></div><span class="league-source-chip">Calculated</span></div><div class="standings-wrap"><table class="standings league-team-stats"><thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Win%</th><th>Pts</th></tr></thead><tbody>${body}</tbody></table></div><p class="league-data-note">Win percentage and totals are calculated from OpenLigaDB provider-reported completed match results. This is not a separate official ESPN team-stat table.</p></section></div>`;
  }

  function unavailableCategoryTab(category, description) {
    return `<div class="league-tab-content">${unavailable(`${category} unavailable`, description)}<section class="league-data-card league-unavailable-details"><div class="league-card-heading"><div><h2>${esc(category)}</h2><p>Section retained; no placeholder records are shown</p></div><span class="league-source-chip muted">Not supplied</span></div><p>Neither the verified ESPN data used by this site nor the connected OpenLigaDB records provide a structured ${esc(category.toLowerCase())} feed for this competition. The section will show data only if a connected source returns it.</p></section></div>`;
  }

  function seasonsTab(model, props) {
    if (model.seasonsLoading && !model.seasons.length) return `<div class="league-tab-content">${loadingCard('Loading source-listed seasons…')}</div>`;
    if (!model.seasons.length) return `<div class="league-tab-content">${unavailable('Season list unavailable', 'Neither connected provider returned a season list for this competition.')}</div>`;
    const selected = seasonFor(model);
    const status = model.dataLoadedFor === Number(model.selectedYear)
      ? `${model.standings.length ? 'Standings available' : 'Standings unavailable'} · ${model.matches.length ? `${model.matches.length} fixtures/results returned` : 'fixtures/results unavailable'}`
      : 'Listed by source · select to load data';
    const rows = model.seasons.map(season => `<button type="button" class="league-season-row ${Number(season.year) === Number(model.selectedYear) ? 'active' : ''}" data-league-season-option="${esc(season.year)}" data-league-id="${esc(props.id)}" aria-pressed="${Number(season.year) === Number(model.selectedYear)}"><span class="league-season-year">${esc(season.year)}</span><span class="league-season-info"><strong>${esc(season.leagueName)}</strong><small>${esc(season.provider || 'OpenLigaDB')}</small></span><span class="league-season-arrow">${Number(season.year) === Number(model.selectedYear) ? 'Selected' : 'Open'}</span></button>`).join('');
    return `<div class="league-tab-content"><section class="league-data-card"><div class="league-card-heading"><div><h2>Available seasons</h2><p>${model.seasons.length} season${model.seasons.length === 1 ? '' : 's'} returned for this competition</p></div><span class="league-source-chip">${model.seasons.some(season => season.provider === 'OpenLigaDB') ? 'OpenLigaDB' : 'ESPN'}</span></div><div class="league-season-list">${rows}</div><div class="league-season-selected"><strong>${esc(selected.leagueName)}</strong><span>${esc(status)}</span></div><p class="league-data-note">Every season listed by OpenLigaDB is selectable. If that exact season has no table or fixture records, the related section says so instead of showing an empty or guessed page.</p></section></div>`;
  }

  function selectedTab(model, props) {
    switch (model.tab) {
      case 'Overview': return overviewTab(model, props);
      case 'Standings': return standingsTab(model, props);
      case 'Fixtures': return fixturesTab(model, props);
      case 'Teams': return teamsTab(model, props);
      case 'Player Stats': return playerStatsTab(model, props);
      case 'Team Stats': return teamStatsTab(model, props);
      case 'Transfers': return unavailableCategoryTab('Transfers', 'No verified league transfer provider is connected here.');
      case 'TOTW': return unavailableCategoryTab('Team of the Week', 'No verified team-of-the-week or player-rating feed is connected here.');
      case 'Seasons': return seasonsTab(model, props);
      default: return standingsTab(model, props);
    }
  }

  function leagueLogo(model) {
    const logos = Array.isArray(model.stats?.league?.logos) ? model.stats.league.logos : [];
    const logo = logos.find(item => (item.rel || []).includes('default')) || logos[0];
    return safeLogo(logo?.href || logo?.url || '');
  }

  function alertLabel(id) {
    if (typeof Notification === 'undefined') return { text: 'Alerts unavailable', disabled: true, active: false };
    if (Notification.permission === 'denied') return { text: 'Alerts blocked', disabled: true, active: false };
    const active = alertIds.has(String(id));
    return { text: active ? 'Alerts on' : 'Enable alerts', disabled: false, active };
  }

  function render(props) {
    const id = String(props?.id || '');
    const config = COMPETITIONS[id] || { name: props?.name || 'Competition', country: 'Football', mark: 'FC' };
    const model = modelFor(id, props?.comp);
    if (!model.seasonsLoaded && !model.seasonsLoading) void loadSeasons(model);
    if (model.statsLoadedFor !== Number(model.selectedYear) && !model.statsLoading) void loadPlayerStats(model);
    if (model.dataLoadedFor !== Number(model.selectedYear) && !model.dataLoading) void loadSeasonData(model);
    if (model.tab === 'Teams' && model.teamsLoadedFor !== Number(model.selectedYear) && !model.teamsLoading) void loadTeams(model);

    const badge = leagueLogo(model);
    const alert = alertLabel(id);
    const options = model.seasons.length
      ? model.seasons.map(season => `<option value="${esc(season.year)}" ${Number(season.year) === Number(model.selectedYear) ? 'selected' : ''}>${esc(season.leagueName)}</option>`).join('')
      : `<option value="${esc(model.selectedYear)}">${esc(model.selectedYear)} · loading source seasons</option>`;
    const title = props?.name || config.name;
    const tabButtons = TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${model.tab === key}" class="league-tab ${model.tab === key ? 'active' : ''}" data-league-tab="${esc(key)}" data-league-id="${esc(id)}">${esc(label)}</button>`).join('');
    return `<section class="league-experience" aria-label="${esc(title)} league details">
      <header class="league-hero"><div class="league-back-row"><button type="button" data-action="back-leagues" aria-label="Back to leagues">‹</button><span>LEAGUE CENTRE</span><button type="button" class="league-refresh" data-league-action="refresh" data-league-id="${esc(id)}" aria-label="Refresh league data">↻</button></div>
        <div class="league-identity"><span class="league-emblem">${badge ? `<img src="${esc(badge)}" alt="${esc(title)} logo" loading="lazy" decoding="async">` : `<b>${esc(config.mark)}</b>`}</span><div class="league-identity-copy"><h1>${esc(title)}</h1><p>${esc(config.country)}${model.selectedYear ? ` · ${esc(model.selectedYear)} season` : ''}</p></div></div>
        <div class="league-hero-controls"><label class="league-season-picker"><span>Season</span><select data-league-season data-league-id="${esc(id)}" aria-label="Choose ${esc(title)} season">${options}</select></label><button type="button" class="follow ${props.following ? 'following' : ''}" data-action="follow-league" data-id="${esc(id)}">${props.following ? 'Following ✓' : 'Follow +'}</button><button type="button" class="league-alert-button ${alert.active ? 'active' : ''}" data-league-action="notifications" data-league-id="${esc(id)}" ${alert.disabled ? 'disabled' : ''} aria-pressed="${alert.active}"><span aria-hidden="true">${alert.active ? '●' : '○'}</span>${esc(alert.text)}</button></div>
        <p class="league-alert-note">Score alerts work only while this site is open and ESPN score updates are being received. ${model.notice ? ` ${esc(model.notice)}` : ''}</p>
      </header>
      <nav class="league-section-nav" role="tablist" aria-label="${esc(title)} sections">${tabButtons}</nav>
      ${selectedTab(model, { ...props, id })}
      <footer class="league-source-footer">Standings, season list and fixtures/results: <a href="https://www.openligadb.de/" target="_blank" rel="noopener noreferrer">OpenLigaDB</a> (ODbL 1.0). Player statistics, team directory and score updates: <a href="https://www.espn.com/soccer/" target="_blank" rel="noopener noreferrer">ESPN</a>. Only returned data is displayed.</footer>
    </section>`;
  }

  function selectSeason(model, year) {
    const next = Number(year);
    if (!next || next === Number(model.selectedYear)) return;
    model.selectedYear = next;
    model.userPickedSeason = true;
    model.dataLoadedFor = null;
    model.updatedAt = 0;
    model.standings = [];
    model.matches = [];
    model.teamsLoadedFor = null;
    model.statsLoadedFor = null;
    model.fixtureLimit = 36;
    model.round = '';
    notify();
  }

  async function enableAlerts(model) {
    if (typeof Notification === 'undefined') {
      model.notice = 'This browser does not support notifications.';
      notify();
      return;
    }
    if (Notification.permission === 'denied') {
      model.notice = 'Notifications are blocked in this browser for this site.';
      notify();
      return;
    }
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        model.notice = 'Notification permission was not granted.';
        notify();
        return;
      }
      const id = String(model.id);
      if (alertIds.has(id)) {
        alertIds.delete(id);
        model.notice = 'Score alerts disabled for this competition.';
      } else {
        alertIds.add(id);
        model.notice = 'Score alerts enabled while Matchday is open.';
      }
      try { localStorage.setItem(ALERT_KEY, JSON.stringify([...alertIds])); } catch (_) {}
    } catch (error) {
      model.notice = 'Could not enable browser notifications.';
      console.warn('League notifications unavailable:', error);
    }
    notify();
  }

  function eventScore(event) {
    if (!event?.score) return '';
    return `${event.score.home}-${event.score.away}`;
  }

  function onScoresUpdated(previousEvents, nextEvents) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !alertIds.size) return;
    const previous = new Map((Array.isArray(previousEvents) ? previousEvents : []).map(event => [String(event.id), event]));
    for (const event of Array.isArray(nextEvents) ? nextEvents : []) {
      if (!alertIds.has(String(event.competitionId))) continue;
      const old = previous.get(String(event.id));
      if (!old) continue;
      const oldScore = eventScore(old);
      const newScore = eventScore(event);
      if (!newScore || oldScore === newScore) continue;
      const score = event.score;
      const title = `${event.home} ${score.home}–${score.away} ${event.away}`;
      const body = `${event.competition} · ${event.statusText || 'Score updated'} · ESPN`;
      window.setTimeout(() => {
        try { new Notification(title, { body, tag: `matchday-${event.id}` }); } catch (_) {}
      }, NOTIFY_DELAY);
    }
  }

  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-league-tab]');
    if (tab) {
      const model = models.get(String(tab.dataset.leagueId));
      if (!model) return;
      model.tab = tab.dataset.leagueTab;
      model.teamQuery = '';
      model.fixtureLimit = 36;
      notify();
      return;
    }
    const mode = event.target.closest('[data-league-mode]');
    if (mode) { const model = models.get(String(mode.dataset.leagueId)); if (model) { model.standingsMode = mode.dataset.leagueMode; notify(); } return; }
    const split = event.target.closest('[data-league-split]');
    if (split) { const model = models.get(String(split.dataset.leagueId)); if (model) { model.split = split.dataset.leagueSplit; notify(); } return; }
    const fixtureMode = event.target.closest('[data-league-fixture-mode]');
    if (fixtureMode) { const model = models.get(String(fixtureMode.dataset.leagueId)); if (model) { model.fixtureMode = fixtureMode.dataset.leagueFixtureMode; model.fixtureLimit = 36; notify(); } return; }
    const seasonOption = event.target.closest('[data-league-season-option]');
    if (seasonOption) { const model = models.get(String(seasonOption.dataset.leagueId)); if (model) selectSeason(model, seasonOption.dataset.leagueSeasonOption); return; }
    const action = event.target.closest('[data-league-action]');
    if (!action) return;
    const model = models.get(String(action.dataset.leagueId));
    if (!model) return;
    const name = action.dataset.leagueAction;
    if (name === 'notifications') void enableAlerts(model);
    else if (name === 'refresh') {
      model.dataLoadedFor = null; model.updatedAt = 0; model.statsLoadedFor = null; model.teamsLoadedFor = null;
      void loadSeasonData(model, true); void loadPlayerStats(model, true);
      if (model.tab === 'Teams') void loadTeams(model, true);
    } else if (name === 'more-fixtures') { model.fixtureLimit += 36; notify(); }
    else if (name === 'players-more') { model.showAllPlayers = !model.showAllPlayers; notify(); }
  });

  document.addEventListener('change', event => {
    const season = event.target.closest('[data-league-season]');
    if (season) { const model = models.get(String(season.dataset.leagueId)); if (model) selectSeason(model, season.value); return; }
    const round = event.target.closest('[data-league-round]');
    if (round) { const model = models.get(String(round.dataset.leagueId)); if (model) { model.round = round.value; model.fixtureLimit = 36; notify(); } }
  });

  document.addEventListener('input', event => {
    const search = event.target.closest('[data-league-team-search]');
    if (search) { const model = models.get(String(search.dataset.leagueId)); if (model) { model.teamQuery = search.value; notify(); } }
  });

  window.MatchdayLeague = { render, onScoresUpdated };
})();
