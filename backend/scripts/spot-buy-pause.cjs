'use strict';
// Maintenance pause only: retain existing GET, SELL and cancellation behavior.
function buyPause(transport){
  return async function(input,init={}){
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    const method=String(init.method||input?.method||'GET').toUpperCase();
    if(/^api[1-4]?\.binance\.com$/.test(url.hostname)&&method==='POST'){
      // The legacy Spot exit chain sends signed parameters in the query string.
      // Refuse unknown write shapes as well as BUY; never consume/forward a body by guessing.
      if(url.pathname!=='/api/v3/order'||url.searchParams.get('side')!=='SELL'||init.body||input instanceof Request&&input.body){
        console.error('SPOT_NEW_BUY_BLOCKED_MAINTENANCE');
        return Response.json({code:-90002,msg:'SPOT_NEW_BUYS_PAUSED_FOR_VPS_HANDOVER'},{status:403});
      }
    }
    return transport(input,init);
  };
}
if(process.env.SPOT_NEW_BUYS_PAUSED==='1')global.fetch=buyPause(global.fetch);
module.exports={buyPause};
