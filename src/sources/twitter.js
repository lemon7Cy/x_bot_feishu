import { spawn } from 'node:child_process';
import { resolveFromRoot } from '../env.js';

export async function fetchTwitter(config, window, env, root = process.cwd()) {
  if (config.twitter?.provider !== 'twscrape') {
    throw new Error(`Unsupported Twitter provider: ${config.twitter?.provider || 'missing'}`);
  }
  const python = env.PYTHON_BIN || 'python3';
  const script = resolveFromRoot(root, config.twitter?.script || './scripts/x_fetch.py');
  const dbPath = resolveFromRoot(root, env.TWSCRAPE_DB_PATH || config.twitter?.dbPath || './data/twscrape/accounts.db');
  const request = {
    keywords: config.keywords,
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    language: config.twitter?.language,
    excludeRetweets: config.twitter?.excludeRetweets !== false,
    limit: config.twitter?.limit || 100,
    dbPath
  };
  return runPythonJson(python, [script], request, 90000);
}

function runPythonJson(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Twitter scraper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Twitter scraper exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch (error) {
        reject(new Error(`Twitter scraper returned invalid JSON: ${error.message}; stderr=${stderr.trim()}`));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
