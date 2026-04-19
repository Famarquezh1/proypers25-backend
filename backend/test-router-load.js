#!/usr/bin/env node

/**
 * Test if deep_health_router loads and registers routes correctly
 */

console.log('Testing deep_health_router load...\n');

try {
  // Step 1: Try to require the router module
  console.log('[1/3] Requiring deep_health_router...');
  const routerModule = require('./routes/deep_health_router');
  console.log('✓ Router module loaded successfully');
  console.log('✓ Module exports:', Object.keys(routerModule));
  
  // Step 2: Check if createDeepHealthRouter function exists
  console.log('\n[2/3] Checking createDeepHealthRouter function...');
  const { createDeepHealthRouter } = routerModule;
  if (typeof createDeepHealthRouter !== 'function') {
    throw new Error('createDeepHealthRouter is not a function, it is: ' + typeof createDeepHealthRouter);
  }
  console.log('✓ createDeepHealthRouter is a function');
  
  // Step 3: Try to create router instance (with dummy db)
  console.log('\n[3/3] Creating router instance with dummy db...');
  const dummyDb = null; // Routes will fail if actually called, but should register
  const router = createDeepHealthRouter(dummyDb);
  
  if (!router) {
    throw new Error('createDeepHealthRouter returned falsy value: ' + router);
  }
  
  console.log('✓ Router instance created successfully');
  console.log('✓ Router type:', typeof router);
  console.log('✓ Router is Express Router:', router._router === undefined && typeof router.use === 'function');
  
  // Step 4: Check registered routes
  console.log('\n[4/4] Checking registered routes...');
  if (router.stack) {
    console.log('✓ Router has stack with', router.stack.length, 'layers');
    router.stack.forEach((layer, idx) => {
      if (layer.route) {
        console.log(`  Route ${idx}: ${layer.route.stack[0].method.toUpperCase()} ${layer.route.path}`);
      } else if (layer.name === 'router') {
        console.log(`  Middleware ${idx}: nested router`);
      }
    });
  } else {
    console.log('? Router has no stack property');
  }
  
  console.log('\n✓✓✓ ALL TESTS PASSED - Router loads and registers correctly! ✓✓✓\n');
  process.exit(0);
  
} catch (err) {
  console.error('\n✗✗✗ ERROR ✗✗✗');
  console.error('Message:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
}
