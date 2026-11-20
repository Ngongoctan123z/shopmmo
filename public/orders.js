const byId=id=>document.getElementById(id);
const root=byId('orders');
const node=(tag,text,className)=>Object.assign(document.createElement(tag),{textContent:text??'',className:className??''});
const currency=new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const labels={awaiting_payment:'Chờ mở thanh toán',pending:'Chờ chuyển khoản',paid:'Đã thanh toán',ordering:'Đang giao tài khoản',
  delivered:'Đã giao tài khoản',expired:'Hết hạn thanh toán',review:'Đang đối soát',unavailable:'Chưa tải được'};
const notes={awaiting_payment:'Đơn đã được lưu. Chỉ chuyển tiền khi trang này hiển thị VietQR.',paid:'ShopMMO đã nhận tiền và sẽ xử lý đơn.',
  ordering:'ShopMMO đang nhập tài khoản. Trang tự cập nhật khi giao xong.',expired:'Mã chuyển khoản đã hết hạn. Hãy đặt đơn mới nếu bạn vẫn muốn mua.',
  review:'Đơn đang được đối soát. Hãy giữ lại mã giao dịch ngân hàng.',unavailable:'Hãy tải lại trang để kiểm tra trạng thái.'};
const requestHeaders={'Content-Type':'application/json','X-ShopMMO-Request':'storefront'};
const params=new URLSearchParams(location.search);
const highlighted=Number(params.get('don'));
const requestedPage=Number(params.get('trang')??0);
let page=Number.isInteger(requestedPage)&&requestedPage>=0&&requestedPage<100000?requestedPage:0;
let timer, requestNumber=0;
async function importLegacyOrders(){
  try{
    const raw=JSON.parse(localStorage.getItem('shopmmo-orders')||'[]');
    if(!Array.isArray(raw))return;
    const entries=raw.filter(item=>item&&typeof item.token==='string'&&/^[a-f0-9]{64}$/.test(item.token));
    const imported=new Set();
    for(let start=0;start<entries.length;start+=10){
      const response=await fetch('/api/orders/import',{method:'POST',headers:requestHeaders,
        body:JSON.stringify({tokens:entries.slice(start,start+10).map(item=>item.token)})});
      if(!response.ok)break;
      for(const token of (await response.json()).imported)imported.add(token);
    }
    const remaining=entries.filter(item=>!imported.has(item.token));
    if(remaining.length)localStorage.setItem('shopmmo-orders',JSON.stringify(remaining));
    else localStorage.removeItem('shopmmo-orders');
  }catch{}
}
function makeCard(order){
  const card=node('article',null,'panel order-card'+(order.code===highlighted?' highlight':''));
  const title=node('div');
  title.append(node('span','#'+order.code,'muted'),node('h2',order.name||'Đơn hàng'));
  const top=node('div',null,'order-top');
  const waiting=order.state==='awaiting_payment'?' waiting':'';
  top.append(title,node('span',labels[order.state]||'Đang cập nhật','order-state'+waiting));
  const row=[];
  if(order.quantity)row.push('Số lượng '+order.quantity);
  if(Number.isFinite(order.amount))row.push((order.state==='awaiting_payment'?'Tổng tham khảo ':'Tổng tiền ')+currency.format(order.amount));
  if(order.created)row.push(new Date(order.created).toLocaleString('vi-VN'));
  card.append(top);
  if(row.length)card.append(node('p',row.join(' · '),'order-meta'));
  if(notes[order.state])card.append(node('p',notes[order.state],'order-desc'+waiting));
  if(order.state==='awaiting_payment'){
    const check=node('button','Kiểm tra thanh toán','button secondary');
    check.type='button';
    const message=node('p',null,'status-msg');message.setAttribute('role','status');
    check.addEventListener('click',async()=>{
      check.disabled=true;
      try{
        const response=await fetch('/api/order/payment',{method:'POST',headers:requestHeaders,body:JSON.stringify({code:order.code})});
        const result=await response.json();
        if(!response.ok)throw Error(result.message);
        await render();
      }catch(error){message.textContent=error.message;check.disabled=false;}
    });
    const actions=node('div',null,'order-actions');actions.append(check);
    card.append(actions,message);
  }
  if(order.payment){
    const payment=order.payment;
    const section=node('section',null,'order-detail pay-qr');
    const qr=node('img');
    const url=new URL('https://img.vietqr.io/image/'+payment.bin+'-'+payment.account+'-compact2.png');
    url.search = new URLSearchParams({amount:order.amount,addInfo:payment.content,accountName:payment.holder});
    qr.alt='Mã VietQR của đơn hàng';qr.width=200;qr.height=250;qr.loading='lazy';qr.src=url.href;
    const info=node('div');
    info.append(node('h3','Thanh toán VietQR'),node('p','Tài khoản nhận '+payment.account),
      node('p','Chủ tài khoản '+payment.holder),node('p','Nội dung chuyển khoản '+payment.content),
      node('p','Hết hạn '+new Date(payment.expires).toLocaleString('vi-VN')));
    const copy=node('button','Sao chép nội dung','button secondary');copy.type='button';
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(payment.content);copy.textContent='Đã sao chép';}catch{}});
    info.append(copy);section.append(qr,info);card.append(section);
  }
  if(order.delivery){
    const section=node('section',null,'order-detail');
    section.append(node('h3','Tài khoản đã giao'),node('pre',order.delivery.join('\n')));
    card.append(section);
  }
  return card;
}
async function render(){
  clearTimeout(timer);
  const current=++requestNumber;
  let result;
  try {
    const response=await fetch('/api/orders?page='+page);
    if(!response.ok)throw Error();
    result=await response.json();
  }catch{
    if(current===requestNumber)root.replaceChildren(node('p','Chưa tải được đơn hàng. Hãy tải lại trang.','panel empty'));
    return;
  }
  if(current!==requestNumber)return;
  page=result.page;
  const orders=result.orders;
  root.replaceChildren(...(orders.length?orders.map(makeCard):[node('p','Chưa có đơn hàng trong phiên này.','panel empty')]));
  const total=Math.ceil(result.total/10);
  byId('order-pagination').hidden=total<=1;
  byId('page-number').textContent='Trang '+(page+1)+' / '+total;
  byId('newer').disabled=page===0;
  byId('older').disabled=page+1>=total;
  if(orders.some(item=>['pending','paid','ordering'].includes(item.state)))timer=setTimeout(render,8000);
}
function goPage(change){
  page+=change;
  const next=new URL(location.href);
  if(page>0)next.searchParams.set('trang',String(page));
  else next.searchParams.delete('trang');
  history.replaceState(null,'',next);
  void render();
}
byId('older').addEventListener('click',()=>goPage(1));
byId('newer').addEventListener('click',()=>goPage(-1));
void importLegacyOrders().then(render);
