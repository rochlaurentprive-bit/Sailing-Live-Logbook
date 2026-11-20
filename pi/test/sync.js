'use strict';
/* Synchronisation appli seule (Android / PWA) ↔ Pi : dans les deux sens, hors connexion, suppressions, trajet ouvert. */
const { chromium } = require('playwright'), assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path');
const { start } = require('./harness');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const S = await start({ options: { enabled: false } }); const PI = S.url.replace('http://', ''), API = S.url + '/plugins/carnet-de-bord';
  const srv = http.createServer((q, r) => { const f = path.join(__dirname, '..', '..', 'www', q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain'); r.end(fs.readFileSync(f)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const U = 'http://127.0.0.1:' + srv.address().port + '/';
  const mk = async host => { const c = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' });
    await c.addInitScript(h => { if (!localStorage.getItem('cfg')) localStorage.setItem('cfg', JSON.stringify({ src: 'demo', lang: 'fr', boat: 'Tel', syncHost: h })); localStorage.setItem('ackResp', '1'); }, host);
    const p = await c.newPage(); p.on('pageerror', e => { console.error('pageerror', e.message); process.exitCode = 1; }); await p.goto(U); await pause(1200); return p; };
  const sync = p => p.evaluate(() => CarnetSync.run().then(r => JSON.parse(JSON.stringify(r))));
  const jget = async p => (await fetch(API + p)).json();

  console.log('Synchronisation téléphone ↔ Pi');
  const A = await mk(PI);
  await A.evaluate(async () => {
    await db.put('trips', { id: 't1', name: 'Sortie', open: false, start: 1000, end: 9000, points: [{ t: 1000, la: 47, lo: -3 }], log: [] });
    await db.put('trips', { id: 'tOpen', name: 'En cours', open: true, start: 5000, points: [], log: [] });
    await db.put('notes', { id: 'n1', t: 2000, text: 'Note maison' });
    localStorage.setItem('wp', JSON.stringify([{ lat: 47.1, lon: -3.2, n: 'Chez moi' }]));
  });
  let r = await sync(A); assert(r.ok, JSON.stringify(r)); assert(r.rep.push >= 3 && r.rep.skipped === 1);
  assert.deepStrictEqual((await jget('/store/trips')).map(t => t.id), ['t1']); assert((await jget('/store/notes'))[0].text === 'Note maison');
  assert(JSON.parse((await jget('/kv')).wp)[0].n === 'Chez moi'); ok('téléphone → Pi : trajet, note et route envoyés ; le trajet en cours reste sur le téléphone');

  const B = await mk(PI); r = await sync(B); assert(r.ok && r.rep.pull >= 2, JSON.stringify(r));
  const got = await B.evaluate(async () => ({ t: (await db.all('trips')).map(x => x.id), n: (await db.all('notes')).map(x => x.text), wp: JSON.parse(localStorage.getItem('wp'))[0].n }));
  assert.deepStrictEqual(got, { t: ['t1'], n: ['Note maison'], wp: 'Chez moi' }); ok('Pi → second téléphone : journal, notes et route reçus');

  await pause(30);
  await B.evaluate(() => { localStorage.setItem('plan', JSON.stringify({ from: 'A', to: 'B', prepared: 'maison' })); }); r = await sync(B); assert(r.ok);
  assert(JSON.parse((await jget('/kv')).plan).prepared === 'maison'); ok('route préparée à la maison : poussée dans le Pi');
  r = await sync(A); assert(r.ok && r.rep.kv >= 1, JSON.stringify(r)); assert(await A.evaluate(() => JSON.parse(localStorage.getItem('plan')).prepared) === 'maison'); ok('le premier téléphone reçoit la route le lendemain');

  await B.evaluate(async () => { const x = (await db.all('notes'))[0]; x.text = 'Note modifiée'; await db.put('notes', x); });
  r = await sync(B); assert(r.ok); r = await sync(A); assert(await A.evaluate(async () => (await db.all('notes'))[0].text) === 'Note modifiée'); ok('modification : la version la plus récente gagne');

  await A.evaluate(async () => { await db.del('notes', 'n1'); }); r = await sync(A); assert(r.ok && r.rep.del >= 1, JSON.stringify(r));
  assert((await jget('/store/notes')).length === 0); r = await sync(B); assert(await B.evaluate(async () => (await db.all('notes')).length) === 0); ok('suppression propagée au Pi puis à l’autre téléphone');

  await A.evaluate(async () => { await db.put('photos', { id: 'ph1', t: 5, blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' }) }); });
  r = await sync(A); assert(r.ok); r = await sync(B); assert(r.ok, JSON.stringify(r));
  assert(await B.evaluate(async () => { const p = (await db.all('photos'))[0]; return p && p.blob.size; }) === 5); ok('photos : envoyées au Pi et reçues avec leur image');

  const C = await mk('127.0.0.1:1'); await C.evaluate(async () => { await db.put('notes', { id: 'loc', t: 1, text: 'locale' }); });
  r = await sync(C); assert(!r.ok && r.err); assert(await C.evaluate(async () => (await db.all('notes')).length) === 1); ok('Pi injoignable : message clair, rien perdu, l’appli reste utilisable');

  S.stop(); srv.close(); await browser.close(); console.log('\n' + n + ' vérifications synchro réussies');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
