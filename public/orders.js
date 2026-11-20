const root = document.querySelector('#orders');
const show = (tag,text) => Object.assign(document.createElement(tag),{textContent:text??''});
const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const labels = {pending:'Chờ chuyển khoản',paid:'Đã thanh toán',ordering:'Đang giao tài khoản',delivered:'Đã giao tài khoản',
  expired:'Đã hết thời hạn thanh toán',review:'Đang đối soát thủ công'};
let saved = [];
try { saved = JSON.parse(localStorage.getItem('shopmmo-orders')||'[]'); } catch {}
async function render() {
  if(!Array.isArray(saved) || !saved.length){ root.textContent='Chưa có đơn hàng trên trình duyệt này.'; return; }
  const results = await Promise.all(saved.map(async item=>{
    try {
      const response=await fetch('/api/order',{headers:{Authorization:'Bearer '+item.token}});
      if(!response.ok) throw Error();
      return await response.json();
    }catch{return {code:item.code,state:'unavailable'};}
  }));
  root.replaceChildren(...results.map(order=>{
    const card=show('article');
    card.append(show('h2',order.name || 'Đơn '+order.code),
      show('p',[('#'+order.code),labels[order.state]||'Chưa tải được trạng thái',order.amount&&currency.format(order.amount)].filter(Boolean).join(' · ')));
    if(order.payment){
      const payment=order.payment;
      const section=show('section');
      const qr=show('img');
      const url=new URL('https://img.vietqr.io/image/'+payment.bin+'-'+payment.account+'-compact2.png');
      url.search=new URLSearchParams({amount:order.amount,addInfo:payment.content,accountName:payment.holder});
      qr.alt='Mã VietQR của đơn hàng';qr.src=url.href;
      const info=show('div');
      info.append(show('p','Tài khoản nhận '+payment.account),show('p','Chủ tài khoản '+payment.holder),
        show('p','Nội dung chuyển khoản '+payment.content),show('p','Hết hạn '+new Date(payment.expires).toLocaleString('vi-VN')));
      const copy=show('button','Sao chép nội dung');
      copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(payment.content);copy.textContent='Đã sao chép';}catch{}});
      info.append(copy);section.append(qr,info);card.append(section);
    }
    if(order.delivery) card.append(show('pre',order.delivery.join('\n')));
    return card;
  }));
  if(results.some(item=>['pending','paid','ordering','unavailable'].includes(item.state))) setTimeout(render,6000);
}
void render();

