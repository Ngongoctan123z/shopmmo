const menu = document.querySelector('#product');
const search = document.querySelector('#search');
const grid = document.querySelector('#grid');
const count = document.querySelector('#count');
const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const fold = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d');
const slug = value => fold(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const node = (tag,text,className) => Object.assign(document.createElement(tag),{textContent:text??'',className:className??''});
let products = [];
function render(){
  const query = fold(search.value.trim());
  const groups = new Map();
  for(const item of products){
    if((menu.value && item.brand!==menu.value)||!fold([item.name,item.plan,item.brand].join(' ')).includes(query)) continue;
    if(!groups.has(item.brand)) groups.set(item.brand,[]);
    groups.get(item.brand).push(item);
  }
  count.textContent=groups.size+' sản phẩm';
  grid.replaceChildren();
  for(const [brand,items] of groups){
    const row=node('article',null,'catalog-row');
    const summary=node('div');
    const title=node('h3');
    const link=node('a',brand);link.href='/products/'+slug(brand);title.append(link);
    summary.append(title,node('p',items.length+' gói có sẵn','muted'));
    const figures=items.map(item=>item.price??item.referencePrice).filter(Number.isFinite);
    const minimum=figures.length?Math.min(...figures):null;
    const ready=items.some(item=>item.price===minimum);
    const price=node('p',minimum===null?'Chưa có giá':(!ready?'Tham khảo ':items.length>1?'Từ ':'')+currency.format(minimum),'catalog-price');
    const open=node('a','Chọn gói','button secondary');open.href=link.href;open.setAttribute('aria-label','Chọn gói '+brand);
    row.append(summary,price,open);grid.append(row);
  }
  if(!groups.size){
    const message=menu.value==='FPT Play'?'Gói FPT Play hiện cần kích hoạt thủ công. ShopMMO chưa mở bán gói này.':'Không tìm thấy gói phù hợp.';
    grid.append(node('p',message,'empty'));
  }
}
search.addEventListener('input',render);
menu.addEventListener('change',render);
fetch('/api/catalog').then(response=>{
  if(!response.ok) throw Error();
  return response.json();
}).then(data=>{
  products=data.products;
  const brands=new Set(products.map(item=>item.brand));
  brands.add('FPT Play');
  for(const brand of brands) menu.add(new Option(brand,brand));
  const requested=new URLSearchParams(location.search).get('san-pham');
  if(brands.has(requested))menu.value=requested;
  render();
}).catch(()=>{grid.replaceChildren(node('p','Chưa tải được danh mục. Hãy tải lại trang.','empty'));});
