'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MIN = LEVELS[String(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'))] ?? 2;

function emit(level, scope, message, meta) {
  if (LEVELS[level] > MIN) return;
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: message,
  };
  if (meta !== undefined) line.meta = meta;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

module.exports = {
  error: (scope, message, meta) => emit('error', scope, message, meta),
  warn: (scope, message, meta) => emit('warn', scope, message, meta),
  info: (scope, message, meta) => emit('info', scope, message, meta),
  debug: (scope, message, meta) => emit('debug', scope, message, meta),
};
