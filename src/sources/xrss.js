import { fetchText, matchKeywords, truncate } from '../utils.js';

const DEFAULT_INSTANCES = [
  'https://xcancel.com',
  'https://nitter.poast.org',
  'https://nitter.privacyredirect.com'
];

export async function fetchXRss(config, window) {
  const instances = config.xrss?.instances?.length ? config.xrss.instances : DEFAULT_INSTANCES;
  const limit = config.xrss?.limit || 50;
  const errors = [];
  for (const instance of instances) {
    try {
      const items = await fetchFromInstance(instance, config, window, limit);
      if (items.length > 0) return items;
    } catch (error) {
      errors.push(`${instance}: ${error.message}`);
    }
  }
  if (errors.length > 0) throw new Error(`X RSS instances failed: ${errors.join(' | ')}`);
  return [];
}

async function fetchFromInstance(instance, config, window, limit) {
  const out = [];
  const errors = [];
  for (const keyword of config.keywords || []) {
    try {
      const query = buildQuery(keyword, config.xrss || {});
      const url = `${instance.replace(/\/$/, '')}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;
      const xml = await fetchTextWithTimeout(url, 8000, { headers: { 'User-Agent': 'x-bot-feishu-monitor/0.1 low-frequency-rss' } });
      const entries = parseRss(xml, instance, keyword)
        .filter((item) => new Date(item.publishedAt) >= window.since && new Date(item.publishedAt) < window.until);
      out.push(...entries);
    } catch (error) {
      errors.push(`${keyword}: ${error.message}`);
    }
    if (out.length >= limit) break;
  }
  const deduped = dedupe(out).slice(0, limit);
  if (deduped.length === 0 && errors.length > 0) throw new Error(errors.join(' | '));
  return deduped;
}

async function fetchTextWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchText(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildQuery(keyword, config) {
  const parts = [keyword.includes(' ') ? `"${keyword}"` : keyword];
  if (config.language) parts.push(`lang:${config.language}`);
  if (config.excludeRetweets !== false) parts.push('-filter:retweets');
  return parts.join(' ');
}

function parseRss(xml, instance, keyword) {
  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1]);
  return entries.map((entry) => {
    const title = cleanXml(textBetween(entry, 'title'));
    const description = cleanXml(textBetween(entry, 'description'));
    const link = cleanXml(textBetween(entry, 'link'));
    const pubDate = cleanXml(textBetween(entry, 'pubDate'));
    const statusId = extractStatusId(link) || stableId(link || title);
    const author = extractAuthor(link);
    return {
      source: 'xrss',
      sourceType: 'post',
      sourceItemId: statusId,
      canonicalUrl: normalizeTweetUrl(link, instance),
      title: truncate(title || description, 140),
      summary: truncate(description || title, 500),
      author: author ? `@${author}` : '',
      authorId: author || '',
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      raw: { keyword, mirrorUrl: link, instance }
    };
  }).filter((item) => item.canonicalUrl && matchKeywords(`${item.title} ${item.summary}`, [keyword]).length > 0);
}

function textBetween(text, tag) {
  return text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
}

function cleanXml(text) {
  return decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(text) {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractStatusId(url) {
  return String(url || '').match(/status\/(\d+)/)?.[1] || '';
}

function extractAuthor(url) {
  return String(url || '').match(/\/([^/?#]+)\/status\/\d+/)?.[1] || '';
}

function normalizeTweetUrl(url, instance) {
  const statusId = extractStatusId(url);
  const author = extractAuthor(url);
  if (statusId && author) return `https://x.com/${author}/status/${statusId}`;
  if (url?.startsWith('/')) return `${instance.replace(/\/$/, '')}${url}`;
  return url;
}

function stableId(value) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `rss-${Math.abs(hash)}`;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.sourceItemId || item.canonicalUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
