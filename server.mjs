import { createCheckout } from './checkout.mjs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sources = ['uniz', 'melody'];
const brands = ['Netflix','NordVPN','AdGuard VPN','CapCut','Canva','Meitu','Spotify','YouTube','Disney+','Prime Video','Khác'];
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
const reviewedUniz = new Map([
  ['netflix-premium-4k-1-thang-bhf', 'Netflix'],
  ['nordvpn-3-ngay-bhf-f4faea', 'NordVPN'],
  ['adguard-vpn-5-7-ngay-bhf-4df89a', 'AdGuard VPN']
]);

function offer(source, id, slug, name, plan, category, referencePrice, stock, instant, description = '', hasFields = false) {
  if (!slugOk(slug) || !name || !cents(referencePrice)) throw Error('Danh mục chứa gói sai định dạng.');
  const searchable = [name, plan, category, slug, description.replace(/<[^>]*>/g, ' ')].map(fold).join(' ').replace(/-/g, ' ');
  const blocked = aiSignals.test(searchable) || (source === 'uniz' && /\b(capcut|canva)\b/.test(searchable))
    ? 'Có dấu hiệu liên quan đến AI'
    : hasFields || manualSignals.test(searchable) || instant === false ? 'Cần xử lý hoặc xác minh theo gói' : '';
  const fingerprint = digest(JSON.stringify([slug,name,plan,category,description,instant,blocked])).toString('hex');
  return { id, slug, name, plan, category, referencePrice, stock, instant, blocked, fingerprint, source };
}

export function normalizeUniz(data) {
  if (data?.success !== true || !Array.isArray(data.products) || data.total !== data.products.length) throw Error('Uniz trả danh mục không đầy đủ.');
  return data.products.map(row => {
    if (typeof row.inStock !== 'boolean') throw Error('Uniz trả trạng thái kho không hợp lệ.');
    return offer('uniz', String(row.slug), row.slug, text(row.name), '', text(row.category), row.price, row.inStock, null);
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
        plan.fields.length > 0);
    });
  });
}

async function requestCatalog(url, headers, fetcher) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12_000), redirect: 'error' });
  if (!response.ok) throw Error('Nhà cung cấp trả HTTP ' + response.status + '.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw Error('Danh mục vượt giới hạn dung lượng.');
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('Nhà cung cấp trả JSON không hợp lệ.'); }
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
      const instant = item.instant === true || (item.instant === null && approved);
      return {...item, brand: review?.brand ?? 'Khác', price: review?.price ?? null,
        approved, published: Boolean(approved && review.published), eligible: !item.blocked && instant && item.stock && fresh,
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
          items = normalizeUniz(await requestCatalog('https://unizvn.com/api/v1/products',headers,fetcher));
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
          const first = !snapshot.get(source);
          db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?)').run(source,Date.now(),JSON.stringify(items));
          if (first && source === 'uniz') for (const item of items) {
            if (reviewedUniz.has(item.id) && !item.blocked) writeReview.run(source,item.id,item.fingerprint,reviewedUniz.get(item.id),1,null);
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
            referencePrice:item.source==='uniz'?item.referencePrice:null}));
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
        return json(200,{brands,checkoutConfigured:checkout.configured,orders:checkout.list(),sources:sources.map(source=>({source,configured:configured(source),running:running.has(source),...rows(source)})),
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
      if (!sources.includes(input?.source)) return json(400,{message:'Nguồn hàng không hợp lệ.'});
      const source = input.source;
      if (path === '/api/admin/sync') {
        const result = await sync(source);
        return json(result.ok ? 200 : 502,result);
      }
      if (path === '/api/admin/review') {
        const state = rows(source);
        const item = state.products.find(item=>item.id===input.id);
        if (!item || item.fingerprint !== input.fingerprint) return json(409,{message:'Gói đã thay đổi. Tải lại danh mục.'});
        if (!brands.includes(input.brand) || typeof input.published !== 'boolean' || !(input.price === null || (cents(input.price) && Number.isInteger(input.price)))) {
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
  const refresh = () => Promise.all(sources.map(sync)).catch(() => console.error('Lỗi tác vụ đồng bộ.'));
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



