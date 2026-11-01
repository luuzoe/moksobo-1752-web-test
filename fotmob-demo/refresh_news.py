#!/usr/bin/env python3
"""Refresh Matchday's BBC Sport RSS snapshot with source-provided stories only."""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

FEED_URL = 'https://feeds.bbci.co.uk/sport/football/rss.xml?edition=int'
DATA_FILE = Path(__file__).resolve().parent / 'data' / 'news.json'
MIN_REFRESH_SECONDS = 15 * 60
PRESERVE_DAYS = 30
MAX_ARTICLES = 25
DC_NS = '{http://purl.org/dc/elements/1.1/}'


class PlainText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag.lower() in {'br', 'p', 'div', 'li'}:
            self.parts.append(' ')

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {'p', 'div', 'li'}:
            self.parts.append(' ')


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, OverflowError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def published_at(value: str) -> str:
    parsed = parse_timestamp(value)
    return parsed.isoformat(timespec='seconds').replace('+00:00', 'Z') if parsed else ''


def is_bbc_url(value: str, image: bool = False) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    host = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme != 'https':
        return False
    if image:
        return host == 'ichef.bbci.co.uk'
    return host in {'bbc.co.uk', 'bbc.com'} or host.endswith('.bbc.co.uk') or host.endswith('.bbc.com')


def canonical_link(value: str) -> str:
    try:
        parsed = urlsplit(value)
        return urlunsplit(('https', parsed.netloc.lower(), parsed.path.rstrip('/'), '', '')).lower()
    except ValueError:
        return value.lower().strip()


def item_text(item: ET.Element, name: str) -> str:
    child = item.find(name)
    if child is None:
        return ''
    return ''.join(child.itertext()).strip()


def clean_description(value: str) -> str:
    if not value:
        return ''
    parser = PlainText()
    try:
        parser.feed(html.unescape(value))
        return re.sub(r'\s+', ' ', ''.join(parser.parts)).strip()
    except Exception:
        return re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', ' ', html.unescape(value))).strip()


def image_url(item: ET.Element) -> str:
    candidates: list[str] = []
    for element in item.iter():
        local_name = element.tag.rsplit('}', 1)[-1].lower()
        if local_name in {'thumbnail', 'content', 'enclosure'}:
            value = (element.attrib.get('url') or element.attrib.get('href') or '').strip()
            if value:
                candidates.append(value)
    return next((url for url in candidates if is_bbc_url(url, image=True)), '')


def make_articles(root: ET.Element) -> list[dict[str, str]]:
    articles: list[dict[str, str]] = []
    for item in root.findall('./channel/item'):
        title = item_text(item, 'title')
        link = item_text(item, 'link')
        if not title or not is_bbc_url(link):
            continue
        articles.append({
            'guid': item_text(item, 'guid') or link,
            'title': title,
            'url': link,
            'description': clean_description(item_text(item, 'description')),
            'author': item_text(item, DC_NS + 'creator'),
            'publishedAt': published_at(item_text(item, 'pubDate')),
            'publisher': 'BBC Sport',
            'imageUrl': image_url(item),
        })
    return sorted(articles, key=lambda row: row['publishedAt'], reverse=True)


def previous_verified_articles(now: datetime) -> list[dict[str, str]]:
    try:
        snapshot = json.loads(DATA_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    cutoff = now - timedelta(days=PRESERVE_DAYS)
    articles = []
    for row in snapshot.get('articles', []):
        if not isinstance(row, dict):
            continue
        title = str(row.get('title') or '').strip()
        link = str(row.get('url') or '').strip()
        when = parse_timestamp(row.get('publishedAt'))
        if not title or not is_bbc_url(link) or not when or when < cutoff:
            continue
        image = str(row.get('imageUrl') or '').strip()
        if not is_bbc_url(image, image=True):
            image = ''
        articles.append({
            'guid': str(row.get('guid') or link),
            'title': title,
            'url': link,
            'description': str(row.get('description') or '').strip(),
            'author': str(row.get('author') or '').strip(),
            'publishedAt': when.isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'publisher': 'BBC Sport',
            'imageUrl': image,
        })
    return sorted(articles, key=lambda row: row['publishedAt'], reverse=True)


def merge_recent_articles(current: list[dict[str, str]], previous: list[dict[str, str]]) -> list[dict[str, str]]:
    current_links = {canonical_link(row['url']) for row in current}
    preserved = [row for row in previous if canonical_link(row['url']) not in current_links]
    preserved.sort(key=lambda row: row['publishedAt'], reverse=True)
    current_limit = max(0, MAX_ARTICLES - min(len(preserved), MAX_ARTICLES))
    combined = current[:current_limit] + preserved[:MAX_ARTICLES]
    return sorted(combined, key=lambda row: row['publishedAt'], reverse=True)[:MAX_ARTICLES]


def snapshot_is_recent(now: datetime) -> bool:
    try:
        existing = json.loads(DATA_FILE.read_text(encoding='utf-8'))
        fetched = parse_timestamp(existing.get('fetchedAt'))
        return bool(fetched and (now - fetched).total_seconds() < MIN_REFRESH_SECONDS)
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def write_snapshot(payload: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temporary.replace(DATA_FILE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='Fetch the RSS feed even if the last snapshot is under 15 minutes old.')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    if not args.force and snapshot_is_recent(now):
        print('BBC news snapshot is less than 15 minutes old; skipping the RSS request.')
        return 0

    request = Request(FEED_URL, headers={
        'Accept': 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'MatchdayBBCNews/1.0 (+https://github.com/luuzoe/moksobo-1752-web-test)',
    })
    try:
        with urlopen(request, timeout=20) as response:
            root = ET.fromstring(response.read())
    except Exception as exc:
        print(f'BBC Sport RSS refresh failed; retaining the existing news snapshot ({type(exc).__name__}: {exc}).', file=sys.stderr)
        return 1

    current = make_articles(root)
    if not current:
        print('BBC Sport RSS returned no verified BBC football stories; retaining the existing news snapshot.', file=sys.stderr)
        return 1

    articles = merge_recent_articles(current, previous_verified_articles(now))
    payload = {
        'provider': 'BBC Sport',
        'feedUrl': FEED_URL,
        'fetchedAt': stamp(),
        'articles': articles,
    }
    write_snapshot(payload)
    print(f'BBC Sport news snapshot refreshed from RSS: {len(articles)} recent verified articles.')
    print(f'Latest story: {articles[0]["title"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
