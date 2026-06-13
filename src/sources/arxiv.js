import { fetchText, matchKeywords, truncate } from '../utils.js';
import { keywordsForSource } from '../sourceKeywords.js';

export async function fetchArxiv(config, window) {
  const keywords = keywordsForSource(config, 'arxiv');
  const query = keywords.map((kw) => `all:${quoteArxiv(kw)}`).join('+OR+');
  const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${config.ingestion?.maxItemsPerSource || 100}&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1]);
  return entries.map(parseEntry).filter((item) => {
    const published = new Date(item.publishedAt);
    return published >= window.since && published < window.until && matchKeywords(`${item.title} ${item.summary}`, keywords).length > 0;
  });
}

function parseEntry(entry) {
  const title = cleanXml(textBetween(entry, 'title'));
  const summary = cleanXml(textBetween(entry, 'summary'));
  const publishedAt = textBetween(entry, 'published') || textBetween(entry, 'updated');
  const url = textBetween(entry, 'id');
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
    .slice(0, 4)
    .map((match) => cleanXml(match[1]))
    .join(', ');
  return {
    source: 'arxiv',
    sourceType: 'paper',
    sourceItemId: url.replace('http://arxiv.org/abs/', '').replace('https://arxiv.org/abs/', ''),
    canonicalUrl: url,
    title,
    summary: truncate(summary, 500),
    author: authors,
    authorId: '',
    publishedAt: new Date(publishedAt).toISOString(),
    raw: { authors, arxivUrl: url }
  };
}

function quoteArxiv(keyword) {
  return keyword.includes(' ') ? `%22${encodeURIComponent(keyword).replaceAll('%20', '+')}%22` : encodeURIComponent(keyword);
}

function textBetween(text, tag) {
  return text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
}

function cleanXml(text) {
  return decodeEntities(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(text) {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}
