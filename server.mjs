import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EbayError, searchEbay, getEbayItem, getMedia } from './lib/ebay.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
export function createServer(options = {}) {
  const allowed = new Set((options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const clients = new Map();
  let active = 0;
  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    if (origin && !sameOrigin && !allowed.has(origin)) { json(res, 403, { error: 'Этот сайт не подключён к серверу фотографий.', code: 'ORIGIN_DENIED' }); return; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Метод не поддерживается.', code: 'METHOD_NOT_ALLOWED' }); return; }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { json(res, 400, { error: 'Некорректный адрес.', code: 'INVALID_URL' }); return; }
    if (url.pathname === '/api/health') { json(res, 200, { ok: true, service: 'photo-picker', ebay: 'html', version: 1 }); return; }
    if (url.pathname.startsWith('/api/')) {
      const now = Date.now(), ip = req.socket.remoteAddress;
      let bucket = clients.get(ip);
      if (!bucket || now - bucket.start > 60000) { bucket = { start: now, count: 0 }; clients.set(ip, bucket); }
      if (clients.size > 10000) for (const [key, value] of clients) if (now - value.start > 60000) clients.delete(key);
      if (++bucket.count > 120 || active >= 8) { res.setHeader('Retry-After', '15'); json(res, 429, { error: 'Слишком много запросов. Подождите немного.', code: 'RATE_LIMITED' }); return; }
      active++;
      try {
        if (req.method === 'HEAD') { json(res, 405, { error: 'Для API используйте GET.', code: 'METHOD_NOT_ALLOWED' }); return; }
        if (url.pathname === '/api/ebay/search') { json(res, 200, await searchEbay(url.searchParams.get('article'), url.searchParams.get('page') || '1')); return; }
        if (url.pathname === '/api/ebay/item') { json(res, 200, await getEbayItem(url.searchParams.get('url'))); return; }
        if (url.pathname === '/api/media') {
          const { bytes, mime: type } = await getMedia(url.searchParams.get('url'));
          const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[type];
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="ebay-photo.${extension}"`, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return;
        }
        json(res, 404, { error: 'API не найден.', code: 'NOT_FOUND' });
      } catch (error) {
        const known = error instanceof EbayError;
        json(res, known ? error.status : 500, { error: known ? error.message : 'Внутренняя ошибка сервера.', code: known ? error.code : 'INTERNAL_ERROR' });
      } finally { active--; }
      return;
    }
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep)) throw new Error('Invalid path');
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      const bytes = req.method === 'HEAD' ? null : await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Страница не найдена'); }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 15000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Photo Picker: http://${process.env.HOST || '127.0.0.1'}:${port}`));
}
