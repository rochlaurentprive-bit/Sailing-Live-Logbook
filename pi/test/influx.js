'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { Influx, importTrips } = require('../plugin/influx'), { Store } = require('../plugin/store');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const KN = 1 / 1.9438444924, T0 = Date.UTC(2026, 5, 1, 8, 0, 0), STEP = 10000;
// 1 h de navigation à 5 nd cap est, puis 10 min à l'arrêt
const pos = t => { const k = Math.min((t - T0) / 1000, 3600); return { lat: 47.5, lon: -3.1 + k * 5 * KN / (60 * 1852 * Math.cos(47.5 * Math.PI / 180)) * 1852 / 1 * 0 + k * 0.00003 }; };
const moving = t => t >= T0 && t < T0 + 3600e3;
const data = {
  'navigation.speedOverGround': t => moving(t) ? 5 * KN : 0.1,
  'navigation.position:lat': t => pos(t).lat, 'navigation.position:lon': t => pos(t).lon,
  'environment.wind.speedApparent': () => 8
};
function mkRows(meas, field, from, to, step) {
  const f = data[meas] || data[meas + ':' + field]; if (!f) return [];
  const o = []; for (let t = Math.ceil(from / step) * step; t < to; t += step) if (t >= T0 - 600e3 && t < T0 + 4300e3) o.push([t, f(t)]); return o;
}
let v1calls = 0, v2calls = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (u.pathname === '/query') {
      v1calls++; const q = u.searchParams.get('q');
      if (/SHOW MEASUREMENTS/.test(q)) return res.end(JSON.stringify({ results: [{ series: [{ values: [['navigation.speedOverGround'], ['navigation.position'], ['environment.wind.speedApparent']] }] }] }));
      const m = q.match(/mean\("(\w+)"\) FROM "([^"]+)" WHERE time >= (\d+)ms AND time < (\d+)ms GROUP BY time\((\d+)s\)/);
      const rows = mkRows(m[2], m[1], +m[3], +m[4], +m[5] * 1000);
      return res.end(JSON.stringify({ results: [{ series: rows.length ? [{ values: rows }] : undefined }] }));
    }
    if (u.pathname === '/api/v2/query') {
      v2calls++; assert.strictEqual(req.headers.authorization, 'Token tok');
      if (/schema\.measurements/.test(b)) return res.end(',result,table,_value\r\n,_result,0,navigation.speedOverGround\r\n,_result,0,navigation.position\r\n');
      const m = b.match(/_measurement == "([^"]+)" and r._field == "(\w+)"/), r = b.match(/start: ([^,]+), stop: ([^)]+)\)/), e = b.match(/every: (\d+)s/);
      const rows = mkRows(m[1], m[2], Date.parse(r[1]), Date.parse(r[2]), +e[1] * 1000);
      return res.end(',result,table,_time,_value\r\n' + rows.map(x => `,_result,0,${new Date(x[0]).toISOString()},${x[1]}`).join('\r\n') + '\r\n');
    }
    res.statusCode = 404; res.end('no');
  });
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  for (const v of ['1', '2']) {
    console.log('InfluxDB ' + v + '.x');
    const cfg = { enabled: true, version: v, url, database: 'sk', bucket: 'sk', org: 'o', token: 'tok', latField: 'lat', lonField: 'lon' };
    const inf = new Influx(cfg), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-i-')), st = new Store(dir);
    assert((await inf.measurements()).includes('navigation.position')); ok('sonde : mesures détectées');
    const r = await importTrips(inf, st, T0 - 600e3, T0 + 4300e3, {});
    assert.strictEqual(r.created.length, 1, JSON.stringify(r)); const t = st.all('trips')[0];
    assert(t.points.length > 360 && t.points.length < 410 && t.imported === 'influx' && !t.open); ok('1 trajet reconstruit (' + t.points.length + ' points)');
    assert(t.log[0].kind === 'start' && t.log[t.log.length - 1].kind === 'end' && t.log.some(e => e.kind === 'auto')); ok('entrées start / auto / end comme l’appli');
    assert(t.start >= T0 && t.start <= T0 + 60e3 && t.end > T0 + 3600e3 && t.end < T0 + 3600e3 + 400e3); ok('départ ~30 s après le début, arrêt après 5 min d’immobilité');
    assert(Math.abs(r.created[0].nm - 4.4) < 0.5); ok('distance ≈ 4,4 NM');
    const r2 = await importTrips(inf, st, T0 - 600e3, T0 + 4300e3, {}); assert.strictEqual(r2.created.length, 0); assert.strictEqual(r2.skipped.length, 1); assert.strictEqual(st.all('trips').length, 1); ok('second import : aucun doublon');
    const r3 = await importTrips(inf, st, T0 + 7200e3, T0 + 9000e3, {}); assert.strictEqual(r3.created.length, 0); ok('période sans données : rien créé');
    await assert.rejects(() => importTrips(new Influx({}), st, 1, 2, {}), /non configuré/); ok('non configuré : refusé');
  }
  assert(v1calls > 0 && v2calls > 0); srv.close(); console.log('\n' + n + ' vérifications InfluxDB réussies');
})().catch(e => { console.error(e); process.exit(1); });
