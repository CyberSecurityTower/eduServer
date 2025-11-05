
// services/data/firestore.js
'use strict';

const admin = require('firebase-admin');
const logger = require('../../utils/logger');

let db;

function initializeFirestore() {
  if (db) return db; // Already initialized

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    logger.error('Missing FIREBASE_SERVICE_ACCOUNT_KEY env var. Exiting.');
    process.exit(1);
  }

  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch (e) {
      try { serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
      catch (e2) { serviceAccount = JSON.parse(raw.replace(/\\n/g, '\n')); }
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    logger.success('Firebase Admin initialized.');
    return db;
  } catch (err) {
    logger.error('Firebase init failed:', err.message || err);
    process.exit(1);
  }
}

function getFirestoreInstance() {
  if (!db) {
    logger.warn('Firestore instance requested before initialization. Initializing now.');
    return initializeFirestore();
  }
  return db;
}

module.exports = {
  initializeFirestore,
  getFirestoreInstance,
  admin, // Export admin for FieldValue, Timestamp etc.
};
