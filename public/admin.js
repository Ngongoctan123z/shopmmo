const $ = id=>document.getElementById(id);
const sourceName = {uniz:'Uniz',melody:'MelodyApp'};
const formatVnd = amount => new Intl.NumberFormat('vi-VN').format(amount)+' ₫';
const stamp = at => at ? new Date(at).toLocaleString('vi-VN') : 'Chưa đồng bộ';
const node = (tag,text) => Object.assign(document.createElement(tag),{textContent:text ?? ''});
let token = '', state, page = 0;
const limit = 25;
async function api(path, data) {
  const options = {headers:{Authorization:'Bearer '+token}};
  if(data){options.method='POST';options.headers['Content-Type']='application/json';options.body=JSON.stringify(data);}
  const response = await fetch('/api/admin/'+path,options);
  const result = await response.json();
  if(!response.ok) throw Error(result.message);
  return result;
}
async function refresh() {
  state = await api('state');
  $('dashboard').hidden = false;
  $('login').hidden = true;
  $('logout').hidden = false;
  render();
}
function action(label,handler){
  const button = node('button',label);
  button.type = 'button';
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try { $('status').textContent=await handler(); }
    catch(error){$('status').textContent=error.message;}
    finally{button.disabled=false;}
  });
  return button;
}
function render(){
  $('sources').replaceChildren();
  for(const source of state.sources){
    const box=node('div');box.className='source';
    const sync=action('Đồng bộ ngay',async()=>{try{return (await api('sync',{source:source.source})).message;}finally{await refresh();}});
    sync.disabled=!source.configured || source.running;
    const supplier=source.procurement;
    const check=action('Kiểm tra ví nguồn',async()=>{try{return (await api('supplier-check',{source:source.source})).message;}finally{await refresh();}});
    check.disabled=!supplier.keyConfigured;
    const wallet=supplier.ok?'Số dư ví '+formatVnd(supplier.balance)+(supplier.fresh?'':' · Đã cũ'):
      supplier.message ?? 'Chưa kiểm tra ví nguồn';
    const permission=supplier.canWrite===true?'Có quyền tạo đơn':supplier.canWrite===false?
      'Thiếu quyền tạo đơn':source.source==='uniz'&&supplier.ok?'Khóa hợp lệ. API ví không cho biết quyền tạo đơn.':'Chưa xác minh quyền tạo đơn.';
    box.append(node('strong',sourceName[source.source]),node('p',source.configured?'Đã bật kết nối đọc':'Thiếu khóa máy chủ'),
      node('p','Danh mục · '+stamp(source.updated)+(source.updated&&!source.fresh?' · Tồn kho đã cũ':'')),
      node('p',wallet+(supplier.checkedAt?' · '+stamp(supplier.checkedAt):'')),node('p',permission),
      node('p',supplier.enabled?'Đã bật chế độ nhập hàng':'Đang tắt chế độ nhập hàng'),sync,' ',check);
    $('sources').append(box);
  }
  $('events').replaceChildren(...state.events.map(item=>node('li',stamp(item.at)+' · '+sourceName[item.source]+' · '+item.action+' · '+item.detail)));
  $('payment-config').textContent=state.checkoutConfigured?'GPM Pay đã có cấu hình máy chủ.':'GPM Pay đang chờ cấu hình tài khoản nhận, khóa webhook và khóa mã hóa.';
  $('orders').replaceChildren(...state.orders.map(item=>{
    const row=node('tr');
    const ref=node('td',String(item.code));ref.append(node('small',item.name));
    const detail=node('td',item.state);if(item.detail)detail.append(node('small',item.detail));
    if(item.payment_ref)detail.append(node('small','GPM Pay · '+item.payment_ref));
    if(item.supplier_ref)detail.append(node('small',sourceName[item.source]+' · '+item.supplier_ref));
    if(item.supplier_cost!==null)detail.append(node('small','Giá vốn thực tế '+formatVnd(item.supplier_cost)));
    if(item.state==='review'&&item.supplier_ref){
      detail.append(action('Đối soát nguồn',async()=>{
        const result=await api('order-reconcile',{code:item.code});
        await refresh();
        return result.message;
      }));
    }
    row.append(ref,node('td',formatVnd(item.amount)),detail);
    return row;
  }));
  renderRows();
}
function renderRows(){
  const query=$('query').value.trim().toLowerCase(), supplier=$('supplier').value, status=$('statusFilter').value;
  const matches=state.sources.flatMap(source=>source.products).filter(item=>{
    const live=item.published&&item.eligible;
    const kind=item.blocked?'blocked':!item.stock?'stock':live?'live':'pending';
    return (!supplier||item.source===supplier)&&(!status||status===kind)&&[item.name,item.plan,item.id].join(' ').toLowerCase().includes(query);
  });
  const pages=Math.max(1,Math.ceil(matches.length/limit));
  page=Math.min(page,pages-1);
  $('page').textContent='Trang '+(page+1)+' / '+pages+' · '+matches.length+' gói';
  $('prev').disabled=page===0;$('next').disabled=page+1>=pages;
  $('products').replaceChildren(...matches.slice(page*limit,(page+1)*limit).map(makeRow));
}
function makeRow(item){
  const row=node('tr');
  const info=node('td'), status=node('td'), settings=node('td'), controls=node('td');
  const link=node('a',item.name);link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';
  info.append(link,node('small',[sourceName[item.source],item.plan,item.id].filter(Boolean).join(' · ')));
  status.append(node('strong',item.blocked||(!item.stock?'Hết hàng':item.instant===true?'Giao tự động':'Cần xác nhận giao ngay')),
    node('small',item.published&&item.eligible?'Đang hiển thị':'Đang ẩn'));
  const brand=node('select');brand.setAttribute('aria-label','Thương hiệu '+item.name);
  for (const value of state.brands) brand.add(new Option(value,value));
  brand.value=item.brand;
  const price=node('input');price.type='number';price.min='0';price.max='100000000';price.step='1';
  price.placeholder='Giá bán ₫';price.setAttribute('aria-label','Giá bán '+item.name);price.value=item.price??'';
  settings.append(brand,price,node('small','Giá nguồn '+new Intl.NumberFormat('vi-VN').format(item.referencePrice)+' ₫'));
  const confirm=node('input');confirm.type='checkbox';
  const label=node('label');label.className='confirm';label.append(confirm,node('span','Tài khoản không AI, giao ngay'));
  const save=published=>async()=>{
    const result=await api('review',{source:item.source,id:item.id,fingerprint:item.fingerprint,brand:brand.value,price:price.value===''?null:Number(price.value),published,confirmed:confirm.checked});
    await refresh();
    return result.message;
  };
  const publish=action(item.published?'Cập nhật':'Đăng',save(true));publish.disabled=Boolean(item.blocked||!item.stock);
  controls.append(label,publish);
  if(item.published) controls.append(' ',action('Ẩn',save(false)));
  row.append(info,status,settings,controls);
  return row;
}
$('login').addEventListener('submit',async event=>{
  event.preventDefault();token=$('token').value;$('token').value='';
  try{await refresh();$('status').textContent='Đã mở trang quản trị.';}
  catch(error){token='';$('status').textContent=error.message;}
});
$('logout').addEventListener('click',()=>{token='';state=null;$('dashboard').hidden=true;$('sources').replaceChildren();$('products').replaceChildren();$('events').replaceChildren();$('orders').replaceChildren();$('logout').hidden=true;$('login').hidden=false;$('status').textContent='Đã đăng xuất.';});
$('query').addEventListener('input',()=>{page=0;renderRows();});
for(const id of ['supplier','statusFilter']) $(id).addEventListener('change',()=>{page=0;renderRows();});
$('prev').addEventListener('click',()=>{page--;renderRows();});
$('next').addEventListener('click',()=>{page++;renderRows();});

