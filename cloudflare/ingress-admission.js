const caches=new WeakMap();
function positive(v,fallback){if(v===undefined)return fallback;const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid ingress limit');return n;}
export async function admitInteractive(env,id,now=Date.now()){
 let cache=caches.get(env.DB);if(!cache){cache=new Map();caches.set(env.DB,cache);}
 const cached=cache.get(String(id));if(cached>now)return false;
 for(const binding of ['INTERACTIVE_BURST','INTERACTIVE_USER','INTERACTIVE_TOTAL'])if(env[binding] && !(await env[binding].limit({key:String(env.WORKER_PUBLIC_ORIGIN??'instance')+':'+(binding==='INTERACTIVE_TOTAL'?'all':String(id))})).success)return false;
 const rules=[['all',60,positive(env.INTERACTIVE_TOTAL_LIMIT,120)],[String(id),60,positive(env.INTERACTIVE_USER_LIMIT,30)],[String(id),10,positive(env.INTERACTIVE_BURST_LIMIT,10)]];
 for(const [subject,period,limit]of rules){const slot=Math.floor(now/(period*1000));const r=await env.DB.prepare("INSERT INTO runtime_locks(name,owner,locked_until) SELECT ?, '1', ? WHERE (SELECT COUNT(*) FROM runtime_locks)<100000 ON CONFLICT(name) DO UPDATE SET owner=CASE WHEN runtime_locks.locked_until=excluded.locked_until THEN CAST(CAST(runtime_locks.owner AS INTEGER)+1 AS TEXT) ELSE '1' END,locked_until=excluded.locked_until WHERE runtime_locks.locked_until<excluded.locked_until OR (runtime_locks.locked_until=excluded.locked_until AND CAST(runtime_locks.owner AS INTEGER)<?)").bind('ingress:'+subject+':'+period,slot,limit).run();
 if(r.meta?.changes!==1){if(cache.size>=4096)cache.delete(cache.keys().next().value);cache.set(String(id),(slot+1)*period*1000);return false;}}
 return true;
}
