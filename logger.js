const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
// level: error < warn < info

const LEVEL_ORDER = {
  error: 0,
  warn: 1,
  info: 2
};

function stamp() {
  return new Date().toISOString();
}

function normalize(level) {
  return LEVEL_ORDER[level] !== undefined ? level : 'info';
}

function shouldLog(level) {
  const current = normalize(LOG_LEVEL);
  const target = normalize(level);
  return LEVEL_ORDER[target] <= LEVEL_ORDER[current];
}

function serialize(data) {
  if (data === undefined) return '';
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data);
    } catch {
      return '[unserializable]';
    }
  }
  return String(data);
}

function base(level, message, data) {
  const head = `[${stamp()}] [${level.toUpperCase()}]`;
  const body = data !== undefined
    ? `${message} ${serialize(data)}`
    : message;

  return `${head} ${body}`;
}

// ================= EXPORT =================

export function log(message, data) {
  if (!shouldLog('info')) return;
  console.log(base('info', message, data));
}

export function warn(message, data) {
  if (!shouldLog('warn')) return;
  console.warn(base('warn', message, data));
}

export function error(message, data) {
  if (!shouldLog('error')) return;
  console.error(base('error', message, data));
}