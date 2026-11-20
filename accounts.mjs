import {createHash, randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive = promisify(scrypt);
const hash = token => createHash('sha256').update(token).digest('hex');
const duration = 30*24*60*60_000;
const passwordBytes = 64;
const tokenFormat = /^[a-f0-9]{64}$/;

export function createAccounts(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt BLOB NOT NULL, password_hash BLOB NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_session_expiry ON customer_sessions(expires);
  `);
  const byEmail=db.prepare('SELECT * FROM customers WHERE email=?');
  const loginSession=db.prepare('INSERT INTO customer_sessions VALUES(?,?,?)');
  const removeSession=db.prepare('DELETE FROM customer_sessions WHERE token_hash=?');
  const expired=db.prepare('DELETE FROM customer_sessions WHERE expires<=?');
  const findSession=db.prepare('SELECT customers.id,customers.email FROM customer_sessions JOIN customers ON customers.id=customer_sessions.customer_id WHERE customer_sessions.token_hash=? AND customer_sessions.expires>?');
  const attempts=new Map();
  let windowStart=0, requests=0, verifying=0;

  function get(token){
    return typeof token==='string'&&tokenFormat.test(token) ? findSession.get(hash(token),Date.now())??null : null;
  }
  function logout(token){
    if(typeof token==='string'&&tokenFormat.test(token)) removeSession.run(hash(token));
  }
  function open(user,now){
    const token=randomBytes(32).toString('hex');
    loginSession.run(hash(token),user.id,now+duration);
    return {token,user:{id:user.id,email:user.email}};
  }
  async function authenticate(action,body){
    const email=typeof body?.email==='string'?body.email.trim().toLowerCase():'';
    const password=body?.password;
    if(email.length>254||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||typeof password!=='string'||password.length<12||password.length>128){
      return [400,{message:'Nhập email hợp lệ và mật khẩu từ 12 đến 128 ký tự.'}];
    }
    const now=Date.now();
    if(now-windowStart>=60_000){windowStart=now;requests=0;attempts.clear();expired.run(now);}
    const current=attempts.get(email)??0;
    if(requests>=120||current>=8||verifying>=4) return [429,{message:'Đã thử nhiều lần. Vui lòng đợi một phút.'}];
    requests++;attempts.set(email,current+1);verifying++;
    try{
      const existing=byEmail.get(email);
      const salt=existing?.salt??randomBytes(16);
      const key=await derive(password,salt,passwordBytes,{N:32768,r:8,p:3,maxmem:64*1024*1024});
      if(action==='login'){
        const expected=Buffer.from(existing?.password_hash??Buffer.alloc(passwordBytes));
        if(!timingSafeEqual(key,expected)||!existing) return [401,{message:'Email hoặc mật khẩu chưa đúng.'}];
        return [200,open(existing,now)];
      }
      if(existing) return [409,{message:'Email này đã có tài khoản. Hãy đăng nhập.'}];
      const inserted=db.prepare('INSERT INTO customers(email,salt,password_hash,created) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING')
        .run(email,salt,key,now);
      if(!inserted.changes) return [409,{message:'Email này đã có tài khoản. Hãy đăng nhập.'}];
      return [201,open({id:Number(inserted.lastInsertRowid),email},now)];
    }finally{verifying--;}
  }
  return {get,logout,authenticate};
}
