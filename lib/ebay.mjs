const PAGE_HOSTS = new Set(['www.ebay.com', 'ebay.com']);
const MAX_HTML_BYTES = 8 * 1024 * 1024;
export class EbayError extends Error {
  constructor(message, code = 'EBAY_ERROR', status = 502) { super(message); this.code = code; this.status = status; }
}

function unescapeHtml(value = '') {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}
const text = (value) => unescapeHtml(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function attr(tag, name) {
  const match = tag.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
  return match ? unescapeHtml(match[1] ?? match[2]) : '';
}
export function normalizeArticle(value) {
  const article = String(value ?? '').trim().replace(/VRN$/i, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(article)) throw new EbayError('Некорректный артикул.', 'INVALID_ARTICLE', 400);
  return article;
}
export function safeItemUrl(value) {
  let url;
  try { url = new URL(unescapeHtml(String(value))); } catch { throw new EbayError('Некорректная ссылка eBay.', 'INVALID_URL', 400); }
  if (url.protocol !== 'https:' || !PAGE_HOSTS.has(url.hostname) || url.port || url.username || url.password || !/^\/itm\/(?:[^/]+\/)?\d{9,15}\/?$/.test(url.pathname)) {
    throw new EbayError('Допускаются только ссылки на объявления ebay.com.', 'INVALID_URL', 400);
  }
  const id = url.pathname.match(/(\d{9,15})\/?$/)[1];
  return new URL('https://www.ebay.com/itm/' + id);
}
export function safeMediaUrl(value) {
  let url;
  try { url = new URL(unescapeHtml(String(value))); } catch { throw new EbayError('Некорректная ссылка на изображение.', 'INVALID_URL', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'i.ebayimg.com' || url.port || url.username || url.password || !/^\/(?:images|00)\//.test(url.pathname)) {
    throw new EbayError('Допускаются только изображения i.ebayimg.com.', 'INVALID_URL', 400);
  }
  return url;
}
function imagePair(value) {
  try {
    const thumbnail = safeMediaUrl(value).href;
    const url = thumbnail.replace(/\/s-l\d+(?=\.[a-z]+(?:[?#]|$))/i, '/s-l1600');
    return { url, thumbnail };
  } catch { return null; }
}
function uniqueImages(values) {
  const seen = new Set();
  return values.map(imagePair).filter((image) => image && !seen.has(image.url) && seen.add(image.url));
}
export function parseSearchHtml(html, page = 1) {
  const items = [], ids = new Set();
  // Restrict extraction to result list cards; global image matching includes advertising and recommendations.
  for (const match of html.matchAll(/<li\b[^>]*class\s*=\s*["'][^"']*\b(?:s-item|s-card)\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const card = match[1];
    let itemUrl;
    for (const anchor of card.matchAll(/<a\b[^>]*>/gi)) {
      try { itemUrl = safeItemUrl(attr(anchor[0], 'href')); break; } catch { /* Other card links are not listing links. */ }
    }
    if (!itemUrl) continue;
    const id = itemUrl.pathname.split('/').pop();
    if (ids.has(id) || id === '123456789012') continue;
    const heading = card.match(/<(?:div|h3|span)\b[^>]*class\s*=\s*["'][^"']*\b(?:s-item__title|s-card__title)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|h3|span)>/i);
    const title = heading ? text(heading[1]).replace(/^New Listing\s*/i, '') : `Объявление ${id}`;
    const images = [];
    for (const image of card.matchAll(/<img\b[^>]*>/gi)) {
      const candidate = imagePair(attr(image[0], 'data-src') || attr(image[0], 'src'));
      if (candidate) { images.push(candidate); break; }
    }
    if (!images.length) continue;
    ids.add(id); items.push({ id, title, url: itemUrl.href, images });
  }
  let hasMore = false;
  for (const anchor of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = anchor[0];
    if (/pagination__next/i.test(attr(tag, 'class')) && attr(tag, 'href') && attr(tag, 'aria-disabled') !== 'true') hasMore = true;
  }
  const noResults = /(?:No exact matches found|0 results for|We couldn.t find any results|No results found)/i.test(text(html));
  const warnings = items.length ? [] : noResults ? [] : ['eBay не вернул распознаваемые карточки. Возможно, изменилась разметка страницы.'];
  return { items, page, hasMore: items.length > 0 && hasMore, warnings };
}
export function parseItemHtml(html, itemUrl) {
  const url = safeItemUrl(itemUrl);
  let title = '';
  const images = [];
  function product(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(product); return; }
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.includes('Product')) {
      title ||= typeof node.name === 'string' ? node.name : '';
      const source = Array.isArray(node.image) ? node.image : [node.image];
      for (const image of source) {
        const value = typeof image === 'string' ? image : image?.contentUrl || image?.url;
        if (value) images.push(value);
      }
    }
    if (node['@graph']) product(node['@graph']);
  }
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { product(JSON.parse(script[1])); } catch { /* A malformed unrelated JSON-LD block is not fatal. */ }
  }
  // Gallery elements only, excluding "similar items" and seller promotional images.
  for (const gallery of html.matchAll(/<(button|li|div)\b[^>]*class\s*=\s*["'][^"']*\bux-image-(?:filmstrip-)?carousel-item\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
    for (const image of gallery[2].matchAll(/<img\b[^>]*>/gi)) images.push(attr(image[0], 'data-zoom-src') || attr(image[0], 'data-src') || attr(image[0], 'src'));
  }
  for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
    if (attr(image[0], 'id') === 'icImg') images.push(attr(image[0], 'src'));
  }
  if (!title) title = text(html.match(/<h1\b[^>]*class\s*=\s*["'][^"']*\bx-item-title__mainTitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const result = uniqueImages(images);
  return { id: url.pathname.split('/').pop(), title, url: url.href, images: result, warnings: result.length ? [] : ['Не удалось извлечь галерею объявления. Откройте объявление на eBay.'] };
}
export async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new EbayError('Ответ источника слишком большой.', 'RESPONSE_TOO_LARGE'); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new EbayError('Ответ источника слишком большой.', 'RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export async function restrictedFetch(input, kind = 'page') {
  let url = kind === 'media' ? safeMediaUrl(input) : new URL(input);
  const signal = AbortSignal.timeout(25000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (kind === 'media') safeMediaUrl(url.href);
    else if (url.protocol !== 'https:' || !PAGE_HOSTS.has(url.hostname) || url.port || url.username || url.password) throw new EbayError('Источник перенаправил запрос на запрещённый адрес.', 'INVALID_REDIRECT');
    let response;
    try {
      response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhotoPicker/1.0)', 'Accept-Language': 'en-US,en;q=0.9', Accept: kind === 'media' ? 'image/*' : 'text/html' } });
    } catch { throw new EbayError('Не удалось связаться с eBay. Повторите позже.', 'EBAY_UNAVAILABLE'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 4) throw new EbayError('Слишком много перенаправлений eBay.', 'INVALID_REDIRECT');
      url = new URL(location, url); continue;
    }
    if ([403, 429].includes(response.status)) { await response.body?.cancel(); throw new EbayError('eBay ограничил автоматические запросы. Откройте поиск на eBay или повторите позже.', 'EBAY_BLOCKED', 503); }
    if (!response.ok) { await response.body?.cancel(); throw new EbayError(`eBay вернул ошибку ${response.status}.`, 'EBAY_UNAVAILABLE'); }
    return response;
  }
}
async function htmlRequest(url) {
  const response = await restrictedFetch(url);
  const mime = response.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml\+xml/i.test(mime)) { await response.body?.cancel(); throw new EbayError('eBay вернул неожиданный формат ответа.', 'EBAY_UNAVAILABLE'); }
  const html = (await readLimited(response, MAX_HTML_BYTES)).toString('utf8');
  if (/<title[^>]*>\s*(?:Pardon Our Interruption|Security Measure|Access Denied)|\/splashui\/|Checking your browser|Please verify yourself|verify you are (?:a )?human/i.test(html)) {
    throw new EbayError('eBay запросил проверку браузера. Откройте поиск на eBay или повторите позже.', 'EBAY_BLOCKED', 503);
  }
  return html;
}
export async function searchEbay(articleInput, pageInput = 1) {
  const article = normalizeArticle(articleInput), page = Number(pageInput);
  if (!Number.isInteger(page) || page < 1 || page > 50) throw new EbayError('Номер страницы должен быть от 1 до 50.', 'INVALID_PAGE', 400);
  const url = new URL('https://www.ebay.com/sch/i.html');
  url.search = new URLSearchParams({ _nkw: article, rt: 'nc', LH_ItemCondition: '3', _pgn: String(page), _ipg: '60' });
  return parseSearchHtml(await htmlRequest(url), page);
}
export async function getEbayItem(input) {
  const url = safeItemUrl(input);
  return parseItemHtml(await htmlRequest(url), url);
}
export async function getMedia(input) {
  const response = await restrictedFetch(safeMediaUrl(input), 'media');
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) { await response.body?.cancel(); throw new EbayError('Источник не вернул изображение.', 'INVALID_MEDIA'); }
  return { bytes: await readLimited(response, 25 * 1024 * 1024), mime };
}
