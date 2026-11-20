'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { Mirror, csv } = require('../plugin/mirror');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const lines = []; let fail = 0;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    assert.strictEqual(req.headers.authorization, 'Token wtok');
    if (u.pathname === '/api/v2/write') {
      if (fail > 0) { fail--; res.statusCode = 500; return res.end('boom'); }
      assert.strictEqual(u.searchParams.get('bucket'), 'carnet'); lines.push(...b.split('\n')); res.statusCode = 204; return res.end();
    }
    if (u.pathname === '/api/v2/query') {
      assert(/range\(start: -20y\)/.test(b) && /"carnet"/.test(b));
      const latest = new Map();
      for (const l of lines) { const m = l.match(/^carnet_doc,kind=(\S+),id=((?:\\.|\S)+) json="(.*)" \d+$/); if (m) { m[2] = m[2].replace(/\\(.)/g, '$1'); latest.set(m[1] + '|' + m[2], m); } }
      const rows = [...latest.values()].map(m => `,_result,0,2026-06-01T00:00:00Z,"${m[3].replace(/\\(.)/g, '$1').replace(/"/g, '""')}",json,carnet_doc,${m[1]},${m[2]}`);
      return res.end(',result,table,_time,_value,_field,_measurement,kind,id\r\n' + rows.join('\r\n') + '\r\n');
    }
    res.statusCode = 404; res.end();
  });
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port;
  const cfg = { enabled: true, version: '2', url, org: 'o', token: 'rtok', carnetToken: 'wtok', carnetBucket: 'carnet' };
  assert.deepStrictEqual(csv('a,"b,c","d""e"\r\n1,2,3\r\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]); ok('lecteur CSV : virgules et guillemets dans les valeurs');
  assert(!new Mirror({ ...cfg, version: '1' }).enabled && !new Mirror({ ...cfg, mirror: false }).enabled && !new Mirror({}).enabled); ok('inactif en 1.x, désactivé ou non configuré');
  const m = new Mirror(cfg);
  m.put('notes', 'n 1', { id: 'n 1', text: 'Voile "génois", 12 nds, ok' }); m.put('kv', 'cfg', { v: 'x' }); m.put('trips', 't1', { id: 't1', points: [1, 2] });
  m.put('trips', 't1', { id: 't1', points: [1, 2, 3] }); assert.strictEqual(m.q.size, 3); ok('une seule version en attente par document');
  fail = 1; await m.flush(); assert(m.err && m.q.size === 3); ok('échec d’écriture : rien perdu, nouvel essai prévu');
  await m.flush(); assert.strictEqual(m.q.size, 0); assert.strictEqual(lines.length, 3); ok('écriture groupée réussie (3 lignes, bucket dédié)');
  m.put('notes', 'n2', { id: 'n2' }); await m.flush(); m.del('notes', 'n2'); await m.flush();
  const docs = await m.restore(); const by = Object.fromEntries(docs.map(d => [d.kind + '|' + d.id, d.doc]));
  assert.strictEqual(by['notes|n 1'].text, 'Voile "génois", 12 nds, ok'); assert.strictEqual(by['kv|cfg'].v, 'x'); assert.deepStrictEqual(by['trips|t1'].points, [1, 2, 3]); assert(!by['notes|n2']); ok('restauration : dernière version, texte intact, suppression respectée');
  const big = new Mirror(cfg); big.put('trips', 'b', { id: 'b', points: new Array(120000).fill({ t: 1234567890123, la: 47.123456, lo: -3.123456 }) });
  assert(/pointsDropped/.test([...big.q.values()][0])); ok('trajet trop volumineux : points non copiés, journal conservé');
  srv.close(); setTimeout(() => process.exit(0), 100); console.log('\n' + n + ' vérifications miroir réussies');
})().catch(e => { console.error(e); process.exit(1); });
