import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(root = process.cwd()) {
  const values = process.env.ENV_OVERRIDE === '1' ? {} : { ...process.env };
  const filePath = path.join(root, '.env');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, '');
      values[key] = value;
    }
  } catch {
    // Missing .env is valid for cron environments that provide real env vars.
  }
  return process.env.ENV_OVERRIDE === '1' ? { ...values, ...process.env } : values;
}

export function resolveFromRoot(root, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}
