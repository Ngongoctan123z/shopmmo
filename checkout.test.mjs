import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from './server.mjs';
const token='0123456789abcdef'.repeat(4);
const env={SHOPMMO_DB:':memory:',ADMIN_TOKEN:token,DELIVERY_KEY:'ab'.repeat(32),
  GPMPAY_WEBHOOK_SECRET:token,GPMPAY_BANK_BIN:'970422',GPMPAY_ACCOUNT_NAME:'Demo',GPMPAY_ACCOUNT_NUMBER:'0000000000',
  MELODY_API_KEY:'fixture',MELODY_API_SECRET:'fixture',MELODY_ORDER_ENABLED:'true',UNIZ_ORDER_ENABLED:'true',UNIZ_API_KEY:'fixture-uniz'};
let purchases=0;
let balance=100000;
let unizPurchases=0;
let unizBadge='Có ngay';
const unizSku='capcut-pro-ca-nhan-1-thang-bhf';
let outcome='completed';
const fetcher=(url,options)=>{
  if(url.startsWith('https://unizvn.com/')){
    if(url.includes('/p/')) return new Response('<h1>CapCut Pro</h1><span>'+unizBadge+'</span>');
    assert.equal(options.headers['x-api-key'],'fixture-uniz');
    if(url.endsWith('/balance')) return new Response(JSON.stringify({status:true,success:true,balance:100000}));
    if(url.endsWith('/products')) return new Response(JSON.stringify({success:true,total:1,
      products:[{slug:unizSku,name:'CapCut Pro',category:'Giải trí',price:30000,inStock:true}]}));
    assert(url.endsWith('/orders'));
    assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),{slug:unizSku,qty:1});
    unizPurchases++;
    return new Response(JSON.stringify({success:true,order:{code:'UZ-FIXTURE',slug:unizSku,quantity:1,accounts:['uniz | sample']}}));
  }
  if(url.endsWith('/account/info')){
    return new Response(JSON.stringify({success:true,data:{user:{balance},api_key:{permissions:['orders.create']}}}));
  }
  if(url.includes('/orders/status?trans_id=')){
    return new Response(JSON.stringify({success:true,data:{order:{trans_id:'REVIEW-REF',status:'completed',plan:{id:15},quantity:1,final_amount:30000},delivery:{items:['review | sample']}}}));
  }
  if(url.endsWith('/orders/create')){
    purchases++;
    assert.deepEqual(JSON.parse(options.body),{items:[{plan_id:15,quantity:1}]});
    if(outcome==='timeout') throw Error('fixture network error');
    const receipt=outcome==='completed'?
      {status:'completed',plan_id:15,quantity:1,trans_id:'TEST',final_amount:30000,delivery:{items:['demo | sample']}}:
      {status:'pending',trans_id:'REVIEW-REF'};
    return new Response(JSON.stringify({success:true,data:{orders:[receipt]}}));
  }
  return new Response(JSON.stringify({success:true,data:{products:[{
    slug:'meitu',name:'Meitu',plans:[{id:15,name:'Tài khoản tháng',is_instant:true,in_stock:true,stock_count:5,fields:[],final_price:30000}]
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
  assert.equal((await post('/api/admin/supplier-check',{source:'melody'},auth)).status,200);
  const state=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  const item=state.sources.find(s=>s.source==='melody').products[0];
  assert.equal((await post('/api/admin/review',{source:'melody',id:item.id,fingerprint:item.fingerprint,brand:'Meitu',price:35000,published:true,confirmed:true},auth)).status,200);
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
  const waitFor = async(order, state)=>{
    for(let i=0;i<30;i++){
      const review = await status(order);
      if(review.state===state)return review;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('Did not reach '+state);
  };
  const poor=await create();
  const paymentFor=order=>({...event,id:randomUUID(),content:'SMMO'+order.code,transactionDate:new Date().toISOString()});
  balance=0;
  await deliver(paymentFor(poor));
  await waitFor(poor,'review');
  assert.equal(purchases,1,'No upstream POST if the wallet is empty');
  assert.equal((await post('/api/checkout',{source:'melody',id:item.id,price:35000})).status,409);
  balance=100000;
  await app.checkout.suppliers.inspect('melody');
  const pending=await create();
  outcome='pending';
  await deliver(paymentFor(pending));
  await waitFor(pending,'review');
  assert.equal((await post('/api/admin/order-reconcile',{code:pending.code},auth)).status,200);
  assert.deepEqual((await status(pending)).delivery,['review | sample']);
  assert.equal(purchases,2,'Reconciliation uses GET');
  const lost=await create();
  outcome='timeout';
  const lostPayment=paymentFor(lost);
  await deliver(lostPayment);
  await waitFor(lost,'review');
  await deliver(lostPayment);
  app.checkout.resume();
  assert.equal((await post('/api/admin/order-reconcile',{code:lost.code},auth)).status,409);
  assert.equal(purchases,3,'An ambiguous POST is never repeated');
  assert.equal((await app.sync('uniz')).ok,true);
  assert.equal((await post('/api/admin/supplier-check',{source:'uniz'},auth)).status,200);
  const unizState=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  const unizItem=unizState.sources.find(s=>s.source==='uniz').products[0];
  assert.equal((await post('/api/admin/review',{source:'uniz',id:unizItem.id,fingerprint:unizItem.fingerprint,brand:'CapCut',price:35000,
    published:true,confirmed:true},auth)).status,200);
  const unizOrder=await (await post('/api/checkout',{source:'uniz',id:unizItem.id,price:35000})).json();
  const unizPayment=paymentFor(unizOrder);
  await Promise.all([deliver(unizPayment),deliver(unizPayment)]);
  assert.deepEqual((await waitFor(unizOrder,'delivered')).delivery,['uniz | sample']);
  assert.equal(unizPurchases,1);
  const admin=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  assert.equal(admin.orders.find(o=>o.code===unizOrder.code).supplier_ref,'UZ-FIXTURE');
  assert(!JSON.stringify(admin).includes('uniz | sample'));
  unizBadge='Giao hàng';
  await app.sync('uniz');
  const catalog = await (await fetch(base+'/api/catalog')).json();
  assert(!catalog.products.some(p=>p.id===unizSku),'A provider switch to manual delivery hides the offer');
  console.log('PASS: both suppliers, payment checks, wallet gating, encrypted delivery, read-only reconciliation, timeout and duplicate protection');
} finally { await new Promise(resolve=>app.server.close(resolve)); app.db.close(); }
