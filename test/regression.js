'use strict';
/* Non-régression de l'appli commune (Android / web) SANS Signal K ni Raspberry Pi, et fonctions « signal bateau », référence du vent, provenance. */
const { chromium } = require('playwright'), assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const WWW = path.join(__dirname, '..', 'www');
const init = () => { localStorage.setItem('cfg', JSON.stringify(window.__CFG)); localStorage.setItem('ackResp', '1'); localStorage.setItem('piInit', '1'); };
const FAKE_WS = `(()=>{class W{constructor(u){this.u=u;setTimeout(()=>{this.onopen&&this.onopen();const m=(u,v)=>this.onmessage&&this.onmessage({data:JSON.stringify({context:'vessels.self',updates:[Object.assign({values:v},u)]})});
 m({source:{label:'can0',src:'23'}},[{path:'environment.wind.speedApparent',value:6},{path:'environment.wind.angleApparent',value:1.0},{path:'navigation.speedOverGround',value:3},{path:'navigation.speedThroughWater',value:2.8}]);
 m({$source:'derived-data',source:{label:'derived-data'}},[{path:'environment.wind.speedTrue',value:4.5},{path:'environment.wind.angleTrueWater',value:1.3}]);
 setTimeout(()=>m({source:{label:'can0'}},[{path:'environment.wind.angleTrueGround',value:2.0}]),200);},200)}close(){this.onclose&&this.onclose()}}window.WebSocket=W})();`;

(async () => {
  const srv = http.createServer((q, r) => { const f = path.join(WWW, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); } r.setHeader('Content-Type', f.endsWith('.html') ? 'text/html' : 'text/plain'); r.end(fs.readFileSync(f)); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const U = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const mk = async (cfg, extra) => { const c = await browser.newContext({ viewport: { width: 400, height: 860 }, serviceWorkers: 'block' }); await c.addInitScript('window.__CFG=' + JSON.stringify(cfg) + ';(' + init.toString() + ')()'); if (extra) await c.addInitScript(extra); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.errs = errs; return p; };

  console.log('Mode démo (sans Signal K, sans Pi)');
  let P = await mk({ src: 'demo', demoSpeed: 20, lang: 'fr' }); await P.goto(U); await pause(2500);
  assert(await P.evaluate(() => typeof window.PIBOX === 'undefined')); ok('aucun mode Pi');
  assert(await P.evaluate(() => $('#noBoat').classList.contains('hide') && $('#provBar').classList.contains('hide'))); ok('démo : ni bandeau « pas de signal », ni provenance');
  await P.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(900);
  assert(await P.evaluate(() => !!cur && cur.open)); await pause(9000);
  assert(await P.evaluate(() => cur.points.length >= 2)); await P.evaluate(() => { document.querySelector('#btnRec').click(); }); await pause(1200);
  const st = await P.evaluate(async () => (await db.all('trips')).map(t => ({ o: t.open, p: t.points.length }))); assert(st.filter(t => !t.o && t.p >= 2).length === 1); ok('trajet : démarrage, trace, fin, rangement dans le téléphone (comme avant)');
  assert.deepStrictEqual(P.errs, []); ok('aucune erreur JavaScript');

  console.log('Pas de signal bateau');
  P = await mk({ src: 'signalk', host: '127.0.0.1:9', lang: 'fr' }); await P.goto(U); await pause(10500);
  assert(await P.evaluate(() => !$('#noBoat').classList.contains('hide') && $('#nbT').textContent.includes('Pas de signal bateau') && $('#nbS').textContent.includes('carnet'))); ok('Signal K injoignable : bandeau explicite, carnet et carte restent disponibles');
  await P.evaluate(() => go('trips')); await pause(500);
  assert(await P.evaluate(() => document.querySelector('#v-trips').classList.contains('on'))); ok('le carnet reste utilisable sans signal');

  console.log('Provenance et référence du vent (Signal K simulé)');
  P = await mk({ src: 'signalk', host: 'x:1', lang: 'fr' }, FAKE_WS); await P.goto(U); await pause(1800);
  let r = await P.evaluate(() => ({ aws: SRC.aws, tws: SRC.tws, twa: SRC.twa, ref: D.twRef, noBoat: $('#noBoat').classList.contains('hide') }));
  assert.strictEqual(r.aws, 'boat'); assert.strictEqual(r.tws, 'sk'); assert.strictEqual(r.twa, 'sk'); assert.strictEqual(r.ref, 'water'); assert(r.noBoat); ok('mesuré = bateau, valeur d’un plugin de calcul = Signal K, référence surface retenue');
  await pause(500); r = await P.evaluate(() => ({ twa: D.twa, ref: D.twRef })); assert.strictEqual(r.ref, 'water'); assert(Math.abs(r.twa - 1.3 * 180 / Math.PI) < 0.01); ok('en automatique, l’angle « fond » n’écrase pas l’angle « surface »');
  assert(await P.evaluate(() => { updProv(); const e = $('#provBar'); return !e.classList.contains('hide') && e.querySelectorAll('.pc.s-sk').length >= 1 && e.querySelectorAll('.pc.s-boat').length >= 1; })); ok('barre de provenance affichée avec les couleurs');
  assert(await P.evaluate(() => { renderLive(); return $('#t-tws').dataset.src === 'sk' && $('#t-tws .sub').textContent.includes('surface'); })); ok('tuile vent vrai : pastille Signal K et « réf. surface »');
  await P.evaluate(() => { cfg.windRef = 'ground'; D.twRef = null; skValue('environment.wind.angleTrueWater', 0.2); skValue('environment.wind.angleTrueGround', 2.0); });
  r = await P.evaluate(() => ({ ref: D.twRef, twa: D.twa })); assert.strictEqual(r.ref, 'ground'); assert(Math.abs(r.twa - 114.5916) < 0.01); ok('réglage « fond » : seule la valeur fond est retenue');
  // calcul par l'appli : repli, mise à jour à chaque seconde, référence
  P = await mk({ src: 'signalk', host: 'x:1', lang: 'fr' }); await P.goto(U); await pause(800);
  r = await P.evaluate(() => { PSRC = 'boat'; skValue('environment.wind.speedApparent', 6); skValue('environment.wind.angleApparent', 1.0); skValue('navigation.speedOverGround', 3); computeTrueWind(); const a = { s: SRC.tws, ref: D.twRef, v: D.tws }; skValue('environment.wind.speedApparent', 9); computeTrueWind(); return { ...a, v2: D.tws }; });
  assert.strictEqual(r.s, 'calc'); assert.strictEqual(r.ref, 'ground'); assert(r.v2 > r.v + 1); ok('repli : vent vrai calculé (couleur « appli », réf. fond car pas de vitesse surface) et recalculé à chaque appel');
  r = await P.evaluate(() => { skValue('navigation.speedThroughWater', 2.5); skValue('environment.wind.speedApparent', 7); computeTrueWind(); return D.twRef; }); assert.strictEqual(r, 'water'); ok('avec vitesse surface : référence surface');
  r = await P.evaluate(() => { cfg.windRef = 'water'; D.tws = D.twa = null; T.tws = T.twa = 0; T.stw = 0; skValue('environment.wind.speedApparent', 7); computeTrueWind(); return D.tws; }); assert(r == null); ok('réglage « surface » sans vitesse surface : pas de calcul approximatif');
  r = await P.evaluate(() => { cfg.windRef = 'auto'; cfg.src = 'signalk'; cfg.gpsSrc = 'phone'; onPhoneFix({ coords: { latitude: 47.1, longitude: -3.2, accuracy: 10, speed: 2, heading: 90 } }); return { s: SRC.lat, sog: SRC.sog }; });
  assert.strictEqual(r.s, 'phone'); assert.strictEqual(r.sog, 'phone'); ok('GPS du téléphone repéré comme tel');
  r = await P.evaluate(() => { loadSettings(); $('#sWind').value = 'water'; return !!$('#sWind'); }); assert(r); ok('réglage « Référence du vent vrai » présent dans Réglages');
  assert.deepStrictEqual(P.errs, []); ok('aucune erreur JavaScript');
  srv.close(); await browser.close();
  console.log('\n' + n + ' vérifications réussies');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
