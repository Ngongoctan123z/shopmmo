const byId = id=>document.getElementById(id);
const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const slug = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const node = (tag,text) => Object.assign(document.createElement(tag),{textContent:text??''});
const count=byId('quantity'), submit=byId('place-order'), status=byId('purchase-status');
let selected, busy=false;
const unit = item=>item.price??item.referencePrice;
const planLabel = item=>item.plan||item.name;
const limit = item=>Math.max(0,item.maxQuantity??1);
function updateTotal(){
  const value=count.valueAsNumber, max=limit(selected);
  const valid=Number.isInteger(value)&&value>=1&&value<=max;
  const amount=unit(selected);
  byId('total').textContent=valid&&Number.isFinite(amount)?currency.format(amount*value):'—';
  byId('less').disabled=busy||!valid||value<=1;
  byId('more').disabled=busy||!valid||value>=max;
  submit.disabled=busy||!valid||!Number.isFinite(amount);
  count.disabled=busy;
  for(const radio of byId('variants').querySelectorAll('input')) radio.disabled=busy;
}
function choose(item){
  selected=item;
  byId('selected-plan').textContent=planLabel(item);
  count.max=String(limit(item));
  count.value='1';
  const amount=unit(item);
  byId('unit-price').textContent=Number.isFinite(amount)?currency.format(amount):'Chưa có giá';
  byId('total-label').textContent=item.price===null?'Tổng tham khảo':'Tổng tiền';
  byId('purchase-note').textContent=item.paymentReady?'Xác nhận đặt hàng để xem hướng dẫn VietQR và trạng thái đơn.':'Đơn được lưu trên ShopMMO. Mã QR sẽ xuất hiện khi thanh toán được mở.';
  status.textContent='';
  const facts=['Gói '+planLabel(item),'Hình thức giao: tài khoản số trong mục Đơn hàng.'];
  if(item.warrantyDays)facts.push('Thời hạn bảo hành theo gói: '+item.warrantyDays+' ngày.');
  if(item.id==='capcut-pro-ca-nhan-1-thang-bhf')facts.push('Gói cá nhân dùng trên một điện thoại và một máy tính. Sử dụng trên hai điện thoại có thể bị giới hạn đăng nhập.');
  if(item.id==='admin-canva-pro-business-100-slot-1-thang-bhf-052693')facts.push('Gói quản trị Canva Business. Có thể thêm tối đa 100 thành viên theo điều kiện của gói.');
  byId('details').replaceChildren(...facts.map(fact=>node('li',fact)));
  updateTotal();
}
count.addEventListener('input',updateTotal);
byId('less').addEventListener('click',()=>{count.stepDown();updateTotal();});
byId('more').addEventListener('click',()=>{count.stepUp();updateTotal();});
byId('purchase').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!selected||busy||!count.reportValidity()||submit.disabled)return;
  const quantity=count.valueAsNumber;
  busy=true;
  updateTotal();
  status.textContent='Đang tạo đơn ShopMMO…';
  try{
    const raw=JSON.parse(localStorage.getItem('shopmmo-orders')||'[]');
    const saved=Array.isArray(raw)?raw:[];
    const response=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({source:selected.source,id:selected.id,price:unit(selected),quantity})});
    const data=await response.json();
    if(!response.ok)throw Error(data.message);
    localStorage.setItem('shopmmo-orders',JSON.stringify([{code:data.code,token:data.token},...saved]));
    location.assign('/orders');
  }catch(error){
    busy=false;
    updateTotal();
    status.textContent=error.message;
  }
});
fetch('/api/catalog').then(async response=>{
  if(!response.ok)throw Error('Chưa tải được sản phẩm. Hãy tải lại trang.');
  return response.json();
}).then(({products})=>{
  const key=location.pathname.split('/').at(-1);
  const variants=products.filter(item=>slug(item.brand)===key);
  if(!variants.length)throw Error('Sản phẩm này hiện chưa có gói mở bán.');
  const brand=variants[0].brand;
  byId('product-title').textContent=brand;
  byId('breadcrumb').textContent=brand;
  byId('product-subtitle').textContent=variants.length+' gói có sẵn';
  document.title=brand+' | ShopMMO';
  for(const [index,item] of variants.entries()){
    const label=node('label');label.className='option';
    const radio=node('input');radio.type='radio';radio.name='variant';radio.checked=index===0;
    radio.addEventListener('change',()=>{if(radio.checked&&!busy)choose(item);});
    const caption=node('span',planLabel(item));
    if(item.warrantyDays)caption.append(node('small','Bảo hành '+item.warrantyDays+' ngày'));
    const amount=unit(item);
    label.append(radio,caption,node('strong',Number.isFinite(amount)?currency.format(amount):'Chưa có giá'));
    byId('variants').append(label);
  }
  choose(variants[0]);
  const alternatives=[...new Set(products.map(item=>item.brand))].filter(value=>value!==brand);
  for(const name of alternatives){
    const link=node('a',name);link.href='/products/'+slug(name);byId('related').append(link);
  }
  byId('related-section').hidden=!alternatives.length;
  byId('product-error').hidden=true;
  byId('product-page').hidden=false;
}).catch(error=>{byId('product-error').textContent=error.message;});
