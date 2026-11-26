import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const paths = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const assets = {};
for (const [path, [file, type]] of Object.entries(paths)) {
  let body = await readFile(new URL(`public/${file}`, root), 'utf8');
  if (path === '/') body = body.replace('до 250 МиБ', 'до 10 МиБ');
  assets[path] = { body, type };
}
await build({
  entryPoints: ['sites/worker.mjs'], bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', minify: true, outfile: 'dist/server/index.js',
  plugins: [{
    name: 'site-assets',
    setup(builder) {
      builder.onResolve({ filter: /^site-assets$/ }, args => ({ path: args.path, namespace: 'site-assets' }));
      builder.onLoad({ filter: /.*/, namespace: 'site-assets' }, () => ({ contents: `export const assets = ${JSON.stringify(assets)};` }));
    },
  }],
});
const manifest = JSON.parse(await readFile(new URL('.openai/hosting.json', root), 'utf8'));
if (!manifest.project_id || manifest.d1 !== 'DB' || manifest.r2 !== 'BUCKET') throw new Error('Invalid Sites hosting manifest');
await mkdir(new URL('dist/.openai/', root), { recursive: true });
await writeFile(new URL('dist/.openai/hosting.json', root), `${JSON.stringify(manifest, null, 2)}\n`);
