import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from './server.mjs';
const token='0123456789abcdef'.repeat(4);
const env={SHOPMMO_DB:':memory:',ADMIN_TOKEN:token,DELIVERY_KEY:'ab'.repeat(32),
  GPMPAY_WEBHOOK_SECRET:token,GPMPAY_BANK_BIN:'970422',GPMPAY_ACCOUNT_NAME:'Demo',GPMPAY_ACCOUNT_NUMBER:'0000000000',
  MELODY_API_KEY:'fixture',MELODY_API_SECRET:'fixture',MELODY_ORDER_ENABLED:'true'};
let purchases=0;
const fetcher=(url,options)=>{
  if(url.endsWith('/orders/create')){
    purchases++;
    assert.deepEqual(JSON.parse(options.body),{items:[{plan_id:15,quantity:1}]});
    return new Response(JSON.stringify({success:true,data:{orders:[{status:'completed',plan_id:15,trans_id:'TEST',delivery:{items:['demo | sample']}}]}}));
  }
  return new Response(JSON.stringify({success:true,data:{products:[{
    slug:'spotify',name:'Spotify',plans:[{id:15,name:'Tài khoản tháng',is_instant:true,in_stock:true,stock_count:5,fields:[],final_price:30000}]
  }]}}));
};
const app=createApp(env,fetcher);
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const base='http://127.0.0.1:'+app.server.address().port;
function post(path, data, headers={}){
  return fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
}
function signature(data,time=Math.floor(Date.now()/1000)){
  return 't='+time+',v1='+createHmac('sha256',env.GPMPAY_WEBHOOK_SECRET).update(time+'.'+JSON.stringify(data)).digest('hex');
}
const auth={Authorization:'Bearer '+token};
try {
  assert.equal((await app.sync('melody')).ok,true);
  const state=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  const item=state.sources.find(s=>s.source==='melody').products[0];
  assert.equal((await post('/api/admin/review',{source:'melody',id:item.id,fingerprint:item.fingerprint,brand:'Spotify',price:35000,published:true,confirmed:true},auth)).status,200);
  assert.equal((await post('/api/checkout',{source:'melody',id:item.id,price:1})).status,409);
  const create=async()=>{
    const response=await post('/api/checkout',{source:'melody',id:item.id,price:35000});
    assert.equal(response.status,201);
    return response.json();
  };
  const order=await create();
  const status=entry=>fetch(base+'/api/order',{headers:{Authorization:'Bearer '+entry.token}}).then(r=>r.json());
  const event={id:randomUUID(),source:'REAL',transferType:'in',accountNumber:env.GPMPAY_ACCOUNT_NUMBER,
    transferAmount:35000,content:'Thanh toan SMMO'+order.code,transactionDate:new Date().toISOString()};
  const deliver=(data, sig=signature(data))=>post('/api/payments/gpmpay',data,{'x-gpmpay-signature':sig});
  assert.equal((await deliver(event,'invalid')).status,401);
  assert.equal((await deliver(event,signature(event,Math.floor(Date.now()/1000)-400))).status,401);
  assert.equal((await deliver({...event,source:'SIMULATED'})).status,200);
  assert.equal((await deliver({...event,accountNumber:'1234567890'})).status,200);
  assert.equal((await status(order)).payment.content,'SMMO'+order.code);
  assert.equal(purchases,0);
  await Promise.all([deliver(event),deliver(event)]);
  for(let tries=0;tries<20&&purchases===0;tries++) await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(purchases,1);
  assert.deepEqual((await status(order)).delivery,['demo | sample']);
  assert.equal((await fetch(base+'/api/order')).status,404);
  const encrypted=app.db.prepare('SELECT delivery FROM checkout_orders WHERE code=?').get(order.code).delivery;
  assert(!encrypted.includes('demo'));
  const other=await create();
  await deliver({...event,content:'SMMO'+other.code});
  assert.equal((await status(other)).state,'pending');
  await deliver({...event,id:randomUUID(),content:'SMMO'+other.code,transferAmount:1000});
  assert.equal((await status(other)).state,'review');
  assert.equal(purchases,1);
  console.log('PASS: server price, signed webhook, stale signature, simulation, wrong account, duplicate, amount mismatch, encrypted delivery');
} finally { await new Promise(resolve=>app.server.close(resolve)); app.db.close(); }
