import { fork } from 'node:child_process';
export async function extractPdf(rawSource) {
 if(!rawSource?.bytes || rawSource.bytes.byteLength>20*1024*1024)throw new Error('PDF byte limit exceeded');
 return new Promise((resolve,reject)=>{
 const child=fork(new URL('./extract-child.js',import.meta.url),[],{env:{},execArgv:['--max-old-space-size=256'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
 let settled=false;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(result);};
 const timer=setTimeout(()=>finish(new Error('PDF extraction timed out')),60000);
 child.on('error',()=>finish(new Error('PDF extraction process failed')));
 child.on('exit',()=>finish(new Error('PDF extraction process stopped')));
 child.on('message',m=>m?.ok?finish(null,m.result):finish(new Error('PDF extraction rejected: '+String(m?.error??'invalid result').slice(0,160))));
 child.send({bytes:rawSource.bytes,source:rawSource.source},error=>{if(error)finish(new Error('PDF extraction transfer failed'));});
 });
}
