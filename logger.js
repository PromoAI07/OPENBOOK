// logger.js
// Structured logging for OpenBook, built on pino (pure JS, no native build, no
// build step). Shared by server.js (HTTP requests + errors) and db.js (slow
// queries).
//
// Output:
//   - production (NODE_ENV=production): newline-delimited JSON to stdout, ideal
//     for log aggregators.
//   - development: human-friendly colorized output via pino-pretty (a dev-only
//     dependency; falls back to JSON if it is not installed).
//
// Verbosity is controlled by a single env var, LOG_LEVEL
// (trace | debug | info | warn | error | fatal). Default: info in production,
// debug in development.
//
// Slow-query threshold is DB_SLOW_MS (default 100). Queries at or above it are
// logged at warn by db.js.

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');
const base = { level, serializers: { err: pino.stdSerializers.err } };

let logger;
if (isProd) {
  logger = pino(base);
} else {
  // Pretty output in dev. Use pino-pretty as a synchronous destination stream
  // (no worker thread) and degrade gracefully to JSON if it is not present.
  try {
    const pretty = require('pino-pretty');
    logger = pino(base, pretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }));
  } catch (e) {
    logger = pino(base);
  }
}

const DB_SLOW_MS = Number(process.env.DB_SLOW_MS || 100);

module.exports = { logger, DB_SLOW_MS };
