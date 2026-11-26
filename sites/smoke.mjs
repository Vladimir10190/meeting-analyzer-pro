import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../dist/server/index.js';

const video = await readFile(new URL('../test-data/01_project_meeting.mp4', import.meta.url));
const migration = await readFile(new URL('../drizzle/0000_meetings.sql', import.meta.url), 'utf8');
const summary = { summary: 'Обсудили запуск.', decisions: [], tasks: [], open_questions: [] };

test('Sites Worker stores stages, identifies repeats and isolates records by visitor', async t => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(migration);
  const videos = new Map();
  const env = {
    VSELLM_API_KEY: 'test-key',
    DB: {
      prepare(query) {
        const statement = sql.prepare(query);
        return { bind: (...p) => ({ first: async () => statement.get(...p) ?? null,
          all: async () => ({ results: statement.all(...p) }),
          run: async () => ({ meta: { changes: statement.run(...p).changes } }) }) };
      },
    },
    BUCKET: {
      async put(id, data) {
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data.slice();
        videos.set(id, bytes);
      },
      async get(id) {
        const data = videos.get(id);
        return data && { size: data.byteLength, arrayBuffer: async () => data.slice().buffer };
      },
      async delete(id) { videos.delete(id); },
    },
  };
  const site = 'https://site.example';
  const get = (path, owner = 'alice') => worker.fetch(new Request(site + path, { headers: { 'oai-authenticated-user-id': owner } }), env);
  const post = (path, body, contentType) => worker.fetch(new Request(site + path, { method: 'POST', body,
    headers: { 'oai-authenticated-user-id': 'alice', Origin: site, ...(contentType && { 'Content-Type': contentType }) } }), env);
  const api = '/api/meetings';
  const link = 'https://drive.google.com/file/d/recording/view?usp=sharing';
  const add = () => post(`${api}/cloud`, JSON.stringify({ url: link }), 'application/json');
  const advance = id => post(`${api}/${id}/advance`);
  const detail = async id => (await get(`${api}/${id}`)).json();
  let transcriptions = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url instanceof URL && url.hostname === 'drive.google.com') {
      return new Response(video, { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename=meeting.mp4' } });
    }
    assert.equal(url, 'https://api.vsellm.ru/v1/chat/completions');
    const body = JSON.parse(options.body);
    if (Array.isArray(body.messages[0].content)) {
      transcriptions++;
      assert.deepEqual(Buffer.from(body.messages[0].content[1].input_audio.data, 'base64'), video);
      return Response.json({ choices: [{ message: { content: 'Текст встречи.' } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(summary) } }] });
  });

  assert.equal((await worker.fetch(new Request(site + api), env)).status, 401);
  assert.equal((await get('/')).status, 200);
  const rejectedOrigin = await worker.fetch(new Request(site + api, { method: 'POST',
    headers: { 'oai-authenticated-user-id': 'alice', Origin: 'https://untrusted.example' } }), env);
  assert.equal(rejectedOrigin.status, 403);
  const added = await add();
  assert.equal(added.status, 202);
  const { id, stage } = await added.json();
  assert.equal(stage, 'download');
  assert.equal((await add()).status, 409);
  assert.equal((await get(`${api}/${id}`, 'bob')).status, 404);
  assert.deepEqual((await (await get(api, 'bob')).json()).meetings, []);

  assert.equal((await advance(id)).status, 200);
  assert.equal((await detail(id)).stage, 'transcription');
  assert.equal(videos.size, 1);
  assert.equal(sql.prepare('SELECT cloud_url FROM meetings WHERE id = ?').get(id).cloud_url, null);
  assert.equal((await advance(id)).status, 200);
  const recognized = await detail(id);
  assert.equal(recognized.stage, 'analysis');
  assert.equal(recognized.transcript, 'Текст встречи.');
  assert.equal(videos.size, 0);
  assert.equal((await advance(id)).status, 200);
  assert.deepEqual((await detail(id)).summary, summary);

  const duplicate = await (await add()).json();
  await advance(duplicate.id);
  assert.equal((await detail(duplicate.id)).duplicate_of, id);
  assert.equal((await (await get(api)).json()).meetings.length, 1);
  assert.equal(transcriptions, 1);

  const form = new FormData();
  form.set('file', new Blob([video], { type: 'video/mp4' }), 'manual.mp4');
  const manual = await post(api, form);
  assert.equal(manual.status, 202);
  const manualId = (await manual.json()).id;
  await advance(manualId);
  await advance(manualId);
  assert.equal((await detail(manualId)).status, 'ready');
  assert.equal((await detail(manualId)).source, 'manual');
  assert.equal(videos.size, 0);
  assert.equal(transcriptions, 2);
});
