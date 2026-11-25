import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildAppsScript } from '../scripts/build-apps-script.mjs';

const source = await buildAppsScript();
function runtime(responses = []) {
  const calls = [], cache = new Map();
  const context = vm.createContext({
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options });
      const fixture = responses.shift();
      if (!fixture) throw new Error('Unexpected request: ' + url);
      const body = fixture.body || '';
      return { getResponseCode: () => fixture.status || 200, getAllHeaders: () => fixture.headers || { 'Content-Type': 'text/html; charset=utf-8' }, getContent: () => Array.from(Buffer.from(body)), getContentText: () => body };
    } },
    CacheService: { getScriptCache: () => ({ get: (key) => cache.get(key), put: (key, value) => cache.set(key, value) }) },
    Utilities: { base64Encode: (bytes) => Buffer.from(bytes).toString('base64') },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'js' }, createTextOutput: (value) => ({ value, setMimeType(type) { this.type = type; return this; } }) }
  });
  vm.runInContext(source, context);
  return { calls, get: (parameter) => context.doGet({ parameter }) };
}
test('Apps Script manifest requests only external public URL access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../google-apps-script/appsscript.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.external_request']);
  assert.ok(!source.includes('DriveApp'));
  assert.ok(!source.includes('new URL('));
});
test('health supports JSONP with a restricted callback', () => {
  const script = runtime();
  const output = script.get({ action: 'health', callback: 'pp_123_a' });
  assert.equal(output.type, 'js');
  assert.match(output.value, /^pp_123_a\(\{"ok":true/);
  assert.equal(script.calls.length, 0);
  const invalid = script.get({ action: 'health', callback: 'pp_a);alert(1)//' });
  assert.equal(invalid.type, 'json');
  assert.equal(JSON.parse(invalid.value).code, 'INVALID_CALLBACK');
});
test('search uses shared parser, strips VRN, and caches public results', () => {
  const script = runtime([{ body: '<li class="s-item"><a href="https://www.ebay.com/itm/123456789123"><div class="s-item__title">Pump</div></a><img src="https://i.ebayimg.com/images/g/a/s-l500.jpg"></li>' }]);
  const first = JSON.parse(script.get({ action: 'search', article: '038145209VRN', page: '1' }).value);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].title, 'Pump');
  assert.ok(script.calls[0].url.includes('_nkw=038145209&'));
  assert.equal(script.calls[0].options.followRedirects, false);
  script.get({ action: 'search', article: '038145209', page: '1' });
  assert.equal(script.calls.length, 1);
});
test('403 and captcha produce explicit blocked errors', () => {
  for (const fixture of [{ status: 403 }, { body: '<title>Pardon Our Interruption</title>' }]) {
    const script = runtime([fixture]);
    const result = JSON.parse(script.get({ action: 'search', article: '038145209' }).value);
    assert.equal(result.code, 'EBAY_BLOCKED');
    assert.equal(result.status, 503);
  }
});
test('item uses shared JSON-LD parser and excludes unrelated images', () => {
  const body = '<script type="application/ld+json">{"@type":"Product","name":"Pump","image":["https://i.ebayimg.com/images/g/a/s-l500.jpg"]}</script><img src="https://i.ebayimg.com/images/g/ads/s-l500.jpg">';
  const script = runtime([{ body }]);
  const result = JSON.parse(script.get({ action: 'item', url: 'https://www.ebay.com/itm/123456789123?tracking=x' }).value);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, 'https://i.ebayimg.com/images/g/a/s-l1600.jpg');
  assert.equal(script.calls[0].url, 'https://www.ebay.com/itm/123456789123');
});
test('media returns base64 and MIME, rejects arbitrary hosts and unsafe redirects', () => {
  const script = runtime([{ body: 'image-bytes', headers: { 'content-type': 'image/jpeg' } }]);
  const result = JSON.parse(script.get({ action: 'media', url: 'https://i.ebayimg.com/images/g/a/s-l1600.jpg' }).value);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(Buffer.from(result.base64, 'base64').toString(), 'image-bytes');
  for (const url of ['https://127.0.0.1/images/a', 'https://i.ebayimg.com.evil.test/images/a', 'https://i.ebayimg.com:443/images/a', 'https://i.ebayimg.com@evil.test/images/a', 'http://i.ebayimg.com/images/a']) {
    assert.equal(JSON.parse(script.get({ action: 'media', url }).value).code, 'INVALID_URL');
  }
  const redirect = runtime([{ status: 302, headers: { location: 'https://evil.test/steal' } }]);
  assert.equal(JSON.parse(redirect.get({ action: 'media', url: 'https://i.ebayimg.com/images/g/a/s-l1600.jpg' }).value).code, 'INVALID_URL');
  assert.equal(redirect.calls.length, 1);
});
test('media rejects HTML and oversized bodies and pages reject invalid parameters', () => {
  const html = runtime([{ body: '<html>not an image</html>', headers: { 'Content-Type': 'text/html' } }]);
  assert.equal(JSON.parse(html.get({ action: 'media', url: 'https://i.ebayimg.com/images/g/a/s-l500.jpg' }).value).code, 'INVALID_MEDIA');
  const large = runtime([{ body: '', headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '20000000' } }]);
  assert.equal(JSON.parse(large.get({ action: 'media', url: 'https://i.ebayimg.com/images/g/a/s-l500.jpg' }).value).code, 'RESPONSE_TOO_LARGE');
  const validation = runtime();
  assert.equal(JSON.parse(validation.get({ action: 'search', article: 'abc', page: '51' }).value).code, 'INVALID_PAGE');
  assert.equal(JSON.parse(validation.get({ action: 'item', url: 'https://www.ebay.com/sch/i.html' }).value).code, 'INVALID_URL');
  assert.equal(validation.calls.length, 0);
});
