import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient } from '../public/drive.mjs';

test('Drive confines matches to collection and reads private files with user token', async () => {
  const originalGoogle = globalThis.google, originalFetch = globalThis.fetch;
  const folder = (id, name, parents) => ({ id, name, parents, mimeType: 'application/vnd.google-apps.folder' });
  const root = folder('collection', 'Фото', []), good = folder('good', 'Насос 038145209VRN', ['collection']), unrelated = folder('unrelated', '038145209VRN', ['elsewhere']);
  const photo = { id: 'photo', name: 'Фото.jpg', mimeType: 'image/jpeg', parents: ['good'], size: '4' };
  const txt = { id: 'txt', name: 'Название.txt', mimeType: 'text/plain', parents: ['good'], size: '40' };
  const requests = [];
  globalThis.google = { accounts: { oauth2: {
    hasGrantedAllScopes: () => true,
    initTokenClient: options => ({ requestAccessToken() { options.callback({ access_token: 'test-private-token', expires_in: 3600 }); } })
  } } };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); requests.push(url);
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer test-private-token');
    assert.equal(options.credentials, 'omit');
    if (url.pathname.endsWith('/collection')) return Response.json(root);
    if (url.pathname.endsWith('/elsewhere')) return Response.json(folder('elsewhere', 'Личное', []));
    if (url.pathname.endsWith('/txt')) return new Response('Наименование: Насос вакуумный');
    if (url.pathname.endsWith('/photo')) return new Response('jpeg');
    const q = url.searchParams.get('q');
    if (q.includes("'good' in parents")) return Response.json({ files: [photo, txt] });
    if (q.includes("'collection' in parents") && q.includes('mimeType !=')) return Response.json({ files: [] });
    if (q.includes("'collection' in parents")) return Response.json({ files: [good] });
    return Response.json({ files: [good, unrelated] });
  };
  try {
    const client = new DriveClient({ clientId: 'test', rootFolderId: root.id });
    await client.connect();
    const result = await client.search('038145209');
    assert.equal(result.folderName, 'Насос вакуумный');
    assert.equal(result.foldersFound, 1);
    assert.deepEqual(result.files.map(f => f.id).sort(), ['photo', 'txt']);
    assert.ok(!requests.some(u => u.searchParams.get('q')?.includes("'unrelated' in parents")));
    assert.equal(await (await client.download(photo)).text(), 'jpeg');
    client.disconnect();
    assert.equal(client.connected, false);
    await assert.rejects(client.download(photo), /Войдите в Google/);
  } finally { globalThis.google = originalGoogle; globalThis.fetch = originalFetch; }
});

test('Drive denies missing folder access instead of falsely reporting missing photos', async () => {
  const originalGoogle = globalThis.google, originalFetch = globalThis.fetch;
  globalThis.google = { accounts: { oauth2: { hasGrantedAllScopes: () => true, initTokenClient: options => ({ requestAccessToken() { options.callback({ access_token: 'test', expires_in: 3600 }); } }) } } };
  globalThis.fetch = async () => Response.json({ error: { message: 'File not found' } }, { status: 404 });
  try {
    const client = new DriveClient({ clientId: 'test', rootFolderId: 'private' });
    await client.connect();
    await assert.rejects(client.search('038145209'), /нет доступа/);
  } finally { globalThis.google = originalGoogle; globalThis.fetch = originalFetch; }
});
