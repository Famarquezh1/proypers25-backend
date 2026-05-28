const admin = require('firebase-admin');

// Initialize Firebase Admin SDK (automatically uses default credentials)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/**
 * HTTP Cloud Function: Generate Spot Opportunity Scans
 * Triggered by Cloud Scheduler every 45 minutes
 */
exports.generateSpotScans = async (req, res) => {
  // Validate CRON secret
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  const expectedSecret = process.env.CRON_SECRET || 'proypers25-cron-secret';
  
  if (secret !== expectedSecret) {
    console.warn('[CLOUD_FUNCTION] Unauthorized access attempt');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }
  
  try {
    console.log('[CLOUD_FUNCTION] Generating fresh spot scan...');
    
    const scanId = `spot_scan_${Date.now()}`;
    const now = new Date();
    
    // Get top 50 candidates
    const candidatesSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(50)
      .get();
    
    const candidates = candidatesSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));
    
    console.log(`[CLOUD_FUNCTION] Found ${candidates.length} candidates`);
    
    // Create scan document
    await db.collection('spot_opportunity_scans').doc(scanId).set({
      scan_id: scanId,
      created_at: now.toISOString(),
      completed_at: now.toISOString(),
      candidates_count: candidates.length,
      status: 'COMPLETED',
      version: '1.0',
      metadata: {
        source: 'cloud_scheduler_automated',
        manual: false,
        cloud_function: true
      }
    });
    
    console.log(`[CLOUD_FUNCTION] Created scan: ${scanId}`);
    
    // Update candidates with batch
    const batch = db.batch();
    const updateCount = Math.min(candidates.length, 50);
    
    for (let i = 0; i < updateCount; i++) {
      const candidate = candidates[i];
      const docRef = db.collection('spot_opportunity_candidates').doc(candidate.id);
      batch.update(docRef, {
        scan_id: scanId,
        updated_at: now.toISOString()
      });
    }
    
    await batch.commit();
    console.log(`[CLOUD_FUNCTION] Updated ${updateCount} candidates with new scan_id`);
    
    res.status(200).json({
      ok: true,
      message: 'Fresh scan generated successfully',
      scan_id: scanId,
      candidates_count: candidates.length,
      timestamp: now.toISOString()
    });
    
  } catch (error) {
    console.error('[CLOUD_FUNCTION] Error generating scan:', error.message);
    res.status(500).json({
      ok: false,
      error: 'Failed to generate scan',
      details: error.message
    });
  }
};

