/**
 * Zhenzhu Miner — logger
 *
 * Writes to stdout and to a log file, with a level and a timestamp. Telegram
 * notifications are sent from notify.js; this module only handles local output.
 */

const fs = require('fs');
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.ZZ_LOG_LEVEL || 'info'] || LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    fs.appendFileSync(config.logFile, `${line}\n`);
  } catch {
    // a full disk must not stop the miner
  }
}

module.exports = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
