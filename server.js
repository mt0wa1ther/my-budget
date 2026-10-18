const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 9090;               // ← 9090 по вашему желанию
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR   = path.join(__dirname, 'data');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css' :'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.png' :'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.ico' :'image/x-icon', '.txt':'text/plain; charset=utf-8'
};
function validCode(c){ return /^[A-Z0-9]{6}$/.test(c||''); }
function readJson(f){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return null; } }
function writeJsonAtom(f, obj){
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/load') {
    const code = (url.searchParams.get('code')||'').toUpperCase();
    if (!validCode(code)) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad_code'})); }
    const data = readJson(path.join(DATA_DIR, code + '.json'));
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true, data:data}));
  }

  if (p === '/api/save') {
    let body = '';
    req.on('data', c => body += c);
    return req.on('end', () => {
      let payload = null; try{ payload = JSON.parse(body); }catch(e){}
      const code = String((payload && payload.code)||'').toUpperCase();
      if (!validCode(code)) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'bad_code'})); }
      if (!payload || payload.data === undefined) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'no_data'})); }
      try { writeJsonAtom(path.join(DATA_DIR, code + '.json'), payload.data); }
      catch(e){ res.writeHead(500, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'write_failed'})); }
      res.writeHead(200, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true}));
    });
  }

  let fp = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403, { 'Content-Type':'application/json' }); return res.end(JSON.stringify({ok:false,error:'forbidden'})); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'not_found'})); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(data);
  });
}).listen(PORT, () => console.log('Server on http://0.0.0.0:' + PORT));