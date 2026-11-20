import { createHash, createHmac, timingSafeEqual, randomBytes, randomInt, createCipheriv, createDecipheriv } from 'node:crypto';

const hash = token => createHash('sha256').update(token).digest('hex');
const expiration = 30 * 60_000;

function verifyWebhook(raw, header, secret) {
  const match = /^t=(\d{10}),\s*v1=([a-f0-9]{64})$/i.exec(header ?? '');
  if (!match || Math.abs(Date.now()/1000 - Number(match[1])) > 300) return false;
  const expected = createHmac('sha256',secret).update(match[1]+'.').update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(match[2],'hex'));
}

export function createCheckout({db, env, rows, sync, fetcher}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout_orders (
      code INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL, sku TEXT NOT NULL, fingerprint TEXT NOT NULL,
      name TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL,
      payment_ref TEXT UNIQUE, delivery TEXT,
      detail TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checkout_state ON checkout_orders(state);
  `);
  // A prior process could have charged a supplier before it stopped.
  db.prepare("UPDATE checkout_orders SET state='review', detail=?, updated=? WHERE state='ordering'")
    .run('Tiến trình bị ngắt khi nhập hàng. Đối soát với nhà cung cấp.',Date.now());
  const get = db.prepare('SELECT * FROM checkout_orders WHERE code=?');
  const update = db.prepare('UPDATE checkout_orders SET state=?, detail=?, updated=? WHERE code=?');
  const secret = /^[0-9a-f]{64}$/i.test(env.DELIVERY_KEY ?? '') ? Buffer.from(env.DELIVERY_KEY,'hex') : null;
  const account = env.GPMPAY_ACCOUNT_NUMBER ?? '';
  const bin = env.GPMPAY_BANK_BIN ?? '';
  const holder = env.GPMPAY_ACCOUNT_NAME?.trim();
  const webhookSecret = env.GPMPAY_WEBHOOK_SECRET ?? '';
  const configured = Boolean(secret && /^\d{6}$/.test(bin) && /^[a-z0-9]{5,30}$/i.test(account) &&
    holder && webhookSecret.length >= 32);
  const canOrder = source => source === 'melody'
    ? Boolean(env.MELODY_ORDER_ENABLED === 'true' && env.MELODY_API_KEY && env.MELODY_API_SECRET)
    : Boolean(env.UNIZ_ORDER_ENABLED === 'true' && env.UNIZ_API_KEY);
  const sellable = item => Boolean(configured && canOrder(item.source) && item.eligible && item.published &&
    Number.isSafeInteger(item.price) && item.price >= Math.max(2000,item.referencePrice));

  async function request(url, headers, body) {
    const response = await fetcher(url,{
      headers:body ? {...headers,'Content-Type':'application/json'} : headers,
      method:body?'POST':'GET', body:body?JSON.stringify(body):undefined,
      redirect:'error', signal:AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    return response.json();
  }

  function encrypt(items, code) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',secret,iv);
    cipher.setAAD(Buffer.from(String(code)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(items),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
  }

  function decrypt(order) {
    const blob = Buffer.from(order.delivery,'base64');
    const cipher = createDecipheriv('aes-256-gcm',secret,blob.subarray(0,12));
    cipher.setAAD(Buffer.from(String(order.code)));
    cipher.setAuthTag(blob.subarray(12,28));
    return JSON.parse(Buffer.concat([cipher.update(blob.subarray(28)),cipher.final()]));
  }

  async function create(input) {
    if (!configured) return [503,{message:'Thanh toán ShopMMO chưa được kích hoạt.'}];
    if (!['uniz','melody'].includes(input?.source) || typeof input.id !== 'string') return [400,{message:'Gói không hợp lệ.'}];
    const item = rows(input.source).products.find(row=>row.id===input.id);
    if (!item || !sellable(item) || item.price !== input.price) return [409,{message:'Gói đã đổi giá, hết hàng hoặc chưa mở thanh toán.'}];
    const code = randomInt(100_000_000_000,999_999_999_999);
    const token = randomBytes(32).toString('hex');
    const time = Date.now();
    db.prepare("INSERT INTO checkout_orders(code,token_hash,source,sku,fingerprint,name,amount,state,created,updated) VALUES(?,?,?,?,?,?,?,'pending',?,?)")
      .run(code,hash(token),item.source,item.id,item.fingerprint,item.name,item.price,time,time);
    return [201,{code,token}];
  }

  async function fulfill(code) {
    const order = get.get(code);
    if (!order || order.state !== 'paid' || !configured || !canOrder(order.source)) return;
    const claimed = db.prepare("UPDATE checkout_orders SET state='ordering', updated=? WHERE code=? AND state='paid'").run(Date.now(),code);
    if (!claimed.changes) return;
    let upstreamStarted = false;
    let upstreamRef = '';
    try {
      if (!(await sync(order.source)).ok) throw Error();
      const item = rows(order.source).products.find(row=>row.id===order.sku);
      if (!item || !item.eligible || !item.published || item.fingerprint !== order.fingerprint || order.amount < item.referencePrice) throw Error();
      upstreamStarted = true;
      let items;
      if (order.source === 'melody') {
        const result = await request('https://melodyapp.vn/api/v1/orders/create',
          {'X-API-Key':env.MELODY_API_KEY,'X-API-Secret':env.MELODY_API_SECRET},
          {items:[{plan_id:Number(order.sku),quantity:1}]});
        const receipt = result.data?.orders?.[0];
        upstreamRef = String(receipt?.trans_id ?? '').slice(0,80);
        if (result.success !== true || receipt?.status !== 'completed' || receipt.plan_id !== Number(order.sku)) throw Error();
        items = receipt.delivery?.items;
      } else {
        const result = await request('https://unizvn.com/api/v1/orders',{'x-api-key':env.UNIZ_API_KEY},{slug:order.sku,qty:1});
        const receipt = result.order ?? result.data?.order ?? result.data ?? result;
        upstreamRef = String(receipt.code ?? receipt.orderCode ?? '').slice(0,80);
        if (result.success !== true || (receipt.slug && receipt.slug !== order.sku) ||
          ['pending','failed','cancelled'].includes(String(receipt.status).toLowerCase())) throw Error();
        items = receipt.accounts ?? receipt.delivery?.items ?? receipt.items;
      }
      // Only a documented delivery of one non-empty credential string can complete an order.
      if (!Array.isArray(items) || items.length !== 1 || typeof items[0] !== 'string' ||
        !items[0].trim() || items[0].length > 16000) throw Error();
      db.prepare("UPDATE checkout_orders SET state='delivered', delivery=?, detail=?, updated=? WHERE code=?")
        .run(encrypt(items,code),upstreamRef || null,Date.now(),code);
    } catch {
      const detail = upstreamStarted ? 'Cần đối soát với nhà cung cấp. Không gửi lại lệnh mua.' : 'Gói hoặc giá vốn thay đổi, hoặc đồng bộ thất bại trước khi nhập hàng.';
      update.run('review',upstreamRef ? detail + ' Mã nguồn: ' + upstreamRef : detail,Date.now(),code);
    }
  }

  function webhook(data, raw, signature) {
    if (!configured) return [503,{ok:false}];
    if (!verifyWebhook(raw,signature,webhookSecret)) return [401,{ok:false}];
    if (data?.test === true || data?.source !== 'REAL' || data.transferType !== 'in' ||
        data.accountNumber !== account || !/^[a-f0-9-]{36}$/i.test(data.id ?? '') ||
        !Number.isSafeInteger(data.transferAmount) || data.transferAmount <= 0) return [200,{ok:true}];
    const codes = [...String(data.content ?? '').toUpperCase().matchAll(/(?:^|[^A-Z0-9])SMMO(\d{12})(?![A-Z0-9])/g)];
    if (codes.length !== 1) return [200,{ok:true}];
    const order = get.get(Number(codes[0][1]));
    if (!order || order.state !== 'pending' || db.prepare('SELECT 1 FROM checkout_orders WHERE payment_ref=?').get(data.id)) return [200,{ok:true}];
    const at = Date.parse(data.transactionDate);
    const matched = data.transferAmount === order.amount && at >= order.created - 1000 && at <= order.created + expiration;
    const next = matched ? 'paid' : 'review';
    const detail = matched ? null : 'Tiền vào sai số tiền hoặc ngoài thời hạn. Cần đối soát thủ công.';
    db.prepare("UPDATE checkout_orders SET state=?, payment_ref=?, detail=?, updated=? WHERE code=? AND state='pending'")
      .run(next,data.id,detail,Date.now(),order.code);
    if (matched) void fulfill(order.code);
    return [200,{ok:true}];
  }

  function status(token) {
    if (!/^[0-9a-f]{64}$/.test(token ?? '')) return [404,{message:'Không tìm thấy đơn.'}];
    const order = db.prepare('SELECT * FROM checkout_orders WHERE token_hash=?').get(hash(token));
    if (!order) return [404,{message:'Không tìm thấy đơn.'}];
    const {code,name,amount}=order;
    const expired = order.state==='pending' && Date.now() > order.created+expiration;
    const state = expired ? 'expired' : order.state;
    const payment = state==='pending' && configured ? {account,bin,holder,content:'SMMO'+code,expires:order.created+expiration} : null;
    return [200,{code,name,amount,state,payment,delivery:state==='delivered' && secret ? decrypt(order):null}];
  }

  const resume = () => {
    for (const order of db.prepare("SELECT code FROM checkout_orders WHERE state='paid' LIMIT 30").all()) void fulfill(order.code);
  };
  const list = () => db.prepare('SELECT code,source,sku,name,amount,state,detail,payment_ref,created,updated FROM checkout_orders ORDER BY created DESC LIMIT 50').all();
  return {create,webhook,status,sellable,list,resume,configured};
}

