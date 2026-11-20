const uniz = 'https://unizvn.com/api/v1';
const melody = 'https://melodyapp.vn/api/v1';
const maxResponseBytes = 512 * 1024;
const walletTtl = 6 * 60_000;

export class SupplierError extends Error {
  constructor(message, ref = null) {
    super(message);
    this.ref = ref;
  }
}

const reference = value => typeof value === 'string' && /^[a-z0-9_-]{3,80}$/i.test(value) ? value : null;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validItem = value => typeof value === 'string' && value.trim() && value.length <= 16000;
const messages = {
  INSUFFICIENT_BALANCE:'Ví nguồn không đủ tiền.',
  OUT_OF_STOCK:'Nhà cung cấp báo hết hàng.',
  PRODUCT_NOT_FOUND:'Nhà cung cấp không tìm thấy sản phẩm.',
  PERMISSION_DENIED:'Khóa API thiếu quyền.',
  RATE_LIMIT_EXCEEDED:'Nhà cung cấp giới hạn tần suất yêu cầu.',
  ORDER_NOT_FOUND:'Nguồn chưa tìm thấy mã đơn.'
};

async function readJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { return null; }
}

function melodyReceipt(receipt, delivery, sku, ref) {
  if (!ref || receipt?.status !== 'completed' || (receipt.plan_id ?? receipt.plan?.id) !== Number(sku) ||
    receipt.quantity !== 1 || (receipt.payment_status && receipt.payment_status !== 'paid') ||
    !Array.isArray(delivery?.items) || delivery.items.length !== 1 || !validItem(delivery.items[0]) ||
    (delivery.delivered_count != null && delivery.delivered_count !== 1) ||
    (delivery.expected_count != null && delivery.expected_count !== 1)) {
    throw new SupplierError('MelodyApp chưa xác nhận đủ một tài khoản đã giao.',ref);
  }
  return {ref, items:delivery.items, cost:money(receipt.final_amount)?receipt.final_amount:null};
}

function unizReceipt(result, sku, expectedRef = null) {
  const receipt = result?.order ?? result?.data?.order ?? result?.data ?? result;
  const ref = reference(receipt?.code ?? receipt?.orderCode ?? receipt?.order_code);
  const code = ref && /^UZ/i.test(ref) ? ref : null;
  const listedSku = receipt?.slug ?? receipt?.product?.slug;
  const qty = receipt?.qty ?? receipt?.quantity;
  const status = receipt?.status;
  const items = receipt?.accounts ?? receipt?.delivery?.items ?? result?.data?.accounts ?? result?.accounts;
  const completed = status == null || status === true || ['completed','delivered','success','paid'].includes(String(status).toLowerCase());
  if ((result?.success !== true && result?.status !== true) || !code || !completed ||
      (expectedRef && (code !== expectedRef || listedSku !== sku)) ||
      (listedSku != null && listedSku !== sku) || (qty != null && qty !== 1) ||
      !Array.isArray(items) || items.length !== 1 || !validItem(items[0])) {
    throw new SupplierError('Uniz chưa trả mã đơn và một tài khoản giao hàng theo định dạng đã hỗ trợ.',expectedRef && expectedRef !== code ? null : code);
  }
  return {ref:code, items, cost:null};
}

export function createSuppliers(env, fetcher) {
  const diagnostics = new Map();
  const inspections = new Map();
  const credentials = {
    uniz: env.UNIZ_API_KEY ? {'x-api-key':env.UNIZ_API_KEY} : null,
    melody: env.MELODY_API_KEY && env.MELODY_API_SECRET
      ? {'X-API-Key':env.MELODY_API_KEY,'X-API-Secret':env.MELODY_API_SECRET} : null
  };
  const flags = {uniz:env.UNIZ_ORDER_ENABLED === 'true',melody:env.MELODY_ORDER_ENABLED === 'true'};
  const enabled = source => Boolean(flags[source] && credentials[source]);

  async function request(source,path,body) {
    const base = source === 'melody' ? melody : uniz;
    const headers = credentials[source];
    if (!headers) throw new SupplierError('Thiếu cấu hình khóa API nguồn.');
    let response, data;
    try {
      response = await fetcher(base+path,{
        headers: body ? {...headers,'Content-Type':'application/json'} : headers,
        method:body?'POST':'GET', body:body?JSON.stringify(body):undefined,
        redirect:'error',signal:AbortSignal.timeout(12_000)
      });
      data = await readJson(response);
    } catch {
      throw new SupplierError('Mất kết nối hoặc quá thời gian phản hồi của nguồn.');
    }
    if (!response.ok || !data || data.success === false) {
      const code = data?.data?.error_code ?? data?.error_code;
      const message = typeof code === 'string' && Object.hasOwn(messages,code) ? messages[code] : 'Nguồn trả HTTP '+response.status+' hoặc dữ liệu không hợp lệ.';
      throw new SupplierError(message);
    }
    return data;
  }

  async function inspect(source) {
    if (inspections.has(source)) return inspections.get(source);
    const task = (async() => {
      try {
        const result = await request(source,source === 'melody'?'/account/info':'/balance');
        const balance = source === 'melody'?result.data?.user?.balance : result.balance;
        if (result.success !== true || !money(balance)) throw new SupplierError('Không xác minh được ví nguồn.');
        const scopes = result.data?.api_key?.permissions;
        const canWrite = source === 'melody' ? Boolean(Array.isArray(scopes) && scopes.some(scope=>scope==='orders.create'||scope==='all')) : null;
        const snapshot = {ok:true,balance,canWrite,checkedAt:Date.now(),message:null};
        diagnostics.set(source,snapshot);
        return snapshot;
      } catch(error) {
        const snapshot = {ok:false,balance:null,canWrite:null,checkedAt:Date.now(),message:error.message};
        diagnostics.set(source,snapshot);
        return snapshot;
      }
    })();
    inspections.set(source,task);
    try { return await task; }
    finally { inspections.delete(source); }
  }

  function status(source) {
    const snapshot = diagnostics.get(source);
    return {enabled:enabled(source),keyConfigured:Boolean(credentials[source]),
      ...snapshot,fresh:Boolean(snapshot?.ok && Date.now()-snapshot.checkedAt < walletTtl)};
  }

  async function buy(source,sku) {
    if (!enabled(source)) throw new SupplierError('Nhập hàng API cho nguồn này đang tắt.');
    if (source === 'uniz') return unizReceipt(await request(source,'/orders',{slug:sku,qty:1}),sku);
    const result = await request(source,'/orders/create',{items:[{plan_id:Number(sku),quantity:1}]});
    const orders = result.data?.orders;
    const receipt = Array.isArray(orders) && orders.length === 1 ? orders[0] : null;
    const ref = reference(receipt?.trans_id);
    if (result.success !== true || result.data?.summary?.partial_success === true || result.data?.failed_items?.length) {
      throw new SupplierError('MelodyApp chưa xác nhận đơn nhập hàng thành công.',ref);
    }
    return melodyReceipt(receipt,receipt?.delivery,sku,ref);
  }

  async function lookup(source,sku,ref) {
    if (!reference(ref)) throw new SupplierError('Thiếu mã đơn chính xác của nhà cung cấp.');
    if (source === 'uniz') return unizReceipt(await request(source,'/orders?code='+encodeURIComponent(ref)),sku,ref);
    const result=await request(source,'/orders/status?trans_id='+encodeURIComponent(ref));
    const receipt=result.data?.order;
    if (result.success !== true || receipt?.trans_id !== ref) throw new SupplierError('MelodyApp không xác nhận đúng mã đơn.');
    return melodyReceipt(receipt,result.data.delivery,sku,ref);
  }
  return {enabled,inspect,status,buy,lookup};
}
