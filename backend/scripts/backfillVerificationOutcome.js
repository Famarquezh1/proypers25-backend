const db = require('../firebase-admin-config');

const outcomeOf = (verification) => {
  if (!verification) return null;
  const expired = verification.expired || verification.outcome_label === 'EXPIRED' || verification.outcome === 'EXPIRED';
  const directionMatch = verification.direction_match;
  const reachedTarget = verification.reached_target;
  if (expired) return 'EXPIRED';
  if (directionMatch && reachedTarget) return 'WIN';
  if (directionMatch && !reachedTarget) return 'LUCKY_WIN';
  return 'LOSS';
};

async function main() {
  const snapshot = await db.collection('velas_predicciones').get();
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  for (const doc of snapshot.docs) {
    processed += 1;
    const data = doc.data();
    if (!data?.verification) {
      skipped += 1;
      continue;
    }
    if (data.verification_outcome) {
      skipped += 1;
      continue;
    }
    const outcome = outcomeOf(data.verification);
    if (!outcome) {
      skipped += 1;
      continue;
    }
    await doc.ref.update({ verification_outcome: outcome });
    updated += 1;
  }
  console.log(`Procesadas: ${processed}`);
  console.log(`Actualizadas: ${updated}`);
  console.log(`Saltadas: ${skipped}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Falló el backfill:', error.message);
      process.exit(1);
    });
}

module.exports = main;
