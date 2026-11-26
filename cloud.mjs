import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { CloudImportError, openCloudVideo, sizeLimitMessage } from './cloud-source.mjs';
export { CloudImportError, cloudFilename, cloudLink } from './cloud-source.mjs';

export async function downloadCloudVideo(link, target, maxBytes) {
  const signal = AbortSignal.timeout(120_000);
  const { body, filename, extension } = await openCloudVideo(link, maxBytes, signal);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(body, async function* (chunks) {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new CloudImportError(sizeLimitMessage(maxBytes));
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(target, { flags: 'wx' }), { signal });
    if (!size) throw new CloudImportError('Облако вернуло пустой файл.');
    return { filename, extension, checksum: hash.digest('hex') };
  } catch (error) {
    if (error instanceof CloudImportError) throw error;
    throw new CloudImportError(signal.aborted ? 'Истекло время скачивания видео.' : 'Не удалось сохранить облачный файл.');
  }
}
