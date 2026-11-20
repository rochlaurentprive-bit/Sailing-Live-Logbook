'use strict';
/* Test navigateur : (1) version Pi branchée sur le plugin, (2) non-régression de la version Android (sans Pi). */
const { chromium } = require('playwright'), assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path');
const { start } = require('./harness');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const CFG = { src: 'demo', demoSpeed: 20, lang: 'fr', boat: 'Test' };
const init = () => { localStorage.setItem('cfg', JSON.stringify(window.__CFG)); localStorage.setItem('ackResp', '1'); localStorage.setItem('piInit', '1'); };

(async () => {
  require('child_process').execSync('node scripts/build.js', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); await c.addInitScript('window.__CFG=' + JSON.stringify(CFG) + ';(' + init.toString() + ')()'); const p = await c.newPage(); p.on('pageerror', e => { console.log('  pageerror:', e.message); }); return p; };

  console.log('Version Raspberry Pi');
  const S = await start({ publicDir: path.join(__dirname, '..', 'public'), options: { interval: 2 } });
  const feed = setInterval(() => { S.delta('navigation.position', { latitude: 47.5, longitude: -3.1 }); S.delta('navigation.speedOverGround', 0.6); S.delta('navigation.courseOverGroundTrue', 1.2); }, 1000);
  const A = await mk(); await A.goto(S.url + '/signalk-carnet-de-bord/index.html'); await pause(1500);
  assert(await A.evaluate(() => !!window.PIBOX)); ok('l’appli détecte le plugin (mode Pi actif)');
  await A.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(2500);
  let ping = await (await fetch(S.url + '/plugins/carnet-de-bord/ping')).json(); assert(ping.open && ping.open.id); ok('« Démarrer un trajet » sur le téléphone : le Pi prend le relais');
  await pause(8000);
  const sum = await (await fetch(S.url + '/plugins/carnet-de-bord/trip/open')).json(); assert(sum.nPoints >= 3); ok('le Pi enregistre la trace (' + sum.nPoints + ' points) alors que l’appli ne le fait plus');
  const local = await A.evaluate(() => cur && cur.points.length); assert(local >= 1); ok('l’appli affiche la trace du Pi (' + local + ' points reçus)');
  await A.evaluate(async () => { await db.put('notes', { id: 'nt1', t: Date.now(), type: 'note', text: 'Note de test', trip: cur && cur.id }); }); await pause(800);
  await A.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(2500);
  ping = await (await fetch(S.url + '/plugins/carnet-de-bord/ping')).json(); assert(!ping.open); ok('« Terminer le trajet » : le Pi clôt et range le trajet');
  const trips = await (await fetch(S.url + '/plugins/carnet-de-bord/store/trips')).json(); assert(trips.length === 1 && trips[0].points.length >= 3 && trips[0].log.some(e => e.kind === 'end') && trips[0].log.filter(e => e.kind === 'start').length === 1); ok('trajet rangé sur le Pi (' + trips[0].points.length + ' points, 1 entrée « start », 1 entrée « end »)');
  const B = await mk(); await B.goto(S.url + '/signalk-carnet-de-bord/index.html'); await pause(1500);
  const seen = await B.evaluate(async () => ({ trips: (await db.all('trips')).length, notes: (await db.all('notes')).map(x => x.text) })); assert.deepStrictEqual(seen, { trips: 1, notes: ['Note de test'] }); ok('un second appareil voit le même journal et les mêmes notes');
  await B.evaluate(() => { localStorage.setItem('wp', JSON.stringify([{ lat: 47.1, lon: -3.2, n: 'WP1' }])); }); await pause(1500);
  const kv = await (await fetch(S.url + '/plugins/carnet-de-bord/kv')).json(); assert(kv.wp && kv.wp.includes('WP1')); ok('waypoints partagés envoyés au Pi');
  clearInterval(feed);
  const dir = S.dir; S.stop();

  console.log('Version Android (non-régression, sans Pi)');
  const srv = http.createServer((q, r) => { const f = path.join(__dirname, '..', '..', 'www', q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html' : 'text/plain'); r.end(fs.readFileSync(f)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const U = 'http://127.0.0.1:' + srv.address().port + '/';
  const C = await mk(); await C.goto(U); await pause(1500);
  assert(await C.evaluate(() => typeof window.PIBOX === 'undefined')); ok('aucun mode Pi : l’appli utilise le stockage du téléphone comme avant');
  await C.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(900);
  assert(await C.evaluate(() => !!cur && cur.open)); ok('démarrage d’un trajet : fonctionne');
  await pause(9000);
  const pts = await C.evaluate(() => cur.points.length); assert(pts >= 2); ok('l’appli enregistre elle-même la trace (' + pts + ' points)');
  await C.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(1200);
  const stored = await C.evaluate(async () => (await db.all('trips')).map(t => ({ open: t.open, p: t.points.length }))); assert(stored.length === 1 && stored[0].open === false && stored[0].p >= 2); ok('fin de trajet : rangé dans IndexedDB du téléphone');
  srv.close(); await browser.close();
  console.log('\n' + n + ' vérifications réussies');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
