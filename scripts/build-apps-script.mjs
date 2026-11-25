import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validators = String.raw`
function checkedHttps(value, kind) {
  const source = unescapeHtml(String(value || ''));
  const match = source.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i);
  if (!match || /[\\\s\u0000-\u001f]/.test(source)) throw new EbayError('Некорректная ссылка.', 'INVALID_URL', 400);
  const host = match[1].toLowerCase();
  const path = match[2] || '/';
  if (kind === 'media' ? host !== 'i.ebayimg.com' : host !== 'www.ebay.com' && host !== 'ebay.com') throw new EbayError('Адрес источника запрещён.', 'INVALID_URL', 400);
  if (kind === 'media' && !/^\/(?:images|00)\//.test(path)) throw new EbayError('Допускаются только изображения eBay.', 'INVALID_URL', 400);
  return { href: source, hostname: host, pathname: path };
}
function safeItemUrl(value) {
  const url = checkedHttps(value, 'page');
  const match = url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/);
  if (!match) throw new EbayError('Допускаются только ссылки на объявления ebay.com.', 'INVALID_URL', 400);
  return { href: 'https://www.ebay.com/itm/' + match[1], pathname: '/itm/' + match[1], hostname: 'www.ebay.com' };
}
function safeMediaUrl(value) { return checkedHttps(value, 'media'); }
`;

const runtime = String.raw`
// This connector reads public eBay pages only. It never receives Google Drive access tokens.
function resolveRedirect(location, previous, kind) {
  if (!location || /[\\\s\u0000-\u001f]/.test(location)) throw new EbayError('Некорректное перенаправление.', 'INVALID_REDIRECT');
  let target;
  if (/^https:\/\//i.test(location)) target = location;
  else if (location.indexOf('//') === 0) target = 'https:' + location;
  else {
    const prior = checkedHttps(previous, kind);
    if (location[0] === '/') target = 'https://' + prior.hostname + location;
    else if (location[0] === '?') target = 'https://' + prior.hostname + prior.pathname + location;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(location)) throw new EbayError('Перенаправление запрещено.', 'INVALID_REDIRECT');
    else target = 'https://' + prior.hostname + prior.pathname.replace(/[^/]*$/, '') + location;
  }
  checkedHttps(target, kind);
  return target;
}
function responseHeader(headers, name) {
  const key = Object.keys(headers || {}).find(function (key) { return key.toLowerCase() === name.toLowerCase(); });
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}
function fetchPublic(url, kind) {
  const max = kind === 'media' ? 15 * 1024 * 1024 : 8 * 1024 * 1024;
  for (let redirects = 0; redirects <= 4; redirects++) {
    checkedHttps(url, kind);
    let response;
    try {
      response = UrlFetchApp.fetch(url, {
        followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true,
        headers: { 'Accept-Language': 'en-US,en;q=0.9', Accept: kind === 'media' ? 'image/*' : 'text/html' }
      });
    } catch (error) {
      throw new EbayError('Не удалось связаться с eBay. Возможна недоступность источника или исчерпание лимита Google.', 'EBAY_UNAVAILABLE');
    }
    const status = response.getResponseCode();
    const headers = response.getAllHeaders();
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirects === 4) throw new EbayError('Слишком много перенаправлений eBay.', 'INVALID_REDIRECT');
      url = resolveRedirect(responseHeader(headers, 'location'), url, kind); continue;
    }
    if (status === 403 || status === 429) throw new EbayError('eBay ограничил автоматические запросы. Откройте поиск на eBay или повторите позже.', 'EBAY_BLOCKED', 503);
    if (status < 200 || status >= 300) throw new EbayError('eBay вернул ошибку ' + status + '.', 'EBAY_UNAVAILABLE');
    if (Number(responseHeader(headers, 'content-length')) > max) throw new EbayError('Ответ источника слишком большой.', 'RESPONSE_TOO_LARGE');
    const bytes = response.getContent();
    if (bytes.length > max) throw new EbayError('Ответ источника слишком большой.', 'RESPONSE_TOO_LARGE');
    const mime = responseHeader(headers, 'content-type').split(';')[0].toLowerCase().trim();
    if (kind === 'media') {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) throw new EbayError('Источник не вернул изображение.', 'INVALID_MEDIA');
      return { base64: Utilities.base64Encode(bytes), mime: mime };
    }
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml') throw new EbayError('eBay вернул неожиданный формат ответа.', 'EBAY_UNAVAILABLE');
    const html = response.getContentText('UTF-8');
    if (/<title[^>]*>\s*(?:Pardon Our Interruption|Security Measure|Access Denied)|\/splashui\/|Checking your browser|Please verify yourself|verify you are (?:a )?human/i.test(html)) throw new EbayError('eBay запросил проверку браузера. Откройте поиск на eBay или повторите позже.', 'EBAY_BLOCKED', 503);
    return html;
  }
}
function withCache(key, operation) {
  let cache;
  try { cache = CacheService.getScriptCache(); const hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (error) { /* Cache is optional. */ }
  const result = operation();
  const data = JSON.stringify(result);
  // 22,000 UTF-16 characters stay below the 90 KB ceiling, even with four-byte UTF-8 characters.
  if (cache && data.length < 22000) try { cache.put(key, data, 120); } catch (error) { /* Cache quota must not break the request. */ }
  return result;
}
function dispatch(parameters) {
  const action = parameters.action || 'health';
  if (action === 'health') return { ok: true, service: 'photo-picker', ebay: 'html', version: 1 };
  if (action === 'search') {
    const article = normalizeArticle(parameters.article);
    const page = Number(parameters.page || '1');
    if (!Number.isInteger(page) || page < 1 || page > 50) throw new EbayError('Номер страницы должен быть от 1 до 50.', 'INVALID_PAGE', 400);
    return withCache('search:' + article + ':' + page, function () {
      const url = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(article) + '&rt=nc&LH_ItemCondition=3&_pgn=' + page + '&_ipg=60';
      return parseSearchHtml(fetchPublic(url, 'page'), page);
    });
  }
  if (action === 'item') {
    const url = safeItemUrl(parameters.url);
    return withCache('item:' + url.pathname.split('/').pop(), function () { return parseItemHtml(fetchPublic(url.href, 'page'), url.href); });
  }
  if (action === 'media') return fetchPublic(safeMediaUrl(parameters.url).href, 'media');
  throw new EbayError('Неизвестное действие.', 'INVALID_ACTION', 400);
}
function doGet(e) {
  const parameters = e && e.parameter || {};
  const callback = parameters.callback || '';
  if (callback && !/^pp_[a-z0-9_]{1,100}$/i.test(callback)) return ContentService.createTextOutput(JSON.stringify({ error: 'Некорректный callback.', code: 'INVALID_CALLBACK', status: 400 })).setMimeType(ContentService.MimeType.JSON);
  let payload;
  try { payload = dispatch(parameters); }
  catch (error) { payload = { error: error instanceof EbayError ? error.message : 'Ошибка сервиса фотографий.', code: error.code || 'INTERNAL_ERROR', status: error.status || 500 }; }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return ContentService.createTextOutput(callback ? callback + '(' + json + ');' : json).setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
`;

export async function buildAppsScript() {
  const input = await readFile(resolve(root, 'lib/ebay.mjs'), 'utf8');
  const parserEnd = input.indexOf('export async function readLimited');
  const validatorsStart = input.indexOf('export function safeItemUrl');
  const validatorsEnd = input.indexOf('function imagePair', validatorsStart);
  if ([parserEnd, validatorsStart, validatorsEnd].some((index) => index < 0)) throw new Error('Parser boundaries changed. Update the Apps Script generator.');
  const shared = (input.slice(0, validatorsStart) + validators + '\n' + input.slice(validatorsEnd, parserEnd)).replace(/^export /gm, '');
  const output = '// GENERATED by node scripts/build-apps-script.mjs. Edit lib/ebay.mjs or the generator.\n' + shared + runtime;
  const directory = resolve(root, 'google-apps-script');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'Code.gs'), output, 'utf8');
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildAppsScript();
  console.log('Generated google-apps-script/Code.gs');
}
