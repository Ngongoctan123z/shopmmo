import { createSuppliers } from './suppliers.mjs';
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
  const columns = db.prepare('PRAGMA table_info(checkout_orders)').all().map(column=>column.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!columns.includes('supplier_attempt_at')) {
      db.exec('ALTER TABLE checkout_orders ADD COLUMN supplier_attempt_at INTEGER');
      // Older versions cannot distinguish an interrupted check from an interrupted purchase.
      db.exec("UPDATE checkout_orders SET supplier_attempt_at=updated WHERE state='ordering'");
    }
    if (!columns.includes('supplier_ref')) db.exec('ALTER TABLE checkout_orders ADD COLUMN supplier_ref TEXT');
    if (!columns.includes('payment_started')) db.exec('ALTER TABLE checkout_orders ADD COLUMN payment_started INTEGER');
    if (!columns.includes('customer_id')) db.exec('ALTER TABLE checkout_orders ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
    if (!columns.includes('owner_hash')) db.exec('ALTER TABLE checkout_orders ADD COLUMN owner_hash TEXT');
    if (!columns.includes('quantity')) db.exec('ALTER TABLE checkout_orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
    if (!columns.includes('supplier_cost')) db.exec('ALTER TABLE checkout_orders ADD COLUMN supplier_cost REAL');
    db.exec('CREATE INDEX IF NOT EXISTS checkout_customer_created ON checkout_orders(customer_id,created DESC,code DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS checkout_owner_created ON checkout_orders(owner_hash,created DESC,code DESC)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS checkout_supplier_ref ON checkout_orders(source,supplier_ref) WHERE supplier_ref IS NOT NULL');
    db.prepare("UPDATE checkout_orders SET state='review', detail=?, updated=? WHERE state='ordering' AND supplier_attempt_at IS NOT NULL")
      .run('Tiến trình bị ngắt sau khi chuẩn bị gửi lệnh mua. Cần đối soát với nguồn.',Date.now());
    db.exec("UPDATE checkout_orders SET state='paid' WHERE state='ordering' AND supplier_attempt_at IS NULL");
    db.exec('COMMIT');
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const suppliers = createSuppliers(env,fetcher);
  const get = db.prepare('SELECT * FROM checkout_orders WHERE code=?');
  const update = db.prepare('UPDATE checkout_orders SET state=?, detail=?, updated=? WHERE code=?');
  const secret = /^[0-9a-f]{64}$/i.test(env.DELIVERY_KEY ?? '') ? Buffer.from(env.DELIVERY_KEY,'hex') : null;
  const account = env.GPMPAY_ACCOUNT_NUMBER ?? '';
  const bin = env.GPMPAY_BANK_BIN ?? '';
  const holder = env.GPMPAY_ACCOUNT_NAME?.trim();
  const webhookSecret = env.GPMPAY_WEBHOOK_SECRET ?? '';
  const configured = Boolean(secret && /^\d{6}$/.test(bin) && /^[a-z0-9]{5,30}$/i.test(account) &&
    holder && webhookSecret.length >= 32);
  const maxQuantity = item => Math.min(10,Number.isInteger(item.stockCount)?Math.max(0,item.stockCount):1);
  const sellable = (item,quantity=1) => {
    if (!configured || !item.eligible || !item.published || !Number.isSafeInteger(item.price) ||
      item.price < item.referencePrice || item.price*quantity < 2000 || quantity > maxQuantity(item)) return false;
    const wallet = suppliers.status(item.source);
    return wallet.enabled && wallet.fresh && wallet.canWrite !== false && wallet.balance >= item.referencePrice*quantity;
  };

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

  function ownerScope(session,customer){
    if(customer) return {field:'customer_id',key:customer.id};
    if(session) return {field:'owner_hash',key:hash(session)};
    return null;
  }

  function create(input,session,customer) {
    if (!['uniz','melody'].includes(input?.source) || typeof input.id !== 'string') return [400,{message:'Gói không hợp lệ.'}];
    const item = rows(input.source).products.find(row=>row.id===input.id);
    const quote = item?.price ?? item?.listingPrice;
    if (!item?.eligible || !item.published || !Number.isFinite(quote) || quote < 0 || quote !== input.price) {
      return [409,{message:'Gói đã đổi giá hoặc hết hàng. Hãy tải lại danh mục.'}];
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity(item)) {
      return [400,{message:'Số lượng vượt giới hạn hoặc số gói có sẵn.'}];
    }
    const code = randomInt(100_000_000_000,999_999_999_999);
    const scope = ownerScope(session,customer);
    const token = randomBytes(32).toString('hex');
    const time = Date.now();
    const recent = db.prepare('SELECT COUNT(*) AS n FROM checkout_orders WHERE '+scope.field+'=? AND created>?').get(scope.key,time-60_000).n;
    if (recent>=12) return [429,{message:'Bạn đang đặt nhiều đơn. Hãy đợi một phút rồi thử lại.'}];
    const paymentStarted = sellable(item,quantity)?time:null;
    const state = paymentStarted ? 'pending' : 'awaiting_payment';
    const name = [item.name,item.plan].filter(Boolean).join(' · ');
    db.prepare('INSERT INTO checkout_orders(code,token_hash,owner_hash,customer_id,source,sku,fingerprint,name,amount,quantity,state,payment_started,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(code,hash(token),customer?null:scope.key,customer?.id??null,item.source,item.id,item.fingerprint,name,quote*quantity,quantity,state,paymentStarted,time,time);
    return [201,{code,state}];
  }

  function findCustomerOrder({token,session,customer,code}) {
    const scope = ownerScope(session,customer);
    if (scope && Number.isSafeInteger(code)) return db.prepare('SELECT * FROM checkout_orders WHERE code=? AND '+scope.field+'=?').get(code,scope.key);
    if (!/^[0-9a-f]{64}$/.test(token ?? '')) return null;
    return db.prepare('SELECT * FROM checkout_orders WHERE token_hash=? AND owner_hash IS NULL AND customer_id IS NULL').get(hash(token));
  }

  function startPayment(access) {
    const order = findCustomerOrder(access);
    if (!order) return [404,{message:'Không tìm thấy đơn.'}];
    if (order.state === 'pending') return [200,{state:'pending'}];
    if (order.state !== 'awaiting_payment') return [409,{message:'Đơn này không thể mở thanh toán.'}];
    const item = rows(order.source).products.find(row=>row.id===order.sku);
    if (!item?.eligible || !item.published || item.fingerprint !== order.fingerprint) {
      return [409,{message:'Gói đã thay đổi hoặc hết hàng. Hãy kiểm tra lại trong cửa hàng.'}];
    }
    if (Number.isSafeInteger(item.price) && item.price*order.quantity !== order.amount) {
      return [409,{message:'Giá bán đã thay đổi. Hãy kiểm tra giá mới và đặt lại trong cửa hàng.'}];
    }
    if (!sellable(item,order.quantity)) return [409,{message:'ShopMMO chưa thể nhận thanh toán cho đơn này. Vui lòng thử lại sau.'}];
    const now = Date.now();
    db.prepare("UPDATE checkout_orders SET state='pending',payment_started=?,updated=? WHERE code=? AND state='awaiting_payment'")
      .run(now,now,order.code);
    return [200,{state:'pending'}];
  }

  function deliver(order,result) {
    const costIssue = result.cost !== null && result.cost > order.amount ? 'Giá vốn nguồn cao hơn số tiền đã thu.' : null;
    const {changes} = db.prepare("UPDATE checkout_orders SET state='delivered', delivery=?, supplier_ref=?, supplier_cost=?, detail=?, updated=? WHERE code=? AND state IN ('ordering','review')")
      .run(encrypt(result.items,order.code),result.ref,result.cost,costIssue,Date.now(),order.code);
    return Boolean(changes);
  }

  function recordReview(order, message, ref) {
    if (ref && db.prepare('SELECT 1 FROM checkout_orders WHERE source=? AND supplier_ref=? AND code<>?').get(order.source,ref,order.code)) {
      update.run('review','Mã đơn nguồn đã được gắn với một đơn ShopMMO khác.',Date.now(),order.code);
      return;
    }
    db.prepare("UPDATE checkout_orders SET state='review', supplier_ref=COALESCE(?,supplier_ref), detail=?, updated=? WHERE code=?")
      .run(ref??null,message,Date.now(),order.code);
  }

  async function fulfill(order) {
    const claimed = db.prepare("UPDATE checkout_orders SET state='ordering', updated=? WHERE code=? AND state='paid'").run(Date.now(),order.code);
    if (!claimed.changes) return;
    let upstreamStarted = false;
    let result;
    try {
      if (!(await sync(order.source)).ok) throw Error('Không đồng bộ được tồn kho từ nguồn.');
      const item = rows(order.source).products.find(row=>row.id===order.sku);
      if (!item || !item.eligible || !item.published || item.fingerprint !== order.fingerprint) throw Error('Gói không còn đủ điều kiện giao ngay.');
      if (order.quantity > maxQuantity(item)) throw Error('Kho nguồn không đủ số lượng đã đặt.');
      if (order.amount < item.referencePrice*order.quantity) throw Error('Giá vốn nguồn đã cao hơn số tiền đã thu.');
      const wallet = await suppliers.inspect(order.source);
      if (!wallet.ok) throw Error(wallet.message);
      if (wallet.canWrite === false) throw Error('Khóa API thiếu quyền tạo đơn.');
      if (wallet.balance < item.referencePrice*order.quantity) throw Error('Ví nguồn không đủ tiền.');
      db.prepare('UPDATE checkout_orders SET supplier_attempt_at=? WHERE code=?').run(Date.now(),order.code);
      upstreamStarted = true;
      result = await suppliers.buy(order.source,order.sku,order.quantity);
      deliver(order,result);
    } catch(error) {
      const detail = upstreamStarted ? error.message + ' Cần đối soát nguồn trước khi xử lý lại.' : error.message + ' Chưa gửi lệnh mua.';
      recordReview(order,detail,result?.ref ?? error.ref);
    }
  }

  const active = new Set();
  const queue = db.prepare("SELECT * FROM checkout_orders WHERE source=? AND state='paid' ORDER BY updated,code LIMIT 1");
  async function processSource(source) {
    if (active.has(source) || !configured || !suppliers.enabled(source)) return;
    active.add(source);
    try {
      let order;
      while ((order=queue.get(source))) await fulfill(order);
    } catch {
      console.error('Không thể ghi kết quả nhập hàng của nguồn '+source+'.');
    } finally {
      active.delete(source);
    }
  }

  async function reconcile(code) {
    const order = get.get(code);
    if (!secret || !order || order.state !== 'review' || !order.supplier_ref || !order.supplier_attempt_at) {
      return [409,{message:'Cần một đơn đang đối soát có mã nguồn do API trả về.'}];
    }
    try {
      const result = await suppliers.lookup(order.source,order.sku,order.supplier_ref,order.quantity);
      return deliver(order,result) ? [200,{message:'Đã xác nhận và giao tài khoản từ đơn nguồn.'}] : [409,{message:'Trạng thái đơn đã thay đổi.'}];
    } catch(error) {
      return [502,{message:error.message}];
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
    const started = order.payment_started ?? order.created;
    const matched = data.transferAmount === order.amount && at >= started - 1000 && at <= started + expiration;
    const next = matched ? 'paid' : 'review';
    const detail = matched ? null : 'Tiền vào sai số tiền hoặc ngoài thời hạn. Cần đối soát thủ công.';
    db.prepare("UPDATE checkout_orders SET state=?, payment_ref=?, detail=?, updated=? WHERE code=? AND state='pending'")
      .run(next,data.id,detail,Date.now(),order.code);
    if (matched) void processSource(order.source);
    return [200,{ok:true}];
  }

  function orderView(order) {
    const {code,name,amount,quantity,created}=order;
    const expires = (order.payment_started ?? order.created)+expiration;
    const expired = order.state==='pending' && Date.now() > expires;
    const state = expired ? 'expired' : order.state;
    const payment = state==='pending' && configured ? {account,bin,holder,content:'SMMO'+code,expires} : null;
    return {code,name,amount,quantity,created,state,payment,delivery:state==='delivered' && secret ? decrypt(order):null};
  }

  function status(token) {
    const order = findCustomerOrder({token});
    return order?[200,orderView(order)]:[404,{message:'Không tìm thấy đơn.'}];
  }

  function customerOrders(session,page,customer) {
    const scope = ownerScope(session,customer);
    if (!scope) return {orders:[],total:0,page:0};
    const total = db.prepare('SELECT COUNT(*) AS n FROM checkout_orders WHERE '+scope.field+'=?').get(scope.key).n;
    const activePage = Math.min(page,Math.max(0,Math.ceil(total/10)-1));
    const orders = db.prepare('SELECT * FROM checkout_orders WHERE '+scope.field+'=? ORDER BY created DESC,code DESC LIMIT 10 OFFSET ?')
      .all(scope.key,activePage*10).map(orderView);
    return {orders,total,page:activePage};
  }

  function claimGuestOrders(session,customer){
    if (!session || !customer) return;
    db.prepare('UPDATE checkout_orders SET customer_id=?,owner_hash=NULL WHERE owner_hash=? AND customer_id IS NULL')
      .run(customer.id,hash(session));
  }

  function importOrders(session,tokens,customer) {
    const scope = ownerScope(session,customer);
    const claim = db.prepare('UPDATE checkout_orders SET '+scope.field+'=? WHERE token_hash=? AND owner_hash IS NULL AND customer_id IS NULL');
    const owned = db.prepare('SELECT 1 FROM checkout_orders WHERE token_hash=? AND '+scope.field+'=?');
    db.exec('BEGIN IMMEDIATE');
    try {
      const imported = [];
      for (const token of tokens) {
        const key=hash(token);
        if (claim.run(scope.key,key).changes || owned.get(key,scope.key)) imported.push(token);
      }
      db.exec('COMMIT');
      return imported;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const resume = () => {
    for (const source of ['uniz','melody']) void processSource(source);
  };
  const list = () => db.prepare('SELECT code,source,sku,name,amount,quantity,state,detail,payment_ref,supplier_ref,supplier_cost,supplier_attempt_at,created,updated FROM checkout_orders ORDER BY created DESC LIMIT 50').all();
  return {create,startPayment,customerOrders,claimGuestOrders,importOrders,webhook,status,sellable,maxQuantity,list,resume,reconcile,suppliers,configured};
}
