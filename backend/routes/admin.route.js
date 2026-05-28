const express = require('express');
const router = express.Router();
const db = require('../firebase-admin-config');

/**
 * ADMIN ROUTE: Generate Fresh Spot Opportunity Scans
 * Called by Cloud Scheduler every 45 minutes
 */

// Middleware: Validate cron secret
const validateCronSecret = (req, res, next) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  const expectedSecret = process.env.CRON_SECRET || 'proypers25-cron-secret';
  
  if (secret !== expectedSecret) {
    console.warn('[ADMIN] Unauthorized access attempt to generate-scan');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: Invalid cron secret'
    });
  }
  
  next();
};

/**
 * POST /internal/admin/generate-scan
 * 
 * Generates a fresh spot opportunity scan with current market candidates.
 * Called automatically by Cloud Scheduler every 45 minutes.
 * 
 * Security: Requires x-cron-secret header matching CRON_SECRET env var
 */
router.post('/internal/admin/generate-scan', validateCronSecret, async (req, res) => {
  try {
    console.log('[ADMIN] Generating fresh spot scan...');
    
    const scanId = `spot_scan_${Date.now()}`;
    const now = new Date();
    
    // Get top 50 candidates from paper collection
    const candidatesSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(50)
      .get();
    
    const candidates = candidatesSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));
    
    console.log(`[ADMIN] Found ${candidates.length} candidates for scan`);
    
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
        manual: false
      }
    });
    
    console.log(`[ADMIN] Created scan: ${scanId}`);
    
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
    console.log(`[ADMIN] Updated ${Math.min(candidates.length, 50)} candidates with new scan_id`);
    
    return res.status(200).json({
      ok: true,
      message: 'Fresh scan generated successfully',
      scan_id: scanId,
      candidates_count: candidates.length,
      timestamp: now.toISOString()
    });
    
  } catch (error) {
    console.error('[ADMIN] Error generating scan:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to generate scan',
      details: error.message
    });
  }
});

/**
 * GET /internal/admin/scan-status
 * 
 * Check the status of the latest scan
 */
router.get('/internal/admin/scan-status', validateCronSecret, async (req, res) => {
  try {
    const latestScanSnap = await db.collection('spot_opportunity_scans')
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    
    if (latestScanSnap.empty) {
      return res.status(200).json({
        ok: true,
        message: 'No scans found',
        latest_scan: null
      });
    }
    
    const latestScan = latestScanSnap.docs[0].data();
    const scanAgeMs = Date.now() - new Date(latestScan.created_at).getTime();
    const scanAgeMinutes = scanAgeMs / (60 * 1000);
    
    return res.status(200).json({
      ok: true,
      message: 'Latest scan found',
      latest_scan: {
        scan_id: latestScan.scan_id,
        created_at: latestScan.created_at,
        age_minutes: Number(scanAgeMinutes.toFixed(2)),
        candidates_count: latestScan.candidates_count,
        status: latestScan.status
      }
    });
    
  } catch (error) {
    console.error('[ADMIN] Error getting scan status:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to get scan status',
      details: error.message
    });
  }
});

module.exports = router;
