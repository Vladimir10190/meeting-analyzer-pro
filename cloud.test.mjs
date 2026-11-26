import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloudLink, downloadCloudVideo } from './cloud.mjs';

test('Google share links retain the resource key and follow the download redirect', async t => {
  const link = cloudLink('https://drive.google.com/file/d/example-id/view?usp=sharing&resourcekey=0-key');
  const directory = await mkdtemp(join(tmpdir(), 'meeting-drive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(link.url.href, 'https://drive.google.com/uc?export=download&id=example-id&resourcekey=0-key');
  assert.throws(() => cloudLink('https://drive.google.com/drive/folders/example-id'), /отдельный файл/);
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'drive.google.com') {
      return new Response(null, { status: 303, headers: { Location: 'https://drive.usercontent.google.com/download?id=example-id' } });
    }
    assert.equal(url.hostname, 'drive.usercontent.google.com');
    return new Response('video bytes', { headers: {
      'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="Meeting.mp4"',
    } });
  });
  const target = join(directory, 'video.download');
  const result = await downloadCloudVideo(link, target, 100);
  assert.equal(result.filename, 'Meeting.mp4');
  assert.equal(result.extension, '.mp4');
  assert.equal(await readFile(target, 'utf8'), 'video bytes');
});

test('Yandex public API resolves a specific file in a shared folder and preserves its name', async t => {
  const link = cloudLink('https://disk.yandex.ru/d/example/%D0%A2%D0%B5%D1%81%D1%82.webm?utm_source=app');
  const directory = await mkdtemp(join(tmpdir(), 'meeting-yandex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetch = t.mock.method(globalThis, 'fetch', url => {
    if (url.hostname === 'cloud-api.yandex.net') {
      assert.equal(url.searchParams.get('public_key'), 'https://disk.yandex.ru/d/example');
      assert.equal(url.searchParams.get('path'), '/Тест.webm');
      if (url.pathname.endsWith('/download')) {
        return Response.json({ href: 'https://downloader.disk.yandex.ru/disk/token', method: 'GET', templated: false });
      }
      return Response.json({ name: 'Тест.webm', type: 'file', size: 11 });
    }
    if (url.hostname === 'downloader.disk.yandex.ru') {
      return new Response(null, { status: 302, headers: { Location: 'https://mds.storage.yandex.net/download/token' } });
    }
    assert.equal(url.hostname, 'mds.storage.yandex.net');
    return new Response('video bytes', { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const target = join(directory, 'video.download');
  const result = await downloadCloudVideo(link, target, 100);
  assert.equal(result.filename, 'Тест.webm');
  assert.equal(result.extension, '.webm');
  assert.equal(await readFile(target, 'utf8'), 'video bytes');
  assert.equal(fetch.mock.callCount(), 4);
});

test('cloud import reports Google sign-in and rejects a Yandex folder before downloading', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', url => {
    if (url.hostname === 'drive.google.com') {
      return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/ServiceLogin' } });
    }
    assert.equal(url.href, 'https://cloud-api.yandex.net/v1/disk/public/resources?public_key=https%3A%2F%2Fdisk.yandex.ru%2Fd%2Ffolder&fields=type%2Cname%2Csize');
    return Response.json({ type: 'dir' });
  });
  const google = cloudLink('https://drive.google.com/file/d/private/view');
  const yandex = cloudLink('https://disk.yandex.ru/d/folder');
  const target = join(tmpdir(), 'unsaved-meeting.download');
  await assert.rejects(downloadCloudVideo(google, target, 100), /Google Диск не разрешил.*Выбрать файл/);
  await assert.rejects(downloadCloudVideo(yandex, target, 100), /конкретный видеофайл.*Выбрать файл/);
  assert.equal(fetch.mock.callCount(), 2);
});
