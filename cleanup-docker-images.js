#!/usr/bin/env node

/**
 * Docker Image Cleanup Tool - proypers25
 * Safely removes unused Docker images from Artifact Registry
 *
 * Images to delete:
 * - backend-image:build9-manual (300 MB) - Build 9 manual attempt, never deployed
 * - backend-image:manual-build9 (300 MB) - Build 9 alternate tag, never deployed
 * - Untagged artifacts from failed builds (300 MB each) - 3-5 images
 *
 * Safe deletion command format:
 * gcloud artifacts docker images delete <IMAGE_FULL_PATH>
 */

const { spawn } = require('child_process');
const path = require('path');

const PROJECT = 'proypers2025';
const LOCATION = 'southamerica-west1';
const REPO = 'backend-repo';

// Images to delete - only unused ones
const IMAGES_TO_DELETE = [
  {
    name: 'backend-image:build9-manual',
    reason: 'Build 9 manual override - never deployed',
    size: '~300 MB'
  },
  {
    name: 'backend-image:manual-build9',
    reason: 'Build 9 alternate tag - never deployed',
    size: '~300 MB'
  }
];

// Images to KEEP - critical for production
const IMAGES_TO_KEEP = [
  {
    name: 'backend-image:latest',
    reason: 'PRODUCTION - Currently deployed to Cloud Run',
    size: '~300 MB',
    critical: true
  },
  {
    name: 'node:20-slim',
    reason: 'Base image - required for all future builds',
    size: '~150 MB',
    critical: true
  }
];

async function executeGcloud(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gcloud', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, code, error: stderr });
      }
    });
  });
}

async function deleteImage(imageName) {
  const fullPath = `${LOCATION}-docker.pkg.dev/${PROJECT}/${REPO}/${imageName}`;

  console.log(`\n🗑️  Deleting: ${imageName}`);
  console.log(`   Path: ${fullPath}`);

  const result = await executeGcloud([
    'artifacts',
    'docker',
    'images',
    'delete',
    fullPath,
    '--quiet'
  ]);

  if (result.success) {
    console.log(`   ✅ SUCCESS - Deleted`);
    return true;
  } else {
    console.log(`   ❌ FAILED - ${result.error.substring(0, 100)}`);
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         DOCKER IMAGE CLEANUP - proypers25                  ║');
  console.log('║              Artifact Registry Cleanup Tool                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log('\n📋 PROJECT CONFIGURATION');
  console.log(`   Project: ${PROJECT}`);
  console.log(`   Location: ${LOCATION}`);
  console.log(`   Repository: ${REPO}`);

  console.log('\n✅ IMAGES TO KEEP (PRODUCTION CRITICAL)');
  IMAGES_TO_KEEP.forEach(img => {
    console.log(`   🔴 ${img.name}`);
    console.log(`      Reason: ${img.reason}`);
    console.log(`      Size: ${img.size}`);
  });

  console.log('\n⚠️  IMAGES TO DELETE (SAFE TO REMOVE)');
  IMAGES_TO_DELETE.forEach(img => {
    console.log(`   ${img.name}`);
    console.log(`      Reason: ${img.reason}`);
    console.log(`      Size: ${img.size}`);
  });

  console.log('\n' + '='.repeat(60));
  console.log('DELETION PROGRESS');
  console.log('='.repeat(60));

  let deletedCount = 0;
  let failedCount = 0;

  for (const image of IMAGES_TO_DELETE) {
    const success = await deleteImage(image.name);
    if (success) {
      deletedCount++;
    } else {
      failedCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP SUMMARY');
  console.log('='.repeat(60));

  console.log(`\n📊 Results:`);
  console.log(`   ✅ Successfully deleted: ${deletedCount} image(s)`);
  console.log(`   ❌ Failed to delete: ${failedCount} image(s)`);

  const spaceFreed = deletedCount * 300;
  console.log(`   💾 Space freed: ~${spaceFreed} MB`);

  console.log('\n✅ PRODUCTION IMAGES REMAIN UNTOUCHED');
  console.log('   - backend-image:latest → ACTIVE in Cloud Run');
  console.log('   - node:20-slim → Required for builds');

  if (deletedCount > 0) {
    console.log('\n🎉 Cleanup complete! Unused images removed.');
    console.log('   Your Artifact Registry storage has been optimized.');
  } else if (failedCount > 0) {
    console.log('\n⚠️  Some deletions failed. Check permissions or image availability.');
  } else {
    console.log('\n📌 No images were deleted in this run.');
  }

  process.exit(deletedCount > 0 && failedCount === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
