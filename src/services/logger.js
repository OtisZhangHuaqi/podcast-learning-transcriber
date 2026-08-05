const fs = require('fs');
const os = require('os');
const path = require('path');

let logDirectory = null;

function configureLogger(directory) {
  logDirectory = directory;
  fs.mkdirSync(logDirectory, { recursive: true });
  return logDirectory;
}

function getLogDirectory() {
  return logDirectory;
}

function redactText(value) {
  let text = String(value ?? '');
  const home = os.homedir();
  if (home) text = text.split(home).join('<HOME>');
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<REDACTED_API_KEY>')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/g, '<REDACTED_TOKEN>')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <REDACTED>')
    .replace(/([?&](?:token|key|api_key|auth|signature|sig)=)[^&#\s]+/gi, '$1<REDACTED>');
}

function sanitize(value, depth = 0) {
  if (depth > 5) return '<MAX_DEPTH>';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/api.?key|password|secret|cookie|authorization|token/i.test(key)) result[key] = '<REDACTED>';
      else result[key] = sanitize(item, depth + 1);
    }
    return result;
  }
  return redactText(value);
}

function dailyLogPath(date = new Date()) {
  if (!logDirectory) return null;
  return path.join(logDirectory, `podcast-transcriber-${date.toISOString().slice(0, 10)}.jsonl`);
}

function serializeError(error) {
  return sanitize({
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code,
    stack: error?.stack,
    process: error?.processDetails,
    cause: error?.cause && {
      name: error.cause.name,
      message: error.cause.message,
      code: error.cause.code
    }
  });
}

function logError(scope, error, context = {}) {
  if (!logDirectory) return null;
  const target = dailyLogPath();
  const record = {
    timestamp: new Date().toISOString(),
    level: 'error',
    scope,
    platform: process.platform,
    arch: process.arch,
    context: sanitize(context),
    error: serializeError(error)
  };
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
    return target;
  } catch (writeError) {
    console.error('Unable to write application error log:', writeError);
    return null;
  }
}

module.exports = {
  configureLogger,
  dailyLogPath,
  getLogDirectory,
  logError,
  redactText,
  sanitize,
  serializeError
};
