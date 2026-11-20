const menu = document.querySelector('#product');
const search = document.querySelector('#search');
const grid = document.querySelector('#grid');
const count = document.querySelector('#count');
const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const fold = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d');
let products = [];
function render(){
  const query = fold(search.value.trim());
  const matches = products.filter(item => (!menu.value || item.brand === menu.value) &&
    fold([item.name,item.plan,item.brand].join(' ')).includes(query));
  count.textContent = matches.length + ' sản phẩm';
  grid.replaceChildren();
  for(const item of matches){
    const card = document.createElement('article');
    card.className = 'card';
    const title = document.createElement('h3');
    title.textContent = item.name;
    const state = document.createElement('span');
    state.className = 'stock';
    state.textContent = 'Có sẵn';
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = item.plan || item.brand;
    const bottom = document.createElement('div');
    bottom.className = 'card-bottom';
    const price = document.createElement('span');
    price.className = 'price';
    const amount = item.price ?? item.referencePrice;
    price.textContent = amount === null ? 'Chưa có giá' : (item.price === null ? 'Tham khảo ' : '') + currency.format(amount);
    const buy=document.createElement('button');
    buy.type='button';
    buy.className='primary';
    buy.textContent='Mua ngay';
    buy.setAttribute('aria-label','Mua ngay '+item.name+(item.plan?' '+item.plan:''));
    buy.disabled=amount===null;
    buy.addEventListener('click',async()=>{
      const status=document.querySelector('#purchase-status');
      buy.disabled=true;
      status.textContent='Đang tạo đơn ShopMMO…';
      try{
        const stored=JSON.parse(localStorage.getItem('shopmmo-orders')||'[]');
        const saved=Array.isArray(stored)?stored:[];
        const response=await fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({source:item.source,id:item.id,price:amount})});
        const data=await response.json();
        if(!response.ok) throw Error(data.message);
        localStorage.setItem('shopmmo-orders',JSON.stringify([{code:data.code,token:data.token},...saved].slice(0,30)));
        window.location.assign('/orders');
      }catch(error){status.textContent=error.message;buy.disabled=false;}
    });
    bottom.append(price,buy);
    card.append(state,title,desc,bottom);
    grid.append(card);
  }
  if(!matches.length){
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = menu.value==='FPT Play'
      ? 'Gói FPT Play hiện cần số điện thoại chính chủ và thời gian kích hoạt. ShopMMO chưa mở bán gói này.'
      : 'Hiện chưa có gói phù hợp đủ điều kiện giao ngay.';
    grid.append(empty);
  }
}
search.addEventListener('input',render);
menu.addEventListener('change',render);
fetch('/api/catalog').then(response=>{
  if(!response.ok) throw Error();
  return response.json();
}).then(data=>{
  products = data.products;
  const known = new Set(Array.from(menu.options, o=>o.value));
  for(const brand of new Set(products.map(item=>item.brand))) if(!known.has(brand)) menu.add(new Option(brand,brand));
  render();
}).catch(()=>{grid.textContent='Chưa tải được danh mục. Hãy thử tải lại trang.';});

