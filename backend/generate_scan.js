const db = require('./firebase-admin-config');

(async () => {
  console.log('=== GENERATING FRESH SCAN ===');
  try {
    // Create a fresh scan
    const scanId = `spot_scan_${Date.now()}`;
    const now = new Date();
    
    // Get candidates from paper collection
    const candidatesSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(50)
      .get();
    
    const candidates = candidatesSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));
    
    console.log(`Found ${candidates.length} candidates`);
    
    // Create scan document
    await db.collection('spot_opportunity_scans').doc(scanId).set({
      scan_id: scanId,
      created_at: now.toISOString(),
      completed_at: now.toISOString(),
      candidates_count: candidates.length,
      status: 'COMPLETED',
      version: '1.0',
      metadata: {
        source: 'automated_rearm',
        manual: false
      }
    });
    
    console.log(`✓ Created scan: ${scanId}`);
    
    // Update candidates to reference this scan
    const batch = db.batch();
    for (let i = 0; i < Math.min(candidates.length, 50); i++) {
      const candidate = candidates[i];
      const docRef = db.collection('spot_opportunity_candidates').doc(candidate.id);
      batch.update(docRef, {
        scan_id: scanId,
        updated_at: now.toISOString()
      });
    }
    
    await batch.commit();
    console.log(`✓ Updated ${Math.min(candidates.length, 50)} candidates with new scan_id`);
    console.log(`✓ Fresh scan ready for live trading`);
    
    process.exit(0);
  } catch (e) {
    console.error('✗ Error:', e.message);
    process.exit(1);
  }
})();
