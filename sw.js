/* hashem-bone site: service worker. Serves the app from the encrypted files in e/, decrypting with the key
   kept on this device (IndexedDB "hb", put there by the code page). Keeps the app page, the list and the
   libraries for use with no network. */
const SHELL='hb-shell-1', LIBS='hb-libs-1', DATA='hb-data-1';
const BASE=new URL('./',self.location).href;            // .../hashem-bone/
const APP=BASE+'app/';
let KEY=null, MAN=null, MANAT=0;

self.addEventListener('install',e=>{ e.waitUntil(caches.open(SHELL).then(c=>c.addAll(['./','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png']).catch(()=>{}))); self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil(self.clients.claim()); });
self.addEventListener('message',e=>{ if(e.data==='key-changed'){ KEY=null; MAN=null; } });

function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open('hb',1); r.onupgradeneeded=()=>r.result.createObjectStore('k'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function getKey(){
  if(KEY) return KEY;
  try{ const d=await idb(); const v=await new Promise(r=>{ const q=d.transaction('k').objectStore('k').get('key'); q.onsuccess=()=>r(q.result||null); q.onerror=()=>r(null); });
    if(!v) return null;
    KEY=(v instanceof CryptoKey)?v:await crypto.subtle.importKey('raw',v,'AES-GCM',false,['decrypt']);
  }catch(e){ KEY=null; }
  return KEY;
}
async function dec(buf){ const k=await getKey(); if(!k) throw new Error('nokey'); const u=new Uint8Array(buf); return crypto.subtle.decrypt({name:'AES-GCM',iv:u.slice(0,12)},k,u.slice(12)); }

/* encrypted file: from the network, else from the cache when kept */
async function getEnc(name,keep){
  const url=BASE+'e/'+name;
  if(keep){ const c=await caches.open(SHELL); const hit=await c.match(url); if(hit) return hit.arrayBuffer();
    const r=await fetch(url); if(!r.ok) throw new Error('http '+r.status); await c.put(url,r.clone()); return r.arrayBuffer(); }
  const c=await caches.open(DATA); const hit=await c.match(url); if(hit) return hit.arrayBuffer();
  const r=await fetch(url); if(!r.ok) throw new Error('http '+r.status);
  try{ await c.put(url,r.clone()); }catch(e){}
  return r.arrayBuffer();
}
/* the list of files: fresh from the network (4 s), else the last one kept */
async function manifest(){
  if(MAN && Date.now()-MANAT<60000) return MAN;
  const url=BASE+'e/m.bin', c=await caches.open(SHELL);
  let buf=null;
  try{ const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),4000);
    const r=await fetch(url,{cache:'no-cache',signal:ctl.signal}); clearTimeout(t);
    if(r.ok){ buf=await r.clone().arrayBuffer(); await c.put(url,r); } }catch(e){}
  if(!buf){ const hit=await c.match(url); if(hit) buf=await hit.arrayBuffer(); }
  if(!buf) throw new Error('nomanifest');
  MAN=JSON.parse(new TextDecoder().decode(await dec(buf))); MANAT=Date.now();
  if(MAN.idx) cleanShell(MAN.idx,MAN);
  return MAN;
}
let cleaned='';
async function cleanShell(keepName,m){ if(cleaned===keepName) return; cleaned=keepName; const c=await caches.open(SHELL);
  for(const req of await c.keys()){ const u=req.url; if(u.startsWith(BASE+'e/') && !u.endsWith('/m.bin') && !u.endsWith('/'+keepName)) await c.delete(req); }
  /* files of older versions are dropped */
  const live=new Set(Object.values(m.files).map(f=>BASE+'e/'+f[0])); const d=await caches.open(DATA);
  for(const req of await d.keys()){ if(!live.has(req.url)) await d.delete(req); } }

function toLogin(){ return Response.redirect(BASE+'?r=1',302); }

async function blobResp(id){
  try{ const d=await new Promise((res,rej)=>{ const r=indexedDB.open('hbdb',1); r.onupgradeneeded=()=>{ const x=r.result; if(!x.objectStoreNames.contains('docs')) x.createObjectStore('docs'); if(!x.objectStoreNames.contains('assets')) x.createObjectStore('assets'); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
    const v=await new Promise(r=>{ const q=d.transaction('assets').objectStore('assets').get(id); q.onsuccess=()=>r(q.result||null); q.onerror=()=>r(null); });
    if(!v) return new Response('',{status:404});
    return new Response(v.blob,{headers:{'Content-Type':v.type||v.blob.type||'application/octet-stream'}});
  }catch(e){ return new Response('',{status:404}); }
}

async function appFile(rel,isNav){
  if(!(await getKey())) return isNav?toLogin():new Response('',{status:401});
  let m; try{ m=await manifest(); }catch(e){ return isNav?toLogin():new Response('',{status:503}); }
  if(rel===''||rel==='index.html'){
    try{ const b=await dec(await getEnc(m.idx,true));
      return new Response(b,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}); }
    catch(e){ return isNav?toLogin():new Response('',{status:503}); }
  }
  if(rel.startsWith('_blob/')) return blobResp(decodeURIComponent(rel.slice(6)));
  const f=m.files[rel];
  if(!f) return new Response('',{status:404});
  try{ const b=await dec(await getEnc(f[0],false)); return new Response(b,{headers:{'Content-Type':f[1]}}); }
  catch(e){ return new Response('',{status:504,statusText:'offline'}); }
}

const LIBHOSTS=['cdnjs.cloudflare.com','cdn.jsdelivr.net','fonts.googleapis.com','fonts.gstatic.com','unpkg.com'];
async function lib(req){
  const c=await caches.open(LIBS); const hit=await c.match(req);
  if(hit) return hit;
  const r=await fetch(req); try{ if(r.ok||r.type==='opaque') await c.put(req,r.clone()); }catch(e){} return r;
}

self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET') return;
  const u=new URL(req.url);
  if(u.href.startsWith(APP)){ const rel=decodeURIComponent(u.pathname.slice(new URL(APP).pathname.length)); e.respondWith(appFile(rel,req.mode==='navigate')); return; }
  if(u.href===BASE+'app'){ e.respondWith(Response.redirect(APP,302)); return; }
  if(LIBHOSTS.includes(u.hostname)){ e.respondWith(lib(req)); return; }
  if(u.href.startsWith(BASE) && !u.href.startsWith(BASE+'e/')){
    e.respondWith(fetch(req).then(r=>{ if(r.ok){ const cl=r.clone(); caches.open(SHELL).then(c=>c.put(req,cl)); } return r; }).catch(()=>caches.open(SHELL).then(c=>c.match(req,{ignoreSearch:true})).then(r=>r||new Response('',{status:504}))));
  }
});
