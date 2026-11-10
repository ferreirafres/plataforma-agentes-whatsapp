'use strict';
// Only the offline explanation is cached. Account data and authenticated pages
// always go to the server, and are never available through an offline cache.
const CACHE='agentes-offline-v2';
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/static/offline.html','/static/offline.css'])).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('agentes-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  if(new URL(event.request.url).origin===self.location.origin && new URL(event.request.url).pathname==='/static/offline.css'){
    event.respondWith(caches.match('/static/offline.css').then(cached=>cached||fetch(event.request)));return;
  }
  if(event.request.method!=='GET'||event.request.mode!=='navigate')return;
  event.respondWith(fetch(event.request).catch(()=>caches.match('/static/offline.html')));
});
