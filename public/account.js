const byId=id=>document.getElementById(id);
const feedback=byId('account-status');
const password=byId('password');
let registering=false;
function toggleMode(){
  byId('auth-title').textContent=registering?'Tạo tài khoản':'Đăng nhập';
  byId('auth-submit').textContent=registering?'Tạo tài khoản':'Đăng nhập';
  byId('login-mode').setAttribute('aria-pressed',String(!registering));
  byId('register-mode').setAttribute('aria-pressed',String(registering));
  byId('password-hint').hidden=!registering;
  password.autocomplete=registering?'new-password':'current-password';
}
function show(user){
  byId('account-load').hidden=true;
  byId('auth-panel').hidden=Boolean(user);
  byId('profile-panel').hidden=!user;
  byId('profile-email').textContent=user?.email??'';
}
async function action(path,data){
  const response=await fetch('/api/account/'+path,{method:'POST',
    headers:{'Content-Type':'application/json','X-ShopMMO-Request':'storefront'},body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok)throw Error(result.message);
  return result.user;
}
for(const mode of ['login','register']){
  byId(mode+'-mode').addEventListener('click',()=>{
    registering=mode==='register';feedback.textContent='';password.value='';toggleMode();
  });
}
byId('auth-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=byId('auth-submit'), modes=[byId('login-mode'),byId('register-mode')];
  button.disabled=true;for(const control of modes)control.disabled=true;feedback.textContent='';
  try{
    const user=await action(registering?'register':'login',{email:byId('email').value,password:password.value});
    byId('auth-form').reset();
    show(user);
  }catch(error){feedback.textContent=error.message;}
  finally{button.disabled=false;for(const control of modes)control.disabled=false;}
});
byId('logout').addEventListener('click',async()=>{
  const button=byId('logout');button.disabled=true;feedback.textContent='';
  try{await action('logout',{});show(null);}
  catch(error){feedback.textContent=error.message;}
  finally{button.disabled=false;}
});
fetch('/api/account').then(response=>{
  if(!response.ok)throw Error();
  return response.json();
}).then(result=>show(result.user)).catch(()=>{
  byId('account-load').textContent='Chưa kiểm tra được phiên đăng nhập. Hãy tải lại trang.';
});
