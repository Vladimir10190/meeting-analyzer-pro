import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { createMeetingServer } from './server.mjs';
import { ProcessingError } from './analysis.mjs';

const example = {
  transcript: 'Подготовить отчёт.',
  summary: { summary: 'Обсудили отчёт.', decisions: [], tasks: [
    { action: 'Подготовить отчёт', assignee: null, due: null },
  ], open_questions: [] },
};

// Drive the same registered request listener without requiring loopback in CI.
async function request(server, path = '/', options = {}) {
  const form = options.body && new Request('http://localhost' + path, {
    method: options.method, headers: options.headers, body: options.body,
  });
  const body = form ? Buffer.from(await form.arrayBuffer()) : Buffer.alloc(0);
  const input = Readable.from(body.length ? [body] : []);
  input.method = options.method ?? 'GET';
  input.url = path;
  input.headers = form ? Object.fromEntries(form.headers) : {};
  return new Promise((resolve, reject) => {
    let status;
    let headers;
    const output = {
      setHeader() {},
      writeHead(code, fields) {
        status = code;
        headers = fields;
      },
      end(contents) {
        resolve(new Response(contents, { status, headers }));
      },
    };
    try {
      server.emit('request', input, output);
    } catch (error) {
      reject(error);
    }
  });
}

function upload(server, name, content = 'input') {
  const form = new FormData();
  form.set('file', new Blob([content]), name);
  return request(server, '/api/meetings', { method: 'POST', body: form });
}

function importCloud(server, url) {
  return request(server, '/api/meetings/cloud', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
}

async function waitIdle(server) {
  for (let count = 0; count < 100; count++) {
    if (!(await (await request(server, '/api/meetings')).json()).busy) return;
    await wait(20);
  }
  assert.fail('Server did not release the processing slot');
}

async function finished(server, id) {
  for (let count = 0; count < 50; count++) {
    const response = await request(server, '/api/meetings/' + id);
    const result = await response.json();
    if (result.status !== 'processing') return result;
    await wait(20);
  }
  assert.fail('Processing did not finish');
}

test('upload, concurrency, persistence and interrupted jobs', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-test-'));
  const options = { dataDirectory, unavailable: () => null };
  const gate = Promise.withResolvers();
  let server;
  try {
    server = await createMeetingServer({ ...options, processRecording: async path => {
      assert.equal(await readFile(path, 'utf8'), 'input');
      return gate.promise;
    } });
    assert.match(await (await request(server)).text(), /AI-анализатор видеовстреч/);
    assert.equal((await upload(server, 'unsupported.txt')).status, 415);
    const accepted = await upload(server, 'Встреча MP4.mp4');
    assert.equal(accepted.status, 202);
    const { id, status } = await accepted.json();
    assert.equal(status, 'processing');
    assert.equal((await upload(server, 'second.webm')).status, 409);
    const index = await (await request(server, '/api/meetings')).json();
    assert.equal(index.meetings[0].filename, 'Встреча MP4.mp4');
    gate.resolve(example);
    const ready = await finished(server, id);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.summary, example.summary);
    for (let count = 0; count < 50; count++) {
      if (!(await readdir(join(dataDirectory, 'uploads'))).length) break;
      await wait(20);
    }
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);

    const interrupted = '01234567-0123-4123-a123-012345678901';
    await writeFile(join(dataDirectory, 'meetings', interrupted + '.json'), JSON.stringify({
      id: interrupted, filename: 'interrupted.webm', status: 'processing', created_at: new Date().toISOString(),
    }));
    await mkdir(join(dataDirectory, 'uploads', 'abandoned-audio'));
    server = await createMeetingServer({ ...options, unavailable: () => 'No key' });
    assert.deepEqual(await (await request(server, '/api/meetings/' + id)).json(), ready);
    const recovered = await (await request(server, '/api/meetings/' + interrupted)).json();
    assert.equal(recovered.status, 'error');
    assert.match(recovered.error, /перезапущен/);
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);
    assert.equal((await upload(server, 'disabled.webm')).status, 503);
  } finally {
    gate.resolve(example);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('cloud import uses the Lite pipeline, persists stages, and recognizes duplicates after restart', { timeout: 10_000 }, async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-cloud-test-'));
  const download = Promise.withResolvers();
  const transcription = Promise.withResolvers();
  const analysis = Promise.withResolvers();
  const transcriptStarted = Promise.withResolvers();
  const analysisStarted = Promise.withResolvers();
  const link = 'https://dropbox.com/scl/fi/token/reunion.mp4?rlkey=access&dl=0#preview';
  const firstVideo = await readFile(new URL('./test-data/01_project_meeting.mp4', import.meta.url));
  const secondVideo = await readFile(new URL('./test-data/02_team_meeting.mp4', import.meta.url));
  let video = firstVideo;
  let transcriptions = 0;
  let analyses = 0;
  let server;

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url instanceof URL && url.hostname === 'www.dropbox.com') {
      assert.equal(options.redirect, 'manual');
      assert.equal(url.hash, '');
      assert.equal(url.searchParams.get('dl'), '1');
      assert.equal(url.searchParams.get('rlkey'), 'access');
      return new Response(null, { status: 302, headers: { Location: 'https://dl.dropboxusercontent.com/s/dl/token' } });
    }
    if (url instanceof URL && url.hostname === 'dl.dropboxusercontent.com') {
      await download.promise;
      return new Response(video, { headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': "attachment; filename=reunion.mp4; filename*=UTF-8''%D0%92%D1%81%D1%82%D1%80%D0%B5%D1%87%D0%B0.mp4",
      } });
    }
    if (url === 'https://provider.example/v1/audio/transcriptions') {
      transcriptions++;
      transcriptStarted.resolve();
      await transcription.promise;
      return Response.json({ text: example.transcript });
    }
    assert.equal(url, 'https://provider.example/v1/chat/completions');
    analyses++;
    analysisStarted.resolve();
    await analysis.promise;
    return Response.json({ choices: [{ message: { content: JSON.stringify(example.summary) } }] });
  });

  const environment = {
    OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://provider.example/v1', TRANSCRIPTION_MODE: 'transcriptions',
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    server = await createMeetingServer({ dataDirectory });
    const accepted = await importCloud(server, link);
    assert.equal(accepted.status, 202);
    const { id, stage } = await accepted.json();
    assert.equal(stage, 'download');
    const get = async () => (await request(server, '/api/meetings/' + id)).json();
    assert.equal((await get()).stage, 'download');
    assert.equal((await importCloud(server, link)).status, 409);
    download.resolve();
    await transcriptStarted.promise;
    assert.equal((await get()).stage, 'transcription');
    assert.equal((await get()).filename, 'Встреча.mp4');
    transcription.resolve();
    await analysisStarted.promise;
    assert.equal((await get()).stage, 'analysis');
    analysis.resolve();
    const ready = await finished(server, id);
    assert.equal(ready.source, 'cloud');
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.summary, example.summary);
    assert.equal(ready.checksum, undefined);
    assert.equal(ready.cloud_link_key, undefined);
    await waitIdle(server);

    server = await createMeetingServer({ dataDirectory });
    assert.deepEqual(await get(), ready);
    const duplicate = await (await importCloud(server, link.replace('dl=0#preview', 'dl=1'))).json();
    const reused = await finished(server, duplicate.id);
    assert.equal(reused.status, 'duplicate');
    assert.equal(reused.duplicate_of, id);
    const { meetings } = await (await request(server, '/api/meetings')).json();
    assert.deepEqual(meetings.map(meeting => [meeting.id, meeting.preview]), [[id, example.summary.summary]]);
    assert.deepEqual(await readdir(join(dataDirectory, 'meetings')), [id + '.json']);
    assert.equal(transcriptions, 1);
    assert.equal(analyses, 1);
    await waitIdle(server);

    video = secondVideo;
    const updated = await (await importCloud(server, link)).json();
    assert.equal((await finished(server, updated.id)).status, 'ready');
    assert.equal(analyses, 2);
    await waitIdle(server);
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    download.resolve();
    transcription.resolve();
    analysis.resolve();
    if (server) await waitIdle(server);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('cloud import rejects invalid links, private pages and redirects outside Dropbox', async t => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-cloud-error-test-'));
  const responses = new Map([
    ['blocked.webm', () => new Response(null, { status: 403 })],
    ['preview.webm', () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['redirect.webm', () => new Response(null, { status: 302, headers: { Location: 'https://other.example/file.webm' } })],
    ['huge.webm', () => new Response('video', { headers: {
      'Content-Type': 'video/webm', 'Content-Length': '262144001',
    } })],
  ]);
  const fetch = t.mock.method(globalThis, 'fetch', async url => responses.get(url.pathname.split('/').pop())());
  const processRecording = t.mock.fn(() => assert.fail('Unexpected AI analysis'));
  const server = await createMeetingServer({ dataDirectory, unavailable: () => null, processRecording });
  try {
    for (const url of ['file:///test.webm', 'https://www.dropbox.com.evil.example/s/a/test.webm',
      'https://www.dropbox.com/scl/fo/token', 'https://user:pass@www.dropbox.com/s/a/test.webm']) {
      const response = await importCloud(server, url);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Выбрать файл/);
    }
    assert.equal(fetch.mock.callCount(), 0);
    for (const [filename, message] of [
      ['blocked.webm', /не разрешил/], ['preview.webm', /веб-страница/],
      ['redirect.webm', /перенаправил/], ['huge.webm', /250 МиБ/],
    ]) {
      const accepted = await importCloud(server, `https://www.dropbox.com/s/token/${filename}`);
      assert.equal(accepted.status, 202);
      const result = await finished(server, (await accepted.json()).id);
      assert.equal(result.status, 'error');
      assert.match(result.error, message);
      assert.match(result.error, /Выбрать файл/);
      await waitIdle(server);
    }
    assert.equal(fetch.mock.callCount(), 4);
    assert.equal(processRecording.mock.callCount(), 0);
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('partial transcript survives an AI error and upload can be retried', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-test-'));
  let server;
  try {
    let attempts = 0;
    server = await createMeetingServer({ dataDirectory, unavailable: () => null, processRecording: async () => {
      if (++attempts === 1) throw new ProcessingError('Ошибка конспекта.', example.transcript);
      return example;
    } });
    const first = await (await upload(server, 'запись.webm')).json();
    const partial = await finished(server, first.id);
    assert.equal(partial.status, 'error');
    assert.equal(partial.transcript, example.transcript);
    assert.equal(partial.error, 'Ошибка конспекта.');
    assert.equal(partial.summary, null);
    for (let count = 0; count < 50; count++) {
      if (!(await (await request(server, '/api/meetings')).json()).busy) break;
      await wait(10);
    }
    const retry = await (await upload(server, 'запись.webm')).json();
    assert.notEqual(retry.id, first.id);
    assert.equal((await finished(server, retry.id)).status, 'ready');
    for (let count = 0; count < 50; count++) {
      if (!(await (await request(server, '/api/meetings')).json()).busy) break;
      await wait(10);
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
