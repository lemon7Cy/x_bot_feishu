export function truncate(text, max) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

export function matchKeywords(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return [...new Set(keywords.filter((keyword) => lower.includes(keyword.toLowerCase())))];
}

export function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export function compactError(message, max = 360) {
  return String(message || '')
    .replace(/<!DOCTYPE html>[\s\S]*/gi, '<html>')
    .replace(/<html>[\s\S]*/gi, '<html>')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url} ${text.slice(0, 300)}`);
  return text;
}
