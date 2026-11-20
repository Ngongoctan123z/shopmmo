const menu = document.querySelector('#product');
const search = document.querySelector('#search');
const grid = document.querySelector('#grid');
const count = document.querySelector('#count');
const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND'});
const fold = value => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d');
const slug = value => fold(value).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const node = (tag,text,className) => Object.assign(document.createElement(tag),{textContent:text??'',className:className??''});
let products = [];
const labels = {CapCut:['CC','capcut'],Canva:['CV','canva'],Meitu:['MT','meitu'],Hypic:['HY','hypic'],Wink:['WK','wink']};
const brandOrder = Object.keys(labels);
const position = brand => brandOrder.includes(brand)?brandOrder.indexOf(brand):brandOrder.length;
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
  for(const [brand,items] of [...groups].sort((a,b)=>position(a[0])-position(b[0]))){
    const card=node('article',null,'panel catalog-card');
    const heading=node('div',null,'card-heading');
    const [mark,tone]=labels[brand]??[brand.slice(0,2).toUpperCase(),'other'];
    const monogram=node('span',mark,'app-mark mark-'+tone);monogram.setAttribute('aria-hidden','true');
    const summary=node('div',null,'card-app');
    const title=node('h3');
    const link=node('a',brand);link.href='/products/'+slug(brand);title.append(link);
    summary.append(title,node('p',items.length+' gói có sẵn','muted'));
    const figures=items.map(item=>item.price??item.referencePrice).filter(Number.isFinite);
    const minimum=figures.length?Math.min(...figures):null;
    const ready=items.some(item=>item.price===minimum);
    const price=node('div',null,'catalog-price');
    if(minimum!==null&&!ready)price.append(node('small','Giá tham khảo'));
    price.append(node('strong',minimum===null?'Chưa có giá':(items.length>1?'Từ ':'')+currency.format(minimum)));
    const open=node('a','Chọn gói','button secondary');open.href=link.href;open.setAttribute('aria-label','Chọn gói '+brand);
    heading.append(monogram,summary);
    const bottom=node('div',null,'card-bottom');bottom.append(price,open);
    card.append(heading,bottom);grid.append(card);
  }
  if(!groups.size){
    const message=menu.value==='FPT Play'?'Gói FPT Play hiện cần kích hoạt thủ công. ShopMMO chưa mở bán gói này.':'Không tìm thấy gói phù hợp.';
    grid.append(node('p',message,'empty'));
  }
}
function updateFilters(){
  const next=new URL(location.href);
  for(const [key,value] of [['q',search.value.trim()],['san-pham',menu.value]]){
    if(value)next.searchParams.set(key,value);else next.searchParams.delete(key);
  }
  history.replaceState(null,'',next);
  render();
}
search.addEventListener('input',updateFilters);
menu.addEventListener('change',updateFilters);
fetch('/api/catalog').then(response=>{
  if(!response.ok) throw Error();
  return response.json();
}).then(data=>{
  products=data.products;
  const brands=new Set(products.map(item=>item.brand));
  brands.add('FPT Play');
  for(const brand of brands) menu.add(new Option(brand,brand));
  const params=new URLSearchParams(location.search);
  const requested=params.get('san-pham');
  search.value=params.get('q')??'';
  if(brands.has(requested))menu.value=requested;
  render();
}).catch(()=>{grid.replaceChildren(node('p','Chưa tải được danh mục. Hãy tải lại trang.','empty'));});
