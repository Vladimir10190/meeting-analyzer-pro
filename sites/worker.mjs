import { BufferSource, Input, MP4, WEBM } from 'mediabunny';
import { ProcessingError, configurationIssue, settings, summarizeTranscript, transcribeVideo } from '../ai.mjs';
import { CloudImportError, cloudFilename, cloudLink, openCloudVideo, sizeLimitMessage } from '../cloud-source.mjs';
import { assets } from 'site-assets';

const maxFileMiB = 10;
const maxFile = maxFileMiB * 1024 * 1024;
const maxRequest = maxFile + 64 * 1024;
const leaseMilliseconds = 210_000;
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const tooLarge = `Максимальный размер видео на сайте — ${maxFileMiB} МиБ.`;
const busyMessage = 'Запись уже обрабатывается. Дождитесь завершения.';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const reply = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' },
});

function runtimeSettings(env) {
  return settings({
    OPENAI_API_KEY: env.VSELLM_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL || 'https://api.vsellm.ru/v1',
    TRANSCRIPTION_MODE: env.TRANSCRIPTION_MODE || 'chat_audio',
    STT_MODEL: env.STT_MODEL || 'google/gemini-3.1-flash-lite',
    SUMMARY_MODEL: env.SUMMARY_MODEL || 'google/gemini-3.1-flash-lite',
  });
}

function runtimeIssue(config) {
  if (!config.key) return 'Добавьте секрет VSELLM_API_KEY в настройки сайта.';
  if (configurationIssue(config) || !config.api.startsWith('https://')) {
    return 'Проверьте HTTPS-адрес и модели AI-провайдера в настройках сайта.';
  }
  return null;
}

async function readBytes(stream, limit, sizeError) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        throw sizeError;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cleanFilename(name) {
  const filename = name.replaceAll('\\', '/').split('/').pop().replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (!/\.(?:mp4|webm)$/i.test(filename)) throw new HttpError(415, 'Загрузите видео в формате MP4 или WebM.');
  return filename;
}

export async function inspectVideo(bytes, filename) {
  const invalid = 'Видео повреждено или его формат не поддерживается.';
  const input = new Input({ formats: [MP4, WEBM], source: new BufferSource(bytes) });
  try {
    const format = /\.mp4$/i.test(filename) ? MP4 : WEBM;
    if (await input.getFormat() !== format) throw new ProcessingError(invalid);
    if (!await input.getPrimaryVideoTrack()) throw new ProcessingError('В файле нет видеодорожки.');
    if (!await input.getPrimaryAudioTrack()) throw new ProcessingError('В видео нет аудиодорожки.');
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0) throw new ProcessingError('Не удалось определить длительность видео.');
    if (duration > 300.15) throw new ProcessingError('Видео длиннее 5 минут.');
    return format === MP4 ? 'mp4' : 'webm';
  } catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError(invalid);
  } finally {
    input.dispose();
  }
}

function meetingDetail(row) {
  const { id, filename, created_at, source, status, stage, error, transcript, summary, duplicate_of } = row;
  return { id, filename, created_at, source, status, stage, error, duplicate_of, transcript,
    summary: summary ? JSON.parse(summary) : null };
}

async function formFile(request) {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new HttpError(400, 'Выберите видео MP4 или WebM.');
  const sizeError = new HttpError(413, tooLarge);
  if (Number(request.headers.get('Content-Length')) > maxRequest) throw sizeError;
  const bytes = await readBytes(request.body, maxRequest, sizeError);
  let form;
  try {
    form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Не удалось прочитать загрузку. Выберите файл снова.');
  }
  const entries = [...form.entries()];
  const file = form.get('file');
  if (entries.length !== 1 || !(file instanceof File) || !file.size) throw new HttpError(400, 'Выберите один непустой видеофайл.');
  if (file.size > maxFile) throw sizeError;
  return { file, filename: cleanFilename(file.name) };
}

async function readLink(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new HttpError(415, 'Отправьте ссылку через форму «Добавить из облака».');
  }
  const body = await readBytes(request.body, 16 * 1024, new HttpError(413, 'Ссылка слишком длинная.'));
  let url;
  try { url = JSON.parse(new TextDecoder().decode(body))?.url; }
  catch { throw new HttpError(400, 'Не удалось прочитать ссылку.'); }
  return cloudLink(url);
}

async function deleteVideo(bucket, id) {
  await bucket.delete(id).catch(() => console.error('Не удалось удалить временное видео.'));
}

async function createMeeting(request, env, owner, fromCloud) {
  const running = await env.DB.prepare("SELECT id FROM meetings WHERE owner = ? AND status = 'processing'").bind(owner).first();
  if (running) throw new HttpError(409, busyMessage);
  const id = crypto.randomUUID();
  const source = fromCloud ? 'cloud' : 'manual';
  const stage = fromCloud ? 'download' : 'transcription';
  let link;
  let filename;
  if (fromCloud) {
    link = await readLink(request);
    filename = cloudFilename(link).slice(0, 240);
  } else {
    const upload = await formFile(request);
    filename = upload.filename;
    await env.BUCKET.put(id, upload.file);
  }
  try {
    const inserted = await env.DB.prepare(`INSERT INTO meetings (id, owner, source, filename, created_at, status, stage, cloud_url)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?) ON CONFLICT DO NOTHING`).bind(
      id, owner, source, filename, new Date().toISOString(), stage, link?.url.href ?? null,
    ).run();
    if (!inserted.meta.changes) throw new HttpError(409, busyMessage);
  } catch (error) {
    if (!fromCloud) await deleteVideo(env.BUCKET, id);
    throw error;
  }
  return reply({ id, status: 'processing', stage }, 202);
}

async function download(row, env, update) {
  const link = cloudLink(row.cloud_url);
  const { body, filename } = await openCloudVideo(link, maxFile, AbortSignal.timeout(120_000));
  const bytes = await readBytes(body, maxFile, new CloudImportError(sizeLimitMessage(maxFile)));
  if (!bytes.length) throw new CloudImportError('Облако вернуло пустой файл.');

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const existing = await env.DB.prepare(`SELECT id FROM meetings WHERE owner = ? AND checksum = ?
    AND source = 'cloud' AND status = 'ready' LIMIT 1`).bind(row.owner, checksum).first();
  if (existing) {
    await update("filename = ?, status = 'duplicate', duplicate_of = ?, stage = NULL, cloud_url = NULL", filename, existing.id);
    await deleteVideo(env.BUCKET, row.id);
    return;
  }
  await env.BUCKET.put(row.id, bytes);
  await update("filename = ?, checksum = ?, stage = 'transcription', cloud_url = NULL", filename, checksum);
}

async function recognize(row, env, config, update) {
  const media = await env.BUCKET.get(row.id);
  if (!media) throw new ProcessingError('Временный файл недоступен. Добавьте запись снова.');
  if (media.size > maxFile) throw new ProcessingError(tooLarge);
  const bytes = new Uint8Array(await media.arrayBuffer());
  const format = await inspectVideo(bytes, row.filename);
  const transcript = await transcribeVideo(bytes, format, row.filename, config);
  if (await update("transcript = ?, stage = 'analysis'", transcript)) await deleteVideo(env.BUCKET, row.id);
}

async function advance(env, owner, id, config) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(`UPDATE meetings SET lease_token = ?, lease_until = ?
    WHERE id = ? AND owner = ? AND status = 'processing' AND lease_until <= ? RETURNING *`)
    .bind(token, now + leaseMilliseconds, id, owner, now).first();
  if (!row) return reply({ advanced: false });

  async function update(fields, ...params) {
    const result = await env.DB.prepare(`UPDATE meetings SET ${fields}, lease_token = NULL, lease_until = 0
      WHERE id = ? AND owner = ? AND lease_token = ?`).bind(...params, id, owner, token).run();
    return Boolean(result.meta.changes);
  }

  try {
    if (row.stage === 'download') {
      await download(row, env, update);
    } else if (row.stage === 'transcription') {
      await recognize(row, env, config, update);
    } else {
      await deleteVideo(env.BUCKET, id);
      const summary = await summarizeTranscript(row.transcript, config);
      await update("summary = ?, status = 'ready', stage = NULL", JSON.stringify(summary));
    }
  } catch (error) {
    const message = error instanceof ProcessingError || error instanceof CloudImportError
      ? error.message : 'Не удалось обработать запись. Добавьте её снова.';
    if (!(error instanceof ProcessingError) && !(error instanceof CloudImportError)) console.error('Не удалось обработать запись.');
    if (await update("status = 'error', stage = NULL, cloud_url = NULL, error = ?", message)) await deleteVideo(env.BUCKET, id);
  }
  return reply({ advanced: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const asset = assets[url.pathname];
      if (request.method === 'GET' && asset) {
        return new Response(asset.body, { headers: { 'Content-Type': asset.type,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' } });
      }
      const visitor = request.headers.get('oai-authenticated-user-id');
      const owner = env.MEETING_OWNER_ID?.trim() || null;
      const isOwner = Boolean(owner && owner === visitor);
      const config = runtimeSettings(env);
      const issue = owner ? runtimeIssue(config) : 'Укажите MEETING_OWNER_ID в настройках сайта.';
      const displayIssue = issue && (isOwner ? issue : 'Добавление записей временно недоступно.');
      if (request.method === 'POST') {
        const origin = request.headers.get('Origin');
        if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          throw new HttpError(403, 'Загрузка доступна со страницы приложения.');
        }
        if (displayIssue) throw new HttpError(503, displayIssue);
        if (url.pathname === '/api/meetings' || url.pathname === '/api/meetings/cloud') {
          return await createMeeting(request, env, owner, url.pathname.endsWith('/cloud'));
        }
        const advanceId = url.pathname.match(/^\/api\/meetings\/([^/]+)\/advance$/)?.[1];
        if (advanceId && idPattern.test(advanceId)) return await advance(env, owner, advanceId, config);
      }
      if (request.method === 'GET' && url.pathname === '/api/meetings') {
        const { results } = await env.DB.prepare(`SELECT id, filename, created_at, source, status, stage, summary FROM meetings
          WHERE owner = ? AND status <> 'duplicate' ORDER BY created_at DESC`).bind(owner).all();
        const meetings = results.map(({ summary, ...row }) => ({ ...row, preview: summary ? JSON.parse(summary).summary : undefined }));
        return reply({ meetings, busy: meetings.some(row => row.status === 'processing'),
          configuration_issue: displayIssue, hosted: true, max_file_mib: maxFileMiB, signed_in: Boolean(visitor) });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/meetings/')) {
        const id = url.pathname.slice('/api/meetings/'.length);
        const row = idPattern.test(id) && await env.DB.prepare('SELECT * FROM meetings WHERE id = ? AND owner = ?').bind(id, owner).first();
        if (row) return reply(meetingDetail(row));
      }
      throw new HttpError(404, 'Страница или встреча не найдена.');
    } catch (error) {
      if (error instanceof HttpError) return reply({ error: error.message }, error.status);
      if (error instanceof CloudImportError) return reply({ error: error.message }, 400);
      console.error('Не удалось выполнить запрос к сайту.');
      return reply({ error: 'Не удалось выполнить запрос. Попробуйте снова.' }, 500);
    }
  },
};
