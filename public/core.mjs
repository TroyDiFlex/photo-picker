export function parseArticles(text) {
  const found = new Set();
  for (const line of String(text).split(/[\r\n,;]+/)) {
    const token = line.trim().replace(/^[|\s`"'•]+|[|\s`"'\\]+$/g, '').trim().toUpperCase().replace(/VRN$/i, '');
    if (/^[A-Z0-9][A-Z0-9._-]{1,79}$/.test(token) && /[A-Z0-9]/.test(token.replace(/[-_.]/g, ''))) found.add(token);
  }
  return [...found];
}

function safeName(value, fallback, length) {
  let name = String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  name = [...name].slice(0, length).join('').replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
export function sanitizeFolderName(value, fallback = 'Фотографии') { return safeName(value, fallback, 110); }
export function sanitizeFileName(value, fallback = 'файл') { return safeName(value, fallback, 140); }

// The first nonempty name line is used, never a SKU/URL or an entire description.
export function titleFromText(text, article) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const named = lines.find(s => /^(?:наименование|название|товар|name|title)\s*[:=]/i.test(s));
  if (named) return named.replace(/^[^:=]+[:=]\s*/, '').trim() || null;
  return lines.find(s => !/^https?:\/\//i.test(s) && !/^(?:артикул|sku|oem|номер)\s*[:=]/i.test(s) && s.toUpperCase().replace(/VRN$/, '') !== article && s.length > 3) || null;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function header(size) { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; }
function checkAbort(signal) { if (signal?.aborted) throw signal.reason || new DOMException('Отменено', 'AbortError'); }
function uniquePath(path, used) {
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some(s => s === '.' || s === '..')) throw new Error('Некорректный путь в архиве.');
  const file = sanitizeFileName(parts.pop());
  const directory = parts.map(s => sanitizeFolderName(s)).join('/');
  const base = directory ? directory + '/' : '';
  let candidate = base + file, n = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const dot = file.lastIndexOf('.');
    candidate = base + (dot > 0 ? file.slice(0, dot) + ` (${n++})` + file.slice(dot) : file + ` (${n++})`);
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

// ZIP STORE: media is already compressed. UTF-8 names, CRC and central directory
// make the archive readable by Windows without any extra runtime or ZIP library.
export async function buildZip(entries, { onProgress, signal, maxBytes = 512 * 1024 * 1024 } = {}) {
  if (!entries.length) throw new Error('Сначала выберите файлы.');
  if (entries.length > 65535) throw new Error('В одном архиве допускается до 65 535 файлов.');
  const encoder = new TextEncoder(), chunks = [], directory = [], used = new Set();
  let offset = 0, totalBytes = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < entries.length; i++) {
    checkAbort(signal);
    const path = uniquePath(entries[i].path, used), name = encoder.encode(path);
    onProgress?.({ completed: i, total: entries.length, path, bytes: totalBytes });
    const blob = await entries[i].load();
    checkAbort(signal);
    if (totalBytes + blob.size > maxBytes) throw new Error('Выбрано больше 512 МБ. Скачайте файлы несколькими архивами.');
    const data = new Uint8Array(await blob.arrayBuffer());
    checkAbort(signal);
    const crc = crc32(data), [local, l] = header(30);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, name.length, true);
    const [central, c] = header(46);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    chunks.push(local, name, data); directory.push(central, name);
    offset += local.length + name.length + data.length; totalBytes += data.length;
    onProgress?.({ completed: i + 1, total: entries.length, path, bytes: totalBytes });
  }
  const directorySize = directory.reduce((s, b) => s + b.length, 0), [end, e] = header(22);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}

export async function downloadZip(entries, options = {}) {
  const blob = await buildZip(entries, options);
  checkAbort(options.signal);
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = options.filename || `Фотографии_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { count: entries.length, bytes: blob.size };
}
