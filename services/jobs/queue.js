
// services/jobs/queue.js
'use strict';

const { getFirestoreInstance, admin } = require('../data/firestore');
const logger = require('../../utils/logger');

const db = getFirestoreInstance();

async function enqueueJob(job) {
  try {
    const doc = await db.collection('jobs').add({
      ...job,
      status: 'queued',
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return doc.id;
  } catch (err) {
    logger.error('enqueueJob failed:', err.message);
    return null;
  }
}

module.exports = {
  enqueueJob,
};
