const admin = require('firebase-admin');

const db = admin.firestore();
const COLLECTION_NAME = 'entrenamientos_pendientes';

async function createTrainingJob(symbols, metadata = {}) {
  const jobRef = db.collection(COLLECTION_NAME).doc();
  await jobRef.set({
    symbols,
    status: 'pending',
    metadata,
    logs: {},
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return jobRef.id;
}

async function pullPendingJob() {
  const snapshot = await db.collection(COLLECTION_NAME)
    .where('status', '==', 'pending')
    .orderBy('createdAt')
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  await doc.ref.update({
    status: 'running',
    startedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function updateJobLogs(ref, symbol, payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const cleanPayload = Object.entries(payload).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});

  if (!Object.keys(cleanPayload).length) {
    return;
  }

  const path = `logs.${symbol}`;
  await ref.update({
    [path]: cleanPayload
  });
}

async function finalizeJob(ref, updates = {}) {
  await ref.update({
    ...updates,
    finishedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

module.exports = {
  createTrainingJob,
  pullPendingJob,
  updateJobLogs,
  finalizeJob
};
