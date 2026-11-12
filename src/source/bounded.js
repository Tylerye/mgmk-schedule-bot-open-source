export async function boundedBytes(response, limit, timeoutMs = 30000) {
 const declared=response.headers?.get('content-length');
 if(declared && Number(declared)>limit) { await response.body?.cancel(); throw new Error('Source byte limit exceeded'); }
 if(!response.body) return new Uint8Array();
 const reader=response.body.getReader(),chunks=[];let length=0,done=false,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Source body timeout')),timeoutMs);});
 try { while(true){const r=await Promise.race([reader.read(),deadline]);if(r.done){done=true;break;}length+=r.value.byteLength;if(length>limit)throw new Error('Source byte limit exceeded');chunks.push(r.value);}
 const out=new Uint8Array(length);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.byteLength;}return out;
 } finally {clearTimeout(timer);if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function boundedText(response){return new TextDecoder().decode(await boundedBytes(response,2*1024*1024));}
