
// utils/logger.js
'use strict';

const iso = () => new Date().toISOString();

const logger = {
  info: (msg, ...args) => console.log(`\x1b[36m${iso()} [INFO] ${msg}\x1b[0m`, ...args),
  success: (msg, ...args) => console.log(`\x1b[32m${iso()} [SUCCESS] ${msg}\x1b[0m`, ...args),
  warn: (msg, ...args) => console.warn(`\x1b[33m${iso()} [WARN] ${msg}\x1b[0m`, ...args),
  error: (msg, ...args) => console.error(`\x1b[31m${iso()} [ERROR] ${msg}\x1b[0m`, ...args),
  log: (msg, ...args) => console.log(`${iso()} [LOG] ${msg}`, ...args),
  // Request-specific logger (will be assigned in middleware)
  req: (requestId, ...args) => console.log(iso(), `[req:${requestId}]`, ...args)
};

module.exports = logger;
