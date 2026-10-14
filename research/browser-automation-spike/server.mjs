import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2]; const port = +process.argv[3] || 8000; const outFile = process.argv[4];
const types = { '.html': 'text/html', '.js': 'text/javascript' };
http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.method === 'POST' && req.url === '/result') { let b = ''; req.on('data', d => b += d); req.on('end', () => { console.log('RESULT ' + b); if (outFile) fs.writeFileSync(outFile, b); res.end('ok'); if (outFile) setTimeout(() => process.exit(0), 200); }); return; }
  const p = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(p, (e, d) => { if (e) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream'); res.end(d); });
}).listen(port);
