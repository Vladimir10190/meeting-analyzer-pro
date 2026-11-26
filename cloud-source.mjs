const shareHosts = new Set(['dropbox.com', 'www.dropbox.com']);
const filePath = /^\/s(?:cl\/fi)?\/[^/]+\/[^/]+\/?$/;
const googleHosts = new Set(['drive.google.com', 'drive.usercontent.google.com']);
const yandexHosts = new Set(['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk']);
const yandexPath = /^(\/(?:i|d)\/[\w-]+)(\/.*)?$/u;
const fallback = 'Скачайте видео из облака вручную и нажмите «Выбрать файл».';
const videoTypes = new Map([['video/mp4', '.mp4'], ['video/webm', '.webm']]);
const providers = {
  dropbox: { name: 'Dropbox', allows: host => host === 'dropbox.com' || host.endsWith('.dropbox.com') || downloadHost(host) },
  google: { name: 'Google Диск', allows: host => googleHosts.has(host) },
  yandex: {
    name: 'Яндекс.Диск',
    allows: host => host === 'mds.storage.yandex.net' || /^downloader[\w-]*\.(?:disk|dst)\.yandex\.(?:ru|net)$/.test(host),
  },
};

export class CloudImportError extends Error {
  constructor(message) {
    super(`${message} ${fallback}`);
  }
}

function downloadHost(hostname) {
  return hostname.endsWith('.dropboxusercontent.com');
}

function isHttps(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password;
}

function googleDownload(url) {
  const share = url.hostname === 'drive.google.com' && url.pathname.match(/^\/file\/d\/([\w-]+)(?:\/(?:view|preview))?\/?$/);
  const id = share?.[1] ?? (['/uc', '/download', '/open'].includes(url.pathname) ? url.searchParams.get('id') : null);
  if (!id || !/^[\w-]+$/.test(id)) return null;
  const direct = new URL('https://drive.google.com/uc');
  direct.searchParams.set('export', 'download');
  direct.searchParams.set('id', id);
  const key = url.searchParams.get('resourcekey');
  if (key) direct.searchParams.set('resourcekey', key);
  return direct;
}

export function cloudLink(input) {
  let url;
  if (typeof input === 'string' && input.length <= 8192) {
    try { url = new URL(input.trim()); } catch { /* Report the invalid link below. */ }
  }
  if (url && isHttps(url)) {
    url.hash = '';
    if (shareHosts.has(url.hostname) && filePath.test(url.pathname)) {
      url.hostname = 'www.dropbox.com';
      url.pathname = url.pathname.replace(/\/$/, '');
      url.searchParams.delete('raw');
      url.searchParams.set('dl', '1');
      url.searchParams.sort();
      return { provider: 'dropbox', url };
    }
    if (downloadHost(url.hostname)) return { provider: 'dropbox', url };
    if (googleHosts.has(url.hostname)) {
      const direct = googleDownload(url);
      if (direct) return { provider: 'google', url: direct };
    }
    if (yandexHosts.has(url.hostname) && yandexPath.test(url.pathname)) {
      url.search = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      return { provider: 'yandex', url };
    }
  }
  throw new CloudImportError('Вставьте HTTPS-ссылку Яндекс.Диска, Google Диска или Dropbox на отдельный файл с разрешённым скачиванием.');
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function cleanFilename(value) {
  return value.replaceAll('\\', '/').split('/').pop().replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

export function cloudFilename({ provider, url }) {
  const last = cleanFilename(decode(url.pathname.split('/').pop()));
  return ['.mp4', '.webm'].includes(extname(last).toLowerCase()) ? last : `Видеозапись из облака · ${providers[provider].name}`;
}

function videoFilename(response, url, link, type, remoteName) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const extendedName = disposition.match(/;\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1];
  const basicName = disposition.match(/;\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const hint = extendedName ? decode(extendedName) : basicName?.[1] ?? basicName?.[2];
  const original = filePath.test(link.url.pathname) ? decode(link.url.pathname.split('/').pop()) : '';
  const filename = cleanFilename(hint || remoteName || original || decode(url.pathname.split('/').pop()));
  const extension = extname(filename).toLowerCase() || videoTypes.get(type);
  if (extension !== '.mp4' && extension !== '.webm') {
    throw new CloudImportError('По ссылке ожидается видео в формате MP4 или WebM.');
  }
  const suffix = extname(filename);
  const stem = (suffix ? filename.slice(0, -suffix.length) : filename).slice(0, 200);
  return { filename: (stem || 'Видеозапись из облака') + extension, extension };
}

function accessError(name) {
  return new CloudImportError(`${name} не разрешил скачать файл. Проверьте доступ и срок действия ссылки.`);
}

function responseError(name, status) {
  if ([401, 403, 404, 410].includes(status)) return accessError(name);
  return new CloudImportError(`${name} не выдал файл. Проверьте ссылку или повторите попытку позже.`);
}

async function yandexResource(share, signal, maxBytes) {
  const [, root, path] = share.pathname.match(yandexPath);
  const metadata = new URL('https://cloud-api.yandex.net/v1/disk/public/resources');
  metadata.searchParams.set('public_key', share.origin + root);
  if (path) metadata.searchParams.set('path', decode(path));
  const download = new URL(metadata);
  download.pathname += '/download';
  metadata.searchParams.set('fields', 'type,name,size');
  const { name, type, size } = await yandexJson(metadata, signal);
  if (type !== 'file') throw new CloudImportError('Укажите ссылку на конкретный видеофайл Яндекс.Диска.');
  if (size > maxBytes) throw new CloudImportError(sizeLimitMessage(maxBytes));
  const resource = await yandexJson(download, signal);
  if (typeof resource.href !== 'string' || resource.method !== 'GET' || resource.templated) {
    throw new CloudImportError('Яндекс.Диск не выдал прямую ссылку на файл.');
  }
  return { url: new URL(resource.href), name: typeof name === 'string' ? name : '' };
}

async function yandexJson(url, signal) {
  const response = await fetch(url, { redirect: 'error', signal });
  if (response.ok) return response.json();
  await response.body?.cancel();
  throw responseError(providers.yandex.name, response.status);
}

async function fileResponse(initial, provider, signal) {
  const { name, allows } = providers[provider];
  let url = initial;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isHttps(url) || !allows(url.hostname)) {
      if (provider === 'google' && url.hostname === 'accounts.google.com') throw accessError(name);
      throw new CloudImportError(`${name} перенаправил на страницу, с которой нельзя скачать файл.`);
    }
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
    if (response.status === 200) return { response, url };

    await response.body?.cancel();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location');
      if (target) {
        url = new URL(target, url);
        continue;
      }
    }
    throw responseError(name, response.status);
  }
  throw new CloudImportError(`${name} перенаправляет слишком много раз.`);
}

function extname(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot) : '';
}

export function sizeLimitMessage(maxBytes) {
  const mib = maxBytes / (1024 * 1024);
  const limit = Number.isInteger(mib) ? `${mib} МиБ` : `${maxBytes} Б`;
  return `Размер облачного файла превышает ${limit}.`;
}

export async function openCloudVideo(link, maxBytes, signal) {
  const service = providers[link.provider].name;
  let response;
  try {
    const resource = link.provider === 'yandex' ? await yandexResource(link.url, signal, maxBytes) : link;
    const download = await fileResponse(resource.url, link.provider, signal);
    response = download.response;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type.startsWith('text/') || type === 'application/json' || type === 'application/xhtml+xml') {
      throw new CloudImportError(`По ссылке открывается веб-страница. Проверьте, что ${service} разрешает скачать видео без входа и подтверждения.`);
    }
    const metadata = videoFilename(response, download.url, link, type, resource.name);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new CloudImportError(sizeLimitMessage(maxBytes));
    if (!response.body) throw new CloudImportError('Облако вернуло пустой файл.');
    return { ...metadata, body: response.body };
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (error instanceof CloudImportError) throw error;
    throw new CloudImportError(signal.aborted ? 'Истекло время скачивания видео.' : `Не удалось скачать видео. Источник — ${service}.`);
  }
}
