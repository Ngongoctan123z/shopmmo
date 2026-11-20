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
    state.textContent = 'Có ngay tại nguồn';
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = item.plan || item.brand;
    const bottom = document.createElement('div');
    bottom.className = 'card-bottom';
    const price = document.createElement('span');
    price.className = 'price';
    const amount = item.price ?? item.referencePrice;
    price.textContent = amount === null ? 'Xem giá tại nguồn' : (item.price === null ? 'Tham khảo ' : '') + currency.format(amount);
    const link = document.createElement('a');
    link.className = 'primary';
    link.textContent = 'Xem tại nguồn';
    link.href = item.url;
    bottom.append(price,link);
    card.append(state,title,desc,bottom);
    grid.append(card);
  }
  if(!matches.length){
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Hiện chưa có gói phù hợp đủ điều kiện giao ngay.';
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

