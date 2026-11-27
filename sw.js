/* 25meltser site: service worker. Serves the app from the encrypted files in e/, decrypting with the key
   kept on this device (IndexedDB "hb", put there by the code page). Keeps the app page, the list, the data
   files already seen and the fonts for use with no network. */
const SHELL='hb-shell-1', LIBS='hb-libs-1', DATA='hb-data-1';
const BASE=new URL('./',self.location).href;            // .../<site>/
const APP=BASE+'app/';
const APPPATH=new URL(APP).pathname;
let KEY=null, MAN=null, MANAT=0, REFRESH=null, CUT=false, CUTW='x';

self.addEventListener('install',e=>{ e.waitUntil(caches.open(SHELL).then(c=>c.addAll(['./','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png']).catch(()=>{}))); self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil(self.clients.claim()); });
self.addEventListener('message',e=>{ if(e.data==='key-changed'){ KEY=null; MAN=null; CUT=false; } });

function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open('hb',1); r.onupgradeneeded=()=>r.result.createObjectStore('k'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function getKey(){
  if(KEY) return KEY;
  try{ const d=await idb(); const v=await new Promise(r=>{ const q=d.transaction('k').objectStore('k').get('key'); q.onsuccess=()=>r(q.result||null); q.onerror=()=>r(null); });
    if(!v) return null;
    KEY=(typeof CryptoKey!=='undefined' && v instanceof CryptoKey)?v:await crypto.subtle.importKey('raw',v,'AES-GCM',false,['decrypt']);
  }catch(e){ KEY=null; }
  return KEY;
}
/* cut off: this device forgets the key (its own reports and photos stay on it) */
async function getMe(){ try{ const d=await idb(); return await new Promise(r=>{ const q=d.transaction('k').objectStore('k').get('me'); q.onsuccess=()=>r(q.result||null); q.onerror=()=>r(null); }); }catch(e){ return null; } }
async function forget(w){ KEY=null; MAN=null; CUT=true; CUTW=w||'x';
  try{ const d=await idb(); await new Promise(r=>{ const t=d.transaction('k','readwrite'); t.objectStore('k').delete('key'); t.objectStore('k').delete('me'); t.oncomplete=r; t.onerror=r; t.onabort=r; }); }catch(e){}
  try{ await caches.delete(DATA); const c=await caches.open(SHELL); for(const q of await c.keys()) if(q.url.startsWith(BASE+'e/')) await c.delete(q); }catch(e){} }
/* with network, at each opening: is this person still allowed? */
async function checkAccess(){
  try{ const me=await getMe(); if(!me||!me.i) return;
    const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),4000);
    const r=await fetch(BASE+'e/k.json',{cache:'no-cache',signal:ctl.signal}); clearTimeout(t);
    if(!r.ok) return; const K=await r.json();
    if(K&&Array.isArray(K.ok)&&K.ok.length&&!K.ok.includes(me.i)) await forget('x');
  }catch(e){} }
async function dec(buf){ const k=await getKey(); if(!k) throw new Error('nokey'); const u=new Uint8Array(buf); return crypto.subtle.decrypt({name:'AES-GCM',iv:u.subarray(0,12)},k,u.subarray(12)); }

/* encrypted file: kept copy first (names change with the content, so a kept copy is never stale), else the network */
async function getEnc(name,store){
  const url=BASE+'e/'+name;
  const c=await caches.open(store); const hit=await c.match(url); if(hit) return hit.arrayBuffer();
  const r=await fetch(url); if(!r.ok) throw new Error('http '+r.status);
  try{ await c.put(url,r.clone()); }catch(e){}
  return r.arrayBuffer();
}

/* the list of files (m.bin) */
const MURL=BASE+'e/m.bin';
async function useMan(buf){ const m=JSON.parse(new TextDecoder().decode(await dec(buf))); MAN=m; MANAT=Date.now(); if(m.idx) clean(m); return m; }
function refresh(ms){
  if(REFRESH) return REFRESH;
  REFRESH=(async()=>{ try{ const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),ms||8000);
      const r=await fetch(MURL,{cache:'no-cache',signal:ctl.signal}); clearTimeout(t);
      if(r.ok){ const buf=await r.clone().arrayBuffer(); try{ await useMan(buf); }catch(e){ if(String(e&&e.message)!=='nokey' && await getKey()) await forget('n'); return false; } const c=await caches.open(SHELL); await c.put(MURL,r); return true; }
    }catch(e){} return false; })();
  REFRESH.then(()=>{ REFRESH=null; },()=>{ REFRESH=null; });
  return REFRESH;
}
/* fresh=true (opening the app): ask the network first, 4 s at most. Otherwise the kept list answers at once
   and the network is asked in the background, so a file never waits for it. */
async function manifest(fresh){
  if(fresh){ await refresh(4000); if(MAN) return MAN; }
  if(MAN){ if(Date.now()-MANAT>60000){ MANAT=Date.now(); refresh(); } return MAN; }
  const c=await caches.open(SHELL); const hit=await c.match(MURL);
  if(hit){ try{ await useMan(await hit.arrayBuffer()); refresh(); return MAN; }catch(e){} }
  await refresh(8000);
  if(!MAN) throw new Error('nomanifest');
  return MAN;
}
let cleaned='';
async function clean(m){ if(cleaned===m.idx) return; cleaned=m.idx;
  try{ const c=await caches.open(SHELL);
    for(const req of await c.keys()){ const u=req.url; if(u.startsWith(BASE+'e/') && u!==MURL && !u.endsWith('/'+m.idx)) await c.delete(req); }
    /* files of older versions are dropped */
    const live=new Set(Object.values(m.files).map(f=>BASE+'e/'+f[0])); const d=await caches.open(DATA);
    for(const req of await d.keys()){ if(!live.has(req.url)) await d.delete(req); } }catch(e){} }

function toLogin(w){ return Response.redirect(BASE+'?r=1'+(w?'&w='+w:''),302); }

async function blobResp(id){
  try{ const d=await new Promise((res,rej)=>{ const r=indexedDB.open('hbdb',1); r.onupgradeneeded=()=>{ const x=r.result; if(!x.objectStoreNames.contains('docs')) x.createObjectStore('docs'); if(!x.objectStoreNames.contains('assets')) x.createObjectStore('assets'); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
    const v=await new Promise(r=>{ const q=d.transaction('assets').objectStore('assets').get(id); q.onsuccess=()=>r(q.result||null); q.onerror=()=>r(null); });
    if(!v) return new Response('',{status:404});
    return new Response(v.blob,{headers:{'Content-Type':v.type||v.blob.type||'application/octet-stream'}});
  }catch(e){ return new Response('',{status:404}); }
}

async function appFile(rel,isNav){
  const page=(rel===''||rel==='index.html');
  if(page&&isNav){ CUT=false; await checkAccess(); }
  if(CUT||!(await getKey())) return isNav?toLogin(CUT?CUTW:'k'):new Response('',{status:401});
  let m; try{ m=await manifest(page); }catch(e){ return isNav?toLogin(CUT?CUTW:'m'):new Response('',{status:503}); }
  if(CUT) return isNav?toLogin(CUTW):new Response('',{status:401});
  if(page){
    try{ const b=await dec(await getEnc(m.idx,SHELL));
      return new Response(b,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}); }
    catch(e){ return isNav?toLogin('p'):new Response('',{status:503}); }
  }
  if(rel.startsWith('_blob/')) return blobResp(decodeURIComponent(rel.slice(6)));
  const f=m.files[rel];
  if(!f) return new Response('',{status:404});
  try{ const b=await dec(await getEnc(f[0],DATA)); return new Response(b,{headers:{'Content-Type':f[1],'Content-Length':String(b.byteLength)}}); }
  catch(e){ return new Response('',{status:504,statusText:'offline'}); }
}

/* fonts and any library still asked from a CDN: kept copy first; asked with CORS so the kept copy is a normal response */
const LIBHOSTS=['cdnjs.cloudflare.com','cdn.jsdelivr.net','fonts.googleapis.com','fonts.gstatic.com','unpkg.com'];
async function lib(req){
  const c=await caches.open(LIBS); const hit=await c.match(req.url);
  if(hit) return hit;
  try{ const r=await fetch(req.url,{mode:'cors',credentials:'omit'}); if(r.ok){ try{ await c.put(req.url,r.clone()); }catch(e){} return r; } }catch(e){}
  return fetch(req);
}

self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET') return;
  const u=new URL(req.url);
  if(u.href.startsWith(APP)){ const rel=decodeURIComponent(u.pathname.slice(APPPATH.length)); e.respondWith(appFile(rel,req.mode==='navigate')); return; }
  if(u.href===BASE+'app'){ e.respondWith(Response.redirect(APP,302)); return; }
  if(LIBHOSTS.includes(u.hostname)){ e.respondWith(lib(req)); return; }
  if(u.href.startsWith(BASE) && !u.href.startsWith(BASE+'e/')){
    e.respondWith(fetch(req).then(r=>{ if(r.ok){ const cl=r.clone(); caches.open(SHELL).then(c=>c.put(req,cl)); } return r; }).catch(()=>caches.open(SHELL).then(c=>c.match(req,{ignoreSearch:true})).then(r=>r||new Response('',{status:504}))));
  }
});
