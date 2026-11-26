import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import mediaInfoFactory from 'mediainfo.js';
import ebml from 'ts-ebml';

import { configurationIssue, ProcessingError, settings, summarizeTranscript, transcribeVideo } from './ai.mjs';
export { configurationIssue, ProcessingError, settings } from './ai.mjs';

const maximumDuration = 300.15;

async function inspectVideo(video) {
  const invalid = 'Видео повреждено или его формат не поддерживается.';
  const handle = await open(video, 'r');
  let analyzer;
  let tracks;
  try {
    const size = (await handle.stat()).size;
    analyzer = await mediaInfoFactory({ format: 'object' });
    const metadata = await analyzer.analyzeData(size, async (length, offset) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    });
    tracks = metadata.media?.track ?? [];
  } catch {
    throw new ProcessingError(invalid);
  } finally {
    analyzer?.close();
    await handle.close();
  }
  const general = tracks.find(track => track['@type'] === 'General');
  const extension = extname(video).toLowerCase();
  const header = await readHeader(video);
  const brand = general?.CodecID?.trim();
  const isMp4 = extension === '.mp4' && general?.Format === 'MPEG-4' && Boolean(brand) && !/^(qt|3g|mjp2)/i.test(brand);
  const isWebm = extension === '.webm' && general?.Format === 'WebM' && isWebmHeader(header);
  if (!isMp4 && !isWebm) throw new ProcessingError(invalid);
  if (!tracks.some(track => track['@type'] === 'Video')) {
    throw new ProcessingError('В файле нет видеодорожки.');
  }
  if (!tracks.some(track => track['@type'] === 'Audio')) {
    throw new ProcessingError('В видео нет аудиодорожки.');
  }
  let length = Number(general?.Duration);
  if (!(length > 0) && isWebm) {
    try {
      const decoder = new ebml.Decoder();
      const reader = new ebml.Reader();
      reader.use_segment_info = false;
      reader.drop_default_duration = false;
      for await (const chunk of createReadStream(video)) {
        for (const element of decoder.decode(chunk)) reader.read(element);
      }
      reader.stop();
      length = reader.duration * reader.timestampScale / 1e9;
    } catch {
      throw new ProcessingError('Не удалось определить длительность видео.');
    }
  }
  if (!Number.isFinite(length) || !(length > 0)) throw new ProcessingError('Не удалось определить длительность видео.');
  if (length > maximumDuration) throw new ProcessingError('Видео длиннее 5 минут.');
  return extension.slice(1);
}

async function readHeader(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isWebmHeader(header) {
  if (!header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  return header.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
}

export async function processVideo(videoPath, { onStage } = {}) {
  const config = settings();
  const issue = configurationIssue(config);
  if (issue) throw new ProcessingError(issue);

  const format = await inspectVideo(videoPath);
  const videoData = await readFile(videoPath);
  const transcript = await transcribeVideo(videoData, format, basename(videoPath), config);
  try {
    await onStage?.('analysis');
    return { transcript, summary: await summarizeTranscript(transcript, config) };
  } catch (error) {
    throw new ProcessingError(error instanceof ProcessingError ? error.message : 'Не удалось составить конспект.', transcript);
  }
}
