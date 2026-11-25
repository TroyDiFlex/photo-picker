import { parseArticles, sanitizeFolderName, sanitizeFileName, downloadZip } from './core.mjs';
import { DriveClient } from './drive.mjs';
import { EbayClient } from './ebay-client.mjs';

const $ = id => document.getElementById(id);
const defaults = { googleClientId: '', backendUrl: '', rootFolderId: '1-5L2u0-VwwXCuBYR0vHH-_0dumzUR0Gr', ...window.PHOTO_PICKER_CONFIG };
let overrides = {};
try { overrides = JSON.parse(localStorage.getItem('photo-picker-settings') || '{}'); } catch { /* storage may be unavailable */ }
let config = { ...defaults, ...overrides };
let drive;
let ebay;
let states = [];
let searchController = null;
let downloadController = null;
let generation = 0;
let downloadBusy = false;
const objectUrls = new Map();
const thumbnailJobs = new Map();
let thumbnailActive = 0;
const thumbnailQueue = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function ebaySearch(article) { return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(article)}&rt=nc&LH_ItemCondition=3`; }
function externalLink(text, href, className) {
  const link = el('a', className, text);
  link.href = safeUrl(href) || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
function notify(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
}
function describeError(error) {
  if (error?.name === 'AbortError') return 'Операция отменена.';
  if (error?.code === 'EBAY_BLOCKED') return 'eBay отклонил запрос. Сейчас фотографии автоматически недоступны. Можно открыть поиск на eBay.';
  return error?.message || 'Не удалось получить данные. Попробуйте ещё раз.';
}
function isCurrent(version) { return version === generation && !searchController?.signal.aborted; }
function authChanged() {
  if (!drive) return;
  $('connect').textContent = drive.connected ? 'Выйти из Google' : 'Войти через Google';
}
function createDrive() {
  drive = new DriveClient({ clientId: config.googleClientId, rootFolderId: config.rootFolderId, onAuthChange: authChanged });
  ebay = new EbayClient(config.backendUrl || (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.origin : ''));
  authChanged();
}
function syncSettings() {
  $('client-id').value = config.googleClientId || '';
  $('backend-url').value = config.backendUrl || '';
  $('settings-status').textContent = config.googleClientId ? '' : 'Google Диск ещё не подключён';
}
async function connect() {
  if (downloadBusy) { notify('Дождитесь завершения скачивания или отмените его.'); return; }
  if (drive.connected) {
    drive.disconnect();
    authChanged();
    clearSearch();
    states = [];
    $('results').replaceChildren(el('div', 'empty', 'Вы вышли из Google. Войдите, чтобы снова найти файлы Диска.'));
    updateSelection();
    return;
  }
  if (!config.googleClientId) {
    $('settings').open = true;
    $('client-id').focus();
    notify('Для входа нужен Google OAuth Client ID владельца сайта. Он задаётся один раз в настройках страницы.');
    return;
  }
  $('connect').disabled = true;
  try {
    await drive.connect();
    authChanged();
    notify('Вход выполнен. Приложение ищет файлы только в папке фотографий.');
    if ($('articles').value.trim()) await startSearch();
  } catch (error) { notify(describeError(error), true); }
  finally { $('connect').disabled = false; }
}
function clearSearch() {
  searchController?.abort();
  generation += 1;
  searchController = new AbortController();
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  thumbnailJobs.clear();
}
function updateSelection() {
  const count = states.reduce((sum, state) => sum + state.selected.size, 0);
  $('selected-count').textContent = String(count);
  $('download').disabled = count === 0 || downloadBusy;
  $('results-count').textContent = states.length ? `${states.length} арт. · выбрано файлов: ${count}` : '';
}
function fileKey(source, file) { return `${source}:${source === 'drive' ? file.id : file.url}`; }
function toggleFile(state, source, file, checked, tile) {
  const key = fileKey(source, file);
  if (checked) state.selected.set(key, { source, file }); else state.selected.delete(key);
  tile?.classList.toggle('selected', checked);
  updateDriveCheckbox(state);
  updateSelection();
}
function updateDriveCheckbox(state) {
  if (!state.selectAll) return;
  const count = state.drive.files.filter(file => state.selected.has(fileKey('drive', file))).length;
  state.selectAll.checked = state.drive.files.length > 0 && count === state.drive.files.length;
  state.selectAll.indeterminate = count > 0 && count < state.drive.files.length;
  state.selectAll.disabled = state.drive.files.length === 0 || state.drive.loading;
}
function sizeLabel(size) {
  const bytes = Number(size);
  if (!bytes) return '';
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
function queueThumbnail(file, version) {
  const cacheKey = `${version}:${file.id}`;
  if (thumbnailJobs.has(cacheKey)) return thumbnailJobs.get(cacheKey);
  const job = new Promise(resolve => {
    thumbnailQueue.push(async () => {
      if (!isCurrent(version)) { resolve(null); return; }
      try {
        const blob = await drive.thumbnail(file, { signal: searchController.signal });
        if (!blob || !isCurrent(version)) { resolve(null); return; }
        const url = URL.createObjectURL(blob);
        objectUrls.set(cacheKey, url);
        resolve(url);
      } catch { resolve(null); }
    });
    drainThumbnails();
  });
  thumbnailJobs.set(cacheKey, job);
  return job;
}
function drainThumbnails() {
  while (thumbnailActive < 4 && thumbnailQueue.length) {
    const job = thumbnailQueue.shift();
    thumbnailActive += 1;
    job().finally(() => { thumbnailActive -= 1; drainThumbnails(); });
  }
}
function fileTile(state, source, file, version) {
  const selected = state.selected.has(fileKey(source, file));
  const tile = el('div', `file-tile${selected ? ' selected' : ''}`);
  const label = el('label', 'file-check');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected;
  checkbox.setAttribute('aria-label', `Выбрать ${file.name || 'фотографию eBay'}`);
  checkbox.addEventListener('change', () => toggleFile(state, source, file, checkbox.checked, tile));
  label.append(checkbox);
  const mime = file.mimeType || 'image/jpeg';
  const preview = externalLink('', source === 'drive' ? file.previewUrl || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` : file.url, 'file-preview');
  preview.setAttribute('aria-label', `Открыть ${file.name || 'фотографию'}`);
  const isImage = mime.startsWith('image/');
  const symbol = el('span', 'file-symbol', isImage ? '▧' : mime.startsWith('video/') ? '▷' : 'TXT');
  preview.append(symbol);
  if (isImage || mime.startsWith('video/')) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove());
    if (source === 'drive') {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        queueThumbnail(file, version).then(url => {
          if (!url || !isCurrent(version) || !preview.isConnected) return;
          image.src = url;
          preview.replaceChildren(image);
        });
      }, { rootMargin: '120px' });
      observer.observe(tile);
      // Detached cards from a new search must not retain observers indefinitely.
      searchController.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    } else {
      const imageUrl = safeUrl(file.thumbnail || file.url);
      if (imageUrl) { image.src = imageUrl; preview.replaceChildren(image); }
    }
  }
  const info = el('div', 'file-info');
  const title = el('span', 'file-title', file.name || 'Фотография eBay');
  title.title = file.name || 'Фотография eBay';
  const type = isImage ? 'Фото' : mime.startsWith('video/') ? 'Видео' : mime.startsWith('text/') ? 'Текст' : 'Файл';
  info.append(title, el('div', 'file-meta', [type, sizeLabel(file.size)].filter(Boolean).join(' · ')));
  tile.append(label, preview, info);
  return tile;
}
function panelMessage(text, error = false) {
  const box = el('div', `panel-message${error ? ' error' : ''}`);
  box.append(el('p', '', text));
  return box;
}
function renderDrive(state, version) {
  const panel = state.panel;
  panel.replaceChildren();
  if (state.drive.loading) { panel.append(panelMessage('Ищем файлы на Google Диске…')); return; }
  if (!drive.connected) {
    const box = panelMessage('Войдите через Google, чтобы искать в папке фотографий. Используются права вашего аккаунта.');
    box.append(button('Войти через Google', 'button secondary', connect));
    panel.append(box);
    return;
  }
  if (state.drive.error) {
    const box = panelMessage(state.drive.error, true);
    box.append(button('Повторить поиск', 'button secondary', () => loadDrive(state, version)));
    panel.append(box);
    return;
  }
  if (!state.drive.loaded) {
    const box = panelMessage('Поиск на Google Диске ещё не выполнен.');
    box.append(button('Найти файлы', 'button secondary', () => loadDrive(state, version)));
    panel.append(box);
    return;
  }
  if (!state.drive.files.length) { panel.append(panelMessage(state.drive.foldersFound ? 'Папка найдена, файлов нет.' : 'Папка с этим артикулом не найдена.')); return; }
  if (!state.drive.files.some(file => file.mimeType?.startsWith('image/'))) panel.append(el('div', 'inline-warning', 'Фотографий на Диске нет. Остальные файлы можно выбрать здесь.'));
  const grid = el('div', 'file-grid');
  state.drive.files.forEach(file => grid.append(fileTile(state, 'drive', file, version)));
  panel.append(grid);
}
function renderEbay(state, version) {
  const panel = state.panel;
  panel.replaceChildren();
  if (!state.ebay.loaded && !state.ebay.loading && !state.ebay.error) {
    const box = panelMessage('Фотографии из объявлений eBay.');
    box.append(button('Найти на eBay', 'button secondary', () => loadEbay(state, version)));
    panel.append(box);
    return;
  }
  if (state.ebay.error) {
    const box = panelMessage(state.ebay.error, true);
    box.append(button('Повторить', 'button secondary', () => loadEbay(state, version, state.ebay.page + 1)));
    box.append(document.createTextNode(' '), externalLink('Открыть eBay', ebaySearch(state.article), 'button secondary'));
    panel.append(box);
  }
  state.ebay.warnings.forEach(warning => panel.append(el('div', 'inline-warning', warning)));
  state.ebay.items.forEach(item => {
    const listing = el('div', 'listing');
    const header = el('div', 'listing-header');
    header.append(externalLink(item.title || 'Объявление eBay', item.url, 'listing-title'));
    const more = button(item.loading ? 'Загружаем…' : item.expanded ? 'Галерея загружена' : 'Все фото объявления', 'text-button', () => loadItem(state, item, version));
    more.disabled = item.loading || item.expanded;
    header.append(more);
    listing.append(header);
    if (item.error) listing.append(el('div', 'inline-warning', item.error));
    const grid = el('div', 'file-grid');
    item.images.forEach(file => grid.append(fileTile(state, 'ebay', file, version)));
    listing.append(grid);
    panel.append(listing);
  });
  if (state.ebay.loading) panel.append(panelMessage('Ищем фотографии на eBay…'));
  else if (state.ebay.loaded && !state.ebay.items.length && !state.ebay.error) panel.append(panelMessage('По этому артикулу фотографии не найдены.'));
  if (state.ebay.hasMore && !state.ebay.loading && !state.ebay.error) panel.append(button('Показать следующие объявления', 'button secondary load-more', () => loadEbay(state, version, state.ebay.page + 1)));
}
function refreshCard(state, version) {
  if (!isCurrent(version)) return;
  state.driveTab.setAttribute('aria-selected', String(state.source === 'drive'));
  state.ebayTab.setAttribute('aria-selected', String(state.source === 'ebay'));
  state.driveTab.textContent = `Google Диск${state.drive.loaded ? ` · ${state.drive.files.length}` : ''}`;
  state.ebayTab.textContent = `eBay${state.ebay.items.length ? ` · ${state.ebay.items.reduce((sum, item) => sum + item.images.length, 0)}` : ''}`;
  state.panel.setAttribute('aria-labelledby', state.source === 'drive' ? state.driveTab.id : state.ebayTab.id);
  state.source === 'drive' ? renderDrive(state, version) : renderEbay(state, version);
  updateDriveCheckbox(state);
}
function articleCard(state, index, version) {
  const card = el('article', 'article-card');
  const header = el('div', 'article-header');
  header.append(el('h3', 'article-name', state.article));
  const select = el('label', 'drive-select');
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  selectAll.disabled = true;
  selectAll.addEventListener('change', () => {
    const checked = selectAll.checked;
    state.drive.files.forEach(file => toggleFile(state, 'drive', file, checked));
    refreshCard(state, version);
  });
  state.selectAll = selectAll;
  select.append(selectAll, document.createTextNode('Все файлы Диска'));
  header.append(select);
  const folderLabel = el('label', 'folder-field', 'Папка');
  const folder = document.createElement('input');
  folder.value = state.folderName;
  folder.setAttribute('aria-label', `Название папки для ${state.article}`);
  folder.addEventListener('input', () => { state.folderName = folder.value; state.folderEdited = true; });
  folderLabel.append(folder);
  state.folderInput = folder;
  header.append(folderLabel);
  const tabs = el('div', 'source-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', `Источник для ${state.article}`);
  const switchSource = source => {
    state.source = source;
    if (source === 'ebay' && !state.ebay.loaded && !state.ebay.loading) loadEbay(state, version);
    refreshCard(state, version);
  };
  state.driveTab = button('Google Диск', 'tab', () => switchSource('drive'));
  state.ebayTab = button('eBay', 'tab', () => switchSource('ebay'));
  [state.driveTab, state.ebayTab].forEach((tab, sourceIndex) => {
    tab.id = `tab-${index}-${sourceIndex}-${version}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${index}-${version}`);
  });
  tabs.append(state.driveTab, state.ebayTab);
  state.panel = el('div', 'source-panel');
  state.panel.id = `panel-${index}-${version}`;
  state.panel.setAttribute('role', 'tabpanel');
  const footer = el('div', 'article-footer');
  footer.append(el('span', '', 'ZIP → папка артикула → выбранные файлы'), externalLink('Поиск на eBay', ebaySearch(state.article)));
  card.append(header, tabs, state.panel, footer);
  refreshCard(state, version);
  return card;
}
async function loadDrive(state, version) {
  if (!isCurrent(version) || state.drive.loading || !drive.connected) return;
  state.drive.loading = true;
  state.drive.error = '';
  refreshCard(state, version);
  try {
    const data = await drive.search(state.article, { signal: searchController.signal });
    if (!isCurrent(version)) return;
    state.drive.files = data.files || [];
    state.drive.foldersFound = data.foldersFound || 0;
    state.drive.loaded = true;
    if (data.folderName && !state.folderEdited) {
      state.folderName = data.folderName;
      state.folderInput.value = data.folderName;
    }
    if (!state.drive.files.some(file => file.mimeType?.startsWith('image/'))) {
      state.source = 'ebay';
      await loadEbay(state, version);
    }
  } catch (error) { if (isCurrent(version)) state.drive.error = describeError(error); }
  finally { if (isCurrent(version)) { state.drive.loading = false; refreshCard(state, version); } }
}
function normalizeImages(images, title) {
  const seen = new Set();
  return (images || []).filter(image => {
    try {
      const url = new URL(image.url);
      if (url.protocol !== 'https:' || !(url.hostname === 'i.ebayimg.com' || url.hostname.endsWith('.ebayimg.com')) || seen.has(url.href)) return false;
      seen.add(url.href);
      return true;
    } catch { return false; }
  }).map((image, index) => {
    const extension = new URL(image.url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase() || 'jpg';
    return { ...image, name: image.name || `${title || 'eBay'} ${index + 1}.${extension}`, mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}` };
  });
}
async function loadEbay(state, version, page = 1) {
  if (!isCurrent(version) || state.ebay.loading) return;
  state.ebay.loading = true;
  state.ebay.error = '';
  refreshCard(state, version);
  try {
    const data = await ebay.search(state.article, page, { signal: searchController.signal });
    if (!isCurrent(version)) return;
    const ids = new Set(state.ebay.items.map(item => item.id || item.url));
    for (const item of data.items || []) {
      const id = item.id || item.url;
      if (ids.has(id)) continue;
      ids.add(id);
      state.ebay.items.push({ ...item, images: normalizeImages(item.images, item.title), expanded: false, loading: false, error: '' });
    }
    state.ebay.page = data.page || page;
    state.ebay.loaded = true;
    state.ebay.hasMore = Boolean(data.hasMore);
    state.ebay.warnings = (data.warnings || []).filter(warning => typeof warning === 'string');
  } catch (error) { if (isCurrent(version)) state.ebay.error = describeError(error); }
  finally { if (isCurrent(version)) { state.ebay.loading = false; refreshCard(state, version); } }
}
async function loadItem(state, item, version) {
  if (!isCurrent(version) || item.loading || item.expanded) return;
  item.loading = true;
  item.error = '';
  refreshCard(state, version);
  try {
    const data = await ebay.item(item.url, { signal: searchController.signal });
    if (!isCurrent(version)) return;
    const images = normalizeImages(data.images, item.title);
    const seen = new Set(item.images.map(file => file.url));
    images.forEach(file => { if (!seen.has(file.url)) { seen.add(file.url); item.images.push(file); } });
    item.expanded = true;
  } catch (error) { if (isCurrent(version)) item.error = describeError(error); }
  finally { if (isCurrent(version)) { item.loading = false; refreshCard(state, version); } }
}
async function startSearch(event) {
  event?.preventDefault();
  const articles = parseArticles($('articles').value);
  if (!articles.length) { notify('Вставьте хотя бы один артикул.', true); return; }
  if (articles.length > 100) { notify('За один поиск можно обработать до 100 артикулов. Разделите список на части.', true); return; }
  clearSearch();
  const version = generation;
  notify(!drive.connected ? 'Для поиска в Google Диске войдите через свой Google-аккаунт. eBay можно открыть в блоке артикула.' : '');
  states = articles.map(article => ({ article, source: 'drive', folderName: article, folderEdited: false, selected: new Map(), drive: { files: [], loaded: false, loading: false, error: '', foldersFound: 0 }, ebay: { items: [], loaded: false, loading: false, error: '', page: 0, hasMore: false, warnings: [] } }));
  $('results').replaceChildren(...states.map((state, index) => articleCard(state, index, version)));
  updateSelection();
  if (!drive.connected) return;
  const queue = [...states];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length && isCurrent(version)) await loadDrive(queue.shift(), version);
  }));
}
function uniqueName(desired, seen) {
  let name = desired;
  let number = 2;
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  while (seen.has(name.toLocaleLowerCase())) name = `${stem} (${number++})${ext}`;
  seen.add(name.toLocaleLowerCase());
  return name;
}
async function downloadSelected() {
  if (downloadBusy) return;
  const snapshot = states.filter(state => state.selected.size).map(state => ({ article: state.article, folderName: state.folderName, files: [...state.selected.values()] }));
  if (!snapshot.length) return;
  downloadBusy = true;
  downloadController = new AbortController();
  const signal = downloadController.signal;
  $('cancel-download').hidden = false;
  $('progress').hidden = false;
  $('progress').textContent = 'Подготавливаем архив…';
  document.body.classList.add('downloading');
  updateSelection();
  const folders = new Set();
  const entries = [];
  for (const state of snapshot) {
    const folder = uniqueName(sanitizeFolderName(state.folderName || state.article), folders);
    const names = new Set();
    state.files.forEach(({ source, file }, index) => {
      const fallback = `${state.article}_${index + 1}.jpg`;
      const name = uniqueName(sanitizeFileName(file.name || fallback), names);
      entries.push({ path: `${folder}/${name}`, load: async () => {
        if (source === 'drive') return drive.download(file, { signal });
        return ebay.download(file.url, { signal });
      } });
    });
  }
  try {
    const result = await downloadZip(entries, { signal, filename: `Фотографии_${new Date().toISOString().slice(0, 10)}.zip`, onProgress: ({ completed, total, path }) => { $('progress').textContent = `Готовим архив: ${completed} из ${total}${path ? ` · ${path}` : ''}`; } });
    $('progress').textContent = `Архив готов: ${result.count} файлов. Проверьте загрузки браузера.`;
    notify('');
  } catch (error) {
    $('progress').hidden = true;
    notify(signal.aborted ? 'Скачивание отменено.' : describeError(error), !signal.aborted);
  } finally {
    downloadBusy = false;
    downloadController = null;
    $('cancel-download').hidden = true;
    document.body.classList.remove('downloading');
    updateSelection();
  }
}

$('search-form').addEventListener('submit', startSearch);
$('articles').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); startSearch(); } });
$('connect').addEventListener('click', connect);
$('download').addEventListener('click', downloadSelected);
$('cancel-download').addEventListener('click', () => downloadController?.abort());
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const googleClientId = $('client-id').value.trim();
  const backendUrl = $('backend-url').value.trim().replace(/\/$/, '');
  if (googleClientId && !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(googleClientId)) { $('settings-message').textContent = 'Проверьте Google OAuth Client ID.'; return; }
  try {
    if (backendUrl) {
      const value = new URL(backendUrl);
      if (value.username || value.password || value.search || value.hash || (value.protocol !== 'https:' && !(value.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)))) throw new Error();
    }
  } catch { $('settings-message').textContent = 'Укажите корректный HTTPS-адрес подключения eBay.'; return; }
  if (downloadBusy) { $('settings-message').textContent = 'Дождитесь завершения скачивания.'; return; }
  drive.disconnect();
  overrides = { googleClientId, backendUrl };
  config = { ...defaults, ...overrides };
  try { localStorage.setItem('photo-picker-settings', JSON.stringify(overrides)); $('settings-message').textContent = 'Сохранено на этом устройстве.'; }
  catch { $('settings-message').textContent = 'Применено. Браузер не разрешил сохранить настройки.'; }
  createDrive();
  syncSettings();
  clearSearch();
  states = [];
  $('results').replaceChildren(el('div', 'empty', 'Настройки изменены. Войдите через Google и повторите поиск.'));
  updateSelection();
});
syncSettings();
createDrive();
