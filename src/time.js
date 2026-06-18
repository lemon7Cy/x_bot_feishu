export function ingestionWindow(config, now = new Date()) {
  const hours = config.ingestion?.lookbackHours ?? 2;
  return windowFromHours(hours, now);
}

export function sourceIngestionWindow(config, source, now = new Date()) {
  const hours = config.ingestion?.sourceLookbackHours?.[source] ?? config.ingestion?.lookbackHours ?? 2;
  return windowFromHours(hours, now);
}

function windowFromHours(hours, now) {
  return {
    since: new Date(now.getTime() - hours * 60 * 60 * 1000),
    until: now
  };
}

export function digestWindow(config, dateArg, now = new Date()) {
  const timezone = config.timezone || 'Asia/Shanghai';
  if (timezone !== 'Asia/Shanghai') {
    throw new Error('Only Asia/Shanghai digest windows are supported in this version.');
  }
  if (isRollingPrepareWindow(config)) {
    const date = dateArg || currentDateInTimezone(now, timezone);
    const prepareTime = config.scheduler?.prepare?.time || '08:30';
    return {
      date,
      timezone,
      start: new Date(`${previousDate(date)}T${prepareTime}:00+08:00`),
      end: new Date(`${date}T${prepareTime}:00+08:00`)
    };
  }
  const date = dateArg || previousDateInTimezone(now, timezone);
  return {
    date,
    timezone,
    start: new Date(`${date}T00:00:00+08:00`),
    end: new Date(`${nextDate(date)}T00:00:00+08:00`)
  };
}

export function analysisWindow(config, dateArg, now = new Date()) {
  if (dateArg || !isRollingPrepareWindow(config)) return digestWindow(config, dateArg, now);
  const timezone = config.timezone || 'Asia/Shanghai';
  if (timezone !== 'Asia/Shanghai') return digestWindow(config, dateArg, now);
  const date = currentDateInTimezone(now, timezone);
  const prepareTime = config.scheduler?.prepare?.time || '08:30';
  const cutoff = new Date(`${date}T${prepareTime}:00+08:00`);
  return digestWindow(config, now >= cutoff ? nextDate(date) : date, now);
}

export function isRollingPrepareWindow(config) {
  return ['rolling_prepare_time', 'prepare_time_rolling'].includes(config.digest?.window);
}

export function formatDate(value, timezone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone
  }).format(new Date(value));
}

function previousDateInTimezone(now, timezone) {
  const date = currentDateInTimezone(now, timezone);
  return previousDate(date);
}

function currentDateInTimezone(now, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  const utc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(utc).toISOString().slice(0, 10);
}

function previousDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
