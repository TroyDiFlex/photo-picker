import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArticle, safeItemUrl, safeMediaUrl, parseSearchHtml, parseItemHtml } from '../lib/ebay.mjs';
import { createServer } from '../server.mjs';

test('normalizes article suffix and rejects query injection', () => {
  assert.equal(normalizeArticle(' 038145209VRN '), '038145209');
  assert.equal(normalizeArticle('5Q0965561Bvrn'), '5Q0965561B');
  for (const value of ['', 'x&y=1', '../test', 'a'.repeat(81)]) assert.throws(() => normalizeArticle(value));
});
test('restricts item URLs and removes tracking', () => {
  assert.equal(safeItemUrl('https://www.ebay.com/itm/a-title/123456789123?x=1').href, 'https://www.ebay.com/itm/123456789123');
  for (const value of ['https://ebay.com.evil.test/itm/123456789123', 'https://user@www.ebay.com/itm/123456789123', 'http://www.ebay.com/itm/123456789123', 'https://127.0.0.1/itm/123456789123', 'https://www.ebay.com:123/itm/123456789123', 'https://www.ebay.com/other/123456789123']) assert.throws(() => safeItemUrl(value));
});
test('media URL validation prevents SSRF and SVG/HTML endpoints', () => {
  assert.equal(safeMediaUrl('https://i.ebayimg.com/images/g/abc/s-l500.jpg').hostname, 'i.ebayimg.com');
  for (const value of ['https://localhost/images/a.jpg', 'https://i.ebayimg.com.evil.test/images/a.jpg', 'http://i.ebayimg.com/images/a.jpg', 'https://i.ebayimg.com/foo', 'https://i.ebayimg.com@127.0.0.1/images/a.jpg']) assert.throws(() => safeMediaUrl(value));
});
test('search extracts only listing cards and deduplicates, not ads or recommendation images', () => {
  const card = `<li class="s-item s-item__pl-on-bottom"><div><a href="https://www.ebay.com/itm/123456789123?hash=item"><div class="s-item__title">New Listing Water &amp; oil pump</div></a><img src="https://i.ebayimg.com/images/g/abc/s-l225.jpg"></div></li>`;
  const html = `<img src="https://i.ebayimg.com/images/g/advert/s-l500.jpg">${card}${card}<a class="pagination__next" href="?page=2">Next</a>`;
  const result = parseSearchHtml(html, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Water & oil pump');
  assert.equal(result.items[0].images[0].url, 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg');
  assert.equal(result.hasMore, true);
});
test('supports newer s-card result markup', () => {
  const result = parseSearchHtml(`<li class='s-card'><a href='https://www.ebay.com/itm/234567891234'><div class='s-card__title'>A pump</div></a><img data-src='https://i.ebayimg.com/images/g/def/s-l500.webp'></li>`);
  assert.equal(result.items[0].id, '234567891234');
  assert.equal(result.items[0].title, 'A pump');
});
test('empty page reports parse uncertainty separately from a genuine no-results page', () => {
  assert.equal(parseSearchHtml('<html>unknown format</html>').warnings.length, 1);
  assert.equal(parseSearchHtml('<h1>No results found</h1>').warnings.length, 0);
});
test('extracts Product JSON-LD and gallery only, including nested graphs and duplicate sizes', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'Product', name: 'Pump', image: ['https://i.ebayimg.com/images/g/a/s-l500.jpg', { url: 'https://i.ebayimg.com/images/g/b/s-l1600.jpg' }] }] })}</script><button class="ux-image-filmstrip-carousel-item"><img src="https://i.ebayimg.com/images/g/a/s-l64.jpg"></button><img src="https://i.ebayimg.com/images/g/recommendation/s-l1600.jpg">`;
  const result = parseItemHtml(html, 'https://www.ebay.com/itm/123456789123');
  assert.equal(result.title, 'Pump');
  assert.equal(result.images.length, 2);
  assert.ok(result.images.every((image) => !image.url.includes('recommendation')));
});
test('CORS denies unconfigured origins and health endpoint needs no external service', async () => {
  const server = createServer({ allowedOrigins: 'https://example.github.io' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/health`;
    const allowed = await fetch(url, { headers: { Origin: 'https://example.github.io' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.github.io');
    assert.equal((await allowed.json()).ok, true);
    const denied = await fetch(url, { headers: { Origin: 'https://evil.test' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
