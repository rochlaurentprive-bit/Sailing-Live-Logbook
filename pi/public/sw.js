const C='carnet-pi-2.6.1';
const TILE_HOSTS=['tile.openstreetmap.org','basemaps.cartocdn.com','server.arcgisonline.com','tiles.openseamap.org'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./pi-adapter.js','./manifest.webmanifest'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('carnet-pi-')&&k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(TILE_HOSTS.some(h=>u.hostname.endsWith(h))){
    e.respondWith(caches.open('tiles-v1').then(c=>fetch(e.request).then(r=>{c.put(e.request,r.clone());return r}).catch(()=>c.match(e.request))));
    return;
  }
  if(u.origin!==location.origin)return;
  // jamais de cache pour le serveur (Signal K, plugin, API) : seulement les fichiers de l'appli
  if(u.pathname.includes('/plugins/')||u.pathname.includes('/signalk/'))return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request)));
});
