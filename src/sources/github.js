import { fetchJson, truncate } from '../utils.js';

export async function fetchGitHub(config, window, env) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'x-bot-feishu-monitor'
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const tasks = [];
  for (const keyword of config.keywords) {
    if (config.github.searchTypes.includes('repositories')) {
      const q = `${keyword} in:name,description,readme pushed:>=${dateOnly(window.since)}`;
      tasks.push(fetchGitHubSearch('repositories', q, headers, keyword));
    }
    if (config.github.searchTypes.includes('issues')) {
      const q = `${keyword} updated:>=${dateOnly(window.since)}`;
      tasks.push(fetchGitHubSearch('issues', q, headers, keyword));
    }
  }
  const items = (await Promise.all(tasks)).flat();
  return items.filter((item) => {
    const published = new Date(item.publishedAt);
    return published >= window.since && published < window.until;
  });
}

async function fetchGitHubSearch(type, query, headers, searchKeyword) {
  const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=20`;
  const data = await fetchJson(url, { headers });
  return (data.items || []).map((item) => normalizeGitHubItem(type, item, searchKeyword));
}

function normalizeGitHubItem(type, item, searchKeyword) {
  const isRepo = type === 'repositories';
  const repoName = isRepo ? item.full_name : item.repository_url?.replace('https://api.github.com/repos/', '');
  const title = isRepo ? item.full_name : item.title;
  const summary = isRepo
    ? `${item.description || 'No description'} | stars ${item.stargazers_count ?? 0}`
    : `${repoName || 'GitHub'} #${item.number}`;
  return {
    source: 'github',
    sourceType: isRepo ? 'repo' : item.pull_request ? 'pull_request' : 'issue',
    sourceItemId: `${type}:${item.id}`,
    canonicalUrl: item.html_url,
    title,
    summary: truncate(summary, 500),
    author: item.owner?.login || item.user?.login || '',
    authorId: String(item.owner?.id || item.user?.id || ''),
    publishedAt: new Date(item.updated_at || item.created_at).toISOString(),
    raw: {
      stars: item.stargazers_count ?? 0,
      repo: repoName,
      keyword: searchKeyword,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }
  };
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}
