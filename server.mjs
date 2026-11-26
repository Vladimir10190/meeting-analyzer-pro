import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, writeFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { configurationIssue, ProcessingError, processVideo } from './analysis.mjs';
import { CloudImportError, cloudFilename, cloudLink, downloadCloudVideo } from './cloud.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
try {
  process.loadEnvFile(join(root, '.env.local'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const maxFile = 250 * 1024 * 1024;
const maxRequest = maxFile + 64 * 1024;
const meetingId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function upload(request) {
  const type = request.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new HttpError(400, 'Выберите видео MP4 или WebM.');
  const limitError = 'Файл больше 250 МиБ. Выберите видео меньшего размера.';
  const size = Number(request.headers['content-length']);
  if (size > maxRequest) throw new HttpError(413, limitError);

  const controller = new AbortController();
  const reader = request.iterator({ destroyOnReturn: false });
  let received = 0;
  const stream = new ReadableStream({
    async pull(sink) {
      try {
        const { value, done } = await reader.next();
        if (done) return sink.close();
        received += value.length;
        if (received > maxRequest) {
          controller.abort();
          sink.error(new HttpError(413, limitError));
          return;
        }
        sink.enqueue(value);
      } catch (error) {
        sink.error(error);
      }
    },
  });
  let form;
  try {
    form = await new Response(stream, { headers: { 'content-type': type } }).formData();
  } catch {
    if (controller.signal.aborted) throw new HttpError(413, limitError);
    throw new HttpError(400, 'Не удалось прочитать загрузку. Выберите файл снова.');
  }

  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(entries[0][1] instanceof File)) {
    throw new HttpError(400, 'Выберите один видеофайл.');
  }
  const file = entries[0][1];
  if (!file.size) throw new HttpError(400, 'Файл пуст. Выберите другую запись.');
  if (file.size > maxFile) throw new HttpError(413, limitError);
  const filename = basename(file.name.replaceAll('\\', '/'));
  const extension = extname(filename).toLowerCase();
  if (extension !== '.mp4' && extension !== '.webm') {
    throw new HttpError(415, 'Загрузите видео в формате MP4 или WebM.');
  }
  return { file, filename, extension };
}

async function readCloudLink(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Отправьте ссылку через форму «Добавить из облака».');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, 'Ссылка слишком длинная.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { link: cloudLink(data?.url), sourceUrl: data.url.trim() };
  } catch (error) {
    throw new HttpError(400, error instanceof CloudImportError ? error.message : 'Не удалось прочитать ссылку.');
  }
}

function newRecord(source, filename, stage) {
  return {
    id: randomUUID(), source, filename, created_at: new Date().toISOString(), status: 'processing', stage,
    transcript: null, summary: null, error: null,
  };
}

function publicRecord({ cloud_link_key, checksum, ...record }) {
  return { source: 'manual', ...record };
}

export async function createMeetingServer({
  dataDirectory = join(root, 'data'), unavailable = configurationIssue,
  processRecording = (video, _temporary, onStage) => processVideo(video, { onStage }),
} = {}) {
  const records = join(dataDirectory, 'meetings');
  const temporary = join(dataDirectory, 'uploads');
  const meetings = new Map();
  const duplicates = new Map();
  let busy = false;

  await mkdir(records, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary);
  const recordPath = id => join(records, id + '.json');
  async function save(record) {
    const target = recordPath(record.id);
    await writeFile(target + '.tmp', JSON.stringify(record, null, 2), 'utf8');
    await rename(target + '.tmp', target);
    meetings.set(record.id, record);
  }

  for (const name of await readdir(records)) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !meetingId.test(id)) continue;
    try {
      const record = JSON.parse(await readFile(join(records, name), 'utf8'));
      if (record.id !== id || typeof record.created_at !== 'string') continue;
      if (record.status === 'processing') {
        await save({ ...record, status: 'error', stage: null, error: 'Сервер был перезапущен во время обработки. Добавьте запись снова.' });
      } else {
        meetings.set(id, record);
      }
    } catch {
      console.error('Один файл истории недоступен.');
    }
  }

  async function run(record, video, link) {
    try {
      if (link) {
        const { filename, extension, checksum } = await downloadCloudVideo(link, video, maxFile);
        const candidates = [...meetings.values()].filter(item => item.status === 'ready' && item.checksum === checksum);
        const existing = candidates.find(item => item.cloud_link_key === record.cloud_link_key) ?? candidates[0];
        if (existing) {
          if (!existing.source_url && record.source_url) {
            await save({ ...existing, source_url: record.source_url });
          }
          await rm(recordPath(record.id));
          duplicates.set(record.id, { ...publicRecord(record), filename, status: 'duplicate', stage: null, duplicate_of: existing.id });
          meetings.delete(record.id);
          if (duplicates.size > 100) duplicates.delete(duplicates.keys().next().value);
          return;
        }

        const validatedPath = join(temporary, record.id + extension);
        await rename(video, validatedPath);
        video = validatedPath;
        await save({ ...record, filename, checksum, stage: 'transcription' });
      }
      const result = await processRecording(video, temporary, async stage => {
        await save({ ...meetings.get(record.id), stage });
      });
      await save({ ...meetings.get(record.id), ...result, status: 'ready', stage: null });
    } catch (error) {
      const known = error instanceof ProcessingError || error instanceof CloudImportError;
      const failed = {
        ...meetings.get(record.id), status: 'error', stage: null,
        error: known ? error.message : 'Не удалось обработать или сохранить запись. Добавьте её снова.',
        transcript: error instanceof ProcessingError ? error.transcript : null,
      };
      try {
        await save(failed);
      } catch {
        meetings.set(record.id, { ...failed, error: 'Не удалось сохранить результат на диск.' });
        console.error('Не удалось записать результат встречи.');
      }
    } finally {
      await rm(video, { force: true }).catch(() => console.error('Не удалось удалить временное видео.'));
      busy = false;
    }
  }

  async function submit(request, response, fromCloud) {
    if (busy) throw new HttpError(409, 'Сервер уже обрабатывает запись. Дождитесь её завершения.');
    const issue = unavailable();
    if (issue) throw new HttpError(503, issue);
    busy = true;
    let video;
    try {
      let record;
      let link;
      if (fromCloud) {
        const cloud = await readCloudLink(request);
        link = cloud.link;
        record = newRecord('cloud', cloudFilename(link).slice(0, 240), 'download');
        record.source_url = cloud.sourceUrl;
        record.cloud_link_key = createHash('sha256').update(link.url.href).digest('hex');
        video = join(temporary, record.id + '.download');
      } else {
        const { file, filename, extension } = await upload(request);
        record = newRecord('manual', filename, 'transcription');
        video = join(temporary, record.id + extension);
        await pipeline(file.stream(), createWriteStream(video, { flags: 'wx' }));
      }
      await save(record);
      reply(response, 202, { id: record.id, status: record.status, stage: record.stage });
      void run(record, video, link);
    } catch (error) {
      if (video) await rm(video, { force: true }).catch(() => {});
      busy = false;
      throw error;
    }
  }

  return createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      const asset = staticFiles.get(pathname);
      if (request.method === 'GET' && asset) {
        const [name, type] = asset;
        const contents = await readFile(join(root, 'public', name));
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        return response.end(contents);
      }
      if (request.method === 'POST' && (pathname === '/api/meetings' || pathname === '/api/meetings/cloud')) {
        const origin = request.headers.origin;
        if ((origin && origin !== 'http://' + request.headers.host) ||
            request.headers['sec-fetch-site'] === 'cross-site') {
          throw new HttpError(403, 'Загрузка доступна со страницы локального приложения.');
        }
        return await submit(request, response, pathname.endsWith('/cloud'));
      }
      if (request.method === 'GET' && pathname === '/api/meetings') {
        const items = [...meetings.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map(({ id, filename, created_at, status, stage, source = 'manual', source_url, summary }) =>
            ({ id, filename, created_at, status, stage, source, source_url, preview: summary?.summary }));
        return reply(response, 200, { meetings: items, configuration_issue: unavailable(), busy });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/meetings/')) {
        const id = pathname.slice('/api/meetings/'.length);
        const record = meetings.get(id) ?? duplicates.get(id);
        if (record) return reply(response, 200, publicRecord(record));
      }
      throw new HttpError(404, 'Страница или встреча не найдена.');
    } catch (error) {
      if (error instanceof HttpError) {
        if (request.method === 'POST' && !request.readableEnded) response.setHeader('connection', 'close');
        return reply(response, error.status, { error: error.message });
      }
      console.error('Ошибка локального сервера.');
      return reply(response, 500, { error: 'Локальный сервер не смог выполнить запрос.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? '8000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  const server = await createMeetingServer();
  server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
}
