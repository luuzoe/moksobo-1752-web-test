#!/usr/bin/env python3
"""Cache owner-approved ESPN public feed responses for the static website.

No scores, players, events or statistics are inferred. The browser retains the
source fetch time and labels this fallback as a snapshot. The existing GitHub
refresh workflow owns recurring execution; this script is finite.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent / 'data' / 'espn'
BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer'
LEAGUES = ['eng.1', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf']
WORKERS = 6


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def read(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temporary.replace(path)


def get(path):
    request = Request(f'{BASE}/{path}', headers={'Accept': 'application/json', 'User-Agent': 'MatchdayStaticFeed/1.0'})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                return json.load(response)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def age(payload):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(payload['fetchedAt'].replace('Z', '+00:00'))).total_seconds()
    except (KeyError, TypeError, ValueError):
        return float('inf')


def main():
    now = datetime.now(timezone.utc)
    team_file = ROOT / 'teams.json'
    previous = read(team_file)
    if not previous or age(previous) > 86400:
        directories = dict((previous or {}).get('leagues', {}))
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            jobs = {pool.submit(get, f'{code}/teams?limit=500'): code for code in LEAGUES}
            for job in as_completed(jobs):
                code = jobs[job]
                try:
                    directories[code] = job.result()
                except Exception as exc:
                    print(f'Directory {code}: preserving previous response ({type(exc).__name__})', flush=True)
        if directories:
            write(team_file, {'provider': 'ESPN', 'fetchedAt': stamp(), 'leagues': directories})
        print(f'Team directories cached: {len(directories)}', flush=True)
    dates = [(now + timedelta(days=offset)).strftime('%Y%m%d') for offset in range(-3, 4)]
    scoreboards = {day: {'provider': 'ESPN', 'fetchedAt': stamp(), 'leagues': {}} for day in dates}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        jobs = {pool.submit(get, f'{code}/scoreboard?dates={day}'): (day, code) for day in dates for code in LEAGUES}
        for job in as_completed(jobs):
            day, code = jobs[job]
            try:
                payload = job.result()
                scoreboards[day]['leagues'][code] = {'events': payload.get('events', [])}
            except Exception as exc:
                print(f'Scoreboard {day}/{code}: unavailable ({type(exc).__name__})', flush=True)
    events = {}
    for day, payload in scoreboards.items():
        # Never replace a complete prior bundle with a partial/failed refresh.
        if len(payload['leagues']) != len(LEAGUES):
            payload = read(ROOT / 'scoreboards' / f'{day}.json') or payload
        else:
            write(ROOT / 'scoreboards' / f'{day}.json', payload)
        for code, board in payload.get('leagues', {}).items():
            for event in board.get('events', []):
                if event.get('id'):
                    events[str(event['id'])] = (code, event)
    print(f'Cached seven selected-date scoreboards; returned fixtures: {len(events)}', flush=True)
    wanted = []
    for event_id, (code, event) in events.items():
        old = read(ROOT / 'summaries' / f'{event_id}.json')
        status = (event.get('status') or {}).get('type') or {}
        ttl = 86400 if status.get('completed') else 1800 if status.get('state') == 'pre' else 240
        if old and age(old) < ttl:
            continue
        wanted.append((event_id, code))
    completed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        jobs = {pool.submit(get, f'{code}/summary?event={event_id}'): (event_id, code) for event_id, code in wanted}
        for job in as_completed(jobs):
            event_id, code = jobs[job]
            try:
                raw = job.result()
                # Keep only fields that the UI displays, verbatim from the feed.
                data = {key: raw[key] for key in ['gameInfo', 'keyEvents', 'rosters', 'boxscore'] if key in raw}
                if raw.get('commentary'):
                    data['commentary'] = raw['commentary'][:100]
                write(ROOT / 'summaries' / f'{event_id}.json', {'provider': 'ESPN', 'fetchedAt': stamp(), 'league': code, 'data': data})
                completed += 1
                if completed % 10 == 0:
                    print(f'Match summaries refreshed: {completed}/{len(wanted)}', flush=True)
            except Exception as exc:
                print(f'Summary {event_id}: preserving previous response ({type(exc).__name__})', flush=True)
    print(f'ESPN same-origin fallback ready: {completed} summaries refreshed.', flush=True)
    if not team_file.exists() or not any((ROOT / 'scoreboards').glob('*.json')):
        raise RuntimeError('No usable ESPN fallback responses were obtained')
    # Retain recent detail caches for date navigation; remove only very old files.
    cutoff = time.time() - 30 * 86400
    for folder in ['scoreboards', 'summaries']:
        for path in (ROOT / folder).glob('*.json'):
            if path.stat().st_mtime < cutoff:
                path.unlink()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
