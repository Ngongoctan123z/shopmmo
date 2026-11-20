import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
    if(url.includes('/p/')) return new Response('<h1>CapCut Pro</h1><span>'+unizBadge+'</span><span>Còn 4</span>');
    assert.equal(options.headers['x-api-key'],'fixture-uniz');
    if(url.endsWith('/balance')) return new Response(JSON.stringify({status:true,success:true,balance:100000}));
    if(url.endsWith('/products')) return new Response(JSON.stringify({success:true,total:1,
      products:[{slug:unizSku,name:'CapCut Pro',category:'Giải trí',price:30000,inStock:true}]}));
    assert(url.endsWith('/orders'));
    assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),{slug:unizSku,qty:2});
    unizPurchases++;
    return new Response(JSON.stringify({success:true,order:{code:'UZ-FIXTURE',slug:unizSku,quantity:2,accounts:['uniz | sample 1','uniz | sample 2']}}));
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
const storefront={'X-ShopMMO-Request':'storefront'};
const jar={};
function captureCookies(response,storage=jar){
  for(const value of response.headers.getSetCookie()){
    const [nameValue]=value.split(';');
    const index=nameValue.indexOf('=');
    storage[nameValue.slice(0,index)]=nameValue.slice(index+1);
  }
}
function withCookies(storage=jar){
  return {...storefront,Cookie:Object.entries(storage).map(([k,v])=>k+'='+v).join('; ')};
}
const list = (storage=jar)=>fetch(base+'/api/orders',{headers:withCookies(storage)}).then(r=>r.json());
const status = async entry=>(await list()).orders.find(o=>o.code===entry.code);
async function checkout(data){
  const response=await post('/api/checkout',data,withCookies());
  captureCookies(response);
  return response;
}
try {
  assert.equal((await app.sync('melody')).ok,true);
  assert.equal((await post('/api/admin/supplier-check',{source:'melody'},auth)).status,200);
  const state=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  const item=state.sources.find(s=>s.source==='melody').products[0];
  assert.equal((await post('/api/admin/review',{source:'melody',id:item.id,fingerprint:item.fingerprint,brand:'Meitu',price:35000,published:true,confirmed:true},auth)).status,200);
  assert.equal((await checkout({source:'melody',id:item.id,price:1})).status,409);
  assert.equal((await post('/api/checkout',{source:'melody',id:item.id,price:35000})).status,403);
  assert.equal((await post('/api/checkout',{source:'melody',id:item.id,price:35000},
    {...storefront,'Sec-Fetch-Site':'cross-site'})).status,403);
  const create=async()=>{
    const response=await checkout({source:'melody',id:item.id,price:35000});
    assert.equal(response.status,201);
    return response.json();
  };
  const order=await create();
  assert(!Object.hasOwn(order,'token'));
  assert(jar.shopmmo_guest);
  assert.deepEqual((await list({})).orders,[]);
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
  const deferred=await create();
  assert.equal(deferred.state,'awaiting_payment');
  assert.equal((await status(deferred)).payment,null);
  const deferredPayment=paymentFor(deferred);
  await deliver(deferredPayment);
  assert.equal(purchases,1,'A saved order is not payable yet');
  const startPayment=entry=>post('/api/order/payment',{code:entry.code},withCookies());
  assert.equal((await startPayment(deferred)).status,409);
  assert.equal((await post('/api/order/payment',{code:deferred.code},storefront)).status,404);
  balance=100000;
  await app.checkout.suppliers.inspect('melody');
  app.db.prepare('UPDATE checkout_orders SET created=? WHERE code=?').run(Date.now()-60*60_000,deferred.code);
  assert.equal((await startPayment(deferred)).status,200);
  assert((await status(deferred)).payment.expires>Date.now(),'The pending order receives a new payment deadline');
  assert.equal(purchases,1,'Opening payment does not buy anything');
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
  assert.equal((await checkout({source:'uniz',id:unizItem.id,price:35000,quantity:5})).status,400);
  const unizOrder=await (await checkout({source:'uniz',id:unizItem.id,price:35000,quantity:2})).json();
  const unizView=await status(unizOrder);
  assert.equal(unizView.quantity,2);
  assert.equal(unizView.amount,70000);
  assert.equal((await fetch(base+'/products/capcut')).status,200);
  const unizPayment={...paymentFor(unizOrder),transferAmount:70000};
  await Promise.all([deliver(unizPayment),deliver(unizPayment)]);
  assert.deepEqual((await waitFor(unizOrder,'delivered')).delivery,['uniz | sample 1','uniz | sample 2']);
  assert.equal(unizPurchases,1);
  const admin=await (await fetch(base+'/api/admin/state',{headers:auth})).json();
  assert.equal(admin.orders.find(o=>o.code===unizOrder.code).supplier_ref,'UZ-FIXTURE');
  assert(!JSON.stringify(admin).includes('uniz | sample'));
  unizBadge='Giao hàng';
  await app.sync('uniz');
  const catalog = await (await fetch(base+'/api/catalog')).json();
  assert(!catalog.products.some(p=>p.id===unizSku),'A provider switch to manual delivery hides the offer');
  assert(catalog.products.every(product=>!Object.hasOwn(product,'url')),'Storefront does not receive supplier URLs');
  const guestCookie={...jar};
  const credential={email:'checkout-fixture@example.test',password:'fixture-password-99'};
  const registration=await post('/api/account/register',credential,withCookies());
  assert.equal(registration.status,201);
  const cookies=registration.headers.getSetCookie();
  assert(cookies.some(cookie=>cookie.startsWith('shopmmo_account=')&&cookie.includes('HttpOnly')&&cookie.includes('SameSite=Strict')));
  captureCookies(registration);
  assert.equal((await list(guestCookie)).total,0);
  assert((await status(order)).delivery.length);
  const secondDevice={};
  const login=await post('/api/account/login',credential,storefront);
  assert.equal(login.status,200);
  captureCookies(login,secondDevice);
  assert((await list(secondDevice)).orders.some(value=>value.code===order.code));
  const wrong=await post('/api/account/login',{...credential,password:'fixture-password-incorrect'},storefront);
  assert.equal(wrong.status,401);
  const legacy='fa'.repeat(32);
  const hashed=createHash('sha256').update(legacy).digest('hex');
  app.db.prepare('UPDATE checkout_orders SET customer_id=NULL,owner_hash=NULL,token_hash=? WHERE code=?').run(hashed,deferred.code);
  assert.equal((await fetch(base+'/api/order',{headers:{Authorization:'Bearer '+legacy}})).status,200);
  const imported=await (await post('/api/orders/import',{tokens:[legacy]},withCookies())).json();
  assert.deepEqual(imported.imported,[legacy]);
  assert.equal((await fetch(base+'/api/order',{headers:{Authorization:'Bearer '+legacy}})).status,404);
  assert.equal((await status(deferred)).code,deferred.code);
  const logout=await post('/api/account/logout',{},withCookies(secondDevice));
  assert.equal(logout.status,200);
  assert.equal((await list(secondDevice)).total,0);
  assert(!JSON.stringify(app.db.prepare('SELECT password_hash FROM customers').get()).includes(credential.password));
  console.log('PASS: both suppliers, payment checks, wallet gating, multi-quantity, guest cookie, account ownership, multi-device order access, legacy migration and encrypted delivery');
} finally { await new Promise(resolve=>app.server.close(resolve)); app.db.close(); }
