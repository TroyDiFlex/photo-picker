function serviceUrl(value) {
  if (!value) throw new Error('Владелец сайта ещё не подключил получение фотографий eBay.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Некорректный адрес подключения eBay.'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Для подключения eBay нужен HTTPS-адрес.');
  return url;
}
export function isGoogleConnector(url) { return url.hostname === 'script.google.com' && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname); }
function apiError(data) {
  if (!data || typeof data !== 'object') throw new Error('Подключение eBay вернуло некорректный ответ.');
  if (data.error) { const error = new Error(data.error); error.code = data.code; throw error; }
  return data;
}
function jsonp(url, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Отменено', 'AbortError'));
  return new Promise((resolve, reject) => {
    const name = 'pp_' + crypto.randomUUID().replaceAll('-', '_'), script = document.createElement('script');
    url.searchParams.set('callback', name);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); script.remove(); delete globalThis[name]; };
    const fail = error => {
      cleanup();
      // Google may finish after cancellation; keep a harmless short-lived callback.
      globalThis[name] = () => {}; setTimeout(() => delete globalThis[name], 60000);
      reject(error);
    };
    const cancel = () => fail(signal.reason || new DOMException('Отменено', 'AbortError'));
    const timer = setTimeout(() => fail(new Error('Google не ответил за 45 секунд. Повторите запрос.')), 45000);
    globalThis[name] = data => { cleanup(); try { resolve(apiError(data)); } catch (error) { reject(error); } };
    script.onerror = () => fail(new Error('Не удалось подключиться к eBay. Проверьте опубликованный адрес Google Apps Script.'));
    script.src = url.href; script.referrerPolicy = 'no-referrer'; script.async = true;
    signal?.addEventListener('abort', cancel, { once: true }); document.head.append(script);
  });
}
export class EbayClient {
  constructor(baseUrl = '') { this.baseUrl = baseUrl; }
  async #request(route, params, { signal } = {}) {
    const base = serviceUrl(this.baseUrl);
    if (isGoogleConnector(base)) {
      base.searchParams.set('action', route);
      for (const [key, value] of Object.entries(params)) base.searchParams.set(key, String(value));
      return jsonp(base, signal);
    }
    const url = new URL(base.href.replace(/\/$/, '') + (route === 'media' ? '/api/media' : '/api/ebay/' + route));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (route === 'media' && response.ok) return response.blob();
    const data = await response.json().catch(() => ({ error: 'Подключение eBay вернуло неожиданный ответ.' }));
    apiError(data);
    if (!response.ok) throw new Error('Ошибка подключения eBay: ' + response.status);
    return data;
  }
  search(article, page = 1, options) { return this.#request('search', { article, page }, options); }
  item(url, options) { return this.#request('item', { url }, options); }
  async download(url, options) {
    const result = await this.#request('media', { url }, options);
    if (result instanceof Blob) return result;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(result.mime) || typeof result.base64 !== 'string' || result.base64.length > 21 * 1024 * 1024) throw new Error('Подключение не вернуло изображение.');
    let decoded;
    try { decoded = atob(result.base64); } catch { throw new Error('Повреждённое изображение eBay. Повторите скачивание.'); }
    return new Blob([Uint8Array.from(decoded, c => c.charCodeAt(0))], { type: result.mime });
  }
}
