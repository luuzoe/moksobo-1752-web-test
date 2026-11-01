'use strict';

(function () {
  const DATA_URL = './data/news.json';
  const CACHE_KEY = 'matchday_bbc_football_news_v2';
  const REFRESH_AFTER_MS = 5 * 60 * 1000;
  let snapshot = null;
  let loading = false;
  let hadError = false;
  let lastRequested = 0;

  function safeParse(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function html(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function fieldString(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (value && typeof value === 'object') {
      if (typeof value.href === 'string') return value.href.trim();
      if (typeof value.url === 'string') return value.url.trim();
      if (typeof value.value === 'string') return value.value.trim();
      if (typeof value['#text'] === 'string') return value['#text'].trim();
      if (value.$ && typeof value.$.url === 'string') return value.$.url.trim();
      if (Array.isArray(value) && value.length) return fieldString(value[0]);
    }
    return '';
  }

  function bbcUrl(value) {
    const original = fieldString(value);
    if (!original) return '';
    try {
      const url = new URL(original, location.href);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'bbc.co.uk' || host.endsWith('.bbc.co.uk') || host === 'bbc.com' || host.endsWith('.bbc.com'))) return '';
      return original;
    } catch (_) { return ''; }
  }

  function bbcImageUrl(value) {
    const original = fieldString(value);
    if (!original) return '';
    try {
      const url = new URL(original, location.href);
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'ichef.bbci.co.uk') return '';
      return original;
    } catch (_) { return ''; }
  }

  function dateIso(value) {
    if (value === null || value === undefined || value === '') return '';
    let input = value;
    if (typeof input === 'number' || (typeof input === 'string' && /^\d{10,13}$/.test(input.trim()))) {
      const number = Number(input);
      input = number < 100000000000 ? number * 1000 : number;
    }
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function canonicalLink(value) {
    const valid = bbcUrl(value);
    if (!valid) return '';
    try {
      const url = new URL(valid, location.href);
      url.search = '';
      url.hash = '';
      return url.href.toLowerCase().replace(/\/$/, '');
    } catch (_) { return valid.toLowerCase(); }
  }

  function imageFrom(item) {
    const values = [
      item.image, item.imageUrl, item.image_url, item.thumbnail, item['media:thumbnail'],
      item.mediaThumbnail, item.media_thumbnail, item.enclosure, item.media?.thumbnail,
      item.media?.content, item.media_content
    ];
    for (const value of values) {
      const url = bbcImageUrl(value);
      if (url) return url;
    }
    return '';
  }

  function articleRows(document) {
    let source = safeParse(document);
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const key of ['payload', 'data', 'result']) {
        const nested = safeParse(source[key]);
        if (nested && nested !== source && typeof nested === 'object') {
          const rows = articleRows(nested);
          if (rows.length) return rows;
        }
      }
      for (const key of ['articles', 'items', 'entries', 'stories']) {
        if (Array.isArray(source[key])) return source[key];
      }
      if (source.item && typeof source.item === 'object') return [source.item];
      if (source.title || source.guid || source.link || source.url) return [source];
    }
    return Array.isArray(source) ? source : [];
  }

  function normalizeArticle(item) {
    if (!item || typeof item !== 'object') return null;
    const title = fieldString(item.title || item.headline);
    const url = bbcUrl(item.link || item.url || item.articleUrl || item.article_url || item.href);
    if (!title || !url) return null;
    const time = item.time ?? item.publishedAt ?? item.published_at ?? item.pubDate ?? item.published ?? item.date ?? item.updated;
    const author = fieldString(item.author || item.creator || item['dc:creator'] || item['author:name'] || (Array.isArray(item.authors) ? item.authors[0] : ''));
    return {
      guid: fieldString(item.guid || item.id || item.identifier),
      title,
      url,
      description: fieldString(item.summary || item.description || item.contentSnippet || item.content_snippet || item.subtitle),
      author,
      publishedAt: dateIso(time),
      publisher: 'BBC Sport',
      imageUrl: imageFrom(item)
    };
  }

  function deduplicate(rows) {
    const items = rows.map(normalizeArticle).filter(Boolean);
    items.sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0));
    const output = [];
    const guidIndex = new Map();
    const linkIndex = new Map();
    for (const item of items) {
      const guidKey = item.guid ? item.guid.trim().toLowerCase() : '';
      const linkKey = canonicalLink(item.url);
      const existing = (guidKey && guidIndex.get(guidKey)) || (linkKey && linkIndex.get(linkKey));
      if (existing) {
        const newer = (Date.parse(item.publishedAt || '') || 0) > (Date.parse(existing.item.publishedAt || '') || 0);
        const preferred = newer ? item : existing.item;
        const other = newer ? existing.item : item;
        const merged = {
          ...other,
          ...preferred,
          guid: preferred.guid || other.guid,
          description: preferred.description || other.description,
          author: preferred.author || other.author,
          imageUrl: preferred.imageUrl || other.imageUrl,
          publishedAt: preferred.publishedAt || other.publishedAt,
          url: preferred.url || other.url,
          publisher: 'BBC Sport'
        };
        output[existing.index] = merged;
        existing.item = merged;
        if (guidKey) guidIndex.set(guidKey, existing);
        if (linkKey) linkIndex.set(linkKey, existing);
        if (merged.guid) guidIndex.set(merged.guid.trim().toLowerCase(), existing);
        const mergedLink = canonicalLink(merged.url);
        if (mergedLink) linkIndex.set(mergedLink, existing);
      } else {
        const entry = { item, index: output.length };
        output.push(item);
        if (guidKey) guidIndex.set(guidKey, entry);
        if (linkKey) linkIndex.set(linkKey, entry);
      }
    }
    return output.sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0));
  }

  function normalizedSnapshot(document) {
    const source = safeParse(document);
    const rows = articleRows(source);
    const articles = deduplicate(rows);
    const fetchedAt = dateIso(source?.fetchedAt || source?.updatedAt || source?.syncedAt || source?.lastUpdated || source?.time);
    return {
      provider: 'BBC Sport',
      feedUrl: fieldString(source?.feedUrl || source?.sourceUrl) || 'https://feeds.bbci.co.uk/sport/football/rss.xml?edition=int',
      fetchedAt,
      articles,
      recognized: rows.length > 0 || Array.isArray(source?.articles) || Array.isArray(source?.items) || Array.isArray(source?.entries)
    };
  }

  try {
    const cached = normalizedSnapshot(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached.articles.length) snapshot = cached;
    else {
      const oldCache = safeParse(localStorage.getItem('matchday_bbc_football_news_v1'));
      if (oldCache && Array.isArray(oldCache.articles)) snapshot = normalizedSnapshot(oldCache);
    }
  } catch (_) {}

  function formatDate(value) {
    if (!value) return 'Publication time unavailable';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Publication time unavailable';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function notifyUpdated() {
    window.dispatchEvent(new Event('matchday-news-updated'));
  }

  async function load(force) {
    const now = Date.now();
    if (loading || (!force && now - lastRequested < REFRESH_AFTER_MS)) return;
    loading = true;
    lastRequested = now;
    hadError = false;
    notifyUpdated();
    try {
      const response = await fetch(`${DATA_URL}?v=${Math.floor(now / 60000)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`News data returned ${response.status}`);
      const result = normalizedSnapshot(await response.json());
      if (!result.recognized) throw new Error('News data did not contain RSS article items');
      snapshot = result;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)); } catch (_) {}
    } catch (error) {
      hadError = true;
      console.warn('Football news could not be refreshed:', error);
    } finally {
      loading = false;
      notifyUpdated();
    }
  }

  function render() {
    if (!lastRequested || Date.now() - lastRequested >= REFRESH_AFTER_MS) void load(false);
    const articles = snapshot?.articles || [];
    const latest = articles[0]?.publishedAt || '';
    const status = hadError && articles.length
      ? '<p class="news-status news-status-warning">Could not refresh the saved BBC feed data just now; showing the latest verified stories already on this page.</p>'
      : latest ? `<p class="news-status">Latest story published ${html(formatDate(latest))}</p>` : '';

    let content;
    if (articles.length) {
      content = `<div class="news-list">${articles.map(article => {
        const image = bbcImageUrl(article.imageUrl);
        const iso = dateIso(article.publishedAt);
        return `<article class="news-story">
          <div class="news-story-meta"><a class="news-source" href="https://www.bbc.com/sport/football" target="_blank" rel="noopener noreferrer">BBC Sport</a>${article.author ? `<span class="news-author">By ${html(article.author)}</span>` : ''}${image ? '<span class="news-image-credit">Photo: BBC Sport</span>' : ''}${iso ? `<time datetime="${html(iso)}">Published ${html(formatDate(iso))}</time>` : '<span>Publication time unavailable</span>'}</div>
          <div class="news-story-layout"><div class="news-story-copy"><h2>${html(article.title)}</h2>
            ${article.description ? `<p>${html(article.description)}</p>` : ''}
          </div>${image ? `<img class="news-image" src="${html(image)}" alt="" loading="lazy" decoding="async">` : ''}</div>
        </article>`;
      }).join('')}</div>`;
    } else if (loading) {
      content = '<div class="news-empty"><strong>Loading football news…</strong><span>Checking the latest BBC Sport RSS items.</span></div>';
    } else if (hadError) {
      content = '<div class="news-empty"><strong>News could not be loaded</strong><span>The saved BBC Sport feed data is temporarily unavailable. Try again shortly.</span></div>';
    } else {
      content = '<div class="news-empty"><strong>No recent stories are available</strong><span>No verified BBC Sport RSS items are present in the published feed data yet.</span></div>';
    }

    return `<section class="news-feed" aria-label="Latest football news">
      <header class="news-heading"><div><p class="news-eyebrow">BBC SPORT · FOOTBALL</p><h1>Latest news</h1><p class="news-intro">Stories from the BBC Sport Football RSS feed, with original source links and publication times.</p></div><button class="news-refresh" type="button" data-news-refresh ${loading ? 'disabled' : ''}>${loading ? 'Updating…' : 'Refresh'}</button></header>
      ${status}${content}
      <p class="news-attribution">Titles, summaries, dates and images are shown only when supplied by <a href="https://www.bbc.com/sport/football" target="_blank" rel="noopener noreferrer">BBC Sport Football</a>. BBC image credit is shown with each feed-provided image. Times use your device’s local time.</p>
    </section>`;
  }

  document.addEventListener('click', event => {
    if (event.target.closest('[data-news-refresh]')) {
      event.preventDefault();
      void load(true);
    }
  });

  window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true);
  }, REFRESH_AFTER_MS);

  window.MatchdayNews = { render };
})();
