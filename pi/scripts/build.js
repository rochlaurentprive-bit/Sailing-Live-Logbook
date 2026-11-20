#!/usr/bin/env node
/* Construit la version Raspberry Pi à partir de l'appli commune (../www) SANS la modifier :
   - index.html : même fichier + une balise pour l'adaptateur Pi ;
   - sw.js propre au Pi (ne met jamais en cache les appels au serveur) ;
   - manifest et icône. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), out = path.join(__dirname, '..', 'public');
const rootVer = require(path.join(root, 'package.json')).version;      // « 2.0 » (x.y) : même numéro que l'APK
const ver = rootVer.split('.').length < 3 ? rootVer + '.0' : rootVer;   // semver exigé par npm
const pj = path.join(__dirname, '..', 'package.json'), pk = JSON.parse(fs.readFileSync(pj, 'utf8'));
if (pk.version !== ver) { pk.version = ver; fs.writeFileSync(pj, JSON.stringify(pk, null, 2) + '\n'); }
let html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
const tag = '<script src="pi-adapter.js"></script>';
if (html.includes(tag)) throw new Error('déjà injecté');
const i = html.indexOf('<script');
if (i < 0) throw new Error('aucune balise <script> dans index.html');
html = html.slice(0, i) + tag + '\n' + html.slice(i);
for (const probe of ['window.PIBOX&&PIBOX.has(s)', 'window.PIBOX){/* version Raspberry Pi']) {
  if (!html.includes(probe)) throw new Error('crochet Pi absent de l\'appli commune : ' + probe);
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'www', 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
fs.copyFileSync(path.join(root, 'icone-512.png'), path.join(out, 'icon.png'));
fs.copyFileSync(path.join(root, 'icone-512.png'), path.join(out, 'icon-512.png'));
fs.writeFileSync(path.join(out, 'sw.js'), `const C='carnet-pi-${ver}';
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
`);
console.log('build Pi OK : ' + out + ' (' + Math.round(html.length / 1024) + ' Ko)');
