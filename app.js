// app.js
'use strict';

const express = require('express');
const cors = require('cors');
const requestIdMiddleware = require('./middleware/requestId');
const appRoutes = require('./routes');
const logger = require('./utils/logger');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: process.env.BODY_LIMIT || '300kb' }));
app.use(requestIdMiddleware); // Custom request ID and logger

// Routes
app.use('/', appRoutes);

// Error handling middleware (optional, but good practice)
app.use((err, req, res, next) => {
  logger.error(`Unhandled error for request ${req.requestId}:`, err.stack);
  res.status(500).json({ error: 'An unexpected error occurred.' });
});

module.exports = app;
