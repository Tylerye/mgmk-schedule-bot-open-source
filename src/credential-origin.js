export function credentialOrigin(value) {
 let url; try { url = new URL(value); } catch { throw new Error('Invalid credential origin'); }
 const host=url.hostname.toLowerCase();
 if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash || url.port
   || !host.includes('.') || host.endsWith('.') || host.includes(':') || /^[\d.]+$/.test(host)
   || /(^|\.)(localhost|local|example|invalid|test)(\.|$)/.test(host)
   || /replace|your[-_]/i.test(host)) throw new Error('Unsafe credential origin');
 return url.origin;
}
