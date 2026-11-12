const time=v=>typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
function bounded(v,depth=0){if(depth>12)return false;if(typeof v==='string')return v.length<=3000;if(typeof v==='number')return Number.isFinite(v);if(v===null||typeof v==='boolean'||v===undefined)return true;if(Array.isArray(v))return v.length<=128&&v.every(x=>bounded(x,depth+1));return typeof v==='object'&&Object.keys(v).length<=64&&Object.entries(v).every(([k,x])=>!['__proto__','constructor','prototype'].includes(k)&&bounded(x,depth+1));}
export function validGroupResult(s){
 if(!s||!bounded(s)||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)||!/^ [a-f0-9]{64}$/.test(' '+s.hash)||!Array.isArray(s.lessons)||s.lessons.length>64)return false;
 if(s.lessons.some(l=>!Number.isInteger(l.number)||l.number<1||l.number>24))return false;
 if(s.timeline!==undefined&&(!Array.isArray(s.timeline)||s.timeline.some(e=>!time(e.start)||!time(e.end)||e.start>=e.end)))return false;
 return true;
}
