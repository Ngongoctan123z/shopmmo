const byId=id=>document.getElementById(id);
const root=byId('orders');
const node=(tag,text,className)=>Object.assign(document.createElement(tag),{textContent:text??'',className:className??''});
const currency=new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const labels={awaiting_payment:'Chờ mở thanh toán',pending:'Chờ chuyển khoản',paid:'Đã thanh toán',ordering:'Đang giao tài khoản',
  delivered:'Đã giao tài khoản',expired:'Hết hạn thanh toán',review:'Đang đối soát',unavailable:'Chưa tải được'};
const notes={awaiting_payment:'Đơn đã được lưu. Chỉ chuyển tiền khi trang này hiển thị VietQR.',paid:'ShopMMO đã nhận tiền và sẽ xử lý đơn.',
  ordering:'ShopMMO đang nhập tài khoản. Trang tự cập nhật khi giao xong.',expired:'Mã chuyển khoản đã hết hạn. Hãy đặt đơn mới nếu bạn vẫn muốn mua.',
  review:'Đơn đang được đối soát. Hãy giữ lại mã giao dịch ngân hàng.',unavailable:'Hãy tải lại trang để kiểm tra trạng thái.'};
let saved=[];
try{
  const list=JSON.parse(localStorage.getItem('shopmmo-orders')||'[]');
  if(Array.isArray(list))saved=list.filter(item=>item&&/^[a-f0-9]{64}$/.test(item.token));
}catch{}
const pageSize=10;
let page=0, timer, requestNumber=0;
function makeCard(order,entry){
  const card=node('article',null,'panel order-card');
  const title=node('div');
  title.append(node('span','#'+entry.code,'muted'),node('h2',order.name||'Đơn hàng'));
  const top=node('div',null,'order-top');
  top.append(title,node('span',labels[order.state]||'Đang cập nhật','order-state'));
  const row=[];
  if(order.quantity)row.push('Số lượng '+order.quantity);
  if(Number.isFinite(order.amount))row.push((order.state==='awaiting_payment'?'Tổng tham khảo ':'Tổng tiền ')+currency.format(order.amount));
  if(order.created)row.push(new Date(order.created).toLocaleString('vi-VN'));
  card.append(top);
  if(row.length)card.append(node('p',row.join(' · '),'order-meta'));
  if(notes[order.state])card.append(node('p',notes[order.state],'order-desc'));
  if(order.state==='awaiting_payment'){
    const check=node('button','Kiểm tra thanh toán','button secondary');
    check.type='button';
    const message=node('p',null,'status-msg');message.setAttribute('role','status');
    check.addEventListener('click',async()=>{
      check.disabled=true;
      try{
        const response=await fetch('/api/order/payment',{method:'POST',headers:{Authorization:'Bearer '+entry.token}});
        const result=await response.json();
        if(!response.ok)throw Error(result.message);
        await render();
      }catch(error){message.textContent=error.message;check.disabled=false;}
    });
    card.append(check,message);
  }
  if(order.payment){
    const payment=order.payment;
    const section=node('section',null,'order-detail pay-qr');
    const qr=node('img');
    const url=new URL('https://img.vietqr.io/image/'+payment.bin+'-'+payment.account+'-compact2.png');
    url.search = new URLSearchParams({amount:order.amount,addInfo:payment.content,accountName:payment.holder});
    qr.alt='Mã VietQR của đơn hàng';qr.src=url.href;
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
  if(!saved.length){root.replaceChildren(node('p','Chưa có đơn hàng trên trình duyệt này.','panel empty'));return;}
  const entries=saved.slice(page*pageSize,(page+1)*pageSize);
  let orders;
  try {
    const response=await fetch('/api/orders/lookup',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tokens:entries.map(item=>item.token)})});
    if(!response.ok)throw Error();
    orders=(await response.json()).orders;
  }catch{orders=[];}
  if(current!==requestNumber)return;
  root.replaceChildren(...entries.map((entry,index)=>makeCard(orders[index]??{state:'unavailable'},entry)));
  const total=Math.ceil(saved.length/pageSize);
  byId('order-pagination').hidden=total<=1;
  byId('page-number').textContent='Trang '+(page+1)+' / '+total;
  byId('newer').disabled=page===0;
  byId('older').disabled=page+1>=total;
  if(orders.some(item=>item&&['pending','paid','ordering'].includes(item.state)))timer=setTimeout(render,8000);
}
byId('older').addEventListener('click',()=>{page++;void render();});
byId('newer').addEventListener('click',()=>{page--;void render();});
void render();
