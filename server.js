/* Single-process Node.js server. No npm dependencies required. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 9090);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_BODY = 4 * 1024 * 1024;

const ACCESS_CODE = process.env.ACCESS_CODE;
const GATE_SECRET = process.env.GATE_SECRET;
const COOKIE_NAME = 'mb_gate';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

if (!ACCESS_CODE || ACCESS_CODE.length < 8) {
  console.error('Set ACCESS_CODE environment variable (minimum 8 characters).');
  process.exit(1);
}

if (!GATE_SECRET || GATE_SECRET.length < 32) {
  console.error('Set GATE_SECRET environment variable (minimum 32 characters).');
  process.exit(1);
}

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const validCode = c => /^[A-Z0-9]{6}$/.test(c);
const loginAttempts = new Map();

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(value));
}

function readRoom(code) {
  const f = path.join(DATA_DIR, code + '.json');

  if (!fs.existsSync(f)) {
    return { _finance: 2, revision: 0, data: null, receipts: [] };
  }

  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));

  if (raw && raw._finance === 2) return raw;

  return { _finance: 2, revision: 1, data: raw, receipts: [] };
}

function atomic(code, value) {
  const f = path.join(DATA_DIR, code + '.json');
  const tmp = f + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';

  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, f);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function safeJSON(value, depth = 0) {
  if (depth > 40) return false;

  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => safeJSON(v, depth + 1));

  if (typeof value === 'object') {
    return Object.keys(value).every(k =>
      !['__proto__', 'constructor', 'prototype'].includes(k) && safeJSON(value[k], depth + 1)
    );
  }

  return false;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};

  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;

    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();

    if (key) result[key] = decodeURIComponent(value);
  }

  return result;
}

function sign(value) {
  return crypto.createHmac('sha256', GATE_SECRET).update(value).digest('base64url');
}

function createGateToken() {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

function verifyGateToken(token) {
  if (typeof token !== 'string') return false;

  const i = token.lastIndexOf('.');
  if (i <= 0) return false;

  const payload = token.slice(0, i);
  const signature = token.slice(i + 1);
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const expires = Number(payload);
  return Number.isSafeInteger(expires) && expires > Date.now();
}

function isAuthenticated(req) {
  return verifyGateToken(parseCookies(req)[COOKIE_NAME]);
}

function isAllowedAttempt(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip);

  if (!item || now > item.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }

  item.count += 1;
  return item.count <= 5;
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

function serveFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'not_found' });

    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': /\.(html|js|css|json)$/.test(filePath) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept-Encoding'
    };

    if (
      /gzip/.test(req.headers?.['accept-encoding'] || '') &&
      /^(text\/|application\/(javascript|json))/.test(type)
    ) {
      zlib.gzip(data, (e, out) => {
        if (e) return json(res, 500, { ok: false, error: 'compression_failed' });

        headers['Content-Encoding'] = 'gzip';
        res.writeHead(status, headers);
        res.end(out);
      });
    } else {
      res.writeHead(status, headers);
      res.end(data);
    }
  });
}

const server = http.createServer((req, res) => {
  let url;

  try {
    url = new URL(req.url, 'http://local');
  } catch {
    return json(res, 400, { ok: false, error: 'bad_url' });
  }

  const pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, protocol: 2 });
  }

  if (pathname === '/api/auth/login') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });
    if (!isAllowedAttempt(ip)) {
      return json(res, 429, { ok: false, error: 'too_many_attempts' });
    }

    let chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', c => {
      size += c.length;

      if (size > MAX_BODY) {
        if (!tooLarge) json(res, 413, { ok: false, error: 'too_large' });
        tooLarge = true;
        chunks = [];
      } else if (!tooLarge) {
        chunks.push(c);
      }
    });

    req.on('end', () => {
      if (tooLarge) return;

      let body;

      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { ok: false, error: 'bad_json' });
      }

      const code = String(body?.code || '').trim();

      if (!code || !constantTimeEqual(code, ACCESS_CODE)) {
        return json(res, 401, { ok: false, error: 'wrong_code' });
      }

      const token = createGateToken();
      const expires = new Date(Date.now() + SESSION_TTL_MS);

      res.setHeader('Set-Cookie', [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Expires=${expires.toUTCString()}`,
        process.env.NODE_ENV === 'production' ? 'Secure' : ''
      ].filter(Boolean).join('; '));

      return json(res, 200, { ok: true });
    });

    return;
  }

  if (pathname === '/api/auth/logout') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });

    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/load' || pathname === '/api/save') {
    if (!isAuthenticated(req)) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }
  }

  if (pathname === '/api/load') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method' });

    const code = (url.searchParams.get('code') || '').toUpperCase();

    if (!validCode(code)) return json(res, 400, { ok: false, error: 'bad_code' });

    try {
      const r = readRoom(code);
      return json(res, 200, { ok: true, protocol: 2, revision: r.revision, data: r.data });
    } catch (e) {
      console.error('Read room failed', e.message);
      return json(res, 500, { ok: false, error: 'read_failed' });
    }
  }

  if (pathname === '/api/save') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });

    let chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', c => {
      size += c.length;

      if (size > MAX_BODY) {
        if (!tooLarge) json(res, 413, { ok: false, error: 'too_large' });
        tooLarge = true;
        chunks = [];
      } else if (!tooLarge) {
        chunks.push(c);
      }
    });

    req.on('end', () => {
      if (tooLarge) return;

      let p;

      try {
        p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { ok: false, error: 'bad_json' });
      }

      const code = String(p && p.code || '').toUpperCase();

      if (!validCode(code)) return json(res, 400, { ok: false, error: 'bad_code' });

      if (
        !Number.isSafeInteger(p.revision) ||
        p.revision < 0 ||
        typeof p.requestId !== 'string' ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(p.requestId)
      ) {
        return json(res, 428, { ok: false, error: 'upgrade_required', protocol: 2 });
      }

      if (
        !p.data ||
        !Array.isArray(p.data.cats) ||
        !p.data.months ||
        typeof p.data.months !== 'object' ||
        Array.isArray(p.data.months) ||
        !safeJSON(p.data)
      ) {
        return json(res, 400, { ok: false, error: 'invalid_state' });
      }

      try {
        const r = readRoom(code);

        if ((r.receipts || []).some(x => x.id === p.requestId)) {
          return json(res, 200, {
            ok: true,
            protocol: 2,
            revision: r.revision,
            data: r.data,
            duplicate: true
          });
        }

        if (r.revision !== p.revision) {
          return json(res, 409, {
            ok: false,
            error: 'revision_conflict',
            protocol: 2,
            revision: r.revision,
            data: r.data
          });
        }

        const next = {
          _finance: 2,
          revision: r.revision + 1,
          data: p.data,
          receipts: (r.receipts || []).concat({ id: p.requestId }).slice(-256)
        };

        atomic(code, next);

        return json(res, 200, {
          ok: true,
          protocol: 2,
          revision: next.revision,
          data: next.data
        });
      } catch (e) {
        console.error('Save room failed', e.message);
        return json(res, 500, { ok: false, error: 'write_failed' });
      }
    });

    return;
  }

  if (pathname.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { ok: false, error: 'method' });
  }

  let requested;

  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { ok: false, error: 'bad_path' });
  }

  if (requested.split('/').some(v => v.startsWith('.')) || /\.(bak|tmp)(-|\.|$)/i.test(requested)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  const isAppEntry = requested === '/' || requested === '/index.html';
  const loginPath = path.join(PUBLIC_DIR, 'login.html');

  if (isAppEntry && !isAuthenticated(req)) {
    return serveFile(res, loginPath);
  }

  const fp = path.resolve(PUBLIC_DIR, '.' + (requested === '/' ? '/index.html' : requested));

  if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  if (fp === DATA_DIR || fp.startsWith(DATA_DIR + path.sep) || fp === __filename) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  serveFile(res, fp);
});

server.requestTimeout = 20000;
server.headersTimeout = 15000;

server.listen(PORT, () => {
  console.log(`Finance protocol 2 on port ${PORT}; public=${PUBLIC_DIR}; data=${DATA_DIR}`);
});
