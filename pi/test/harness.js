'use strict';
/* Mini serveur de test : imite ce que Signal K offre aux plugins (routeur de type Express, dossier de données, abonnement). */
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const plugin = require('../plugin/index.js');

function makeRouter() {
  const routes = [];
  const add = m => (p, h) => routes.push({ m, p, h, keys: (p.match(/:\w+/g) || []).map(k => k.slice(1)), re: new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$') });
  return { routes, get: add('GET'), put: add('PUT'), post: add('POST'), delete: add('DELETE') };
}
function start({ dir, publicDir, options } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-'));
  let onDelta = null; const status = [];
  const app = {
    getDataDirPath: () => dir, debug() {}, error: m => console.error('[plugin]', m), setPluginStatus: s => status.push(s),
    subscriptionmanager: { subscribe(cmd, unsub, err, cb) { onDelta = cb; unsub.push(() => { onDelta = null; }); } }
  };
  const p = plugin(app), router = makeRouter();
  p.start({ enabled: true, ...(options || {}) }); p.registerWithRouter(router);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let path_ = u.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');   // Signal K accepte aussi les requêtes d'autres origines
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    res.status = c => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = b => res.end(b);
    req.query = Object.fromEntries(u.searchParams);
    if (path_.startsWith('/plugins/carnet-de-bord')) {
      path_ = path_.slice('/plugins/carnet-de-bord'.length) || '/';
      for (const r of router.routes) {
        if (r.m !== req.method) continue; const m = r.re.exec(path_); if (!m) continue;
        req.params = {}; r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1]));
        return r.h(req, res);
      }
      return res.status(404).json({ error: 'route' });
    }
    if (publicDir && path_.startsWith('/signalk-carnet-de-bord/')) {
      let f = path_.slice('/signalk-carnet-de-bord/'.length) || 'index.html';
      f = path.join(publicDir, f); if (!fs.existsSync(f)) return res.status(404).end('nf');
      const ext = path.extname(f), ct = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/json' }[ext] || 'text/plain';
      res.setHeader('Content-Type', ct + '; charset=utf-8'); return res.end(fs.readFileSync(f));
    }
    res.status(404).end('nf');
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({
    url: 'http://127.0.0.1:' + server.address().port, dir, status,
    delta: (path, value) => onDelta && onDelta({ context: 'vessels.self', updates: [{ values: [{ path, value }] }] }),
    stop: () => { p.stop(); server.close(); }
  })));
}
module.exports = { start };
