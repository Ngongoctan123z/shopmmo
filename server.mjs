import { createCheckout } from './checkout.mjs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sources = ['uniz', 'melody'];
const brands = ['CapCut','Canva','Meitu','Hypic','Wink','Xingtu','FPT Play','BeautyCam','VSCO','Xinghui','Làm đẹp'];
const base = {
  uniz: 'https://unizvn.com/p/',
  melody: 'https://melodyapp.vn/product/'
};
const expiryMs = 20 * 60_000;
const clean = value => String(value ?? '').trim().slice(0, 240);
const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi,'d').toLowerCase();
const text = value => typeof value === 'string' ? clean(value) : '';
const slugOk = value => typeof value === 'string' && /^[a-z0-9-]{1,180}$/i.test(value);
const cents = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000_000;
const digest = value => createHash('sha256').update(value).digest();
const aiSignals = /\b(ai|llm|gpt|openai|chatgpt|claude|gemini|copilot|grok|anthropic|suno|midjourney|deepseek|veo\s?3|hailuo|elevenlabs|magic studio)\b/;
const manualSignals = /\b(nang cap|chinh chu|xu ly|cho admin|thu cong|manual|pending|upgrade|gift link|redeem|cdk|otp|api key|license key)\b/;
// Uniz's inventory API omits delivery mode. Check these exact variants on their public product pages.
const unizCatalog = new Map([
  ['capcut-pro-ca-nhan-1-thang-bhf','CapCut'],
  ['admin-canva-pro-business-100-slot-1-thang-bhf-052693','Canva']
]);
const melodyReviewed = new Map([
  ['773','Meitu'],['805','Meitu'],['774','Meitu'],['777','Meitu'],['775','Meitu'],
  ['818','Hypic'],['782','Wink']
]);
const beautyApps = [
  ['meitu','Meitu'],['hypic','Hypic'],['wink','Wink'],['xingtu','Xingtu'],
  ['beautycam','BeautyCam'],['vsco','VSCO'],['xinghui','Xinghui']
];

function brandFor(source, id, name, slug, category) {
  if (source === 'uniz') return unizCatalog.get(id);
  const product = fold(name+' '+slug);
  if (/\bfpt play\b/.test(product.replace(/-/g,' '))) return 'FPT Play';
  return beautyApps.find(([key])=>product.includes(key))?.[1] ??
    (/\blam dep\b/.test(fold(category)) ? 'Làm đẹp' : null);
}

function offer(source,id,slug,name,plan,category,referencePrice,stock,instant,description='',hasFields=false,listingPrice=referencePrice) {
  if (!slugOk(slug) || !name || !cents(referencePrice)) throw Error('Danh mục chứa gói sai định dạng.');
  const brand = brandFor(source,id,name,slug,category);
  const identity = [name,plan,slug].map(fold).join(' ').replace(/-/g,' ');
  let blocked = '';
  if (!brand) blocked = 'Ngoài phạm vi danh mục ShopMMO';
  else if (source === 'melody' && id === '809') blocked = 'Gói hiện có yêu cầu số điện thoại chính chủ và chờ kích hoạt 5–10 phút';
  else if (aiSignals.test(identity)) blocked = 'Gói riêng có dấu hiệu liên quan đến AI';
  else if (brand === 'Xingtu' && /\botp\b/i.test(description)) blocked = 'Đăng nhập cần OTP từ nhà cung cấp';
  else if (hasFields || manualSignals.test(fold(plan)) || instant === false) blocked = 'Gói cần xử lý hoặc cần thông tin bổ sung';
  const fingerprint = digest(JSON.stringify([slug,name,plan,category,description,instant,blocked])).toString('hex');
  return {id,slug,name,plan,category,referencePrice,listingPrice,stock,instant,blocked,fingerprint,source};
}

export function normalizeUniz(data, instantSlugs = new Set()) {
  if (data?.success !== true || !Array.isArray(data.products) || data.total !== data.products.length) throw Error('Uniz trả danh mục không đầy đủ.');
  return data.products.map(row => {
    if (typeof row.inStock !== 'boolean') throw Error('Uniz trả trạng thái kho không hợp lệ.');
    return offer('uniz', String(row.slug), row.slug, text(row.name), '', text(row.category), row.price, row.inStock, instantSlugs.has(row.slug));
  });
}

export function normalizeMelody(data) {
  if (data?.success !== true || !Array.isArray(data.data?.products)) throw Error('MelodyApp trả danh mục không hợp lệ.');
  return data.data.products.flatMap(product => {
    if (!Array.isArray(product.plans)) throw Error('MelodyApp thiếu danh sách gói.');
    const category = [product.category, ...(product.categories ?? [])].map(item => text(item?.name)).join(' ');
    return product.plans.map(plan => {
      if (!Number.isSafeInteger(plan.id) || typeof plan.is_instant !== 'boolean' || typeof plan.in_stock !== 'boolean' || !Array.isArray(plan.fields)) {
        throw Error('MelodyApp trả gói thiếu dữ liệu giao hàng.');
      }
      return offer('melody', String(plan.id), product.slug, text(product.name), text(plan.name), category,
        plan.final_price, plan.in_stock && Number.isInteger(plan.stock_count) && plan.stock_count > 0,
        plan.is_instant, String(product.description ?? '').slice(0, 20_000) + ' ' + String(plan.description ?? '').slice(0, 20_000),
        plan.fields.length > 0, cents(plan.price) ? plan.price : null);
    });
  });
}

async function requestText(url, headers, fetcher, limit) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12_000), redirect: 'error' });
  if (!response.ok) throw Error('Nhà cung cấp trả HTTP ' + response.status + '.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw Error('Danh mục vượt giới hạn dung lượng.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestCatalog(url, headers, fetcher) {
  const body = await requestText(url,headers,fetcher,8_000_000);
  try { return JSON.parse(body); }
  catch { throw Error('Nhà cung cấp trả JSON không hợp lệ.'); }
}

async function liveUnizInstant(catalog,fetcher) {
  const products = Array.isArray(catalog?.products)?catalog.products:[];
  const checks = await Promise.all(products.filter(item=>unizCatalog.has(item.slug) && item.inStock === true).map(async item=>{
    try {
      const body = await requestText(base.uniz+item.slug,{},fetcher,1_500_000);
      const heading = /<h1\b[^>]*>([^<]+)<\/h1>/i.exec(body);
      if (!heading || fold(heading[1]) !== fold(item.name)) return null;
      const details = body.slice(heading.index+heading[0].length,heading.index+heading[0].length+1300);
      const badge = /<span\b[^>]*>\s*(Có ngay|Giao hàng)\s*<\/span>/i.exec(details);
      return badge?.[1] === 'Có ngay'?item.slug:null;
    } catch {
      return null;
    }
  }));
  return new Set(checks.filter(Boolean));
}

export function createApp(env = process.env, fetcher = fetch) {
  const db = new DatabaseSync(env.SHOPMMO_DB || 'shopmmo.sqlite');
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS snapshots (source TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reviews (source TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      brand TEXT NOT NULL, published INTEGER NOT NULL, price INTEGER, PRIMARY KEY(source,id));
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
  `);
  const snapshot = db.prepare('SELECT * FROM snapshots WHERE source=?');
  const reviewRows = db.prepare('SELECT * FROM reviews WHERE source=?');
  const writeReview = db.prepare('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?)');
  const event = db.prepare('INSERT INTO events(at,source,action,detail) VALUES(?,?,?,?)');
  const running = new Map();
  const configured = source => source === 'uniz' || Boolean(env.MELODY_API_KEY && env.MELODY_API_SECRET);

  function rows(source) {
    const record = snapshot.get(source);
    const reviews = new Map(reviewRows.all(source).map(row => [row.id,row]));
    const fresh = Boolean(record && Date.now() - record.updated <= expiryMs);
    const products = record ? JSON.parse(record.payload).map(item => {
      const review = reviews.get(item.id);
      const approved = review?.fingerprint === item.fingerprint;
      const scopedBrand = brandFor(source,item.id,item.name,item.slug,item.category);
      const instant = item.instant === true;
      const blocked = !scopedBrand ? 'Ngoài phạm vi danh mục ShopMMO' :
        source === 'melody' && item.id === '809' ? 'Gói hiện có yêu cầu số điện thoại chính chủ và chờ kích hoạt 5–10 phút' : item.blocked;
      return {...item, blocked, brand: scopedBrand ?? 'Ngoài phạm vi', price: review?.price ?? null,
        approved, published: Boolean(approved && review.published && !blocked),
        eligible: !blocked && instant && item.stock && fresh,
        url: base[source] + item.slug};
    }) : [];
    return { updated: record?.updated ?? null, fresh, products };
  }

  function sync(source) {
    if (running.has(source)) return running.get(source);
    if (!configured(source)) return Promise.resolve({ok:false, message:'Chưa cấu hình khóa đọc MelodyApp.'});
    const task = (async () => {
      try {
        let items;
        if (source === 'uniz') {
          const headers = env.UNIZ_API_KEY ? {'x-api-key':env.UNIZ_API_KEY} : {};
          const catalog = await requestCatalog('https://unizvn.com/api/v1/products',headers,fetcher);
          items = normalizeUniz(catalog,await liveUnizInstant(catalog,fetcher));
        } else {
          const headers = {'X-API-Key':env.MELODY_API_KEY,'X-API-Secret':env.MELODY_API_SECRET};
          const url = 'https://melodyapp.vn/api/v1/products/list';
          items = [];
          let more = true;
          for (let page=1; more; page++) {
            if (page > 30) throw Error('Danh mục vượt giới hạn phân trang.');
            const data = await requestCatalog(url + '?page=' + page, headers,fetcher);
            items.push(...normalizeMelody(data));
            const pagination = data.data.pagination;
            if (pagination && pagination.current_page !== page) throw Error('MelodyApp trả sai trang.');
            more = pagination?.has_more === true;
            if (pagination?.total_pages > page && !more) throw Error('MelodyApp trả thiếu trang.');
          }
        }
        if (new Set(items.map(item=>item.id)).size !== items.length) throw Error('Danh mục có mã gói trùng.');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)').run(source,Date.now(),JSON.stringify(items));
          const selected = source === 'uniz' ? unizCatalog : melodyReviewed;
          const publishDefault = db.prepare('INSERT OR IGNORE INTO reviews VALUES(?,?,?,?,?,?)');
          for (const item of items) {
            const brand = selected.get(item.id);
            if (brand && brand === brandFor(source,item.id,item.name,item.slug,item.category) &&
                item.instant && item.stock && !item.blocked) publishDefault.run(source,item.id,item.fingerprint,brand,1,null);
          }
          event.run(Date.now(),source,'Đồng bộ',items.length + ' gói');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return {ok:true, message:'Đã đồng bộ ' + items.length + ' gói.'};
      } catch {
        const message = 'Đồng bộ thất bại. Kiểm tra khóa, kết nối hoặc định dạng dữ liệu nguồn.';
        event.run(Date.now(),source,'Lỗi đồng bộ',message);
        return {ok:false, message};
      } finally { running.delete(source); }
    })();
    running.set(source,task);
    return task;
  }

  const checkout = createCheckout({db,env,rows,sync,fetcher});
  const assets = new Map([
    ['/orders', ['text/html; charset=utf-8','orders.html']],
    ['/orders.js', ['text/javascript; charset=utf-8','orders.js']],
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/admin', ['text/html; charset=utf-8','admin.html']],
    ['/shop.js', ['text/javascript; charset=utf-8','shop.js']],
    ['/admin.js', ['text/javascript; charset=utf-8','admin.js']]
  ].map(([path,[type,file]]) => [path,[type,readFileSync(new URL('./public/'+file,import.meta.url))]]));
  const key = env.ADMIN_TOKEN?.length >= 32 ? digest(env.ADMIN_TOKEN) : null;

  const server = http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src https://img.vietqr.io; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const json = (status,data) => {
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url,'http://localhost').pathname;
      const asset = assets.get(path);
      if (req.method === 'GET' && asset) {
        res.writeHead(200,{'Content-Type':asset[0]});
        return res.end(asset[1]);
      }
      if (req.method === 'GET' && path === '/api/catalog') {
        const products = sources.flatMap(source=>rows(source).products)
          .filter(item=>item.eligible && item.published)
          .map(item=>({name:item.name,plan:item.plan,brand:item.brand,price:item.price,url:item.url,
            source:item.source,id:item.id,buyable:checkout.sellable(item),
            referencePrice:item.listingPrice??null}));
        return json(200,{products});
      }
      const publicPost = ['/api/checkout','/api/payments/gpmpay'].includes(path) && req.method === 'POST';
      if (req.method === 'GET' && path === '/api/order') {
        return json(...checkout.status(req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]));
      }
      if (!publicPost && !path.startsWith('/api/admin/')) return json(404,{message:'Không tìm thấy.'});
      const auth = req.headers.authorization;
      if (!publicPost && (!key || !auth?.startsWith('Bearer ') || !timingSafeEqual(key,digest(auth.slice(7))))) {
        return json(401,{message:'Cần mã quản trị hợp lệ.'});
      }
      if (req.method==='GET' && path==='/api/admin/state') {
        return json(200,{brands,checkoutConfigured:checkout.configured,orders:checkout.list(),sources:sources.map(source=>({source,configured:configured(source),running:running.has(source),procurement:checkout.suppliers.status(source),...rows(source)})),
          events:db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 30').all()});
      }
      if (req.method !== 'POST') return json(405,{message:'Phương thức không được hỗ trợ.'});
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(415,{message:'Cần JSON.'});
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8192) { json(413,{message:'Yêu cầu quá dài.'}); return; }
        chunks.push(chunk);
      }
      let input;
      const raw = Buffer.concat(chunks);
      try { input = JSON.parse(raw); } catch { return json(400,{message:'JSON không hợp lệ.'}); }
      if (path === '/api/checkout') return json(...await checkout.create(input));
      if (path === '/api/payments/gpmpay') return json(...checkout.webhook(input,raw,req.headers['x-gpmpay-signature']));
      if (path === '/api/admin/order-reconcile') {
        if (!Number.isSafeInteger(input?.code)) return json(400,{message:'Mã đơn không hợp lệ.'});
        return json(...await checkout.reconcile(input.code));
      }
      if (!sources.includes(input?.source)) return json(400,{message:'Nguồn hàng không hợp lệ.'});
      const source = input.source;
      if (path === '/api/admin/supplier-check') {
        const result = await checkout.suppliers.inspect(source);
        return json(result.ok ? 200 : 502,{...result,message:result.message ?? 'Đã kiểm tra ví nguồn.'});
      }
      if (path === '/api/admin/sync') {
        const result = await sync(source);
        return json(result.ok ? 200 : 502,result);
      }
      if (path === '/api/admin/review') {
        const state = rows(source);
        const item = state.products.find(item=>item.id===input.id);
        if (!item || item.fingerprint !== input.fingerprint) return json(409,{message:'Gói đã thay đổi. Tải lại danh mục.'});
        if (input.brand !== item.brand || !brands.includes(input.brand) || typeof input.published !== 'boolean' || !(input.price === null || (cents(input.price) && Number.isInteger(input.price)))) {
          return json(400,{message:'Thương hiệu hoặc giá bán không hợp lệ.'});
        }
        if (input.published && (item.blocked || !item.stock || !state.fresh || input.confirmed !== true ||
          (item.instant !== true && source !== 'uniz') || (source === 'melody' && input.price === null))) {
          return json(422,{message:'Gói chưa đạt điều kiện đăng. Kiểm tra tồn, giao ngay, tài khoản không AI và giá bán MelodyApp.'});
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          writeReview.run(source,item.id,item.fingerprint,input.brand,Number(input.published),input.price);
          event.run(Date.now(),source,input.published?'Đăng / cập nhật':'Ẩn',item.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(200,{ok:true, message:'Đã lưu gói sản phẩm.'});
      }
      return json(404,{message:'Không tìm thấy.'});
    } catch { if (!res.headersSent) json(500,{message:'Lỗi máy chủ.'}); else res.end(); }
  });
  return {server,db,sync,checkout};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {server,sync,checkout} = createApp();
  const refresh = () => Promise.all(sources.flatMap(source=>[sync(source),checkout.suppliers.inspect(source)]))
    .catch(() => console.error('Lỗi tác vụ đồng bộ.'));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port,host,() => {
    console.log('ShopMMO http://' + host + ':' + port);
    void refresh();
    checkout.resume();
  });
  setInterval(refresh, 5 * 60_000).unref();
  setInterval(checkout.resume, 30_000).unref();
}



