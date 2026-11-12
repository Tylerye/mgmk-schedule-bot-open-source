import { readFile } from 'node:fs/promises';
import { credentialOrigin } from '../src/credential-origin.js';
import { TEACHERS } from '../src/teachers.js';
const filename=process.argv[2];
if(!filename)throw new Error('Pass an explicit deployment config path');
const config=JSON.parse(await readFile(filename,'utf8'));
const vars=config.vars??{};
const positive=value=>typeof value==='string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
if(!positive(vars.ADMIN_USER_ID))throw new Error('Configure a valid owner numeric ID');
if(vars.CURATOR_USER_ID && !positive(vars.CURATOR_USER_ID))throw new Error('Invalid curator configuration');
if(vars.OWNER_PREVIEW_ENABLED!==undefined && !['false','true'].includes(vars.OWNER_PREVIEW_ENABLED))throw new Error('Invalid preview flag');
const bindings=JSON.parse(vars.TEACHER_USER_IDS||'{}');
if(!bindings || typeof bindings!=='object' || Array.isArray(bindings))throw new Error('Invalid teacher binding map');
const ids=Object.values(bindings).map(String);
if(Object.keys(bindings).some(id=>!TEACHERS.some(t=>t.id===id)) || ids.some(id=>!positive(id)) || new Set(ids).size!==ids.length)throw new Error('Invalid or conflicting teacher numeric bindings');
if(config.main==='cloudflare/worker.js'){
 const origin=credentialOrigin(vars.WORKER_PUBLIC_ORIGIN);
 if(new URL(origin).hostname.split('.')[0]!==config.name)throw new Error('Configured origin does not match Worker name');
 for(const name of ['INTERACTIVE_BURST','INTERACTIVE_USER','INTERACTIVE_TOTAL'])if(!config.ratelimits?.some(r=>r.name===name))throw new Error('Missing ingress limiter');
}
if(config.main==='personal/worker.js' && (config.workers_dev!==false || config.preview_urls!==false))throw new Error('Personal worker must have no public or preview URLs');
if(!config.d1_databases?.length || config.d1_databases.some(d=>!d.database_id || d.database_id==='00000000-0000-0000-0000-000000000000'))throw new Error('Configure an explicit database binding');
console.log('Deployment configuration validated; private values omitted.');
