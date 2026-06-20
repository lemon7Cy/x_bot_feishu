export function truncate(text, max) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

export function matchKeywords(text, keywords) {
  const value = String(text || '');
  return [...new Set((keywords || []).filter((keyword) => keywordMatches(value, keyword)))];
}

export function keywordMatches(text, keyword) {
  const term = String(keyword || '').trim();
  if (!term) return false;
  const value = String(text || '');
  if (hasCjk(term)) return value.toLowerCase().includes(term.toLowerCase());
  return keywordRegex(term).test(value);
}

function keywordRegex(term) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(term).replace(/\s+/g, '\\s+')}($|[^A-Za-z0-9])`, 'i');
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
