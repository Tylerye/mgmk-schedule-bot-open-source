import { credentialOrigin } from '../src/credential-origin.js';
const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
async function key(secret){if(typeof secret!=='string'||secret.length<32)throw new Error('Maintenance authentication is not configured');return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function canonical(origin,path,time,body){return enc.encode(['v1','POST',origin,path,time,hex(await crypto.subtle.digest('SHA-256',body))].join('\n'));}
export async function maintenanceHeaders(env,path,now=Date.now()){
 const origin=credentialOrigin(env.WORKER_PUBLIC_ORIGIN),time=String(now);
 const signature=await crypto.subtle.sign('HMAC',await key(env.MAINTENANCE_SIGNING_SECRET),await canonical(origin,path,time,new Uint8Array()));
 return {'x-maintenance-time':time,'x-maintenance-signature':hex(signature)};
}
export async function verifyMaintenance(request,env,now=Date.now()){
 try{const origin=credentialOrigin(env.WORKER_PUBLIC_ORIGIN),url=new URL(request.url),time=request.headers.get('x-maintenance-time'),sig=request.headers.get('x-maintenance-signature');
 if(request.method!=='POST'||url.origin!==origin||url.search||!/^\d{13}$/.test(time??'')||Math.abs(now-Number(time))>60000||!/^[a-f0-9]{64}$/.test(sig??'') )return false;
 if(request.body){const reader=request.body.getReader();let timer;try {const r=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('body timeout')),5000);})]);if(!r.done)return false;}finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}}
 return await crypto.subtle.verify('HMAC',await key(env.MAINTENANCE_SIGNING_SECRET),unhex(sig),await canonical(origin,url.pathname,time,new Uint8Array()));
 }catch{return false;}
}
