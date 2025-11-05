

// middleware/requestId.js
'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

function requestIdMiddleware(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  req.log = (...args) => logger.req(req.requestId, ...args); // Use the unified logger
  next();
}

module.exports = requestIdMiddleware;
