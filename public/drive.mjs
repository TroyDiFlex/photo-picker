import { titleFromText } from './core.mjs';

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FIELDS = 'id,name,mimeType,size,parents,thumbnailLink,webViewLink,resourceKey,capabilities(canDownload),shortcutDetails(targetId,targetMimeType,targetResourceKey)';
function quoted(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function abort(signal) { if (signal?.aborted) throw signal.reason || new DOMException('Отменено', 'AbortError'); }
export function matchesArticle(name, article) {
  const escaped = article.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Z0-9])' + escaped + '(?:VRN)?(?=$|[^A-Z0-9])', 'i').test(name);
}
export function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1251').decode(bytes); }
}

export class DriveClient {
  #token = ''; #expires = 0; #client; #pending; #generation = 0;
  #metadata = new Map();
  constructor({ clientId, rootFolderId, onAuthChange = () => {} }) {
    this.clientId = clientId; this.rootFolderId = rootFolderId; this.onAuthChange = onAuthChange;
  }
  get connected() { return Boolean(this.#token && Date.now() < this.#expires); }
  connect() {
    if (this.#pending) return this.#pending;
    if (!this.clientId) return Promise.reject(new Error('Для входа владелец сайта должен настроить Google Client ID.'));
    if (!globalThis.google?.accounts?.oauth2) return Promise.reject(new Error('Вход Google ещё не загрузился. Подождите или проверьте блокировщик.'));
    const generation = this.#generation;
    this.#pending = new Promise((resolve, reject) => {
      this.#client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId, scope: SCOPE,
        callback: response => {
          if (generation !== this.#generation) { reject(new Error('Вход отменён.')); return; }
          if (response.error || !response.access_token) { reject(new Error(response.error_description || response.error || 'Google не выдал доступ.')); return; }
          if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) { reject(new Error('Разрешите чтение файлов, чтобы искать фотографии.')); return; }
          this.#token = response.access_token; this.#expires = Date.now() + (Number(response.expires_in) - 30) * 1000;
          this.onAuthChange(true); resolve();
        },
        error_callback: error => reject(new Error(error.type === 'popup_closed' ? 'Окно входа закрыто.' : 'Не удалось открыть вход Google. Разрешите всплывающее окно.'))
      });
      this.#client.requestAccessToken({ prompt: 'select_account' });
    }).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  disconnect() {
    // Revoke is deliberately not called: logging out of this tab must not revoke
    // another open tab's consent. The access token was never persisted.
    this.#token = ''; this.#expires = 0; this.#metadata.clear(); this.#generation++;
    this.onAuthChange(false);
  }
  async #request(url, { signal, resourceKey, fileId } = {}) {
    abort(signal);
    if (!this.connected) { this.#token = ''; this.onAuthChange(false); throw new Error('Войдите в Google. Если сеанс истёк, войдите повторно.'); }
    const headers = { Authorization: 'Bearer ' + this.#token };
    if (resourceKey && fileId) headers['X-Goog-Drive-Resource-Keys'] = `${fileId}/${resourceKey}`;
    const response = await fetch(url, { headers, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
      if (response.status === 401) { this.#token = ''; this.onAuthChange(false); }
      const error = await response.json().catch(() => ({}));
      if (response.status === 403 || response.status === 404) throw new Error('Google Диск: нет доступа к файлу/папке либо скачивание запрещено. ' + (error.error?.message || ''));
      throw new Error('Google Диск: ' + (error.error?.message || response.status));
    }
    return response;
  }
  async #get(id, signal) {
    abort(signal);
    if (this.#metadata.has(id)) return this.#metadata.get(id);
    const params = new URLSearchParams({ fields: FIELDS, supportsAllDrives: 'true' });
    const result = await (await this.#request(`${API}/${encodeURIComponent(id)}?${params}`, { signal })).json();
    this.#metadata.set(id, result); return result;
  }
  async #list(q, signal) {
    const results = []; let pageToken = '';
    do {
      abort(signal);
      const params = new URLSearchParams({ q: 'trashed = false and (' + q + ')', pageSize: '1000', fields: `nextPageToken,incompleteSearch,files(${FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await this.#request(`${API}?${params}`, { signal })).json();
      if (data.incompleteSearch) throw new Error('Google вернул неполные результаты поиска. Повторите поиск.');
      for (const item of data.files || []) { this.#metadata.set(item.id, item); results.push(item); }
      pageToken = data.nextPageToken || '';
      if (pageToken && results.length >= 10000) throw new Error('Слишком много совпадений на Диске. Уточните артикул.');
    } while (pageToken);
    return results;
  }
  async #insideRoot(item, signal) {
    const queue = [item], visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (current.id === this.rootFolderId) return true;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      if (visited.size > 100) throw new Error('Слишком глубокая структура папок Google Диска.');
      for (const parent of current.parents || []) {
        if (parent === this.rootFolderId) return true;
        try { queue.push(await this.#get(parent, signal)); }
        catch (error) { abort(signal); if (!this.connected) throw error; /* Inaccessible parent outside the shared root. */ }
      }
    }
    return false;
  }
  async search(article, { signal } = {}) {
    await this.#get(this.rootFolderId, signal); // Fail clearly when this user cannot access the supplied folder.
    const folders = new Map();
    const query = `(mimeType = ${quoted(FOLDER)} or mimeType = ${quoted(SHORTCUT)}) and (name contains ${quoted(article)} or name contains ${quoted(article.toLowerCase())})`;
    const directFolders = await this.#list(`${quoted(this.rootFolderId)} in parents and (mimeType = ${quoted(FOLDER)} or mimeType = ${quoted(SHORTCUT)})`, signal);
    const candidates = new Map([...directFolders, ...await this.#list(query, signal)].map(file => [file.id, file]));
    for (const candidate of candidates.values()) {
      if (matchesArticle(candidate.name, article) && await this.#insideRoot(candidate, signal)) {
        if (candidate.mimeType === FOLDER) folders.set(candidate.id, candidate);
        else if (candidate.shortcutDetails?.targetMimeType === FOLDER) {
          // A shortcut explicitly located in the selected root is part of that collection.
          const target = await this.#get(candidate.shortcutDetails.targetId, signal);
          folders.set(target.id, target);
        }
      }
    }
    const files = new Map(), visited = new Set(), queue = [...folders.values()];
    while (queue.length) {
      const folder = queue.shift();
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      if (visited.size > 500) throw new Error('В артикуле больше 500 вложенных папок. Сузьте папку поиска.');
      for (let file of await this.#list(`${quoted(folder.id)} in parents`, signal)) {
        if (file.mimeType === SHORTCUT) {
          if (file.shortcutDetails?.targetMimeType === FOLDER) continue; // Avoid traversing unrelated linked trees.
          file = await this.#get(file.shortcutDetails.targetId, signal);
        }
        if (file.mimeType === FOLDER) queue.push(file);
        else files.set(file.id, file);
      }
      if (files.size > 5000) throw new Error('В артикуле больше 5000 файлов. Сузьте папку поиска.');
    }
    // Some collections store files directly in the root, with the SKU in the filename.
    for (const file of await this.#list(`${quoted(this.rootFolderId)} in parents and mimeType != ${quoted(FOLDER)} and (name contains ${quoted(article)} or name contains ${quoted(article.toLowerCase())})`, signal)) {
      if (matchesArticle(file.name, article) && file.mimeType !== SHORTCUT) files.set(file.id, file);
    }
    const result = [...files.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    let folderName = null;
    for (const file of result.filter(f => (/\.txt$/i.test(f.name) || f.mimeType === 'text/plain') && Number(f.size || 0) <= 1048576)) {
      const blob = await this.download(file, { signal });
      folderName = titleFromText(decodeText(await blob.arrayBuffer()), article);
      if (folderName) break;
    }
    return { foldersFound: folders.size, folderName, files: result.map(file => ({ ...file, thumbnailUrl: file.thumbnailLink || '', previewUrl: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` })) };
  }
  async download(file, { signal } = {}) {
    if (file.capabilities?.canDownload === false) throw new Error(`Владелец запретил скачивание: ${file.name}`);
    let url;
    if (file.mimeType === 'application/vnd.google-apps.document') url = `${API}/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`;
    else if (file.mimeType?.startsWith('application/vnd.google-apps.')) throw new Error(`Скачивание этого типа файла не поддерживается: ${file.name}`);
    else url = `${API}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    return (await this.#request(url, { signal, resourceKey: file.resourceKey, fileId: file.id })).blob();
  }
  async thumbnail(file, { signal } = {}) {
    // thumbnailLink has no supported cross-origin JS access. Images are fetched
    // from Drive's authenticated media endpoint, never through the eBay service.
    if (!file.mimeType?.startsWith('image/') || file.mimeType === 'image/svg+xml' || Number(file.size || 0) > 12 * 1024 * 1024) return null;
    return this.download(file, { signal });
  }
}
