/** 极简 WebDAV 测试服务器：PUT/GET/MKCOL/DELETE，Basic Auth（user/pass），文件存 ./webdav-root */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('test-assets/webdav-root');
const PORT = 9876;
const AUTH = 'Basic ' + Buffer.from('davuser:davpass').toString('base64');

fs.mkdirSync(ROOT, { recursive: true });
http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const abs = path.join(ROOT, rel);
  const authed = (req.headers.authorization ?? '') === AUTH;
  if (!authed) { res.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' }); return res.end(); }
  const safe = abs.startsWith(ROOT);
  if (req.method === 'MKCOL') {
    fs.mkdirSync(abs, { recursive: true });
    return res.writeHead(201).end();
  }
  if (req.method === 'PUT') {
    if (!safe) return res.writeHead(403).end();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fs.writeFileSync(abs, Buffer.concat(chunks)); console.log(`[dav] PUT ${rel} (${chunks.length}B)`); res.writeHead(201).end(); });
    return;
  }
  if (req.method === 'GET') {
    if (!fs.existsSync(abs)) return res.writeHead(404).end();
    const st = fs.statSync(abs);
    res.writeHead(200, { 'content-length': st.size });
    fs.createReadStream(abs).pipe(res);
    return;
  }
  if (req.method === 'DELETE') {
    fs.rmSync(abs, { force: true, recursive: true });
    return res.writeHead(204).end();
  }
  res.writeHead(405).end();
}).listen(PORT, () => console.log(`[dav] stub listening :${PORT}, root=${ROOT}`));
