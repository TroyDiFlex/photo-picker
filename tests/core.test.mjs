import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticles, sanitizeFolderName, sanitizeFileName, titleFromText, crc32, buildZip } from '../public/core.mjs';
import { matchesArticle, decodeText, DriveClient } from '../public/drive.mjs';

test('user input: VRN suffix, Markdown table, trailing backslashes, duplicates', () => {
  assert.deepEqual(parseArticles('17128579334VRN\\\n17128616914VRN\\\n| 038145209VRN |\n| ------------ |\n| A2710703501VRN |\n038145209\n5q0965561bvrn'), ['17128579334', '17128616914', '038145209', 'A2710703501', '5Q0965561B']);
  assert.deepEqual(parseArticles('<script>alert(1)</script>\n../abc\n| --- |'), []);
});
test('Windows names cannot escape folders or use reserved names', () => {
  assert.equal(sanitizeFolderName(' ..\\Втулка / рычаг: 1? '), '.. Втулка рычаг 1');
  assert.equal(sanitizeFolderName('CON'), '_CON');
  assert.equal(sanitizeFileName('NUL.txt'), '_NUL.txt');
  assert.equal(sanitizeFolderName('..'), 'Фотографии');
});
test('text naming prefers explicit product name and supports original first-line form', () => {
  assert.equal(titleFromText('Артикул: 038145209\nНаименование: Насос вакуумный\nОписание...', '038145209'), 'Насос вакуумный');
  assert.equal(titleFromText('038145209VRN\nНасос вакуумный\nОписание', '038145209'), 'Насос вакуумный');
});
test('folder match does not confuse close part numbers', () => {
  assert.equal(matchesArticle('Насос 038145209VRN', '038145209'), true);
  assert.equal(matchesArticle('038145209A', '038145209'), false);
  assert.equal(matchesArticle('1038145209', '038145209'), false);
});
test('Russian TXT supports UTF-8, Windows-1251 and UTF-16', () => {
  assert.equal(decodeText(new TextEncoder().encode('Насос').buffer), 'Насос');
  assert.equal(decodeText(Uint8Array.from([0xcd, 0xe0, 0xf1, 0xee, 0xf1]).buffer), 'Насос');
  assert.equal(decodeText(Uint8Array.from([255, 254, 29, 4, 48, 4]).buffer), 'На');
});
test('ZIP includes UTF-8 directory, valid CRC and unique duplicate names', async () => {
  const zip = await buildZip(['one', 'two'].map(text => ({ path: 'Насос/фото.jpg', load: async () => new Blob([text]) })));
  const bytes = new Uint8Array(await zip.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x800);
  assert.equal(view.getUint32(14, true), crc32(new TextEncoder().encode('one')));
  const raw = new TextDecoder().decode(bytes);
  assert.match(raw, /Насос\/фото\.jpg/); assert.match(raw, /Насос\/фото \(2\)\.jpg/);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), 2);
});
test('ZIP cancellation and memory limits fail without incomplete archive', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(buildZip([{ path: 'a.jpg', load: async () => new Blob(['1']) }], { signal }), { name: 'AbortError' });
  await assert.rejects(buildZip([{ path: 'a.jpg', load: async () => new Blob(['123']) }], { maxBytes: 2 }), /512 МБ/);
  await assert.rejects(buildZip([{ path: '../a.jpg', load: async () => new Blob() }]), /Некорректный путь/);
});
test('private Drive requests require the current user to sign in', async () => {
  const client = new DriveClient({ clientId: '', rootFolderId: 'private' });
  await assert.rejects(client.connect(), /Client ID/);
  await assert.rejects(client.search('038145209'), /Войдите в Google/);
});
