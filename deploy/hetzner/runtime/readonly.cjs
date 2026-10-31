'use strict';
// Staging transport only. There is deliberately no live-mode switch.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const HOSTS = new Set(['api.binance.com', 'api1.binance.com', 'api2.binance.com',
  'api3.binance.com', 'api4.binance.com', 'data-api.binance.vision', 'api.coingecko.com']);
function makeFetch(request = https.get) {
  return async (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    if (target.protocol !== 'https:' || target.username || target.password || target.port) throw new Error('TRANSPORT_TARGET_DENIED');
    if (method !== 'GET') {
      console.error(JSON.stringify({event:'SHADOW_WRITE_BLOCKED', host:target.hostname, method, endpoint:target.pathname}));
      return new Response(JSON.stringify({code:-90001,msg:'VPS_STAGING_WRITE_BLOCKED'}), {status:403});
    }
    if (target.hostname === 'api.github.com') {
      if (target.pathname !== '/repos/Famarquezh1/proypers25-backend/issues') throw new Error('GITHUB_ROUTE_DENIED');
      const file = process.env.PROYPERS_MANAGED_CONTEXT;
      if (!file) throw new Error('MANAGED_CONTEXT_REQUIRED');
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(snapshot.issues)) throw new Error('INVALID_MANAGED_CONTEXT');
      const state = target.searchParams.get('state') || 'open';
      const rows = snapshot.issues.filter(i => state === 'all' || i.state === state);
      return new Response(JSON.stringify(rows), {status:200,headers:{'content-type':'application/json'}});
    }
    if (!HOSTS.has(target.hostname)) throw new Error('TRANSPORT_HOST_DENIED');
    // Binance's permission-set expansion can exceed the bounded response budget.
    // None of these operational scripts consume that expansion; retain symbol/filter data.
    if(target.pathname==='/api/v3/exchangeInfo'&&!target.searchParams.has('showPermissionSets'))target.searchParams.set('showPermissionSets','false');
    const headers = new Headers(init.headers || input?.headers || {});
    if (headers.has('X-MBX-APIKEY') && !/^api[1-4]?\.binance\.com$/.test(target.hostname)) throw new Error('CREDENTIAL_DESTINATION_DENIED');
    return new Promise((resolve, reject) => {
      const req = request(target, {method:'GET', family:4, headers:Object.fromEntries(headers),
        signal:init.signal || AbortSignal.timeout(15000)}, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) res.destroy(new Error('RESPONSE_SIZE_LIMIT'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status:res.statusCode,
          headers:{'content-type':'application/json'}})));
      });
      req.on('error', reject);
    });
  };
}
if (process.env.PROYPERS_STAGING_PRELOAD === '1') {
  global.fetch = makeFetch();
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (dir) {
    process.env.BINANCE_API_KEY = fs.readFileSync(path.join(dir,'binance-key'),'utf8').trim();
    process.env.BINANCE_SECRET_KEY = fs.readFileSync(path.join(dir,'binance-secret'),'utf8').trim();
  }
}
module.exports = {makeFetch};
