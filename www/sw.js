const C='carnet-v18';
const TILE_HOSTS=['tile.openstreetmap.org','basemaps.cartocdn.com','server.arcgisonline.com','tiles.openseamap.org'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./manifest.webmanifest'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(TILE_HOSTS.some(h=>u.hostname.endsWith(h))){
    // fonds de carte : on garde en cache les tuiles déjà vues pour les revoir hors ligne
    e.respondWith(caches.open('tiles-v1').then(c=>fetch(e.request).then(r=>{c.put(e.request,r.clone());return r}).catch(()=>c.match(e.request))));
    return;
  }
  if(u.origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request)));
});
